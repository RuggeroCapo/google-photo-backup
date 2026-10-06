import { PhotoBackupAgent } from './app.js';
import { buildServer } from './api/server.js';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel, config.logDir);

  const agent = new PhotoBackupAgent(config, { logger });
  const server = buildServer(agent, { logger });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'received signal, shutting down gracefully');
    const force = setTimeout(() => {
      logger.error('graceful shutdown timed out, exiting');
      process.exit(1);
    }, 25_000);
    force.unref();
    try {
      await server.close();
      await agent.stop();
      logger.flush();
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandled rejection'));

  await agent.start();
  await server.listen({ port: config.port, host: config.host });
  logger.info({ port: config.port }, 'API and dashboard listening');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
