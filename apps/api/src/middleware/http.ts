import crypto from 'node:crypto';
import type { ErrorRequestHandler, NextFunction, Request, Response } from 'express';
import { ZodError, type ZodType, z } from 'zod';
import { HttpError } from '../lib/errors';
import { logger } from '../lib/logger';

export function requestId(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header('x-request-id');
  req.id = incoming && /^[\w-]{8,64}$/.test(incoming) ? incoming : crypto.randomUUID();
  res.setHeader('x-request-id', req.id);
  next();
}

export function parse<T extends ZodType>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new HttpError(
      422,
      'validation_error',
      'Request validation failed',
      result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return result.data;
}

export const uuidParam = z.uuid();

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({ error: { code: 'not_found', message: `No route for ${req.method} ${req.path}` } });
}

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details, requestId: req.id } });
    return;
  }
  if (err instanceof ZodError) {
    res.status(422).json({ error: { code: 'validation_error', message: 'Request validation failed', requestId: req.id } });
    return;
  }
  if (err?.type === 'entity.parse.failed') {
    res.status(400).json({ error: { code: 'invalid_json', message: 'Request body is not valid JSON', requestId: req.id } });
    return;
  }
  if (err?.type === 'entity.too.large') {
    res.status(413).json({ error: { code: 'payload_too_large', message: 'Request body is too large', requestId: req.id } });
    return;
  }
  // Unknown errors: log full detail server-side, return a generic message (no stack traces to clients).
  logger.error({ err, requestId: req.id, path: req.path }, 'unhandled_error');
  res.status(500).json({ error: { code: 'internal_error', message: 'Something went wrong', requestId: req.id } });
};
