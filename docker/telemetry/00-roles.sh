#!/bin/sh
# 00-roles.sh — local-only bootstrap for the telemetry profile.
#
# The production migrations in hosted-server/migrations/ are written against
# Supabase, which pre-creates the PostgREST role trio (anon, authenticated,
# service_role) plus the `authenticator` login role PostgREST connects as.
# Plain postgres:16 has none of them, so those migrations would fail on their
# GRANT / REVOKE / CREATE POLICY statements. This runs first and creates them.
#
# LOCAL DEV ONLY. Roles are deliberately permissive and the password is the
# compose POSTGRES_PASSWORD. Never point this at a real database.
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
     -v pw="$POSTGRES_PASSWORD" <<'EOSQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')          THEN CREATE ROLE anon          NOLOGIN NOINHERIT; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN NOINHERIT; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role')  THEN CREATE ROLE service_role  NOLOGIN NOINHERIT BYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticator') THEN CREATE ROLE authenticator LOGIN NOINHERIT; END IF;
END
$$;

-- PostgREST logs in as `authenticator`, then SET ROLE to anon / authenticated /
-- service_role according to the `role` claim in the request JWT.
ALTER ROLE authenticator WITH PASSWORD :'pw';
GRANT anon, authenticated, service_role TO authenticator;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
EOSQL
