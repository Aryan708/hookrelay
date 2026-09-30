import { z } from 'zod';

const bool = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_TTL_DAYS: z.coerce.number().int().positive().default(7),

  // 32-byte key, hex encoded. Used for AES-256-GCM encryption of signing secrets at rest.
  ENCRYPTION_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, 'ENCRYPTION_KEY must be 64 hex characters (32 bytes)'),

  CORS_ORIGINS: z.string().default('http://localhost:3000'),
  WEB_URL: z.url().default('http://localhost:3000'),
  // Public base URL the API is reachable at (used to build ingest URLs and OAuth callbacks).
  API_PUBLIC_URL: z.url().default('http://localhost:3000/api'),

  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),

  // Destinations resolving to private/loopback IPs are blocked unless explicitly allowed (SSRF guard).
  ALLOW_PRIVATE_DESTINATIONS: bool,
  // Comma-separated hostnames that may resolve to private IPs, e.g. "n8n" inside docker-compose.
  DESTINATION_HOST_ALLOWLIST: z
    .string()
    .default('')
    .transform((v) => v.split(',').map((h) => h.trim().toLowerCase()).filter(Boolean)),
  // Plain http destinations are rejected in production unless explicitly allowed (internal networks only).
  ALLOW_HTTP_DESTINATIONS: bool,
  WORKER_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  WORKER_POLL_MS: z.coerce.number().int().positive().default(2000),
  WORKER_BATCH_SIZE: z.coerce.number().int().positive().default(10),
  RETRY_BASE_MS: z.coerce.number().int().positive().default(5000),
  SIGNATURE_TOLERANCE_SECONDS: z.coerce.number().int().positive().default(300),
  TRUST_PROXY: z.coerce.number().int().min(0).default(1),
});

export type Env = z.infer<typeof schema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }
  const env = parsed.data;
  if (env.NODE_ENV === 'production' && env.ALLOW_PRIVATE_DESTINATIONS) {
    throw new Error('ALLOW_PRIVATE_DESTINATIONS must not be enabled in production');
  }
  return env;
}

export const env = loadEnv();
