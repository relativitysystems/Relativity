'use strict';

// Focused AES-256-GCM encryption for OAuth integration credentials
// (Architecture Review Phase 4, Milestone 2). Fully provider-neutral: this
// module has never known about Slack specifically at the API/logic level,
// and as of this revision it no longer does at the config level either —
// it reads the generic INTEGRATION_CREDENTIAL_ENCRYPTION_KEY, with a
// deprecated, temporary fallback to the old SLACK_TOKEN_ENCRYPTION_KEY name
// so an already-configured environment (e.g. a developer's local .env, or
// this branch's own .env.example history) does not break outright. Do not
// set both — set only INTEGRATION_CREDENTIAL_ENCRYPTION_KEY. Fallback
// support for the deprecated name is temporary and will be removed in a
// future migration once every environment has been updated.
//
// Key rotation (backlog M3). The envelope's `version` field (serialization
// / algorithm format) and the separate `encryption_key_version` column on
// oauth_credentials (services/oauthConnectionsService.js — which configured
// key encrypted this row) are deliberately two different concerns and are
// never merged into one field. Envelope version changes when the ciphertext
// *format* changes (e.g. a future algorithm); key version changes when the
// *key material* rotates while the format stays identical.
//
// Rotation model: INTEGRATION_CREDENTIAL_ENCRYPTION_KEY is always the key
// for the CURRENT version (identified by INTEGRATION_CREDENTIAL_ENCRYPTION_KEY_VERSION,
// an integer defaulting to 1 if unset — every environment configured before
// this change is version 1 with no action required). To rotate: pick a new
// version number, set INTEGRATION_CREDENTIAL_ENCRYPTION_KEY to a fresh key,
// bump INTEGRATION_CREDENTIAL_ENCRYPTION_KEY_VERSION to the new number, and
// keep the OLD key available under INTEGRATION_CREDENTIAL_ENCRYPTION_KEY_V{oldVersion}
// (e.g. INTEGRATION_CREDENTIAL_ENCRYPTION_KEY_V1) so rows still encrypted
// under it keep decrypting while services/oauthConnectionsService.js#
// reencryptCredentialForConnection re-encrypts them under the new key. Once
// every row's encryption_key_version matches the current version, the old
// INTEGRATION_CREDENTIAL_ENCRYPTION_KEY_V{oldVersion} variable can be removed.
const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const ENVELOPE_VERSION = 1;
const KEY_BYTES = 32;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const KEY_ENV_VAR = 'INTEGRATION_CREDENTIAL_ENCRYPTION_KEY';
// @deprecated — temporary fallback only, see the module comment above.
const LEGACY_KEY_ENV_VAR = 'SLACK_TOKEN_ENCRYPTION_KEY';
const KEY_VERSION_ENV_VAR = 'INTEGRATION_CREDENTIAL_ENCRYPTION_KEY_VERSION';
const HEX_64_PATTERN = /^[0-9a-fA-F]{64}$/;
const DEFAULT_KEY_VERSION = 1;

let legacyKeyFallbackWarned = false;

/**
 * Resolves the raw key string from the environment: the generic variable
 * first, falling back to the deprecated Slack-specific one if that's all
 * that's configured. Never reads config/index.js's cached snapshot — see
 * validateEncryptionKey's doc comment for why.
 */
function resolveRawKeyFromEnv() {
  const primary = process.env[KEY_ENV_VAR];
  if (primary) return primary;

  const legacy = process.env[LEGACY_KEY_ENV_VAR];
  if (legacy) {
    if (!legacyKeyFallbackWarned) {
      legacyKeyFallbackWarned = true;
      console.warn(
        `[integrationCredentialEncryption] ${LEGACY_KEY_ENV_VAR} is deprecated — ` +
        `set ${KEY_ENV_VAR} instead. Fallback support will be removed in a future migration.`
      );
    }
    return legacy;
  }

  return undefined;
}

/**
 * Which key version INTEGRATION_CREDENTIAL_ENCRYPTION_KEY currently
 * represents. Defaults to 1 so every environment configured before M3
 * (a single, unversioned key) keeps working with zero config changes.
 * Read lazily (not cached) for the same "catch misconfiguration at use
 * time" reason validateEncryptionKey reads process.env directly.
 */
function getCurrentKeyVersion() {
  const raw = process.env[KEY_VERSION_ENV_VAR];
  if (raw === undefined || raw === '') return DEFAULT_KEY_VERSION;

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${KEY_VERSION_ENV_VAR} must be a positive integer`);
  }
  return parsed;
}

/**
 * Resolves the raw key string for a specific key version. The current
 * version reads from the same variable(s) validateEncryptionKey always
 * has (including the deprecated legacy fallback); any other (retired)
 * version reads from a dedicated `${KEY_ENV_VAR}_V{version}` variable that
 * only needs to exist while rotation-in-progress rows under that old
 * version still need decrypting.
 */
function resolveRawKeyForVersion(version) {
  if (version === getCurrentKeyVersion()) return resolveRawKeyFromEnv();
  return process.env[`${KEY_ENV_VAR}_V${version}`];
}

/**
 * Validates and returns the encryption key as a Buffer.
 *
 * Reads process.env directly (not the cached config/index.js snapshot) so a
 * missing/rotated/misconfigured key is caught at the moment of use, not
 * only at server-start time — this is what makes validation "lazy" per the
 * Phase 4 Milestone 2 requirement. config/index.js still exposes the same
 * variable for status/discoverability purposes only; it is not read here.
 *
 * Validation (hex format, exact length) is identical regardless of which
 * env var supplied the raw string — the deprecated fallback never weakens
 * this check, it only changes where the string is read from.
 *
 * @param {string} [rawKey] — override for testing; defaults to the env var(s).
 * @returns {Buffer} exactly KEY_BYTES long.
 */
function validateEncryptionKey(rawKey = resolveRawKeyFromEnv()) {
  if (!rawKey || typeof rawKey !== 'string') {
    throw new Error(`${KEY_ENV_VAR} is not configured`);
  }
  if (!HEX_64_PATTERN.test(rawKey)) {
    throw new Error(`${KEY_ENV_VAR} must be exactly 64 hexadecimal characters (32 bytes)`);
  }

  const keyBuffer = Buffer.from(rawKey, 'hex');
  if (keyBuffer.length !== KEY_BYTES) {
    // Unreachable given the regex above, but kept as an explicit invariant
    // check rather than trusting the regex alone to guarantee byte length.
    throw new Error(`${KEY_ENV_VAR} must decode to exactly ${KEY_BYTES} bytes`);
  }

  return keyBuffer;
}

/**
 * Validates and returns the key Buffer for a specific key version — the
 * version-aware counterpart to validateEncryptionKey (which always resolves
 * whatever the CURRENT key is). Used by decryptCredential so a row
 * encrypted under a retired version is decrypted with that version's key,
 * not whatever key happens to be current right now.
 *
 * @param {number} version
 * @returns {Buffer} exactly KEY_BYTES long.
 */
function resolveKeyForVersion(version) {
  const rawKey = resolveRawKeyForVersion(version);
  if (!rawKey || typeof rawKey !== 'string') {
    throw new Error(
      version === getCurrentKeyVersion()
        ? `${KEY_ENV_VAR} is not configured`
        : `${KEY_ENV_VAR}_V${version} is not configured — required to decrypt a row still under key version ${version}`
    );
  }
  return validateEncryptionKey(rawKey);
}

/**
 * Encrypts a plaintext credential (an OAuth access or refresh token) into a
 * versioned envelope. A fresh random IV is generated on every call, so
 * identical plaintext never produces identical ciphertext twice.
 *
 * The returned envelope's `version` field is the serialization/algorithm
 * format version (ENVELOPE_VERSION, currently always 1) — NOT which key was
 * used to encrypt. Callers (services/oauthConnectionsService.js) record
 * which key was used separately, in the `encryption_key_version` column on
 * oauth_credentials. This function knows nothing about key versions; it
 * only ever uses whatever key validateEncryptionKey() currently resolves.
 *
 * @param {string} plaintext
 * @returns {{version:number, algorithm:string, iv:string, authTag:string, ciphertext:string}}
 */
function encryptCredential(plaintext) {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new Error('encryptCredential requires a non-empty string plaintext');
  }

  const key = validateEncryptionKey();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_BYTES });
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    version: ENVELOPE_VERSION,
    algorithm: ALGORITHM,
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

/**
 * Decrypts a versioned envelope back into the plaintext credential.
 * Authenticated decryption (GCM) means a wrong key, corrupted ciphertext,
 * or a tampered auth tag all fail the same way — decipher.final() throws
 * internally, which Node implements as a constant-time tag comparison.
 * No additional manual crypto.timingSafeEqual comparison is added here: it
 * would be a redundant, meaningless check layered on top of a primitive
 * that already provides authenticated (tamper-evident) decryption.
 *
 * There is never a plaintext fallback: any failure below throws instead of
 * returning partial or unauthenticated plaintext.
 *
 * @param {{version:number, algorithm:string, iv:string, authTag:string, ciphertext:string}} envelope
 * @param {number} [keyVersion] — which key encrypted this envelope (the
 *   row's own `encryption_key_version` column). Defaults to the current
 *   key version, preserving pre-M3 behavior for any caller that hasn't
 *   been updated to pass it explicitly.
 * @returns {string} plaintext
 */
function decryptCredential(envelope, keyVersion = getCurrentKeyVersion()) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw new Error('decryptCredential requires an envelope object');
  }

  const { version, algorithm, iv, authTag, ciphertext } = envelope;

  if (version !== ENVELOPE_VERSION) {
    throw new Error('Unsupported credential envelope version');
  }
  if (algorithm !== ALGORITHM) {
    throw new Error('Unsupported credential envelope algorithm');
  }
  if (!iv || !authTag || !ciphertext) {
    throw new Error('Credential envelope is missing required fields');
  }

  const key = resolveKeyForVersion(keyVersion);

  let ivBuffer, authTagBuffer, ciphertextBuffer;
  try {
    ivBuffer = Buffer.from(iv, 'base64');
    authTagBuffer = Buffer.from(authTag, 'base64');
    ciphertextBuffer = Buffer.from(ciphertext, 'base64');
  } catch {
    throw new Error('Credential envelope contains malformed base64 data');
  }

  if (ivBuffer.length !== IV_BYTES) {
    throw new Error('Credential envelope IV has an invalid length');
  }
  if (authTagBuffer.length !== AUTH_TAG_BYTES) {
    throw new Error('Credential envelope authentication tag has an invalid length');
  }

  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, key, ivBuffer, { authTagLength: AUTH_TAG_BYTES });
    decipher.setAuthTag(authTagBuffer);
    const plaintext = Buffer.concat([decipher.update(ciphertextBuffer), decipher.final()]);
    return plaintext.toString('utf8');
  } catch {
    // Deliberately generic: never echo cipher internals, the key, or any
    // fragment of ciphertext/plaintext back in an error message. A wrong
    // key, corrupted ciphertext, and a tampered auth tag are
    // indistinguishable to a caller by design.
    throw new Error('Credential decryption failed: ciphertext, key, or authentication tag is invalid');
  }
}

module.exports = {
  ALGORITHM,
  ENVELOPE_VERSION,
  KEY_ENV_VAR,
  LEGACY_KEY_ENV_VAR,
  KEY_VERSION_ENV_VAR,
  DEFAULT_KEY_VERSION,
  validateEncryptionKey,
  resolveKeyForVersion,
  getCurrentKeyVersion,
  encryptCredential,
  decryptCredential,
};
