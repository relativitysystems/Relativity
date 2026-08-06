// Pure, DOM-free citation-shaping logic for the client portal chat (EM10 —
// EMAIL_INGESTION.md §23, §20 "Threading UI"). Loaded as a plain <script>
// in portal.html (before portal.js, which builds DOM from these functions'
// output), and required directly from node:test files — same dual-mode
// pattern as portalCache.js.
(function (global) {
  'use strict';

  // A source object is email-shaped if it carries `subject` — the field
  // only ever present on the email branch of runKnowledgeQuery.js's
  // sourceMap (EMAIL_INGESTION.md §23), or on a live source (§6.2, EL6);
  // a plain document source never has it.
  function isEmailSource(s) {
    return !!(s && typeof s === 'object' && 'subject' in s);
  }

  // EL6 (LIVE_EMAIL_LOOKUP.md §6.2) — `live: true` is the one field only
  // ever present on a live_email_message/live_email_thread source, never on
  // a stored ingested_email/knowledge_document one. Used to render live
  // results in their own visually distinct group (§6.3), never merged into
  // the durable "Sources" box.
  function isLiveSource(s) {
    return !!(s && s.live === true);
  }

  // Stored email sources use `sentAt`; live sources (§6.2) use `receivedAt`
  // — same concept, different field name since they come from different
  // pipelines. A citation line never needs to know which kind it's showing.
  function citationDate(s) {
    return s && (s.sentAt || s.receivedAt);
  }

  // EM10.5 Scenario 2 bug fix: pinned to UTC so this always agrees with
  // aikb/services/openaiService.js's identical function — before this, each
  // defaulted to its own runtime's local timezone (this browser's vs. the
  // AIKB Node process's), so the same sentAt instant near a timezone
  // boundary could format to different calendar dates on each side.
  function formatCitationDate(isoString) {
    if (!isoString) return null;
    var d = new Date(isoString);
    if (isNaN(d.getTime())) return null;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  }

  // The box was previously suppressed whenever the model's own answer text
  // already contained a "Source:" line (which the RAG system prompt always
  // makes it write), leaving this box effectively dead in normal operation.
  // That suppression is still correct for a plain document citation — the
  // inline text conveys the same information a fileName/page list would.
  // It is NOT correct once a citation carries a clickable deep link or a
  // thread grouping — plain text can never render either, so the box must
  // show whenever at least one source has something the inline text
  // structurally cannot convey.
  function shouldShowSourcesBox(answerText, sources) {
    if (!sources || sources.length === 0) return false;
    if (sources.some(function (s) { return s && (s.deepLinkUrl || s.providerThreadId); })) return true;
    if (/Source:/i.test(answerText)) return false;
    return true;
  }

  // Groups email sources sharing a providerThreadId so a thread with
  // multiple matched messages renders as one "N messages in this thread
  // matched" group instead of N separate, seemingly-unrelated citation
  // lines. Retrieval/chunking stay per-message (unchanged, §20) — this is
  // purely a display grouping over the sources[] array the API already
  // returns. Non-email sources, and email sources with no providerThreadId,
  // each get their own single-item group. Order-preserving: a group's
  // position in the returned array is the position of its FIRST member in
  // the input.
  function groupSourcesForDisplay(sources) {
    var groups = [];
    var groupByThreadId = new Map();
    sources.forEach(function (s) {
      var threadId = isEmailSource(s) ? s.providerThreadId : null;
      if (threadId && groupByThreadId.has(threadId)) {
        groupByThreadId.get(threadId).push(s);
        return;
      }
      var group = [s];
      groups.push(group);
      if (threadId) groupByThreadId.set(threadId, group);
    });
    return groups;
  }

  // EM10.5 Scenario 2 bug fix — strips the model's own inline "Source: ..."
  // line(s) (RAG_SYSTEM_PROMPT's Response Format always ends the answer with
  // one) from the displayed bubble text. Only called when a structured
  // sources box is about to be rendered for the same message — the box
  // conveys the same information (and more: dates, deep links, thread
  // grouping), so showing the freeform line too just duplicates the
  // citation and reads as two disconnected blocks. Never called for a
  // knowledge-gap answer ("Source: N/A") or a plain-document answer with no
  // deep link, where the inline line remains the sole citation, unchanged.
  function stripInlineSourceLine(answerText) {
    if (typeof answerText !== 'string') return answerText;
    return answerText
      .replace(/^[ \t]*Source\s*:.*$/gim, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  var PortalCitations = {
    isEmailSource: isEmailSource,
    isLiveSource: isLiveSource,
    citationDate: citationDate,
    formatCitationDate: formatCitationDate,
    shouldShowSourcesBox: shouldShowSourcesBox,
    groupSourcesForDisplay: groupSourcesForDisplay,
    stripInlineSourceLine: stripInlineSourceLine,
  };

  if (typeof module === 'object' && module.exports) {
    module.exports = PortalCitations;
  } else {
    global.PortalCitations = PortalCitations;
  }
})(typeof self !== 'undefined' ? self : this);
