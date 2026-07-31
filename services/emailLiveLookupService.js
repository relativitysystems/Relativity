'use strict';

// EL4 — Gmail search and content tools (Architecture/architecture/
// LIVE_EMAIL_LOOKUP.md §1.1 steps 8-11, §4, §7, §9). Implements the two
// read-only tools search_email_messages/get_email_content behind the
// 8-gate authorization chain, called by services/toolExecutionService.js
// once a signed AIKB tool-call envelope has already been verified (EL3).
// No AIKB orchestration lives here (EL5) — this milestone is directly
// testable via a call to searchEmailMessages/getEmailContent, mirroring
// EM5's own "preview route before full pipeline" precedent
// (services/emailPreviewService.js).
//
// Every Gmail-facing call reuses gmailService.js unchanged
// (listMessageIdsByQuery/getMessageMetadata/getMessageBody/getThread);
// body normalization reuses emailNormalizationService.js#normalizeEmailBody
// unchanged; deny-rule re-verification reuses
// emailPolicyService.js#ruleMatchesMessage against deny rules only (§5.3 —
// allow-rule reuse is deliberately NOT done here: live lookup is gated by
// the 8 authorization gates below and the deny-list, never by the
// ingestion allow-list).
//
// Never throws for an authorization/eligibility/provider-failure outcome —
// those are named {status, reason} results (§9) the caller
// (toolExecutionService) returns as-is to AIKB. Only an unexpected
// exception (a bug, not a modeled outcome) propagates.

const { email: emailConfig } = require('../config');
const defaultGmailService = require('./gmailService');
const defaultOauthConnectionsService = require('./oauthConnectionsService');
const defaultEmailConnectionService = require('./emailConnectionService');
const defaultEmailPolicyService = require('./emailPolicyService');
const { ruleMatchesMessage } = require('./emailPolicyService');
const defaultEmailNormalizationService = require('./emailNormalizationService');
const defaultSupabaseService = require('./supabaseService');

const PROVIDER = 'gmail';

// §9's named result-shape reasons this file is able to distinguish today.
// `rate_limited` and a message-level `not_found` are explicitly NOT
// modeled here — gmailService.js's HTTP_ERROR doesn't currently propagate
// the real HTTP status code, so this file cannot tell a 429 apart from any
// other failed call. Every unclassified provider failure collapses to
// `provider_timeout`, per §9's own precedent for "AIKB->Relativity
// signed-request failure": "treated as provider_timeout-equivalent... the
// call itself didn't complete." Distinguishing rate_limited is a named,
// deliberate gap, not an oversight — revisit once gmailService surfaces
// the status code.
const REASONS = Object.freeze({
  NOT_CONNECTED: 'not_connected',
  NOT_PERMITTED: 'not_permitted',
  AUTH_EXPIRED: 'auth_expired',
  PROVIDER_TIMEOUT: 'provider_timeout',
});

function unavailable(reason) {
  return { status: 'unavailable', reason };
}
function toolError(reason) {
  return { status: 'error', reason };
}

/**
 * Races a Gmail-calling promise against this tool's own (tighter than
 * gmailService's internal 10s axios timeout) §4/§7 timeout cap. Rejects
 * with a recognizable `.liveLookupTimeout` marker so classifyGmailError can
 * tell "our own cap tripped" apart from "gmailService's own HTTP_ERROR."
 */
function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error('Live email lookup timed out');
      err.liveLookupTimeout = true;
      reject(err);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Any Gmail-facing failure this file catches — its own timeout or any
// gmailService-thrown error — is a `provider_timeout`-shaped {status:"error"}
// result (see the REASONS comment above for why this collapses rather than
// distinguishing further).
function classifyGmailError() {
  return toolError(REASONS.PROVIDER_TIMEOUT);
}

/**
 * The authorization gate chain (§1.1 step 8, §7): resolves the requesting
 * member's own Gmail connection and re-verifies every condition
 * independently of whatever ingestion already decided — a stale/cached
 * result is never trusted (§7: "every request re-verifies").
 *
 * Gates, in order (first failure wins):
 *   1. member exists, status = 'active'
 *   2. member.role != 'viewer'
 *   3. member.search_enabled = true
 *   4. member.live_lookup_consented_at is set (EL6, §2.3 — the member's own
 *      one-time product consent, distinct from Gmail's OAuth scope grant)
 *   5. an active oauth_connections row exists for this member+provider
 *   6. its email_connections row exists
 *   7. org email_organization_settings.live_lookup_enabled = true
 *   8. mailbox email_connections.live_lookup_enabled = true
 *   9. a valid (or silently refreshable) Gmail access token
 *
 * @returns {Promise<{ok:true, accessToken:string, connectionRow:object, emailConnectionRow:object, rules:object[]}|{ok:false, result:object}>}
 */
async function resolveAuthorizedMailbox({ deps, clientId, requestingMemberId }) {
  const { supabaseService, oauthConnectionsService, emailConnectionService, emailPolicyService } = deps;

  const member = await supabaseService.getClientMemberById(requestingMemberId, clientId);
  if (!member || member.status !== 'active' || member.role === 'viewer' || member.search_enabled === false) {
    return { ok: false, result: unavailable(REASONS.NOT_PERMITTED) };
  }
  // EL6 (§2.3) — the member's own one-time product consent for live,
  // per-question mailbox use. Explicitly separate from Gmail's OAuth scope
  // grant and from search_enabled above; re-verified on every request like
  // every other gate here, never trusted from a prior call.
  if (!member.live_lookup_consented_at) {
    return { ok: false, result: unavailable(REASONS.NOT_PERMITTED) };
  }

  const connectionRow = await oauthConnectionsService.getActiveConnectionForClientAndMember(clientId, PROVIDER, requestingMemberId);
  if (!connectionRow) {
    return { ok: false, result: unavailable(REASONS.NOT_CONNECTED) };
  }

  const emailConnectionRow = await emailConnectionService.getEmailConnectionRecord(connectionRow.id);
  if (!emailConnectionRow) {
    return { ok: false, result: unavailable(REASONS.NOT_CONNECTED) };
  }

  const settings = await emailPolicyService.getSettings(clientId);
  if (!settings.liveLookupEnabled || !emailConnectionRow.live_lookup_enabled) {
    return { ok: false, result: unavailable(REASONS.NOT_PERMITTED) };
  }

  let accessToken;
  try {
    accessToken = await emailConnectionService.getValidGmailAccessToken(connectionRow.id);
  } catch (err) {
    if (err.code === 'AUTHORIZATION_EXPIRED') return { ok: false, result: unavailable(REASONS.AUTH_EXPIRED) };
    throw err;
  }

  const { rules } = await emailPolicyService.getPolicy(clientId);

  return { ok: true, accessToken, connectionRow, emailConnectionRow, rules };
}

/**
 * EL6 (§1.1 step 4) — the cheap, DB-only availability check Relativity runs
 * on EVERY chat question to decide the `emailLookupAvailable` flag it
 * attaches to AIKB's `/query`/`/ask` request. Deliberately NOT
 * resolveAuthorizedMailbox: it skips the Gmail token refresh (and the
 * policy-rules fetch, unneeded here) — refreshing a token on every single
 * question regardless of whether the question needs live lookup would be
 * wasteful and would leak a Gmail-outage failure into unrelated stored-
 * knowledge answers. A token that turns out to be expired/unrefreshable
 * still surfaces correctly at actual tool-call time via
 * resolveAuthorizedMailbox's own `auth_expired` result — this function
 * only answers "is it even worth offering the tools," not "will the call
 * definitely succeed."
 *
 * @returns {Promise<boolean>}
 */
async function isLiveLookupAvailable({ deps, clientId, requestingMemberId }) {
  const { supabaseService, oauthConnectionsService, emailConnectionService, emailPolicyService } = deps;
  if (!clientId || !requestingMemberId) return false;

  const member = await supabaseService.getClientMemberById(requestingMemberId, clientId);
  if (!member || member.status !== 'active' || member.role === 'viewer' || member.search_enabled === false) return false;
  if (!member.live_lookup_consented_at) return false;

  const connectionRow = await oauthConnectionsService.getActiveConnectionForClientAndMember(clientId, PROVIDER, requestingMemberId);
  if (!connectionRow) return false;

  const emailConnectionRow = await emailConnectionService.getEmailConnectionRecord(connectionRow.id);
  if (!emailConnectionRow || !emailConnectionRow.live_lookup_enabled) return false;

  const settings = await emailPolicyService.getSettings(clientId);
  return Boolean(settings.liveLookupEnabled);
}

/**
 * §5.3 — deny-rule reuse, not allow-rule reuse: a candidate is dropped iff
 * an enabled deny rule matches it. No allow-rule gate is applied here at
 * all (unlike ingestion's evaluateMessageAgainstPolicy) — live lookup's own
 * authorization already happened in resolveAuthorizedMailbox above.
 */
function isDenied(rules, message) {
  const denyRules = (rules || []).filter((r) => r.enabled !== false && r.ruleType === 'deny');
  return denyRules.some((rule) => ruleMatchesMessage(rule, message));
}

function toPolicyMessage(meta) {
  return {
    provider: PROVIDER,
    fromAddress: meta.fromAddress,
    toAddresses: [],
    ccAddresses: [],
    subject: meta.subject,
    isSent: meta.isSent,
    labelsOrFolders: [],
  };
}

/**
 * §7's "Maximum date ranges" control: dateFrom/dateTo bounded to the org's
 * own max_historical_days policy setting — the most permissive enabled
 * rule's value (an org that allows a 730-day ingestion window shouldn't
 * have live lookup arbitrarily narrower), defaulting to
 * config.email.liveLookup.defaultMaxHistoricalDays (90, mirroring
 * emailPolicyService.js's own DEFAULT_MAX_HISTORICAL_DAYS) when the client
 * has no enabled rules yet.
 */
function computeMaxHistoricalDays(rules) {
  const enabledDays = (rules || [])
    .filter((r) => r.enabled !== false)
    .map((r) => r.maxHistoricalDays)
    .filter((n) => Number.isInteger(n) && n > 0);
  if (enabledDays.length === 0) return emailConfig.liveLookup.defaultMaxHistoricalDays;
  return Math.max(...enabledDays);
}

function clampDateFrom(dateFrom, maxHistoricalDays) {
  const earliestAllowedIso = new Date(Date.now() - maxHistoricalDays * 24 * 60 * 60 * 1000).toISOString();
  if (!dateFrom) return earliestAllowedIso;
  return Date.parse(dateFrom) < Date.parse(earliestAllowedIso) ? earliestAllowedIso : dateFrom;
}

function formatGmailDate(isoDate) {
  const d = new Date(isoDate);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}/${mm}/${dd}`;
}

/**
 * Compiles search_email_messages' structured arguments into a Gmail `q`
 * string — the model never constructs raw Gmail query syntax itself (§4:
 * "there is no code path by which model output becomes a raw Gmail query
 * string"). Unlike gmailService.compileSearchQuery (policy-rule-driven,
 * can return null for "zero candidates"), this always returns a usable
 * query: omitting every field yields just `-in:chats`, matching the tool's
 * own documented "omitting every field returns the most recent messages."
 */
function compileLiveSearchQuery(args) {
  const terms = [];
  if (args.senderContains) terms.push(`from:${args.senderContains}`);
  if (args.recipientContains) terms.push(`to:${args.recipientContains}`);
  if (args.subjectContains) terms.push(`subject:${args.subjectContains}`);
  if (args.keywords) terms.push(args.keywords);
  if (args.dateFrom) terms.push(`after:${formatGmailDate(args.dateFrom)}`);
  if (args.dateTo) terms.push(`before:${formatGmailDate(args.dateTo)}`);
  if (args.unreadOnly) terms.push('is:unread');
  if (args.hasAttachment) terms.push('has:attachment');
  if (args.attachmentNameContains) terms.push(`filename:${args.attachmentNameContains}`);
  terms.push('-in:chats');
  return terms.join(' ');
}

function capSnippet(snippet) {
  const max = emailConfig.liveLookup.snippetMaxChars;
  if (!snippet) return '';
  return snippet.length > max ? snippet.slice(0, max) : snippet;
}

function capBody({ messageId, threadId, subject, fromAddress, date, body }) {
  const max = emailConfig.liveLookup.bodyMaxChars;
  const truncated = body.length > max;
  return {
    messageId,
    threadId,
    subject,
    fromAddress,
    date,
    body: truncated ? body.slice(0, max) : body,
    truncated,
    // §6.2 — same URL shape as search's match objects above.
    deepLinkUrl: `https://mail.google.com/mail/u/0/#all/${messageId}`,
  };
}

/**
 * §4.2 — search_email_messages. `args` must already be validated/normalized
 * by services/emailToolValidation.js#validateSearchEmailMessagesArgs
 * (maxResults is trusted here to already be within
 * config.email.liveLookup.maxResultsPerSearch).
 */
async function searchEmailMessages({ deps, clientId, requestingMemberId, args }) {
  const { gmailService } = deps;

  const auth = await resolveAuthorizedMailbox({ deps, clientId, requestingMemberId });
  if (!auth.ok) return auth.result;

  const maxHistoricalDays = computeMaxHistoricalDays(auth.rules);
  const boundedDateFrom = clampDateFrom(args.dateFrom, maxHistoricalDays);
  const query = compileLiveSearchQuery({ ...args, dateFrom: boundedDateFrom });

  let listResult;
  try {
    listResult = await withTimeout(
      gmailService.listMessageIdsByQuery({ accessToken: auth.accessToken, query, maxResults: args.maxResults }),
      emailConfig.liveLookup.searchTimeoutMs
    );
  } catch {
    return classifyGmailError();
  }

  const matches = [];
  for (const messageId of listResult.messageIds) {
    let meta;
    try {
      // Best-effort per candidate — one message that fails to fetch (e.g. a
      // transient error) never fails the whole search, mirroring
      // emailSyncService.js#processCandidateMessage's per-message isolation.
      meta = await withTimeout(
        gmailService.getMessageMetadata({ accessToken: auth.accessToken, messageId }),
        emailConfig.liveLookup.searchTimeoutMs
      );
    } catch {
      continue;
    }

    if (isDenied(auth.rules, toPolicyMessage(meta))) continue;

    matches.push({
      messageId: meta.messageId,
      threadId: meta.threadId,
      subject: meta.subject,
      fromAddress: meta.fromAddress,
      date: meta.date,
      snippet: capSnippet(meta.snippet),
      // §6.2 — same URL shape as ingestion's existing citation deep link
      // (emailSyncService.js), Gmail-only for now (matches this file's
      // existing Gmail-only scope).
      deepLinkUrl: `https://mail.google.com/mail/u/0/#all/${meta.messageId}`,
    });
  }

  return {
    status: 'ok',
    matches,
    truncated: Boolean(listResult.nextPageToken) || listResult.messageIds.length >= args.maxResults,
  };
}

/**
 * §4.3 — get_email_content. `args` must already be validated/normalized by
 * emailToolValidation.js#validateGetEmailContentArgs (exactly one of
 * messageId/threadId is guaranteed present).
 *
 * Cross-mailbox isolation (§7: "Searching another employee's mailbox") is
 * structural, not a separate check: every Gmail call below is made with
 * `auth.accessToken`, the requesting member's own OAuth token, and Gmail's
 * `users/me/...` endpoints are scoped to whatever mailbox that token
 * belongs to — a messageId/threadId from a different mailbox simply 404s
 * inside gmailService, never resolves.
 */
async function getEmailContent({ deps, clientId, requestingMemberId, args }) {
  const { gmailService, emailNormalizationService } = deps;

  const auth = await resolveAuthorizedMailbox({ deps, clientId, requestingMemberId });
  if (!auth.ok) return auth.result;

  if (args.threadId) {
    let thread;
    try {
      thread = await withTimeout(
        gmailService.getThread({ accessToken: auth.accessToken, threadId: args.threadId }),
        emailConfig.liveLookup.contentTimeoutMs
      );
    } catch {
      return classifyGmailError();
    }

    const capped = thread.messages.slice(0, args.maxMessagesInThread);
    const messages = [];
    for (const m of capped) {
      if (isDenied(auth.rules, toPolicyMessage(m))) continue;
      const body = emailNormalizationService.normalizeEmailBody({ html: m.html, text: m.text });
      messages.push(capBody({ messageId: m.messageId, threadId: m.threadId, subject: m.subject, fromAddress: m.fromAddress, date: m.date, body }));
    }

    return { status: 'ok', threadId: args.threadId, messages, truncated: thread.messages.length > args.maxMessagesInThread };
  }

  // messageId branch.
  let meta;
  try {
    meta = await withTimeout(
      gmailService.getMessageMetadata({ accessToken: auth.accessToken, messageId: args.messageId }),
      emailConfig.liveLookup.contentTimeoutMs
    );
  } catch {
    return classifyGmailError();
  }

  // A deny-listed single message is reported the same way "nothing found"
  // is (§9's zero-matches precedent), not as a distinct error — the caller
  // has no legitimate need to know a message exists but was excluded.
  if (isDenied(auth.rules, toPolicyMessage(meta))) {
    return { status: 'ok', messages: [], truncated: false };
  }

  let normalized;
  try {
    const raw = await withTimeout(
      gmailService.getMessageBody({ accessToken: auth.accessToken, messageId: args.messageId }),
      emailConfig.liveLookup.contentTimeoutMs
    );
    normalized = emailNormalizationService.normalizeEmailBody({ html: raw.html, text: raw.text });
  } catch {
    return classifyGmailError();
  }

  return {
    status: 'ok',
    messages: [capBody({ messageId: meta.messageId, threadId: meta.threadId, subject: meta.subject, fromAddress: meta.fromAddress, date: meta.date, body: normalized })],
    truncated: false,
  };
}

/**
 * @param {object} [deps] — injected for testing; each defaults to the real singleton service.
 */
function createEmailLiveLookupService({
  gmailService = defaultGmailService,
  oauthConnectionsService = defaultOauthConnectionsService,
  emailConnectionService = defaultEmailConnectionService,
  emailPolicyService = defaultEmailPolicyService,
  emailNormalizationService = defaultEmailNormalizationService,
  supabaseService = defaultSupabaseService,
} = {}) {
  const deps = { gmailService, oauthConnectionsService, emailConnectionService, emailPolicyService, emailNormalizationService, supabaseService };

  return {
    searchEmailMessages: (params) => searchEmailMessages({ deps, ...params }),
    getEmailContent: (params) => getEmailContent({ deps, ...params }),
    isLiveLookupAvailable: (params) => isLiveLookupAvailable({ deps, ...params }),
  };
}

const defaultService = createEmailLiveLookupService();

module.exports = {
  ...defaultService,
  createEmailLiveLookupService,
  REASONS,
  compileLiveSearchQuery,
  computeMaxHistoricalDays,
};
