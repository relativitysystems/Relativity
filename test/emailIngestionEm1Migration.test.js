const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// EM1 — Multi-member schema foundation (Architecture/architecture/
// EMAIL_INGESTION.md §13.1, §28, §31). EM1 ships schema only — no service
// layer exists yet to exercise against a fake DI'd Supabase client the way
// test/oauthConnectionsService.test.js does for the original oauth_connections
// migration. Consistent with this repo's existing convention (that same
// file's "Migration <-> service consistency" section, and its total absence
// of any live-database test anywhere in test/*.test.js), this file proves
// the migration's invariants by parsing the actual migration SQL rather
// than hardcoding a second copy of it or standing up a real Postgres
// instance — a silent drift between this file and the migration fails a
// test instead of only surfacing as an opaque Postgres error later.
//
// Limitation, stated plainly: these are static, text-level assertions
// against the migration's SQL, not an executed-against-a-real-database
// proof. This repo has no test-database pattern for any existing migration
// (confirmed: 20260714_oauth_connections.sql's own test file uses the same
// approach). A live-database run of this migration (fresh DB, and against
// the current pre-EM1 schema) was performed manually as part of this
// change's verification — see the implementation summary — but is not
// itself part of the automated suite, matching how every other migration
// in this repo is tested today.

const EM1_MIGRATION_PATH = path.join(__dirname, '..', 'supabase', 'migrations', '20260723_email_ingestion_em1.sql');
const EM1_SQL = fs.readFileSync(EM1_MIGRATION_PATH, 'utf8');

const ORIGINAL_OAUTH_MIGRATION_PATH = path.join(__dirname, '..', 'supabase', 'migrations', '20260714_oauth_connections.sql');
const ORIGINAL_OAUTH_SQL = fs.readFileSync(ORIGINAL_OAUTH_MIGRATION_PATH, 'utf8');

function parseQuotedList(sql, pattern) {
  const match = sql.match(pattern);
  assert.ok(match, `pattern ${pattern} did not match anything — the migration may have been edited`);
  return match[1].split(',').map(s => s.trim().replace(/^'|'$/g, ''));
}

// ─────────────────────────────────────────────
// client_members.search_enabled — additive, safe for all existing rows
// ─────────────────────────────────────────────

test('client_members.search_enabled is additive: ADD COLUMN IF NOT EXISTS with a NOT NULL DEFAULT true, so every existing row gets true automatically', () => {
  assert.match(
    EM1_SQL,
    /ALTER TABLE client_members\s*\n\s*ADD COLUMN IF NOT EXISTS search_enabled boolean NOT NULL DEFAULT true;/,
    'search_enabled must be ADD COLUMN IF NOT EXISTS ... NOT NULL DEFAULT true — a DEFAULT is required for a NOT NULL column added to a table with existing rows to backfill safely'
  );
});

// ─────────────────────────────────────────────
// oauth_connections uniqueness relaxation — provider-partitioned, not a
// single blanket relaxation, so Slack/Drive/Dropbox behavior is preserved
// byte-for-byte while gmail/microsoft become per-member.
// ─────────────────────────────────────────────

test('the old single-active-per-client-provider index is dropped', () => {
  assert.match(EM1_SQL, /DROP INDEX IF EXISTS uq_oauth_connections_active_per_client_provider;/);
});

test('the legacy partial unique index preserves exactly (client_id, provider) scoping for every non-email provider', () => {
  assert.match(
    EM1_SQL,
    /CREATE UNIQUE INDEX IF NOT EXISTS uq_oauth_connections_active_per_client_provider_legacy\s*\n\s*ON oauth_connections\(client_id, provider\)\s*\n\s*WHERE status = 'active' AND provider NOT IN \('gmail', 'microsoft'\);/,
    'the legacy index must exclude gmail/microsoft and otherwise be identical to the original (client_id, provider) index, so Slack/Drive/Dropbox reconnect semantics are unchanged'
  );
});

test('the member-scoped partial unique index adds connected_by_member_id to the key, only for gmail/microsoft', () => {
  assert.match(
    EM1_SQL,
    /CREATE UNIQUE INDEX IF NOT EXISTS uq_oauth_connections_active_per_client_provider_member\s*\n\s*ON oauth_connections\(client_id, provider, connected_by_member_id\)\s*\n\s*WHERE status = 'active' AND provider IN \('gmail', 'microsoft'\);/,
    'the member-scoped index must key on (client_id, provider, connected_by_member_id) and be restricted to gmail/microsoft only'
  );
});

test('every provider is covered by exactly one of the two partial indexes (their WHERE clauses are exact complements)', () => {
  assert.match(EM1_SQL, /provider NOT IN \('gmail', 'microsoft'\)/);
  assert.match(EM1_SQL, /provider IN \('gmail', 'microsoft'\)/);
});

test('connected_by_member_id is required for gmail/microsoft via a conditional CHECK, not a global NOT NULL', () => {
  assert.match(
    EM1_SQL,
    /ADD CONSTRAINT chk_oauth_connections_member_required_for_email\s*\n\s*CHECK \(provider NOT IN \('gmail', 'microsoft'\) OR connected_by_member_id IS NOT NULL\);/,
    'the member requirement for gmail/microsoft must be a conditional CHECK, leaving the column nullable for every other provider'
  );
  // Explicitly must NOT contain a blanket "ALTER COLUMN connected_by_member_id SET NOT NULL" anywhere.
  assert.equal(
    /ALTER COLUMN connected_by_member_id SET NOT NULL/.test(EM1_SQL),
    false,
    'must never make connected_by_member_id NOT NULL globally — Slack/legacy rows are entitled to leave it null'
  );
});

test('the CHECK constraint addition is guarded so re-running the migration is a no-op', () => {
  assert.match(EM1_SQL, /SELECT 1 FROM pg_constraint WHERE conname = 'chk_oauth_connections_member_required_for_email'/);
});

// ─────────────────────────────────────────────
// replace_active_oauth_connection — backward-compatible signature,
// provider-branched revoke scope
// ─────────────────────────────────────────────

test('replace_active_oauth_connection keeps the exact same parameter list as the original migration (no signature change)', () => {
  const originalParams = [...ORIGINAL_OAUTH_SQL.matchAll(/CREATE OR REPLACE FUNCTION replace_active_oauth_connection\(([\s\S]*?)\)\s*\nRETURNS/g)]
    .map(m => [...m[1].matchAll(/\b(p_[a-z_]+)\b/g)].map(x => x[1]))[0];
  const em1Params = [...EM1_SQL.matchAll(/CREATE OR REPLACE FUNCTION replace_active_oauth_connection\(([\s\S]*?)\)\s*\nRETURNS/g)]
    .map(m => [...m[1].matchAll(/\b(p_[a-z_]+)\b/g)].map(x => x[1]))[0];

  assert.ok(originalParams && originalParams.length > 0, 'could not parse the original function signature');
  assert.ok(em1Params && em1Params.length > 0, 'could not parse the EM1 function signature');
  assert.deepEqual(em1Params.sort(), originalParams.sort());
});

test('the RPC raises a clear exception rather than silently inserting a memberless gmail/microsoft row', () => {
  assert.match(
    EM1_SQL,
    /IF p_provider IN \('gmail', 'microsoft'\) AND p_connected_by_member_id IS NULL THEN\s*\n\s*RAISE EXCEPTION/
  );
});

test('gmail/microsoft revoke branch scopes by client + provider + connected_by_member_id (member A cannot revoke member B)', () => {
  const branchMatch = EM1_SQL.match(/IF p_provider IN \('gmail', 'microsoft'\) THEN([\s\S]*?)ELSE([\s\S]*?)END IF;/);
  assert.ok(branchMatch, 'could not find the provider-branched revoke logic');
  const [, gmailBranch, legacyBranch] = branchMatch;

  assert.match(gmailBranch, /AND connected_by_member_id = p_connected_by_member_id/, 'the gmail/microsoft branch must scope the revoke UPDATE by connected_by_member_id');
  assert.match(gmailBranch, /WHERE client_id = p_client_id/);
  assert.match(gmailBranch, /AND provider = p_provider/);

  // The legacy branch must NOT filter by member — this is what preserves
  // "any admin's Slack reconnect replaces the client's one active Slack
  // connection" instead of leaving the previous admin's row active.
  assert.equal(
    /connected_by_member_id/.test(legacyBranch),
    false,
    'the legacy (non-email) branch must not scope by connected_by_member_id, or a different member reconnecting Slack would stop replacing the prior connection'
  );
  assert.match(legacyBranch, /WHERE client_id = p_client_id/);
  assert.match(legacyBranch, /AND provider = p_provider/);
});

test('both revoke branches only ever touch active rows for the given client + provider (never cross-client)', () => {
  const clientScopedOccurrences = [...EM1_SQL.matchAll(/WHERE client_id = p_client_id\s*\n\s*AND provider = p_provider/g)];
  assert.equal(clientScopedOccurrences.length, 2, 'expected exactly two client+provider-scoped UPDATE clauses (one per branch)');
});

// ─────────────────────────────────────────────
// email_connections
// ─────────────────────────────────────────────

test('email_connections.provider CHECK constraint is exactly gmail/microsoft', () => {
  const match = EM1_SQL.match(/CREATE TABLE IF NOT EXISTS email_connections[\s\S]*?CHECK \(provider IN \(([^)]+)\)\)/);
  assert.ok(match, 'could not find email_connections.provider CHECK constraint');
  const values = match[1].split(',').map(s => s.trim().replace(/^'|'$/g, ''));
  assert.deepEqual(values.sort(), ['gmail', 'microsoft']);
});

test('email_connections.sync_mode CHECK constraint matches the documented three modes, defaulting to manual_selected', () => {
  assert.match(EM1_SQL, /sync_mode\s+text\s+NOT NULL DEFAULT 'manual_selected'/);
  const match = EM1_SQL.match(/CHECK \(sync_mode IN \(([^)]+)\)\)/);
  assert.ok(match);
  const values = match[1].split(',').map(s => s.trim().replace(/^'|'$/g, ''));
  assert.deepEqual(values.sort(), ['automatic', 'manual_selected', 'paused'].sort());
});

test('email_connections.historical_import_status CHECK constraint matches the documented four statuses', () => {
  const match = EM1_SQL.match(/CHECK \(historical_import_status IN \(([^)]+)\)\)/);
  assert.ok(match);
  const values = match[1].split(',').map(s => s.trim().replace(/^'|'$/g, ''));
  assert.deepEqual(values.sort(), ['completed', 'failed', 'not_started', 'running'].sort());
});

test('email_connections.member_id is required (NOT NULL) and ON DELETE RESTRICT, not CASCADE/SET NULL', () => {
  assert.match(
    EM1_SQL,
    /member_id\s+uuid\s+NOT NULL REFERENCES client_members\(id\) ON DELETE RESTRICT/,
    'member_id must be a required, RESTRICT-on-delete FK — members are soft-deleted in this codebase, so a hard delete is not an expected path this table absorbs'
  );
});

test('email_connections.oauth_connection_id is 1:1 (UNIQUE) with oauth_connections', () => {
  assert.match(EM1_SQL, /oauth_connection_id\s+uuid\s+NOT NULL REFERENCES oauth_connections\(id\) ON DELETE CASCADE/);
  assert.match(EM1_SQL, /UNIQUE \(oauth_connection_id\)/);
});

test('email_connections.sync_enabled defaults to true', () => {
  assert.match(EM1_SQL, /sync_enabled\s+boolean\s+NOT NULL DEFAULT true/);
});

// ─────────────────────────────────────────────
// email_organization_settings
// ─────────────────────────────────────────────

test('email_organization_settings.automatic_sync_enabled defaults to false (fail closed)', () => {
  assert.match(EM1_SQL, /automatic_sync_enabled\s+boolean\s+NOT NULL DEFAULT false/);
});

test('email_organization_settings is one row per client (client_id is the primary key)', () => {
  assert.match(EM1_SQL, /CREATE TABLE IF NOT EXISTS email_organization_settings \(\s*\n\s*client_id\s+uuid\s+PRIMARY KEY REFERENCES clients\(id\) ON DELETE CASCADE/);
});

// ─────────────────────────────────────────────
// email_ingestion_rules
// ─────────────────────────────────────────────

test('email_ingestion_rules is client-scoped, not connection-scoped (no email_connection_id column anywhere in its definition)', () => {
  const tableMatch = EM1_SQL.match(/CREATE TABLE IF NOT EXISTS email_ingestion_rules \(([\s\S]*?)\);/);
  assert.ok(tableMatch);
  assert.equal(/email_connection_id/.test(tableMatch[1]), false, 'organization policy must be authored once per client, not per connection');
  assert.match(tableMatch[1], /client_id\s+uuid\s+NOT NULL REFERENCES clients\(id\) ON DELETE CASCADE/);
});

test('email_ingestion_rules.rule_type CHECK constraint is exactly allow/deny', () => {
  const match = EM1_SQL.match(/CHECK \(rule_type IN \(([^)]+)\)\)/);
  assert.ok(match);
  assert.deepEqual(match[1].split(',').map(s => s.trim().replace(/^'|'$/g, '')).sort(), ['allow', 'deny']);
});

test('email_ingestion_rules.max_historical_days is bounded (0, 730] and defaults to 90', () => {
  assert.match(EM1_SQL, /max_historical_days\s+integer\s+NOT NULL DEFAULT 90/);
  assert.match(EM1_SQL, /CHECK \(max_historical_days > 0 AND max_historical_days <= 730\)/);
});

test('email_ingestion_rules.destination_collection_id has no foreign key (cross-project reference into AIKB)', () => {
  assert.match(EM1_SQL, /destination_collection_id uuid,\s*--.*cross-project/);
});

test('email_ingestion_rules.enabled defaults to true, and the client index is partial on enabled rows', () => {
  assert.match(EM1_SQL, /enabled\s+boolean\s+NOT NULL DEFAULT true/);
  assert.match(EM1_SQL, /idx_email_ingestion_rules_client_id\s*\n\s*ON email_ingestion_rules\(client_id\) WHERE enabled = true;/);
});

// ─────────────────────────────────────────────
// email_sync_state
// ─────────────────────────────────────────────

test('email_sync_state is one row per connection (UNIQUE email_connection_id) with a bounded cursor_status', () => {
  assert.match(EM1_SQL, /UNIQUE \(email_connection_id\)/);
  const match = EM1_SQL.match(/CHECK \(cursor_status IN \(([^)]+)\)\)/);
  assert.ok(match);
  assert.deepEqual(match[1].split(',').map(s => s.trim().replace(/^'|'$/g, '')).sort(), ['expired', 'none', 'valid'].sort());
});

// ─────────────────────────────────────────────
// email_sync_runs
// ─────────────────────────────────────────────

test('email_sync_runs.run_type and status CHECK constraints match the documented enums', () => {
  const runTypeMatch = EM1_SQL.match(/CHECK \(run_type IN \(([^)]+)\)\)/);
  assert.ok(runTypeMatch);
  assert.deepEqual(runTypeMatch[1].split(',').map(s => s.trim().replace(/^'|'$/g, '')).sort(), ['historical', 'incremental', 'manual'].sort());

  const statusMatch = EM1_SQL.match(/CREATE TABLE IF NOT EXISTS email_sync_runs[\s\S]*?CHECK \(status IN \(([^)]+)\)\)/);
  assert.ok(statusMatch);
  assert.deepEqual(statusMatch[1].split(',').map(s => s.trim().replace(/^'|'$/g, '')).sort(), ['completed', 'failed', 'partial', 'running'].sort());
});

test('email_sync_runs carries client_id directly (not only reachable via a join) for tenant-isolation queries', () => {
  assert.match(EM1_SQL, /CREATE TABLE IF NOT EXISTS email_sync_runs \(\s*\n\s*id\s+uuid\s+PRIMARY KEY DEFAULT gen_random_uuid\(\),\s*\n\s*client_id\s+uuid\s+NOT NULL REFERENCES clients\(id\) ON DELETE CASCADE/);
});

// ─────────────────────────────────────────────
// email_ingestion_events
// ─────────────────────────────────────────────

test('email_ingestion_events.outcome CHECK constraint includes exactly the eight documented outcomes', () => {
  const match = EM1_SQL.match(/CHECK \(outcome IN\s*\n\s*\(([^)]+(?:\)[^)]*)*)\)\)/);
  assert.ok(match, 'could not find the outcome CHECK constraint');
  const values = match[1].split(',').map(s => s.trim().replace(/^'|'$/g, ''));
  assert.deepEqual(
    values.sort(),
    [
      'ingested', 'excluded_no_matching_rule', 'excluded_deny_listed', 'excluded_not_labeled',
      'duplicate', 'skipped_size_limit', 'failed', 'tombstoned_label_removed',
    ].sort()
  );
});

test('email_ingestion_events.sync_run_id is nullable (reconciliation events not tied to a sync run)', () => {
  assert.match(EM1_SQL, /sync_run_id\s+uuid\s+REFERENCES email_sync_runs\(id\) ON DELETE CASCADE,/);
  assert.equal(/sync_run_id\s+uuid\s+NOT NULL/.test(EM1_SQL), false);
});

test('email_ingestion_events.ingested_document_id has no foreign key (cross-project reference into AIKB)', () => {
  assert.match(EM1_SQL, /ingested_document_id\s+uuid,\s*--.*cross-project/);
});

test('email_ingestion_events never declares a subject/body column — technical metadata only', () => {
  const tableMatch = EM1_SQL.match(/CREATE TABLE IF NOT EXISTS email_ingestion_events \(([\s\S]*?)\);/);
  assert.ok(tableMatch);
  assert.equal(/\bsubject\b|\bbody\b/i.test(tableMatch[1]), false, 'email_ingestion_events must never store subject/body content');
});

// ─────────────────────────────────────────────
// Cross-cutting: no cross-project foreign keys, no RLS introduced
// ─────────────────────────────────────────────

test('no CREATE POLICY / ENABLE ROW LEVEL SECURITY is introduced by this migration', () => {
  assert.equal(/CREATE POLICY|ENABLE ROW LEVEL SECURITY/.test(EM1_SQL), false);
});

test('every new client-scoped table has client_id NOT NULL REFERENCES clients(id) ON DELETE CASCADE, except email_organization_settings whose PK is client_id', () => {
  for (const table of ['email_connections', 'email_ingestion_rules', 'email_sync_runs']) {
    const tableMatch = EM1_SQL.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\);`));
    assert.ok(tableMatch, `could not find ${table} definition`);
    assert.match(tableMatch[1], /client_id\s+uuid\s+NOT NULL REFERENCES clients\(id\) ON DELETE CASCADE/, `${table} must have a direct client_id FK`);
  }
});
