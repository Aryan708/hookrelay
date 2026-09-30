import { Router } from 'express';
import { z } from 'zod';
import { one, query } from '../db/pool';
import { randomToken, sha256 } from '../lib/crypto';
import { notFound } from '../lib/errors';
import { API_KEY_SCOPES } from '../lib/rbac';
import { audit } from '../middleware/audit';
import { API_KEY_PREFIX, authenticate, requirePermission, requireUser } from '../middleware/auth';
import { parse, uuidParam } from '../middleware/http';

export const apiKeysRouter = Router();
apiKeysRouter.use(authenticate);

const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  scopes: z.array(z.enum(API_KEY_SCOPES)).min(1).transform((s) => [...new Set(s)]),
  expiresInDays: z.number().int().min(1).max(365).optional(),
});

apiKeysRouter.get('/', requirePermission('apikeys:read'), async (req, res) => {
  const { rows } = await query(
    `SELECT id, name, prefix, scopes, expires_at, last_used_at, revoked_at, created_at
       FROM api_keys WHERE workspace_id = $1 ORDER BY created_at DESC`,
    [req.principal!.workspaceId],
  );
  res.json({ data: rows });
});

apiKeysRouter.post('/', requirePermission('apikeys:write'), async (req, res) => {
  const actor = requireUser(req); // keys can only be minted by humans
  const body = parse(createSchema, req.body);
  const prefix = randomToken(6).replace(/[-_]/g, 'x').slice(0, 8);
  const key = `${API_KEY_PREFIX}${prefix}_${randomToken(32)}`;
  const expiresAt = body.expiresInDays ? new Date(Date.now() + body.expiresInDays * 86_400_000) : null;

  const row = await one<{ id: string }>(
    `INSERT INTO api_keys (workspace_id, name, prefix, key_hash, scopes, created_by, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, name, prefix, scopes, expires_at, created_at`,
    [actor.workspaceId, body.name, `${API_KEY_PREFIX}${prefix}`, sha256(key), body.scopes, actor.id, expiresAt],
  );
  await audit(req, { action: 'apikey.create', resourceType: 'api_key', resourceId: row!.id, metadata: { scopes: body.scopes } });
  // The plaintext key is returned exactly once and never stored.
  res.status(201).json({ ...row, key });
});

apiKeysRouter.delete('/:id', requirePermission('apikeys:write'), async (req, res) => {
  const id = parse(uuidParam, req.params.id);
  const row = await one(
    `UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND workspace_id = $2 AND revoked_at IS NULL RETURNING id`,
    [id, req.principal!.workspaceId],
  );
  if (!row) throw notFound('API key');
  await audit(req, { action: 'apikey.revoke', resourceType: 'api_key', resourceId: id });
  res.status(204).end();
});
