import path from 'node:path';
import type { DB } from './database.js';
import type { FileRecord, FileStatus, IgnoredReason } from '../types.js';
import { FILE_STATUSES } from '../types.js';

export interface ScannedFile {
  path: string;
  size: number;
  mtime: number;
  sha256: string;
  mimeType: string;
}

export interface StatusCount {
  count: number;
  bytes: number;
}

export interface Stats {
  localFiles: number;
  localBytes: number;
  uploadedHashes: number;
  byStatus: Record<FileStatus, StatusCount>;
  ignoredByReason: Record<string, number>;
  lastUploadAt: string | null;
}

export interface QueueQuery {
  status?: FileStatus;
  limit?: number;
  offset?: number;
}

const iso = (ms: number) => new Date(ms).toISOString();

/** Statuses that represent work not yet done for a piece of content. */
const OPEN_STATUSES = `('pending','uploading','failed')`;

export class FileRepository {
  constructor(
    private readonly db: DB,
    private readonly clock: () => number = Date.now,
  ) {}

  getByPath(relPath: string): FileRecord | undefined {
    return this.db.prepare('SELECT * FROM files WHERE path = ?').get(relPath) as FileRecord | undefined;
  }

  getById(id: number): FileRecord | undefined {
    return this.db.prepare('SELECT * FROM files WHERE id = ?').get(id) as FileRecord | undefined;
  }

  /**
   * True when the path is already tracked with the same size and mtime, so it
   * does not need to be hashed again. Rows that were marked deleted/missing are
   * reconsidered, because the file has evidently come back.
   */
  isKnownUnchanged(relPath: string, size: number, mtime: number): boolean {
    const row = this.db
      .prepare('SELECT size, mtime, status, ignored_reason FROM files WHERE path = ?')
      .get(relPath) as Pick<FileRecord, 'size' | 'mtime' | 'status' | 'ignored_reason'> | undefined;
    if (!row) return false;
    if (row.status === 'ignored' && (row.ignored_reason === 'deleted' || row.ignored_reason === 'missing')) {
      return false;
    }
    return row.size === size && row.mtime === mtime;
  }

  uploadedHash(sha256: string): { sha256: string; path: string; remote_path: string | null; uploaded_at: string } | undefined {
    return this.db.prepare('SELECT * FROM uploaded_hashes WHERE sha256 = ?').get(sha256) as
      | { sha256: string; path: string; remote_path: string | null; uploaded_at: string }
      | undefined;
  }

  /**
   * Insert or update a file after it has been found stable and hashed.
   * Applies deduplication: content already uploaded (or already queued under
   * another path) is stored as `ignored` / `duplicate`.
   */
  upsertScanned(file: ScannedFile): FileRecord {
    return this.db.transaction((f: ScannedFile): FileRecord => {
      const now = iso(this.clock());
      const existing = this.getByPath(f.path);

      // Never touch a row the worker is uploading right now; the worker
      // re-checks the file after the upload and re-submits it if it changed.
      if (existing?.status === 'uploading') return existing;

      if (existing && existing.sha256 === f.sha256) {
        const revive =
          existing.status === 'ignored' &&
          (existing.ignored_reason === 'deleted' || existing.ignored_reason === 'missing');
        this.db
          .prepare('UPDATE files SET size = ?, mtime = ?, mime_type = ?, updated_at = ? WHERE id = ?')
          .run(f.size, f.mtime, f.mimeType, now, existing.id);
        if (revive) this.applyInitialStatus(existing.id, f.sha256, now);
        return this.getById(existing.id)!;
      }

      let id: number;
      if (existing) {
        // Same path, new content: treat as a brand new item. Whatever was
        // uploaded before stays in the cloud and in the ledger.
        this.db
          .prepare(
            `UPDATE files SET filename = ?, size = ?, mtime = ?, sha256 = ?, mime_type = ?,
               retry_count = 0, error = NULL, remote_path = NULL, uploaded_at = NULL,
               next_attempt_at = NULL, updated_at = ?
             WHERE id = ?`,
          )
          .run(path.posix.basename(f.path), f.size, f.mtime, f.sha256, f.mimeType, now, existing.id);
        id = existing.id;
        if (existing.status !== 'ignored') this.promoteDuplicate(existing.sha256, existing.path);
      } else {
        const res = this.db
          .prepare(
            `INSERT INTO files (path, filename, size, mtime, sha256, mime_type, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
          )
          .run(f.path, path.posix.basename(f.path), f.size, f.mtime, f.sha256, f.mimeType, now, now);
        id = Number(res.lastInsertRowid);
      }
      this.applyInitialStatus(id, f.sha256, now);
      return this.getById(id)!;
    })(file);
  }

  /** Decide between `pending` and `ignored/duplicate` for a (re)discovered file. */
  private applyInitialStatus(id: number, sha256: string, now: string): void {
    const uploaded = this.uploadedHash(sha256);
    const open = uploaded
      ? undefined
      : (this.db
          .prepare(`SELECT path FROM files WHERE sha256 = ? AND id <> ? AND status IN ${OPEN_STATUSES} LIMIT 1`)
          .get(sha256, id) as { path: string } | undefined);
    const dupOf = uploaded?.path ?? open?.path;

    if (dupOf !== undefined) {
      const reason = uploaded ? `already uploaded as ${dupOf}` : `same content queued as ${dupOf}`;
      this.db
        .prepare(
          `UPDATE files SET status = 'ignored', ignored_reason = 'duplicate', duplicate_of = ?, error = ?,
             next_attempt_at = NULL, updated_at = ? WHERE id = ?`,
        )
        .run(dupOf, `Duplicate: ${reason}`, now, id);
    } else {
      this.db
        .prepare(
          `UPDATE files SET status = 'pending', ignored_reason = NULL, duplicate_of = NULL, error = NULL,
             retry_count = 0, next_attempt_at = NULL, updated_at = ? WHERE id = ?`,
        )
        .run(now, id);
    }
  }

  /**
   * When the row that "owned" a piece of content disappears before being
   * uploaded, hand ownership to one of its duplicates (if any) so the content
   * still gets backed up exactly once.
   */
  promoteDuplicate(sha256: string, excludePath?: string): FileRecord | undefined {
    if (this.uploadedHash(sha256)) return undefined;
    const stillOpen = this.db
      .prepare(`SELECT id FROM files WHERE sha256 = ? AND status IN ${OPEN_STATUSES} AND path <> ? LIMIT 1`)
      .get(sha256, excludePath ?? '');
    if (stillOpen) return undefined;
    const candidate = this.db
      .prepare(
        `SELECT * FROM files WHERE sha256 = ? AND status = 'ignored' AND ignored_reason = 'duplicate'
           AND path <> ? ORDER BY id LIMIT 1`,
      )
      .get(sha256, excludePath ?? '') as FileRecord | undefined;
    if (!candidate) return undefined;
    this.db
      .prepare(
        `UPDATE files SET status = 'pending', ignored_reason = NULL, duplicate_of = NULL, error = NULL,
           retry_count = 0, next_attempt_at = NULL, updated_at = ? WHERE id = ?`,
      )
      .run(iso(this.clock()), candidate.id);
    return this.getById(candidate.id);
  }

  /** The local file was removed. Uploaded rows are kept as history; nothing is ever deleted in the cloud. */
  markDeleted(relPath: string): void {
    this.db.transaction(() => {
      const row = this.getByPath(relPath);
      if (!row) return;
      if (row.status === 'pending' || row.status === 'failed') {
        this.setIgnored(row.id, 'deleted', 'Local file deleted before upload');
        this.promoteDuplicate(row.sha256, row.path);
      } else if (row.status === 'ignored' && row.ignored_reason === 'duplicate') {
        this.setIgnored(row.id, 'deleted', 'Local file deleted (duplicate)');
      }
    })();
  }

  /** A queued file vanished from disk when the worker tried to upload it. */
  markMissing(id: number): void {
    this.db.transaction(() => {
      const row = this.getById(id);
      if (!row) return;
      this.setIgnored(id, 'missing', 'File not found on disk at upload time');
      this.promoteDuplicate(row.sha256, row.path);
    })();
  }

  markDuplicate(id: number, duplicateOf: string): void {
    this.db
      .prepare(
        `UPDATE files SET status = 'ignored', ignored_reason = 'duplicate', duplicate_of = ?, error = ?,
           next_attempt_at = NULL, updated_at = ? WHERE id = ?`,
      )
      .run(duplicateOf, `Duplicate: already uploaded as ${duplicateOf}`, iso(this.clock()), id);
  }

  private setIgnored(id: number, reason: IgnoredReason, error: string): void {
    this.db
      .prepare(
        `UPDATE files SET status = 'ignored', ignored_reason = ?, error = ?, next_attempt_at = NULL,
           updated_at = ? WHERE id = ?`,
      )
      .run(reason, error, iso(this.clock()), id);
  }

  /**
   * After a complete scan, open rows whose path was not seen are gone from
   * disk (e.g. deleted while the agent was stopped).
   */
  markUnseenAsDeleted(seen: Set<string>): number {
    const rows = this.db
      .prepare(`SELECT path FROM files WHERE status IN ('pending','failed') OR (status = 'ignored' AND ignored_reason = 'duplicate')`)
      .all() as { path: string }[];
    let n = 0;
    for (const r of rows) {
      if (!seen.has(r.path)) {
        this.markDeleted(r.path);
        n++;
      }
    }
    return n;
  }

  /** Crash recovery: anything left `uploading` goes back to `pending`. */
  recoverInterrupted(): number {
    return this.db
      .prepare(`UPDATE files SET status = 'pending', next_attempt_at = NULL, updated_at = ? WHERE status = 'uploading'`)
      .run(iso(this.clock())).changes;
  }

  /** Atomically pick the next eligible pending job and mark it `uploading`. */
  claimNext(): FileRecord | undefined {
    return this.db.transaction((): FileRecord | undefined => {
      const now = this.clock();
      const row = this.db
        .prepare(
          `SELECT * FROM files WHERE status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
           ORDER BY retry_count ASC, id ASC LIMIT 1`,
        )
        .get(now) as FileRecord | undefined;
      if (!row) return undefined;
      this.db.prepare(`UPDATE files SET status = 'uploading', updated_at = ? WHERE id = ?`).run(iso(now), row.id);
      return { ...row, status: 'uploading' };
    })();
  }

  /** Earliest time (ms) at which a pending job in backoff becomes eligible. */
  nextEligibleAt(): number | null {
    const r = this.db
      .prepare(`SELECT MIN(COALESCE(next_attempt_at, 0)) AS t FROM files WHERE status = 'pending'`)
      .get() as { t: number | null };
    return r.t;
  }

  markUploaded(id: number, remotePath: string): void {
    this.db.transaction(() => {
      const now = iso(this.clock());
      const row = this.getById(id);
      if (!row) return;
      this.db
        .prepare(
          `UPDATE files SET status = 'uploaded', remote_path = ?, uploaded_at = ?, error = NULL,
             next_attempt_at = NULL, updated_at = ? WHERE id = ?`,
        )
        .run(remotePath, now, now, id);
      this.db
        .prepare(`INSERT OR IGNORE INTO uploaded_hashes (sha256, path, remote_path, uploaded_at) VALUES (?, ?, ?, ?)`)
        .run(row.sha256, row.path, remotePath, now);
      // Any other open row with the same content is now a duplicate.
      this.db
        .prepare(
          `UPDATE files SET status = 'ignored', ignored_reason = 'duplicate', duplicate_of = ?,
             error = 'Duplicate: already uploaded as ' || ?, next_attempt_at = NULL, updated_at = ?
           WHERE sha256 = ? AND id <> ? AND status IN ('pending','failed')`,
        )
        .run(row.path, row.path, now, row.sha256, id);
    })();
  }

  /** Transient failure: schedule another attempt. */
  markRetry(id: number, error: string, nextAttemptAt: number): void {
    this.db
      .prepare(
        `UPDATE files SET status = 'pending', retry_count = retry_count + 1, error = ?, next_attempt_at = ?,
           updated_at = ? WHERE id = ?`,
      )
      .run(error, nextAttemptAt, iso(this.clock()), id);
  }

  markFailed(id: number, error: string, countAttempt = true): void {
    this.db
      .prepare(
        `UPDATE files SET status = 'failed', retry_count = retry_count + ?, error = ?, next_attempt_at = NULL,
           updated_at = ? WHERE id = ?`,
      )
      .run(countAttempt ? 1 : 0, error, iso(this.clock()), id);
  }

  /** Put a job back to `pending` without consuming a retry (shutdown, auth problems, file still changing). */
  requeue(id: number, error: string | null = null, nextAttemptAt: number | null = null): void {
    this.db
      .prepare(`UPDATE files SET status = 'pending', error = ?, next_attempt_at = ?, updated_at = ? WHERE id = ?`)
      .run(error, nextAttemptAt, iso(this.clock()), id);
  }

  retryFailed(): number {
    return this.db
      .prepare(
        `UPDATE files SET status = 'pending', retry_count = 0, error = NULL, next_attempt_at = NULL, updated_at = ?
         WHERE status = 'failed'`,
      )
      .run(iso(this.clock())).changes;
  }

  countByStatus(status: FileStatus): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM files WHERE status = ?').get(status) as { n: number }).n;
  }

  lastUpload(): FileRecord | undefined {
    return this.db
      .prepare(`SELECT * FROM files WHERE status = 'uploaded' ORDER BY uploaded_at DESC, id DESC LIMIT 1`)
      .get() as FileRecord | undefined;
  }

  stats(): Stats {
    const byStatus = Object.fromEntries(FILE_STATUSES.map((s) => [s, { count: 0, bytes: 0 }])) as Record<
      FileStatus,
      StatusCount
    >;
    const rows = this.db
      .prepare('SELECT status, COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes FROM files GROUP BY status')
      .all() as { status: FileStatus; count: number; bytes: number }[];
    for (const r of rows) byStatus[r.status] = { count: r.count, bytes: r.bytes };

    const local = this.db
      .prepare(
        `SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes FROM files
         WHERE NOT (status = 'ignored' AND ignored_reason IN ('deleted','missing'))`,
      )
      .get() as { count: number; bytes: number };

    const ignored = this.db
      .prepare(`SELECT ignored_reason AS r, COUNT(*) AS n FROM files WHERE status = 'ignored' GROUP BY ignored_reason`)
      .all() as { r: string | null; n: number }[];

    const hashes = (this.db.prepare('SELECT COUNT(*) AS n FROM uploaded_hashes').get() as { n: number }).n;

    return {
      localFiles: local.count,
      localBytes: local.bytes,
      uploadedHashes: hashes,
      byStatus,
      ignoredByReason: Object.fromEntries(ignored.map((i) => [i.r ?? 'unknown', i.n])),
      lastUploadAt: this.lastUpload()?.uploaded_at ?? null,
    };
  }

  listQueue(q: QueueQuery = {}): { items: FileRecord[]; total: number } {
    const limit = Math.min(Math.max(q.limit ?? 50, 1), 500);
    const offset = Math.max(q.offset ?? 0, 0);
    if (q.status) {
      const order = q.status === 'uploaded' ? 'uploaded_at DESC, id DESC' : q.status === 'pending' ? 'retry_count ASC, id ASC' : 'updated_at DESC, id DESC';
      const items = this.db
        .prepare(`SELECT * FROM files WHERE status = ? ORDER BY ${order} LIMIT ? OFFSET ?`)
        .all(q.status, limit, offset) as FileRecord[];
      return { items, total: this.countByStatus(q.status) };
    }
    // Default view: the actual work queue (uploading first, then pending in pick order).
    const items = this.db
      .prepare(
        `SELECT * FROM files WHERE status IN ('uploading','pending')
         ORDER BY CASE status WHEN 'uploading' THEN 0 ELSE 1 END, retry_count ASC, id ASC LIMIT ? OFFSET ?`,
      )
      .all(limit, offset) as FileRecord[];
    const total = (
      this.db.prepare(`SELECT COUNT(*) AS n FROM files WHERE status IN ('uploading','pending')`).get() as { n: number }
    ).n;
    return { items, total };
  }

  getMeta(key: string): string | null {
    const r = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return r?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  ping(): boolean {
    return (this.db.prepare('SELECT 1 AS ok').get() as { ok: number }).ok === 1;
  }
}
