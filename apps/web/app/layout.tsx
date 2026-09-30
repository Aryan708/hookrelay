import type { Metadata } from 'next';
import { AuthProvider } from '@/lib/auth';
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'HookRelay', template: '%s | HookRelay' },
  description: 'Receive, route and reliably deliver webhooks to n8n and your SaaS tools.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
