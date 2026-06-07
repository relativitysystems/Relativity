const { WebClient } = require('@slack/web-api');
const { slack } = require('../config');

const web = new WebClient(slack.botToken);

async function sendMessage(client, text) {
  const channel = client.slack_channel_id || slack.defaultChannel;
  if (!channel) throw new Error('No Slack channel configured for this client');
  await web.chat.postMessage({ channel, text });
}

module.exports = { sendMessage };
