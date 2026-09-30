import { describe, expect, it } from 'vitest';
import { API_KEY_SCOPES, PERMISSIONS, ROLE_PERMISSIONS } from '../../src/lib/rbac';
import { backoffDelayMs, isRetryableStatus, MAX_BACKOFF_MS, parseRetryAfter } from '../../src/lib/retry';
import { assertSafeUrl, isPrivateAddress } from '../../src/lib/ssrf';
import { applyMapping, getPath, matchesConditions, renderTemplate } from '../../src/lib/transform';

describe('transform: filters', () => {
  const doc = { type: 'payment.succeeded', data: { amount: 4200, currency: 'usd', tags: ['vip'], customer: { email: 'a@b.co' } } };

  it.each([
    [{ path: 'type', op: 'eq', value: 'payment.succeeded' }, true],
    [{ path: 'type', op: 'neq', value: 'payment.succeeded' }, false],
    [{ path: 'data.amount', op: 'gt', value: 1000 }, true],
    [{ path: 'data.amount', op: 'lte', value: 1000 }, false],
    [{ path: 'data.currency', op: 'in', value: ['usd', 'eur'] }, true],
    [{ path: 'data.tags', op: 'contains', value: 'vip' }, true],
    [{ path: 'data.customer.email', op: 'contains', value: '@b.co' }, true],
    [{ path: 'data.customer.phone', op: 'exists' }, false],
    [{ path: 'data.missing', op: 'gt', value: 0 }, false],
  ] as const)('%o → %s', (condition, expected) => {
    expect(matchesConditions([condition], doc)).toBe(expected);
  });

  it('ANDs conditions and treats an empty filter as match-all', () => {
    expect(matchesConditions([], doc)).toBe(true);
    expect(
      matchesConditions(
        [
          { path: 'type', op: 'eq', value: 'payment.succeeded' },
          { path: 'data.amount', op: 'lt', value: 100 },
        ],
        doc,
      ),
    ).toBe(false);
  });
});

describe('transform: mapping', () => {
  const doc = { id: 'evt_1', data: { customer: { email: 'a@b.co', name: 'Ada' }, items: [{ sku: 'X1' }], amount: 4200 } };

  it('maps paths, constants and templates into nested output', () => {
    expect(
      applyMapping(
        {
          'contact.email': 'data.customer.email',
          'contact.source': { const: 'hookrelay' },
          firstSku: 'data.items.0.sku',
          text: { template: 'Payment of {{data.amount}} from {{data.customer.name}}' },
          dropped: 'data.not.there',
        },
        doc,
      ),
    ).toEqual({
      contact: { email: 'a@b.co', source: 'hookrelay' },
      firstSku: 'X1',
      text: 'Payment of 4200 from Ada',
    });
  });

  it('passes the document through when no mapping is set', () => {
    expect(applyMapping(null, doc)).toBe(doc);
  });

  it('blocks prototype pollution', () => {
    expect(getPath({ a: 1 }, '__proto__.polluted')).toBeUndefined();
    expect(() => applyMapping({ '__proto__.polluted': { const: true } }, doc)).toThrow();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('renders missing template values as empty strings', () => {
    expect(renderTemplate('Hi {{ nope }}!', {})).toBe('Hi !');
  });
});

describe('retry policy', () => {
  it('grows exponentially with jitter and caps', () => {
    expect(backoffDelayMs(1, 1000, () => 0)).toBe(500);
    expect(backoffDelayMs(1, 1000, () => 1)).toBe(1000);
    expect(backoffDelayMs(4, 1000, () => 1)).toBe(8000);
    expect(backoffDelayMs(50, 1000, () => 1)).toBe(MAX_BACKOFF_MS);
  });

  it('classifies statuses', () => {
    expect([408, 425, 429, 500, 503].every(isRetryableStatus)).toBe(true);
    expect([400, 401, 404, 422].some(isRetryableStatus)).toBe(false);
  });

  it('parses Retry-After seconds and dates', () => {
    expect(parseRetryAfter('30')).toBe(30_000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 0)).toBe(10_000);
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter('soon')).toBeNull();
  });
});

describe('SSRF guard', () => {
  it.each(['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:10.0.0.1'])(
    'blocks %s',
    (ip) => expect(isPrivateAddress(ip)).toBe(true),
  );

  it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])('allows %s', (ip) => expect(isPrivateAddress(ip)).toBe(false));

  const strict = { allowPrivate: false, requireHttps: true };

  it('rejects private destinations, including via DNS', async () => {
    await expect(assertSafeUrl('https://169.254.169.254/latest/meta-data', strict)).rejects.toMatchObject({ code: 'blocked_destination' });
    await expect(assertSafeUrl('https://internal.example', strict, async () => ['10.0.0.5'])).rejects.toMatchObject({
      code: 'blocked_destination',
    });
  });

  it('enforces https, protocol and no embedded credentials', async () => {
    await expect(assertSafeUrl('http://hooks.example.com', strict, async () => ['93.184.216.34'])).rejects.toMatchObject({ code: 'insecure_url' });
    await expect(assertSafeUrl('ftp://x.example', strict)).rejects.toMatchObject({ code: 'invalid_url' });
    await expect(assertSafeUrl('https://u:p@x.example', strict)).rejects.toMatchObject({ code: 'invalid_url' });
  });

  it('trusts explicitly allow-listed internal hosts only', async () => {
    const policy = { ...strict, requireHttps: false, allowHosts: ['n8n'] };
    await expect(assertSafeUrl('http://n8n:5678/webhook/x', policy, async () => ['172.18.0.4'])).resolves.toBeInstanceOf(URL);
    await expect(assertSafeUrl('http://postgres:5432', policy, async () => ['172.18.0.2'])).rejects.toMatchObject({
      code: 'blocked_destination',
    });
  });

  it('accepts public https destinations', async () => {
    const url = await assertSafeUrl('https://hooks.example.com/n8n', strict, async () => ['93.184.216.34']);
    expect(url.hostname).toBe('hooks.example.com');
  });
});

describe('RBAC matrix', () => {
  it('follows least privilege', () => {
    expect(ROLE_PERMISSIONS.viewer.has('sources:write')).toBe(false);
    expect(ROLE_PERMISSIONS.developer.has('sources:write')).toBe(true);
    expect(ROLE_PERMISSIONS.developer.has('members:write')).toBe(false);
    expect(ROLE_PERMISSIONS.developer.has('audit:read')).toBe(false);
    expect(ROLE_PERMISSIONS.admin.has('audit:read')).toBe(true);
    expect(ROLE_PERMISSIONS.owner.size).toBe(PERMISSIONS.length);
  });

  it('never lets API keys manage identity or read the audit log', () => {
    for (const forbidden of ['members:write', 'apikeys:write', 'audit:read']) {
      expect(API_KEY_SCOPES as readonly string[]).not.toContain(forbidden);
    }
  });
});
