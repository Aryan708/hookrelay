'use client';

// Thin API client. The access token lives only in memory (never localStorage) so
// an XSS bug can't read a long-lived credential; the refresh token is an httpOnly cookie.

let accessToken: string | null = null;
let refreshing: Promise<boolean> | null = null;

export const setAccessToken = (t: string | null) => {
  accessToken = t;
};

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: { path: string; message: string }[],
  ) {
    super(message);
  }
}

export interface Session {
  accessToken: string;
  user: User;
}
export type Role = 'owner' | 'admin' | 'developer' | 'viewer';
export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
  workspaceId: string;
}

export async function refreshSession(): Promise<Session | null> {
  const res = await fetch('/api/v1/auth/refresh', { method: 'POST', credentials: 'same-origin' });
  if (!res.ok) return null;
  const session = (await res.json()) as Session;
  accessToken = session.accessToken;
  return session;
}

async function tryRefreshOnce(): Promise<boolean> {
  refreshing ??= refreshSession()
    .then((s) => Boolean(s))
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

export async function api<T = unknown>(path: string, init: RequestInit & { json?: unknown } = {}, retry = true): Promise<T> {
  const headers = new Headers(init.headers);
  if (accessToken) headers.set('authorization', `Bearer ${accessToken}`);
  if (init.json !== undefined) headers.set('content-type', 'application/json');

  const res = await fetch(`/api${path}`, {
    ...init,
    headers,
    body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
    credentials: 'same-origin',
  });

  if (res.status === 401 && retry && !path.startsWith('/v1/auth/')) {
    if (await tryRefreshOnce()) return api<T>(path, init, false);
  }
  if (res.status === 204) return undefined as T;

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = body?.error ?? {};
    throw new ApiError(res.status, err.code ?? 'error', err.message ?? `Request failed (${res.status})`, err.details);
  }
  return body as T;
}
