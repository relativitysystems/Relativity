'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  htmlToPlainText,
  stripQuotedReplies,
  stripSignature,
  truncateAtHtmlQuoteBoundary,
  normalizeEmailBody,
} = require('../services/emailNormalizationService');

// ─────────────────────────────────────────────
// htmlToPlainText
// ─────────────────────────────────────────────

test('htmlToPlainText strips tags, decodes entities, and turns block boundaries into newlines', () => {
  const html = '<p>Hi Alex,</p><p>The Q3 report is ready &amp; attached.</p><p>Best,<br>Sam</p>';
  const text = htmlToPlainText(html);
  assert.match(text, /Hi Alex,/);
  assert.match(text, /The Q3 report is ready & attached\./);
  assert.match(text, /Best,\nSam/);
  assert.equal(text.includes('<p>'), false);
});

test('htmlToPlainText strips <script> and <style> content entirely, not just the tags', () => {
  const html = '<style>.x{color:red}</style><script>alert(1)</script><p>Real content</p>';
  const text = htmlToPlainText(html);
  assert.equal(text.includes('alert'), false);
  assert.equal(text.includes('color:red'), false);
  assert.match(text, /Real content/);
});

test('htmlToPlainText preserves image alt text but drops the image itself (no OCR)', () => {
  const html = '<p>See chart: <img src="cid:1" alt="Q3 revenue chart"></p>';
  const text = htmlToPlainText(html);
  assert.match(text, /Q3 revenue chart/);
  assert.equal(text.includes('cid:1'), false);
});

test('htmlToPlainText returns empty string for empty/whitespace input', () => {
  assert.equal(htmlToPlainText(''), '');
  assert.equal(htmlToPlainText('   '), '');
  assert.equal(htmlToPlainText(undefined), '');
});

// ─────────────────────────────────────────────
// truncateAtHtmlQuoteBoundary
// ─────────────────────────────────────────────

test('truncateAtHtmlQuoteBoundary cuts at a gmail_quote div, leaving only the new content', () => {
  const html = '<div>New reply text here.</div><div class="gmail_quote">On Mon, Jan 1, 2026, Alex wrote:<br>Old text</div>';
  const truncated = truncateAtHtmlQuoteBoundary(html);
  assert.match(truncated, /New reply text here/);
  assert.equal(truncated.includes('Old text'), false);
});

test('truncateAtHtmlQuoteBoundary cuts at a <blockquote> (Outlook HTML convention)', () => {
  const html = '<div>New content.</div><blockquote>Quoted history</blockquote>';
  const truncated = truncateAtHtmlQuoteBoundary(html);
  assert.match(truncated, /New content/);
  assert.equal(truncated.includes('Quoted history'), false);
});

test('truncateAtHtmlQuoteBoundary is a no-op when no quote marker is present', () => {
  const html = '<div>Just a normal email, no quoting.</div>';
  assert.equal(truncateAtHtmlQuoteBoundary(html), html);
});

// ─────────────────────────────────────────────
// stripQuotedReplies
// ─────────────────────────────────────────────

test('stripQuotedReplies removes a Gmail-style "On <date>, <sender> wrote:" block and everything after it', () => {
  const text = 'Sounds good, let\'s proceed.\n\nOn Mon, Jan 5, 2026 at 3:00 PM, Alex Doe <alex@example.com> wrote:\n> Can we proceed with the plan?\n> Thanks';
  const stripped = stripQuotedReplies(text);
  assert.match(stripped, /Sounds good, let's proceed\./);
  assert.equal(stripped.includes('Can we proceed'), false);
  assert.equal(stripped.includes('wrote:'), false);
});

test('stripQuotedReplies removes an Outlook-style "-----Original Message-----" block', () => {
  const text = 'Approved.\n\n-----Original Message-----\nFrom: Alex Doe\nSent: Monday, January 5, 2026\nTo: Sam\nSubject: Approval needed\n\nCan you approve this?';
  const stripped = stripQuotedReplies(text);
  assert.match(stripped, /Approved\./);
  assert.equal(stripped.includes('Approval needed'), false);
});

test('stripQuotedReplies removes leading ">"-quoted lines with no header present', () => {
  const text = 'My new reply.\n> old quoted line one\n> old quoted line two';
  const stripped = stripQuotedReplies(text);
  assert.match(stripped, /My new reply\./);
  assert.equal(stripped.includes('old quoted line'), false);
});

test('stripQuotedReplies is a no-op on an email with no quoted content', () => {
  const text = 'Just a plain new message with no history.';
  assert.equal(stripQuotedReplies(text), text);
});

test('stripQuotedReplies never reduces an all-quoted message to empty — falls back to the original', () => {
  const text = '> entirely quoted line one\n> entirely quoted line two';
  const stripped = stripQuotedReplies(text);
  assert.ok(stripped.trim().length > 0);
});

// ─────────────────────────────────────────────
// stripSignature
// ─────────────────────────────────────────────

test('stripSignature removes a "-- " delimited trailing signature block', () => {
  const text = 'Here is the update you asked for.\n\n--\nSam Lee\nVP Engineering\nsam@example.com';
  const stripped = stripSignature(text);
  assert.match(stripped, /Here is the update you asked for\./);
  assert.equal(stripped.includes('VP Engineering'), false);
});

test('stripSignature removes a short trailing disclaimer/signoff block without a "--" delimiter', () => {
  const text = 'The invoice is attached for your records.\n\nBest regards,\nSam\nThis email is confidential and privileged.';
  const stripped = stripSignature(text);
  assert.match(stripped, /The invoice is attached/);
});

test('stripSignature is a no-op on an email with no signature block', () => {
  const text = 'Just body content, nothing trailing that looks like a signature.';
  assert.equal(stripSignature(text), text);
});

test('stripSignature does not strip to empty when the whole message is a signature block', () => {
  const text = '--\nSam Lee\nVP Engineering';
  const stripped = stripSignature(text);
  assert.ok(stripped.trim().length > 0);
  assert.match(stripped, /Sam Lee/);
});

// ─────────────────────────────────────────────
// normalizeEmailBody — full pipeline
// ─────────────────────────────────────────────

test('normalizeEmailBody: a real-shaped multi-reply Gmail HTML thread keeps only the newest message', () => {
  const html = [
    '<div dir="ltr">Thanks, that works for me.<br><br>Best,<br>Sam</div>',
    '<div class="gmail_quote">',
    '<div dir="ltr" class="gmail_attr">On Mon, Jan 5, 2026 at 2:00 PM Alex Doe &lt;alex@example.com&gt; wrote:<br></div>',
    '<blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex">',
    '<div dir="ltr">Does Monday at 3pm work?</div>',
    '</blockquote></div>',
  ].join('');
  const result = normalizeEmailBody({ html });
  assert.match(result, /Thanks, that works for me\./);
  assert.equal(result.includes('Does Monday at 3pm work'), false);
  assert.equal(result.includes('gmail_quote'), false);
});

test('normalizeEmailBody: an Outlook-style HTML reply with a plain <blockquote> quote boundary', () => {
  const html = '<p>Confirmed, proceeding now.</p><blockquote><p>From: Alex Doe<br>Sent: Monday, January 5, 2026<br>Subject: Please confirm</p><p>Can you confirm?</p></blockquote>';
  const result = normalizeEmailBody({ html });
  assert.match(result, /Confirmed, proceeding now\./);
  assert.equal(result.includes('Can you confirm'), false);
});

test('normalizeEmailBody: an email with no quoted content is returned essentially unchanged (no-op)', () => {
  const result = normalizeEmailBody({ text: 'A short standalone message with no history and no signature line.' });
  assert.equal(result, 'A short standalone message with no history and no signature line.');
});

test('normalizeEmailBody: an email that is entirely a signature block is not stripped to empty', () => {
  const result = normalizeEmailBody({ text: '--\nSam Lee\nVP Engineering\nsam@example.com' });
  assert.ok(result.trim().length > 0);
  assert.match(result, /Sam Lee/);
});

test('normalizeEmailBody: plain-text-only body (no html) still gets quote- and signature-stripped', () => {
  const text = 'Approved, thanks.\n\nOn Mon, Jan 5, 2026, Alex wrote:\n> please approve\n\n--\nSam';
  const result = normalizeEmailBody({ text });
  assert.match(result, /Approved, thanks\./);
  assert.equal(result.includes('please approve'), false);
  assert.equal(result.includes('Sam'), false);
});

test('normalizeEmailBody: forwarded message wrapper commentary is kept, forwarded body is treated as quoted content', () => {
  const text = 'FYI, see below.\n\n-----Original Message-----\nFrom: Alex\nSubject: Report\n\nHere is the report body.';
  const result = normalizeEmailBody({ text });
  assert.match(result, /FYI, see below\./);
  assert.equal(result.includes('Here is the report body'), false);
});

test('normalizeEmailBody: returns empty string for an empty message', () => {
  assert.equal(normalizeEmailBody({ html: '', text: '' }), '');
  assert.equal(normalizeEmailBody({}), '');
});

test('normalizeEmailBody: prefers html over text when both are present', () => {
  const result = normalizeEmailBody({ html: '<p>HTML body wins.</p>', text: 'Plain text body loses.' });
  assert.match(result, /HTML body wins\./);
  assert.equal(result.includes('Plain text body loses'), false);
});
