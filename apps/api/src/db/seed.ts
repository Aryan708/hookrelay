import bcrypt from 'bcryptjs';
import { env } from '../config/env';
import { buildSignatureHeader, encrypt } from '../lib/crypto';
import { migrate } from './migrate';
import { pool, withTransaction } from './pool';
import { ingestEvent } from '../services/ingest';

/**
 * Local demo data. Creates a workspace with one user per role and a Stripe → n8n pipeline.
 * Credentials come from env (SEED_PASSWORD) so nothing sensitive is hard-coded.
 */
async function main() {
  if (env.NODE_ENV === 'production') throw new Error('Refusing to seed a production database');
  const password = process.env.SEED_PASSWORD;
  if (!password || password.length < 12) throw new Error('Set SEED_PASSWORD (12+ chars) to seed demo users');

  await migrate(pool);
  const n8nUrl = process.env.SEED_N8N_WEBHOOK_URL ?? 'http://n8n:5678/webhook/hookrelay-payments';
  const sourceSecret = process.env.SEED_SOURCE_SECRET ?? `whsec_demo_${Date.now()}`;

  const seeded = await withTransaction(async (tx) => {
    const exists = await tx.query(`SELECT 1 FROM users WHERE email = 'owner@demo.hookrelay.dev'`);
    if (exists.rowCount) return null;
    const hash = await bcrypt.hash(password, 12);
    const ws = (await tx.query<{ id: string }>(`INSERT INTO workspaces (name) VALUES ('Demo Co') RETURNING id`)).rows[0]!.id;
    for (const role of ['owner', 'admin', 'developer', 'viewer']) {
      await tx.query(`INSERT INTO users (workspace_id, email, name, role, password_hash) VALUES ($1, $2, $3, $4, $5)`, [
        ws,
        `${role}@demo.hookrelay.dev`,
        `Demo ${role[0]!.toUpperCase()}${role.slice(1)}`,
        role,
        hash,
      ]);
    }
    const source = (
      await tx.query<{ id: string }>(
        `INSERT INTO sources (workspace_id, name, description, signing_secret_enc) VALUES ($1, 'Stripe (test mode)', 'Payment events', $2) RETURNING id`,
        [ws, encrypt(sourceSecret, env.ENCRYPTION_KEY)],
      )
    ).rows[0]!.id;
    const dest = (
      await tx.query<{ id: string }>(
        `INSERT INTO destinations (workspace_id, name, url, signing_secret_enc) VALUES ($1, 'n8n: payment workflow', $2, $3) RETURNING id`,
        [ws, n8nUrl, encrypt(`whsec_dest_${Date.now()}`, env.ENCRYPTION_KEY)],
      )
    ).rows[0]!.id;
    await tx.query(
      `INSERT INTO routes (workspace_id, name, source_id, destination_id, filter, mapping) VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        ws,
        'Paid invoices → CRM + email',
        source,
        dest,
        JSON.stringify([{ path: 'type', op: 'eq', value: 'payment.succeeded' }]),
        JSON.stringify({
          event_id: 'id',
          'customer.email': 'data.customer.email',
          'customer.name': 'data.customer.name',
          amount: 'data.amount',
          currency: 'data.currency',
          summary: { template: '{{data.customer.name}} paid {{data.amount}} {{data.currency}}' },
        }),
      ],
    );
    const samples = [
      { type: 'payment.succeeded', amount: 4900, currency: 'usd', customer: { name: 'Ada Lovelace', email: 'ada@example.com' } },
      { type: 'payment.succeeded', amount: 12900, currency: 'usd', customer: { name: 'Alan Turing', email: 'alan@example.com' } },
      { type: 'payment.failed', amount: 4900, currency: 'usd', customer: { name: 'Grace Hopper', email: 'grace@example.com' } },
    ];
    for (const [i, payload] of samples.entries()) {
      await ingestEvent(tx, { workspaceId: ws, sourceId: source, eventType: payload.type, payload, idempotencyKey: `seed_${i}` });
    }
    return source;
  });
  await pool.end();

  // Report only after the transaction has committed.
  if (!seeded) {
    console.log('Demo data already present, skipping.');
    return;
  }
  console.log('Seeded demo workspace. Users: {owner,admin,developer,viewer}@demo.hookrelay.dev (password = SEED_PASSWORD)');
  console.log(`Source ${seeded} signing secret: ${sourceSecret}`);
  console.log(`Example signature header: ${buildSignatureHeader(sourceSecret, '{}')}`);
}

main().catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
