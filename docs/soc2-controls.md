# SOC 2 control mapping

HookRelay is a portfolio project, not an audited service. This document shows how its engineering practices map to the SOC 2 Trust Services Criteria (Security, plus parts of Availability and Confidentiality), and where the evidence for each control lives. It's the kind of document an engineering team maintains for its auditors.

## Logical access (CC6.1 – CC6.3)

| Control | Implementation | Evidence |
| --- | --- | --- |
| Unique user identification | Every user has a unique email and id; API keys are separately identified and attributed in the audit log | `migrations/001_init.sql` (`users`, `api_keys`) |
| Authentication strength | bcrypt cost 12, password policy, OAuth 2.0 + PKCE via GitHub | `modules/auth.ts`, `tests/integration/auth.test.ts` |
| Least privilege | Four roles with explicit permission sets; API keys limited to a safe scope subset | `lib/rbac.ts`, "RBAC matrix" unit tests |
| Privilege escalation prevention | Users can't grant or edit roles above their own; last owner protected | `modules/members.ts`, "never above their own role" test |
| Timely access removal | Disabling a user revokes all refresh tokens; role changes apply on the next request | "disabling a member blocks their tokens", "applies demotions immediately" tests |
| Session management | Short-lived access tokens, rotating refresh tokens, reuse detection revokes the session family, logout revokes server-side | "refresh token rotation" tests |
| Credential storage | Hashes for passwords, refresh tokens and API keys; AES-256-GCM for signing secrets; one-time display | `lib/crypto.ts`, "never exposes stored secrets" test |
| Tenant segregation | All data access filtered by `workspace_id` | "isolates tenants" test |

## System operations and monitoring (CC7.1 – CC7.3)

| Control | Implementation | Evidence |
| --- | --- | --- |
| Audit logging | Logins (success and failure), token reuse, member, key, source, destination and route changes, replays and rejected webhook signatures, with actor, IP and request id | `middleware/audit.ts`, Audit log page, CSV export |
| Log integrity | Database trigger makes `audit_logs` append-only, even for the database owner role used by the app | `001_init.sql`, "append-only audit trail" test |
| Security event detection | Rejected signatures, OAuth state mismatches and refresh-token reuse are recorded as distinct actions for alerting | audit actions `ingest.signature_rejected`, `auth.oauth_state_mismatch`, `auth.refresh_token_reuse` |
| Application logging | Structured JSON logs (pino) with request ids and credential redaction | `lib/logger.ts` |
| Operational monitoring | `/healthz` and `/readyz` probes; dashboard success rate, dead-letter counts and failing destinations; n8n error workflow and daily digest to Slack | `app.ts`, Overview page, `n8n/workflows/02`, `03` |

## Change management (CC8.1)

| Control | Implementation | Evidence |
| --- | --- | --- |
| Peer review | All changes through pull requests; CODEOWNERS requires owner review on security-sensitive paths | `.github/CODEOWNERS`, branch protection on `main` |
| Security review checklist | PR template requires confirming authz, tenant scoping, validation, audit logging, no secrets | `.github/pull_request_template.md` |
| Automated testing | Lint, typecheck, unit and integration tests against real Postgres on every PR | `.github/workflows/ci.yml` |
| Database changes | Forward-only, transactional, versioned migrations | `apps/api/migrations/`, `db/migrate.ts` |
| Environment separation | Configuration only through environment variables validated at startup; production refuses unsafe flags; separate databases and secrets per environment | `config/env.ts`, `SECURITY.md` |

## Risk mitigation and vulnerability management (CC3.2, CC7.1)

| Control | Implementation | Evidence |
| --- | --- | --- |
| Dependency scanning | `npm audit --audit-level=high` gate in CI; weekly Dependabot updates for npm, GitHub Actions and Docker base images | `ci.yml`, `.github/dependabot.yml` |
| Static analysis | CodeQL (security-extended) on every PR and weekly | `.github/workflows/codeql.yml` |
| Secret scanning | Gitleaks in CI; CI also rejects n8n workflow files containing credential-like strings | `ci.yml` |
| Secure coding (OWASP) | Input validation (A03), SSRF guard (A10), access control checks (A01), crypto at rest (A02), security headers (A05), audit logging (A09) | `lib/ssrf.ts`, `middleware/`, SSRF unit tests |

## Availability (A1.2)

| Control | Implementation |
| --- | --- |
| No lost events | Event and its deliveries are committed in a single transaction before `202` is returned |
| Resilient delivery | Exponential backoff with jitter, `Retry-After`, dead-letter queue and replay |
| Horizontal scale | Multiple workers claim work with `FOR UPDATE SKIP LOCKED` leases (tested with concurrent workers) |
| Graceful shutdown | API and worker drain in-flight work on `SIGTERM` |

## Confidentiality (C1.1)

| Control | Implementation |
| --- | --- |
| Data minimisation in logs | Response snippets stored per attempt are truncated to 500 characters; credentials are redacted from logs |
| Encryption in transit | HTTPS required for destinations in production; secure cookies in production |
| Encryption at rest | Webhook signing secrets encrypted with AES-256-GCM; database-level encryption expected from the hosting provider |

## Known gaps (would be addressed before a real audit)

- MFA for password sign-in (GitHub OAuth can enforce the provider's MFA today)
- Automated event retention and purge policy
- Centralised log shipping with retention guarantees (e.g. to a SIEM)
- Formal key-rotation procedure for `ENCRYPTION_KEY` (the ciphertext format is versioned to support it)
