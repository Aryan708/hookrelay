import { Router } from 'express';
import { z } from 'zod';
import { one, query } from '../db/pool';
import { HttpError, notFound } from '../lib/errors';
import { conditionSchema, mappingSchema } from '../lib/transform';
import { audit } from '../middleware/audit';
import { authenticate, requirePermission } from '../middleware/auth';
import { parse, uuidParam } from '../middleware/http';

export const routesRouter = Router();
routesRouter.use(authenticate);

const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  sourceId: z.uuid(),
  destinationId: z.uuid(),
  enabled: z.boolean().default(true),
  filter: z.array(conditionSchema).max(20).default([]),
  mapping: mappingSchema.nullable().optional(),
});
const updateSchema = createSchema.omit({ sourceId: true, destinationId: true }).partial();

const SELECT = `SELECT r.id, r.name, r.enabled, r.filter, r.mapping, r.created_at, r.updated_at,
                       r.source_id, s.name AS source_name, r.destination_id, d.name AS destination_name
                  FROM routes r JOIN sources s ON s.id = r.source_id JOIN destinations d ON d.id = r.destination_id`;

routesRouter.get('/', requirePermission('routes:read'), async (req, res) => {
  const { rows } = await query(`${SELECT} WHERE r.workspace_id = $1 ORDER BY r.created_at DESC`, [
    req.principal!.workspaceId,
  ]);
  res.json({ data: rows });
});

routesRouter.post('/', requirePermission('routes:write'), async (req, res) => {
  const body = parse(createSchema, req.body);
  const ws = req.principal!.workspaceId;
  // Both ends must belong to the caller's workspace (tenant isolation).
  const owned = await one<{ n: number }>(
    `SELECT (SELECT count(*) FROM sources WHERE id = $1 AND workspace_id = $3)
          + (SELECT count(*) FROM destinations WHERE id = $2 AND workspace_id = $3) AS n`,
    [body.sourceId, body.destinationId, ws],
  );
  if (Number(owned!.n) !== 2) throw new HttpError(422, 'invalid_reference', 'Unknown source or destination');

  const created = await one<{ id: string }>(
    `INSERT INTO routes (workspace_id, name, source_id, destination_id, enabled, filter, mapping)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [ws, body.name, body.sourceId, body.destinationId, body.enabled, JSON.stringify(body.filter), body.mapping ? JSON.stringify(body.mapping) : null],
  );
  await audit(req, { action: 'route.create', resourceType: 'route', resourceId: created!.id });
  res.status(201).json(await one(`${SELECT} WHERE r.id = $1`, [created!.id]));
});

routesRouter.patch('/:id', requirePermission('routes:write'), async (req, res) => {
  const id = parse(uuidParam, req.params.id);
  const body = parse(updateSchema, req.body);
  const row = await one(
    `UPDATE routes SET name = COALESCE($3, name), enabled = COALESCE($4, enabled),
            filter = COALESCE($5::jsonb, filter),
            mapping = CASE WHEN $6::boolean THEN $7::jsonb ELSE mapping END,
            updated_at = now()
      WHERE id = $1 AND workspace_id = $2 RETURNING id`,
    [
      id,
      req.principal!.workspaceId,
      body.name ?? null,
      body.enabled ?? null,
      body.filter ? JSON.stringify(body.filter) : null,
      body.mapping !== undefined,
      body.mapping ? JSON.stringify(body.mapping) : null,
    ],
  );
  if (!row) throw notFound('Route');
  await audit(req, { action: 'route.update', resourceType: 'route', resourceId: id, metadata: { fields: Object.keys(body) } });
  res.json(await one(`${SELECT} WHERE r.id = $1`, [id]));
});

routesRouter.delete('/:id', requirePermission('routes:write'), async (req, res) => {
  const id = parse(uuidParam, req.params.id);
  const row = await one('DELETE FROM routes WHERE id = $1 AND workspace_id = $2 RETURNING id', [id, req.principal!.workspaceId]);
  if (!row) throw notFound('Route');
  await audit(req, { action: 'route.delete', resourceType: 'route', resourceId: id });
  res.status(204).end();
});
