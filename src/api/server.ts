import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import type { PhotoBackupAgent } from '../app.js';
import { FILE_STATUSES, type FileStatus } from '../types.js';
import { Thumbnailer, ThumbnailError } from './thumbnails.js';

const DEFAULT_PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public');

export interface ServerOptions {
  logger?: Logger;
  publicDir?: string;
  /** Where generated thumbnails are cached (default: `thumbs/` next to the database). */
  thumbCacheDir?: string;
}

export function buildServer(agent: PhotoBackupAgent, options: ServerOptions = {}): FastifyInstance {
  const app = Fastify({
    ...(options.logger ? { loggerInstance: options.logger.child({ component: 'api' }) as FastifyBaseLogger } : { logger: false }),
    // The dashboard polls every few seconds: don't log each request.
    logController: new LogController({ disableRequestLogging: true }),
  });

  const dashboardFile = path.join(options.publicDir ?? DEFAULT_PUBLIC_DIR, 'index.html');

  app.get('/', async (_req, reply) => {
    try {
      const html = await fs.promises.readFile(dashboardFile, 'utf8');
      return reply.type('text/html; charset=utf-8').send(html);
    } catch {
      return reply.code(404).send({ error: 'Dashboard not available' });
    }
  });

  app.get('/health', async (_req, reply) => {
    const ok = agent.healthy();
    return reply.code(ok ? 200 : 503).send({ status: ok ? 'ok' : 'error' });
  });

  app.get('/api/status', async () => agent.status());

  app.get('/api/stats', async () => agent.stats());

  app.get<{ Querystring: { status?: string; limit?: string; offset?: string } }>('/api/queue', async (req, reply) => {
    const { status, limit, offset } = req.query;
    if (status !== undefined && status !== '' && !FILE_STATUSES.includes(status as FileStatus)) {
      return reply.code(400).send({ error: `Invalid status "${status}". Allowed: ${FILE_STATUSES.join(', ')}` });
    }
    const lim = limit !== undefined ? Number(limit) : undefined;
    const off = offset !== undefined ? Number(offset) : undefined;
    if ((lim !== undefined && !Number.isInteger(lim)) || (off !== undefined && !Number.isInteger(off))) {
      return reply.code(400).send({ error: 'limit and offset must be integers' });
    }
    const result = agent.repo.listQueue({
      status: status ? (status as FileStatus) : undefined,
      limit: lim,
      offset: off,
    });
    return { ...result, limit: lim ?? 50, offset: off ?? 0 };
  });

  const thumbs = new Thumbnailer(
    agent.config.photosDir,
    options.thumbCacheDir ?? path.join(path.dirname(agent.config.databasePath), 'thumbs'),
  );

  app.get<{ Querystring: { path?: string } }>('/api/thumb', async (req, reply) => {
    try {
      const file = await thumbs.get(req.query.path ?? '');
      return reply
        .header('Cache-Control', 'private, max-age=86400')
        .type('image/jpeg')
        .send(fs.createReadStream(file));
    } catch (e) {
      if (e instanceof ThumbnailError) return reply.code(e.code).send({ error: e.message });
      throw e;
    }
  });

  app.post('/api/sync', async (_req, reply) => {
    agent.syncNow();
    return reply.code(202).send({ ok: true, manualSync: true });
  });

  app.post('/api/pause', async () => {
    agent.pause();
    return { ok: true, userPaused: true };
  });

  app.post('/api/resume', async () => {
    agent.resume();
    return { ok: true, userPaused: false };
  });

  app.post('/api/retry-failed', async () => {
    const requeued = agent.retryFailed();
    return { ok: true, requeued };
  });

  return app;
}
