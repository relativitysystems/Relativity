-- Migration: 20260719_hash_team_invite_tokens
-- Backlog M2 — team_invites.token was stored in plaintext, unlike the
-- hash-only pattern already established for OAuth state
-- (supabase/migrations/20260715_oauth_states.sql). A leaked/read-access
-- to this table alone was previously enough to redeem any outstanding
-- invite; hashing closes that off the same way the OAuth-state migration
-- did for connect-flow CSRF tokens.
--
-- Design: identical hash function/encoding to oauthStateService.js
-- (SHA-256, hex-encoded), computed here via pgcrypto's digest() purely for
-- this one-time backfill of pre-existing plaintext rows — all future writes
-- hash in application code (services/supabaseService.js) before ever
-- reaching a query, exactly like oauthStateService.js does. The raw token
-- itself is still generated the same way (routes/team.js#generateToken,
-- 32 random bytes hex) and still emailed/URL'd to the invitee — only its
-- at-rest storage changes.
--
-- Safe to run multiple times (IF NOT EXISTS / idempotent backfill).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE team_invites
  ADD COLUMN IF NOT EXISTS token_hash text;

-- One-time backfill for any pre-existing plaintext rows.
UPDATE team_invites
   SET token_hash = encode(digest(token, 'sha256'), 'hex')
 WHERE token_hash IS NULL
   AND token IS NOT NULL;

ALTER TABLE team_invites
  ALTER COLUMN token_hash SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_team_invites_token_hash ON team_invites(token_hash);

DROP INDEX IF EXISTS idx_team_invites_token;

-- Plaintext token is no longer needed once every row has a backfilled hash
-- — application code (services/supabaseService.js) never writes or reads
-- this column after this migration.
ALTER TABLE team_invites DROP COLUMN IF EXISTS token;
