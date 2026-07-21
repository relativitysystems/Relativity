require('dotenv').config();

module.exports = {
  port: process.env.PORT || 3000,
  supabase: {
    url: process.env.GLOBAL_SUPABASE_URL,
    serviceKey: process.env.GLOBAL_SUPABASE_SERVICE_ROLE_KEY || process.env.GLOBAL_SUPABASE_SERVICE_KEY,
    anonKey: process.env.GLOBAL_SUPABASE_ANON_KEY,
  },
  // Slack OAuth v2 (Architecture Review Phase 4, Milestone 3). appId/appSecret
  // (the old SLACK_APP_ID/SLACK_APP_SECRET vars) are gone along with the
  // retired /auth/slack/{start,callback} flow — see routes/auth.js.
  // signingSecret is read here for discoverability/future use (the Slack
  // Events endpoint, not built in this milestone); the OAuth connect/
  // callback flow itself does not use it.
  slack: {
    clientId: process.env.SLACK_CLIENT_ID,
    clientSecret: process.env.SLACK_CLIENT_SECRET,
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    redirectUri: process.env.SLACK_REDIRECT_URI,
    // Architecture Review Phase 4, Milestone 4 — max normalized question
    // length forwarded to AIKB from an app_mention (services/slackQuestionService.js).
    questionMaxLength: parseInt(process.env.SLACK_QUESTION_MAX_LENGTH || '2000', 10),
  },
  // Architecture Review Phase 4, Milestone 4 (§4.10) — a small, additive
  // HMAC-signed envelope scoped ONLY to POST /api/knowledge/ask (Relativity
  // -> AIKB) and POST /api/integrations/slack/deliver (AIKB -> Relativity,
  // reversed). Distinct from AIKB_API_KEY (unchanged, still gates every
  // other AIKB route) and from SLACK_SIGNING_SECRET (Slack<->Relativity
  // only). This is NOT the full future signed ServiceRequest envelope
  // (Phase 2 §10) — see services/serviceRequestAuth.js.
  serviceRequest: {
    signingSecret: process.env.SERVICE_REQUEST_SIGNING_SECRET,
  },
  // Provider-neutral OAuth credential encryption (starts with Slack, applies
  // to every future provider on oauth_connections/oauth_credentials).
  // Exposed here for discoverability/status checks only — the encryption
  // service (services/integrationCredentialEncryption.js) reads
  // process.env directly rather than this cached value, so a key rotation
  // or misconfiguration is caught at the moment of use, not only at
  // server-start time — see that file for details, including its
  // temporary deprecated fallback to SLACK_TOKEN_ENCRYPTION_KEY.
  integrationCredentials: {
    encryptionKey: process.env.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY,
  },
  // Google Drive Picker only (browser-side, one-shot copy import — see
  // routes/api.js's /google-drive/picker-config and /google-drive/import).
  // Backlog M15 removed the separate persistent-OAuth-connection flow that
  // used to also live here (clientSecret/redirectUri for a server-side
  // token exchange) — the Picker needs neither.
  googleDrive: {
    clientId: process.env.GOOGLE_CLIENT_ID,
    pickerApiKey: process.env.GOOGLE_PICKER_API_KEY,
  },
  appBaseUrl: process.env.APP_BASE_URL || 'http://localhost:3000',
  // Backlog M6 — explicit CORS allowlist (middleware/corsPolicy.js).
  // Comma-separated list of additional origins allowed to make
  // browser-based cross-origin requests to this API (e.g. a staging
  // domain). appBaseUrl is always allowed and does not need to be repeated
  // here.
  allowedOrigins: (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  email: {
    resendApiKey: process.env.RESEND_API_KEY,
    smtpHost: process.env.SMTP_HOST,
    smtpPort: parseInt(process.env.SMTP_PORT || '587', 10),
    smtpUser: process.env.SMTP_USER,
    smtpPass: process.env.SMTP_PASS,
    leadNotificationEmail: process.env.LEAD_NOTIFICATION_EMAIL,
    fromAddress: process.env.EMAIL_FROM || 'noreply@relativitysystems.ai',
  },
  aikb: {
    apiBaseUrl: process.env.AIKB_API_BASE_URL,
    apiKey: process.env.AIKB_API_KEY,
    supabaseUrl: process.env.AIKB_SUPABASE_URL,
    supabaseServiceRoleKey: process.env.AIKB_SUPABASE_SERVICE_ROLE_KEY,
    storageBucket: process.env.AIKB_STORAGE_BUCKET || 'aikb-documents',
    // Architecture Review Phase 4, Milestone 4 — timeout for the fast
    // accept-and-enqueue call to POST /api/knowledge/ask made synchronously
    // inside the Slack /events handler, before acking Slack (services/aikbAskClient.js).
    askTimeoutMs: parseInt(process.env.AIKB_ASK_TIMEOUT_MS || '4000', 10),
    // ADR-007 — best-effort callback to AIKB's POST /api/knowledge/chat/redact
    // once a Slack event reaches the terminal delivery_failed state
    // (services/aikbRedactClient.js). Deliberately short: this call happens
    // after the delivery outcome is already decided, never blocking it.
    redactTimeoutMs: parseInt(process.env.AIKB_REDACT_TIMEOUT_MS || '4000', 10),
  },
  // ADR-007 — bounded, immediate Slack delivery retries, replacing the
  // removed scheduled sweep (services/retryWithBackoff.js). Every retry
  // happens synchronously within the request/flow that triggered it; no
  // background job or scheduler ever revisits a Slack event. See
  // roadmap/FEATURE_BACKLOG.md item H5.
  slackDelivery: {
    maxAttempts: parseInt(process.env.SLACK_DELIVERY_MAX_ATTEMPTS || '3', 10),
    backoffMs: (process.env.SLACK_DELIVERY_BACKOFF_MS || '2000,5000')
      .split(',')
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n) && n >= 0),
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY,
  },
  limits: {
    maxDocuments: parseInt(process.env.MAX_DOCUMENTS || '50', 10),
    maxMonthlyQuestions: parseInt(process.env.MAX_MONTHLY_QUESTIONS || '500', 10),
    maxStorageMb: parseInt(process.env.MAX_STORAGE_MB || '500', 10),
    maxFileSizeMb: parseInt(process.env.MAX_FILE_SIZE_MB || '20', 10),
    maxAudioSizeMb: parseInt(process.env.MAX_AUDIO_SIZE_MB || '10', 10),
    maxZipSizeMb: parseInt(process.env.MAX_ZIP_SIZE_MB || '50', 10),
    maxZipFiles: parseInt(process.env.MAX_ZIP_FILES || '100', 10),
    maxZipEntryMb: parseInt(process.env.MAX_ZIP_ENTRY_MB || '20', 10),
    maxZipTotalMb: parseInt(process.env.MAX_ZIP_TOTAL_MB || '200', 10),
  },
};
