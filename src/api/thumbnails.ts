import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const SIZE = 192;
const MAX_PARALLEL = 2;
const SUPPORTED = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'tif', 'tiff']);

export class ThumbnailError extends Error {
  constructor(readonly code: 400 | 404 | 415 | 500, message: string) {
    super(message);
  }
}

/** On-demand JPEG thumbnails for files under the photos root, cached on disk. */
export class Thumbnailer {
  private running = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(
    private readonly photosDir: string,
    private readonly cacheDir: string,
  ) {
    sharp.concurrency(1);
    sharp.cache(false);
  }

  /** Returns the path of a cached thumbnail, generating it first if needed. */
  async get(relativePath: string): Promise<string> {
    const source = path.resolve(this.photosDir, relativePath);
    if (!relativePath || (source !== this.photosDir && !source.startsWith(this.photosDir + path.sep))) {
      throw new ThumbnailError(400, 'Invalid path');
    }
    if (!SUPPORTED.has(path.extname(source).slice(1).toLowerCase())) {
      throw new ThumbnailError(415, 'No thumbnail for this file type');
    }
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(source);
    } catch {
      throw new ThumbnailError(404, 'File not found');
    }
    if (!stat.isFile()) throw new ThumbnailError(404, 'File not found');

    const key = crypto.createHash('sha1').update(`${relativePath}\0${stat.size}\0${stat.mtimeMs}`).digest('hex');
    const cached = path.join(this.cacheDir, `${key}.jpg`);
    if (fs.existsSync(cached)) return cached;

    await this.acquire();
    try {
      await fs.promises.mkdir(this.cacheDir, { recursive: true });
      const tmp = `${cached}.${process.pid}.tmp`;
      await sharp(source, { failOn: 'none' })
        .rotate()
        .resize(SIZE, SIZE, { fit: 'cover' })
        .jpeg({ quality: 72 })
        .toFile(tmp);
      await fs.promises.rename(tmp, cached);
      return cached;
    } catch {
      throw new ThumbnailError(415, 'Cannot decode image');
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.running < MAX_PARALLEL) {
      this.running++;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.running--;
  }
}
