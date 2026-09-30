'use client';

import { usePathname, useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, refreshSession, setAccessToken, type Session, type User } from './api';

interface AuthState {
  user: User | null;
  workspace: { id: string; name: string } | null;
  permissions: Set<string>;
  loading: boolean;
  can: (permission: string) => boolean;
  signIn: (session: Session) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);
const PUBLIC_ROUTES = ['/login', '/register', '/auth/callback'];

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [workspace, setWorkspace] = useState<AuthState['workspace']>(null);
  const [permissions, setPermissions] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const router = useRouter();
  const pathname = usePathname();

  const loadMe = useCallback(async () => {
    const me = await api<{ user: User; workspace: { id: string; name: string }; permissions: string[] }>('/v1/auth/me');
    setUser(me.user);
    setWorkspace(me.workspace);
    setPermissions(new Set(me.permissions));
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const session = await refreshSession().catch(() => null);
      if (cancelled) return;
      if (session) await loadMe().catch(() => undefined);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [loadMe]);

  useEffect(() => {
    if (loading) return;
    const isPublic = PUBLIC_ROUTES.some((r) => pathname.startsWith(r));
    if (!user && !isPublic) router.replace(`/login?next=${encodeURIComponent(pathname)}`);
  }, [loading, user, pathname, router]);

  const value = useMemo<AuthState>(
    () => ({
      user,
      workspace,
      permissions,
      loading,
      can: (p) => permissions.has(p),
      signIn: async (session) => {
        setAccessToken(session.accessToken);
        await loadMe();
      },
      signOut: async () => {
        await api('/v1/auth/logout', { method: 'POST' }).catch(() => undefined);
        setAccessToken(null);
        setUser(null);
        setPermissions(new Set());
        router.replace('/login');
      },
    }),
    [user, workspace, permissions, loading, loadMe, router],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
