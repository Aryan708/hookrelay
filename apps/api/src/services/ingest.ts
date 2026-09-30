import type { PoolClient } from 'pg';
import { one } from '../db/pool';
import { type Condition, matchesConditions } from '../lib/transform';

export interface IngestInput {
  workspaceId: string;
  sourceId: string;
  eventType: string;
  payload: unknown;
  idempotencyKey?: string | null;
}

export interface IngestResult {
  id: string;
  duplicate: boolean;
  deliveries: { routeId: string; status: 'pending' | 'skipped' }[];
}

/** The envelope routes filter on and mappings read from. */
export const envelope = (e: { id: string; event_type: string; source_id: string; received_at: Date | string; payload: unknown }) => ({
  id: e.id,
  type: e.event_type,
  source_id: e.source_id,
  received_at: e.received_at,
  data: e.payload,
});

/**
 * Stores an event (idempotently) and fans it out to every enabled route on its source.
 * Runs inside the caller's transaction so the event and its deliveries commit atomically.
 */
export async function ingestEvent(tx: PoolClient, input: IngestInput): Promise<IngestResult> {
  if (input.idempotencyKey) {
    const existing = await one<{ id: string }>(
      'SELECT id FROM events WHERE source_id = $1 AND idempotency_key = $2',
      [input.sourceId, input.idempotencyKey],
      tx,
    );
    if (existing) return { id: existing.id, duplicate: true, deliveries: [] };
  }

  const event = await one<{ id: string; event_type: string; source_id: string; received_at: Date; payload: unknown }>(
    `INSERT INTO events (workspace_id, source_id, idempotency_key, event_type, payload)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (source_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
     RETURNING id, event_type, source_id, received_at, payload`,
    [input.workspaceId, input.sourceId, input.idempotencyKey ?? null, input.eventType, JSON.stringify(input.payload)],
    tx,
  );
  if (!event) {
    // Lost a race with a concurrent duplicate.
    const existing = await one<{ id: string }>(
      'SELECT id FROM events WHERE source_id = $1 AND idempotency_key = $2',
      [input.sourceId, input.idempotencyKey],
      tx,
    );
    return { id: existing!.id, duplicate: true, deliveries: [] };
  }

  const { rows: routes } = await tx.query<{ id: string; destination_id: string; filter: Condition[] }>(
    'SELECT id, destination_id, filter FROM routes WHERE source_id = $1 AND enabled',
    [input.sourceId],
  );

  const doc = envelope(event);
  const deliveries: IngestResult['deliveries'] = [];
  for (const route of routes) {
    const status = matchesConditions(route.filter ?? [], doc) ? 'pending' : 'skipped';
    await tx.query(
      `INSERT INTO deliveries (workspace_id, event_id, route_id, destination_id, status, next_attempt_at, completed_at)
       VALUES ($1, $2, $3, $4, $5, CASE WHEN $5 = 'pending' THEN now() END, CASE WHEN $5 = 'skipped' THEN now() END)`,
      [input.workspaceId, event.id, route.id, route.destination_id, status],
    );
    deliveries.push({ routeId: route.id, status });
  }
  return { id: event.id, duplicate: false, deliveries };
}
