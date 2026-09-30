'use client';

import Link from 'next/link';
import { use, useState } from 'react';
import { Button, Code, CopyButton, type DeliveryStatus, ErrorNote, Loading, PageHeader, Panel, StatusBadge } from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { dateTime, timeAgo } from '@/lib/format';
import { useApi } from '@/lib/useApi';

interface Attempt {
  attempt_no: number;
  status_code: number | null;
  error: string | null;
  duration_ms: number;
  response_snippet: string | null;
  created_at: string;
}

interface Delivery {
  id: string;
  status: DeliveryStatus;
  attempt_count: number;
  next_attempt_at: string | null;
  last_status_code: number | null;
  last_error: string | null;
  route_name: string;
  destination_name: string;
  destination_url: string;
  attempts: Attempt[];
}

interface EventDetail {
  id: string;
  event_type: string;
  source_id: string;
  source_name: string;
  idempotency_key: string | null;
  received_at: string;
  payload: unknown;
  deliveries: Delivery[];
}

export default function EventPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data, error, loading, reload } = useApi<EventDetail>(`/v1/events/${id}`);

  if (loading && !data) return <Loading />;
  if (error) return <ErrorNote error={error} />;
  const e = data!;

  return (
    <>
      <p className="mb-2 text-sm">
        <Link href="/events" className="text-wire hover:underline">Events</Link>
      </p>
      <PageHeader
        title={e.event_type}
        description={`Received ${dateTime(e.received_at)} from ${e.source_name}`}
        action={<Button variant="quiet" onClick={() => void reload()}>Refresh</Button>}
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="space-y-5">
          <h2 className="text-[0.9375rem] font-semibold">Deliveries</h2>
          {e.deliveries.length === 0 && (
            <p className="text-sm text-ink-soft">No routes were listening to this source when the event arrived.</p>
          )}
          {e.deliveries.map((d) => (
            <DeliveryCard key={d.id} d={d} onReplayed={reload} />
          ))}
        </div>

        <div className="space-y-5">
          <Panel title="Details">
            <dl className="space-y-3 text-sm">
              <Row label="Event ID"><Code>{e.id}</Code></Row>
              <Row label="Idempotency key">{e.idempotency_key ? <Code>{e.idempotency_key}</Code> : '—'}</Row>
              <Row label="Source">
                <Link href={`/events?sourceId=${e.source_id}`} className="text-wire hover:underline">{e.source_name}</Link>
              </Row>
            </dl>
          </Panel>
          <Panel title="Payload">
            <div className="-mt-2 mb-2 flex justify-end">
              <CopyButton value={JSON.stringify(e.payload, null, 2)} label="Copy JSON" />
            </div>
            <pre className="max-h-[28rem] overflow-auto rounded-md bg-ink p-4 font-mono text-[0.8125rem] leading-relaxed text-white/90">
              {JSON.stringify(e.payload, null, 2)}
            </pre>
          </Panel>
        </div>
      </div>
    </>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-ink-soft">{label}</dt>
      <dd className="min-w-0 truncate text-right">{children}</dd>
    </div>
  );
}

function DeliveryCard({ d, onReplayed }: { d: Delivery; onReplayed: () => void }) {
  const { can } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [open, setOpen] = useState(d.status !== 'succeeded');

  async function replay() {
    setBusy(true);
    setError(null);
    try {
      await api(`/v1/deliveries/${d.id}/replay`, { method: 'POST' });
      onReplayed();
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="rounded-lg border border-line bg-panel">
      <header className="flex items-start justify-between gap-3 p-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2.5">
            <p className="font-medium">{d.destination_name}</p>
            <StatusBadge status={d.status} />
          </div>
          <p className="mt-0.5 truncate text-sm text-ink-soft">
            via {d.route_name} to <span className="font-mono text-xs">{d.destination_url}</span>
          </p>
        </div>
        {can('events:replay') && d.status !== 'pending' && (
          <Button variant="quiet" disabled={busy} onClick={() => void replay()}>
            {busy ? 'Queuing…' : d.status === 'skipped' ? 'Deliver anyway' : 'Replay'}
          </Button>
        )}
      </header>

      <Wire d={d} />

      <div className="px-4 pb-4">
        <ErrorNote error={error} />
        {d.status === 'pending' && d.next_attempt_at && (
          <p className="text-sm text-retry">Next attempt {timeAgo(d.next_attempt_at)}</p>
        )}
        {d.attempts.length > 0 && (
          <button onClick={() => setOpen((o) => !o)} className="mt-1 text-sm font-medium text-wire hover:underline" aria-expanded={open}>
            {open ? 'Hide attempts' : `Show ${d.attempts.length} attempt${d.attempts.length > 1 ? 's' : ''}`}
          </button>
        )}
        {open && d.attempts.length > 0 && (
          <ol className="mt-3 space-y-2">
            {d.attempts.map((a) => (
              <li key={a.attempt_no} className="rounded-md border border-line px-3 py-2 text-sm">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span>
                    Attempt {a.attempt_no}:{' '}
                    <span className={a.status_code && a.status_code < 300 ? 'text-ok' : 'text-dead'}>
                      {a.status_code ? `HTTP ${a.status_code}` : a.error}
                    </span>
                  </span>
                  <span className="text-xs text-ink-faint">
                    {a.duration_ms} ms, {dateTime(a.created_at)}
                  </span>
                </div>
                {a.response_snippet && (
                  <pre className="mt-1.5 overflow-x-auto font-mono text-xs text-ink-soft">{a.response_snippet}</pre>
                )}
              </li>
            ))}
          </ol>
        )}
      </div>
    </article>
  );
}

/**
 * The signature element: a wire from source to destination, with one signal per attempt.
 * Failed attempts sit on the line in red, the final state lands at the terminal.
 */
function Wire({ d }: { d: Delivery }) {
  const slots = Math.max(d.attempts.length, 1);
  const color = (a: Attempt) =>
    a.status_code && a.status_code < 300 ? 'var(--color-ok)' : a.status_code && a.status_code < 500 && ![408, 425, 429].includes(a.status_code) ? 'var(--color-dead)' : 'var(--color-retry)';
  const terminal =
    d.status === 'succeeded' ? 'var(--color-ok)' : d.status === 'pending' ? 'var(--color-retry)' : d.status === 'skipped' ? 'var(--color-skip)' : 'var(--color-dead)';

  return (
    <div className="px-4 pb-3" aria-label={`${d.attempts.length} delivery attempts, final status ${d.status}`}>
      <svg viewBox="0 0 400 28" className="h-7 w-full" preserveAspectRatio="none" aria-hidden="true">
        <line x1="8" x2="392" y1="14" y2="14" stroke="var(--color-line)" strokeWidth="2" strokeDasharray={d.status === 'pending' ? '4 4' : undefined} />
        <line
          x1="8"
          x2={d.status === 'skipped' ? 40 : 392}
          y1="14"
          y2="14"
          stroke={terminal}
          strokeOpacity="0.35"
          strokeWidth="2"
        />
      </svg>
      <div className="relative -mt-7 flex h-7 items-center justify-between">
        <span className="h-3 w-3 rounded-full border-2 border-wire bg-panel" title="Source" />
        <div className="flex flex-1 justify-evenly">
          {d.attempts.map((a, i) => (
            <span
              key={a.attempt_no}
              title={`Attempt ${a.attempt_no}: ${a.status_code ? `HTTP ${a.status_code}` : a.error}`}
              className="h-2.5 w-2.5 rounded-full"
              style={{ background: color(a), animation: `signal 240ms ${i * 90}ms both ease-out` }}
            />
          ))}
          {slots === 1 && d.attempts.length === 0 && (
            <span className="bg-panel px-2 text-xs text-ink-soft">{d.status === 'skipped' ? 'Route filter did not match' : 'Queued'}</span>
          )}
        </div>
        <span className="h-3.5 w-3.5 rounded-full" style={{ background: terminal }} title="Destination" />
      </div>
    </div>
  );
}
