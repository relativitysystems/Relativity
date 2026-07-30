'use strict';

// Argument validation for the read-only email live-lookup tool registry
// (EL2 — Architecture/architecture/LIVE_EMAIL_LOOKUP.md §4, ADR-010).
// Mirrors services/emailPolicyService.js#validateRule's convention exactly:
// hand-rolled checks (no schema-validation library exists anywhere in this
// codebase), throw a plain Error with `.status = 400` and a field-naming
// message on the first invalid field, return a normalized object on
// success.
//
// This module does not call Gmail, resolve a connection, or check
// authorization — it only validates that a tool-call's arguments are
// shaped the way aikb/services/emailToolSchemas.js's JSON Schema says they
// should be, before any later milestone (EL3 execution endpoint, EL4 real
// Gmail calls) trusts them. The property/type/enum shape validated here
// must stay in sync with that file — see this file's own test,
// test/emailToolValidation.test.js, for the cross-repo fixture this and
// emailToolSchemas.test.js both assert against independently.

const { email: emailConfig } = require('../config');

const TOOL_NAMES = Object.freeze({
  SEARCH_EMAIL_MESSAGES: 'search_email_messages',
  GET_EMAIL_CONTENT: 'get_email_content',
});

const MAILBOX_SCOPES = ['mine'];

function invalid(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

function checkNoUnknownKeys(args, allowedKeys, toolName) {
  const unknown = Object.keys(args).filter((key) => !allowedKeys.includes(key));
  if (unknown.length > 0) {
    throw invalid(`${toolName}: unrecognized argument(s): ${unknown.join(', ')}.`);
  }
}

function checkOptionalString(args, field, toolName) {
  if (args[field] == null) return null;
  if (typeof args[field] !== 'string' || args[field].trim() === '') {
    throw invalid(`${toolName}: ${field} must be a non-empty string when provided.`);
  }
  return args[field].trim();
}

function checkOptionalBoolean(args, field, toolName) {
  if (args[field] == null) return null;
  if (typeof args[field] !== 'boolean') {
    throw invalid(`${toolName}: ${field} must be a boolean when provided.`);
  }
  return args[field];
}

function checkOptionalIsoDate(args, field, toolName) {
  if (args[field] == null) return null;
  if (typeof args[field] !== 'string' || Number.isNaN(Date.parse(args[field]))) {
    throw invalid(`${toolName}: ${field} must be an ISO 8601 date string when provided.`);
  }
  return args[field];
}

/**
 * Validates and normalizes search_email_messages' arguments (§4.2). Every
 * field is optional; omitting all of them is valid (returns the most
 * recent messages, per the tool's own description). maxResults defaults to
 * config.email.liveLookup.defaultResultsPerSearch and is rejected — never
 * silently clamped — if it exceeds maxResultsPerSearch, so a caller
 * requesting more than the hard cap gets an explicit error, not a
 * quietly-truncated result set.
 *
 * @param {object} args - raw tool-call arguments.
 * @returns {object} normalized arguments, ready for EL4's execution layer.
 */
function validateSearchEmailMessagesArgs(args) {
  const toolName = TOOL_NAMES.SEARCH_EMAIL_MESSAGES;
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw invalid(`${toolName}: arguments must be an object.`);
  }

  const allowedKeys = [
    'senderContains',
    'recipientContains',
    'subjectContains',
    'keywords',
    'dateFrom',
    'dateTo',
    'unreadOnly',
    'hasAttachment',
    'attachmentNameContains',
    'mailboxScope',
    'maxResults',
  ];
  checkNoUnknownKeys(args, allowedKeys, toolName);

  const senderContains = checkOptionalString(args, 'senderContains', toolName);
  const recipientContains = checkOptionalString(args, 'recipientContains', toolName);
  const subjectContains = checkOptionalString(args, 'subjectContains', toolName);
  const keywords = checkOptionalString(args, 'keywords', toolName);
  const attachmentNameContains = checkOptionalString(args, 'attachmentNameContains', toolName);

  const dateFrom = checkOptionalIsoDate(args, 'dateFrom', toolName);
  const dateTo = checkOptionalIsoDate(args, 'dateTo', toolName);
  if (dateFrom && dateTo && Date.parse(dateFrom) > Date.parse(dateTo)) {
    throw invalid(`${toolName}: dateFrom must not be after dateTo.`);
  }

  const unreadOnly = checkOptionalBoolean(args, 'unreadOnly', toolName);
  const hasAttachment = checkOptionalBoolean(args, 'hasAttachment', toolName);

  let mailboxScope = 'mine';
  if (args.mailboxScope != null) {
    if (!MAILBOX_SCOPES.includes(args.mailboxScope)) {
      throw invalid(`${toolName}: mailboxScope must be "mine" (the only supported value).`);
    }
    mailboxScope = args.mailboxScope;
  }

  let maxResults = emailConfig.liveLookup.defaultResultsPerSearch;
  if (args.maxResults != null) {
    const parsed = Number(args.maxResults);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw invalid(`${toolName}: maxResults must be a positive integer.`);
    }
    if (parsed > emailConfig.liveLookup.maxResultsPerSearch) {
      throw invalid(
        `${toolName}: maxResults must not exceed ${emailConfig.liveLookup.maxResultsPerSearch}.`
      );
    }
    maxResults = parsed;
  }

  return {
    senderContains,
    recipientContains,
    subjectContains,
    keywords,
    dateFrom,
    dateTo,
    unreadOnly: unreadOnly == null ? false : unreadOnly,
    hasAttachment: hasAttachment == null ? false : hasAttachment,
    attachmentNameContains,
    mailboxScope,
    maxResults,
  };
}

/**
 * Validates and normalizes get_email_content's arguments (§4.3). Exactly
 * one of messageId/threadId is required — plain JSON Schema on the AIKB
 * side can't express that exclusivity, so it's enforced here.
 *
 * @param {object} args - raw tool-call arguments.
 * @returns {object} normalized arguments, ready for EL4's execution layer.
 */
function validateGetEmailContentArgs(args) {
  const toolName = TOOL_NAMES.GET_EMAIL_CONTENT;
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw invalid(`${toolName}: arguments must be an object.`);
  }

  const allowedKeys = ['messageId', 'threadId', 'maxMessagesInThread'];
  checkNoUnknownKeys(args, allowedKeys, toolName);

  const messageId = checkOptionalString(args, 'messageId', toolName);
  const threadId = checkOptionalString(args, 'threadId', toolName);

  if (!messageId && !threadId) {
    throw invalid(`${toolName}: exactly one of messageId or threadId is required (neither was provided).`);
  }
  if (messageId && threadId) {
    throw invalid(`${toolName}: exactly one of messageId or threadId is required (both were provided).`);
  }

  let maxMessagesInThread = emailConfig.liveLookup.defaultMessagesPerThread;
  if (args.maxMessagesInThread != null) {
    const parsed = Number(args.maxMessagesInThread);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw invalid(`${toolName}: maxMessagesInThread must be a positive integer.`);
    }
    if (parsed > emailConfig.liveLookup.maxMessagesPerThread) {
      throw invalid(
        `${toolName}: maxMessagesInThread must not exceed ${emailConfig.liveLookup.maxMessagesPerThread}.`
      );
    }
    maxMessagesInThread = parsed;
  }

  return { messageId, threadId, maxMessagesInThread };
}

module.exports = {
  TOOL_NAMES,
  validateSearchEmailMessagesArgs,
  validateGetEmailContentArgs,
};
