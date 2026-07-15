const test = require('node:test');
const assert = require('node:assert/strict');
const { extractQuestion, EMPTY_QUESTION_REPLY } = require('../services/slackQuestionService');

const BOT_ID = 'U0BOT123';

test('strips the leading bot mention and trims whitespace', () => {
  const result = extractQuestion(`<@${BOT_ID}>   What is our PTO policy?`, BOT_ID);
  assert.equal(result.ok, true);
  assert.equal(result.question, 'What is our PTO policy?');
});

test('strips a leading mention with a display-name suffix (<@ID|label>)', () => {
  const result = extractQuestion(`<@${BOT_ID}|RelativityBot> What is our PTO policy?`, BOT_ID);
  assert.equal(result.ok, true);
  assert.equal(result.question, 'What is our PTO policy?');
});

test('preserves ordinary punctuation', () => {
  const result = extractQuestion(`<@${BOT_ID}> What's the deadline -- is it Friday?!`, BOT_ID);
  assert.equal(result.ok, true);
  assert.equal(result.question, "What's the deadline -- is it Friday?!");
});

test('a mention that appears mid-sentence is left intact', () => {
  const result = extractQuestion(`<@${BOT_ID}> ask <@U999> about PTO`, BOT_ID);
  assert.equal(result.ok, true);
  assert.equal(result.question, 'ask <@U999> about PTO');
});

test('rejects an empty question after stripping the mention', () => {
  const result = extractQuestion(`<@${BOT_ID}>`, BOT_ID);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'empty');
  assert.equal(result.question, null);
});

test('rejects a question that is only whitespace after stripping', () => {
  const result = extractQuestion(`<@${BOT_ID}>     `, BOT_ID);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'empty');
});

test('rejects a fully empty raw text', () => {
  const result = extractQuestion('', BOT_ID);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'empty');
});

test('rejects an oversized question', () => {
  const longQuestion = 'a'.repeat(50);
  const result = extractQuestion(`<@${BOT_ID}> ${longQuestion}`, BOT_ID, 10);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'too_long');
});

test('accepts a question exactly at the max length', () => {
  const question = 'a'.repeat(10);
  const result = extractQuestion(`<@${BOT_ID}> ${question}`, BOT_ID, 10);
  assert.equal(result.ok, true);
});

test('does not strip a different user mention that happens to be leading', () => {
  const result = extractQuestion(`<@U999DIFFERENT> what is our PTO policy?`, BOT_ID);
  assert.equal(result.ok, true);
  // Not our bot's mention, so left as part of the question text.
  assert.equal(result.question, '<@U999DIFFERENT> what is our PTO policy?');
});

test('exports the exact empty-question fallback string', () => {
  assert.equal(EMPTY_QUESTION_REPLY, 'Please include a question after mentioning me.');
});

test('a missing botUserId still trims text safely (defensive — should not throw)', () => {
  const result = extractQuestion('What is our PTO policy?', null);
  assert.equal(result.ok, true);
  assert.equal(result.question, 'What is our PTO policy?');
});
