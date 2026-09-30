'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Button, CopyButton, Empty, ErrorNote, Field, Input, Loading, OneTimeSecret, PageHeader, Panel, Table, Td } from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { timeAgo } from '@/lib/format';
import { useApi } from '@/lib/useApi';

interface Source {
  id: string;
  name: string;
  description: string | null;
  ingestUrl: string;
  events_24h: number;
  created_at: string;
}

export default function SourcesPage() {
  const { can } = useAuth();
  const { data, error, loading, reload } = useApi<{ data: Source[] }>('/v1/sources');
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<{ title: string; value: string } | null>(null);
  const [formError, setFormError] = useState<ApiError | null>(null);

  async function create(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try {
      const s = await api<Source & { signingSecret: string }>('/v1/sources', {
        method: 'POST',
        json: { name: f.get('name'), description: f.get('description') || undefined },
      });
      setSecret({ title: `Signing secret for ${s.name}`, value: s.signingSecret });
      setCreating(false);
      setFormError(null);
      await reload();
    } catch (err) {
      setFormError(err as ApiError);
    }
  }

  async function rotate(s: Source) {
    if (!confirm(`Rotate the signing secret for ${s.name}? Senders using the old secret will be rejected.`)) return;
    const r = await api<{ signingSecret: string }>(`/v1/sources/${s.id}/rotate-secret`, { method: 'POST' });
    setSecret({ title: `New signing secret for ${s.name}`, value: r.signingSecret });
  }

  async function remove(s: Source) {
    if (!confirm(`Delete ${s.name}? Its events, routes and delivery history will be deleted too.`)) return;
    await api(`/v1/sources/${s.id}`, { method: 'DELETE' });
    await reload();
  }

  return (
    <>
      <PageHeader
        title="Sources"
        description="Each source is a webhook URL that only accepts requests signed with its secret."
        action={can('sources:write') && !creating && <Button onClick={() => setCreating(true)}>New source</Button>}
      />

      {secret && <OneTimeSecret title={secret.title} value={secret.value} onDone={() => setSecret(null)} />}

      {creating && (
        <Panel title="New source" className="mb-6">
          <form onSubmit={create} className="grid gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2"><ErrorNote error={formError} /></div>
            <Field label="Name"><Input name="name" required placeholder="Stripe (live)" autoFocus /></Field>
            <Field label="Description" hint="Optional. Who sends to this URL and why."><Input name="description" /></Field>
            <div className="flex gap-2 sm:col-span-2">
              <Button type="submit">Create source</Button>
              <Button type="button" variant="quiet" onClick={() => setCreating(false)}>Cancel</Button>
            </div>
          </form>
        </Panel>
      )}

      <ErrorNote error={error} />
      {loading && !data ? (
        <Loading />
      ) : data?.data.length === 0 ? (
        <Empty title="No sources yet" body="Create one to get a signed webhook URL you can paste into Stripe, Typeform, HubSpot or your own app." />
      ) : (
        <Table head={['Source', 'Webhook URL', 'Events (24h)', 'Created', '']}>
          {data?.data.map((s) => (
            <tr key={s.id}>
              <Td>
                <p className="font-medium">{s.name}</p>
                {s.description && <p className="text-ink-soft">{s.description}</p>}
              </Td>
              <Td>
                <div className="flex max-w-xs items-center gap-2">
                  <code className="truncate font-mono text-xs text-ink-soft">{s.ingestUrl}</code>
                  <CopyButton value={s.ingestUrl} />
                </div>
              </Td>
              <Td>
                <Link href={`/events?sourceId=${s.id}`} className="tabular-nums text-wire hover:underline">{s.events_24h}</Link>
              </Td>
              <Td className="text-ink-soft">{timeAgo(s.created_at)}</Td>
              <Td className="whitespace-nowrap text-right">
                {can('sources:write') && (
                  <span className="flex justify-end gap-4 text-sm">
                    <button className="text-wire hover:underline" onClick={() => void rotate(s)}>Rotate secret</button>
                    <button className="text-dead hover:underline" onClick={() => void remove(s)}>Delete</button>
                  </span>
                )}
              </Td>
            </tr>
          ))}
        </Table>
      )}

      <Panel title="Sending a signed webhook" className="mt-8">
        <p className="mb-3 max-w-2xl text-sm leading-relaxed text-ink-soft">
          Sign <Code>{'{timestamp}.{raw body}'}</Code> with HMAC-SHA256 using the source secret and send it as{' '}
          <Code>X-HookRelay-Signature: t=…,v1=…</Code>. Requests older than 5 minutes are rejected. Add an{' '}
          <Code>Idempotency-Key</Code> header so retries from the sender are only processed once.
        </p>
        <pre className="overflow-x-auto rounded-md bg-ink p-4 font-mono text-[0.8125rem] leading-relaxed text-white/90">{`BODY='{"type":"payment.succeeded","amount":4900,"customer":{"email":"ada@example.com"}}'
TS=$(date +%s)
SIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$HOOKRELAY_SECRET" | cut -d' ' -f2)

curl -X POST "$SOURCE_URL" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: evt_$(uuidgen)" \\
  -H "X-HookRelay-Signature: t=$TS,v1=$SIG" \\
  -d "$BODY"`}</pre>
      </Panel>
    </>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return <code className="rounded bg-skip-bg px-1 font-mono text-[0.8125rem] text-ink">{children}</code>;
}
