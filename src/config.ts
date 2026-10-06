import path from 'node:path';

export const DEFAULT_EXTENSIONS = ['jpg', 'jpeg', 'heic', 'png', 'mp4', 'mov'] as const;
export const RAW_EXTENSIONS = ['arw', 'cr2', 'cr3', 'nef', 'raf', 'orf', 'rw2', 'dng'] as const;

export type AlbumMode = 'none' | 'folder';

export interface Config {
  photosDir: string;
  databasePath: string;
  logDir: string | null;
  logLevel: string;
  port: number;
  host: string;

  extensions: Set<string>;
  stabilityWindowMs: number;
  hashConcurrency: number;
  rescanIntervalMs: number;
  watchEnabled: boolean;
  watchPolling: boolean;
  watchPollIntervalMs: number;

  rcloneBinary: string;
  rcloneConfig: string;
  rcloneRemote: string;
  rcloneDestPath: string;
  albumMode: AlbumMode;
  rcloneExtraArgs: string[];
  uploadTimeoutMs: number;
  uploadConcurrency: number;
  maxUploadMbps: number;

  maxRetries: number;
  retryBaseMs: number;
  retryMaxMs: number;
  configErrorPauseMs: number;

  scheduleStart: string | null;
  scheduleEnd: string | null;
}

type Env = Record<string, string | undefined>;

function str(env: Env, key: string, def: string): string {
  const v = env[key];
  return v === undefined || v.trim() === '' ? def : v.trim();
}

function optStr(env: Env, key: string): string | null {
  const v = env[key];
  return v === undefined || v.trim() === '' ? null : v.trim();
}

function num(env: Env, key: string, def: number, min = 0): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) {
    throw new Error(`Invalid value for ${key}: "${raw}" (expected a number >= ${min})`);
  }
  return n;
}

function bool(env: Env, key: string, def: boolean): boolean {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return def;
  const v = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  throw new Error(`Invalid boolean for ${key}: "${raw}"`);
}

function list(env: Env, key: string): string[] {
  const raw = env[key];
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase().replace(/^\./, ''))
    .filter(Boolean);
}

const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/;

export function loadConfig(env: Env = process.env): Config {
  const extensions = new Set<string>(DEFAULT_EXTENSIONS);
  if (bool(env, 'INCLUDE_RAW', false)) RAW_EXTENSIONS.forEach((e) => extensions.add(e));
  list(env, 'EXTRA_EXTENSIONS').forEach((e) => extensions.add(e));
  list(env, 'EXCLUDE_EXTENSIONS').forEach((e) => extensions.delete(e));

  const albumMode = str(env, 'GPHOTOS_ALBUM_MODE', 'none') as AlbumMode;
  if (albumMode !== 'none' && albumMode !== 'folder') {
    throw new Error(`Invalid GPHOTOS_ALBUM_MODE: "${albumMode}" (expected none|folder)`);
  }

  const scheduleStart = optStr(env, 'SCHEDULE_START');
  const scheduleEnd = optStr(env, 'SCHEDULE_END');
  if ((scheduleStart === null) !== (scheduleEnd === null)) {
    throw new Error('SCHEDULE_START and SCHEDULE_END must be both set or both empty');
  }
  for (const [k, v] of [['SCHEDULE_START', scheduleStart], ['SCHEDULE_END', scheduleEnd]] as const) {
    if (v !== null && !HHMM.test(v)) throw new Error(`Invalid ${k}: "${v}" (expected HH:MM)`);
  }

  const logDir = str(env, 'LOG_DIR', '/logs');

  return {
    photosDir: path.resolve(str(env, 'PHOTOS_DIR', '/photos')),
    databasePath: str(env, 'DATABASE_PATH', '/database/photo-backup.db'),
    logDir: logDir === 'none' ? null : logDir,
    logLevel: str(env, 'LOG_LEVEL', 'info'),
    port: num(env, 'PORT', 8080, 1),
    host: str(env, 'HOST', '0.0.0.0'),

    extensions,
    stabilityWindowMs: num(env, 'STABILITY_WINDOW_SECONDS', 30) * 1000,
    hashConcurrency: Math.max(1, Math.floor(num(env, 'HASH_CONCURRENCY', 2, 1))),
    rescanIntervalMs: num(env, 'RESCAN_INTERVAL_MINUTES', 360) * 60_000,
    watchEnabled: bool(env, 'WATCH_ENABLED', true),
    watchPolling: bool(env, 'WATCH_POLLING', false),
    watchPollIntervalMs: num(env, 'WATCH_POLL_INTERVAL_SECONDS', 30, 1) * 1000,

    rcloneBinary: str(env, 'RCLONE_BINARY', 'rclone'),
    rcloneConfig: str(env, 'RCLONE_CONFIG', '/config/rclone/rclone.conf'),
    rcloneRemote: str(env, 'RCLONE_REMOTE', 'gphotos').replace(/:$/, ''),
    rcloneDestPath: str(env, 'RCLONE_DEST_PATH', 'upload').replace(/^\/+|\/+$/g, ''),
    albumMode,
    rcloneExtraArgs: (optStr(env, 'RCLONE_EXTRA_ARGS') ?? '').split(/\s+/).filter(Boolean),
    uploadTimeoutMs: num(env, 'UPLOAD_TIMEOUT_MINUTES', 120, 1) * 60_000,
    uploadConcurrency: Math.max(1, Math.floor(num(env, 'UPLOAD_CONCURRENCY', 1, 1))),
    maxUploadMbps: num(env, 'MAX_UPLOAD_MBPS', 0),

    maxRetries: Math.floor(num(env, 'MAX_RETRIES', 8)),
    retryBaseMs: num(env, 'RETRY_BASE_SECONDS', 30, 1) * 1000,
    retryMaxMs: num(env, 'RETRY_MAX_SECONDS', 6 * 3600, 1) * 1000,
    configErrorPauseMs: num(env, 'CONFIG_ERROR_PAUSE_SECONDS', 600, 1) * 1000,

    scheduleStart,
    scheduleEnd,
  };
}
