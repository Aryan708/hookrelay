import type { Request } from 'express';
import { pool, type Queryable } from '../db/pool';
import { logger } from '../lib/logger';

export interface AuditEntry {
  action: string;
  resourceType?: string;
  resourceId?: string;
  metadata?: Record<string, unknown>;
  workspaceId?: string;
  actor?: { type: 'user' | 'api_key' | 'system' | 'anonymous'; id?: string };
}

/**
 * Writes an append-only audit record. Actor, workspace, IP and request id are
 * taken from the request so every call site produces consistent evidence.
 */
export async function audit(req: Request | null, entry: AuditEntry, db: Queryable = pool): Promise<void> {
  const p = req?.principal;
  const actor = entry.actor ?? (p ? { type: p.type, id: p.id } : { type: 'anonymous' as const });
  try {
    await db.query(
      `INSERT INTO audit_logs (workspace_id, actor_type, actor_id, action, resource_type, resource_id, metadata, ip, request_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        entry.workspaceId ?? p?.workspaceId ?? null,
        actor.type,
        actor.id ?? null,
        entry.action,
        entry.resourceType ?? null,
        entry.resourceId ?? null,
        entry.metadata ?? {},
        req?.ip ?? null,
        req?.id ?? null,
      ],
    );
  } catch (err) {
    // Audit failures are logged loudly but surfaced to monitoring rather than failing user requests.
    logger.error({ err, action: entry.action }, 'audit_write_failed');
    if (db !== pool) throw err; // inside a transaction, fail the whole unit of work
  }
}
