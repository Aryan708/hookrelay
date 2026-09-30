export function timeAgo(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const diff = (Date.now() - new Date(value).getTime()) / 1000;
  if (diff < 0) return `in ${formatDuration(-diff)}`;
  if (diff < 45) return 'just now';
  return `${formatDuration(diff)} ago`;
}

function formatDuration(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)}s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m`;
  if (seconds < 129600) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

export const dateTime = (v: string | Date) =>
  new Date(v).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' });

export const shortId = (id: string) => id.slice(0, 8);

export const percent = (v: number | null) => (v === null ? '—' : `${(v * 100).toFixed(v === 1 ? 0 : 1)}%`);
