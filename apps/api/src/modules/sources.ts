import { Router } from 'express';
import { z } from 'zod';
import { env } from '../config/env';
import { one, query } from '../db/pool';
import { encrypt, randomToken } from '../lib/crypto';
import { notFound } from '../lib/errors';
import { audit } from '../middleware/audit';
import { authenticate, requirePermission } from '../middleware/auth';
import { parse, uuidParam } from '../middleware/http';

export const sourcesRouter = Router();
sourcesRouter.use(authenticate);

const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).optional(),
});
const updateSchema = createSchema.partial();

const newSecret = () => `whsec_${randomToken(32)}`;
const ingestUrl = (id: string) => `${env.API_PUBLIC_URL}/v1/ingest/${id}`;
const COLUMNS = 'id, name, description, created_at, updated_at';

sourcesRouter.get('/', requirePermission('sources:read'), async (req, res) => {
  const { rows } = await query<{ id: string }>(
    `SELECT s.id, s.name, s.description, s.created_at, s.updated_at,
            (SELECT count(*)::int FROM events e WHERE e.source_id = s.id AND e.received_at > now() - interval '24 hours') AS events_24h
       FROM sources s WHERE s.workspace_id = $1 ORDER BY s.created_at DESC`,
    [req.principal!.workspaceId],
  );
  res.json({ data: rows.map((r) => ({ ...r, ingestUrl: ingestUrl(r.id) })) });
});

sourcesRouter.get('/:id', requirePermission('sources:read'), async (req, res) => {
  const id = parse(uuidParam, req.params.id);
  const row = await one<{ id: string }>(`SELECT ${COLUMNS} FROM sources WHERE id = $1 AND workspace_id = $2`, [
    id,
    req.principal!.workspaceId,
  ]);
  if (!row) throw notFound('Source');
  res.json({ ...row, ingestUrl: ingestUrl(row.id) });
});

sourcesRouter.post('/', requirePermission('sources:write'), async (req, res) => {
  const body = parse(createSchema, req.body);
  const secret = newSecret();
  const row = await one<{ id: string }>(
    `INSERT INTO sources (workspace_id, name, description, signing_secret_enc) VALUES ($1, $2, $3, $4) RETURNING ${COLUMNS}`,
    [req.principal!.workspaceId, body.name, body.description ?? null, encrypt(secret, env.ENCRYPTION_KEY)],
  );
  await audit(req, { action: 'source.create', resourceType: 'source', resourceId: row!.id });
  // Secret is shown once; afterwards it can only be rotated.
  res.status(201).json({ ...row, ingestUrl: ingestUrl(row!.id), signingSecret: secret });
});

sourcesRouter.patch('/:id', requirePermission('sources:write'), async (req, res) => {
  const id = parse(uuidParam, req.params.id);
  const body = parse(updateSchema, req.body);
  const row = await one(
    `UPDATE sources SET name = COALESCE($3, name), description = COALESCE($4, description), updated_at = now()
      WHERE id = $1 AND workspace_id = $2 RETURNING ${COLUMNS}`,
    [id, req.principal!.workspaceId, body.name ?? null, body.description ?? null],
  );
  if (!row) throw notFound('Source');
  await audit(req, { action: 'source.update', resourceType: 'source', resourceId: id, metadata: body });
  res.json(row);
});

sourcesRouter.post('/:id/rotate-secret', requirePermission('sources:write'), async (req, res) => {
  const id = parse(uuidParam, req.params.id);
  const secret = newSecret();
  const row = await one(
    `UPDATE sources SET signing_secret_enc = $3, updated_at = now() WHERE id = $1 AND workspace_id = $2 RETURNING id`,
    [id, req.principal!.workspaceId, encrypt(secret, env.ENCRYPTION_KEY)],
  );
  if (!row) throw notFound('Source');
  await audit(req, { action: 'source.rotate_secret', resourceType: 'source', resourceId: id });
  res.json({ id, signingSecret: secret });
});

sourcesRouter.delete('/:id', requirePermission('sources:write'), async (req, res) => {
  const id = parse(uuidParam, req.params.id);
  const row = await one('DELETE FROM sources WHERE id = $1 AND workspace_id = $2 RETURNING id', [
    id,
    req.principal!.workspaceId,
  ]);
  if (!row) throw notFound('Source');
  await audit(req, { action: 'source.delete', resourceType: 'source', resourceId: id });
  res.status(204).end();
});
