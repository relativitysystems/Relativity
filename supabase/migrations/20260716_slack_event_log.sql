-- Migration: 20260716_slack_event_log
-- Architecture Review Phase 4, Milestone 4 — event-level idempotency and
-- durable processing state for the Slack app_mention Q&A path
-- (services/slackEventLogService.js, routes/integrations/slack.js POST
-- /events, /deliver, /sweep). Additive only; does not touch oauth_connections,
-- oauth_credentials, or oauth_states.
--
-- Design (see report §4.7-§4.8):
-- - Slack's event_id is the idempotency key. UNIQUE (provider,
--   external_event_id) is the sole dedup mechanism: the first delivery of a
--   given Slack event INSERTs and proceeds; every redelivery hits the unique
--   constraint, is caught by the application as a conflict, and the request
--   is ack'd 200 without any further processing or a second AIKB/Slack call.
--   Concurrent duplicate deliveries race on this same constraint at the
--   database level, so only one INSERT can ever win, even under a true race.
-- - status is a small state machine:
--     received  -> event verified, deduped, tenant-mapped, question
--                  extracted; Slack has been (or is about to be) ack'd.
--     enqueued  -> the fast accept-and-enqueue call to AIKB's POST
--                  /api/knowledge/ask succeeded (AIKB accepted the question
--                  onto its own Inngest pipeline).
--     answered  -> AIKB's callback (POST /api/integrations/slack/deliver)
--                  was accepted and claimed exclusively by ONE request via
--                  the conditional UPDATE ... WHERE status = 'enqueued'
--                  (the "only the first delivery attempt proceeds" guarantee
--                  from the report's flow diagram) — Slack delivery is now
--                  in progress.
--     delivered -> chat.postMessage succeeded. Terminal. Never reprocessed
--                  by any retry path, including the sweep.
--     failed    -> a terminal failure (AIKB error, Slack delivery failure)
--                  after attempt_count has exhausted the sweep's retry cap.
--                  Terminal; the sweep never retries a failed row past the cap.
-- - attempt_count / received_at / processing_started_at / completed_at /
--   failed_at give the Vercel Cron sweep (routes/integrations/slack.js POST
--   /sweep) enough state to find rows stuck in received/enqueued past a
--   timeout and retry them, bounded by a max attempt count, without ever
--   reprocessing a delivered row.
-- - error_code is a safe, internal string constant only (e.g.
--   'AIKB_TIMEOUT', 'SLACK_DELIVERY_FAILED') — never a raw provider error
--   string, stack trace, or any value that could leak a secret.
--
-- Tenant isolation note: consistent with oauth_connections/oauth_states,
-- isolation is enforced at the application layer (every query scoped by
-- client_id, resolved only from the trusted oauth_connections lookup — see
-- services/slackEventsService.js), not by Row-Level Security — this
-- repository has no established RLS pattern (tracked as a Should-Have, not
-- introduced here).
--
-- Safe to run multiple times (IF NOT EXISTS / CREATE ... IF NOT EXISTS
-- throughout). No destructive statements. Does not modify any existing table.

CREATE TABLE IF NOT EXISTS slack_event_log (
  id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  provider               text        NOT NULL DEFAULT 'slack' CHECK (provider = 'slack'),
  external_event_id      text        NOT NULL,
  client_id              uuid        NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  connection_id          uuid        NOT NULL REFERENCES oauth_connections(id) ON DELETE CASCADE,
  event_type             text        NOT NULL,
  channel_id             text        NOT NULL,
  event_ts               text        NOT NULL,
  thread_ts              text,
  question                text,
  idempotency_key        text        NOT NULL,
  status                 text        NOT NULL DEFAULT 'received'
                                        CHECK (status IN ('received','enqueued','answered','delivered','failed')),
  attempt_count          integer     NOT NULL DEFAULT 0,
  error_code             text,
  response_metadata      jsonb,
  received_at            timestamptz NOT NULL DEFAULT now(),
  processing_started_at  timestamptz,
  completed_at           timestamptz,
  failed_at              timestamptz,
  UNIQUE (provider, external_event_id)
);

-- Supports the sweep's "find rows stuck in received/enqueued past a
-- timeout" query without a sequential scan.
CREATE INDEX IF NOT EXISTS idx_slack_event_log_sweep
  ON slack_event_log (status, received_at)
  WHERE status IN ('received', 'enqueued');

-- Supports per-client audit/debugging lookups.
CREATE INDEX IF NOT EXISTS idx_slack_event_log_client_id
  ON slack_event_log (client_id, received_at DESC);

-- No scheduled cleanup job is added by this migration; received_at is kept
-- indefinitely as a small, low-cardinality audit trail (no message/answer
-- text is ever more sensitive than what already exists in Slack itself). An
-- operator can prune old rows manually if desired:
--   DELETE FROM slack_event_log WHERE received_at < now() - interval '90 days';
