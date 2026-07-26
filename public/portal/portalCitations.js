// Pure, DOM-free citation-shaping logic for the client portal chat (EM10 —
// EMAIL_INGESTION.md §23, §20 "Threading UI"). Loaded as a plain <script>
// in portal.html (before portal.js, which builds DOM from these functions'
// output), and required directly from node:test files — same dual-mode
// pattern as portalCache.js.
(function (global) {
  'use strict';

  // A source object is email-shaped if it carries `subject` — the field
  // only ever present on the email branch of runKnowledgeQuery.js's
  // sourceMap (EMAIL_INGESTION.md §23); a plain document source never has it.
  function isEmailSource(s) {
    return !!(s && typeof s === 'object' && 'subject' in s);
  }

  function formatCitationDate(isoString) {
    if (!isoString) return null;
    var d = new Date(isoString);
    if (isNaN(d.getTime())) return null;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
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

  var PortalCitations = {
    isEmailSource: isEmailSource,
    formatCitationDate: formatCitationDate,
    shouldShowSourcesBox: shouldShowSourcesBox,
    groupSourcesForDisplay: groupSourcesForDisplay,
  };

  if (typeof module === 'object' && module.exports) {
    module.exports = PortalCitations;
  } else {
    global.PortalCitations = PortalCitations;
  }
})(typeof self !== 'undefined' ? self : this);
