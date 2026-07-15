'use strict';

// Slack answer/citation formatting (Architecture Review Phase 4, Milestone
// 4, §4.14). Pure, no I/O. Only ever includes human-readable citation
// fields (document title, optional page) — document IDs, chunk IDs, storage
// paths, signed URLs, database IDs, embeddings, and raw metadata must never
// reach this module's output.

const MAX_CITATIONS = 5;
const MAX_ANSWER_CHARS = 3000; // conservative vs. Slack's much larger message limit
const TRUNCATION_SUFFIX = '…'; // ellipsis

const FALLBACK = Object.freeze({
  KNOWLEDGE_GAP: "I couldn't find that information in your organization's knowledge base.",
  TEMPORARY_FAILURE: "I couldn't complete that request right now. Please try again shortly.",
});

function truncateAnswer(text) {
  if (typeof text !== 'string') return '';
  if (text.length <= MAX_ANSWER_CHARS) return text;
  return `${text.slice(0, MAX_ANSWER_CHARS - 1)}${TRUNCATION_SUFFIX}`;
}

/**
 * @param {Array<{fileName?: string, title?: string, pages?: number[]}>} sources
 * @returns {string[]} deduplicated, capped, human-readable citation lines.
 */
function formatCitations(sources) {
  if (!Array.isArray(sources) || sources.length === 0) return [];

  const seen = new Set();
  const lines = [];

  for (const source of sources) {
    if (!source) continue;
    const title = typeof source.title === 'string' && source.title.trim()
      ? source.title.trim()
      : (typeof source.fileName === 'string' ? source.fileName.trim() : '');
    if (!title) continue;

    const key = title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    lines.push(title);
    if (lines.length >= MAX_CITATIONS) break;
  }

  return lines;
}

/**
 * @param {{ answer: string, sources?: Array, isKnowledgeGap?: boolean }} result - AIKB's /ask-pipeline response.
 * @returns {string} the exact mrkdwn text to send via chat.postMessage.
 */
function formatSlackMessage({ answer, sources, isKnowledgeGap }) {
  if (isKnowledgeGap) {
    return FALLBACK.KNOWLEDGE_GAP;
  }

  const body = truncateAnswer(answer || '');
  const citationLines = formatCitations(sources);

  if (citationLines.length === 0) {
    return body;
  }

  const sourcesBlock = citationLines.map((title) => `• ${title}`).join('\n');
  return `${body}\n\nSources:\n${sourcesBlock}`;
}

module.exports = {
  formatSlackMessage,
  formatCitations,
  truncateAnswer,
  FALLBACK,
  MAX_CITATIONS,
  MAX_ANSWER_CHARS,
};
