'use client';

import Link from 'next/link';

export function AuthFrame({ title, subtitle, children, footer }: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
  footer: React.ReactNode;
}) {
  return (
    <div className="grid min-h-screen lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
      <section className="relative hidden overflow-hidden bg-ink p-12 text-white lg:flex lg:flex-col lg:justify-between">
        <Link href="/" className="font-semibold tracking-tight">HookRelay</Link>
        <div>
          <p className="max-w-sm text-[2rem] font-semibold leading-[1.15] tracking-[-0.015em]">
            Every webhook received, verified and delivered, or you&apos;ll know exactly why not.
          </p>
          <WireIllustration />
        </div>
        <p className="max-w-sm text-sm leading-relaxed text-white/55">Connect Stripe, forms and CRMs to your n8n workflows with signed intake, filters, field mapping and automatic retries.</p>
      </section>
      <section className="flex items-center justify-center px-4 py-12 sm:px-8">
        <div className="w-full max-w-sm">
          <h1 className="text-2xl font-semibold tracking-[-0.01em]">{title}</h1>
          <p className="mt-1 text-[0.9375rem] text-ink-soft">{subtitle}</p>
          <div className="mt-7">{children}</div>
          <div className="mt-6 text-sm text-ink-soft">{footer}</div>
        </div>
      </section>
    </div>
  );
}

function WireIllustration() {
  // Source on the left, destinations on the right; one line retries before landing.
  return (
    <svg viewBox="0 0 360 150" className="mt-10 w-full max-w-md" aria-hidden="true">
      <g fill="none" strokeWidth="1.5">
        <path d="M40 75 C140 75 170 30 320 30" stroke="#4fb3a6" />
        <path d="M40 75 H320" stroke="#e7a43b" strokeDasharray="4 5" />
        <path d="M40 75 C140 75 170 120 320 120" stroke="#ffffff55" />
      </g>
      <circle cx="40" cy="75" r="9" fill="#fff" />
      {[
        [320, 30, '#4fb3a6'],
        [320, 75, '#e7a43b'],
        [320, 120, '#ffffff88'],
      ].map(([x, y, c]) => (
        <circle key={`${x}${y}`} cx={x as number} cy={y as number} r="6" fill={c as string} />
      ))}
      <circle cx="190" cy="75" r="4" fill="#e7a43b" />
      <circle cx="245" cy="75" r="4" fill="#e7a43b" />
    </svg>
  );
}
