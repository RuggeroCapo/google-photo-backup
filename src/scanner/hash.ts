import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';

/** SHA-256 of a file, streamed so memory stays flat regardless of file size. */
export async function sha256File(file: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(file, { highWaterMark: 1024 * 1024 }), hash, { signal });
  return hash.digest('hex');
}
