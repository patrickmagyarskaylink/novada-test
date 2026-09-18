-- 05-mcp-events-baseline.sql — LOCAL-ONLY baseline for the telemetry profile.
--
-- Why this file exists: hosted-server/migrations/2026-07-23-mcp-events-log-schema.sql
-- is an ALTER-only migration. Its own header says it "assumes mcp_events as created
-- by reports/novada-mcp-telemetry-schema-2026-07-15.sql" — a file that lives in the
-- owner's private reports/ tree, NOT in this repo. Without a baseline table the
-- migration aborts on its first `ALTER TABLE mcp_events` ("relation does not exist").
--
-- So this recreates the baseline from the authoritative in-repo contract: the
-- McpEventRow interface in hosted-server/vercel/api/_telemetry.ts (~line 214), which
-- is literally the JSON body POSTed to /rest/v1/mcp_events. Types are deliberately
-- permissive — the real migration adds the CHECK constraints, defaults, NOT NULLs and
-- indexes on top (every statement there is IF [NOT] EXISTS-guarded, so overlap is a
-- no-op).
--
-- This is a local test fixture. The production Supabase project is unaffected and
-- keeps its own baseline. If the two ever diverge, _telemetry.ts wins.

CREATE TABLE IF NOT EXISTS mcp_events (
  id                   bigserial PRIMARY KEY,
  -- `ts`, NOT `created_at`: the migration builds mcp_events_ts_brin on `ts` and
  -- reconcile-core.ts queries `ts=gte.…&order=ts.desc`. The name is part of the
  -- contract, not a preference.
  ts                   timestamptz NOT NULL DEFAULT now(),

  -- identity of the event
  event_type           text NOT NULL,
  request_id           text NOT NULL,

  -- caller (hashed / metadata only — never a plaintext key)
  token_hash           text,
  plan                 text,
  client_name          text,
  client_version       text,
  protocol_version     text,
  auth_method          text,
  user_agent           text,
  account_uid          text,
  hq_identity          text,
  key_version          text,

  -- what was called
  tool                 text,
  operation            text,
  arg_keys             text[],
  target_domain        text,
  product              text,

  -- how it went
  outcome              text,
  status_bucket        text,
  error_code           text,
  failure_class        text,
  retryable            boolean,
  rejection_stage      text,
  is_hosted_limitation boolean,
  gateway_ceiling_hit  boolean,
  latency_ms           integer,

  -- billing / quota
  charged              boolean,
  over_cap_allowed     boolean,
  quota_remaining      integer,

  -- provenance
  server_version       text,
  region               text,
  channel              text,

  -- push-worker owned
  pushed_at            timestamptz,
  push_status          text
);

-- PostgREST role grants. The gateway inserts with the JWT in TELEMETRY_SUPABASE_KEY;
-- anon/authenticated mirror the production INSERT-only intent described in the
-- 2026-07-23 migration's Section 5 — with one addition: SELECT is required too,
-- because _telemetry.ts sends `Prefer: resolution=ignore-duplicates`, which
-- PostgREST implements as INSERT ... ON CONFLICT DO NOTHING, and Postgres checks
-- SELECT privilege on the conflict target. Without it every insert fails 42501
-- ("permission denied for table mcp_events") — verified against this stack.
GRANT SELECT, INSERT, UPDATE ON mcp_events TO service_role;
GRANT SELECT, INSERT ON mcp_events TO anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE mcp_events_id_seq TO anon, authenticated, service_role;
