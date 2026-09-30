// Test configuration. Values are throwaway and only valid for the local test database.
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/hookrelay_test';
process.env.JWT_ACCESS_SECRET = 'test-only-access-secret-at-least-32-characters';
process.env.ENCRYPTION_KEY = '0'.repeat(64);
process.env.ALLOW_PRIVATE_DESTINATIONS = 'true'; // tests deliver to a local HTTP server
process.env.WORKER_ENABLED = 'false';
process.env.RETRY_BASE_MS = '1';
process.env.API_PUBLIC_URL = 'http://localhost:4000';
process.env.GITHUB_CLIENT_ID = 'test-client-id';
process.env.GITHUB_CLIENT_SECRET = 'test-client-secret';
