export interface DeliveryCounts {
  succeeded: number;
  failed: number;
  pending: number;
  delivery_count: number;
}

export function DeliverySummary({ e }: { e: DeliveryCounts }) {
  if (e.delivery_count === 0) return <span className="text-ink-faint">No routes</span>;
  const parts = [
    e.succeeded ? <span key="s" className="text-ok">{e.succeeded} delivered</span> : null,
    e.pending ? <span key="p" className="text-retry">{e.pending} retrying</span> : null,
    e.failed ? <span key="f" className="text-dead">{e.failed} failed</span> : null,
  ].filter(Boolean);
  const skipped = e.delivery_count - e.succeeded - e.pending - e.failed;
  if (skipped > 0) parts.push(<span key="k" className="text-skip">{skipped} filtered</span>);
  return <span className="flex flex-wrap gap-x-3">{parts}</span>;
}
