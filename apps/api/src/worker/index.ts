import { pool } from '../db/pool';
import { logger } from '../lib/logger';
import { startWorker } from './deliver';

// Standalone worker process: `npm run worker`. Scale horizontally; SKIP LOCKED prevents double delivery.
const stop = startWorker();

const shutdown = async (signal: string) => {
  logger.info({ signal }, 'worker_shutting_down');
  await stop();
  await pool.end();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
