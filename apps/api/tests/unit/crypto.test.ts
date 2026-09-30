import { describe, expect, it } from 'vitest';
import {
  buildSignatureHeader,
  computeSignature,
  decrypt,
  encrypt,
  randomToken,
  safeEqual,
  sha256,
  verifySignatureHeader,
} from '../../src/lib/crypto';

const KEY = 'a'.repeat(64);

describe('encryption at rest', () => {
  it('round-trips plaintext', () => {
    const blob = encrypt('whsec_secret', KEY);
    expect(blob.startsWith('v1:')).toBe(true);
    expect(blob).not.toContain('whsec_secret');
    expect(decrypt(blob, KEY)).toBe('whsec_secret');
  });

  it('uses a fresh IV every time', () => {
    expect(encrypt('same', KEY)).not.toBe(encrypt('same', KEY));
  });

  it('rejects tampered ciphertext (GCM auth tag)', () => {
    const [v, iv, tag, ct] = encrypt('hello', KEY).split(':');
    const flipped = Buffer.from(ct!, 'base64url');
    flipped[0]! ^= 1;
    expect(() => decrypt([v, iv, tag, flipped.toString('base64url')].join(':'), KEY)).toThrow();
  });

  it('rejects the wrong key', () => {
    expect(() => decrypt(encrypt('hello', KEY), 'b'.repeat(64))).toThrow();
  });
});

describe('webhook signatures', () => {
  const secret = 'whsec_test';
  const body = JSON.stringify({ type: 'payment.succeeded', amount: 4200 });
  const now = 1_750_000_000_000;

  it('accepts a valid signature', () => {
    const header = buildSignatureHeader(secret, body, now);
    expect(verifySignatureHeader(header, secret, body, 300, now)).toEqual({ ok: true });
  });

  it('rejects a modified body', () => {
    const header = buildSignatureHeader(secret, body, now);
    expect(verifySignatureHeader(header, secret, body.replace('4200', '1'), 300, now)).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('rejects replays outside the tolerance window', () => {
    const header = buildSignatureHeader(secret, body, now - 301_000);
    expect(verifySignatureHeader(header, secret, body, 300, now)).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects missing and malformed headers', () => {
    expect(verifySignatureHeader(undefined, secret, body, 300, now)).toEqual({ ok: false, reason: 'missing' });
    expect(verifySignatureHeader('garbage', secret, body, 300, now)).toEqual({ ok: false, reason: 'malformed' });
    expect(verifySignatureHeader('t=abc,v1=00', secret, body, 300, now)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('accepts any of several v1 signatures (secret rotation)', () => {
    const t = Math.floor(now / 1000);
    const header = `t=${t},v1=${computeSignature('old', t, body)},v1=${computeSignature(secret, t, body)}`;
    expect(verifySignatureHeader(header, secret, body, 300, now).ok).toBe(true);
  });
});

describe('helpers', () => {
  it('safeEqual compares correctly', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });

  it('randomToken is url-safe and unique', () => {
    const a = randomToken();
    expect(a).toMatch(/^[\w-]{43}$/);
    expect(randomToken()).not.toBe(a);
  });

  it('sha256 is deterministic hex', () => {
    expect(sha256('x')).toBe('2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881');
  });
});
