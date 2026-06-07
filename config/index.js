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
  inngest: {
    eventKey: process.env.INNGEST_EVENT_KEY,
    signingKey: process.env.INNGEST_SIGNING_KEY,
  },
  slack: {
    botToken: process.env.SLACK_BOT_TOKEN,
    defaultChannel: process.env.SLACK_DEFAULT_CHANNEL,
  },
};
