'use strict';

// Coverage for config/index.js's newly centralized operational values
// (hardcoded-values audit follow-up): the transcription model pair, the
// admin-login/team-invite/password-reset rate-limit thresholds, and the
// email sync/preview page sizes. Each is asserted for (a) its pre-existing
// default when the env var is unset and (b) picking up an explicit
// override. config/index.js is a singleton module re-evaluated from
// process.env on every require, so each test re-requires it fresh via
// require.cache busting (same pattern used on the AIKB side).

const test = require('node:test');
const assert = require('node:assert/strict');

const configPath = require.resolve('../config');

// The env vars this suite manipulates, so each test can save/restore them
// and never leak a value into another test or file.
const MANAGED_VARS = [
  'OPENAI_TRANSCRIBE_PRIMARY_MODEL',
  'OPENAI_TRANSCRIBE_FALLBACK_MODEL',
  'ADMIN_LOGIN_RATE_LIMIT_WINDOW_MS',
  'ADMIN_LOGIN_RATE_LIMIT_MAX',
  'TEAM_INVITE_RATE_LIMIT_WINDOW_MS',
  'TEAM_INVITE_RATE_LIMIT_MAX',
  'PASSWORD_RESET_RATE_LIMIT_WINDOW_MS',
  'PASSWORD_RESET_RATE_LIMIT_MAX_ATTEMPTS',
  'EMAIL_HISTORICAL_SYNC_PAGE_SIZE',
  'EMAIL_PREVIEW_PAGE_SIZE',
];

// Loads a fresh config/index.js under the given env overrides (merged onto
// the current process.env), restoring every managed var to its prior value
// (or deleting it, if it was never set) once `fn` returns/throws. Values are
// set to '' rather than deleted to represent "unset" — config/index.js calls
// dotenv on every require, and dotenv only fills in keys entirely absent
// from process.env, so deleting one here would let a real .env file
// silently repopulate it and defeat the test.
function withConfig(envOverrides, fn) {
  const saved = {};
  for (const key of MANAGED_VARS) saved[key] = process.env[key];

  for (const key of MANAGED_VARS) process.env[key] = '';
  Object.assign(process.env, envOverrides);

  delete require.cache[configPath];
  try {
    return fn(require('../config'));
  } finally {
    for (const key of MANAGED_VARS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    delete require.cache[configPath];
  }
}

test('openai transcription model pair defaults when unset', () => {
  withConfig({}, (config) => {
    assert.equal(config.openai.transcribePrimaryModel, 'gpt-4o-mini-transcribe');
    assert.equal(config.openai.transcribeFallbackModel, 'whisper-1');
  });
});

test('openai transcription model pair picks up env overrides', () => {
  withConfig({
    OPENAI_TRANSCRIBE_PRIMARY_MODEL: 'gpt-5-transcribe',
    OPENAI_TRANSCRIBE_FALLBACK_MODEL: 'whisper-2',
  }, (config) => {
    assert.equal(config.openai.transcribePrimaryModel, 'gpt-5-transcribe');
    assert.equal(config.openai.transcribeFallbackModel, 'whisper-2');
  });
});

test('rateLimits default to the pre-existing literals when unset', () => {
  withConfig({}, (config) => {
    assert.equal(config.rateLimits.adminLogin.windowMs, 15 * 60 * 1000);
    assert.equal(config.rateLimits.adminLogin.max, 10);
    assert.equal(config.rateLimits.teamInvite.windowMs, 15 * 60 * 1000);
    assert.equal(config.rateLimits.teamInvite.max, 30);
    assert.equal(config.rateLimits.passwordReset.windowMs, 10 * 60 * 1000);
    assert.equal(config.rateLimits.passwordReset.maxAttempts, 3);
  });
});

test('rateLimits pick up env overrides independently', () => {
  withConfig({
    ADMIN_LOGIN_RATE_LIMIT_WINDOW_MS: '60000',
    ADMIN_LOGIN_RATE_LIMIT_MAX: '5',
    TEAM_INVITE_RATE_LIMIT_MAX: '50',
    PASSWORD_RESET_RATE_LIMIT_MAX_ATTEMPTS: '5',
  }, (config) => {
    assert.equal(config.rateLimits.adminLogin.windowMs, 60000);
    assert.equal(config.rateLimits.adminLogin.max, 5);
    // Untouched overrides keep their defaults.
    assert.equal(config.rateLimits.teamInvite.windowMs, 15 * 60 * 1000);
    assert.equal(config.rateLimits.teamInvite.max, 50);
    assert.equal(config.rateLimits.passwordReset.maxAttempts, 5);
  });
});

test('an invalid rate-limit override fails clearly rather than silently coercing', () => {
  assert.throws(
    () => withConfig({ ADMIN_LOGIN_RATE_LIMIT_MAX: 'abc' }, (config) => config),
    /Invalid ADMIN_LOGIN_RATE_LIMIT_MAX: must be a positive integer/
  );
  assert.throws(
    () => withConfig({ PASSWORD_RESET_RATE_LIMIT_MAX_ATTEMPTS: '0' }, (config) => config),
    /Invalid PASSWORD_RESET_RATE_LIMIT_MAX_ATTEMPTS/
  );
  assert.throws(
    () => withConfig({ TEAM_INVITE_RATE_LIMIT_WINDOW_MS: '-100' }, (config) => config),
    /Invalid TEAM_INVITE_RATE_LIMIT_WINDOW_MS/
  );
});

test('email sync/preview page sizes default to the pre-existing literals when unset', () => {
  withConfig({}, (config) => {
    assert.equal(config.email.historicalSyncPageSize, 25);
    assert.equal(config.email.previewPageSize, 10);
  });
});

test('email sync/preview page sizes pick up env overrides', () => {
  withConfig({ EMAIL_HISTORICAL_SYNC_PAGE_SIZE: '40', EMAIL_PREVIEW_PAGE_SIZE: '20' }, (config) => {
    assert.equal(config.email.historicalSyncPageSize, 40);
    assert.equal(config.email.previewPageSize, 20);
  });
});

test('a non-integer email page-size override fails clearly', () => {
  assert.throws(
    () => withConfig({ EMAIL_HISTORICAL_SYNC_PAGE_SIZE: '3.5' }, (config) => config),
    /Invalid EMAIL_HISTORICAL_SYNC_PAGE_SIZE/
  );
});
