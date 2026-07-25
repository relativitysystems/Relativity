const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// EM8 — Automatic sync scheduler (Architecture/architecture/
// EMAIL_INGESTION.md §31). Static, text-level assertions against the
// migration's SQL, matching the convention established by
// test/emailIngestionEm1Migration.test.js — no test-database pattern exists
// anywhere in this repo for any migration.

const EM8_MIGRATION_PATH = path.join(__dirname, '..', 'supabase', 'migrations', '20260725_email_ingestion_em8.sql');
const EM8_SQL = fs.readFileSync(EM8_MIGRATION_PATH, 'utf8');

test('email_connections.pre_pause_sync_mode is additive: ADD COLUMN IF NOT EXISTS, nullable (no NOT NULL/DEFAULT — a connection that has never been paused should have no value)', () => {
  assert.match(
    EM8_SQL,
    /ALTER TABLE email_connections\s*\n\s*ADD COLUMN IF NOT EXISTS pre_pause_sync_mode TEXT;/,
    'pre_pause_sync_mode must be ADD COLUMN IF NOT EXISTS TEXT with no NOT NULL constraint'
  );
});

test('the migration is idempotent (IF NOT EXISTS) and touches no other table', () => {
  const alterStatements = EM8_SQL.match(/ALTER TABLE \w+/g) || [];
  assert.deepEqual(alterStatements, ['ALTER TABLE email_connections'], 'EM8 should only ever alter email_connections');
  assert.doesNotMatch(EM8_SQL, /DROP (TABLE|COLUMN)/i, 'EM8 must not drop anything — additive only');
});
