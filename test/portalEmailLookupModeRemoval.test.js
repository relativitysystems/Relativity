const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * EL6's visible "Email search" label + Automatic/Company knowledge only/Live
 * email mode selector has been removed from the client portal's Knowledge
 * Base chat UI (product decision: converge toward LIVE_EMAIL_LOOKUP.md
 * §2.2's confirmed "Automatic becomes the only default mode" direction —
 * the prominent three-way selector was always a launch/testing surface,
 * never the intended permanent UI). The underlying company_knowledge/
 * live_email modes are untouched server-side (routes/api.js,
 * emailLiveLookupService.js) and remain available to the automatic router;
 * only the portal's manual selector is gone.
 *
 * No jsdom harness exists in this repo's conventions for portal.js's DOM
 * layer (see test/portalCitations.test.js's header comment) — these are
 * static source assertions over the shipped HTML/CSS/JS, the same spirit as
 * this repo's other lightweight smoke tests (e.g. test/emailRoutes.test.js).
 */

const portalHtml = fs.readFileSync(path.join(__dirname, '../public/portal/portal.html'), 'utf8');
const portalCss  = fs.readFileSync(path.join(__dirname, '../public/portal/portal.css'), 'utf8');
const portalJs   = fs.readFileSync(path.join(__dirname, '../public/portal/portal.js'), 'utf8');
const apiJs      = fs.readFileSync(path.join(__dirname, '../routes/api.js'), 'utf8');

// ─────────────────────────────────────────────
// 1. The removed controls are no longer rendered
// ─────────────────────────────────────────────

test('portal.html no longer renders the email-search mode selector row or its id hooks', () => {
  assert.equal(portalHtml.includes('kb-email-lookup-mode-row'), false);
  assert.equal(portalHtml.includes('id="kb-email-lookup-mode"'), false);
});

test('portal.html no longer contains the "Email search" label or the three mode option labels', () => {
  assert.equal(portalHtml.includes('Email search'), false);
  assert.equal(portalHtml.includes('Company knowledge only'), false);
  assert.equal(portalHtml.includes('>Live email<'), false);
});

test('portal.html still renders the page title, search-scope collection filter, and New Chat button (desired post-removal layout)', () => {
  assert.match(portalHtml, /Knowledge Base<\/h2>/);
  assert.match(portalHtml, /id="kb-collections-filter"/);
  assert.match(portalHtml, /id="kb-clear-chat-btn"/);
});

test('portal.css no longer carries CSS rules that existed only for the removed mode-selector row', () => {
  assert.equal(portalCss.includes('.kb-email-lookup-mode-row'), false);
  assert.equal(portalCss.includes('.kb-email-lookup-mode-select'), false);
});

test('portal.js no longer queries the removed row/select DOM ids or reads/writes their localStorage key', () => {
  assert.equal(portalJs.includes("getElementById('kb-email-lookup-mode-row')"), false);
  assert.equal(portalJs.includes("getElementById('kb-email-lookup-mode')"), false);
  assert.equal(portalJs.includes('kbEmailLookupMode:'), false, 'the per-client localStorage key template should be gone');
  assert.equal(portalJs.includes("addEventListener('change'"), true, 'sanity check: other unrelated change listeners in the file are untouched');
});

// ─────────────────────────────────────────────
// 2 & 3. A normal chat request — and a new chat — send the canonical
// automatic search mode
// ─────────────────────────────────────────────

test('portal.js sends the literal, canonical "automatic" emailLookupMode on every /api/knowledge/query request', () => {
  assert.match(portalJs, /emailLookupMode:\s*kbEmailLookupMode/);
  assert.match(portalJs, /const kbEmailLookupMode\s*=\s*'automatic'/);
});

test('kbEmailLookupMode is a fixed constant, not a mutable selection driven by a removed control', () => {
  // Only one assignment site should exist: the top-level `const` declaration
  // (the negative lookahead excludes `===`/`!==` comparisons elsewhere).
  const assignments = portalJs.match(/kbEmailLookupMode\s*=(?!=)/g) || [];
  assert.equal(assignments.length, 1);
});

test('New Chat (kb-clear-chat-btn) does not touch kbEmailLookupMode, so a new chat inherits the same fixed automatic default with no special-casing', () => {
  const clearChatHandlerStart = portalJs.indexOf("kbClearChatBtn.addEventListener('click'");
  assert.notEqual(clearChatHandlerStart, -1);
  const handlerSlice = portalJs.slice(clearChatHandlerStart, clearChatHandlerStart + 800);
  assert.equal(handlerSlice.includes('kbEmailLookupMode'), false);
});

// ─────────────────────────────────────────────
// 4. No previous user-selected mode from localStorage/sessionStorage can
// cause the hidden UI to remain in company-only or live-email mode
// ─────────────────────────────────────────────

test('portal.js never reads any localStorage/sessionStorage key that could override the fixed automatic mode', () => {
  assert.equal(/localStorage\.getItem\([^)]*[Ee]mail/.test(portalJs), false);
  assert.equal(/sessionStorage\.getItem\([^)]*[Ee]mail/.test(portalJs), false);
});

// ─────────────────────────────────────────────
// 5. Existing search-scope collection selection still works (untouched)
// ─────────────────────────────────────────────

test('the unrelated "Search scope" collections filter (kbAllowedCollectionIds) is untouched by the removal', () => {
  assert.match(portalJs, /kbAllowedCollectionIds/);
  assert.match(portalJs, /collectionIds:\s*kbAllowedCollectionIds/);
  assert.match(portalHtml, /id="kb-collections-filter-list"/);
});

// ─────────────────────────────────────────────
// 6 & 7. Backend still supports both the automatic routing path and the
// underlying company-knowledge/live-email capabilities (API contract
// unchanged; this is a UI-only removal)
// ─────────────────────────────────────────────

test('routes/api.js still defines all three modes and still defaults an unrecognized/missing emailLookupMode to "automatic"', () => {
  assert.match(apiJs, /EMAIL_LOOKUP_MODES\s*=\s*\[['"]company_knowledge['"],\s*['"]live_email['"],\s*['"]automatic['"]\]/);
  assert.match(apiJs, /EMAIL_LOOKUP_MODES\.includes\(emailLookupMode\)\s*\?\s*emailLookupMode\s*:\s*'automatic'/);
});

test('routes/api.js still computes emailLookupAvailable/forceLiveLookup from the mode — the automatic router and live-email path are not weakened', () => {
  assert.match(apiJs, /emailLookupAvailable/);
  assert.match(apiJs, /forceLiveLookup/);
});
