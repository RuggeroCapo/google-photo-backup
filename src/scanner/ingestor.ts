import fs from 'node:fs/promises';
import type { Stats } from 'node:fs';
import type { Logger } from 'pino';
import type { FileRepository } from '../db/repository.js';
import type { FileRecord } from '../types.js';
import { mimeTypeFor } from '../mime.js';
import type { FileFilter } from './filter.js';
import { sha256File } from './hash.js';

export interface IngestorOptions {
  filter: FileFilter;
  repo: FileRepository;
  logger: Logger;
  /** A file must keep the same size/mtime for this long before it is processed. */
  stabilityWindowMs: number;
  hashConcurrency: number;
  /** Max files waiting for hashing before `waitForCapacity` applies back-pressure. */
  maxHashQueue?: number;
  clock?: () => number;
  onIngested?: (record: FileRecord) => void;
}

interface Snapshot {
  size: number;
  mtimeMs: number;
  observedAt: number;
}

const isEnoent = (e: unknown) => (e as NodeJS.ErrnoException)?.code === 'ENOENT';

/**
 * Turns "a file showed up" into a queue row:
 *   1. waits until the file is stable (size and mtime unchanged for the window),
 *   2. hashes it (SHA-256, streamed, bounded concurrency),
 *   3. upserts it in the repository, which applies deduplication.
 */
export class Ingestor {
  private readonly candidates = new Map<string, Snapshot>();
  private readonly hashQueue: string[] = [];
  private readonly queued = new Set<string>();
  private activeHashes = 0;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private stopped = false;
  private readonly abort = new AbortController();
  private capacityWaiters: (() => void)[] = [];
  private idleWaiters: (() => void)[] = [];
  private readonly clock: () => number;
  private readonly maxHashQueue: number;

  constructor(private readonly opts: IngestorOptions) {
    this.clock = opts.clock ?? Date.now;
    this.maxHashQueue = opts.maxHashQueue ?? 1000;
  }

  start(): void {
    if (this.timer) return;
    const interval = Math.min(Math.max(Math.floor(this.opts.stabilityWindowMs / 4), 50), 5000);
    this.timer = setInterval(() => void this.tick(), interval);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.abort.abort();
    this.hashQueue.length = 0;
    this.queued.clear();
    this.candidates.clear();
    this.capacityWaiters.splice(0).forEach((r) => r());
    while (this.activeHashes > 0) await new Promise((r) => setTimeout(r, 20));
    this.idleWaiters.splice(0).forEach((r) => r());
  }

  /** Files waiting for stability or hashing. */
  get pendingCount(): number {
    return this.candidates.size + this.hashQueue.length + this.activeHashes;
  }

  get waitingForStability(): number {
    return this.candidates.size;
  }

  get hashing(): number {
    return this.hashQueue.length + this.activeHashes;
  }

  isIdle(): boolean {
    return this.pendingCount === 0;
  }

  /** Resolves when nothing is waiting for stability or hashing. */
  waitIdle(): Promise<void> {
    if (this.isIdle() || this.stopped) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  /** Back-pressure for the scanner, so a huge first scan doesn't build an unbounded queue. */
  waitForCapacity(): Promise<void> {
    if (this.hashQueue.length < this.maxHashQueue || this.stopped) return Promise.resolve();
    return new Promise((resolve) => this.capacityWaiters.push(resolve));
  }

  /** Report a (possibly new or changed) file. Safe to call repeatedly. */
  async consider(absPath: string): Promise<void> {
    if (this.stopped || !this.opts.filter.accepts(absPath)) return;
    if (this.queued.has(absPath)) return;

    let st: Stats;
    try {
      st = await fs.stat(absPath);
    } catch (e) {
      if (!isEnoent(e)) this.opts.logger.warn({ err: e, file: absPath }, 'stat failed');
      this.candidates.delete(absPath);
      return;
    }
    if (!st.isFile()) return;

    const rel = this.opts.filter.relative(absPath)!;
    if (this.opts.repo.isKnownUnchanged(rel, st.size, Math.trunc(st.mtimeMs))) {
      this.candidates.delete(absPath);
      this.checkIdle();
      return;
    }

    const prev = this.candidates.get(absPath);
    if (prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs) return; // still waiting

    if (!prev && this.isQuiet(st)) {
      this.enqueueHash(absPath);
    } else {
      // New or still changing: (re)start the stability window.
      this.candidates.set(absPath, { size: st.size, mtimeMs: st.mtimeMs, observedAt: this.clock() });
    }
  }

  /**
   * A file nobody has touched (data or metadata) for the whole window is
   * stable without waiting. ctime cannot be forged by copy tools that preserve
   * mtime (cp -p, rsync -t), so this is safe for files being copied right now.
   */
  private isQuiet(st: Stats): boolean {
    const lastChange = Math.max(st.mtimeMs, st.ctimeMs);
    return this.clock() - lastChange >= this.opts.stabilityWindowMs;
  }

  /** Re-check candidates whose window elapsed. Exposed for tests. */
  async tick(): Promise<void> {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    try {
      const now = this.clock();
      for (const [abs, snap] of [...this.candidates]) {
        if (now - snap.observedAt < this.opts.stabilityWindowMs) continue;
        let st: Stats;
        try {
          st = await fs.stat(abs);
        } catch (e) {
          if (!isEnoent(e)) this.opts.logger.warn({ err: e, file: abs }, 'stat failed');
          this.candidates.delete(abs);
          continue;
        }
        if (st.size === snap.size && st.mtimeMs === snap.mtimeMs) {
          this.candidates.delete(abs);
          this.enqueueHash(abs);
        } else {
          this.opts.logger.debug({ file: abs }, 'file still changing, waiting');
          this.candidates.set(abs, { size: st.size, mtimeMs: st.mtimeMs, observedAt: this.clock() });
        }
      }
    } finally {
      this.ticking = false;
      this.checkIdle();
    }
  }

  private enqueueHash(abs: string): void {
    if (this.queued.has(abs)) return;
    this.queued.add(abs);
    this.hashQueue.push(abs);
    this.pump();
  }

  private pump(): void {
    while (!this.stopped && this.activeHashes < this.opts.hashConcurrency && this.hashQueue.length > 0) {
      const abs = this.hashQueue.shift()!;
      this.activeHashes++;
      void this.hashOne(abs).finally(() => {
        this.activeHashes--;
        this.queued.delete(abs);
        this.pump();
        this.checkIdle();
      });
    }
    if (this.hashQueue.length < this.maxHashQueue) this.capacityWaiters.splice(0).forEach((r) => r());
  }

  private async hashOne(abs: string): Promise<void> {
    const { repo, filter, logger } = this.opts;
    try {
      const before = await fs.stat(abs);
      const sha256 = await sha256File(abs, this.abort.signal);
      const after = await fs.stat(abs);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
        // Modified while hashing: back to the stability window.
        this.candidates.set(abs, { size: after.size, mtimeMs: after.mtimeMs, observedAt: this.clock() });
        return;
      }
      const record = repo.upsertScanned({
        path: filter.relative(abs)!,
        size: after.size,
        mtime: Math.trunc(after.mtimeMs),
        sha256,
        mimeType: mimeTypeFor(abs),
      });
      logger.debug({ file: record.path, status: record.status }, 'file ingested');
      this.opts.onIngested?.(record);
    } catch (e) {
      if (this.stopped || isEnoent(e)) return;
      logger.warn({ err: e, file: abs }, 'failed to hash file');
    }
  }

  private checkIdle(): void {
    if (this.isIdle()) this.idleWaiters.splice(0).forEach((r) => r());
  }
}
