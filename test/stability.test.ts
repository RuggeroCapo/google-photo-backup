import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_EXTENSIONS } from '../src/config.js';
import { openDatabase } from '../src/db/database.js';
import { FileRepository } from '../src/db/repository.js';
import { FileFilter } from '../src/scanner/filter.js';
import { Ingestor } from '../src/scanner/ingestor.js';
import { silentLogger, sleep, tmpDir, waitFor, writeFile } from './helpers.js';

const WINDOW = 300;

let ingestor: Ingestor | null = null;
afterEach(async () => {
  await ingestor?.stop();
  ingestor = null;
});

function setup(root: string) {
  const repo = new FileRepository(openDatabase(':memory:'));
  const filter = new FileFilter(root, new Set(DEFAULT_EXTENSIONS));
  ingestor = new Ingestor({ filter, repo, logger: silentLogger, stabilityWindowMs: WINDOW, hashConcurrency: 1 });
  ingestor.start();
  return { repo, ingestor };
}

describe('files still being copied', () => {
  it('waits until size/mtime have been stable for the configured window', async () => {
    const root = tmpDir();
    const { repo, ingestor } = setup(root);
    const abs = path.join(root, 'copying.mp4');

    fs.writeFileSync(abs, 'chunk1');
    await ingestor.consider(abs);
    expect(ingestor.waitingForStability).toBe(1);

    // Keep "copying": append more data before each window elapses.
    for (let i = 0; i < 4; i++) {
      await sleep(WINDOW / 2);
      fs.appendFileSync(abs, `-chunk${i + 2}`);
      expect(repo.getByPath('copying.mp4')).toBeUndefined();
    }

    const started = Date.now();
    await waitFor(() => repo.getByPath('copying.mp4') !== undefined, 5000);
    expect(Date.now() - started).toBeGreaterThanOrEqual(WINDOW - 50);

    const row = repo.getByPath('copying.mp4')!;
    expect(row.size).toBe(fs.statSync(abs).size);
    expect(row.status).toBe('pending');
  });

  it('processes immediately a file nobody touched for longer than the window', async () => {
    const root = tmpDir();
    const { repo, ingestor } = setup(root);
    // A freshly written file has a fresh ctime, so make the check depend on age:
    const abs = writeFile(root, 'old.jpg', 'old');
    await sleep(WINDOW + 50);
    await ingestor.consider(abs);
    expect(ingestor.waitingForStability).toBe(0);
    await ingestor.waitIdle();
    expect(repo.getByPath('old.jpg')!.status).toBe('pending');
  });

  it('does not ingest a file that is not stable even if mtime is preserved (cp -p style)', async () => {
    const root = tmpDir();
    const { repo, ingestor } = setup(root);
    // Old mtime but just-written content: ctime is fresh, so it must still wait.
    const abs = writeFile(root, 'preserved.jpg', 'data', new Date('2015-05-05T00:00:00Z'));
    await ingestor.consider(abs);
    expect(ingestor.waitingForStability).toBe(1);
    expect(repo.getByPath('preserved.jpg')).toBeUndefined();
    await ingestor.waitIdle();
    expect(repo.getByPath('preserved.jpg')!.status).toBe('pending');
  });

  it('drops a candidate that disappears before becoming stable', async () => {
    const root = tmpDir();
    const { repo, ingestor } = setup(root);
    const abs = writeFile(root, 'tmp.jpg', 'temp');
    await ingestor.consider(abs);
    fs.rmSync(abs);
    await ingestor.waitIdle();
    expect(repo.getByPath('tmp.jpg')).toBeUndefined();
  });
});
