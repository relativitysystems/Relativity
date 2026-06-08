require('dotenv').config();

module.exports = {
  port: process.env.PORT || 3000,
  supabase: {
    url: process.env.SUPABASE_URL,
    serviceKey: process.env.SUPABASE_SERVICE_KEY,
    anonKey: process.env.SUPABASE_ANON_KEY,
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
};
