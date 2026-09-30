'use client';

import { useEffect, useState } from 'react';
import { Button, ErrorNote, Loading, PageHeader, Select, Table, Td } from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { dateTime } from '@/lib/format';

interface AuditRow {
  id: number;
  actor_type: 'user' | 'api_key' | 'system' | 'anonymous';
  actor_id: string | null;
  actor_email: string | null;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  metadata: Record<string, unknown>;
  ip: string | null;
  request_id: string | null;
  created_at: string;
}

const GROUPS = [
  ['', 'All activity'],
  ['auth.', 'Sign-ins and sessions'],
  ['member.', 'Member changes'],
  ['apikey.', 'API keys'],
  ['source.', 'Sources'],
  ['destination.', 'Destinations'],
  ['route.', 'Routes'],
  ['delivery.', 'Replays'],
  ['ingest.', 'Rejected webhooks'],
];

const SENSITIVE = /(failed|rejected|reuse|mismatch|revoke|rotate|disable|delete)/;

export default function AuditPage() {
  const [filter, setFilter] = useState('');
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);

  const path = (before?: number) => `/v1/audit-logs?limit=50${filter ? `&action=${filter}` : ''}${before ? `&before=${before}` : ''}`;

  useEffect(() => {
    setLoading(true);
    api<{ data: AuditRow[]; nextCursor: number | null }>(path())
      .then((r) => {
        setRows(r.data);
        setCursor(r.nextCursor);
        setError(null);
      })
      .catch(setError)
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  async function more() {
    if (!cursor) return;
    const r = await api<{ data: AuditRow[]; nextCursor: number | null }>(path(cursor));
    setRows((p) => [...p, ...r.data]);
    setCursor(r.nextCursor);
  }

  function exportCsv() {
    const header = ['time', 'actor', 'action', 'resource_type', 'resource_id', 'ip', 'request_id', 'metadata'];
    const esc = (v: unknown) => `"${String(v ?? '').replaceAll('"', '""')}"`;
    const lines = rows.map((r) =>
      [r.created_at, r.actor_email ?? `${r.actor_type}:${r.actor_id ?? ''}`, r.action, r.resource_type, r.resource_id, r.ip, r.request_id, JSON.stringify(r.metadata)]
        .map(esc)
        .join(','),
    );
    const blob = new Blob([[header.join(','), ...lines].join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `hookrelay-audit-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <>
      <PageHeader
        title="Audit log"
        description="Append-only record of who did what, from where. Entries can't be edited or deleted, including by owners."
        action={<Button variant="quiet" onClick={exportCsv} disabled={rows.length === 0}>Export CSV</Button>}
      />
      <Select aria-label="Filter activity" value={filter} onChange={(e) => setFilter(e.target.value)} className="mb-4 w-auto">
        {GROUPS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </Select>
      <ErrorNote error={error} />
      {loading ? (
        <Loading />
      ) : (
        <>
          <Table head={['When', 'Actor', 'Action', 'Resource', 'Details', 'IP']}>
            {rows.map((r) => (
              <tr key={r.id}>
                <Td className="whitespace-nowrap text-ink-soft">{dateTime(r.created_at)}</Td>
                <Td>{r.actor_email ?? <span className="text-ink-soft">{r.actor_type === 'api_key' ? 'API key' : r.actor_type}</span>}</Td>
                <Td>
                  <code className={`font-mono text-xs ${SENSITIVE.test(r.action) ? 'text-dead' : ''}`}>{r.action}</code>
                </Td>
                <Td className="text-ink-soft">
                  {r.resource_type ? (
                    <>
                      {r.resource_type} <code className="font-mono text-xs">{r.resource_id?.slice(0, 8)}</code>
                    </>
                  ) : (
                    '—'
                  )}
                </Td>
                <Td className="max-w-[14rem] truncate font-mono text-xs text-ink-soft">
                  {Object.keys(r.metadata).length ? JSON.stringify(r.metadata) : ''}
                </Td>
                <Td className="font-mono text-xs text-ink-soft">{r.ip ?? '—'}</Td>
              </tr>
            ))}
          </Table>
          {cursor && (
            <div className="mt-4 text-center">
              <Button variant="quiet" onClick={() => void more()}>Load older entries</Button>
            </div>
          )}
        </>
      )}
    </>
  );
}
