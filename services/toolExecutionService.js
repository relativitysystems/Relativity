'use strict';

// Tool dispatch for POST /api/tools/execute (EL3/EL4 —
// Architecture/architecture/LIVE_EMAIL_LOOKUP.md §1.1 step 7-9, ADR-010).
// EL3 proved the AIKB -> Relativity signed-envelope plumbing end to end
// using one hardcoded 'noop' tool. EL4 replaces the unknown_tool branch
// with real dispatch to search_email_messages/get_email_content, backed by
// services/emailLiveLookupService.js and validated against the schemas
// landed in EL2 (services/emailToolValidation.js).
//
// 'noop' is kept as an EL3-only sentinel, still useful as a lightweight
// envelope round-trip check independent of any real tool's behavior.

const { TOOL_NAMES, validateSearchEmailMessagesArgs, validateGetEmailContentArgs } = require('./emailToolValidation');
const defaultEmailLiveLookupService = require('./emailLiveLookupService');

/**
 * Never throws for a business-level outcome — unrecognized tool, invalid
 * arguments, unauthorized mailbox, or a provider failure are all
 * represented as a named {status, reason} result (§9), not an exception.
 * Only a genuine bug (an unexpected exception from a dependency) propagates
 * to the route, which is untouched from EL3 and still returns a plain 200
 * for anything this function returns.
 *
 * @param {object} params
 * @param {string} params.toolName
 * @param {object} [params.args]
 * @param {string} [params.clientId] - from req.serviceRequest (the signed
 *   envelope's own bound field), never from the payload body.
 * @param {string} [params.requestingMemberId] - from req.servicePayload.
 * @param {string} [params.origin] - EL7B, audit-only ('portal'/'slack'/'slack_dm').
 * @param {object} [params.originMetadata] - EL7B, audit-only — narrow, safe metadata, never message content.
 * @param {object} [deps] - injected for testing; defaults to the real singleton service.
 * @returns {Promise<object>}
 */
async function executeTool({ toolName, args, clientId, requestingMemberId, origin, originMetadata }, deps = {}) {
  const emailLiveLookupService = deps.emailLiveLookupService || defaultEmailLiveLookupService;

  if (toolName === 'noop') {
    return { status: 'ok', toolName: 'noop', echoedArgs: args || null };
  }

  if (toolName === TOOL_NAMES.SEARCH_EMAIL_MESSAGES || toolName === TOOL_NAMES.GET_EMAIL_CONTENT) {
    if (!clientId || !requestingMemberId) {
      return { status: 'error', reason: 'validation_error' };
    }

    let validated;
    try {
      validated = toolName === TOOL_NAMES.SEARCH_EMAIL_MESSAGES
        ? validateSearchEmailMessagesArgs(args)
        : validateGetEmailContentArgs(args);
    } catch {
      return { status: 'error', reason: 'validation_error' };
    }

    return toolName === TOOL_NAMES.SEARCH_EMAIL_MESSAGES
      ? emailLiveLookupService.searchEmailMessages({ clientId, requestingMemberId, args: validated, origin, originMetadata })
      : emailLiveLookupService.getEmailContent({ clientId, requestingMemberId, args: validated, origin, originMetadata });
  }

  return { status: 'error', reason: 'unknown_tool' };
}

module.exports = { executeTool };
