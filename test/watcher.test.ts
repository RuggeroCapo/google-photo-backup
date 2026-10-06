import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PhotoBackupAgent } from '../src/app.js';
import { FakeUploader, silentLogger, sleep, testConfig, tmpDir, waitFor, writeFile } from './helpers.js';

/** Local HH:MM, `hours` from now. */
const hhmm = (hours: number) => {
  const d = new Date(Date.now() + hours * 3600_000);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

let agent: PhotoBackupAgent | null = null;
afterEach(async () => {
  await agent?.stop();
  agent = null;
});

describe('filesystem watcher', () => {
  it('picks up new files once stable, ignores unsupported ones, tracks deletions', async () => {
    const root = tmpDir();
    writeFile(root, 'existing.jpg', 'x', new Date('2020-01-01'));
    const uploader = new FakeUploader();
    agent = new PhotoBackupAgent(
      testConfig(root, {
        WATCH_ENABLED: 'true',
        STABILITY_WINDOW_SECONDS: '0.3',
        // window closed right now: we only want to observe the queue
        SCHEDULE_START: hhmm(2),
        SCHEDULE_END: hhmm(3),
      }),
      { logger: silentLogger, uploader, idlePollMs: 20 },
    );
    await agent.start({ scan: false, watch: true });
    await waitFor(() => agent!.watcher!.ready, 10_000);

    writeFile(root, 'new/IMG_1.jpg', 'new photo');
    writeFile(root, 'new/readme.txt', 'not a photo');
    await waitFor(() => agent!.repo.getByPath('new/IMG_1.jpg') !== undefined, 10_000);
    expect(agent.repo.getByPath('new/IMG_1.jpg')!.status).toBe('pending');
    expect(agent.repo.getByPath('new/readme.txt')).toBeUndefined();

    fs.rmSync(path.join(root, 'new/IMG_1.jpg'));
    await waitFor(() => agent!.repo.getByPath('new/IMG_1.jpg')!.status === 'ignored', 10_000);
    expect(agent.repo.getByPath('new/IMG_1.jpg')!.ignored_reason).toBe('deleted');
    await sleep(50);
    expect(uploader.calls).toHaveLength(0);
  });
});
