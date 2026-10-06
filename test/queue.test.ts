import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/database.js';
import { FileRepository } from '../src/db/repository.js';
import type { PhotoBackupAgent } from '../src/app.js';
import { startAgent } from './agent-helpers.js';
import { FakeUploader, tmpDir, waitFor, writeFile } from './helpers.js';

const OLD = new Date('2020-01-01T00:00:00Z');
const scanned = (p: string, sha: string) => ({ path: p, size: 1, mtime: 1, sha256: sha, mimeType: 'image/jpeg' });

const agents: PhotoBackupAgent[] = [];
afterEach(async () => {
  for (const a of agents.splice(0)) await a.stop();
});

describe('persistent queue', () => {
  it('survives a restart and resets interrupted uploads to pending', () => {
    const dbFile = path.join(tmpDir(), 'db', 'queue.db');
    let db = openDatabase(dbFile);
    let repo = new FileRepository(db);
    repo.upsertScanned(scanned('a.jpg', 'h1'));
    repo.upsertScanned(scanned('b.jpg', 'h2'));
    repo.upsertScanned(scanned('c.jpg', 'h3'));
    const claimed = repo.claimNext()!;
    repo.markUploaded(claimed.id, 'gphotos:upload/a.jpg');
    const inFlight = repo.claimNext()!;
    expect(inFlight.status).toBe('uploading');
    db.close(); // "crash"

    db = openDatabase(dbFile);
    repo = new FileRepository(db);
    expect(repo.getById(inFlight.id)!.status).toBe('uploading');
    expect(repo.recoverInterrupted()).toBe(1);
    expect(repo.getById(inFlight.id)!.status).toBe('pending');
    expect(repo.countByStatus('uploaded')).toBe(1);
    expect(repo.countByStatus('pending')).toBe(2);
    expect(repo.uploadedHash('h1')).toBeDefined();
    db.close();
  });

  it('agent restart: interrupted job is re-uploaded, uploaded ones are not', async () => {
    const root = tmpDir();
    writeFile(root, 'a.jpg', 'A', OLD);
    writeFile(root, 'b.jpg', 'B', OLD);
    const dbFile = path.join(tmpDir(), 'queue.db');

    // First run: upload a.jpg, then "crash" while b.jpg is uploading.
    const hang = new FakeUploader();
    hang.script(
      (f) => ({ ok: true, remotePath: `gphotos:upload/${f.filename}` }),
      () => new Promise(() => undefined), // never resolves
    );
    const first = await startAgent(root, {}, { uploader: hang, db: openDatabase(dbFile) });
    await first.ingest();
    await waitFor(() => first.agent.repo.countByStatus('uploading') === 1 && hang.calls.length === 2);
    expect(first.agent.repo.countByStatus('uploaded')).toBe(1);
    const interrupted = first.agent.repo.listQueue({ status: 'uploading' }).items[0]!.path;
    // simulate kill -9: drop the DB handle without graceful shutdown
    await first.agent.ingestor.stop();
    (first.agent as unknown as { db: { close(): void } }).db.close();

    // Second run on the same DB.
    const second = await startAgent(root, {}, { db: openDatabase(dbFile) });
    agents.push(second.agent);
    await waitFor(() => second.agent.repo.countByStatus('uploaded') === 2);
    expect(second.uploader.calls.map((c) => c.relativePath)).toEqual([interrupted]);
  });

  it('graceful shutdown puts the in-flight upload back to pending without consuming a retry', async () => {
    const root = tmpDir();
    writeFile(root, 'a.jpg', 'A', OLD);
    const uploader = new FakeUploader();
    uploader.script(
      (_f, opts) =>
        new Promise((resolve) => {
          const aborted = () => resolve({ ok: false, kind: 'aborted', retryable: true, error: 'aborted' });
          if (opts.signal!.aborted) aborted();
          opts.signal!.addEventListener('abort', aborted);
        }),
    );
    const dbFile = path.join(tmpDir(), 'queue.db');
    const t = await startAgent(root, {}, { uploader, db: openDatabase(dbFile) });
    await t.ingest();
    await waitFor(() => t.agent.repo.countByStatus('uploading') === 1);
    await t.agent.stop();

    const repo = new FileRepository(openDatabase(dbFile));
    expect(repo.getByPath('a.jpg')).toMatchObject({ status: 'pending', retry_count: 0 });
  });

  it('retry-failed puts failed files back in the queue with a fresh retry budget', () => {
    const repo = new FileRepository(openDatabase(':memory:'));
    const a = repo.upsertScanned(scanned('a.jpg', 'h1'));
    repo.claimNext();
    repo.markFailed(a.id, 'boom');
    expect(repo.getById(a.id)).toMatchObject({ status: 'failed', retry_count: 1, error: 'boom' });
    expect(repo.retryFailed()).toBe(1);
    expect(repo.getById(a.id)).toMatchObject({ status: 'pending', retry_count: 0, error: null });
  });
});
