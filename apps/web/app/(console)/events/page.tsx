'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { DeliverySummary } from '@/components/DeliverySummary';
import { Button, Empty, ErrorNote, Loading, PageHeader, Select, Table, Td } from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { useApi } from '@/lib/useApi';

interface EventRow {
  id: string;
  event_type: string;
  source_id: string;
  source_name: string;
  idempotency_key: string | null;
  received_at: string;
  succeeded: number;
  failed: number;
  pending: number;
  delivery_count: number;
}

const STATUSES = [
  ['', 'Any delivery status'],
  ['dead', 'Dead-lettered'],
  ['failed', 'Rejected'],
  ['pending', 'Retrying'],
  ['succeeded', 'Delivered'],
  ['skipped', 'Filtered out'],
];

function EventsList() {
  const router = useRouter();
  const params = useSearchParams();
  const status = params.get('status') ?? '';
  const sourceId = params.get('sourceId') ?? '';
  const sources = useApi<{ data: { id: string; name: string }[] }>('/v1/sources');

  const [rows, setRows] = useState<EventRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);

  const query = (before?: string) => {
    const q = new URLSearchParams({ limit: '25' });
    if (status) q.set('status', status);
    if (sourceId) q.set('sourceId', sourceId);
    if (before) q.set('before', before);
    return `/v1/events?${q}`;
  };

  useEffect(() => {
    setLoading(true);
    api<{ data: EventRow[]; nextCursor: string | null }>(query())
      .then((r) => {
        setRows(r.data);
        setCursor(r.nextCursor);
        setError(null);
      })
      .catch(setError)
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, sourceId]);

  async function loadMore() {
    if (!cursor) return;
    const r = await api<{ data: EventRow[]; nextCursor: string | null }>(query(cursor));
    setRows((prev) => [...prev, ...r.data]);
    setCursor(r.nextCursor);
  }

  const setFilter = (key: string, value: string) => {
    const q = new URLSearchParams(params);
    if (value) q.set(key, value);
    else q.delete(key);
    router.replace(`/events?${q}`);
  };

  return (
    <>
      <PageHeader title="Events" description="Every webhook received, and what happened to each delivery." />
      <div className="mb-4 flex flex-wrap gap-3">
        <Select aria-label="Filter by source" value={sourceId} onChange={(e) => setFilter('sourceId', e.target.value)} className="w-auto">
          <option value="">All sources</option>
          {sources.data?.data.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </Select>
        <Select aria-label="Filter by delivery status" value={status} onChange={(e) => setFilter('status', e.target.value)} className="w-auto">
          {STATUSES.map(([v, l]) => (
            <option key={v} value={v}>{l}</option>
          ))}
        </Select>
      </div>

      <ErrorNote error={error} />
      {loading ? (
        <Loading />
      ) : rows.length === 0 ? (
        <Empty
          title={status || sourceId ? 'No events match these filters' : 'No events yet'}
          body={
            status || sourceId
              ? 'Try a different source or status.'
              : 'Send a signed request to a source’s webhook URL and it will show up here within a second.'
          }
        />
      ) : (
        <>
          <Table head={['Event type', 'Source', 'Deliveries', 'Idempotency key', 'Received']}>
            {rows.map((e) => (
              <tr key={e.id} className="hover:bg-paper">
                <Td>
                  <Link href={`/events/${e.id}`} className="font-medium hover:underline">{e.event_type}</Link>
                </Td>
                <Td className="text-ink-soft">{e.source_name}</Td>
                <Td><DeliverySummary e={e} /></Td>
                <Td className="font-mono text-xs text-ink-soft">{e.idempotency_key ?? '—'}</Td>
                <Td className="whitespace-nowrap text-ink-soft">{timeAgo(e.received_at)}</Td>
              </tr>
            ))}
          </Table>
          {cursor && (
            <div className="mt-4 text-center">
              <Button variant="quiet" onClick={() => void loadMore()}>Load older events</Button>
            </div>
          )}
        </>
      )}
    </>
  );
}

export default function EventsPage() {
  return (
    <Suspense fallback={<Loading />}>
      <EventsList />
    </Suspense>
  );
}
