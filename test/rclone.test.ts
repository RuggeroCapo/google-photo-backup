import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CommandOptions, CommandResult, CommandRunner } from '../src/upload/command.js';
import { spawnCommand } from '../src/upload/command.js';
import { classifyRcloneFailure } from '../src/upload/errors.js';
import { bwlimitFor, RcloneGooglePhotosUploader, type RcloneUploaderOptions } from '../src/upload/rclone-uploader.js';
import type { PhotoFile } from '../src/types.js';
import { tmpDir } from './helpers.js';

const file: PhotoFile = {
  id: 1,
  absolutePath: '/photos/2023/Trip/IMG 0001.HEIC',
  relativePath: '2023/Trip/IMG 0001.HEIC',
  filename: 'IMG 0001.HEIC',
  size: 123,
  sha256: 'abc',
  mimeType: 'image/heic',
};

const result = (r: Partial<CommandResult>): CommandResult => ({
  code: 0,
  signal: null,
  stdout: '',
  stderr: '',
  timedOut: false,
  aborted: false,
  ...r,
});

function make(r: Partial<CommandResult>, opts: Partial<RcloneUploaderOptions> = {}) {
  const calls: { bin: string; args: string[]; options?: CommandOptions }[] = [];
  const runner: CommandRunner = async (bin, args, options) => {
    calls.push({ bin, args, options });
    return result(r);
  };
  const uploader = new RcloneGooglePhotosUploader({
    binary: 'rclone',
    configPath: '/config/rclone/rclone.conf',
    remote: 'gphotos',
    destPath: 'upload',
    albumMode: 'none',
    maxUploadMbps: 0,
    concurrency: 1,
    timeoutMs: 60_000,
    runner,
    ...opts,
  });
  return { uploader, calls };
}

describe('RcloneGooglePhotosUploader (mocked rclone)', () => {
  it('uses copyto (never sync/move/delete) with the external config', async () => {
    const { uploader, calls } = make({ code: 0 });
    const res = await uploader.upload(file);
    expect(res).toEqual({ ok: true, remotePath: 'gphotos:upload/IMG 0001.HEIC' });
    expect(calls).toHaveLength(1);
    const { bin, args } = calls[0]!;
    expect(bin).toBe('rclone');
    expect(args.slice(0, 3)).toEqual(['copyto', '/photos/2023/Trip/IMG 0001.HEIC', 'gphotos:upload/IMG 0001.HEIC']);
    expect(args).toContain('--no-check-dest');
    expect(args[args.indexOf('--config') + 1]).toBe('/config/rclone/rclone.conf');
    for (const forbidden of ['sync', 'move', 'moveto', 'delete', 'deletefile', 'purge']) expect(args).not.toContain(forbidden);
    expect(args).not.toContain('--bwlimit');
  });

  it('uses the native rclone --bwlimit, converting Mbit/s and sharing it between transfers', async () => {
    expect(bwlimitFor(0, 1)).toBeNull();
    expect(bwlimitFor(20, 1)).toBe('2441k'); // 20 Mbit/s = 2.5 MB/s ≈ 2441 KiB/s
    expect(bwlimitFor(20, 2)).toBe('1220k');
    const { uploader, calls } = make({ code: 0 }, { maxUploadMbps: 20 });
    await uploader.upload(file);
    const args = calls[0]!.args;
    expect(args[args.indexOf('--bwlimit') + 1]).toBe('2441k');
  });

  it('album mode "folder" puts files into an album named after the folder', async () => {
    const { uploader, calls } = make({ code: 0 }, { albumMode: 'folder' });
    const res = await uploader.upload(file);
    expect(calls[0]!.args[2]).toBe('gphotos:album/2023/Trip/IMG 0001.HEIC');
    expect(res).toMatchObject({ ok: true, remotePath: 'gphotos:album/2023/Trip/IMG 0001.HEIC' });
    expect(uploader.remotePathFor({ ...file, relativePath: 'root.jpg', filename: 'root.jpg' })).toBe('upload/root.jpg');
  });

  it('classifies failures', async () => {
    const cases: [Partial<CommandResult>, string, boolean][] = [
      [{ code: 1, stderr: 'ERROR : googleapi: Error 429: Quota exceeded for quota metric' }, 'rate_limit', true],
      [{ code: 5, stderr: 'Failed to copy: Post "https://photoslibrary.googleapis.com": dial tcp: lookup photoslibrary.googleapis.com: no such host' }, 'network', true],
      [{ code: 1, stderr: 'ERROR : IMG.HEIC: Failed to copy: googleapi: Error 503: Service Unavailable, backendError' }, 'server', true],
      [{ code: 1, stderr: 'Failed to create file system for "gphotos:upload": didn\'t find section in config file' }, 'config', true],
      [{ code: 7, stderr: 'oauth2: cannot fetch token: 400 Bad Request Response: {"error": "invalid_grant"}' }, 'config', true],
      [{ code: 1, stderr: 'ERROR : x.mov: Failed to copy: googleapi: Error 400: Request contains an invalid media item, invalid' }, 'permanent', false],
      [{ code: 2, stderr: 'something odd happened' }, 'unknown', true],
      [{ code: null, timedOut: true }, 'network', true],
      [{ code: null, aborted: true }, 'aborted', true],
      [{ code: null, spawnError: Object.assign(new Error('spawn rclone ENOENT'), { code: 'ENOENT' }) }, 'config', true],
    ];
    for (const [r, kind, retryable] of cases) {
      const { uploader } = make(r);
      const res = await uploader.upload(file);
      expect(res, JSON.stringify(r)).toMatchObject({ ok: false, kind, retryable });
    }
  });

  it('does not treat a filename containing 500 as a server error', () => {
    expect(classifyRcloneFailure(3, 'ERROR : IMG_5001.jpg: directory not found').kind).toBe('permanent');
  });

  it('passes the abort signal and timeout to the runner', async () => {
    const { uploader, calls } = make({ code: 0 });
    const ac = new AbortController();
    await uploader.upload(file, { signal: ac.signal });
    expect(calls[0]!.options).toMatchObject({ signal: ac.signal, timeoutMs: 60_000 });
  });
});

describe('spawnCommand', () => {
  it('runs a fake rclone script and captures output / exit code', async () => {
    const dir = tmpDir();
    const fake = path.join(dir, 'fake-rclone.sh');
    fs.writeFileSync(fake, '#!/bin/sh\necho "args: $@"\necho "ERROR : googleapi: Error 429" >&2\nexit 3\n', { mode: 0o755 });
    const r = await spawnCommand(fake, ['copyto', 'a', 'b']);
    expect(r.code).toBe(3);
    expect(r.stdout).toContain('args: copyto a b');
    expect(r.stderr).toContain('429');
  });

  it('kills the process on abort', async () => {
    const ac = new AbortController();
    const p = spawnCommand('sleep', ['10'], { signal: ac.signal });
    setTimeout(() => ac.abort(), 50);
    const r = await p;
    expect(r.aborted).toBe(true);
  });

  it('reports a missing binary as spawnError', async () => {
    const r = await spawnCommand('/nonexistent/rclone', []);
    expect(r.spawnError?.code).toBe('ENOENT');
  });
});
