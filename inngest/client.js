const { Inngest } = require('inngest');
const { inngest: inngestConfig } = require('../config');

const inngest = new Inngest({
  id: 'relativity-systems',
  eventKey: inngestConfig.eventKey,
});

module.exports = { inngest };
