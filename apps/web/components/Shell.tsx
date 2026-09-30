'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { useAuth } from '@/lib/auth';

const NAV: { href: string; label: string; permission: string }[] = [
  { href: '/', label: 'Overview', permission: 'events:read' },
  { href: '/events', label: 'Events', permission: 'events:read' },
  { href: '/sources', label: 'Sources', permission: 'sources:read' },
  { href: '/destinations', label: 'Destinations', permission: 'destinations:read' },
  { href: '/routes', label: 'Routes', permission: 'routes:read' },
  { href: '/api-keys', label: 'API keys', permission: 'apikeys:read' },
  { href: '/members', label: 'Members', permission: 'members:read' },
  { href: '/audit', label: 'Audit log', permission: 'audit:read' },
];

function Mark() {
  // Two terminals joined by a wire: the product in one glyph.
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
      <circle cx="4" cy="11" r="3" fill="none" stroke="currentColor" strokeWidth="2" />
      <circle cx="18" cy="11" r="3" fill="currentColor" />
      <path d="M7 11h8" stroke="currentColor" strokeWidth="2" strokeDasharray="2 2" />
    </svg>
  );
}

export function Shell({ children }: { children: React.ReactNode }) {
  const { user, workspace, can, signOut, loading } = useAuth();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  if (loading || !user) {
    return <div className="grid min-h-screen place-items-center text-sm text-ink-faint">Checking your session…</div>;
  }

  const isActive = (href: string) => (href === '/' ? pathname === '/' : pathname.startsWith(href));

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[232px_1fr]">
      <aside className="bg-ink text-white lg:sticky lg:top-0 lg:h-screen">
        <div className="flex h-14 items-center justify-between px-5 lg:h-16">
          <Link href="/" className="flex items-center gap-2.5 font-semibold tracking-tight">
            <Mark />
            HookRelay
          </Link>
          <button
            className="text-sm text-white/80 lg:hidden"
            aria-expanded={open}
            aria-controls="nav"
            onClick={() => setOpen((o) => !o)}
          >
            {open ? 'Close' : 'Menu'}
          </button>
        </div>
        <nav id="nav" className={`${open ? 'block' : 'hidden'} px-3 pb-4 lg:flex lg:h-[calc(100vh-4rem)] lg:flex-col`}>
          <ul className="space-y-0.5">
            {NAV.filter((n) => can(n.permission)).map((n) => (
              <li key={n.href}>
                <Link
                  href={n.href}
                  onClick={() => setOpen(false)}
                  aria-current={isActive(n.href) ? 'page' : undefined}
                  className={`block rounded-md px-3 py-2 text-sm transition-colors ${
                    isActive(n.href) ? 'bg-white/12 font-medium text-white' : 'text-white/70 hover:bg-white/6 hover:text-white'
                  }`}
                >
                  {n.label}
                </Link>
              </li>
            ))}
          </ul>
          <div className="mt-6 border-t border-white/10 px-3 pt-4 text-sm lg:mt-auto">
            <p className="truncate font-medium">{workspace?.name}</p>
            <p className="truncate text-white/60">
              {user.email} <span className="text-white/40">({user.role})</span>
            </p>
            <button onClick={() => void signOut()} className="mt-3 text-white/70 hover:text-white">
              Sign out
            </button>
          </div>
        </nav>
      </aside>
      <main className="mx-auto w-full max-w-6xl px-4 py-7 sm:px-8 lg:py-10">{children}</main>
    </div>
  );
}
