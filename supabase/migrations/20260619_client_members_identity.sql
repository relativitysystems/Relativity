-- Migration: 20260619_client_members_identity
-- Adds indexes to support client_members as the portal identity source.
-- Safe to run multiple times where possible.

-- Enforce current product rule:
-- one Supabase Auth user belongs to one client member record.
CREATE UNIQUE INDEX IF NOT EXISTS idx_client_members_auth_user_unique
  ON public.client_members(auth_user_id)
  WHERE auth_user_id IS NOT NULL;

-- Prevent duplicate active/invited users within the same client.
-- Allows old revoked/disabled rows to remain without blocking future re-invites.
CREATE UNIQUE INDEX IF NOT EXISTS idx_client_members_email_active_unique
  ON public.client_members(client_id, lower(email))
  WHERE status NOT IN ('disabled', 'revoked');

-- client_users is intentionally NOT dropped here.
-- Drop it in a follow-up migration after the refactor is confirmed in production.
