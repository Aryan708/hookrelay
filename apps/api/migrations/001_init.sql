-- HookRelay initial schema
-- Multi-tenant: every business table is scoped by workspace_id.

CREATE TABLE workspaces (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email          text NOT NULL UNIQUE,
  name           text NOT NULL,
  password_hash  text,                       -- null for OAuth-only accounts
  role           text NOT NULL CHECK (role IN ('owner', 'admin', 'developer', 'viewer')),
  github_id      text UNIQUE,
  disabled_at    timestamptz,
  last_login_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX users_workspace_idx ON users (workspace_id);

-- Refresh tokens are stored hashed and rotated on every use.
-- family_id links a chain of rotations so token reuse can revoke the whole chain.
CREATE TABLE refresh_tokens (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id    uuid NOT NULL,
  token_hash   text NOT NULL UNIQUE,
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refresh_tokens_family_idx ON refresh_tokens (family_id);

-- API keys: only a SHA-256 hash and a short display prefix are stored.
CREATE TABLE api_keys (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name          text NOT NULL,
  prefix        text NOT NULL,
  key_hash      text NOT NULL UNIQUE,
  scopes        text[] NOT NULL,
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  expires_at    timestamptz,
  last_used_at  timestamptz,
  revoked_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX api_keys_workspace_idx ON api_keys (workspace_id);

-- Inbound webhook endpoints. The signing secret is encrypted at rest (AES-256-GCM).
CREATE TABLE sources (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name                  text NOT NULL,
  description           text,
  signing_secret_enc    text NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sources_workspace_idx ON sources (workspace_id);

-- Outbound targets (n8n webhook, CRM, Slack, any HTTP endpoint).
CREATE TABLE destinations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name                  text NOT NULL,
  url                   text NOT NULL,
  signing_secret_enc    text NOT NULL,
  timeout_ms            integer NOT NULL DEFAULT 10000 CHECK (timeout_ms BETWEEN 1000 AND 30000),
  max_attempts          integer NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 10),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX destinations_workspace_idx ON destinations (workspace_id);

-- A route connects a source to a destination, with optional filter conditions
-- and a field mapping that reshapes the payload before delivery.
CREATE TABLE routes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name            text NOT NULL,
  source_id       uuid NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  destination_id  uuid NOT NULL REFERENCES destinations(id) ON DELETE CASCADE,
  enabled         boolean NOT NULL DEFAULT true,
  filter          jsonb NOT NULL DEFAULT '[]'::jsonb,
  mapping         jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX routes_source_idx ON routes (source_id) WHERE enabled;

CREATE TABLE events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_id        uuid NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  idempotency_key  text,
  event_type       text NOT NULL,
  payload          jsonb NOT NULL,
  received_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX events_idempotency_idx ON events (source_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX events_workspace_received_idx ON events (workspace_id, received_at DESC);

CREATE TABLE deliveries (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  event_id         uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  route_id         uuid NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  destination_id   uuid NOT NULL REFERENCES destinations(id) ON DELETE CASCADE,
  status           text NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed', 'dead', 'skipped')),
  attempt_count    integer NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz,
  locked_until     timestamptz,
  last_status_code integer,
  last_error       text,
  completed_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX deliveries_due_idx ON deliveries (next_attempt_at) WHERE status = 'pending';
CREATE INDEX deliveries_event_idx ON deliveries (event_id);
CREATE INDEX deliveries_workspace_status_idx ON deliveries (workspace_id, status);

CREATE TABLE delivery_attempts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id       uuid NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  attempt_no        integer NOT NULL,
  status_code       integer,
  error             text,
  duration_ms       integer NOT NULL,
  response_snippet  text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX delivery_attempts_delivery_idx ON delivery_attempts (delivery_id);

-- Append-only audit trail (SOC 2 CC7.2 / CC8.1 evidence).
CREATE TABLE audit_logs (
  id             bigserial PRIMARY KEY,
  workspace_id   uuid,   -- deliberately no FK: audit history outlives deleted workspaces
  actor_type    text NOT NULL CHECK (actor_type IN ('user', 'api_key', 'system', 'anonymous')),
  actor_id       text,
  action         text NOT NULL,
  resource_type  text,
  resource_id    text,
  metadata       jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip             text,
  request_id     text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_workspace_idx ON audit_logs (workspace_id, id DESC);

CREATE FUNCTION audit_logs_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_logs_no_update
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_immutable();
