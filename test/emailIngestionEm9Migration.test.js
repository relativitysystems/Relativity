const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// EM9 — Member offboarding and policy reconciliation (Architecture/
// architecture/EMAIL_INGESTION.md §31). Static, text-level assertions
// against the migration's SQL, matching the convention established by
// test/emailIngestionEm1Migration.test.js / emailIngestionEm8Migration.test.js
// — no test-database pattern exists anywhere in this repo for any migration.

const EM9_MIGRATION_PATH = path.join(__dirname, '..', 'supabase', 'migrations', '20260725_email_ingestion_em9.sql');
const EM9_SQL = fs.readFileSync(EM9_MIGRATION_PATH, 'utf8');

test('offboard_client_member is defined as a re-runnable (CREATE OR REPLACE) PL/pgSQL function', () => {
  assert.match(
    EM9_SQL,
    /CREATE OR REPLACE FUNCTION offboard_client_member\(/,
    'offboard_client_member must be CREATE OR REPLACE, matching replace_active_oauth_connection\'s idempotent-migration precedent'
  );
  assert.match(EM9_SQL, /LANGUAGE plpgsql/, 'offboard_client_member must be a PL/pgSQL function');
});

test('offboard_client_member rejects any status other than disabled/revoked', () => {
  assert.match(
    EM9_SQL,
    /IF p_status NOT IN \('disabled', 'revoked'\) THEN\s*\n\s*RAISE EXCEPTION/,
    'offboard_client_member must reject a p_status that is not disabled or revoked'
  );
});

test('offboard_client_member updates client_members.status and email_connections.sync_enabled in the same function body (one transaction boundary)', () => {
  assert.match(
    EM9_SQL,
    /UPDATE client_members\s*\n\s*SET status = p_status/,
    'must update client_members.status'
  );
  assert.match(
    EM9_SQL,
    /UPDATE email_connections\s*\n\s*SET sync_enabled = false/,
    'must force email_connections.sync_enabled = false'
  );
  // §24.5 item 2 — sync_mode must never be touched by this function.
  const emailConnectionsUpdateMatch = EM9_SQL.match(/UPDATE email_connections\s*\n\s*SET sync_enabled = false[\s\S]*?WHERE member_id = p_member_id\s*\n\s*AND sync_enabled = true;/);
  assert.ok(emailConnectionsUpdateMatch, 'the email_connections UPDATE must be scoped to member_id + sync_enabled = true');
  assert.doesNotMatch(emailConnectionsUpdateMatch[0], /sync_mode/, 'offboarding must never overwrite sync_mode (§24.5 item 2)');
});

test('email_ingestion_events.outcome gains tombstoned_policy_change, widened via DROP+ADD CONSTRAINT (idempotent)', () => {
  assert.match(
    EM9_SQL,
    /ALTER TABLE email_ingestion_events\s*\n\s*DROP CONSTRAINT IF EXISTS email_ingestion_events_outcome_check;/,
    'must drop the old constraint IF EXISTS before recreating it'
  );
  assert.match(EM9_SQL, /'tombstoned_policy_change'/, 'the widened CHECK must include tombstoned_policy_change');
  // Every pre-existing outcome value must still be present — this is a
  // widen, not a replace.
  for (const outcome of [
    'ingested', 'excluded_no_matching_rule', 'excluded_deny_listed',
    'excluded_not_labeled', 'duplicate', 'skipped_size_limit', 'failed',
    'tombstoned_label_removed',
  ]) {
    assert.match(EM9_SQL, new RegExp(`'${outcome}'`), `must preserve pre-existing outcome value '${outcome}'`);
  }
});

test('the migration touches no other table and drops nothing destructively', () => {
  const alterStatements = Array.from(new Set(EM9_SQL.match(/ALTER TABLE \w+/g) || []));
  assert.deepEqual(
    alterStatements.sort(),
    ['ALTER TABLE email_ingestion_events'],
    'EM9 should only ever ALTER email_ingestion_events (the constraint widen) — the client_members/email_connections writes live inside the function body, not as migration-level ALTERs'
  );
  assert.doesNotMatch(EM9_SQL, /DROP TABLE/i, 'EM9 must not drop a table');
  assert.doesNotMatch(EM9_SQL, /DROP COLUMN/i, 'EM9 must not drop a column');
});
