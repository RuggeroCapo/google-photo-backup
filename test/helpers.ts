import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { loadConfig, type Config } from '../src/config.js';
import type { PhotoFile, PhotoUploader, UploadOptions, UploadResult } from '../src/types.js';

export const silentLogger = pino({ level: 'silent' });

export function tmpDir(prefix = 'pba-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function writeFile(root: string, rel: string, content: string | Buffer, mtime?: Date): string {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  if (mtime) fs.utimesSync(abs, mtime, mtime);
  return abs;
}

export function testConfig(root: string, overrides: Record<string, string> = {}): Config {
  return loadConfig({
    PHOTOS_DIR: root,
    DATABASE_PATH: ':memory:',
    LOG_DIR: 'none',
    STABILITY_WINDOW_SECONDS: '0',
    WATCH_ENABLED: 'false',
    RESCAN_INTERVAL_MINUTES: '0',
    RETRY_BASE_SECONDS: '30',
    MAX_RETRIES: '3',
    ...overrides,
  });
}

export async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 5000, stepMs = 10): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Behaviour = (file: PhotoFile, options: UploadOptions) => Promise<UploadResult> | UploadResult;

/** In-memory uploader: records calls, behaviour scriptable per call. */
export class FakeUploader implements PhotoUploader {
  calls: PhotoFile[] = [];
  private queued: Behaviour[] = [];
  defaultBehaviour: Behaviour = (f) => ({ ok: true, remotePath: `gphotos:upload/${f.filename}` });

  /** Queue behaviours for the next calls (FIFO); afterwards `defaultBehaviour` is used. */
  script(...b: Behaviour[]): this {
    this.queued.push(...b);
    return this;
  }

  async upload(file: PhotoFile, options: UploadOptions = {}): Promise<UploadResult> {
    this.calls.push(file);
    const b = this.queued.shift() ?? this.defaultBehaviour;
    return b(file, options);
  }
}

export const fail =
  (kind: Extract<UploadResult, { ok: false }>['kind'], retryable = true, error = `simulated ${kind}`): Behaviour =>
  () => ({ ok: false, kind, retryable, error });
