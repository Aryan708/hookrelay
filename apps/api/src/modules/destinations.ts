import { Router } from 'express';
import { z } from 'zod';
import { env } from '../config/env';
import { one, query } from '../db/pool';
import { encrypt, randomToken } from '../lib/crypto';
import { notFound } from '../lib/errors';
import { assertSafeUrl } from '../lib/ssrf';
import { audit } from '../middleware/audit';
import { authenticate, requirePermission } from '../middleware/auth';
import { parse, uuidParam } from '../middleware/http';

export const destinationsRouter = Router();
destinationsRouter.use(authenticate);

export const urlPolicy = () => ({
  allowPrivate: env.ALLOW_PRIVATE_DESTINATIONS,
  requireHttps: env.NODE_ENV === 'production' && !env.ALLOW_HTTP_DESTINATIONS,
  allowHosts: env.DESTINATION_HOST_ALLOWLIST,
});

const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  url: z.url().max(2048),
  timeoutMs: z.number().int().min(1000).max(30000).optional(),
  maxAttempts: z.number().int().min(1).max(10).optional(),
});
const updateSchema = createSchema.partial();

const COLUMNS = 'id, name, url, timeout_ms, max_attempts, created_at, updated_at';

destinationsRouter.get('/', requirePermission('destinations:read'), async (req, res) => {
  const { rows } = await query(
    `SELECT d.id, d.name, d.url, d.timeout_ms, d.max_attempts, d.created_at, d.updated_at,
            count(dl.*) FILTER (WHERE dl.status = 'succeeded' AND dl.created_at > now() - interval '24 hours')::int AS succeeded_24h,
            count(dl.*) FILTER (WHERE dl.status IN ('failed', 'dead') AND dl.created_at > now() - interval '24 hours')::int AS failed_24h
       FROM destinations d LEFT JOIN deliveries dl ON dl.destination_id = d.id
      WHERE d.workspace_id = $1 GROUP BY d.id ORDER BY d.created_at DESC`,
    [req.principal!.workspaceId],
  );
  res.json({ data: rows });
});

destinationsRouter.post('/', requirePermission('destinations:write'), async (req, res) => {
  const body = parse(createSchema, req.body);
  await assertSafeUrl(body.url, urlPolicy());
  const secret = `whsec_${randomToken(32)}`;
  const row = await one<{ id: string }>(
    `INSERT INTO destinations (workspace_id, name, url, signing_secret_enc, timeout_ms, max_attempts)
     VALUES ($1, $2, $3, $4, COALESCE($5, 10000), COALESCE($6, 5)) RETURNING ${COLUMNS}`,
    [
      req.principal!.workspaceId,
      body.name,
      body.url,
      encrypt(secret, env.ENCRYPTION_KEY),
      body.timeoutMs ?? null,
      body.maxAttempts ?? null,
    ],
  );
  await audit(req, { action: 'destination.create', resourceType: 'destination', resourceId: row!.id, metadata: { url: body.url } });
  // Receivers use this secret to verify the X-HookRelay-Signature header on deliveries.
  res.status(201).json({ ...row, signingSecret: secret });
});

destinationsRouter.patch('/:id', requirePermission('destinations:write'), async (req, res) => {
  const id = parse(uuidParam, req.params.id);
  const body = parse(updateSchema, req.body);
  if (body.url) await assertSafeUrl(body.url, urlPolicy());
  const row = await one(
    `UPDATE destinations SET name = COALESCE($3, name), url = COALESCE($4, url),
            timeout_ms = COALESCE($5, timeout_ms), max_attempts = COALESCE($6, max_attempts), updated_at = now()
      WHERE id = $1 AND workspace_id = $2 RETURNING ${COLUMNS}`,
    [id, req.principal!.workspaceId, body.name ?? null, body.url ?? null, body.timeoutMs ?? null, body.maxAttempts ?? null],
  );
  if (!row) throw notFound('Destination');
  await audit(req, { action: 'destination.update', resourceType: 'destination', resourceId: id, metadata: body });
  res.json(row);
});

destinationsRouter.delete('/:id', requirePermission('destinations:write'), async (req, res) => {
  const id = parse(uuidParam, req.params.id);
  const row = await one('DELETE FROM destinations WHERE id = $1 AND workspace_id = $2 RETURNING id', [
    id,
    req.principal!.workspaceId,
  ]);
  if (!row) throw notFound('Destination');
  await audit(req, { action: 'destination.delete', resourceType: 'destination', resourceId: id });
  res.status(204).end();
});
