## What changed and why

<!-- Link the issue. Describe the change in a sentence or two. -->

## How it was tested

- [ ] Unit / integration tests added or updated
- [ ] `npm run lint`, `npm run typecheck` and `npm test` pass locally

## Security & compliance checklist (SOC 2 change management)

- [ ] No secrets, tokens or credentials in code, tests, fixtures or logs
- [ ] New endpoints enforce authentication **and** a specific permission (`requirePermission`)
- [ ] Queries are scoped to the caller's `workspace_id` (tenant isolation)
- [ ] User input is validated with a zod schema
- [ ] State-changing actions write an audit log entry
- [ ] Schema changes ship as a new forward-only migration
- [ ] Dependencies added are necessary and actively maintained

Reviewer: approve only after checking the list above.
