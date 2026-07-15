const test = require('node:test');
const assert = require('node:assert/strict');
const {
  validateEncryptionKey,
  encryptCredential,
  decryptCredential,
  ENVELOPE_VERSION,
  KEY_ENV_VAR,
  LEGACY_KEY_ENV_VAR,
} = require('../services/integrationCredentialEncryption');

const VALID_KEY = 'a'.repeat(64); // 64 hex chars = 32 bytes
const OTHER_VALID_KEY = 'b'.repeat(64);
const PLAINTEXT = 'xoxb-test-slack-bot-token-should-never-leak';

/**
 * Sets/unsets an arbitrary set of env vars for the duration of fn, then
 * restores exactly what was there before. Assigning undefined to
 * process.env.X coerces to the string "undefined" rather than unsetting
 * it, so a missing var is simulated with delete instead.
 */
function withEnv(overrides, fn) {
  const originals = {};
  for (const key of Object.keys(overrides)) {
    originals[key] = process.env[key];
    const value = overrides[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(originals)) {
      const original = originals[key];
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
  }
}

// Sets only the primary (generic) key and clears the deprecated legacy one,
// so tests aren't affected by whatever the ambient environment (.env)
// happens to have configured for either name.
function withKey(key, fn) {
  return withEnv({ [KEY_ENV_VAR]: key, [LEGACY_KEY_ENV_VAR]: undefined }, fn);
}

// ─────────────────────────────────────────────
// validateEncryptionKey
// ─────────────────────────────────────────────

test('validateEncryptionKey accepts a well-formed 64-char hex key', () => {
  const buf = validateEncryptionKey(VALID_KEY);
  assert.equal(buf.length, 32);
});

test('validateEncryptionKey rejects a missing key', () => {
  assert.throws(() => validateEncryptionKey(undefined), /not configured/);
  assert.throws(() => validateEncryptionKey(''), /not configured/);
});

test('validateEncryptionKey rejects a non-hex key', () => {
  assert.throws(() => validateEncryptionKey('z'.repeat(64)), /hexadecimal/);
  assert.throws(() => validateEncryptionKey('not-hex-at-all-'.repeat(4)), /hexadecimal/);
});

test('validateEncryptionKey rejects a wrong-length key', () => {
  assert.throws(() => validateEncryptionKey('a'.repeat(32)), /64 hexadecimal characters/); // 16 bytes
  assert.throws(() => validateEncryptionKey('a'.repeat(128)), /64 hexadecimal characters/); // 64 bytes
});

test('validateEncryptionKey error messages reference the generic (preferred) variable name', () => {
  assert.throws(() => validateEncryptionKey(undefined), new RegExp(KEY_ENV_VAR));
  assert.equal(KEY_ENV_VAR, 'INTEGRATION_CREDENTIAL_ENCRYPTION_KEY');
});

// ─────────────────────────────────────────────
// Deprecated fallback: SLACK_TOKEN_ENCRYPTION_KEY
// ─────────────────────────────────────────────

test('falls back to the deprecated SLACK_TOKEN_ENCRYPTION_KEY when the generic key is unset', () => {
  withEnv({ [KEY_ENV_VAR]: undefined, [LEGACY_KEY_ENV_VAR]: VALID_KEY }, () => {
    const envelope = encryptCredential(PLAINTEXT);
    assert.equal(decryptCredential(envelope), PLAINTEXT);
  });
});

test('the generic variable takes priority over the deprecated one when both are set', () => {
  let envelope;
  withEnv({ [KEY_ENV_VAR]: VALID_KEY, [LEGACY_KEY_ENV_VAR]: OTHER_VALID_KEY }, () => {
    envelope = encryptCredential(PLAINTEXT);
  });

  // Proves the primary key was actually used: decrypting with only the
  // legacy key present must fail, since encryption used the primary key.
  withEnv({ [KEY_ENV_VAR]: undefined, [LEGACY_KEY_ENV_VAR]: OTHER_VALID_KEY }, () => {
    assert.throws(() => decryptCredential(envelope), /Credential decryption failed/);
  });
  // ...and decrypting with the primary key present succeeds.
  withEnv({ [KEY_ENV_VAR]: VALID_KEY, [LEGACY_KEY_ENV_VAR]: undefined }, () => {
    assert.equal(decryptCredential(envelope), PLAINTEXT);
  });
});

test('validation is identical whether the key came from the generic or legacy variable — a malformed legacy key is still rejected', () => {
  withEnv({ [KEY_ENV_VAR]: undefined, [LEGACY_KEY_ENV_VAR]: 'not-hex-data' }, () => {
    assert.throws(() => encryptCredential(PLAINTEXT), /hexadecimal/);
  });
  withEnv({ [KEY_ENV_VAR]: undefined, [LEGACY_KEY_ENV_VAR]: 'a'.repeat(32) }, () => {
    assert.throws(() => encryptCredential(PLAINTEXT), /64 hexadecimal characters/);
  });
});

test('neither variable set fails exactly like a missing key', () => {
  withEnv({ [KEY_ENV_VAR]: undefined, [LEGACY_KEY_ENV_VAR]: undefined }, () => {
    assert.throws(() => encryptCredential(PLAINTEXT), /not configured/);
  });
});

// ─────────────────────────────────────────────
// encrypt/decrypt round trip
// ─────────────────────────────────────────────

test('encryptCredential/decryptCredential round-trips the exact plaintext', () => {
  withKey(VALID_KEY, () => {
    const envelope = encryptCredential(PLAINTEXT);
    assert.equal(decryptCredential(envelope), PLAINTEXT);
  });
});

test('the same plaintext produces different ciphertext on each call (random IV)', () => {
  withKey(VALID_KEY, () => {
    const first = encryptCredential(PLAINTEXT);
    const second = encryptCredential(PLAINTEXT);
    assert.notEqual(first.ciphertext, second.ciphertext);
    assert.notEqual(first.iv, second.iv);
    // Both must still decrypt correctly despite differing ciphertext/IV.
    assert.equal(decryptCredential(first), PLAINTEXT);
    assert.equal(decryptCredential(second), PLAINTEXT);
  });
});

test('encryptCredential envelope matches the documented shape', () => {
  withKey(VALID_KEY, () => {
    const envelope = encryptCredential(PLAINTEXT);
    assert.equal(envelope.version, 1);
    assert.equal(envelope.algorithm, 'aes-256-gcm');
    assert.equal(typeof envelope.iv, 'string');
    assert.equal(typeof envelope.authTag, 'string');
    assert.equal(typeof envelope.ciphertext, 'string');
  });
});

test('encryptCredential rejects empty/non-string plaintext', () => {
  withKey(VALID_KEY, () => {
    assert.throws(() => encryptCredential(''), /non-empty string/);
    assert.throws(() => encryptCredential(null), /non-empty string/);
    assert.throws(() => encryptCredential(undefined), /non-empty string/);
    assert.throws(() => encryptCredential(12345), /non-empty string/);
  });
});

test('encryptCredential fails clearly when the key is missing', () => {
  withKey(undefined, () => {
    assert.throws(() => encryptCredential(PLAINTEXT), /not configured/);
  });
});

// ─────────────────────────────────────────────
// Envelope version vs. key version — deliberately distinct concerns
// ─────────────────────────────────────────────

test('the envelope carries a serialization-format version only — never a key-identity field', () => {
  withKey(VALID_KEY, () => {
    const envelope = encryptCredential(PLAINTEXT);
    // envelope.version == ENVELOPE_VERSION: which ciphertext FORMAT this is.
    // It has no opinion on which key encrypted it — that's tracked
    // separately (encryption_key_version, a DB column owned by
    // services/oauthConnectionsService.js), not embedded here.
    assert.equal(envelope.version, ENVELOPE_VERSION);
    assert.equal('keyVersion' in envelope, false);
    assert.equal('encryption_key_version' in envelope, false);
    assert.equal('key_version' in envelope, false);
    assert.deepEqual(Object.keys(envelope).sort(), ['algorithm', 'authTag', 'ciphertext', 'iv', 'version']);
  });
});

// ─────────────────────────────────────────────
// decryptCredential — malformed / tampered envelopes
// ─────────────────────────────────────────────

test('decryptCredential rejects a malformed envelope (missing fields)', () => {
  withKey(VALID_KEY, () => {
    assert.throws(() => decryptCredential({ version: 1, algorithm: 'aes-256-gcm' }), /missing required fields/);
    assert.throws(() => decryptCredential(null), /requires an envelope object/);
    assert.throws(() => decryptCredential('not-an-object'), /requires an envelope object/);
  });
});

test('decryptCredential rejects an unsupported envelope version', () => {
  withKey(VALID_KEY, () => {
    const envelope = encryptCredential(PLAINTEXT);
    assert.throws(() => decryptCredential({ ...envelope, version: 2 }), /Unsupported credential envelope version/);
  });
});

test('decryptCredential rejects an unsupported algorithm', () => {
  withKey(VALID_KEY, () => {
    const envelope = encryptCredential(PLAINTEXT);
    assert.throws(() => decryptCredential({ ...envelope, algorithm: 'aes-128-cbc' }), /Unsupported credential envelope algorithm/);
  });
});

test('decryptCredential rejects corrupted ciphertext', () => {
  withKey(VALID_KEY, () => {
    const envelope = encryptCredential(PLAINTEXT);
    const corrupted = { ...envelope, ciphertext: Buffer.from('this is not the right ciphertext').toString('base64') };
    assert.throws(() => decryptCredential(corrupted), /Credential decryption failed/);
  });
});

test('decryptCredential rejects a corrupted authentication tag', () => {
  withKey(VALID_KEY, () => {
    const envelope = encryptCredential(PLAINTEXT);
    const tagBuf = Buffer.from(envelope.authTag, 'base64');
    tagBuf[0] ^= 0xff; // flip a bit
    const corrupted = { ...envelope, authTag: tagBuf.toString('base64') };
    assert.throws(() => decryptCredential(corrupted), /Credential decryption failed/);
  });
});

test('decryptCredential rejects the wrong key', () => {
  const envelope = withKey(VALID_KEY, () => encryptCredential(PLAINTEXT));
  withKey(OTHER_VALID_KEY, () => {
    assert.throws(() => decryptCredential(envelope), /Credential decryption failed/);
  });
});

// ─────────────────────────────────────────────
// Exact persistence-format round trip (production path)
// ─────────────────────────────────────────────

test('the exact envelope written to oauth_credentials JSONB survives a JSON round trip and still decrypts', () => {
  withKey(VALID_KEY, () => {
    // Production path: plaintext -> encryptCredential() -> [written to a
    // JSONB column] -> [read back] -> decryptCredential() -> plaintext.
    // Postgres/Supabase serializes the JS object to JSON text on write and
    // parses it back into a plain object on read — JSON.stringify/parse
    // here is not a stand-in approximation, it is the exact transformation
    // JSONB storage performs.
    const envelope = encryptCredential(PLAINTEXT);

    const serializedForColumn = JSON.stringify(envelope);
    assert.ok(!serializedForColumn.includes(PLAINTEXT), 'serialized JSONB payload must never expose plaintext');

    const readBackFromColumn = JSON.parse(serializedForColumn);

    // Exact shape persisted — only the five documented fields.
    assert.deepEqual(Object.keys(readBackFromColumn).sort(), ['algorithm', 'authTag', 'ciphertext', 'iv', 'version']);

    // Types survive the JSON round trip: version stays a JS number (JSONB
    // preserves numeric types), the rest stay strings.
    assert.equal(typeof readBackFromColumn.version, 'number');
    assert.equal(readBackFromColumn.version, ENVELOPE_VERSION);
    assert.equal(typeof readBackFromColumn.algorithm, 'string');
    assert.equal(typeof readBackFromColumn.iv, 'string');
    assert.equal(typeof readBackFromColumn.authTag, 'string');
    assert.equal(typeof readBackFromColumn.ciphertext, 'string');

    // Decryption succeeds using exactly the object shape
    // getDecryptedCredentialForConnection would receive back from Supabase.
    assert.equal(decryptCredential(readBackFromColumn), PLAINTEXT);
  });
});

// ─────────────────────────────────────────────
// No secret leakage
// ─────────────────────────────────────────────

test('the plaintext token never appears in the serialized envelope', () => {
  withKey(VALID_KEY, () => {
    const envelope = encryptCredential(PLAINTEXT);
    const serialized = JSON.stringify(envelope);
    assert.ok(!serialized.includes(PLAINTEXT));
  });
});

test('errors never contain the plaintext token or the encryption key', () => {
  withKey(VALID_KEY, () => {
    const envelope = encryptCredential(PLAINTEXT);

    // Wrong key case
    let caught = null;
    withKey(OTHER_VALID_KEY, () => {
      try {
        decryptCredential(envelope);
      } catch (err) {
        caught = err;
      }
    });
    assert.ok(caught);
    assert.ok(!caught.message.includes(PLAINTEXT));
    assert.ok(!caught.message.includes(VALID_KEY));
    assert.ok(!caught.message.includes(OTHER_VALID_KEY));

    // Missing-key case
    let missingKeyErr = null;
    withKey(undefined, () => {
      try {
        encryptCredential(PLAINTEXT);
      } catch (err) {
        missingKeyErr = err;
      }
    });
    assert.ok(missingKeyErr);
    assert.ok(!missingKeyErr.message.includes(PLAINTEXT));
  });
});
