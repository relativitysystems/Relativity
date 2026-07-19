const test = require('node:test');
const assert = require('node:assert/strict');
const { retryWithBackoff } = require('../services/retryWithBackoff');

function fakeSleep(calls) {
  return async (ms) => { calls.push(ms); };
}

test('succeeds on the first attempt with no sleep', async () => {
  const sleepCalls = [];
  let callCount = 0;

  const { value, attempts } = await retryWithBackoff(async () => {
    callCount++;
    return 'ok';
  }, { sleep: fakeSleep(sleepCalls) });

  assert.equal(value, 'ok');
  assert.equal(attempts, 1);
  assert.equal(callCount, 1);
  assert.deepEqual(sleepCalls, []);
});

test('retries after a failure and succeeds on attempt 2, waiting the configured backoff once', async () => {
  const sleepCalls = [];
  let callCount = 0;

  const { value, attempts } = await retryWithBackoff(async () => {
    callCount++;
    if (callCount === 1) throw new Error('transient');
    return 'ok';
  }, { attempts: 3, backoffMs: [2000, 5000], sleep: fakeSleep(sleepCalls) });

  assert.equal(value, 'ok');
  assert.equal(attempts, 2);
  assert.equal(callCount, 2);
  assert.deepEqual(sleepCalls, [2000], 'only one backoff wait should occur before the second (successful) attempt');
});

test('exhausts all attempts, waiting between each, then throws the last error tagged with .attempts', async () => {
  const sleepCalls = [];
  let callCount = 0;

  await assert.rejects(
    () => retryWithBackoff(async () => {
      callCount++;
      throw Object.assign(new Error('down'), { code: 'BOOM' });
    }, { attempts: 3, backoffMs: [2000, 5000], sleep: fakeSleep(sleepCalls) }),
    (err) => {
      assert.equal(err.code, 'BOOM');
      assert.equal(err.attempts, 3);
      return true;
    }
  );

  assert.equal(callCount, 3, 'exactly 3 total attempts: initial + retry #1 + retry #2');
  assert.deepEqual(sleepCalls, [2000, 5000], 'a wait must happen between each attempt, never after the final one');
});

test('reuses the last configured backoff value if there are more attempts than backoff entries', async () => {
  const sleepCalls = [];

  await assert.rejects(
    () => retryWithBackoff(async () => { throw new Error('down'); }, { attempts: 4, backoffMs: [1000], sleep: fakeSleep(sleepCalls) })
  );

  assert.deepEqual(sleepCalls, [1000, 1000, 1000]);
});
