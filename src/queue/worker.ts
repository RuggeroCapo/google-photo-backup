import fs from 'node:fs/promises';
import type { Logger } from 'pino';
import type { FileRepository } from '../db/repository.js';
import type { FileFilter } from '../scanner/filter.js';
import type { FileRecord, PhotoFile, PhotoUploader, UploadErrorKind, UploadResult } from '../types.js';
import { backoffDelay, type UploadWindow } from './scheduler.js';

export interface WorkerOptions {
  repo: FileRepository;
  uploader: PhotoUploader;
  filter: FileFilter;
  window: UploadWindow;
  logger: Logger;
  concurrency: number;
  maxRetries: number;
  retryBaseMs: number;
  retryMaxMs: number;
  /** Global pause after a configuration/auth error (rclone not configured, token revoked…). */
  configErrorPauseMs: number;
  stabilityWindowMs: number;
  /** True while files are still being discovered/hashed (keeps a manual sync alive). */
  isIngestBusy?: () => boolean;
  /** Called when a queued file turns out to have changed on disk. */
  onFileChanged?: (absPath: string) => void;
  clock?: () => number;
  /** Max sleep between queue polls when idle. */
  idlePollMs?: number;
}

export interface CurrentUpload {
  id: number;
  path: string;
  size: number;
  startedAt: string;
}

export interface WorkerError {
  at: string;
  kind: UploadErrorKind;
  message: string;
  path?: string;
}

const isEnoent = (e: unknown) => (e as NodeJS.ErrnoException)?.code === 'ENOENT';

/**
 * Pulls jobs from the persistent queue and uploads them, honouring the upload
 * window, manual "sync now" sessions, exponential backoff and global pauses
 * (rate limiting / configuration problems). A failing file never blocks the
 * queue: it is rescheduled with a backoff and other files are picked meanwhile.
 */
export class UploadWorker {
  private loops: Promise<void>[] = [];
  private stopping = false;
  private readonly wakers = new Set<() => void>();
  private readonly abort = new AbortController();
  private readonly clock: () => number;

  readonly current = new Map<number, CurrentUpload>();
  manualSync = false;
  pausedUntil: number | null = null;
  pauseReason: string | null = null;
  lastError: WorkerError | null = null;
  configError: WorkerError | null = null;
  lastSuccessAt: string | null = null;

  constructor(private readonly opts: WorkerOptions) {
    this.clock = opts.clock ?? Date.now;
  }

  get running(): boolean {
    return this.loops.length > 0 && !this.stopping;
  }

  start(): void {
    if (this.loops.length) return;
    for (let i = 0; i < Math.max(1, this.opts.concurrency); i++) {
      this.loops.push(this.loop(i));
    }
  }

  /** Abort in-flight uploads (they go back to `pending`) and wait for the loops to exit. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.abort.abort();
    this.notify();
    await Promise.allSettled(this.loops);
    this.loops = [];
  }

  /** Upload now, regardless of the schedule, until the queue is drained. Also clears pauses. */
  syncNow(): void {
    this.manualSync = true;
    this.pausedUntil = null;
    this.pauseReason = null;
    this.notify();
  }

  /** Wake idle loops (new work, manual sync…). */
  notify(): void {
    for (const w of [...this.wakers]) w();
  }

  canUploadNow(): boolean {
    const now = this.clock();
    if (this.pausedUntil !== null && now < this.pausedUntil) return false;
    return this.manualSync || this.opts.window.isOpen(new Date(now));
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(t);
        this.wakers.delete(done);
        resolve();
      };
      const t = setTimeout(done, Math.max(0, ms));
      this.wakers.add(done);
    });
  }

  private async loop(n: number): Promise<void> {
    const idlePoll = this.opts.idlePollMs ?? 30_000;
    while (!this.stopping) {
      try {
        const now = this.clock();
        if (this.pausedUntil !== null) {
          if (now < this.pausedUntil) {
            await this.sleep(Math.min(this.pausedUntil - now, idlePoll));
            continue;
          }
          this.pausedUntil = null;
          this.pauseReason = null;
        }
        if (!this.manualSync && !this.opts.window.isOpen(new Date(now))) {
          await this.sleep(Math.min(this.opts.window.msUntilOpen(new Date(now)), idlePoll));
          continue;
        }

        const job = this.opts.repo.claimNext();
        if (!job) {
          if (this.manualSync && this.current.size === 0 && !(this.opts.isIngestBusy?.() ?? false)) {
            this.manualSync = false;
            this.opts.logger.info('manual sync finished: queue drained');
          }
          const next = this.opts.repo.nextEligibleAt();
          const delay = next === null ? idlePoll : Math.min(Math.max(next - now, 50), idlePoll);
          await this.sleep(delay);
          continue;
        }
        await this.process(job);
      } catch (err) {
        this.opts.logger.error({ err, loop: n }, 'worker loop error');
        await this.sleep(5000);
      }
    }
  }

  private async process(job: FileRecord): Promise<void> {
    const { repo, filter, logger } = this.opts;
    const abs = filter.absolute(job.path);

    try {
      const st = await fs.stat(abs);
      if (st.size !== job.size || Math.trunc(st.mtimeMs) !== job.mtime) {
        repo.requeue(job.id, 'File changed since it was hashed; waiting for it to settle', this.clock() + this.opts.stabilityWindowMs);
        this.opts.onFileChanged?.(abs);
        return;
      }
    } catch (e) {
      if (isEnoent(e)) {
        logger.warn({ file: job.path }, 'queued file no longer exists');
        repo.markMissing(job.id);
        return;
      }
      this.handleFailure(job, { ok: false, kind: 'unknown', retryable: true, error: `stat failed: ${(e as Error).message}` });
      return;
    }

    if (this.stopping) {
      repo.requeue(job.id);
      return;
    }

    const already = repo.uploadedHash(job.sha256);
    if (already) {
      logger.info({ file: job.path, duplicateOf: already.path }, 'skipping duplicate content');
      repo.markDuplicate(job.id, already.path);
      return;
    }

    const file: PhotoFile = {
      id: job.id,
      absolutePath: abs,
      relativePath: job.path,
      filename: job.filename,
      size: job.size,
      sha256: job.sha256,
      mimeType: job.mime_type,
    };

    this.current.set(job.id, { id: job.id, path: job.path, size: job.size, startedAt: new Date(this.clock()).toISOString() });
    logger.info({ file: job.path, size: job.size, attempt: job.retry_count + 1 }, 'upload started');
    const started = this.clock();
    let result: UploadResult;
    try {
      result = await this.opts.uploader.upload(file, { signal: this.abort.signal });
    } catch (e) {
      result = { ok: false, kind: 'unknown', retryable: true, error: (e as Error).message ?? String(e) };
    } finally {
      this.current.delete(job.id);
    }

    if (result.ok) {
      repo.markUploaded(job.id, result.remotePath);
      this.lastSuccessAt = new Date(this.clock()).toISOString();
      this.configError = null;
      logger.info({ file: job.path, remote: result.remotePath, ms: this.clock() - started }, 'upload completed');
      // If the file changed during the upload, make sure the new content is picked up too.
      try {
        const st = await fs.stat(abs);
        if (st.size !== job.size || Math.trunc(st.mtimeMs) !== job.mtime) this.opts.onFileChanged?.(abs);
      } catch {
        /* gone: nothing to do */
      }
      return;
    }
    this.handleFailure(job, result);
  }

  private handleFailure(job: FileRecord, result: Extract<UploadResult, { ok: false }>): void {
    const { repo, logger } = this.opts;
    const now = this.clock();
    const err: WorkerError = { at: new Date(now).toISOString(), kind: result.kind, message: result.error, path: job.path };

    if (result.kind === 'aborted') {
      repo.requeue(job.id);
      logger.info({ file: job.path }, 'upload interrupted, re-queued');
      return;
    }

    this.lastError = err;

    if (result.kind === 'config') {
      // Not this file's fault: don't burn its retries, pause everything instead.
      repo.requeue(job.id, result.error, now + this.opts.configErrorPauseMs);
      this.configError = err;
      this.pause(this.opts.configErrorPauseMs, `configuration error: ${result.error}`);
      logger.error({ file: job.path, error: result.error }, 'rclone configuration/auth error; pausing uploads');
      return;
    }

    if (!result.retryable) {
      repo.markFailed(job.id, result.error);
      logger.error({ file: job.path, kind: result.kind, error: result.error }, 'upload failed permanently');
      return;
    }

    const attempt = job.retry_count + 1;
    if (attempt > this.opts.maxRetries) {
      repo.markFailed(job.id, `${result.error} (gave up after ${attempt} attempts)`);
      logger.error({ file: job.path, kind: result.kind, attempts: attempt }, 'upload failed, max retries reached');
      return;
    }

    const delay = backoffDelay(attempt, this.opts.retryBaseMs, this.opts.retryMaxMs);
    repo.markRetry(job.id, result.error, now + delay);
    logger.warn({ file: job.path, kind: result.kind, attempt, retryInSec: Math.round(delay / 1000), error: result.error }, 'upload failed, will retry');
    if (result.kind === 'rate_limit') this.pause(delay, 'rate limited by Google Photos');
  }

  private pause(ms: number, reason: string): void {
    const until = this.clock() + ms;
    if (this.pausedUntil === null || until > this.pausedUntil) {
      this.pausedUntil = until;
      this.pauseReason = reason;
    }
  }
}
