// Retry policy for outbound deliveries: exponential backoff with jitter.

export const MAX_BACKOFF_MS = 60 * 60 * 1000; // 1 hour

export function backoffDelayMs(attempt: number, baseMs: number, random: () => number = Math.random): number {
  const exp = Math.min(MAX_BACKOFF_MS, baseMs * 2 ** Math.max(0, attempt - 1));
  // "Equal jitter": keep at least half the delay, randomize the rest to avoid thundering herds.
  return Math.round(exp / 2 + random() * (exp / 2));
}

/** 408, 425, 429 and 5xx are transient. Other 4xx mean the request itself is wrong, so retrying won't help. */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/** Parses Retry-After (seconds or HTTP date) into milliseconds, capped at MAX_BACKOFF_MS. */
export function parseRetryAfter(header: string | null, nowMs = Date.now()): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_BACKOFF_MS);
  const date = Date.parse(header);
  if (Number.isNaN(date)) return null;
  return Math.min(Math.max(0, date - nowMs), MAX_BACKOFF_MS);
}
