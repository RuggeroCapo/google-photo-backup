import { afterEach, describe, expect, it } from 'vitest';
import type { PhotoBackupAgent } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { UploadWindow } from '../src/queue/scheduler.js';
import { startAgent } from './agent-helpers.js';
import { sleep, tmpDir, waitFor, writeFile } from './helpers.js';

/** Local-time date on a fixed day. */
const at = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(2026, 5, 15, h, m, 0, 0);
};

describe('UploadWindow', () => {
  it('same-day window 02:00-07:00', () => {
    const w = new UploadWindow('02:00', '07:00');
    expect(w.isOpen(at('01:59'))).toBe(false);
    expect(w.isOpen(at('02:00'))).toBe(true);
    expect(w.isOpen(at('06:59'))).toBe(true);
    expect(w.isOpen(at('07:00'))).toBe(false);
    expect(w.isOpen(at('15:00'))).toBe(false);
  });

  it('window crossing midnight 22:30-06:00', () => {
    const w = new UploadWindow('22:30', '06:00');
    expect(w.isOpen(at('22:29'))).toBe(false);
    expect(w.isOpen(at('22:30'))).toBe(true);
    expect(w.isOpen(at('00:00'))).toBe(true);
    expect(w.isOpen(at('05:59'))).toBe(true);
    expect(w.isOpen(at('06:00'))).toBe(false);
    expect(w.isOpen(at('12:00'))).toBe(false);
  });

  it('no window (or start == end) means always open', () => {
    expect(new UploadWindow(null, null).isOpen(at('13:37'))).toBe(true);
    expect(new UploadWindow('03:00', '03:00').isOpen(at('13:37'))).toBe(true);
  });

  it('computes time until the next opening', () => {
    const w = new UploadWindow('02:00', '07:00');
    expect(w.msUntilOpen(at('01:00'))).toBe(60 * 60_000);
    expect(w.msUntilOpen(at('03:00'))).toBe(0);
    expect(w.nextOpen(at('08:00'))!.getTime()).toBe(new Date(2026, 5, 16, 2, 0).getTime());
  });

  it('config validates HH:MM and requires both bounds', () => {
    expect(() => loadConfig({ SCHEDULE_START: '25:00', SCHEDULE_END: '07:00' })).toThrow(/SCHEDULE_START/);
    expect(() => loadConfig({ SCHEDULE_START: '02:00' })).toThrow(/both/);
    expect(loadConfig({ SCHEDULE_START: '2:00', SCHEDULE_END: '07:00' }).scheduleStart).toBe('2:00');
  });
});

describe('scheduler + worker', () => {
  const agents: PhotoBackupAgent[] = [];
  afterEach(async () => {
    for (const a of agents.splice(0)) await a.stop();
  });

  async function setup(start: Date) {
    const root = tmpDir();
    writeFile(root, 'a.jpg', 'A', new Date('2020-01-01'));
    writeFile(root, 'b.jpg', 'B', new Date('2020-01-01'));
    const t = await startAgent(root, { SCHEDULE_START: '02:00', SCHEDULE_END: '07:00' }, { start });
    agents.push(t.agent);
    await t.ingest();
    return { ...t, root };
  }

  it('outside the window files are queued but not uploaded', async () => {
    const { agent, uploader, clock } = await setup(at('12:00'));
    await sleep(100);
    expect(uploader.calls).toHaveLength(0);
    expect(agent.repo.countByStatus('pending')).toBe(2);
    expect(agent.status()).toMatchObject({ queueSize: 2, uploadingNow: false, schedule: { open: false, window: '02:00-07:00' } });

    clock.set(at('02:00'));
    await waitFor(() => agent.repo.countByStatus('uploaded') === 2);
  });

  it('"Sync now" uploads outside the window and ends when the queue is drained', async () => {
    const { agent, uploader, root } = await setup(at('12:00'));
    agent.syncNow();
    await waitFor(() => agent.repo.countByStatus('uploaded') === 2);
    await waitFor(() => !agent.worker.manualSync);
    expect(uploader.calls).toHaveLength(2);

    // new files after the manual session wait for the window again
    writeFile(root, 'c.jpg', 'C', new Date('2020-01-01'));
    await agent.scanner.scan();
    await agent.ingestor.waitIdle();
    await sleep(100);
    expect(agent.repo.getByPath('c.jpg')!.status).toBe('pending');
  });

  it('user pause blocks uploads until resumed; "Sync now" also resumes', async () => {
    const { agent, uploader, clock } = await setup(at('12:00'));
    agent.pause();
    clock.set(at('03:00')); // window open, but the user paused
    agent.worker.notify();
    expect(agent.status()).toMatchObject({ userPaused: true, uploadingNow: false });
    await sleep(150);
    expect(uploader.calls).toHaveLength(0);

    agent.resume();
    await waitFor(() => agent.repo.countByStatus('uploaded') === 2);
    expect(agent.status().userPaused).toBe(false);

    agent.pause();
    agent.syncNow();
    expect(agent.status().userPaused).toBe(false);
  });
});
