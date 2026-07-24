'use strict';

// Email normalization and preprocessing (EM6 — Architecture/architecture/
// EMAIL_INGESTION.md §19). Performed here, before upload — AIKB receives
// already-normalized plain text, exactly the shape documentParser.js's
// existing plain-text branch already handles (no new AIKB parser needed,
// §5). Pure, dependency-free functions only — no network/DB access, easy to
// unit test against real Gmail/Outlook HTML fixtures.
//
// Never returns raw HTML — sanitize-then-extract only (§19's "never store or
// forward raw HTML" requirement is enforced by services/emailSyncService.js
// only ever sending this module's output to AIKB, never the fetched body
// itself).
//
// Best-effort, not exhaustive — quote/signature stripping are heuristics,
// consistent with this codebase's existing honesty about heuristic
// limitations (e.g. KNOWLEDGE_GAP_DETECTION.md's phrase-match gap detector).
// Never strips content down to empty: every stripping step falls back to its
// pre-strip input when the result would be blank.

// Common HTML entities seen in real email markup — a small, explicit table
// rather than a full HTML-entity library, matching this codebase's existing
// preference for narrow, dependency-free helpers over new packages.
const HTML_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'",
  nbsp: ' ', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘',
  rdquo: '”', ldquo: '“', hellip: '…',
};

function decodeHtmlEntities(str) {
  return str
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp|mdash|ndash|rsquo|lsquo|rdquo|ldquo|hellip);/g, (_, name) => HTML_ENTITIES[name]);
}

/**
 * Truncates HTML at the first quote-boundary container a Gmail/Outlook
 * client emits when replying/forwarding — `<blockquote>` (both clients) or
 * a `gmail_quote`-classed div (Gmail specifically). Applied before tag
 * stripping so the removal is structural, not a fragile text-level guess.
 * A no-op when neither marker is present.
 */
function truncateAtHtmlQuoteBoundary(html) {
  const patterns = [
    /<blockquote[\s>]/i,
    /<div[^>]*class=["'][^"']*gmail_quote[^"']*["']/i,
  ];
  let cutIndex = -1;
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match && (cutIndex === -1 || match.index < cutIndex)) cutIndex = match.index;
  }
  return cutIndex === -1 ? html : html.slice(0, cutIndex);
}

/**
 * HTML → plain text (§19). Strips `<script>`/`<style>` blocks (and their
 * content) first, then every remaining tag, converting block-level/`<br>`
 * boundaries to newlines so paragraph structure survives as blank lines
 * rather than collapsing into one run-on line. Inline images are dropped
 * (alt text preserved where present) — never OCR'd, matching the existing
 * platform-wide lack of OCR capability.
 */
function htmlToPlainText(html) {
  if (typeof html !== 'string' || !html.trim()) return '';

  let out = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<img[^>]*\balt=["']([^"']*)["'][^>]*>/gi, (_, alt) => (alt ? ` ${alt} ` : ''))
    .replace(/<img[^>]*>/gi, '')
    .replace(/<(br|br\/)>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '');

  out = decodeHtmlEntities(out);

  return out
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Gmail's own reply-header convention ("On <date>, <sender> wrote:") and
// Outlook's classic plain-text forward/reply block header
// ("-----Original Message-----" followed by From:/Sent:/To:/Subject:
// lines) — both mark the start of quoted history in a PLAIN-text body (the
// HTML case is already handled structurally by
// truncateAtHtmlQuoteBoundary above; this is the defense-in-depth,
// text-level fallback §19 calls for, and the only mechanism for a body that
// was plain-text to begin with).
const QUOTE_HEADER_PATTERNS = [
  /^On .{0,120}wrote:\s*$/im,
  /^-{2,}\s*Original Message\s*-{2,}\s*$/im,
  /^_{5,}\s*$/m, // Outlook's long-underscore separator before a forwarded block
];

/**
 * Strips quoted-reply content from plain text (§19): removes everything
 * from the first recognized quote-header line onward, then drops any
 * remaining leading `>`-quoted lines (a second, independent reply chain
 * Gmail sometimes leaves un-headered). Never strips to empty — if every
 * line looks quoted, the original text is returned unchanged rather than
 * discarding the whole message.
 */
function stripQuotedReplies(text) {
  if (typeof text !== 'string' || !text.trim()) return '';

  let cutIndex = -1;
  for (const pattern of QUOTE_HEADER_PATTERNS) {
    const match = text.match(pattern);
    if (match && (cutIndex === -1 || match.index < cutIndex)) cutIndex = match.index;
  }
  let result = cutIndex === -1 ? text : text.slice(0, cutIndex);

  const withoutAngleQuotes = result
    .split('\n')
    .filter((line) => !/^\s*>/.test(line))
    .join('\n')
    .trim();

  if (!withoutAngleQuotes) return result.trim() || text.trim();
  return withoutAngleQuotes;
}

// A trailing signature block: a line that's exactly the RFC 3676 sig
// delimiter ("-- ") or a bare "--"/"__", OR a short trailing block (<=6
// non-blank lines) matching common disclaimer/signoff phrasing. Heuristic,
// best-effort (§19) — not guaranteed to catch every signature, and
// deliberately conservative about what it removes.
const SIG_DELIMITER = /^--\s?$/m;
const DISCLAIMER_HINT = /(confidential|privileged|disclaimer|sent from my|regards|best,|thanks,|thank you,|sincerely)/i;

/**
 * Strips a trailing signature/disclaimer block (§19). Never strips to
 * empty: if the delimiter is found but everything before it is blank (the
 * email IS just a signature), the original text is returned unchanged.
 */
function stripSignature(text) {
  if (typeof text !== 'string' || !text.trim()) return '';

  const delimiterMatch = text.match(SIG_DELIMITER);
  if (delimiterMatch) {
    const before = text.slice(0, delimiterMatch.index).trim();
    if (before) return before;
    // The whole message is (or starts with) a signature block — keep it
    // rather than returning empty.
    return text.trim();
  }

  const lines = text.split('\n');
  // Look at a short trailing window only — a disclaimer/signoff phrase
  // appearing mid-body is real content, not a signature.
  const windowSize = Math.min(6, lines.length);
  const tail = lines.slice(-windowSize).join('\n');
  const head = lines.slice(0, lines.length - windowSize).join('\n').trim();

  if (head && DISCLAIMER_HINT.test(tail) && tail.trim().length < 400) {
    return head;
  }

  return text.trim();
}

/**
 * Full pipeline (§19): HTML (if present) is quote-truncated structurally,
 * converted to plain text, then quote-stripped and signature-stripped at
 * the text level as defense in depth; a plain-text-only body skips straight
 * to the text-level steps. Forwarded messages are treated as their own
 * message — the forwarding wrapper's own commentary is genuinely new
 * content, and the same quote-stripping heuristics apply recursively to
 * whatever forwarded/quoted body they wrap without any special-case code.
 *
 * @param {{html?: string, text?: string, subject?: string}} body
 * @returns {string} normalized plain text, never empty if the input wasn't.
 */
function normalizeEmailBody({ html, text } = {}) {
  let plain;
  if (html && html.trim()) {
    plain = htmlToPlainText(truncateAtHtmlQuoteBoundary(html));
  } else {
    plain = typeof text === 'string' ? text : '';
  }

  if (!plain.trim()) return '';

  const unquoted = stripQuotedReplies(plain);
  const designated = unquoted.trim() ? unquoted : plain;
  const unsigned = stripSignature(designated);
  const final = unsigned.trim() ? unsigned : designated;

  return final.replace(/\n{3,}/g, '\n\n').trim();
}

module.exports = {
  htmlToPlainText,
  stripQuotedReplies,
  stripSignature,
  truncateAtHtmlQuoteBoundary,
  normalizeEmailBody,
};
