'use strict';

// Tool dispatch for POST /api/tools/execute (EL3 —
// Architecture/architecture/LIVE_EMAIL_LOOKUP.md §1.1 step 7-9, ADR-010).
// This milestone proves the AIKB -> Relativity signed-envelope plumbing
// end to end using one hardcoded 'noop' tool — it does not implement any
// real tool. EL4 replaces the unknown_tool branch below with real
// dispatch to search_email_messages/get_email_content (see
// aikb/services/emailToolSchemas.js and
// services/emailToolValidation.js for those tools' contracts, landed in
// EL2, not yet wired to anything).
//
// 'noop' is an EL3-only sentinel, not one of EL2's real TOOL_NAMES —
// it exists purely to prove the request/response round trip works
// before any Gmail-calling code exists.

/**
 * @param {object} params
 * @param {string} params.toolName
 * @param {object} [params.args]
 * @returns {Promise<object>} a result shape the caller can trust regardless
 *   of toolName — never throws for an unrecognized tool, since that's a
 *   normal, expected outcome this milestone (nothing beyond 'noop' is
 *   implemented yet), not a server error.
 */
async function executeTool({ toolName, args }) {
  if (toolName === 'noop') {
    return { status: 'ok', toolName: 'noop', echoedArgs: args || null };
  }
  return { status: 'error', reason: 'unknown_tool' };
}

module.exports = { executeTool };
