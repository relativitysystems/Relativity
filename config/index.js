require('dotenv').config();

module.exports = {
  port: process.env.PORT || 3000,
  supabase: {
    url: process.env.GLOBAL_SUPABASE_URL,
    serviceKey: process.env.GLOBAL_SUPABASE_SERVICE_ROLE_KEY || process.env.GLOBAL_SUPABASE_SERVICE_KEY,
    anonKey: process.env.GLOBAL_SUPABASE_ANON_KEY,
  },
  dropbox: {
    appKey: process.env.DROPBOX_APP_KEY,
    appSecret: process.env.DROPBOX_APP_SECRET,
    redirectUri: process.env.DROPBOX_REDIRECT_URI,
    basePath: process.env.DROPBOX_BASE_PATH || '',
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
  googleDrive: {
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    redirectUri: process.env.GOOGLE_REDIRECT_URI,
    pickerApiKey: process.env.GOOGLE_PICKER_API_KEY,
  },
  appBaseUrl: process.env.APP_BASE_URL || 'http://localhost:3000',
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
