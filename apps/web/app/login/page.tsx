'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { AuthFrame } from '@/components/AuthFrame';
import { Button, ErrorNote, Field, Input } from '@/components/ui';
import { api, ApiError, type Session } from '@/lib/api';
import { useAuth } from '@/lib/auth';

function safeNext(value: string | null): string {
  // Only allow same-site relative paths (open-redirect guard).
  return value && value.startsWith('/') && !value.startsWith('//') ? value : '/';
}

function LoginForm() {
  const { signIn, user } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const next = safeNext(params.get('next'));
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [github, setGithub] = useState(false);

  useEffect(() => {
    if (user) router.replace(next);
  }, [user, next, router]);

  useEffect(() => {
    api<{ github: boolean }>('/v1/auth/providers').then((p) => setGithub(p.github)).catch(() => undefined);
  }, []);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const session = await api<Session>('/v1/auth/login', {
        method: 'POST',
        json: { email: form.get('email'), password: form.get('password') },
      });
      await signIn(session);
      router.replace(next);
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthFrame
      title="Sign in"
      subtitle="Pick up where your integrations left off."
      footer={
        <>
          New here? <Link className="font-medium text-wire hover:underline" href="/register">Create a workspace</Link>
        </>
      }
    >
      <form onSubmit={onSubmit} className="space-y-4">
        <ErrorNote error={error} />
        <Field label="Work email">
          <Input name="email" type="email" autoComplete="email" required />
        </Field>
        <Field label="Password">
          <Input name="password" type="password" autoComplete="current-password" required />
        </Field>
        <Button type="submit" disabled={busy} className="w-full justify-center">
          {busy ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
      {github && (
        <>
          <div className="my-5 flex items-center gap-3 text-xs text-ink-faint">
            <span className="h-px flex-1 bg-line" />or<span className="h-px flex-1 bg-line" />
          </div>
          <a
            href="/api/v1/auth/github"
            className="flex h-9 w-full items-center justify-center rounded-md border border-line bg-panel text-sm font-medium hover:border-ink-faint"
          >
            Continue with GitHub
          </a>
        </>
      )}
    </AuthFrame>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
