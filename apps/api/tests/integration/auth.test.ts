import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../../src/db/pool';
import { setAuthFetch } from '../../src/modules/auth';
import { PASSWORD, app, auth, login, register, resetDatabase, truncateAll } from '../helpers';

beforeAll(resetDatabase);
beforeEach(truncateAll);
afterAll(() => pool.end());

const cookieHeader = (setCookie: string[]) => setCookie.map((c) => c.split(';')[0]).join('; ');

describe('registration & login', () => {
  it('registers an owner and returns a session with an httpOnly refresh cookie', async () => {
    const res = await request(app)
      .post('/v1/auth/register')
      .send({ workspaceName: 'Acme', name: 'Ada', email: 'ADA@acme.test', password: PASSWORD })
      .expect(201);
    expect(res.body.user).toMatchObject({ email: 'ada@acme.test', role: 'owner' });
    expect(res.body.accessToken).toMatch(/^eyJ/);
    const cookie = (res.headers['set-cookie'] as unknown as string[])[0]!;
    expect(cookie).toMatch(/^hr_refresh=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);

    const { rows } = await pool.query('SELECT password_hash FROM users');
    expect(rows[0].password_hash).toMatch(/^\$2[aby]\$12\$/); // bcrypt, cost 12
  });

  it('enforces password policy and unique emails', async () => {
    await request(app)
      .post('/v1/auth/register')
      .send({ workspaceName: 'A', name: 'A', email: 'a@a.test', password: 'short' })
      .expect(422);
    await register('dup@acme.test');
    await request(app)
      .post('/v1/auth/register')
      .send({ workspaceName: 'Beta', name: 'B', email: 'dup@acme.test', password: PASSWORD })
      .expect(409);
  });

  it('returns the same error for unknown email and wrong password, and audits failures', async () => {
    await register('ada@acme.test');
    const a = await request(app).post('/v1/auth/login').send({ email: 'ada@acme.test', password: 'Wrong-passw0rd' }).expect(401);
    const b = await request(app).post('/v1/auth/login').send({ email: 'nobody@acme.test', password: 'Wrong-passw0rd' }).expect(401);
    expect(a.body.error.message).toBe(b.body.error.message);
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'auth.login_failed'`);
    expect(rows[0].n).toBe(2);
  });

  it('rejects tampered, missing and alg=none tokens', async () => {
    const { token } = await register();
    await request(app).get('/v1/auth/me').expect(401);
    await request(app).get('/v1/auth/me').set(auth(`${token}x`)).expect(401);
    const [h, p] = token.split('.');
    const none = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${p}.`;
    expect(h).toBeTruthy();
    await request(app).get('/v1/auth/me').set(auth(none)).expect(401);
    const me = await request(app).get('/v1/auth/me').set(auth(token)).expect(200);
    expect(me.body.permissions).toContain('audit:read');
  });
});

describe('refresh token rotation', () => {
  it('rotates on use and revokes the family when an old token is replayed', async () => {
    const { cookie } = await register();
    const first = await request(app).post('/v1/auth/refresh').set('Cookie', cookieHeader(cookie)).expect(200);
    const rotated = first.headers['set-cookie'] as unknown as string[];
    expect(cookieHeader(rotated)).not.toBe(cookieHeader(cookie));

    // Replaying the original (already rotated) token = theft signal
    const replay = await request(app).post('/v1/auth/refresh').set('Cookie', cookieHeader(cookie)).expect(401);
    expect(replay.body.error.code).toBe('token_reuse');

    // ...and the legitimately rotated token is now dead too
    await request(app).post('/v1/auth/refresh').set('Cookie', cookieHeader(rotated)).expect(401);
    // Both presentations of a revoked token are recorded as reuse.
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'auth.refresh_token_reuse'`);
    expect(rows[0].n).toBe(2);
  });

  it('logout revokes the session', async () => {
    const { cookie } = await register();
    await request(app).post('/v1/auth/logout').set('Cookie', cookieHeader(cookie)).expect(204);
    await request(app).post('/v1/auth/refresh').set('Cookie', cookieHeader(cookie)).expect(401);
  });
});

describe('RBAC & members', () => {
  it('lets owners add members but never above their own role', async () => {
    const owner = await register();
    await request(app)
      .post('/v1/members')
      .set(auth(owner.token))
      .send({ email: 'viewer@acme.test', name: 'V', role: 'viewer', temporaryPassword: PASSWORD })
      .expect(201);
    await request(app)
      .post('/v1/members')
      .set(auth(owner.token))
      .send({ email: 'admin@acme.test', name: 'A', role: 'admin', temporaryPassword: PASSWORD })
      .expect(201);

    const admin = await login('admin@acme.test');
    await request(app)
      .post('/v1/members')
      .set(auth(admin))
      .send({ email: 'evil@acme.test', name: 'E', role: 'owner', temporaryPassword: PASSWORD })
      .expect(403);

    const viewer = await login('viewer@acme.test');
    await request(app).get('/v1/sources').set(auth(viewer)).expect(200);
    const denied = await request(app).post('/v1/sources').set(auth(viewer)).send({ name: 'x' }).expect(403);
    expect(denied.body.error.message).toContain('sources:write');
    await request(app).get('/v1/audit-logs').set(auth(viewer)).expect(403);
  });

  it('applies demotions immediately and protects the last owner', async () => {
    const owner = await register();
    const dev = await request(app)
      .post('/v1/members')
      .set(auth(owner.token))
      .send({ email: 'dev@acme.test', name: 'D', role: 'developer', temporaryPassword: PASSWORD })
      .expect(201);
    const devToken = await login('dev@acme.test');
    await request(app).post('/v1/sources').set(auth(devToken)).send({ name: 'Stripe' }).expect(201);

    await request(app).patch(`/v1/members/${dev.body.id}`).set(auth(owner.token)).send({ role: 'viewer' }).expect(200);
    // Same (still unexpired) JWT, but the role is re-read from the DB
    await request(app).post('/v1/sources').set(auth(devToken)).send({ name: 'Nope' }).expect(403);

    await request(app).patch(`/v1/members/${owner.user.id}`).set(auth(owner.token)).send({ role: 'admin' }).expect(400);
  });

  it('disabling a member blocks their tokens', async () => {
    const owner = await register();
    const m = await request(app)
      .post('/v1/members')
      .set(auth(owner.token))
      .send({ email: 'm@acme.test', name: 'M', role: 'developer', temporaryPassword: PASSWORD })
      .expect(201);
    const t = await login('m@acme.test');
    await request(app).patch(`/v1/members/${m.body.id}`).set(auth(owner.token)).send({ disabled: true }).expect(200);
    await request(app).get('/v1/sources').set(auth(t)).expect(401);
  });

  it('isolates tenants', async () => {
    const a = await register('a@alpha.test', 'Alpha');
    const b = await register('b@beta.test', 'Beta');
    const src = await request(app).post('/v1/sources').set(auth(a.token)).send({ name: 'A-only' }).expect(201);
    await request(app).get(`/v1/sources/${src.body.id}`).set(auth(b.token)).expect(404);
    const list = await request(app).get('/v1/sources').set(auth(b.token)).expect(200);
    expect(list.body.data).toHaveLength(0);
  });
});

describe('API keys', () => {
  it('creates a scoped key shown once, stores only its hash, and can be revoked', async () => {
    const { token } = await register();
    const created = await request(app)
      .post('/v1/api-keys')
      .set(auth(token))
      .send({ name: 'n8n', scopes: ['events:read'] })
      .expect(201);
    const key = created.body.key as string;
    expect(key).toMatch(/^hr_\w{8}_/);

    const { rows } = await pool.query('SELECT key_hash FROM api_keys');
    expect(rows[0].key_hash).not.toContain(key);
    const list = await request(app).get('/v1/api-keys').set(auth(token)).expect(200);
    expect(JSON.stringify(list.body)).not.toContain(key);

    await request(app).get('/v1/events').set('X-API-Key', key).expect(200);
    await request(app).get('/v1/sources').set('X-API-Key', key).expect(403); // out of scope
    await request(app).post('/v1/api-keys').set('X-API-Key', key).send({ name: 'x', scopes: ['events:read'] }).expect(403);

    await request(app).delete(`/v1/api-keys/${created.body.id}`).set(auth(token)).expect(204);
    await request(app).get('/v1/events').set('X-API-Key', key).expect(401);
  });

  it('rejects scopes an API key may never hold', async () => {
    const { token } = await register();
    await request(app).post('/v1/api-keys').set(auth(token)).send({ name: 'x', scopes: ['members:write'] }).expect(422);
  });
});

describe('GitHub OAuth', () => {
  it('redirects with state and PKCE challenge', async () => {
    const res = await request(app).get('/v1/auth/github').expect(302);
    const url = new URL(res.headers.location!);
    expect(url.hostname).toBe('github.com');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBeTruthy();
  });

  it('rejects a callback with a mismatched state', async () => {
    const start = await request(app).get('/v1/auth/github');
    const cookies = start.headers['set-cookie'] as unknown as string[];
    await request(app).get('/v1/auth/github/callback?code=abc&state=forged').set('Cookie', cookieHeader(cookies)).expect(400);
  });

  it('completes sign-in and creates a workspace for a new user', async () => {
    setAuthFetch((async (input: string | URL | Request) => {
      const url = String(input);
      const body = url.includes('access_token')
        ? { access_token: 'gho_test' }
        : url.endsWith('/user')
          ? { id: 42, login: 'octo', name: 'Octo Cat' }
          : [{ email: 'Octo@GitHub.test', primary: true, verified: true }];
      return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    }) as typeof fetch);

    const start = await request(app).get('/v1/auth/github');
    const state = new URL(start.headers.location!).searchParams.get('state')!;
    const cookies = start.headers['set-cookie'] as unknown as string[];
    const cb = await request(app)
      .get(`/v1/auth/github/callback?code=abc&state=${state}`)
      .set('Cookie', cookieHeader(cookies))
      .expect(302);
    expect(cb.headers.location).toMatch(/\/auth\/callback$/);

    const refresh = await request(app)
      .post('/v1/auth/refresh')
      .set('Cookie', cookieHeader(cb.headers['set-cookie'] as unknown as string[]))
      .expect(200);
    expect(refresh.body.user).toMatchObject({ email: 'octo@github.test', role: 'owner' });
  });
});
