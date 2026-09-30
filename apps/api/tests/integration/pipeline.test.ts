import crypto from 'node:crypto';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../../src/db/pool';
import { verifySignatureHeader } from '../../src/lib/crypto';
import { runOnce } from '../../src/worker/deliver';
import { type Receiver, app, auth, register, resetDatabase, signedIngest, startReceiver, truncateAll } from '../helpers';

let receiver: Receiver;
beforeAll(resetDatabase);
beforeEach(async () => {
  await truncateAll();
  receiver = await startReceiver();
});
afterEach(() => receiver.close());
afterAll(() => pool.end());

const deps = { fetch: (...a: Parameters<typeof fetch>) => fetch(...a), now: Date.now, random: () => 0, retryBaseMs: 1 };

/** Makes due-later deliveries due now, then runs the worker (simulates time passing). */
async function drain(times = 1) {
  for (let i = 0; i < times; i++) {
    await pool.query(`UPDATE deliveries SET next_attempt_at = now() WHERE status = 'pending'`);
    await runOnce(deps);
  }
}

async function setup(route: Record<string, unknown> = {}, destination: Record<string, unknown> = {}) {
  const { token } = await register();
  const source = await request(app).post('/v1/sources').set(auth(token)).send({ name: 'Stripe' }).expect(201);
  const dest = await request(app)
    .post('/v1/destinations')
    .set(auth(token))
    .send({ name: 'n8n: payments', url: receiver.url, ...destination })
    .expect(201);
  const r = await request(app)
    .post('/v1/routes')
    .set(auth(token))
    .send({ name: 'Payments → n8n', sourceId: source.body.id, destinationId: dest.body.id, ...route })
    .expect(201);
  return {
    token,
    sourceId: source.body.id as string,
    secret: source.body.signingSecret as string,
    destSecret: dest.body.signingSecret as string,
    destId: dest.body.id as string,
    routeId: r.body.id as string,
  };
}

// Raw provider payload. Routes see it as `data` inside the HookRelay envelope ({ id, type, source_id, received_at, data }).
const payment = { type: 'payment.succeeded', id: 'pi_1', amount: 4200, customer: { email: 'ada@example.com', name: 'Ada' } };

describe('webhook ingest', () => {
  it('accepts a signed webhook and queues a delivery', async () => {
    const s = await setup();
    const res = await signedIngest(s.sourceId, s.secret, payment).expect(202);
    expect(res.body).toMatchObject({ duplicate: false, deliveries: [{ routeId: s.routeId, status: 'pending' }] });
  });

  it('rejects bad, missing and stale signatures with an identical error', async () => {
    const s = await setup();
    const bad = await signedIngest(s.sourceId, 'whsec_wrong', payment).expect(401);
    const missing = await request(app).post(`/v1/ingest/${s.sourceId}`).send(payment).expect(401);
    const unknown = await signedIngest(crypto.randomUUID(), s.secret, payment).expect(401);
    expect(bad.body.error.code).toBe(missing.body.error.code);
    expect(unknown.body.error.code).toBe('invalid_signature');
    const { rows } = await pool.query(`SELECT metadata FROM audit_logs WHERE action = 'ingest.signature_rejected'`);
    expect(rows.map((r) => r.metadata.reason).sort()).toEqual(['mismatch', 'missing']);
  });

  it('is idempotent on Idempotency-Key', async () => {
    const s = await setup();
    const first = await signedIngest(s.sourceId, s.secret, payment, { 'Idempotency-Key': 'evt_123' }).expect(202);
    const again = await signedIngest(s.sourceId, s.secret, payment, { 'Idempotency-Key': 'evt_123' }).expect(200);
    expect(again.body).toMatchObject({ id: first.body.id, duplicate: true });
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM deliveries');
    expect(rows[0].n).toBe(1);
  });

  it('skips deliveries whose route filter does not match', async () => {
    const s = await setup({ filter: [{ path: 'data.amount', op: 'gte', value: 10000 }] });
    const res = await signedIngest(s.sourceId, s.secret, payment).expect(202);
    expect(res.body.deliveries[0].status).toBe('skipped');
    await drain();
    expect(receiver.received).toHaveLength(0);
  });

  it('accepts events published with an API key', async () => {
    const s = await setup();
    const key = (
      await request(app).post('/v1/api-keys').set(auth(s.token)).send({ name: 'script', scopes: ['events:write'] }).expect(201)
    ).body.key;
    await request(app)
      .post('/v1/events')
      .set('X-API-Key', key)
      .send({ sourceId: s.sourceId, type: 'lead.created', payload: { email: 'x@y.z' } })
      .expect(202);
  });
});

describe('delivery worker', () => {
  it('delivers the mapped payload with a verifiable signature', async () => {
    const s = await setup({
      mapping: {
        email: 'data.customer.email',
        amount_cents: 'data.amount',
        source: { const: 'stripe' },
        message: { template: '{{data.customer.name}} paid {{data.amount}}' },
      },
    });
    const ingest = await signedIngest(s.sourceId, s.secret, payment).expect(202);
    await drain();

    expect(receiver.received).toHaveLength(1);
    const hit = receiver.received[0]!;
    expect(JSON.parse(hit.body)).toEqual({ email: 'ada@example.com', amount_cents: 4200, source: 'stripe', message: 'Ada paid 4200' });
    expect(hit.headers['x-hookrelay-event-id']).toBe(ingest.body.id);
    expect(verifySignatureHeader(hit.headers['x-hookrelay-signature'] as string, s.destSecret, hit.body, 300).ok).toBe(true);

    const event = await request(app).get(`/v1/events/${ingest.body.id}`).set(auth(s.token)).expect(200);
    expect(event.body.deliveries[0]).toMatchObject({ status: 'succeeded', attempt_count: 1, last_status_code: 200 });
  });

  it('retries transient failures with backoff and then succeeds', async () => {
    const s = await setup();
    receiver.respondWith([503, 429]);
    const ingest = await signedIngest(s.sourceId, s.secret, payment).expect(202);
    await drain(3);
    const event = await request(app).get(`/v1/events/${ingest.body.id}`).set(auth(s.token)).expect(200);
    const d = event.body.deliveries[0];
    expect(d.status).toBe('succeeded');
    expect(d.attempts.map((a: { status_code: number }) => a.status_code)).toEqual([503, 429, 200]);
  });

  it('dead-letters after max attempts, and replay re-queues it', async () => {
    const s = await setup({}, { maxAttempts: 2 });
    receiver.respondWith([500, 500]);
    const ingest = await signedIngest(s.sourceId, s.secret, payment).expect(202);
    await drain(3);
    let event = await request(app).get(`/v1/events/${ingest.body.id}`).set(auth(s.token)).expect(200);
    const d = event.body.deliveries[0];
    expect(d).toMatchObject({ status: 'dead', attempt_count: 2 });

    await request(app).post(`/v1/deliveries/${d.id}/replay`).set(auth(s.token)).expect(202);
    await drain();
    event = await request(app).get(`/v1/events/${ingest.body.id}`).set(auth(s.token)).expect(200);
    expect(event.body.deliveries[0].status).toBe('succeeded');
    const audit = await pool.query(`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'delivery.replay'`);
    expect(audit.rows[0].n).toBe(1);
  });

  it('does not retry permanent 4xx errors', async () => {
    const s = await setup();
    receiver.respondWith([422]);
    const ingest = await signedIngest(s.sourceId, s.secret, payment).expect(202);
    await drain(2);
    const event = await request(app).get(`/v1/events/${ingest.body.id}`).set(auth(s.token)).expect(200);
    expect(event.body.deliveries[0]).toMatchObject({ status: 'failed', attempt_count: 1 });
  });

  it('records network errors as retryable attempts', async () => {
    const s = await setup({}, { url: 'http://127.0.0.1:59999/unreachable' });
    const ingest = await signedIngest(s.sourceId, s.secret, payment).expect(202);
    await drain();
    const event = await request(app).get(`/v1/events/${ingest.body.id}`).set(auth(s.token)).expect(200);
    expect(event.body.deliveries[0]).toMatchObject({ status: 'pending', attempt_count: 1, last_status_code: null });
    expect(event.body.deliveries[0].last_error).toBe('ECONNREFUSED');
  });

  it('never double-delivers when two workers run concurrently', async () => {
    const s = await setup();
    for (let i = 0; i < 8; i++) await signedIngest(s.sourceId, s.secret, { ...payment, n: i }).expect(202);
    await Promise.all([runOnce(deps, 5), runOnce(deps, 5), runOnce(deps, 5)]);
    expect(receiver.received).toHaveLength(8);
    const ids = receiver.received.map((r) => r.headers['x-hookrelay-delivery-id']);
    expect(new Set(ids).size).toBe(8);
  });
});

describe('insights & audit', () => {
  it('reports stats and an append-only audit trail', async () => {
    const s = await setup();
    await signedIngest(s.sourceId, s.secret, payment).expect(202);
    await drain();

    const stats = await request(app).get('/v1/stats').set(auth(s.token)).expect(200);
    expect(stats.body).toMatchObject({ events_24h: 1, sources: 1, destinations: 1, routes: 1, successRate: 1 });
    expect(stats.body.hourly).toHaveLength(24);

    const log = await request(app).get('/v1/audit-logs').set(auth(s.token)).expect(200);
    const actions = log.body.data.map((a: { action: string }) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['auth.register', 'source.create', 'destination.create', 'route.create']));
    expect(log.body.data[0].actor_email).toBe('owner@acme.test');

    await expect(pool.query('UPDATE audit_logs SET action = $1', ['tampered'])).rejects.toThrow(/append-only/);
    await expect(pool.query('DELETE FROM audit_logs')).rejects.toThrow(/append-only/);
  });

  it('never exposes stored secrets through the API', async () => {
    const s = await setup();
    const payloads = await Promise.all([
      request(app).get('/v1/sources').set(auth(s.token)),
      request(app).get(`/v1/sources/${s.sourceId}`).set(auth(s.token)),
      request(app).get('/v1/destinations').set(auth(s.token)),
      request(app).get('/v1/routes').set(auth(s.token)),
    ]);
    for (const p of payloads) {
      const text = JSON.stringify(p.body);
      expect(text).not.toContain(s.secret);
      expect(text).not.toContain(s.destSecret);
      expect(text).not.toContain('signing_secret_enc');
    }
    const { rows } = await pool.query('SELECT signing_secret_enc FROM sources');
    expect(rows[0].signing_secret_enc).not.toContain(s.secret);
  });

  it('validates input and hides internals in errors', async () => {
    const s = await setup();
    const res = await request(app).post('/v1/routes').set(auth(s.token)).send({ name: '', sourceId: 'nope' }).expect(422);
    expect(res.body.error.details.length).toBeGreaterThan(0);
    const bad = await request(app)
      .post('/v1/sources')
      .set(auth(s.token))
      .set('content-type', 'application/json')
      .send('{not json')
      .expect(400);
    expect(bad.body.error.code).toBe('invalid_json');
    expect(bad.body.error.requestId).toBeTruthy();
  });

  it('serves health, readiness and the OpenAPI spec with security headers', async () => {
    const health = await request(app).get('/healthz').expect(200);
    expect(health.headers['x-content-type-options']).toBe('nosniff');
    expect(health.headers['x-powered-by']).toBeUndefined();
    await request(app).get('/readyz').expect(200);
    const spec = await request(app).get('/openapi.json').expect(200);
    expect(spec.body.openapi).toBe('3.1.0');
  });
});
