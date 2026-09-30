import fs from 'node:fs';
import path from 'node:path';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import swaggerUi from 'swagger-ui-express';
import YAML from 'yaml';
import { env } from './config/env';
import { pool } from './db/pool';
import { logger } from './lib/logger';
import { errorHandler, notFoundHandler, requestId } from './middleware/http';
import { apiKeysRouter } from './modules/apiKeys';
import { authRouter } from './modules/auth';
import { destinationsRouter } from './modules/destinations';
import { deliveriesRouter, eventsRouter, ingestRouter } from './modules/events';
import { auditRouter, statsRouter } from './modules/insights';
import { membersRouter } from './modules/members';
import { routesRouter } from './modules/routes';
import { sourcesRouter } from './modules/sources';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY);

  app.use(requestId);
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => (req as express.Request).id,
      autoLogging: { ignore: (req) => req.url === '/healthz' },
      customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
    }),
  );

  const openapi = YAML.parse(fs.readFileSync(path.resolve(__dirname, '../openapi.yaml'), 'utf8'));
  // Swagger UI needs inline styles, so it gets its own relaxed CSP; everything else uses the strict default.
  app.use('/docs', helmet({ contentSecurityPolicy: false }), swaggerUi.serve, swaggerUi.setup(openapi));
  app.get('/openapi.json', (_req, res) => res.json(openapi));

  app.use(helmet());
  app.use(
    cors({
      origin: env.CORS_ORIGINS.split(',').map((o) => o.trim()),
      credentials: true,
      exposedHeaders: ['x-request-id'],
    }),
  );
  app.use(cookieParser());
  // Keep the exact raw bytes: webhook signatures are computed over them, not over re-serialized JSON.
  app.use(
    express.json({
      limit: '512kb',
      verify: (req, _res, buf) => {
        (req as express.Request).rawBody = buf;
      },
    }),
  );

  app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));
  app.get('/readyz', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ status: 'ready' });
    } catch {
      res.status(503).json({ status: 'unavailable' });
    }
  });

  app.use('/v1/auth', authRouter);
  app.use('/v1/members', membersRouter);
  app.use('/v1/api-keys', apiKeysRouter);
  app.use('/v1/sources', sourcesRouter);
  app.use('/v1/destinations', destinationsRouter);
  app.use('/v1/routes', routesRouter);
  app.use('/v1/ingest', ingestRouter);
  app.use('/v1/events', eventsRouter);
  app.use('/v1/deliveries', deliveriesRouter);
  app.use('/v1/stats', statsRouter);
  app.use('/v1/audit-logs', auditRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
