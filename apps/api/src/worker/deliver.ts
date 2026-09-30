import { env } from '../config/env';
import { pool } from '../db/pool';
import { buildSignatureHeader, decrypt } from '../lib/crypto';
import { HttpError } from '../lib/errors';
import { logger } from '../lib/logger';
import { backoffDelayMs, isRetryableStatus, parseRetryAfter } from '../lib/retry';
import { assertSafeUrl } from '../lib/ssrf';
import { type Mapping, applyMapping } from '../lib/transform';
import { urlPolicy } from '../modules/destinations';
import { envelope } from '../services/ingest';

export interface WorkerDeps {
  fetch: typeof fetch;
  now: () => number;
  random: () => number;
  retryBaseMs: number;
}

const defaultDeps = (): WorkerDeps => ({
  fetch: (...a) => fetch(...a),
  now: Date.now,
  random: Math.random,
  retryBaseMs: env.RETRY_BASE_MS,
});

interface DueDelivery {
  id: string;
  attempt_count: number;
  event_id: string;
  event_type: string;
  source_id: string;
  received_at: Date;
  payload: unknown;
  mapping: Mapping | null;
  url: string;
  signing_secret_enc: string;
  timeout_ms: number;
  max_attempts: number;
}

const LEASE_SECONDS = 60;
const SNIPPET_LIMIT = 500;

/**
 * Claims due deliveries with FOR UPDATE SKIP LOCKED + a lease, so several worker
 * processes can run concurrently without double-sending.
 */
async function claimBatch(limit: number): Promise<DueDelivery[]> {
  const { rows } = await pool.query<DueDelivery>(
    `WITH due AS (
       SELECT id FROM deliveries
        WHERE status = 'pending' AND next_attempt_at <= now()
          AND (locked_until IS NULL OR locked_until < now())
        ORDER BY next_attempt_at
        LIMIT $1
        FOR UPDATE SKIP LOCKED
     ), claimed AS (
       UPDATE deliveries d SET locked_until = now() + make_interval(secs => $2)
         FROM due WHERE d.id = due.id
       RETURNING d.*
     )
     SELECT c.id, c.attempt_count, e.id AS event_id, e.event_type, e.source_id, e.received_at, e.payload,
            r.mapping, ds.url, ds.signing_secret_enc, ds.timeout_ms, ds.max_attempts
       FROM claimed c
       JOIN events e ON e.id = c.event_id
       JOIN routes r ON r.id = c.route_id
       JOIN destinations ds ON ds.id = c.destination_id`,
    [limit, LEASE_SECONDS],
  );
  return rows;
}

type Outcome = { statusCode: number | null; error: string | null; snippet: string | null; retryAfterMs: number | null };

async function send(d: DueDelivery, deps: WorkerDeps): Promise<Outcome> {
  try {
    // Re-check at send time: DNS may have changed since the destination was saved (rebinding).
    await assertSafeUrl(d.url, urlPolicy());
    const body = JSON.stringify(applyMapping(d.mapping, envelope({ ...d, id: d.event_id })));
    const res = await deps.fetch(d.url, {
      method: 'POST',
      redirect: 'manual', // never follow redirects to unvetted hosts
      signal: AbortSignal.timeout(d.timeout_ms),
      headers: {
        'content-type': 'application/json',
        'user-agent': 'HookRelay/1.0',
        'x-hookrelay-event-id': d.event_id,
        'x-hookrelay-event-type': d.event_type,
        'x-hookrelay-delivery-id': d.id,
        'x-hookrelay-signature': buildSignatureHeader(decrypt(d.signing_secret_enc, env.ENCRYPTION_KEY), body, deps.now()),
        'idempotency-key': d.id,
      },
      body,
    });
    const text = (await res.text().catch(() => '')).slice(0, SNIPPET_LIMIT);
    return {
      statusCode: res.status,
      error: res.ok ? null : `HTTP ${res.status}`,
      snippet: text || null,
      retryAfterMs: parseRetryAfter(res.headers.get('retry-after'), deps.now()),
    };
  } catch (err) {
    // undici wraps the real reason (ECONNREFUSED, ENOTFOUND, ...) in `cause`; surface that, not "fetch failed".
    const e = err as Error & { code?: string; cause?: { code?: string; message?: string } };
    const message =
      e.name === 'TimeoutError'
        ? `Timed out after ${d.timeout_ms}ms`
        : e instanceof HttpError
          ? e.message
          : (e.cause?.code ?? e.code ?? e.cause?.message ?? e.message);
    return { statusCode: null, error: message.slice(0, SNIPPET_LIMIT), snippet: null, retryAfterMs: null };
  }
}

export async function processDelivery(d: DueDelivery, deps: WorkerDeps): Promise<string> {
  const started = deps.now();
  const outcome = await send(d, deps);
  const duration = Math.max(0, deps.now() - started);
  const attempt = d.attempt_count + 1;

  const ok = outcome.statusCode !== null && outcome.statusCode >= 200 && outcome.statusCode < 300;
  const retryable = outcome.statusCode === null || isRetryableStatus(outcome.statusCode);
  const status = ok ? 'succeeded' : !retryable ? 'failed' : attempt >= d.max_attempts ? 'dead' : 'pending';
  const delay = outcome.retryAfterMs ?? backoffDelayMs(attempt, deps.retryBaseMs, deps.random);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO delivery_attempts (delivery_id, attempt_no, status_code, error, duration_ms, response_snippet)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [d.id, attempt, outcome.statusCode, outcome.error, duration, outcome.snippet],
    );
    await client.query(
      `UPDATE deliveries SET status = $2, attempt_count = $3, last_status_code = $4, last_error = $5,
              locked_until = NULL, updated_at = now(),
              next_attempt_at = CASE WHEN $2 = 'pending' THEN now() + make_interval(secs => $6::double precision / 1000) END,
              completed_at = CASE WHEN $2 = 'pending' THEN NULL ELSE now() END
        WHERE id = $1`,
      [d.id, status, attempt, outcome.statusCode, outcome.error, delay],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  const log = { deliveryId: d.id, eventId: d.event_id, attempt, status, statusCode: outcome.statusCode, durationMs: duration };
  if (status === 'dead') logger.warn({ ...log, error: outcome.error }, 'delivery_dead_lettered');
  else if (status !== 'succeeded') logger.info({ ...log, error: outcome.error }, 'delivery_attempt_failed');
  else logger.debug(log, 'delivery_succeeded');
  return status;
}

/** Processes one batch; returns how many deliveries were attempted. */
export async function runOnce(deps: WorkerDeps = defaultDeps(), batchSize = env.WORKER_BATCH_SIZE): Promise<number> {
  const batch = await claimBatch(batchSize);
  await Promise.all(batch.map((d) => processDelivery(d, deps)));
  return batch.length;
}

export function startWorker(deps: WorkerDeps = defaultDeps()): () => Promise<void> {
  let stopped = false;
  let current: Promise<unknown> = Promise.resolve();

  const loop = async () => {
    while (!stopped) {
      try {
        current = runOnce(deps);
        const n = (await current) as number;
        if (n > 0) continue; // drain quickly while there is work
      } catch (err) {
        logger.error({ err }, 'worker_iteration_failed');
      }
      await new Promise((r) => setTimeout(r, env.WORKER_POLL_MS));
    }
  };
  void loop();
  logger.info({ pollMs: env.WORKER_POLL_MS }, 'delivery_worker_started');

  return async () => {
    stopped = true;
    await current.catch(() => undefined);
  };
}
