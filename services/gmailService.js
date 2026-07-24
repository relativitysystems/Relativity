'use strict';

// Gmail OAuth client (EM2 — Architecture/architecture/EMAIL_INGESTION.md §10,
// §12). Mirrors services/slackService.js's shape one-for-one: provider-
// specific, dependency-injected httpClient so tests never make a real
// network call, no Gmail message-reading/sync logic here — that begins at
// EM5+. Scope is deliberately minimal for EM2: gmail.readonly + identity
// only, no gmail.labels (that's EM4, when the managed label is built).

const axios = require('axios');
const { gmail } = require('../config');

const REQUIRED_SCOPES = ['https://www.googleapis.com/auth/gmail.readonly', 'openid', 'email', 'profile'];

const OAUTH_TIMEOUT_MS = 10000;

const ERROR_CODES = Object.freeze({
  NOT_CONFIGURED: 'GMAIL_NOT_CONFIGURED',
  HTTP_ERROR: 'GMAIL_HTTP_ERROR',
  INVALID_RESPONSE: 'GMAIL_INVALID_RESPONSE',
  OAUTH_FAILED: 'GMAIL_OAUTH_FAILED',
});

function gmailError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function isGmailConfigured() {
  return Boolean(gmail.clientId && gmail.clientSecret && gmail.redirectUri);
}

/**
 * Builds Google's OAuth 2.0 authorization-code consent URL. Pure — no
 * network access. Never includes the client secret. `access_type=offline`
 * plus `prompt=consent` guarantee a refresh token is issued on every
 * connect, not just the first one ever for that Google account.
 */
function buildAuthorizationUrl({ state }) {
  if (!isGmailConfigured()) throw gmailError(ERROR_CODES.NOT_CONFIGURED, 'Gmail OAuth is not configured');
  if (!state || typeof state !== 'string') throw new Error('buildAuthorizationUrl requires state');

  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', gmail.clientId);
  authUrl.searchParams.set('redirect_uri', gmail.redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', REQUIRED_SCOPES.join(' '));
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent');
  authUrl.searchParams.set('state', state);
  return authUrl.toString();
}

/**
 * Validates the shape of Google's token-exchange response. Pure — no
 * network access. Never echoes the raw response back to a caller.
 */
function validateTokenResponse(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw gmailError(ERROR_CODES.INVALID_RESPONSE, 'Gmail token response was not a valid object');
  }
  if (typeof data.access_token !== 'string' || data.access_token.length === 0) {
    throw gmailError(ERROR_CODES.INVALID_RESPONSE, 'Gmail token response is missing an access token');
  }
  if (typeof data.refresh_token !== 'string' || data.refresh_token.length === 0) {
    throw gmailError(ERROR_CODES.INVALID_RESPONSE, 'Gmail token response is missing a refresh token');
  }

  const scopes = typeof data.scope === 'string'
    ? data.scope.split(' ').map((s) => s.trim()).filter(Boolean)
    : [];

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresInSeconds: typeof data.expires_in === 'number' ? data.expires_in : null,
    tokenType: typeof data.token_type === 'string' ? data.token_type : null,
    scopes,
  };
}

/**
 * Validates the shape of Google's OpenID Connect userinfo response. Pure —
 * no network access.
 */
function validateUserInfoResponse(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw gmailError(ERROR_CODES.INVALID_RESPONSE, 'Gmail userinfo response was not a valid object');
  }
  if (typeof data.sub !== 'string' || data.sub.length === 0) {
    throw gmailError(ERROR_CODES.INVALID_RESPONSE, 'Gmail userinfo response is missing a subject id');
  }
  if (typeof data.email !== 'string' || data.email.length === 0) {
    throw gmailError(ERROR_CODES.INVALID_RESPONSE, 'Gmail userinfo response is missing an email address');
  }

  return {
    externalAccountId: data.sub,
    mailboxAddress: data.email,
    displayName: typeof data.name === 'string' && data.name.length > 0 ? data.name : null,
  };
}

/**
 * @param {{ httpClient?: { post: Function, get: Function } }} [deps] — injected for testing; defaults to axios.
 */
function createGmailService({ httpClient = axios } = {}) {
  /**
   * Exchanges an authorization code for tokens, then resolves the connected
   * mailbox's address/display name via the OpenID Connect userinfo
   * endpoint. Returns one normalized object so callers (emailConnectionService)
   * never need to make a second round trip themselves.
   */
  async function exchangeCodeForToken(code) {
    if (!isGmailConfigured()) throw gmailError(ERROR_CODES.NOT_CONFIGURED, 'Gmail OAuth is not configured');
    if (!code || typeof code !== 'string') throw new Error('exchangeCodeForToken requires code');

    const params = new URLSearchParams({
      code,
      client_id: gmail.clientId,
      client_secret: gmail.clientSecret,
      redirect_uri: gmail.redirectUri,
      grant_type: 'authorization_code',
    });

    let tokenResponse;
    try {
      tokenResponse = await httpClient.post('https://oauth2.googleapis.com/token', params.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: OAUTH_TIMEOUT_MS,
      });
    } catch {
      // Deliberately generic — never surface err.message here: the request
      // config (and any axios error object built from it) retains the
      // client secret and must never be echoed to a caller or logged.
      throw gmailError(ERROR_CODES.HTTP_ERROR, 'Gmail OAuth token exchange request failed');
    }

    if (!tokenResponse || tokenResponse.status < 200 || tokenResponse.status >= 300) {
      throw gmailError(ERROR_CODES.HTTP_ERROR, 'Gmail OAuth token exchange returned an unsuccessful HTTP status');
    }

    const token = validateTokenResponse(tokenResponse.data);

    let userInfoResponse;
    try {
      userInfoResponse = await httpClient.get('https://openidconnect.googleapis.com/v1/userinfo', {
        headers: { Authorization: `Bearer ${token.accessToken}` },
        timeout: OAUTH_TIMEOUT_MS,
      });
    } catch {
      throw gmailError(ERROR_CODES.HTTP_ERROR, 'Gmail userinfo request failed');
    }

    if (!userInfoResponse || userInfoResponse.status < 200 || userInfoResponse.status >= 300) {
      throw gmailError(ERROR_CODES.HTTP_ERROR, 'Gmail userinfo request returned an unsuccessful HTTP status');
    }

    const identity = validateUserInfoResponse(userInfoResponse.data);

    return {
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      expiresAt: token.expiresInSeconds ? new Date(Date.now() + token.expiresInSeconds * 1000).toISOString() : null,
      scopes: token.scopes,
      externalAccountId: identity.externalAccountId,
      mailboxAddress: identity.mailboxAddress,
      displayName: identity.displayName,
    };
  }

  /**
   * Best-effort provider-side revocation. Never throws — callers must be
   * able to proceed with local revocation regardless of whether Google's
   * own revocation succeeded. Returns a boolean only.
   */
  async function revokeToken(token) {
    if (!token || typeof token !== 'string') return false;
    try {
      const params = new URLSearchParams({ token });
      const response = await httpClient.post('https://oauth2.googleapis.com/revoke', params.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: OAUTH_TIMEOUT_MS,
      });
      return Boolean(response && response.status >= 200 && response.status < 300);
    } catch {
      return false;
    }
  }

  return { exchangeCodeForToken, revokeToken };
}

const defaultService = createGmailService();

module.exports = {
  ...defaultService,
  createGmailService,
  buildAuthorizationUrl,
  validateTokenResponse,
  validateUserInfoResponse,
  isGmailConfigured,
  REQUIRED_SCOPES,
  ERROR_CODES,
};
