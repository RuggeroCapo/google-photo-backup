import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_EXTENSIONS, RAW_EXTENSIONS, loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db/database.js';
import { FileRepository } from '../src/db/repository.js';
import { FileFilter } from '../src/scanner/filter.js';
import { Ingestor } from '../src/scanner/ingestor.js';
import { Scanner } from '../src/scanner/scanner.js';
import { silentLogger, tmpDir, writeFile } from './helpers.js';

const OLD = new Date('2020-01-01T00:00:00Z');

function pipeline(root: string, extensions: Iterable<string> = DEFAULT_EXTENSIONS) {
  const db = openDatabase(':memory:');
  const repo = new FileRepository(db);
  const filter = new FileFilter(root, new Set(extensions));
  const ingestor = new Ingestor({ filter, repo, logger: silentLogger, stabilityWindowMs: 0, hashConcurrency: 2 });
  ingestor.start();
  const scanner = new Scanner({ filter, ingestor, repo, logger: silentLogger });
  const scan = async () => {
    const r = await scanner.scan();
    await ingestor.waitIdle();
    return r;
  };
  return { db, repo, filter, ingestor, scanner, scan };
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

describe('scanner', () => {
  it('finds whitelisted files recursively and ignores everything else', async () => {
    const root = tmpDir();
    writeFile(root, 'a.jpg', 'A', OLD);
    writeFile(root, '2023/Trip/b.JPEG', 'B', OLD);
    writeFile(root, '2023/Trip/c.heic', 'C', OLD);
    writeFile(root, '2023/d.png', 'D', OLD);
    writeFile(root, 'videos/e.mp4', 'E', OLD);
    writeFile(root, 'videos/f.MOV', 'F', OLD);
    writeFile(root, 'notes.txt', 'nope', OLD);
    writeFile(root, 'raw/g.ARW', 'raw', OLD);
    writeFile(root, '.hidden/h.jpg', 'hidden', OLD);
    writeFile(root, '@eaDir/a.jpg/SYNOPHOTO_THUMB.jpg', 'thumb', OLD);
    writeFile(root, '._a.jpg', 'appledouble', OLD);

    const p = pipeline(root);
    cleanups.push(() => p.ingestor.stop());
    const result = await p.scan();

    expect(result.filesSeen).toBe(6);
    const rows = p.repo.listQueue({ status: 'pending', limit: 100 }).items;
    expect(rows.map((r) => r.path).sort()).toEqual(
      ['2023/Trip/b.JPEG', '2023/Trip/c.heic', '2023/d.png', 'a.jpg', 'videos/e.mp4', 'videos/f.MOV'].sort(),
    );
    const a = p.repo.getByPath('a.jpg')!;
    expect(a).toMatchObject({
      filename: 'a.jpg',
      size: 1,
      mtime: OLD.getTime(),
      mime_type: 'image/jpeg',
      status: 'pending',
      retry_count: 0,
      error: null,
      uploaded_at: null,
    });
    // sha256("A")
    expect(a.sha256).toBe('559aead08264d5795d3909718cdd05abd49572e84fe55590eef31a88a08fdffd');
    expect(p.repo.getByPath('videos/f.MOV')!.mime_type).toBe('video/quicktime');
  });

  it('RAW formats are disabled by default and can be enabled', async () => {
    expect(loadConfig({}).extensions.has('arw')).toBe(false);
    const cfg = loadConfig({ INCLUDE_RAW: 'true' });
    for (const ext of RAW_EXTENSIONS) expect(cfg.extensions.has(ext)).toBe(true);

    const root = tmpDir();
    writeFile(root, 'a.ARW', 'raw1', OLD);
    writeFile(root, 'b.dng', 'raw2', OLD);
    writeFile(root, 'c.jpg', 'jpg', OLD);
    const p = pipeline(root, cfg.extensions);
    cleanups.push(() => p.ingestor.stop());
    await p.scan();
    expect(p.repo.countByStatus('pending')).toBe(3);
  });

  it('does not re-hash unchanged files on rescan, but picks up modified ones', async () => {
    const root = tmpDir();
    writeFile(root, 'a.jpg', 'A', OLD);
    writeFile(root, 'b.jpg', 'B', OLD);
    const p = pipeline(root);
    cleanups.push(() => p.ingestor.stop());
    await p.scan();
    const before = p.repo.getByPath('a.jpg')!;

    writeFile(root, 'b.jpg', 'B modified', new Date('2021-01-01T00:00:00Z'));
    await p.scan();

    expect(p.repo.getByPath('a.jpg')!.updated_at).toBe(before.updated_at);
    const b = p.repo.getByPath('b.jpg')!;
    expect(b.size).toBe('B modified'.length);
    expect(b.status).toBe('pending');
  });

  it('marks queued files deleted when they disappear between scans', async () => {
    const root = tmpDir();
    writeFile(root, 'a.jpg', 'A', OLD);
    writeFile(root, 'b.jpg', 'B', OLD);
    const p = pipeline(root);
    cleanups.push(() => p.ingestor.stop());
    await p.scan();

    fs.rmSync(path.join(root, 'b.jpg'));
    const r = await p.scan();
    expect(r.markedDeleted).toBe(1);
    expect(p.repo.getByPath('b.jpg')).toMatchObject({ status: 'ignored', ignored_reason: 'deleted' });

    // ...and revives them if they come back
    writeFile(root, 'b.jpg', 'B', OLD);
    await p.scan();
    expect(p.repo.getByPath('b.jpg')).toMatchObject({ status: 'pending', ignored_reason: null });
  });

  it('refuses to treat an empty root (unmounted disk) as "everything deleted"', async () => {
    const root = tmpDir();
    writeFile(root, 'a.jpg', 'A', OLD);
    const p = pipeline(root);
    cleanups.push(() => p.ingestor.stop());
    await p.scan();

    fs.rmSync(path.join(root, 'a.jpg'));
    const r = await p.scan();
    expect(r.error).toMatch(/empty/);
    expect(p.repo.getByPath('a.jpg')!.status).toBe('pending');
  });
});
