'use client';

import { useState } from 'react';
import { Button, Empty, ErrorNote, Field, Input, Loading, OneTimeSecret, PageHeader, Panel, Table, Td } from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useApi } from '@/lib/useApi';

interface Destination {
  id: string;
  name: string;
  url: string;
  timeout_ms: number;
  max_attempts: number;
  succeeded_24h: number;
  failed_24h: number;
}

export default function DestinationsPage() {
  const { can } = useAuth();
  const { data, error, loading, reload } = useApi<{ data: Destination[] }>('/v1/destinations');
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<{ title: string; value: string } | null>(null);
  const [formError, setFormError] = useState<ApiError | null>(null);

  async function create(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try {
      const d = await api<Destination & { signingSecret: string }>('/v1/destinations', {
        method: 'POST',
        json: {
          name: f.get('name'),
          url: f.get('url'),
          maxAttempts: Number(f.get('maxAttempts')),
          timeoutMs: Number(f.get('timeoutSec')) * 1000,
        },
      });
      setSecret({ title: `Verification secret for ${d.name}`, value: d.signingSecret });
      setCreating(false);
      setFormError(null);
      await reload();
    } catch (err) {
      setFormError(err as ApiError);
    }
  }

  async function remove(d: Destination) {
    if (!confirm(`Delete ${d.name}? Routes pointing to it will be deleted too.`)) return;
    await api(`/v1/destinations/${d.id}`, { method: 'DELETE' });
    await reload();
  }

  return (
    <>
      <PageHeader
        title="Destinations"
        description="Where events are delivered: an n8n webhook trigger, a CRM endpoint, or any HTTPS URL."
        action={can('destinations:write') && !creating && <Button onClick={() => setCreating(true)}>New destination</Button>}
      />

      {secret && <OneTimeSecret title={secret.title} value={secret.value} onDone={() => setSecret(null)} />}

      {creating && (
        <Panel title="New destination" className="mb-6">
          <form onSubmit={create} className="grid gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2"><ErrorNote error={formError} /></div>
            <Field label="Name"><Input name="name" required placeholder="n8n: new customer workflow" autoFocus /></Field>
            <Field label="URL" hint="Must be https in production. Internal and private addresses are blocked.">
              <Input name="url" type="url" required placeholder="https://n8n.example.com/webhook/payments" />
            </Field>
            <Field label="Max attempts" hint="Failed deliveries retry with exponential backoff, then move to the dead-letter queue.">
              <Input name="maxAttempts" type="number" min={1} max={10} defaultValue={5} />
            </Field>
            <Field label="Timeout (seconds)"><Input name="timeoutSec" type="number" min={1} max={30} defaultValue={10} /></Field>
            <div className="flex gap-2 sm:col-span-2">
              <Button type="submit">Create destination</Button>
              <Button type="button" variant="quiet" onClick={() => setCreating(false)}>Cancel</Button>
            </div>
          </form>
        </Panel>
      )}

      <ErrorNote error={error} />
      {loading && !data ? (
        <Loading />
      ) : data?.data.length === 0 ? (
        <Empty title="No destinations yet" body="Add the webhook URL of an n8n workflow (Webhook trigger node) or any service that accepts JSON over HTTPS." />
      ) : (
        <Table head={['Destination', 'Retry policy', 'Last 24h', '']}>
          {data?.data.map((d) => (
            <tr key={d.id}>
              <Td>
                <p className="font-medium">{d.name}</p>
                <p className="max-w-sm truncate font-mono text-xs text-ink-soft">{d.url}</p>
              </Td>
              <Td className="text-ink-soft">
                Up to {d.max_attempts} attempts, {d.timeout_ms / 1000}s timeout
              </Td>
              <Td>
                <span className="text-ok">{d.succeeded_24h} delivered</span>
                {d.failed_24h > 0 && <span className="ml-3 text-dead">{d.failed_24h} failed</span>}
              </Td>
              <Td className="text-right">
                {can('destinations:write') && (
                  <button className="text-sm text-dead hover:underline" onClick={() => void remove(d)}>Delete</button>
                )}
              </Td>
            </tr>
          ))}
        </Table>
      )}
    </>
  );
}
