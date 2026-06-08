const axios = require('axios');
const { slack } = require('../config');

async function exchangeCodeForToken(code) {
  const params = new URLSearchParams({
    code,
    redirect_uri: slack.redirectUri,
  });

  const response = await axios.post(
    'https://slack.com/api/oauth.v2.access',
    params.toString(),
    {
      auth: { username: slack.appId, password: slack.appSecret },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    }
  );

  if (!response.data.ok) {
    throw new Error(`Slack OAuth failed: ${response.data.error}`);
  }

  return response.data;
}

module.exports = { exchangeCodeForToken };
