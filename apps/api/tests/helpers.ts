import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { createApp } from '../src/app';
import { pool } from '../src/db/pool';
import { migrate } from '../src/db/migrate';
import { buildSignatureHeader } from '../src/lib/crypto';

export const app = createApp();
export const PASSWORD = 'Sup3rSecretPassw0rd';

export async function resetDatabase() {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(pool);
}

export async function truncateAll() {
  await pool.query(`TRUNCATE workspaces, users, refresh_tokens, api_keys, sources, destinations, routes,
                    events, deliveries, delivery_attempts, audit_logs RESTART IDENTITY CASCADE`);
}

export async function register(email = 'owner@acme.test', workspaceName = 'Acme') {
  const res = await request(app)
    .post('/v1/auth/register')
    .send({ workspaceName, name: 'Owner', email, password: PASSWORD })
    .expect(201);
  return {
    token: res.body.accessToken as string,
    user: res.body.user as { id: string; workspaceId: string },
    cookie: res.headers['set-cookie'] as unknown as string[],
  };
}

export async function login(email: string, password = PASSWORD) {
  const res = await request(app).post('/v1/auth/login').send({ email, password }).expect(200);
  return res.body.accessToken as string;
}

export const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

export function signedIngest(sourceId: string, secret: string, payload: unknown, headers: Record<string, string> = {}) {
  const body = JSON.stringify(payload);
  return request(app)
    .post(`/v1/ingest/${sourceId}`)
    .set('content-type', 'application/json')
    .set('x-hookrelay-signature', buildSignatureHeader(secret, body))
    .set(headers)
    .send(body);
}

export interface Receiver {
  url: string;
  received: { headers: http.IncomingHttpHeaders; body: string }[];
  respondWith: (statuses: number[]) => void;
  close: () => Promise<void>;
}

/** A local HTTP server standing in for an n8n webhook / third-party endpoint. */
export async function startReceiver(): Promise<Receiver> {
  const received: Receiver['received'] = [];
  let queue: number[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ headers: req.headers, body });
      res.statusCode = queue.shift() ?? 200;
      res.end(JSON.stringify({ ok: res.statusCode < 300 }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/webhook/hookrelay`,
    received,
    respondWith: (s) => {
      queue = [...s];
    },
    close: () => new Promise((r) => server.close(() => r())),
  };
}
