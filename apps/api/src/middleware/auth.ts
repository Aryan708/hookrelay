import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { one, query } from '../db/pool';
import { sha256 } from '../lib/crypto';
import { forbidden, unauthorized } from '../lib/errors';
import { type Permission, ROLE_PERMISSIONS, type Role, hasPermission } from '../lib/rbac';
import type { Principal } from '../types/express';

export const API_KEY_PREFIX = 'hr_';

interface AccessClaims {
  sub: string;
  wid: string;
  role: Role;
  email: string;
}

export function signAccessToken(user: { id: string; workspace_id: string; role: Role; email: string }): string {
  const claims: AccessClaims = { sub: user.id, wid: user.workspace_id, role: user.role, email: user.email };
  return jwt.sign(claims, env.JWT_ACCESS_SECRET, {
    algorithm: 'HS256',
    expiresIn: env.JWT_ACCESS_TTL_SECONDS,
    issuer: 'hookrelay',
    audience: 'hookrelay-api',
  });
}

async function principalFromJwt(token: string): Promise<Principal> {
  let claims: AccessClaims;
  try {
    claims = jwt.verify(token, env.JWT_ACCESS_SECRET, {
      algorithms: ['HS256'], // pin the algorithm: never accept "none" or asymmetric confusion
      issuer: 'hookrelay',
      audience: 'hookrelay-api',
    }) as AccessClaims;
  } catch {
    throw unauthorized('Invalid or expired access token');
  }
  // Re-read role from the DB so demotions and disabled accounts take effect immediately.
  const user = await one<{ id: string; workspace_id: string; role: Role; email: string; disabled_at: Date | null }>(
    'SELECT id, workspace_id, role, email, disabled_at FROM users WHERE id = $1',
    [claims.sub],
  );
  if (!user || user.disabled_at) throw unauthorized('Account is not active');
  return {
    type: 'user',
    id: user.id,
    workspaceId: user.workspace_id,
    role: user.role,
    email: user.email,
    permissions: ROLE_PERMISSIONS[user.role],
  };
}

async function principalFromApiKey(key: string): Promise<Principal> {
  const row = await one<{ id: string; workspace_id: string; scopes: string[] }>(
    `SELECT id, workspace_id, scopes FROM api_keys
      WHERE key_hash = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`,
    [sha256(key)],
  );
  if (!row) throw unauthorized('Invalid API key');
  // Fire-and-forget usage tracking; failures here must not block the request.
  query('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [row.id]).catch(() => undefined);
  return { type: 'api_key', id: row.id, workspaceId: row.workspace_id, permissions: new Set(row.scopes as Permission[]) };
}

/** Accepts `Authorization: Bearer <jwt>`, `Authorization: Bearer hr_...` or `X-API-Key: hr_...`. */
export async function authenticate(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const header = req.header('authorization');
  const bearer = header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined;
  const apiKey = req.header('x-api-key') ?? (bearer?.startsWith(API_KEY_PREFIX) ? bearer : undefined);

  if (apiKey) req.principal = await principalFromApiKey(apiKey);
  else if (bearer) req.principal = await principalFromJwt(bearer);
  else throw unauthorized();
  next();
}

export function requirePermission(permission: Permission) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.principal) throw unauthorized();
    if (!hasPermission(req.principal.permissions, permission)) throw forbidden(`Missing permission: ${permission}`);
    next();
  };
}

export function requireUser(req: Request): Extract<Principal, { type: 'user' }> {
  if (req.principal?.type !== 'user') throw forbidden('This action requires a signed-in user');
  return req.principal;
}

export function principal(req: Request): Principal {
  if (!req.principal) throw unauthorized();
  return req.principal;
}
