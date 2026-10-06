import chokidar, { type FSWatcher } from 'chokidar';
import type { Logger } from 'pino';
import type { FileRepository } from '../db/repository.js';
import type { FileFilter } from './filter.js';
import type { Ingestor } from './ingestor.js';

export interface WatcherOptions {
  filter: FileFilter;
  ingestor: Ingestor;
  repo: FileRepository;
  logger: Logger;
  usePolling: boolean;
  pollIntervalMs: number;
}

/**
 * Live filesystem watcher. The initial state is handled by the Scanner
 * (ignoreInitial), and stability is handled by the Ingestor, so chokidar's own
 * awaitWriteFinish is not used.
 */
export class PhotoWatcher {
  private watcher: FSWatcher | null = null;
  ready = false;

  constructor(private readonly opts: WatcherOptions) {}

  start(): Promise<void> {
    const { filter, ingestor, repo, logger } = this.opts;
    this.watcher = chokidar.watch(filter.root, {
      ignoreInitial: true,
      persistent: true,
      followSymlinks: false,
      usePolling: this.opts.usePolling,
      interval: this.opts.pollIntervalMs,
      binaryInterval: this.opts.pollIntervalMs,
      ignored: (p: string) => filter.ignoresPath(p),
    });

    const onFile = (p: string) => {
      if (!filter.accepts(p)) return;
      void ingestor.consider(p).catch((err) => logger.warn({ err, file: p }, 'watcher: consider failed'));
    };
    this.watcher.on('add', onFile);
    this.watcher.on('change', onFile);
    this.watcher.on('unlink', (p) => {
      if (!filter.accepts(p)) return;
      const rel = filter.relative(p);
      if (rel) repo.markDeleted(rel);
    });
    this.watcher.on('error', (err) => logger.error({ err }, 'watcher error'));

    return new Promise((resolve) => {
      this.watcher!.once('ready', () => {
        this.ready = true;
        logger.info({ root: filter.root, polling: this.opts.usePolling }, 'watcher ready');
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    this.ready = false;
    await this.watcher?.close();
    this.watcher = null;
  }
}
