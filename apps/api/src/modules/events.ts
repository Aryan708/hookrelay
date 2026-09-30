import { Router } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { z } from 'zod';
import { env } from '../config/env';
import { one, query, withTransaction } from '../db/pool';
import { decrypt, verifySignatureHeader } from '../lib/crypto';
import { HttpError, notFound } from '../lib/errors';
import { audit } from '../middleware/audit';
import { authenticate, requirePermission } from '../middleware/auth';
import { parse, uuidParam } from '../middleware/http';
import { ingestEvent } from '../services/ingest';

// ---------- public, signature-authenticated webhook intake ----------

export const ingestRouter = Router();

const ingestLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: env.NODE_ENV === 'test' ? 10_000 : 600,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    // Per source + client IP, so one noisy sender can't starve other sources.
    keyGenerator: (req) => `${String(req.params.sourceId ?? '')}:${ipKeyGenerator(req.ip ?? '')}`,
    message: { error: { code: 'rate_limited', message: 'Too many requests' } },
  });

const eventTypeFrom = (header: string | undefined, body: unknown): string => {
  const fromBody = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).type : undefined;
  const t = header ?? (typeof fromBody === 'string' ? fromBody : 'event');
  return t.slice(0, 120);
};

ingestRouter.post('/:sourceId', ingestLimiter, async (req, res) => {
  const idCheck = uuidParam.safeParse(req.params.sourceId);
  // Same response for unknown source and bad signature, so the endpoint can't be used to enumerate sources.
  const reject = () => new HttpError(401, 'invalid_signature', 'Signature verification failed');
  if (!idCheck.success) throw reject();

  const source = await one<{ id: string; workspace_id: string; signing_secret_enc: string }>(
    'SELECT id, workspace_id, signing_secret_enc FROM sources WHERE id = $1',
    [idCheck.data],
  );
  if (!source || !req.rawBody) throw reject();

  const check = verifySignatureHeader(
    req.header('x-hookrelay-signature'),
    decrypt(source.signing_secret_enc, env.ENCRYPTION_KEY),
    req.rawBody.toString('utf8'),
    env.SIGNATURE_TOLERANCE_SECONDS,
  );
  if (!check.ok) {
    await audit(req, {
      action: 'ingest.signature_rejected',
      workspaceId: source.workspace_id,
      resourceType: 'source',
      resourceId: source.id,
      metadata: { reason: check.reason },
    });
    throw reject();
  }

  const idempotencyKey = (req.header('idempotency-key') ?? req.header('x-event-id'))?.slice(0, 200) ?? null;
  const result = await withTransaction((tx) =>
    ingestEvent(tx, {
      workspaceId: source.workspace_id,
      sourceId: source.id,
      eventType: eventTypeFrom(req.header('x-event-type'), req.body),
      payload: req.body,
      idempotencyKey,
    }),
  );
  res.status(result.duplicate ? 200 : 202).json(result);
});

// ---------- authenticated event API (users and API keys) ----------

export const eventsRouter = Router();
eventsRouter.use(authenticate);

const publishSchema = z.object({
  sourceId: z.uuid(),
  type: z.string().trim().min(1).max(120),
  payload: z.record(z.string(), z.unknown()),
  idempotencyKey: z.string().max(200).optional(),
});

eventsRouter.post('/', requirePermission('events:write'), async (req, res) => {
  const body = parse(publishSchema, req.body);
  const ws = req.principal!.workspaceId;
  const source = await one('SELECT id FROM sources WHERE id = $1 AND workspace_id = $2', [body.sourceId, ws]);
  if (!source) throw new HttpError(422, 'invalid_reference', 'Unknown source');
  const result = await withTransaction((tx) =>
    ingestEvent(tx, {
      workspaceId: ws,
      sourceId: body.sourceId,
      eventType: body.type,
      payload: body.payload,
      idempotencyKey: body.idempotencyKey,
    }),
  );
  res.status(result.duplicate ? 200 : 202).json(result);
});

const listSchema = z.object({
  sourceId: z.uuid().optional(),
  status: z.enum(['pending', 'succeeded', 'failed', 'dead', 'skipped']).optional(),
  type: z.string().max(120).optional(),
  before: z.iso.datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

eventsRouter.get('/', requirePermission('events:read'), async (req, res) => {
  const q = parse(listSchema, req.query);
  const { rows } = await query<{ received_at: Date }>(
    `SELECT e.id, e.event_type, e.source_id, s.name AS source_name, e.idempotency_key, e.received_at,
            count(d.*)::int AS delivery_count,
            count(d.*) FILTER (WHERE d.status = 'succeeded')::int AS succeeded,
            count(d.*) FILTER (WHERE d.status IN ('failed', 'dead'))::int AS failed,
            count(d.*) FILTER (WHERE d.status = 'pending')::int AS pending
       FROM events e
       JOIN sources s ON s.id = e.source_id
       LEFT JOIN deliveries d ON d.event_id = e.id
      WHERE e.workspace_id = $1
        AND ($2::uuid IS NULL OR e.source_id = $2)
        AND ($3::text IS NULL OR e.event_type = $3)
        AND ($4::timestamptz IS NULL OR e.received_at < $4)
        AND ($5::text IS NULL OR EXISTS (SELECT 1 FROM deliveries x WHERE x.event_id = e.id AND x.status = $5))
      GROUP BY e.id, s.name
      ORDER BY e.received_at DESC
      LIMIT $6`,
    [req.principal!.workspaceId, q.sourceId ?? null, q.type ?? null, q.before ?? null, q.status ?? null, q.limit],
  );
  const last = rows.at(-1);
  res.json({
    data: rows,
    nextCursor: rows.length === q.limit && last ? new Date(last.received_at).toISOString() : null,
  });
});

eventsRouter.get('/:id', requirePermission('events:read'), async (req, res) => {
  const id = parse(uuidParam, req.params.id);
  const event = await one(
    `SELECT e.*, s.name AS source_name FROM events e JOIN sources s ON s.id = e.source_id
      WHERE e.id = $1 AND e.workspace_id = $2`,
    [id, req.principal!.workspaceId],
  );
  if (!event) throw notFound('Event');
  const { rows: deliveries } = await query(
    `SELECT d.id, d.status, d.attempt_count, d.next_attempt_at, d.last_status_code, d.last_error, d.completed_at, d.created_at,
            d.route_id, r.name AS route_name, d.destination_id, ds.name AS destination_name, ds.url AS destination_url,
            COALESCE((SELECT json_agg(a ORDER BY a.attempt_no) FROM (
               SELECT attempt_no, status_code, error, duration_ms, response_snippet, created_at
                 FROM delivery_attempts WHERE delivery_id = d.id) a), '[]') AS attempts
       FROM deliveries d JOIN routes r ON r.id = d.route_id JOIN destinations ds ON ds.id = d.destination_id
      WHERE d.event_id = $1 ORDER BY d.created_at`,
    [id],
  );
  res.json({ ...event, deliveries });
});

// ---------- delivery replay ----------

export const deliveriesRouter = Router();
deliveriesRouter.use(authenticate);

deliveriesRouter.post('/:id/replay', requirePermission('events:replay'), async (req, res) => {
  const id = parse(uuidParam, req.params.id);
  const row = await one(
    `UPDATE deliveries
        SET status = 'pending', attempt_count = 0, next_attempt_at = now(), locked_until = NULL,
            completed_at = NULL, last_error = NULL, updated_at = now()
      WHERE id = $1 AND workspace_id = $2 AND status <> 'pending'
      RETURNING id, status, next_attempt_at`,
    [id, req.principal!.workspaceId],
  );
  if (!row) throw notFound('Replayable delivery');
  await audit(req, { action: 'delivery.replay', resourceType: 'delivery', resourceId: id });
  res.status(202).json(row);
});
