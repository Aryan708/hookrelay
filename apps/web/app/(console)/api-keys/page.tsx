'use client';

import { useState } from 'react';
import { Button, Empty, ErrorNote, Field, Input, Loading, OneTimeSecret, PageHeader, Panel, Table, Td } from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { timeAgo } from '@/lib/format';
import { useApi } from '@/lib/useApi';

interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

const SCOPES: [string, string][] = [
  ['events:write', 'Publish events'],
  ['events:read', 'Read events and deliveries'],
  ['events:replay', 'Replay failed deliveries'],
  ['sources:read', 'List sources'],
  ['routes:read', 'List routes'],
];

export default function ApiKeysPage() {
  const { can } = useAuth();
  const { data, error, loading, reload } = useApi<{ data: ApiKey[] }>('/v1/api-keys');
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<{ title: string; value: string } | null>(null);
  const [formError, setFormError] = useState<ApiError | null>(null);

  async function create(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const expires = Number(f.get('expiresInDays'));
    try {
      const k = await api<ApiKey & { key: string }>('/v1/api-keys', {
        method: 'POST',
        json: { name: f.get('name'), scopes: f.getAll('scopes'), expiresInDays: expires || undefined },
      });
      setSecret({ title: `API key "${k.name}"`, value: k.key });
      setCreating(false);
      setFormError(null);
      await reload();
    } catch (err) {
      setFormError(err as ApiError);
    }
  }

  async function revoke(k: ApiKey) {
    if (!confirm(`Revoke ${k.name}? Anything using it will start getting 401 errors immediately.`)) return;
    await api(`/v1/api-keys/${k.id}`, { method: 'DELETE' });
    await reload();
  }

  const status = (k: ApiKey) =>
    k.revoked_at ? <span className="text-ink-faint">Revoked</span> : k.expires_at && new Date(k.expires_at) < new Date() ? <span className="text-dead">Expired</span> : <span className="text-ok">Active</span>;

  return (
    <>
      <PageHeader
        title="API keys"
        description="For scripts, CI jobs and n8n HTTP Request nodes. Give each key only the scopes it needs."
        action={can('apikeys:write') && !creating && <Button onClick={() => setCreating(true)}>New API key</Button>}
      />

      {secret && <OneTimeSecret title={secret.title} value={secret.value} onDone={() => setSecret(null)} />}

      {creating && (
        <Panel title="New API key" className="mb-6">
          <form onSubmit={create} className="space-y-4">
            <ErrorNote error={formError} />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Name"><Input name="name" required placeholder="n8n daily digest" autoFocus /></Field>
              <Field label="Expires after (days)" hint="Leave empty for no expiry. Shorter-lived keys are safer.">
                <Input name="expiresInDays" type="number" min={1} max={365} defaultValue={90} />
              </Field>
            </div>
            <fieldset>
              <legend className="mb-2 text-sm font-medium">Scopes</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {SCOPES.map(([value, label]) => (
                  <label key={value} className="flex items-center gap-2.5 text-sm">
                    <input type="checkbox" name="scopes" value={value} defaultChecked={value === 'events:read'} className="h-4 w-4 accent-[var(--color-wire)]" />
                    <span>{label}</span>
                    <code className="font-mono text-xs text-ink-faint">{value}</code>
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="flex gap-2">
              <Button type="submit">Create key</Button>
              <Button type="button" variant="quiet" onClick={() => setCreating(false)}>Cancel</Button>
            </div>
          </form>
        </Panel>
      )}

      <ErrorNote error={error} />
      {loading && !data ? (
        <Loading />
      ) : data?.data.length === 0 ? (
        <Empty title="No API keys" body="Create a key to publish events or read delivery status from automation tools." />
      ) : (
        <Table head={['Key', 'Scopes', 'Last used', 'Expires', 'Status', '']}>
          {data?.data.map((k) => (
            <tr key={k.id}>
              <Td>
                <p className="font-medium">{k.name}</p>
                <code className="font-mono text-xs text-ink-soft">{k.prefix}_…</code>
              </Td>
              <Td>
                <span className="flex flex-wrap gap-1">
                  {k.scopes.map((s) => (
                    <code key={s} className="rounded bg-skip-bg px-1.5 py-0.5 font-mono text-xs">{s}</code>
                  ))}
                </span>
              </Td>
              <Td className="text-ink-soft">{k.last_used_at ? timeAgo(k.last_used_at) : 'Never'}</Td>
              <Td className="text-ink-soft">{k.expires_at ? timeAgo(k.expires_at) : 'Never'}</Td>
              <Td>{status(k)}</Td>
              <Td className="text-right">
                {can('apikeys:write') && !k.revoked_at && (
                  <button className="text-sm text-dead hover:underline" onClick={() => void revoke(k)}>Revoke</button>
                )}
              </Td>
            </tr>
          ))}
        </Table>
      )}
    </>
  );
}
