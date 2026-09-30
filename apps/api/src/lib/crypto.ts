import crypto from 'node:crypto';

export const randomToken = (bytes = 32): string => crypto.randomBytes(bytes).toString('base64url');

export const sha256 = (value: string): string => crypto.createHash('sha256').update(value).digest('hex');

/** Constant-time string comparison that does not leak length via early exit. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    crypto.timingSafeEqual(ab, ab);
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

// ---------- Encryption at rest (AES-256-GCM) ----------

export function encrypt(plaintext: string, keyHex: string): string {
  const key = Buffer.from(keyHex, 'hex');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join(':');
}

export function decrypt(blob: string, keyHex: string): string {
  const [version, iv, tag, ciphertext] = blob.split(':');
  if (version !== 'v1' || !iv || !tag || !ciphertext) throw new Error('Unsupported ciphertext format');
  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
}

// ---------- Webhook signatures ----------
// Header format (Stripe-style): "t=<unix seconds>,v1=<hex hmac-sha256 of `${t}.${body}`>"
// Signing the timestamp together with the body prevents replaying an old request.

export function computeSignature(secret: string, timestamp: number, body: string): string {
  return crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

export function buildSignatureHeader(secret: string, body: string, nowMs = Date.now()): string {
  const t = Math.floor(nowMs / 1000);
  return `t=${t},v1=${computeSignature(secret, t, body)}`;
}

export type SignatureCheck = { ok: true } | { ok: false; reason: 'missing' | 'malformed' | 'expired' | 'mismatch' };

export function verifySignatureHeader(
  header: string | undefined,
  secret: string,
  body: string,
  toleranceSeconds: number,
  nowMs = Date.now(),
): SignatureCheck {
  if (!header) return { ok: false, reason: 'missing' };

  const parts = new Map<string, string[]>();
  for (const piece of header.split(',')) {
    const idx = piece.indexOf('=');
    if (idx <= 0) continue;
    const k = piece.slice(0, idx).trim();
    const v = piece.slice(idx + 1).trim();
    parts.set(k, [...(parts.get(k) ?? []), v]);
  }

  const t = Number(parts.get('t')?.[0]);
  const candidates = parts.get('v1') ?? [];
  if (!Number.isInteger(t) || candidates.length === 0) return { ok: false, reason: 'malformed' };

  if (Math.abs(Math.floor(nowMs / 1000) - t) > toleranceSeconds) return { ok: false, reason: 'expired' };

  const expected = computeSignature(secret, t, body);
  // Multiple v1 values are allowed so senders can sign with old + new secret during rotation.
  return candidates.some((c) => safeEqual(c, expected)) ? { ok: true } : { ok: false, reason: 'mismatch' };
}
