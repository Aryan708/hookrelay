# Security policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately through [GitHub security advisories](https://github.com/Aryan708/hookrelay/security/advisories/new) rather than a public issue. Include steps to reproduce and the impact you expect. You'll get an acknowledgement within 3 business days.

## How HookRelay protects data

| Area | Control |
| --- | --- |
| Passwords | bcrypt, cost 12. Minimum 12 characters with mixed case and a digit. Constant-time comparison against a dummy hash when the email doesn't exist, so login timing doesn't reveal accounts. |
| Sessions | 15-minute HS256 JWT access tokens with pinned algorithm, issuer and audience. Refresh tokens are random 384-bit values, stored as SHA-256 hashes, rotated on every use; presenting a rotated token revokes the whole token family. |
| OAuth 2.0 | GitHub authorization code flow with `state` and PKCE (S256), both bound to the browser in a short-lived httpOnly cookie. Accounts link only through a verified primary email. |
| Authorization | Role-based access control (owner, admin, developer, viewer) checked per endpoint. Roles are re-read from the database on every request. Nobody can grant or modify a role above their own; the last owner can't be removed. |
| Tenant isolation | Every query is scoped to the caller's workspace; cross-workspace access returns 404. |
| API keys | Only a SHA-256 hash and a display prefix are stored. Scoped, optionally expiring, revocable. Keys can't manage members, keys or read the audit log. |
| Webhook secrets | AES-256-GCM encrypted at rest with a key from the environment. Shown once on creation or rotation. |
| Inbound webhooks | HMAC-SHA256 over `timestamp.rawBody`, 5-minute replay window, timing-safe comparison, identical error for unknown source and bad signature (no enumeration). Rate limited per source and IP. |
| Outbound deliveries (SSRF) | Destination URLs are resolved and rejected if any address is private, loopback, link-local (cloud metadata) or reserved, both when saved and again at send time. Redirects aren't followed. URLs with embedded credentials are rejected. HTTPS required in production. Internal hosts need an explicit allowlist entry. |
| Input validation | zod schemas on every body, query and path parameter. Mapping paths block prototype-pollution keys. Body size limited to 512 KB. |
| Errors and logs | Clients get a generic message plus a request id; stack traces stay server-side. Authorization headers, cookies, signatures, passwords, tokens and keys are redacted by the logger. |
| Audit trail | Security-relevant and state-changing actions are recorded with actor, IP and request id. A database trigger rejects UPDATE and DELETE on the audit table. |
| Transport and browser | Helmet headers on the API. Dashboard sends a strict CSP (`default-src 'self'`, `frame-ancestors 'none'`), `X-Frame-Options: DENY`, `nosniff`, a restrictive Permissions-Policy, and self-hosts its fonts. Access tokens are kept in memory, never in localStorage. |
| Containers | Non-root user, read-only root filesystem, all capabilities dropped, `no-new-privileges`. |
| Supply chain | Lockfile installs (`npm ci`), `npm audit` gate in CI, Dependabot for npm, Actions and Docker, CodeQL, Gitleaks secret scanning. |

## Configuration you must set in production

- `JWT_ACCESS_SECRET` (32+ random characters) and `ENCRYPTION_KEY` (64 hex characters) from a secrets manager, never committed.
- `NODE_ENV=production`, which enforces HTTPS destinations and secure cookies and refuses `ALLOW_PRIVATE_DESTINATIONS`.
- TLS termination in front of the dashboard and API.
- Separate databases and secrets per environment (dev, staging, production).
