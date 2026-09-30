import { createApp } from './app';
import { env } from './config/env';
import { pool } from './db/pool';
import { logger } from './lib/logger';
import { startWorker } from './worker/deliver';

const app = createApp();
const server = app.listen(env.PORT, () => logger.info({ port: env.PORT }, 'api_listening'));
const stopWorker = env.WORKER_ENABLED ? startWorker() : async () => undefined;

const shutdown = (signal: string) => {
  logger.info({ signal }, 'shutting_down');
  server.close(async () => {
    await stopWorker();
    await pool.end();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
