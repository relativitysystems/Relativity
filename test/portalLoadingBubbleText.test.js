const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Presentation-only change: the "Searching connected email…" text that used
 * to render inside the assistant's loading bubble (alongside the animated
 * loading-dots) has been removed. The bubble now shows only the dots,
 * regardless of whether the question could plausibly trigger a live mailbox
 * lookup. No backend behavior, routing, or the loading animation itself
 * changed — see appendLoadingBubble in portal.js.
 *
 * No jsdom harness exists in this repo's conventions for portal.js's DOM
 * layer (see test/portalCitations.test.js's header comment) — these are
 * static source assertions, the same approach as
 * test/portalEmailLookupModeRemoval.test.js.
 */

const portalJs  = fs.readFileSync(path.join(__dirname, '../public/portal/portal.js'), 'utf8');
const portalCss = fs.readFileSync(path.join(__dirname, '../public/portal/portal.css'), 'utf8');

test('portal.js no longer creates or appends the "Searching connected email…" hint element', () => {
  assert.equal(portalJs.includes('Searching connected email'), false);
  assert.equal(portalJs.includes('kb-loading-live-email-hint'), false);
});

test('appendLoadingBubble still builds the three-dot animated loading indicator', () => {
  const fnStart = portalJs.indexOf('function appendLoadingBubble');
  assert.notEqual(fnStart, -1);
  const fnSlice = portalJs.slice(fnStart, fnStart + 700);
  assert.match(fnSlice, /class="loading-dots"><span><\/span><span><\/span><span><\/span>/);
});

test('appendLoadingBubble still accepts showLiveEmailHint and the call site still computes it — the email-lookup determination logic is untouched, only its text rendering was removed', () => {
  assert.match(portalJs, /function appendLoadingBubble\(showLiveEmailHint\)/);
  assert.match(portalJs, /const showLiveEmailHint = kbEmailLookupMode !== 'company_knowledge' && hasActiveGmailConnection/);
  assert.match(portalJs, /appendLoadingBubble\(showLiveEmailHint\)/);
});

test('portal.css keeps the .loading-dots animation rules untouched', () => {
  assert.match(portalCss, /\.loading-dots\s*\{/);
  assert.match(portalCss, /\.loading-dots span\s*\{/);
  assert.match(portalCss, /@keyframes loading-dot-pulse/);
});

test('portal.css no longer carries the now-dead .kb-loading-live-email-hint rule', () => {
  assert.equal(portalCss.includes('.kb-loading-live-email-hint'), false);
});
