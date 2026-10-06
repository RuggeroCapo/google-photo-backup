import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PhotoBackupAgent } from '../src/app.js';
import { backoffDelay } from '../src/queue/scheduler.js';
import { startAgent } from './agent-helpers.js';
import { fail, FakeUploader, sleep, tmpDir, waitFor, writeFile } from './helpers.js';

const OLD = new Date('2020-01-01T00:00:00Z');
const agents: PhotoBackupAgent[] = [];
afterEach(async () => {
  for (const a of agents.splice(0)) await a.stop();
});

async function setup(files: string[], env: Record<string, string> = {}, uploader = new FakeUploader()) {
  const root = tmpDir();
  for (const f of files) writeFile(root, f, `content of ${f}`, OLD);
  const t = await startAgent(root, env, { uploader });
  agents.push(t.agent);
  await t.ingest();
  return { ...t, root };
}

describe('backoff', () => {
  it('doubles from the base: 30s → 60s → 120s → 240s, capped', () => {
    const base = 30_000;
    expect([1, 2, 3, 4, 5].map((a) => backoffDelay(a, base, 6 * 3600_000))).toEqual([30_000, 60_000, 120_000, 240_000, 480_000]);
    expect(backoffDelay(20, base, 3600_000)).toBe(3600_000);
  });
});

describe('retry', () => {
  it('retries transient errors with exponential backoff, then succeeds', async () => {
    const uploader = new FakeUploader().script(fail('network'), fail('server'));
    const { agent, clock } = await setup(['a.jpg'], {}, uploader);
    const repo = agent.repo;

    await waitFor(() => repo.getByPath('a.jpg')!.retry_count === 1);
    let row = repo.getByPath('a.jpg')!;
    expect(row.status).toBe('pending');
    expect(row.next_attempt_at).toBe(clock.now + 30_000);

    // not yet due
    clock.advance(29_000);
    await sleep(60);
    expect(uploader.calls).toHaveLength(1);

    clock.advance(1_000);
    await waitFor(() => repo.getByPath('a.jpg')!.retry_count === 2);
    row = repo.getByPath('a.jpg')!;
    expect(row.next_attempt_at).toBe(clock.now + 60_000);
    expect(row.error).toBe('simulated server');

    clock.advance(60_000);
    await waitFor(() => repo.getByPath('a.jpg')!.status === 'uploaded');
    expect(uploader.calls).toHaveLength(3);
    expect(repo.getByPath('a.jpg')!.error).toBeNull();
  });

  it('marks the file failed after MAX_RETRIES and keeps processing the queue', async () => {
    const uploader = new FakeUploader();
    uploader.defaultBehaviour = (f) =>
      f.relativePath === 'bad.jpg'
        ? { ok: false, kind: 'server', retryable: true, error: '503 Service Unavailable' }
        : { ok: true, remotePath: `gphotos:upload/${f.filename}` };
    const { agent, clock } = await setup(['bad.jpg', 'good1.jpg', 'good2.jpg'], { MAX_RETRIES: '2' }, uploader);

    // good files are not blocked by the failing one
    await waitFor(() => agent.repo.countByStatus('uploaded') === 2);

    for (let i = 0; i < 3; i++) {
      clock.advance(10 * 60_000);
      await sleep(50);
    }
    await waitFor(() => agent.repo.getByPath('bad.jpg')!.status === 'failed');
    const bad = agent.repo.getByPath('bad.jpg')!;
    expect(bad.retry_count).toBe(3); // 1 attempt + 2 retries
    expect(bad.error).toMatch(/gave up after 3 attempts/);
    expect(uploader.calls.filter((c) => c.relativePath === 'bad.jpg')).toHaveLength(3);
    expect(agent.status().failed).toBe(1);

    // retry-failed gives it a new chance
    uploader.defaultBehaviour = (f) => ({ ok: true, remotePath: `gphotos:upload/${f.filename}` });
    expect(agent.retryFailed()).toBe(1);
    await waitFor(() => agent.repo.getByPath('bad.jpg')!.status === 'uploaded');
  });

  it('permanent errors fail immediately without retries', async () => {
    const uploader = new FakeUploader().script(fail('permanent', false, 'googleapi: Error 400: invalid media'));
    const { agent } = await setup(['a.jpg'], {}, uploader);
    await waitFor(() => agent.repo.getByPath('a.jpg')!.status === 'failed');
    expect(uploader.calls).toHaveLength(1);
  });

  it('429 pauses the whole queue for the backoff period', async () => {
    const uploader = new FakeUploader().script(fail('rate_limit', true, 'googleapi: Error 429: Quota exceeded'));
    const { agent, clock } = await setup(['a.jpg', 'b.jpg'], {}, uploader);
    await waitFor(() => agent.worker.pausedUntil !== null);
    await sleep(80);
    expect(uploader.calls).toHaveLength(1); // b.jpg not attempted while paused
    expect(agent.status().paused?.reason).toMatch(/rate limited/);

    clock.advance(30_000);
    await waitFor(() => agent.repo.countByStatus('uploaded') === 2);
  });

  it('configuration errors pause uploads without consuming the file retries', async () => {
    const uploader = new FakeUploader().script(fail('config', true, "didn't find section in config file"));
    const { agent, clock } = await setup(['a.jpg'], { CONFIG_ERROR_PAUSE_SECONDS: '600' }, uploader);
    await waitFor(() => agent.worker.configError !== null);
    expect(agent.repo.getByPath('a.jpg')).toMatchObject({ status: 'pending', retry_count: 0 });
    expect(agent.status().status).toBe('degraded');

    clock.advance(600_000);
    await waitFor(() => agent.repo.getByPath('a.jpg')!.status === 'uploaded');
    expect(agent.status().status).toBe('healthy');
  });

  it('a file deleted while queued is skipped, not failed', async () => {
    const { agent, root } = await setup([], { SCHEDULE_START: '02:00', SCHEDULE_END: '02:01' });
    writeFile(root, 'gone.jpg', 'x', OLD);
    await agent.scanner.scan();
    await agent.ingestor.waitIdle();
    fs.rmSync(path.join(root, 'gone.jpg'));
    agent.syncNow();
    await waitFor(() => agent.repo.getByPath('gone.jpg')!.status === 'ignored');
    expect(agent.repo.getByPath('gone.jpg')!.ignored_reason).toBe('missing');
  });
});
