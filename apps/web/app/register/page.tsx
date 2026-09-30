'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { AuthFrame } from '@/components/AuthFrame';
import { Button, ErrorNote, Field, Input } from '@/components/ui';
import { api, ApiError, type Session } from '@/lib/api';
import { useAuth } from '@/lib/auth';

export default function RegisterPage() {
  const { signIn } = useAuth();
  const router = useRouter();
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const session = await api<Session>('/v1/auth/register', {
        method: 'POST',
        json: { workspaceName: f.get('workspaceName'), name: f.get('name'), email: f.get('email'), password: f.get('password') },
      });
      await signIn(session);
      router.replace('/sources');
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthFrame
      title="Create a workspace"
      subtitle="You'll be its owner and can invite your team after."
      footer={
        <>
          Already have an account? <Link className="font-medium text-wire hover:underline" href="/login">Sign in</Link>
        </>
      }
    >
      <form onSubmit={onSubmit} className="space-y-4">
        <ErrorNote error={error} />
        <Field label="Workspace name">
          <Input name="workspaceName" required minLength={2} placeholder="Acme Payments" />
        </Field>
        <Field label="Your name">
          <Input name="name" autoComplete="name" required />
        </Field>
        <Field label="Work email">
          <Input name="email" type="email" autoComplete="email" required />
        </Field>
        <Field label="Password" hint="At least 12 characters, with upper and lower case letters and a number.">
          <Input name="password" type="password" autoComplete="new-password" required minLength={12} />
        </Field>
        <Button type="submit" disabled={busy} className="w-full justify-center">
          {busy ? 'Creating…' : 'Create workspace'}
        </Button>
      </form>
    </AuthFrame>
  );
}
