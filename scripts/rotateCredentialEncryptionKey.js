// Backlog M3 — operational script to complete a credential encryption key
// rotation. Not part of the automated test suite; run manually by an
// operator after configuring the new/old key env vars described in
// .env.example (INTEGRATION_CREDENTIAL_ENCRYPTION_KEY,
// INTEGRATION_CREDENTIAL_ENCRYPTION_KEY_VERSION,
// INTEGRATION_CREDENTIAL_ENCRYPTION_KEY_V{oldVersion}):
//
//   node scripts/rotateCredentialEncryptionKey.js
//
// Finds every oauth_credentials row still encrypted under a version other
// than the current one and re-encrypts it in place
// (oauthConnectionsService#reencryptCredentialForConnection). Safe to
// re-run: rows already on the current version are skipped as a no-op.
// Once this reports zero remaining rows, the old
// INTEGRATION_CREDENTIAL_ENCRYPTION_KEY_V{oldVersion} variable can be
// removed from the environment.

const oauthConnectionsService = require('../services/oauthConnectionsService');
const { getCurrentKeyVersion } = require('../services/integrationCredentialEncryption');

async function main() {
  const currentVersion = getCurrentKeyVersion();
  console.log(`[rotate] current key version: ${currentVersion}`);

  const pending = await oauthConnectionsService.listConnectionIdsNeedingKeyRotation();
  console.log(`[rotate] ${pending.length} row(s) not yet on version ${currentVersion}`);

  let rotated = 0;
  let failed = 0;
  for (const { connectionId, encryptionKeyVersion } of pending) {
    try {
      const result = await oauthConnectionsService.reencryptCredentialForConnection(connectionId);
      if (result.rotated) {
        rotated += 1;
        console.log(`[rotate] connection ${connectionId}: v${encryptionKeyVersion} -> v${currentVersion}`);
      }
    } catch (err) {
      failed += 1;
      // Never log the plaintext/ciphertext — only the connection id and
      // error message, matching every other credential-path error log in
      // this codebase (see services/oauthConnectionsService.js).
      console.error(`[rotate] connection ${connectionId} failed: ${err.message}`);
    }
  }

  console.log(`[rotate] done — ${rotated} rotated, ${failed} failed, ${pending.length - rotated - failed} skipped`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('[rotate] fatal error:', err.message);
  process.exitCode = 1;
});
