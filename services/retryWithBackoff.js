'use strict';

// Generic bounded-retry helper (ADR-007 — bounded, immediate, in-flow Slack
// delivery retries, replacing the removed scheduled sweep). Not Slack-
// specific: any async operation that can fail transiently can use this.
// Every retry happens synchronously within the calling request/function's
// own execution — nothing here schedules, persists, or revisits work later.

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_BACKOFF_MS = [2000, 5000];

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Calls `fn` up to `attempts` times (1-indexed attempt number passed in),
 * waiting `backoffMs[i]` between attempt i+1 and i+2 (the last configured
 * backoff value is reused if there are more attempts than backoff entries).
 * Returns the first successful result; throws the last error, tagged with
 * `.attempts`, once every attempt is exhausted.
 *
 * @param {(attempt: number) => Promise<any>} fn
 * @param {object} [opts]
 * @param {number} [opts.attempts]
 * @param {number[]} [opts.backoffMs]
 * @param {(ms: number) => Promise<void>} [opts.sleep] - injectable for tests.
 * @returns {Promise<{ value: any, attempts: number }>}
 */
async function retryWithBackoff(fn, { attempts = DEFAULT_ATTEMPTS, backoffMs = DEFAULT_BACKOFF_MS, sleep = defaultSleep } = {}) {
  const boundedAttempts = Number.isInteger(attempts) && attempts > 0 ? attempts : DEFAULT_ATTEMPTS;
  let lastError;

  for (let attempt = 1; attempt <= boundedAttempts; attempt++) {
    try {
      const value = await fn(attempt);
      return { value, attempts: attempt };
    } catch (err) {
      lastError = err;
      if (attempt < boundedAttempts) {
        const delay = backoffMs[attempt - 1] ?? backoffMs[backoffMs.length - 1] ?? 0;
        await sleep(delay);
      }
    }
  }

  const err = lastError instanceof Error ? lastError : new Error('retryWithBackoff: all attempts failed');
  err.attempts = boundedAttempts;
  throw err;
}

module.exports = { retryWithBackoff, DEFAULT_ATTEMPTS, DEFAULT_BACKOFF_MS };
