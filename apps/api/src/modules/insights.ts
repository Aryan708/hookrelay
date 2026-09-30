import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db/pool';
import { authenticate, requirePermission } from '../middleware/auth';
import { parse } from '../middleware/http';

export const statsRouter = Router();
statsRouter.use(authenticate);

statsRouter.get('/', requirePermission('events:read'), async (req, res) => {
  const ws = req.principal!.workspaceId;
  const [counts, byStatus, hourly, failing] = await Promise.all([
    query<{ events_24h: number; sources: number; destinations: number; routes: number }>(
      `SELECT (SELECT count(*)::int FROM events WHERE workspace_id = $1 AND received_at > now() - interval '24 hours') AS events_24h,
              (SELECT count(*)::int FROM sources WHERE workspace_id = $1) AS sources,
              (SELECT count(*)::int FROM destinations WHERE workspace_id = $1) AS destinations,
              (SELECT count(*)::int FROM routes WHERE workspace_id = $1 AND enabled) AS routes`,
      [ws],
    ),
    query<{ status: string; n: number }>(
      `SELECT status, count(*)::int AS n FROM deliveries
        WHERE workspace_id = $1 AND created_at > now() - interval '24 hours' GROUP BY status`,
      [ws],
    ),
    query<{ hour: string; succeeded: number; failed: number }>(
      `SELECT to_char(h, 'YYYY-MM-DD"T"HH24:00:00"Z"') AS hour,
              count(d.*) FILTER (WHERE d.status = 'succeeded')::int AS succeeded,
              count(d.*) FILTER (WHERE d.status IN ('failed', 'dead'))::int AS failed
         FROM generate_series(date_trunc('hour', now() AT TIME ZONE 'UTC') - interval '23 hours',
                              date_trunc('hour', now() AT TIME ZONE 'UTC'), interval '1 hour') h
         LEFT JOIN deliveries d ON d.workspace_id = $1
              AND date_trunc('hour', d.created_at AT TIME ZONE 'UTC') = h
        GROUP BY h ORDER BY h`,
      [ws],
    ),
    query(
      `SELECT ds.id, ds.name, count(*)::int AS failures, max(d.last_error) AS sample_error
         FROM deliveries d JOIN destinations ds ON ds.id = d.destination_id
        WHERE d.workspace_id = $1 AND d.status IN ('failed', 'dead') AND d.created_at > now() - interval '24 hours'
        GROUP BY ds.id ORDER BY failures DESC LIMIT 5`,
      [ws],
    ),
  ]);

  const statuses = Object.fromEntries(byStatus.rows.map((r) => [r.status, r.n]));
  const succeeded = statuses.succeeded ?? 0;
  const failed = (statuses.failed ?? 0) + (statuses.dead ?? 0);
  res.json({
    ...counts.rows[0],
    deliveries24h: statuses,
    successRate: succeeded + failed > 0 ? succeeded / (succeeded + failed) : null,
    hourly: hourly.rows,
    topFailingDestinations: failing.rows,
  });
});

export const auditRouter = Router();
auditRouter.use(authenticate);

auditRouter.get('/', requirePermission('audit:read'), async (req, res) => {
  const q = parse(
    z.object({
      action: z.string().max(80).optional(),
      before: z.coerce.number().int().positive().optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
    }),
    req.query,
  );
  const { rows } = await query<{ id: string }>(
    `SELECT a.id, a.actor_type, a.actor_id, u.email AS actor_email, a.action, a.resource_type, a.resource_id,
            a.metadata, a.ip, a.request_id, a.created_at
       FROM audit_logs a LEFT JOIN users u ON a.actor_type = 'user' AND u.id::text = a.actor_id
      WHERE a.workspace_id = $1
        AND ($2::text IS NULL OR a.action LIKE $2 || '%')
        AND ($3::bigint IS NULL OR a.id < $3)
      ORDER BY a.id DESC LIMIT $4`,
    [req.principal!.workspaceId, q.action ?? null, q.before ?? null, q.limit],
  );
  const last = rows.at(-1);
  res.json({ data: rows, nextCursor: rows.length === q.limit && last ? Number(last.id) : null });
});
