'use client';

import Link from 'next/link';
import { Empty, ErrorNote, Loading, PageHeader, Panel, Table, Td } from '@/components/ui';
import { DeliverySummary } from '@/components/DeliverySummary';
import { percent, timeAgo } from '@/lib/format';
import { useApi } from '@/lib/useApi';

interface Stats {
  events_24h: number;
  sources: number;
  destinations: number;
  routes: number;
  deliveries24h: Record<string, number>;
  successRate: number | null;
  hourly: { hour: string; succeeded: number; failed: number }[];
  topFailingDestinations: { id: string; name: string; failures: number; sample_error: string | null }[];
}

interface EventRow {
  id: string;
  event_type: string;
  source_name: string;
  received_at: string;
  succeeded: number;
  failed: number;
  pending: number;
  delivery_count: number;
}

export default function Overview() {
  const stats = useApi<Stats>('/v1/stats');
  const events = useApi<{ data: EventRow[] }>('/v1/events?limit=8');

  if (stats.loading && !stats.data) return <Loading />;
  if (stats.error) return <ErrorNote error={stats.error} />;
  const s = stats.data!;
  const retrying = s.deliveries24h.pending ?? 0;
  const dead = (s.deliveries24h.dead ?? 0) + (s.deliveries24h.failed ?? 0);

  if (s.sources === 0) {
    return (
      <>
        <PageHeader title="Overview" />
        <Empty
          title="Connect your first source"
          body="A source gives you a signed webhook URL. Point Stripe, a form tool or your own app at it, then route events to an n8n workflow."
          action={
            <Link href="/sources" className="inline-flex h-9 items-center rounded-md bg-wire px-3.5 text-sm font-medium text-white">
              Create a source
            </Link>
          }
        />
      </>
    );
  }

  return (
    <>
      <PageHeader title="Overview" description="Delivery health across all routes for the last 24 hours." />

      <dl className="mb-8 grid grid-cols-2 gap-x-8 gap-y-5 border-b border-line pb-8 sm:grid-cols-4">
        <Metric label="Events received" value={s.events_24h.toLocaleString()} />
        <Metric label="Delivery success" value={percent(s.successRate)} tone={s.successRate !== null && s.successRate < 0.95 ? 'dead' : 'ok'} />
        <Metric label="Retrying now" value={retrying.toLocaleString()} tone={retrying ? 'retry' : undefined} />
        <Metric label="Failed or dead-lettered" value={dead.toLocaleString()} tone={dead ? 'dead' : undefined} />
      </dl>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Panel title="Deliveries per hour">
          <HourlyChart data={s.hourly} />
        </Panel>
        <Panel title="Needs attention">
          {s.topFailingDestinations.length === 0 ? (
            <p className="text-sm text-ink-soft">No failing destinations in the last 24 hours.</p>
          ) : (
            <ul className="space-y-4">
              {s.topFailingDestinations.map((d) => (
                <li key={d.id}>
                  <div className="flex items-baseline justify-between gap-3">
                    <Link href={`/events?status=dead`} className="truncate font-medium hover:underline">{d.name}</Link>
                    <span className="shrink-0 text-sm text-dead">{d.failures} failed</span>
                  </div>
                  {d.sample_error && <p className="mt-0.5 truncate font-mono text-xs text-ink-faint">{d.sample_error}</p>}
                </li>
              ))}
            </ul>
          )}
          <p className="mt-5 border-t border-line pt-4 text-sm text-ink-soft">
            {s.sources} sources, {s.routes} active routes, {s.destinations} destinations
          </p>
        </Panel>
      </div>

      <div className="mt-8 mb-3 flex items-baseline justify-between">
        <h2 className="text-[0.9375rem] font-semibold">Latest events</h2>
        <Link href="/events" className="text-sm font-medium text-wire hover:underline">View all events</Link>
      </div>
      {events.data && (
        <Table head={['Event', 'Source', 'Deliveries', 'Received']}>
          {events.data.data.map((e) => (
            <tr key={e.id} className="hover:bg-paper">
              <Td>
                <Link href={`/events/${e.id}`} className="font-medium hover:underline">{e.event_type}</Link>
              </Td>
              <Td className="text-ink-soft">{e.source_name}</Td>
              <Td><DeliverySummary e={e} /></Td>
              <Td className="text-ink-soft">{timeAgo(e.received_at)}</Td>
            </tr>
          ))}
        </Table>
      )}
    </>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: 'ok' | 'retry' | 'dead' }) {
  const color = tone === 'dead' ? 'text-dead' : tone === 'retry' ? 'text-retry' : tone === 'ok' ? 'text-ok' : 'text-ink';
  return (
    <div>
      <dt className="text-sm text-ink-soft">{label}</dt>
      <dd className={`mt-1 text-[1.75rem] font-semibold tabular-nums tracking-[-0.02em] ${color}`}>{value}</dd>
    </div>
  );
}

function HourlyChart({ data }: { data: Stats['hourly'] }) {
  const max = Math.max(1, ...data.map((d) => d.succeeded + d.failed));
  const W = 600;
  const H = 160;
  const bw = W / data.length;
  const total = data.reduce((n, d) => n + d.succeeded + d.failed, 0);

  return (
    <figure>
      <svg viewBox={`0 0 ${W} ${H + 22}`} className="w-full" role="img" aria-label={`${total} deliveries in the last 24 hours`}>
        <line x1="0" x2={W} y1={H} y2={H} stroke="var(--color-line)" />
        {data.map((d, i) => {
          const ok = (d.succeeded / max) * (H - 8);
          const bad = (d.failed / max) * (H - 8);
          const x = i * bw + bw * 0.18;
          const w = bw * 0.64;
          return (
            <g key={d.hour}>
              <title>{`${new Date(d.hour).getHours()}:00: ${d.succeeded} delivered, ${d.failed} failed`}</title>
              <rect x={x} y={H - ok} width={w} height={ok} rx="1.5" fill="var(--color-ok)" />
              <rect x={x} y={H - ok - bad - (bad && ok ? 2 : 0)} width={w} height={bad} rx="1.5" fill="var(--color-dead)" />
              {i % 6 === 0 && (
                <text x={x + w / 2} y={H + 16} textAnchor="middle" fontSize="11" fill="var(--color-ink-faint)">
                  {new Date(d.hour).toLocaleTimeString([], { hour: 'numeric' })}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <figcaption className="mt-2 flex gap-5 text-xs text-ink-soft">
        <span className="flex items-center gap-1.5"><i className="h-2 w-2 rounded-sm bg-ok" />Delivered</span>
        <span className="flex items-center gap-1.5"><i className="h-2 w-2 rounded-sm bg-dead" />Failed</span>
      </figcaption>
    </figure>
  );
}
