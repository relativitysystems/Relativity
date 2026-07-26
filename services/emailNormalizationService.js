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
 * client emits when replying/forwarding — `<blockquote>` (both clients), a
 * `gmail_quote`-classed div (Gmail specifically), or Outlook's
 * `divRplyFwdMsg`-id'd container (EM10 — a real, concrete gap found against
 * more realistic fixtures: Outlook desktop/web wraps its "From:/Sent:/To:/
 * Subject:" reply header in `<div id="divRplyFwdMsg">`, positioned BEFORE
 * the `<blockquote>` that follows it — matching only `<blockquote>` cuts
 * after that header block, not before it, leaving the quoted metadata
 * header in the "new" content. Some webmail rendering proxies prefix ids
 * with `x_` (`x_divRplyFwdMsg`), matched too. Applied before tag stripping
 * so the removal is structural, not a fragile text-level guess. A no-op
 * when none of these markers are present.
 */
function truncateAtHtmlQuoteBoundary(html) {
  const patterns = [
    /<blockquote[\s>]/i,
    /<div[^>]*class=["'][^"']*gmail_quote[^"']*["']/i,
    /<div[^>]*id=["'](x_)?divRplyFwdMsg["']/i,
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
  // EM10 — Gmail's own forwarded-message convention ("---------- Forwarded
  // message ---------"), distinct from Outlook's "Original Message" header
  // above; found missing against a realistic Gmail-forward fixture — the
  // forwarding wrapper's own commentary is genuinely new content (§19), but
  // the forwarded body itself was passing through unstripped with no
  // matching pattern to cut at.
  /^-{2,}\s*Forwarded message\s*-{2,}\s*$/im,
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
// delimiter ("-- ") or a bare "--"/"__", a standalone mobile-client
// signature line ("Sent from my iPhone", "Get Outlook for iOS", etc.), OR a
// short trailing block (<=6 non-blank lines) matching common
// disclaimer/signoff phrasing. Heuristic, best-effort (§19) — not
// guaranteed to catch every signature, and deliberately conservative about
// what it removes.
const SIG_DELIMITER = /^--\s?$/m;

// EM10 — split into two tiers with two different trailing-window length
// caps, found necessary against a realistic fixture: a genuine 3-paragraph
// business email ending in a completely ordinary "Thanks,\nAlex" sign-off
// was being wiped down to its first line, because the original single
// DISCLAIMER_HINT list treated "thanks," as strong enough evidence to
// justify stripping up to 400 (now 700) characters of trailing content —
// but "thanks,"/"regards"/"sincerely" are commonly the LAST TWO LINES of
// any polite email, not evidence of a disclaimer block, and only deserve a
// short, tight window (just enough for "Thanks,\nJane Doe\nVP of Sales").
// Legal-boilerplate-specific phrases ("confidential", "intended only for",
// ...) essentially never appear in genuine short prose, so those keep the
// wider, more generous window.
const LEGAL_DISCLAIMER_HINT = /(confidential|privileged|disclaimer|intended only for|intended recipient|this email and any attachments)/i;
const SOFT_SIGNOFF_HINT = /(regards|best,|thanks,|thank you,|sincerely)/i;
const SOFT_SIGNOFF_MAX_CHARS = 80;

// EM10 — these mobile/webmail client footers are always exactly one
// standalone trailing line, unlike a multi-line disclaimer block, so they
// get their own dedicated match rather than going through the windowed
// disclaimer-block check below. This matters because that windowed check
// (see stripSignature) treats the whole tail as one unit and — for a SHORT
// message — can end up with an empty `head`, which its own "never strip to
// empty" guard then correctly, but overly conservatively, refuses to act
// on: a common "Sounds good, talk soon.\n\nSent from my iPhone" reply is 3
// lines total, so windowSize (min(6, 3)) would swallow the ENTIRE message
// as "tail," leaving nothing in `head` for the disclaimer check to return —
// the genuine content ("Sounds good, talk soon.") would incorrectly stay
// glued to the signature line instead of being recognized as real, keepable
// content. Matching this specific, well-known line pattern directly, at any
// message length, avoids that whole class of short-message miss.
const MOBILE_SIGNATURE_LINE = /^(sent from my \S.*|get outlook for \S.*)$/i;

/**
 * Removes a single standalone trailing mobile/webmail signature line (and
 * any blank lines immediately before it), regardless of overall message
 * length. A no-op if the last non-blank line doesn't match, or if the
 * message consists of ONLY that line (never strips to empty).
 */
function stripMobileSignatureLine(text) {
  const lines = text.split('\n');
  let lastIdx = lines.length - 1;
  while (lastIdx >= 0 && lines[lastIdx].trim() === '') lastIdx--;
  if (lastIdx < 0 || !MOBILE_SIGNATURE_LINE.test(lines[lastIdx].trim())) return text;

  const before = lines.slice(0, lastIdx).join('\n').trim();
  return before || text; // the whole message IS just the mobile sig line — keep it
}

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
    if (before) return stripMobileSignatureLine(before);
    // The whole message is (or starts with) a signature block — keep it
    // rather than returning empty.
    return text.trim();
  }

  const withoutMobileLine = stripMobileSignatureLine(text);

  // EM10 — paragraph-based, not a fixed last-N-raw-lines window. The
  // original line-count window (min(6, totalLines)) had a real bug found
  // against a realistic fixture: for any message with 6 or fewer total
  // lines, the window swallowed the ENTIRE message as "tail," leaving
  // `head` empty — which the "never strip to empty" guard then correctly,
  // but overly conservatively, refused to act on. That silently broke
  // disclaimer stripping for exactly the short-message case it's most
  // likely to matter for (a one-line reply followed by a one-paragraph
  // legal footer is only 3 raw lines). Splitting into blank-line-delimited
  // paragraphs and checking only the trailing paragraph(s) — never an
  // arbitrary raw-line count — fixes this: a short message's own single
  // paragraph of real content is never mistaken for its own tail.
  const paragraphs = withoutMobileLine.split(/\n\s*\n/);

  if (paragraphs.length > 1) {
    const lastParagraph = paragraphs[paragraphs.length - 1];
    const headAfterLast = paragraphs.slice(0, -1).join('\n\n').trim();
    // Widened from the original 400-char cap to 700 (EM10) — a real
    // corporate legal disclaimer ("This email and any attachments are
    // confidential and intended only for..." plus 2-3 more sentences)
    // routinely runs 500-700 characters as a single wrapped paragraph.
    if (headAfterLast && LEGAL_DISCLAIMER_HINT.test(lastParagraph) && lastParagraph.trim().length < 700) {
      return headAfterLast;
    }
    if (headAfterLast && SOFT_SIGNOFF_HINT.test(lastParagraph) && lastParagraph.trim().length < SOFT_SIGNOFF_MAX_CHARS) {
      return headAfterLast;
    }

    // A signature sometimes spans two short trailing paragraphs — a
    // "Best regards," paragraph followed by a separate name/title
    // paragraph, blank-line-separated in the source. Checked only as a
    // fallback (the single-paragraph check above didn't match), and only
    // ever the last TWO paragraphs together — never more.
    if (paragraphs.length > 2) {
      const lastTwo = paragraphs.slice(-2).join('\n\n');
      const headBeforeLastTwo = paragraphs.slice(0, -2).join('\n\n').trim();
      if (headBeforeLastTwo && LEGAL_DISCLAIMER_HINT.test(lastTwo) && lastTwo.trim().length < 700) {
        return headBeforeLastTwo;
      }
      if (headBeforeLastTwo && SOFT_SIGNOFF_HINT.test(lastTwo) && lastTwo.trim().length < SOFT_SIGNOFF_MAX_CHARS) {
        return headBeforeLastTwo;
      }
    }
  }

  return withoutMobileLine.trim();
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
