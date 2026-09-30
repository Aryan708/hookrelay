import dns from 'node:dns/promises';
import net from 'node:net';
import { HttpError } from './errors';

// SSRF guard for outbound deliveries: user-supplied destination URLs must not
// reach internal infrastructure (cloud metadata, localhost, private VPC ranges).

const blocked = new net.BlockList();
blocked.addSubnet('0.0.0.0', 8, 'ipv4');
blocked.addSubnet('10.0.0.0', 8, 'ipv4');
blocked.addSubnet('100.64.0.0', 10, 'ipv4');
blocked.addSubnet('127.0.0.0', 8, 'ipv4');
blocked.addSubnet('169.254.0.0', 16, 'ipv4'); // includes 169.254.169.254 cloud metadata
blocked.addSubnet('172.16.0.0', 12, 'ipv4');
blocked.addSubnet('192.168.0.0', 16, 'ipv4');
blocked.addSubnet('224.0.0.0', 4, 'ipv4');
blocked.addAddress('::', 'ipv6');
blocked.addAddress('::1', 'ipv6');
blocked.addSubnet('fc00::', 7, 'ipv6');
blocked.addSubnet('fe80::', 10, 'ipv6');

export function isPrivateAddress(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 0) return false;
  if (family === 6) {
    // IPv4-mapped IPv6 (::ffff:10.0.0.1) must be checked as IPv4
    const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
    if (mapped?.[1]) return blocked.check(mapped[1], 'ipv4');
    return blocked.check(ip, 'ipv6');
  }
  return blocked.check(ip, 'ipv4');
}

export interface UrlPolicy {
  allowPrivate: boolean;
  requireHttps: boolean;
  /** Exact hostnames trusted even on private networks (e.g. the internal `n8n` service). */
  allowHosts?: readonly string[];
}

export type Resolver = (host: string) => Promise<string[]>;

const defaultResolver: Resolver = async (host) => (await dns.lookup(host, { all: true })).map((r) => r.address);

export async function assertSafeUrl(raw: string, policy: UrlPolicy, resolve: Resolver = defaultResolver): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpError(400, 'invalid_url', 'Destination URL is not a valid URL');
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new HttpError(400, 'invalid_url', 'Only http and https destinations are supported');
  }
  if (policy.requireHttps && url.protocol !== 'https:') {
    throw new HttpError(400, 'insecure_url', 'Destination must use https');
  }
  if (url.username || url.password) {
    throw new HttpError(400, 'invalid_url', 'Credentials in URLs are not allowed; use destination headers or signing instead');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (policy.allowPrivate || policy.allowHosts?.includes(host.toLowerCase())) return url;

  const addresses = net.isIP(host) ? [host] : await resolve(host).catch(() => {
    throw new HttpError(400, 'unresolvable_host', `Could not resolve host ${host}`);
  });
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw new HttpError(400, 'blocked_destination', 'Destination resolves to a private or reserved address');
  }
  return url;
}
