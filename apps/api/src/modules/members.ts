import { Router } from 'express';
import { z } from 'zod';
import { one, query, withTransaction } from '../db/pool';
import { HttpError, forbidden, notFound } from '../lib/errors';
import { ROLES, ROLE_RANK, type Role } from '../lib/rbac';
import { audit } from '../middleware/audit';
import { authenticate, requirePermission, requireUser } from '../middleware/auth';
import { parse, uuidParam } from '../middleware/http';
import { hashPassword, passwordSchema } from './auth';

export const membersRouter = Router();
membersRouter.use(authenticate);

const createSchema = z.object({
  email: z.email().transform((e) => e.toLowerCase()),
  name: z.string().trim().min(1).max(80),
  role: z.enum(ROLES),
  temporaryPassword: passwordSchema,
});
const updateSchema = z.object({ role: z.enum(ROLES).optional(), disabled: z.boolean().optional() });

membersRouter.get('/', requirePermission('members:read'), async (req, res) => {
  const { rows } = await query(
    `SELECT id, email, name, role, github_id IS NOT NULL AS github_linked, disabled_at, last_login_at, created_at
       FROM users WHERE workspace_id = $1 ORDER BY created_at`,
    [req.principal!.workspaceId],
  );
  res.json({ data: rows });
});

membersRouter.post('/', requirePermission('members:write'), async (req, res) => {
  const actor = requireUser(req);
  const body = parse(createSchema, req.body);
  // Nobody can grant a role higher than their own (privilege escalation guard).
  if (ROLE_RANK[body.role] > ROLE_RANK[actor.role]) throw forbidden('Cannot grant a role higher than your own');
  if (await one('SELECT 1 FROM users WHERE email = $1', [body.email])) {
    throw new HttpError(409, 'email_taken', 'An account with this email already exists');
  }
  const user = await one<{ id: string }>(
    `INSERT INTO users (workspace_id, email, name, role, password_hash) VALUES ($1, $2, $3, $4, $5)
     RETURNING id, email, name, role, created_at`,
    [actor.workspaceId, body.email, body.name, body.role, await hashPassword(body.temporaryPassword)],
  );
  await audit(req, { action: 'member.create', resourceType: 'user', resourceId: user!.id, metadata: { role: body.role } });
  res.status(201).json(user);
});

membersRouter.patch('/:id', requirePermission('members:write'), async (req, res) => {
  const actor = requireUser(req);
  const id = parse(uuidParam, req.params.id);
  const body = parse(updateSchema, req.body);

  const updated = await withTransaction(async (tx) => {
    const target = await one<{ id: string; role: Role }>(
      'SELECT id, role FROM users WHERE id = $1 AND workspace_id = $2 FOR UPDATE',
      [id, actor.workspaceId],
      tx,
    );
    if (!target) throw notFound('Member');
    if (ROLE_RANK[target.role] > ROLE_RANK[actor.role]) throw forbidden('Cannot modify a member with a higher role');
    if (body.role && ROLE_RANK[body.role] > ROLE_RANK[actor.role]) throw forbidden('Cannot grant a role higher than your own');
    if (target.id === actor.id && body.disabled) throw new HttpError(400, 'self_disable', 'You cannot disable yourself');

    const losingOwner = target.role === 'owner' && ((body.role && body.role !== 'owner') || body.disabled);
    if (losingOwner) {
      const owners = await one<{ n: number }>(
        `SELECT count(*)::int AS n FROM users WHERE workspace_id = $1 AND role = 'owner' AND disabled_at IS NULL`,
        [actor.workspaceId],
        tx,
      );
      if (owners!.n <= 1) throw new HttpError(400, 'last_owner', 'A workspace must keep at least one active owner');
    }

    const row = await one(
      `UPDATE users SET role = COALESCE($2, role),
              disabled_at = CASE WHEN $3::boolean IS NULL THEN disabled_at WHEN $3 THEN now() ELSE NULL END
        WHERE id = $1 RETURNING id, email, name, role, disabled_at`,
      [id, body.role ?? null, body.disabled ?? null],
      tx,
    );
    if (body.disabled) {
      // Disabling a user kills their sessions immediately.
      await tx.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [id]);
    }
    await audit(
      req,
      { action: 'member.update', resourceType: 'user', resourceId: id, metadata: { from: target.role, ...body } },
      tx,
    );
    return row;
  });
  res.json(updated);
});
