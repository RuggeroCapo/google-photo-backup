import fs from 'node:fs/promises';
import type { Logger } from 'pino';
import type { Config } from './config.js';
import { openDatabase, type DB } from './db/database.js';
import { FileRepository } from './db/repository.js';
import { FileFilter } from './scanner/filter.js';
import { Ingestor } from './scanner/ingestor.js';
import { Scanner } from './scanner/scanner.js';
import { PhotoWatcher } from './scanner/watcher.js';
import { UploadWindow } from './queue/scheduler.js';
import { UploadWorker } from './queue/worker.js';
import { RcloneGooglePhotosUploader } from './upload/rclone-uploader.js';
import type { PhotoUploader } from './types.js';

export interface AgentDeps {
  logger: Logger;
  uploader?: PhotoUploader;
  db?: DB;
  clock?: () => number;
  /** Max sleep of idle worker loops (tests use a small value). */
  idlePollMs?: number;
}

export const VERSION = '1.0.0';

/** Wires scanner → ingestor → SQLite queue → worker → uploader. */
export class PhotoBackupAgent {
  readonly repo: FileRepository;
  readonly filter: FileFilter;
  readonly ingestor: Ingestor;
  readonly scanner: Scanner;
  readonly watcher: PhotoWatcher | null;
  readonly worker: UploadWorker;
  readonly window: UploadWindow;
  readonly uploader: PhotoUploader;
  readonly startedAt = Date.now();

  private readonly db: DB;
  private readonly logger: Logger;
  private readonly clock: () => number;
  private rescanTimer: NodeJS.Timeout | null = null;
  private rcloneIssue: string | null = null;
  private stopped = false;

  constructor(
    readonly config: Config,
    deps: AgentDeps,
  ) {
    this.logger = deps.logger;
    this.clock = deps.clock ?? Date.now;
    this.db = deps.db ?? openDatabase(config.databasePath);
    this.repo = new FileRepository(this.db, deps.clock);
    this.filter = new FileFilter(config.photosDir, config.extensions);
    this.window = new UploadWindow(config.scheduleStart, config.scheduleEnd);

    this.uploader =
      deps.uploader ??
      new RcloneGooglePhotosUploader({
        binary: config.rcloneBinary,
        configPath: config.rcloneConfig,
        remote: config.rcloneRemote,
        destPath: config.rcloneDestPath,
        albumMode: config.albumMode,
        maxUploadMbps: config.maxUploadMbps,
        concurrency: config.uploadConcurrency,
        timeoutMs: config.uploadTimeoutMs,
        extraArgs: config.rcloneExtraArgs,
      });

    this.ingestor = new Ingestor({
      filter: this.filter,
      repo: this.repo,
      logger: this.logger.child({ component: 'ingestor' }),
      stabilityWindowMs: config.stabilityWindowMs,
      hashConcurrency: config.hashConcurrency,
      clock: deps.clock,
      onIngested: (rec) => {
        if (rec.status === 'pending') this.worker.notify();
      },
    });

    this.scanner = new Scanner({
      filter: this.filter,
      ingestor: this.ingestor,
      repo: this.repo,
      logger: this.logger.child({ component: 'scanner' }),
    });

    this.watcher = config.watchEnabled
      ? new PhotoWatcher({
          filter: this.filter,
          ingestor: this.ingestor,
          repo: this.repo,
          logger: this.logger.child({ component: 'watcher' }),
          usePolling: config.watchPolling,
          pollIntervalMs: config.watchPollIntervalMs,
        })
      : null;

    this.worker = new UploadWorker({
      repo: this.repo,
      uploader: this.uploader,
      filter: this.filter,
      window: this.window,
      logger: this.logger.child({ component: 'worker' }),
      concurrency: config.uploadConcurrency,
      maxRetries: config.maxRetries,
      retryBaseMs: config.retryBaseMs,
      retryMaxMs: config.retryMaxMs,
      configErrorPauseMs: config.configErrorPauseMs,
      stabilityWindowMs: config.stabilityWindowMs,
      clock: deps.clock,
      idlePollMs: deps.idlePollMs,
      isIngestBusy: () => this.scanner.running || !this.ingestor.isIdle(),
      onFileChanged: (abs) => void this.ingestor.consider(abs),
    });
  }

  async start(options: { scan?: boolean; watch?: boolean } = {}): Promise<void> {
    const recovered = this.repo.recoverInterrupted();
    if (recovered) this.logger.warn({ recovered }, 'recovered interrupted uploads back to pending');

    await this.checkRclone();
    this.logger.info(
      {
        photosDir: this.config.photosDir,
        extensions: [...this.config.extensions],
        window: this.window.describe(),
        maxUploadMbps: this.config.maxUploadMbps || 'unlimited',
        remote: `${this.config.rcloneRemote}:${this.config.rcloneDestPath}`,
      },
      'photo backup agent starting',
    );

    this.ingestor.start();
    this.worker.start();

    if (options.watch !== false && this.watcher) {
      // Chokidar crawls the whole tree to set up watches; don't block startup on it.
      void this.watcher.start().catch((err) => this.logger.error({ err }, 'failed to start watcher'));
    }
    if (options.scan !== false) {
      void this.scanner.scan();
      if (this.config.rescanIntervalMs > 0) {
        this.rescanTimer = setInterval(() => void this.scanner.scan(), this.config.rescanIntervalMs);
        this.rescanTimer.unref();
      }
    }
  }

  /** "Sync now": rescan and upload immediately, ignoring the schedule, until the queue is drained. */
  syncNow(): void {
    this.logger.info('manual sync requested');
    this.worker.syncNow();
    if (!this.scanner.running) void this.scanner.scan().then(() => this.worker.notify());
  }

  retryFailed(): number {
    const n = this.repo.retryFailed();
    this.logger.info({ requeued: n }, 'failed files re-queued');
    this.worker.notify();
    return n;
  }

  async checkRclone(): Promise<void> {
    if (!(this.uploader instanceof RcloneGooglePhotosUploader)) {
      this.rcloneIssue = null;
      return;
    }
    try {
      const content = await fs.readFile(this.config.rcloneConfig, 'utf8');
      this.rcloneIssue = content.includes(`[${this.config.rcloneRemote}]`)
        ? null
        : `Remote "${this.config.rcloneRemote}" not found in ${this.config.rcloneConfig}`;
    } catch {
      this.rcloneIssue = `rclone config not found at ${this.config.rcloneConfig}`;
    }
    if (this.rcloneIssue) this.logger.warn(this.rcloneIssue + ' — see README to configure Google Photos');
  }

  issues(): string[] {
    const issues: string[] = [];
    if (this.rcloneIssue) issues.push(this.rcloneIssue);
    if (this.worker.configError) issues.push(`Upload configuration error: ${this.worker.configError.message}`);
    const scanError = this.scanner.lastResult?.error;
    if (scanError) issues.push(scanError);
    return issues;
  }

  status() {
    const stats = this.repo.stats();
    const pending = stats.byStatus.pending.count;
    const uploading = stats.byStatus.uploading.count;
    const last = this.repo.lastUpload();
    const current = [...this.worker.current.values()];
    const issues = this.issues();
    const now = new Date(this.clock());
    return {
      status: issues.length ? 'degraded' : 'healthy',
      version: VERSION,
      uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
      queueSize: pending + uploading,
      pending,
      uploading,
      failed: stats.byStatus.failed.count,
      uploaded: stats.byStatus.uploaded.count,
      lastUpload: last?.uploaded_at ?? null,
      lastUploadFile: last?.path ?? null,
      currentUpload: current[0] ?? null,
      currentUploads: current,
      uploadingNow: this.worker.canUploadNow(),
      manualSync: this.worker.manualSync,
      schedule: {
        window: this.window.describe(),
        open: this.window.isOpen(now),
        nextOpenAt: this.window.nextOpen(now)?.toISOString() ?? null,
      },
      paused: this.worker.pausedUntil
        ? { until: new Date(this.worker.pausedUntil).toISOString(), reason: this.worker.pauseReason }
        : null,
      scanning: this.scanner.running,
      lastScan: this.scanner.lastResult,
      ingest: { waitingForStability: this.ingestor.waitingForStability, hashing: this.ingestor.hashing },
      watcher: { enabled: this.watcher !== null, ready: this.watcher?.ready ?? false },
      lastError: this.worker.lastError,
      issues,
    };
  }

  stats() {
    return {
      ...this.repo.stats(),
      config: {
        photosDir: this.config.photosDir,
        extensions: [...this.config.extensions].sort(),
        remote: `${this.config.rcloneRemote}:${this.config.rcloneDestPath}`,
        albumMode: this.config.albumMode,
        maxUploadMbps: this.config.maxUploadMbps,
        uploadConcurrency: this.config.uploadConcurrency,
        maxRetries: this.config.maxRetries,
        schedule: this.window.describe(),
      },
    };
  }

  healthy(): boolean {
    try {
      return this.repo.ping();
    } catch {
      return false;
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.logger.info('shutting down');
    if (this.rescanTimer) clearInterval(this.rescanTimer);
    await this.watcher?.stop();
    await this.worker.stop();
    const scanDone = this.scanner.stop();
    await this.ingestor.stop();
    await scanDone;
    this.db.close();
    this.logger.info('shutdown complete');
  }
}
