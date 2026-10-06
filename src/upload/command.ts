import { spawn } from 'node:child_process';

export interface CommandResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  spawnError?: NodeJS.ErrnoException;
}

export interface CommandOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

/** Runs an external command. Injected into uploaders so tests never spawn rclone. */
export type CommandRunner = (bin: string, args: string[], options?: CommandOptions) => Promise<CommandResult>;

const MAX_OUTPUT = 64 * 1024;

function appendCapped(buf: string, chunk: Buffer): string {
  const next = buf + chunk.toString('utf8');
  return next.length > MAX_OUTPUT ? next.slice(next.length - MAX_OUTPUT) : next;
}

export const spawnCommand: CommandRunner = (bin, args, options = {}) =>
  new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const child = spawn(bin, args, { env: options.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] });

    const kill = () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        setTimeout(() => child.exitCode === null && child.signalCode === null && child.kill('SIGKILL'), 10_000).unref();
      }
    };

    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          kill();
        }, options.timeoutMs)
      : null;
    timer?.unref();

    const onAbort = () => {
      aborted = true;
      kill();
    };
    if (options.signal?.aborted) onAbort();
    options.signal?.addEventListener('abort', onAbort, { once: true });

    const finish = (r: Omit<CommandResult, 'stdout' | 'stderr' | 'timedOut' | 'aborted'>) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve({ ...r, stdout, stderr, timedOut, aborted });
    };

    child.stdout.on('data', (c: Buffer) => (stdout = appendCapped(stdout, c)));
    child.stderr.on('data', (c: Buffer) => (stderr = appendCapped(stderr, c)));
    child.on('error', (err) => finish({ code: null, signal: null, spawnError: err }));
    child.on('close', (code, signal) => finish({ code, signal }));
  });
