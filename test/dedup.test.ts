import crypto from 'node:crypto';
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/database.js';
import { FileRepository } from '../src/db/repository.js';
import { sha256File } from '../src/scanner/hash.js';
import { tmpDir, writeFile } from './helpers.js';

const scanned = (p: string, sha: string, size = 10) => ({ path: p, size, mtime: 1000, sha256: sha, mimeType: 'image/jpeg' });

describe('sha256File', () => {
  it('streams large files and matches crypto digest', async () => {
    const root = tmpDir();
    const buf = crypto.randomBytes(5 * 1024 * 1024 + 123);
    const abs = writeFile(root, 'big.mp4', buf);
    expect(await sha256File(abs)).toBe(crypto.createHash('sha256').update(buf).digest('hex'));
  });
});

describe('deduplication', () => {
  it('queues identical content found under two paths only once', () => {
    const repo = new FileRepository(openDatabase(':memory:'));
    const a = repo.upsertScanned(scanned('a/IMG_1.jpg', 'h1'));
    const b = repo.upsertScanned(scanned('b/copy of IMG_1.jpg', 'h1'));
    expect(a.status).toBe('pending');
    expect(b).toMatchObject({ status: 'ignored', ignored_reason: 'duplicate', duplicate_of: 'a/IMG_1.jpg' });
  });

  it('never re-uploads content that was moved/renamed after upload', () => {
    const repo = new FileRepository(openDatabase(':memory:'));
    const a = repo.upsertScanned(scanned('2023/IMG_1.jpg', 'h1'));
    repo.claimNext();
    repo.markUploaded(a.id, 'gphotos:upload/IMG_1.jpg');

    // file moved: old path disappears, new one appears
    repo.markDeleted('2023/IMG_1.jpg');
    const moved = repo.upsertScanned(scanned('archive/2023/renamed.jpg', 'h1'));

    expect(repo.getByPath('2023/IMG_1.jpg')!.status).toBe('uploaded'); // history kept
    expect(moved).toMatchObject({ status: 'ignored', ignored_reason: 'duplicate', duplicate_of: '2023/IMG_1.jpg' });
    expect(repo.claimNext()).toBeUndefined();
  });

  it('the ledger survives even if the uploaded path later gets new content', () => {
    const repo = new FileRepository(openDatabase(':memory:'));
    const a = repo.upsertScanned(scanned('x.jpg', 'h1'));
    repo.claimNext();
    repo.markUploaded(a.id, 'gphotos:upload/x.jpg');

    // x.jpg overwritten with new content → new content must be uploaded
    const changed = repo.upsertScanned(scanned('x.jpg', 'h2'));
    expect(changed.status).toBe('pending');
    // the old content reappears elsewhere → still a duplicate
    expect(repo.upsertScanned(scanned('y.jpg', 'h1')).status).toBe('ignored');
  });

  it('hands the upload to a duplicate when the original is deleted before upload', () => {
    const repo = new FileRepository(openDatabase(':memory:'));
    repo.upsertScanned(scanned('old/IMG_2.jpg', 'h2'));
    repo.upsertScanned(scanned('new/IMG_2.jpg', 'h2'));
    expect(repo.getByPath('new/IMG_2.jpg')!.status).toBe('ignored');

    repo.markDeleted('old/IMG_2.jpg');

    expect(repo.getByPath('old/IMG_2.jpg')).toMatchObject({ status: 'ignored', ignored_reason: 'deleted' });
    expect(repo.getByPath('new/IMG_2.jpg')).toMatchObject({ status: 'pending', duplicate_of: null });
    expect(repo.claimNext()!.path).toBe('new/IMG_2.jpg');
  });

  it('marks pending duplicates ignored once the content is uploaded', () => {
    const repo = new FileRepository(openDatabase(':memory:'));
    const a = repo.upsertScanned(scanned('a.jpg', 'h3'));
    repo.claimNext();
    // b discovered while a is uploading → ignored as queued duplicate
    expect(repo.upsertScanned(scanned('b.jpg', 'h3')).status).toBe('ignored');
    repo.markUploaded(a.id, 'gphotos:upload/a.jpg');
    expect(repo.getByPath('b.jpg')!.duplicate_of).toBe('a.jpg');
    expect(repo.uploadedHash('h3')).toMatchObject({ path: 'a.jpg' });
  });

  it('end-to-end: two real files with equal bytes produce one pending row', async () => {
    const root = tmpDir();
    const repo = new FileRepository(openDatabase(':memory:'));
    for (const rel of ['one.jpg', 'sub/two.jpg']) {
      const abs = writeFile(root, rel, 'same-bytes');
      repo.upsertScanned({ path: rel, size: fs.statSync(abs).size, mtime: 1, sha256: await sha256File(abs), mimeType: 'image/jpeg' });
    }
    expect(repo.countByStatus('pending')).toBe(1);
    expect(repo.countByStatus('ignored')).toBe(1);
  });
});
