import path from 'node:path';
import type { AlbumMode } from '../config.js';
import type { PhotoFile, PhotoUploader, UploadOptions, UploadResult } from '../types.js';
import { spawnCommand, type CommandRunner } from './command.js';
import { classifyRcloneFailure, summarizeOutput } from './errors.js';

export interface RcloneUploaderOptions {
  binary: string;
  configPath: string;
  /** rclone remote name, without the trailing colon (e.g. "gphotos"). */
  remote: string;
  /** Path inside the remote for files without an album (e.g. "upload"). */
  destPath: string;
  albumMode: AlbumMode;
  /** Total bandwidth budget in megabits/s (0 = unlimited). */
  maxUploadMbps: number;
  /** Number of concurrent uploads sharing the bandwidth budget. */
  concurrency: number;
  timeoutMs: number;
  extraArgs?: string[];
  runner?: CommandRunner;
}

/** Convert a Mbit/s budget split across N transfers into an rclone --bwlimit value (KiB/s). */
export function bwlimitFor(maxUploadMbps: number, concurrency: number): string | null {
  if (!maxUploadMbps || maxUploadMbps <= 0) return null;
  const bytesPerSec = (maxUploadMbps * 1_000_000) / 8 / Math.max(1, concurrency);
  return `${Math.max(1, Math.floor(bytesPerSec / 1024))}k`;
}

/**
 * Uploads one file at a time with `rclone copyto` into the Google Photos
 * backend. rclone owns OAuth (token refresh is written back to rclone.conf),
 * bandwidth limiting (--bwlimit) and the actual Google Photos API calls.
 * Never uses sync/move/delete: the backup is strictly one-way.
 */
export class RcloneGooglePhotosUploader implements PhotoUploader {
  private readonly runner: CommandRunner;

  constructor(private readonly opts: RcloneUploaderOptions) {
    this.runner = opts.runner ?? spawnCommand;
  }

  remotePathFor(file: PhotoFile): string {
    const name = sanitizeName(file.filename);
    if (this.opts.albumMode === 'folder') {
      const dir = path.posix.dirname(file.relativePath);
      if (dir && dir !== '.') return `album/${dir}/${name}`;
    }
    return this.opts.destPath ? `${this.opts.destPath}/${name}` : name;
  }

  buildArgs(file: PhotoFile): string[] {
    const args = [
      'copyto',
      file.absolutePath,
      `${this.opts.remote}:${this.remotePathFor(file)}`,
      '--config',
      this.opts.configPath,
      // We deduplicate ourselves; checking the destination would list whole albums.
      '--no-check-dest',
      // Retries/backoff are owned by the agent's queue.
      '--retries',
      '1',
      '--low-level-retries',
      '3',
      '--stats',
      '0',
    ];
    const bw = bwlimitFor(this.opts.maxUploadMbps, this.opts.concurrency);
    if (bw) args.push('--bwlimit', bw);
    if (this.opts.extraArgs?.length) args.push(...this.opts.extraArgs);
    return args;
  }

  async upload(file: PhotoFile, options: UploadOptions = {}): Promise<UploadResult> {
    const remotePath = this.remotePathFor(file);
    const res = await this.runner(this.opts.binary, this.buildArgs(file), {
      signal: options.signal,
      timeoutMs: this.opts.timeoutMs,
    });

    if (res.aborted) return { ok: false, kind: 'aborted', retryable: true, error: 'Upload aborted (shutdown)' };
    if (res.spawnError) {
      const msg =
        res.spawnError.code === 'ENOENT'
          ? `rclone binary not found: ${this.opts.binary}`
          : `Failed to start rclone: ${res.spawnError.message}`;
      return { ok: false, kind: 'config', retryable: true, error: msg };
    }
    if (res.timedOut) {
      return { ok: false, kind: 'network', retryable: true, error: `Upload timed out after ${Math.round(this.opts.timeoutMs / 1000)}s` };
    }
    if (res.code === 0) return { ok: true, remotePath: `${this.opts.remote}:${remotePath}` };

    const output = `${res.stderr}\n${res.stdout}`;
    const { kind, retryable } = classifyRcloneFailure(res.code, output);
    const summary = summarizeOutput(output) || `rclone exited with code ${res.code ?? res.signal}`;
    return { ok: false, kind, retryable, error: `[rclone exit ${res.code ?? res.signal}] ${summary}` };
  }
}

/** Google Photos keeps the file name as the item title; strip characters rclone/remote paths dislike. */
function sanitizeName(name: string): string {
  return name.replace(/[\\/\u0000-\u001f]/g, '_');
}
