-- Migration: 20260717_slack_collection_access
-- Milestone 5: Slack Knowledge Collections (MVP).
--
-- Which AIKB knowledge_collections a client has allowed Slack to search —
-- organization-wide (client_id-scoped), never per-user/per-group, per this
-- milestone's explicit scope (no Groups/Roles/Identity Links/per-user ACLs).
-- A join table (one row per allowed collection) is used instead of a single
-- array column so it's the natural extension point for a future
-- principal_type/principal_id pair (per-group or per-user scoping) without
-- migrating off an array column later.
--
-- collection_id is a plain UUID with NO foreign key: it references a row in
-- AIKB's knowledge_collections table, which lives in a separate Supabase
-- project (AIKB, not Global) — cross-project foreign keys are not
-- supported, mirroring aikb/migrations/004_member_id.sql's member_id/
-- connection_id pattern (reversed direction here: this table stores a
-- reference INTO AIKB, not the other way around).
--
-- No RLS, consistent with every other table in this repo — see
-- 20260714_oauth_connections.sql's tenant-isolation note (app-layer +
-- service-role-key trust boundary only).
--
-- Safe to run multiple times (IF NOT EXISTS throughout).

CREATE TABLE IF NOT EXISTS slack_collection_access (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id     uuid        NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  collection_id uuid        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_slack_collection_access_client_collection
  ON slack_collection_access(client_id, collection_id);

CREATE INDEX IF NOT EXISTS idx_slack_collection_access_client_id
  ON slack_collection_access(client_id);
