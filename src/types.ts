export const FILE_STATUSES = ['pending', 'uploading', 'uploaded', 'failed', 'ignored'] as const;
export type FileStatus = (typeof FILE_STATUSES)[number];

/** Why a file row is `ignored`. */
export type IgnoredReason = 'duplicate' | 'deleted' | 'missing';

export interface FileRecord {
  id: number;
  /** Path relative to the photos root (POSIX separators). */
  path: string;
  filename: string;
  size: number;
  /** Modification time in ms since epoch. */
  mtime: number;
  sha256: string;
  mime_type: string;
  status: FileStatus;
  retry_count: number;
  error: string | null;
  ignored_reason: IgnoredReason | null;
  duplicate_of: string | null;
  remote_path: string | null;
  next_attempt_at: number | null;
  created_at: string;
  updated_at: string;
  uploaded_at: string | null;
}

/** File handed to an uploader. */
export interface PhotoFile {
  id: number;
  absolutePath: string;
  relativePath: string;
  filename: string;
  size: number;
  sha256: string;
  mimeType: string;
}

export type UploadErrorKind =
  | 'network'
  | 'rate_limit'
  | 'server'
  | 'config'
  | 'permanent'
  | 'aborted'
  | 'unknown';

export type UploadResult =
  | { ok: true; remotePath: string }
  | { ok: false; kind: UploadErrorKind; retryable: boolean; error: string };

export interface UploadOptions {
  signal?: AbortSignal;
}

export interface PhotoUploader {
  upload(file: PhotoFile, options?: UploadOptions): Promise<UploadResult>;
}
