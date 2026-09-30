'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useAuth } from '@/lib/auth';

// GitHub OAuth lands here after the API set the refresh cookie; AuthProvider exchanges it for a session.
export default function OAuthCallback() {
  const { user, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;
    router.replace(user ? '/' : '/login');
  }, [user, loading, router]);

  return <div className="grid min-h-screen place-items-center text-sm text-ink-faint">Finishing sign-in…</div>;
}
