import fs from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from 'pino';
import type { FileRepository } from '../db/repository.js';
import type { FileFilter } from './filter.js';
import { isIgnoredName } from './filter.js';
import type { Ingestor } from './ingestor.js';

export interface ScanResult {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  filesSeen: number;
  markedDeleted: number;
  errors: number;
  error?: string;
}

/**
 * Full recursive walk of the photo root. Every supported file is handed to the
 * ingestor (which skips files already known with the same size/mtime). At the
 * end, queued rows whose file is no longer on disk are marked deleted.
 */
export class Scanner {
  private current: Promise<ScanResult> | null = null;
  private stopped = false;
  lastResult: ScanResult | null = null;

  constructor(
    private readonly opts: {
      filter: FileFilter;
      ingestor: Ingestor;
      repo: FileRepository;
      logger: Logger;
    },
  ) {}

  get running(): boolean {
    return this.current !== null;
  }

  /** Stop walking and wait for the scan in progress (if any) to return. */
  async stop(): Promise<void> {
    this.stopped = true;
    await this.current?.catch(() => undefined);
  }

  /** Start a scan, or join the one already in progress. */
  scan(): Promise<ScanResult> {
    this.current ??= this.run().finally(() => {
      this.current = null;
    });
    return this.current;
  }

  private async run(): Promise<ScanResult> {
    const { filter, ingestor, repo, logger } = this.opts;
    const started = Date.now();
    const seen = new Set<string>();
    let errors = 0;
    let fatal: string | undefined;

    logger.info({ root: filter.root }, 'scan started');

    const walk = async (dir: string): Promise<void> => {
      let handle;
      try {
        handle = await fs.opendir(dir);
      } catch (e) {
        errors++;
        logger.warn({ err: e, dir }, 'cannot read directory');
        return;
      }
      for await (const entry of handle) {
        if (this.stopped) return;
        if (isIgnoredName(entry.name)) continue;
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(abs);
        } else if (entry.isFile() && filter.accepts(abs)) {
          seen.add(filter.relative(abs)!);
          await ingestor.waitForCapacity();
          await ingestor.consider(abs);
        }
      }
    };

    try {
      const rootEntries = await fs.readdir(filter.root);
      if (rootEntries.length === 0) {
        // An empty root almost always means the disk isn't mounted: don't
        // conclude that every file was deleted.
        fatal = `Photo root ${filter.root} is empty (is the disk mounted?)`;
      } else {
        await walk(filter.root);
      }
    } catch (e) {
      fatal = `Cannot read photo root ${filter.root}: ${(e as Error).message}`;
    }

    let markedDeleted = 0;
    if (!fatal && errors === 0 && !this.stopped) {
      markedDeleted = repo.markUnseenAsDeleted(seen);
    }

    const result: ScanResult = {
      startedAt: new Date(started).toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      filesSeen: seen.size,
      markedDeleted,
      errors,
      ...(fatal ? { error: fatal } : {}),
    };
    this.lastResult = result;
    if (fatal) logger.error({ ...result }, 'scan failed');
    else logger.info({ ...result }, 'scan finished');
    return result;
  }
}
