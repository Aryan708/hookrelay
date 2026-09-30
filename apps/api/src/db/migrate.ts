import fs from 'node:fs/promises';
import path from 'node:path';
import type { Pool } from 'pg';

// Minimal forward-only migration runner: applies migrations/*.sql in order, each in a transaction.
export async function migrate(pool: Pool, dir = path.resolve(__dirname, '../../migrations')): Promise<string[]> {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const applied = new Set(
    (await pool.query<{ version: string }>('SELECT version FROM schema_migrations')).rows.map((r) => r.version),
  );
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const ran: string[] = [];

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await fs.readFile(path.join(dir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
      await client.query('COMMIT');
      ran.push(file);
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`Migration ${file} failed: ${(err as Error).message}`, { cause: err });
    } finally {
      client.release();
    }
  }
  return ran;
}

if (require.main === module) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { pool } = require('./pool') as typeof import('./pool');
  migrate(pool)
    .then((ran) => {
      console.log(ran.length ? `Applied: ${ran.join(', ')}` : 'Database is up to date');
      return pool.end();
    })
    .catch((err: Error) => {
      console.error(err.message);
      process.exit(1);
    });
}
