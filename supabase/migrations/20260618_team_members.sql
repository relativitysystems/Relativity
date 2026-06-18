-- Migration: 20260618_team_members
-- Adds multi-member team support to the client portal.
-- Safe to run multiple times (uses IF NOT EXISTS / ON CONFLICT DO NOTHING).

-- ─────────────────────────────────────────────
-- 1. Add seat limit to clients
-- ─────────────────────────────────────────────
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS max_members integer NOT NULL DEFAULT 10;

-- ─────────────────────────────────────────────
-- 2. client_members
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS client_members (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id     uuid        NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  auth_user_id  uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  email         text        NOT NULL,
  full_name     text,
  role          text        NOT NULL DEFAULT 'member'
                              CHECK (role IN ('owner','admin','member','viewer')),
  status        text        NOT NULL DEFAULT 'invited'
                              CHECK (status IN ('invited','active','disabled','revoked')),
  invited_by    uuid        REFERENCES client_members(id) ON DELETE SET NULL,
  invited_at    timestamptz,
  accepted_at   timestamptz,
  last_active_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, auth_user_id)
);

CREATE INDEX IF NOT EXISTS idx_client_members_client_id  ON client_members(client_id);
CREATE INDEX IF NOT EXISTS idx_client_members_auth_user  ON client_members(auth_user_id);

-- ─────────────────────────────────────────────
-- 3. team_invites
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS team_invites (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id   uuid        NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  email       text        NOT NULL,
  role        text        NOT NULL DEFAULT 'member'
                            CHECK (role IN ('admin','member','viewer')),
  token       text        UNIQUE NOT NULL,
  expires_at  timestamptz NOT NULL,
  accepted_at timestamptz,
  revoked_at  timestamptz,
  invited_by  uuid        REFERENCES client_members(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_team_invites_token      ON team_invites(token);
CREATE INDEX IF NOT EXISTS idx_team_invites_client_id  ON team_invites(client_id);

-- ─────────────────────────────────────────────
-- 4. client_member_sessions  (local mapping: AIKB session → member)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS client_member_sessions (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id       uuid        NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  member_id       uuid        NOT NULL REFERENCES client_members(id) ON DELETE CASCADE,
  aikb_session_id text        NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, aikb_session_id)
);

CREATE INDEX IF NOT EXISTS idx_cms_member_id  ON client_member_sessions(member_id);

-- ─────────────────────────────────────────────
-- 5. Backfill existing client_users → client_members (role = owner)
-- ─────────────────────────────────────────────
INSERT INTO client_members
  (client_id, auth_user_id, email, role, status, accepted_at, created_at, updated_at)
SELECT
  cu.client_id,
  cu.auth_user_id,
  cu.email,
  'owner',
  'active',
  now(),
  now(),
  now()
FROM client_users cu
ON CONFLICT (client_id, auth_user_id) DO NOTHING;
