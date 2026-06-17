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
  slack: {
    appId: process.env.SLACK_APP_ID,
    appSecret: process.env.SLACK_APP_SECRET,
    redirectUri: process.env.SLACK_REDIRECT_URI,
  },
  googleDrive: {
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    redirectUri: process.env.GOOGLE_REDIRECT_URI,
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
  limits: {
    maxDocuments: parseInt(process.env.MAX_DOCUMENTS || '50', 10),
    maxMonthlyQuestions: parseInt(process.env.MAX_MONTHLY_QUESTIONS || '500', 10),
    maxStorageMb: parseInt(process.env.MAX_STORAGE_MB || '500', 10),
    maxFileSizeMb: parseInt(process.env.MAX_FILE_SIZE_MB || '20', 10),
  },
};
