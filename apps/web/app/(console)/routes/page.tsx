'use client';

import { useState } from 'react';
import { Button, Empty, ErrorNote, Field, Input, inputClass, Loading, PageHeader, Panel, Select, Table, Td } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useApi } from '@/lib/useApi';

type Op = 'eq' | 'neq' | 'contains' | 'gt' | 'gte' | 'lt' | 'lte' | 'exists' | 'in';
interface Condition {
  path: string;
  op: Op;
  value?: unknown;
}
interface Route {
  id: string;
  name: string;
  enabled: boolean;
  filter: Condition[];
  mapping: Record<string, unknown> | null;
  source_name: string;
  destination_name: string;
}

const OPS: [Op, string][] = [
  ['eq', 'equals'],
  ['neq', 'does not equal'],
  ['contains', 'contains'],
  ['gt', 'is greater than'],
  ['gte', 'is at least'],
  ['lt', 'is less than'],
  ['lte', 'is at most'],
  ['in', 'is one of (comma separated)'],
  ['exists', 'is present'],
];
const opLabel = (op: Op) => OPS.find(([o]) => o === op)?.[1] ?? op;

const EXAMPLE_MAPPING = `{
  "email": "data.customer.email",
  "amount": "data.amount",
  "source": { "const": "stripe" },
  "summary": { "template": "{{data.customer.name}} paid {{data.amount}}" }
}`;

function parseValue(op: Op, raw: string): unknown {
  if (op === 'exists') return undefined;
  if (op === 'in') return raw.split(',').map((v) => v.trim()).filter(Boolean);
  if (['gt', 'gte', 'lt', 'lte'].includes(op)) return Number(raw);
  if (raw === 'true' || raw === 'false') return raw === 'true';
  return raw;
}

export default function RoutesPage() {
  const { can } = useAuth();
  const routes = useApi<{ data: Route[] }>('/v1/routes');
  const sources = useApi<{ data: { id: string; name: string }[] }>('/v1/sources');
  const destinations = useApi<{ data: { id: string; name: string }[] }>('/v1/destinations');
  const [creating, setCreating] = useState(false);
  const [conditions, setConditions] = useState<{ path: string; op: Op; raw: string }[]>([]);
  const [formError, setFormError] = useState<ApiError | null>(null);

  const canCreate = (sources.data?.data.length ?? 0) > 0 && (destinations.data?.data.length ?? 0) > 0;

  async function create(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    let mapping: unknown = null;
    const rawMapping = String(f.get('mapping') ?? '').trim();
    if (rawMapping) {
      try {
        mapping = JSON.parse(rawMapping);
      } catch {
        setFormError(new ApiError(0, 'invalid_json', 'Field mapping must be valid JSON'));
        return;
      }
    }
    try {
      await api('/v1/routes', {
        method: 'POST',
        json: {
          name: f.get('name'),
          sourceId: f.get('sourceId'),
          destinationId: f.get('destinationId'),
          filter: conditions.filter((c) => c.path).map((c) => ({ path: c.path, op: c.op, value: parseValue(c.op, c.raw) })),
          mapping,
        },
      });
      setCreating(false);
      setConditions([]);
      setFormError(null);
      await routes.reload();
    } catch (err) {
      setFormError(err as ApiError);
    }
  }

  async function toggle(r: Route) {
    await api(`/v1/routes/${r.id}`, { method: 'PATCH', json: { enabled: !r.enabled } });
    await routes.reload();
  }

  async function remove(r: Route) {
    if (!confirm(`Delete route ${r.name}?`)) return;
    await api(`/v1/routes/${r.id}`, { method: 'DELETE' });
    await routes.reload();
  }

  return (
    <>
      <PageHeader
        title="Routes"
        description="A route sends events from a source to a destination, optionally filtered and reshaped on the way."
        action={can('routes:write') && !creating && canCreate && <Button onClick={() => setCreating(true)}>New route</Button>}
      />

      {creating && (
        <Panel title="New route" className="mb-6">
          <form onSubmit={create} className="space-y-5">
            <ErrorNote error={formError} />
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Name"><Input name="name" required placeholder="Paid invoices to CRM" autoFocus /></Field>
              <Field label="From source">
                <Select name="sourceId" required>
                  {sources.data?.data.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </Select>
              </Field>
              <Field label="To destination">
                <Select name="destinationId" required>
                  {destinations.data?.data.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                </Select>
              </Field>
            </div>

            <fieldset>
              <legend className="mb-1 text-sm font-medium">Only deliver when</legend>
              <p className="mb-3 text-xs text-ink-faint">
                Paths read from the event envelope: <code className="font-mono">type</code>, <code className="font-mono">id</code>, and the original payload under <code className="font-mono">data</code>. All conditions must match.
              </p>
              <div className="space-y-2">
                {conditions.map((c, i) => (
                  <div key={i} className="flex flex-wrap items-center gap-2">
                    <Input
                      aria-label="Field path"
                      className="w-56 font-mono"
                      placeholder="data.amount"
                      value={c.path}
                      onChange={(e) => setConditions((cs) => cs.map((x, j) => (j === i ? { ...x, path: e.target.value } : x)))}
                    />
                    <Select
                      aria-label="Operator"
                      className="w-auto"
                      value={c.op}
                      onChange={(e) => setConditions((cs) => cs.map((x, j) => (j === i ? { ...x, op: e.target.value as Op } : x)))}
                    >
                      {OPS.map(([o, l]) => <option key={o} value={o}>{l}</option>)}
                    </Select>
                    {c.op !== 'exists' && (
                      <Input
                        aria-label="Value"
                        className="w-48"
                        value={c.raw}
                        onChange={(e) => setConditions((cs) => cs.map((x, j) => (j === i ? { ...x, raw: e.target.value } : x)))}
                      />
                    )}
                    <button type="button" className="text-sm text-dead hover:underline" onClick={() => setConditions((cs) => cs.filter((_, j) => j !== i))}>
                      Remove
                    </button>
                  </div>
                ))}
              </div>
              <button
                type="button"
                className="mt-2 text-sm font-medium text-wire hover:underline"
                onClick={() => setConditions((cs) => [...cs, { path: '', op: 'eq', raw: '' }])}
              >
                Add condition
              </button>
            </fieldset>

            <Field label="Field mapping" hint="Optional. Leave empty to forward the full envelope. Values are source paths, constants or templates.">
              <textarea name="mapping" rows={7} className={`${inputClass} h-auto w-full py-2 font-mono`} placeholder={EXAMPLE_MAPPING} />
            </Field>

            <div className="flex gap-2">
              <Button type="submit">Create route</Button>
              <Button type="button" variant="quiet" onClick={() => setCreating(false)}>Cancel</Button>
            </div>
          </form>
        </Panel>
      )}

      <ErrorNote error={routes.error} />
      {routes.loading && !routes.data ? (
        <Loading />
      ) : routes.data?.data.length === 0 ? (
        <Empty
          title="No routes yet"
          body={canCreate ? 'Connect a source to a destination to start delivering events.' : 'Create at least one source and one destination first, then connect them here.'}
        />
      ) : (
        <Table head={['Route', 'Filter', 'Mapping', 'Status', '']}>
          {routes.data?.data.map((r) => (
            <tr key={r.id} className={r.enabled ? '' : 'text-ink-faint'}>
              <Td>
                <p className="font-medium">{r.name}</p>
                <p className="text-ink-soft">
                  {r.source_name} to {r.destination_name}
                </p>
              </Td>
              <Td>
                {r.filter.length === 0 ? (
                  <span className="text-ink-faint">Every event</span>
                ) : (
                  <ul className="space-y-0.5">
                    {r.filter.map((c, i) => (
                      <li key={i}>
                        <code className="font-mono text-xs">{c.path}</code> {opLabel(c.op)}{' '}
                        {c.op !== 'exists' && <code className="font-mono text-xs">{JSON.stringify(c.value)}</code>}
                      </li>
                    ))}
                  </ul>
                )}
              </Td>
              <Td className="text-ink-soft">{r.mapping ? `${Object.keys(r.mapping).length} fields` : 'Full envelope'}</Td>
              <Td>{r.enabled ? <span className="text-ok">Active</span> : 'Paused'}</Td>
              <Td className="whitespace-nowrap text-right">
                {can('routes:write') && (
                  <span className="flex justify-end gap-4 text-sm">
                    <button className="text-wire hover:underline" onClick={() => void toggle(r)}>{r.enabled ? 'Pause' : 'Resume'}</button>
                    <button className="text-dead hover:underline" onClick={() => void remove(r)}>Delete</button>
                  </span>
                )}
              </Td>
            </tr>
          ))}
        </Table>
      )}
    </>
  );
}
