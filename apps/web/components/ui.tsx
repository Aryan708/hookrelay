'use client';

import { useState } from 'react';
import type { ApiError } from '@/lib/api';

export function PageHeader({ title, description, action }: { title: string; description?: string; action?: React.ReactNode }) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-4 border-b border-line pb-5">
      <div className="max-w-2xl">
        <h1 className="text-[1.625rem] font-semibold leading-tight tracking-[-0.01em]">{title}</h1>
        {description && <p className="mt-1.5 text-[0.9375rem] leading-relaxed text-ink-soft">{description}</p>}
      </div>
      {action}
    </header>
  );
}

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'quiet' | 'danger' };

export function Button({ variant = 'primary', className = '', ...props }: ButtonProps) {
  const styles = {
    primary: 'bg-wire text-white hover:bg-ink disabled:bg-ink-faint',
    quiet: 'border border-line bg-panel text-ink hover:border-ink-faint disabled:text-ink-faint',
    danger: 'border border-dead/30 bg-panel text-dead hover:bg-dead-bg',
  }[variant];
  return (
    <button
      className={`inline-flex h-9 items-center gap-2 rounded-md px-3.5 text-sm font-medium transition-colors disabled:cursor-not-allowed ${styles} ${className}`}
      {...props}
    />
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs leading-snug text-ink-faint">{hint}</span>}
    </label>
  );
}

export const inputClass =
  'block h-9 rounded-md border border-line bg-panel px-3 text-sm text-ink placeholder:text-ink-faint focus:border-wire focus:outline-none focus:ring-2 focus:ring-wire/15';

// Full width unless the caller sets its own width.
const width = (className = '') => (/(^|\s)w-/.test(className) ? '' : 'w-full');

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${inputClass} ${width(props.className)} ${props.className ?? ''}`} />;
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`${inputClass} pr-8 ${width(props.className)} ${props.className ?? ''}`} />;
}

export type DeliveryStatus = 'pending' | 'succeeded' | 'failed' | 'dead' | 'skipped';

const STATUS: Record<DeliveryStatus, { label: string; cls: string }> = {
  succeeded: { label: 'Delivered', cls: 'bg-ok-bg text-ok' },
  pending: { label: 'Retrying', cls: 'bg-retry-bg text-retry' },
  failed: { label: 'Rejected', cls: 'bg-dead-bg text-dead' },
  dead: { label: 'Dead-lettered', cls: 'bg-dead-bg text-dead' },
  skipped: { label: 'Filtered out', cls: 'bg-skip-bg text-skip' },
};

export function StatusBadge({ status }: { status: DeliveryStatus }) {
  const s = STATUS[status];
  return <span className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-medium ${s.cls}`}>{s.label}</span>;
}

export function Table({ head, children }: { head: React.ReactNode[]; children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-line bg-panel">
      <table className="w-full min-w-[640px] text-left text-sm">
        <thead>
          <tr className="border-b border-line text-[0.8125rem] text-ink-soft">
            {head.map((h, i) => (
              <th key={i} className="px-4 py-2.5 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">{children}</tbody>
      </table>
    </div>
  );
}

export const Td = ({ children, className = '' }: { children?: React.ReactNode; className?: string }) => (
  <td className={`px-4 py-3 align-top ${className}`}>{children}</td>
);

export function Empty({ title, body, action }: { title: string; body: string; action?: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-line bg-panel px-6 py-12 text-center">
      <p className="font-medium">{title}</p>
      <p className="mx-auto mt-1 max-w-md text-sm leading-relaxed text-ink-soft">{body}</p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function ErrorNote({ error }: { error: ApiError | null }) {
  if (!error) return null;
  return (
    <div role="alert" className="rounded-md border border-dead/25 bg-dead-bg px-3.5 py-2.5 text-sm text-dead">
      <p>{error.message}</p>
      {error.details && (
        <ul className="mt-1 list-disc pl-5">
          {error.details.map((d) => (
            <li key={d.path + d.message}>
              {d.path && <code className="font-mono">{d.path}</code>} {d.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function Loading() {
  return <p className="py-10 text-sm text-ink-faint">Loading…</p>;
}

export function Code({ children }: { children: React.ReactNode }) {
  return <code className="rounded bg-skip-bg px-1.5 py-0.5 font-mono text-[0.8125rem]">{children}</code>;
}

export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        await navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="shrink-0 text-sm font-medium text-wire hover:underline"
    >
      {copied ? 'Copied' : label}
    </button>
  );
}

/** Shows a secret exactly once, with a clear warning that it can't be retrieved later. */
export function OneTimeSecret({ title, value, onDone }: { title: string; value: string; onDone: () => void }) {
  return (
    <div className="mb-6 rounded-lg border border-retry/30 bg-retry-bg p-4">
      <p className="font-medium text-ink">{title}</p>
      <p className="mt-0.5 text-sm text-ink-soft">
        Copy it now and store it in your secrets manager. HookRelay only keeps an encrypted or hashed copy and won&apos;t show it again.
      </p>
      <div className="mt-3 flex items-center gap-3 rounded-md border border-line bg-panel px-3 py-2">
        <code className="min-w-0 flex-1 truncate font-mono text-[0.8125rem]">{value}</code>
        <CopyButton value={value} />
      </div>
      <Button variant="quiet" className="mt-3" onClick={onDone}>
        I&apos;ve stored it
      </Button>
    </div>
  );
}

export function Panel({ title, children, className = '' }: { title?: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={`rounded-lg border border-line bg-panel p-5 ${className}`}>
      {title && <h2 className="mb-4 text-[0.9375rem] font-semibold">{title}</h2>}
      {children}
    </section>
  );
}
