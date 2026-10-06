import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PhotoBackupAgent } from '../src/app.js';
import { buildServer } from '../src/api/server.js';
import { startAgent } from './agent-helpers.js';
import { fail, FakeUploader, tmpDir, waitFor, writeFile } from './helpers.js';

const OLD = new Date('2020-01-01T00:00:00Z');
const at = (h: number) => new Date(2026, 5, 15, h, 0, 0, 0);

let agent: PhotoBackupAgent;
let app: FastifyInstance;
let uploader: FakeUploader;

beforeEach(async () => {
  const root = tmpDir();
  writeFile(root, 'a.jpg', 'AAAA', OLD);
  writeFile(root, 'b.mp4', 'BBBBBBBB', OLD);
  writeFile(root, 'dup/a-copy.jpg', 'AAAA', OLD);
  writeFile(root, 'bad.png', 'XX', OLD);
  uploader = new FakeUploader();
  uploader.defaultBehaviour = (f) =>
    f.relativePath === 'bad.png'
      ? fail('permanent', false, 'googleapi: Error 400: invalid media')(f, {})
      : { ok: true, remotePath: `gphotos:upload/${f.filename}` };
  // Start outside the 02:00-07:00 window so nothing uploads until we ask.
  const t = await startAgent(root, { SCHEDULE_START: '02:00', SCHEDULE_END: '07:00' }, { uploader, start: at(12) });
  agent = t.agent;
  await t.ingest();
  app = buildServer(agent, { publicDir: path.resolve('public') });
});

afterEach(async () => {
  await app.close();
  await agent.stop();
});

describe('API', () => {
  it('GET /health', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('GET /api/status', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/status' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: 'healthy',
      queueSize: 3,
      failed: 0,
      lastUpload: null,
      currentUpload: null,
      manualSync: false,
      schedule: { window: '02:00-07:00', open: false },
    });
  });

  it('GET /api/stats', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/stats' });
    const body = res.json();
    expect(body.localFiles).toBe(4);
    expect(body.localBytes).toBe(4 + 8 + 4 + 2);
    expect(body.byStatus.pending).toEqual({ count: 3, bytes: 14 });
    expect(body.byStatus.ignored.count).toBe(1);
    expect(body.ignoredByReason).toEqual({ duplicate: 1 });
  });

  it('GET /api/queue with filters and validation', async () => {
    let res = await app.inject({ method: 'GET', url: '/api/queue' });
    expect(res.json().total).toBe(3);
    expect(res.json().items[0]).toHaveProperty('sha256');

    // whichever copy is hashed first is uploaded, the other is a duplicate
    res = await app.inject({ method: 'GET', url: '/api/queue?status=ignored' });
    expect(res.json().items).toHaveLength(1);
    expect(['a.jpg', 'dup/a-copy.jpg']).toContain(res.json().items[0].path);
    expect(res.json().items[0]).toMatchObject({ ignored_reason: 'duplicate' });

    res = await app.inject({ method: 'GET', url: '/api/queue?limit=1&offset=1' });
    expect(res.json().items).toHaveLength(1);

    res = await app.inject({ method: 'GET', url: '/api/queue?status=bogus' });
    expect(res.statusCode).toBe(400);
  });

  it('POST /api/sync uploads now; POST /api/retry-failed re-queues failures', async () => {
    const sync = await app.inject({ method: 'POST', url: '/api/sync' });
    expect(sync.statusCode).toBe(202);
    await waitFor(() => agent.repo.countByStatus('pending') === 0 && agent.repo.countByStatus('uploading') === 0);

    let status = (await app.inject({ method: 'GET', url: '/api/status' })).json();
    expect(status).toMatchObject({ queueSize: 0, failed: 1 });
    expect(status.lastUpload).not.toBeNull();
    expect(uploader.calls).toHaveLength(3); // the duplicate was never uploaded

    const errors = (await app.inject({ method: 'GET', url: '/api/queue?status=failed' })).json();
    expect(errors.items[0]).toMatchObject({ path: 'bad.png', error: expect.stringContaining('invalid media') });

    uploader.defaultBehaviour = (f) => ({ ok: true, remotePath: `gphotos:upload/${f.filename}` });
    const retry = await app.inject({ method: 'POST', url: '/api/retry-failed' });
    expect(retry.json()).toEqual({ ok: true, requeued: 1 });
    await app.inject({ method: 'POST', url: '/api/sync' });
    await waitFor(() => agent.repo.countByStatus('uploaded') === 3);
    status = (await app.inject({ method: 'GET', url: '/api/status' })).json();
    expect(status.failed).toBe(0);
  });

  it('GET / serves the dashboard', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.body).toContain('Sync now');
  });
});
