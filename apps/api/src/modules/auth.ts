import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { CookieOptions, Request, Response } from 'express';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { env } from '../config/env';
import { type Queryable, one, pool, withTransaction } from '../db/pool';
import { randomToken, safeEqual, sha256 } from '../lib/crypto';
import { HttpError, unauthorized } from '../lib/errors';
import { ROLE_PERMISSIONS, type Role } from '../lib/rbac';
import { audit } from '../middleware/audit';
import { authenticate, requireUser, signAccessToken } from '../middleware/auth';
import { parse } from '../middleware/http';

export const REFRESH_COOKIE = 'hr_refresh';
const OAUTH_STATE_COOKIE = 'hr_oauth_state';
const BCRYPT_ROUNDS = 12;
// Pre-computed hash used when the email is unknown, so login timing doesn't reveal which emails exist.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password-for-timing', BCRYPT_ROUNDS);

interface UserRow {
  id: string;
  workspace_id: string;
  email: string;
  name: string;
  role: Role;
  password_hash: string | null;
  disabled_at: Date | null;
}

const cookieBase: CookieOptions = {
  httpOnly: true,
  secure: env.NODE_ENV === 'production',
  sameSite: 'lax',
  path: '/',
};

const password = z
  .string()
  .min(12, 'Password must be at least 12 characters')
  .max(128)
  .refine((p) => /[a-z]/.test(p) && /[A-Z]/.test(p) && /\d/.test(p), 'Password needs upper, lower case and a digit');

const registerSchema = z.object({
  workspaceName: z.string().trim().min(2).max(80),
  name: z.string().trim().min(1).max(80),
  email: z.email().max(254).transform((e) => e.toLowerCase()),
  password,
});

const loginSchema = z.object({
  email: z.email().transform((e) => e.toLowerCase()),
  password: z.string().min(1).max(128),
});

export const hashPassword = (plain: string) => bcrypt.hash(plain, BCRYPT_ROUNDS);
export const passwordSchema = password;

// ---------- refresh tokens (rotating, reuse-detecting) ----------

async function issueRefreshToken(userId: string, familyId: string = crypto.randomUUID(), db: Queryable = pool) {
  const token = randomToken(48);
  const expiresAt = new Date(Date.now() + env.REFRESH_TTL_DAYS * 24 * 3600 * 1000);
  await db.query('INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at) VALUES ($1, $2, $3, $4)', [
    userId,
    familyId,
    sha256(token),
    expiresAt,
  ]);
  return { token, expiresAt };
}

function setRefreshCookie(res: Response, token: string, expiresAt: Date) {
  res.cookie(REFRESH_COOKIE, token, { ...cookieBase, expires: expiresAt });
}

type IssuedRefresh = { token: string; expiresAt: Date };

/** Sends the session only after any surrounding transaction has committed. */
function sendSession(res: Response, user: UserRow, refresh: IssuedRefresh, status = 200) {
  setRefreshCookie(res, refresh.token, refresh.expiresAt);
  res.status(status).json({
    accessToken: signAccessToken(user),
    expiresIn: env.JWT_ACCESS_TTL_SECONDS,
    user: publicUser(user),
  });
}

export function publicUser(u: Pick<UserRow, 'id' | 'email' | 'name' | 'role' | 'workspace_id'>) {
  return { id: u.id, email: u.email, name: u.name, role: u.role, workspaceId: u.workspace_id };
}

// ---------- router ----------

export const authRouter = Router();

const credentialLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: env.NODE_ENV === 'test' ? 1000 : 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: { code: 'rate_limited', message: 'Too many attempts, try again later' } },
});

authRouter.post('/register', credentialLimiter, async (req, res) => {
  const body = parse(registerSchema, req.body);
  const hash = await hashPassword(body.password);

  const { user, refresh } = await withTransaction(async (tx) => {
    const exists = await one('SELECT 1 FROM users WHERE email = $1', [body.email], tx);
    if (exists) throw new HttpError(409, 'email_taken', 'An account with this email already exists');
    const ws = await one<{ id: string }>('INSERT INTO workspaces (name) VALUES ($1) RETURNING id', [body.workspaceName], tx);
    const user = (await one<UserRow>(
      `INSERT INTO users (workspace_id, email, name, password_hash, role, last_login_at)
       VALUES ($1, $2, $3, $4, 'owner', now()) RETURNING *`,
      [ws!.id, body.email, body.name, hash],
      tx,
    ))!;
    await audit(
      req,
      {
        action: 'auth.register',
        workspaceId: user.workspace_id,
        actor: { type: 'user', id: user.id },
        resourceType: 'workspace',
        resourceId: ws!.id,
      },
      tx,
    );
    return { user, refresh: await issueRefreshToken(user.id, undefined, tx) };
  });
  sendSession(res, user, refresh, 201);
});

authRouter.post('/login', credentialLimiter, async (req, res) => {
  const body = parse(loginSchema, req.body);
  const user = await one<UserRow>('SELECT * FROM users WHERE email = $1', [body.email]);
  const valid = await bcrypt.compare(body.password, user?.password_hash ?? DUMMY_HASH);

  if (!user || !valid || !user.password_hash || user.disabled_at) {
    await audit(req, {
      action: 'auth.login_failed',
      workspaceId: user?.workspace_id,
      metadata: { email: body.email },
    });
    throw unauthorized('Invalid email or password');
  }

  await pool.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
  await audit(req, { action: 'auth.login', workspaceId: user.workspace_id, actor: { type: 'user', id: user.id } });
  sendSession(res, user, await issueRefreshToken(user.id));
});

authRouter.post('/refresh', async (req, res) => {
  const token = req.cookies?.[REFRESH_COOKIE] as string | undefined;
  if (!token) throw unauthorized('No refresh token');

  const outcome = await withTransaction(async (tx) => {
    const row = await one<{ id: string; user_id: string; family_id: string; revoked_at: Date | null; expires_at: Date }>(
      'SELECT id, user_id, family_id, revoked_at, expires_at FROM refresh_tokens WHERE token_hash = $1 FOR UPDATE',
      [sha256(token)],
      tx,
    );
    if (!row) throw unauthorized('Invalid refresh token');

    if (row.revoked_at) {
      // A rotated token was presented again: likely theft. Revoke the whole family.
      await tx.query('UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL', [
        row.family_id,
      ]);
      await audit(req, { action: 'auth.refresh_token_reuse', actor: { type: 'user', id: row.user_id } }, tx);
      return { reuse: true as const }; // commit the revocation, then respond 401
    }
    if (row.expires_at < new Date()) throw unauthorized('Refresh token expired');

    const user = await one<UserRow>('SELECT * FROM users WHERE id = $1', [row.user_id], tx);
    if (!user || user.disabled_at) throw unauthorized('Account is not active');

    await tx.query('UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1', [row.id]);
    return { reuse: false as const, user, refresh: await issueRefreshToken(user.id, row.family_id, tx) };
  });

  if (outcome.reuse) {
    res.clearCookie(REFRESH_COOKIE, cookieBase);
    res.status(401).json({ error: { code: 'token_reuse', message: 'Session revoked, please sign in again' } });
    return;
  }
  sendSession(res, outcome.user, outcome.refresh);
});

authRouter.post('/logout', async (req, res) => {
  const token = req.cookies?.[REFRESH_COOKIE] as string | undefined;
  if (token) {
    const row = await one<{ family_id: string; user_id: string }>(
      'SELECT family_id, user_id FROM refresh_tokens WHERE token_hash = $1',
      [sha256(token)],
    );
    if (row) {
      await pool.query('UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL', [
        row.family_id,
      ]);
      await audit(req, { action: 'auth.logout', actor: { type: 'user', id: row.user_id } });
    }
  }
  res.clearCookie(REFRESH_COOKIE, cookieBase);
  res.status(204).end();
});

authRouter.get('/me', authenticate, async (req, res) => {
  const p = requireUser(req);
  const row = await one<UserRow & { workspace_name: string }>(
    `SELECT u.*, w.name AS workspace_name FROM users u JOIN workspaces w ON w.id = u.workspace_id WHERE u.id = $1`,
    [p.id],
  );
  res.json({
    user: publicUser(row!),
    workspace: { id: row!.workspace_id, name: row!.workspace_name },
    permissions: [...ROLE_PERMISSIONS[row!.role]],
  });
});

// ---------- GitHub OAuth 2.0 (authorization code flow + state + PKCE) ----------

const githubEnabled = () => Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET);
const githubCallbackUrl = () => `${env.API_PUBLIC_URL}/v1/auth/github/callback`;

authRouter.get('/providers', (_req, res) => {
  res.json({ github: githubEnabled() });
});

authRouter.get('/github', (_req: Request, res: Response) => {
  if (!githubEnabled()) throw new HttpError(501, 'oauth_disabled', 'GitHub sign-in is not configured');
  const state = randomToken(24);
  const verifier = randomToken(48);
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  // state + PKCE verifier live in a short-lived httpOnly cookie bound to this browser.
  res.cookie(OAUTH_STATE_COOKIE, `${state}.${verifier}`, { ...cookieBase, maxAge: 10 * 60 * 1000 });

  const url = new URL('https://github.com/login/oauth/authorize');
  url.searchParams.set('client_id', env.GITHUB_CLIENT_ID!);
  url.searchParams.set('redirect_uri', githubCallbackUrl());
  url.searchParams.set('scope', 'read:user user:email');
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('allow_signup', 'false');
  res.redirect(url.toString());
});

export type FetchLike = typeof fetch;
let httpFetch: FetchLike = (...args) => fetch(...args);
/** Test hook to stub GitHub's endpoints. */
export const setAuthFetch = (f: FetchLike) => {
  httpFetch = f;
};

authRouter.get('/github/callback', async (req, res) => {
  if (!githubEnabled()) throw new HttpError(501, 'oauth_disabled', 'GitHub sign-in is not configured');
  const { code, state } = parse(z.object({ code: z.string().min(1), state: z.string().min(1) }), req.query);
  const stored = (req.cookies?.[OAUTH_STATE_COOKIE] as string | undefined) ?? '';
  res.clearCookie(OAUTH_STATE_COOKIE, cookieBase);
  const [expectedState, verifier] = stored.split('.');
  if (!expectedState || !verifier || !safeEqual(state, expectedState)) {
    await audit(req, { action: 'auth.oauth_state_mismatch', metadata: { provider: 'github' } });
    throw new HttpError(400, 'invalid_state', 'OAuth state mismatch');
  }

  const tokenRes = await httpFetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: githubCallbackUrl(),
      code_verifier: verifier,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const tokenJson = (await tokenRes.json()) as { access_token?: string; error?: string };
  if (!tokenJson.access_token) throw new HttpError(502, 'oauth_exchange_failed', 'GitHub token exchange failed');

  const gh = { authorization: `Bearer ${tokenJson.access_token}`, accept: 'application/vnd.github+json' };
  const profile = (await (await httpFetch('https://api.github.com/user', { headers: gh })).json()) as {
    id: number;
    login: string;
    name: string | null;
  };
  const emails = (await (await httpFetch('https://api.github.com/user/emails', { headers: gh })).json()) as {
    email: string;
    primary: boolean;
    verified: boolean;
  }[];
  const primary = emails.find((e) => e.primary && e.verified);
  if (!primary) throw new HttpError(400, 'no_verified_email', 'Your GitHub account has no verified primary email');
  const email = primary.email.toLowerCase();

  const refresh = await withTransaction(async (tx) => {
    let u = await one<UserRow>('SELECT * FROM users WHERE github_id = $1', [String(profile.id)], tx);
    if (!u) {
      // Link to an existing account only via a verified email.
      u = await one<UserRow>('UPDATE users SET github_id = $1 WHERE email = $2 RETURNING *', [String(profile.id), email], tx);
    }
    if (!u) {
      const ws = await one<{ id: string }>(
        'INSERT INTO workspaces (name) VALUES ($1) RETURNING id',
        [`${profile.login}'s workspace`],
        tx,
      );
      u = await one<UserRow>(
        `INSERT INTO users (workspace_id, email, name, role, github_id) VALUES ($1, $2, $3, 'owner', $4) RETURNING *`,
        [ws!.id, email, profile.name ?? profile.login, String(profile.id)],
        tx,
      );
    }
    if (u!.disabled_at) throw unauthorized('Account is not active');
    await tx.query('UPDATE users SET last_login_at = now() WHERE id = $1', [u!.id]);
    await audit(
      req,
      { action: 'auth.login', workspaceId: u!.workspace_id, actor: { type: 'user', id: u!.id }, metadata: { provider: 'github' } },
      tx,
    );
    return issueRefreshToken(u!.id, undefined, tx);
  });

  // The web app exchanges the refresh cookie for an access token on load.
  setRefreshCookie(res, refresh.token, refresh.expiresAt);
  res.redirect(`${env.WEB_URL}/auth/callback`);
});
