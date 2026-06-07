const { inngest } = require('./client');
const { getClientById, getActiveClients, getToken, upsertToken, logEvent } = require('../services/supabaseService');
const { listFolder, getRecentDayFolders, refreshAccessToken } = require('../services/dropboxService');
const { getAllState, saveStabilityProgress, saveNotificationSent, markDeleted } = require('../services/stateService');
const slackService = require('../services/slackService');
const { dropbox: dropboxConfig } = require('../config');

const REQUIRED_STABLE = 2;
const MAX_STABILITY_ITERATIONS = 10;

const dropboxScheduledCheck = inngest.createFunction(
  { id: 'dropbox-scheduled-check', name: 'Dropbox Scheduled Check', triggers: [{ cron: '0 * * * *' }] },
  async ({ step }) => {
    const clients = await step.run('load-active-clients', () => getActiveClients());

    if (!clients || clients.length === 0) return { checked: 0 };

    await step.sendEvent(
      'send-check-events',
      clients.map(c => ({ name: 'dropbox/check-client', data: { clientId: c.id } }))
    );

    return { checked: clients.length };
  }
);

const dropboxChanged = inngest.createFunction(
  { id: 'dropbox-changed', name: 'Dropbox Changed', triggers: [{ event: 'dropbox/changed' }] },
  async ({ event, step }) => {
    await step.sendEvent('trigger-check', {
      name: 'dropbox/check-client',
      data: { clientId: event.data.clientId },
    });
  }
);

const dropboxCheckClient = inngest.createFunction(
  { id: 'dropbox-check-client', name: 'Dropbox Check Client', triggers: [{ event: 'dropbox/check-client' }] },
  async ({ event, step }) => {
    const { clientId } = event.data;

    const client = await step.run('get-client', () => getClientById(clientId));

    const tokenRow = await step.run('get-token', async () => {
      const row = await getToken(clientId, 'dropbox');
      if (!row) throw new Error(`No Dropbox token for client ${clientId}`);
      return row;
    });

    let accessToken = await step.run('refresh-token-if-needed', async () => {
      const isExpired = tokenRow.expires_at &&
        new Date(tokenRow.expires_at) < new Date(Date.now() + 60_000);

      if (isExpired && tokenRow.refresh_token) {
        const refreshed = await refreshAccessToken(tokenRow.refresh_token);
        const newExpiresAt = refreshed.expires_in
          ? new Date(Date.now() + refreshed.expires_in * 1000)
          : null;
        await upsertToken(clientId, 'dropbox', refreshed.access_token, tokenRow.refresh_token, newExpiresAt);
        return refreshed.access_token;
      }
      return tokenRow.access_token;
    });

    const watchPath = client.dropbox_watch_path || dropboxConfig.basePath || '';

    const rootEntries = await step.run('list-watch-path', () =>
      listFolder(accessToken, watchPath)
    );

    const dayFolders = await step.run('get-day-folders', () =>
      getRecentDayFolders(rootEntries, 5)
    );

    if (!dayFolders.length) return { message: 'No day folders found' };

    const stateRows = await step.run('load-state', () => getAllState(clientId));

    // Build lookup map from state array
    const stateMap = {};
    for (const row of stateRows) {
      stateMap[`${row.day_folder}:${row.address_folder}`] = row;
    }

    for (const dayFolder of dayFolders) {
      const dayEntries = await step.run(`list-day-${dayFolder.name}`, () =>
        listFolder(accessToken, dayFolder.path_lower)
      );

      const addressFolders = dayEntries.filter(e => e['.tag'] === 'folder');
      const currentAddressNames = new Set(addressFolders.map(f => f.name));

      // Process each address folder
      for (const addressFolder of addressFolders) {
        const stateKey = `${dayFolder.name}:${addressFolder.name}`;
        let currentState = stateMap[stateKey] || {
          last_count: -1,
          stable_count: 0,
          last_notified_count: null,
          is_deleted: false,
        };

        if (currentState.is_deleted) continue;

        let fileCount;
        let stableCount = currentState.stable_count;
        let notified = false;

        for (let i = 0; i < MAX_STABILITY_ITERATIONS; i++) {
          const stepId = `count-${dayFolder.name}-${addressFolder.name}-iter-${i}`
            .replace(/[^a-z0-9-]/gi, '-');

          fileCount = await step.run(stepId, async () => {
            const entries = await listFolder(accessToken, addressFolder.path_lower);
            return entries.filter(e => e['.tag'] === 'file').length;
          });

          if (fileCount === currentState.last_count) {
            stableCount = currentState.stable_count + 1;
          } else {
            stableCount = 0;
          }

          // Update state in memory for next iteration
          currentState = { ...currentState, last_count: fileCount, stable_count: stableCount };

          const saveId = `save-progress-${dayFolder.name}-${addressFolder.name}-iter-${i}`
            .replace(/[^a-z0-9-]/gi, '-');

          await step.run(saveId, () =>
            saveStabilityProgress(clientId, dayFolder.name, addressFolder.name, {
              lastCount: fileCount,
              stableCount,
            })
          );

          if (stableCount >= REQUIRED_STABLE) {
            const prevNotifiedCount = stateMap[stateKey]?.last_notified_count ?? null;
            if (fileCount !== prevNotifiedCount) {
              const notifyId = `notify-${dayFolder.name}-${addressFolder.name}-iter-${i}`
                .replace(/[^a-z0-9-]/gi, '-');

              await step.run(notifyId, async () => {
                const msg = `Files ready: *${addressFolder.name}* (${dayFolder.name}) — ${fileCount} file${fileCount === 1 ? '' : 's'}`;
                await slackService.sendMessage(client, msg);
                await saveNotificationSent(clientId, dayFolder.name, addressFolder.name, fileCount);
                await logEvent(clientId, 'slack.sent', {
                  dayFolder: dayFolder.name,
                  addressFolder: addressFolder.name,
                  fileCount,
                });
              });

              // Update local map to prevent double-notify if loop continues
              if (stateMap[stateKey]) {
                stateMap[stateKey].last_notified_count = fileCount;
              } else {
                stateMap[stateKey] = { ...currentState, last_notified_count: fileCount };
              }
            }
            notified = true;
            break;
          }

          if (i < MAX_STABILITY_ITERATIONS - 1) {
            const sleepId = `wait-${dayFolder.name}-${addressFolder.name}-${i}`
              .replace(/[^a-z0-9-]/gi, '-');
            await step.sleep(sleepId, '30s');
          }
        }
      }

      // Detect deleted address folders
      for (const [key, row] of Object.entries(stateMap)) {
        const [keyDay, keyAddr] = key.split(':');
        if (keyDay !== dayFolder.name) continue;
        if (row.is_deleted) continue;
        if (currentAddressNames.has(keyAddr)) continue;

        const deleteId = `delete-${dayFolder.name}-${keyAddr}`
          .replace(/[^a-z0-9-]/gi, '-');

        await step.run(deleteId, async () => {
          await markDeleted(clientId, dayFolder.name, keyAddr);
          await slackService.sendMessage(client, `Folder removed: *${keyAddr}* (${dayFolder.name})`);
          await logEvent(clientId, 'folder.deleted', {
            dayFolder: dayFolder.name,
            addressFolder: keyAddr,
          });
        });

        // Mark locally so we don't re-process in the same run
        stateMap[key] = { ...row, is_deleted: true };
      }
    }

    return { clientId, dayFolders: dayFolders.map(f => f.name) };
  }
);

const functions = [dropboxScheduledCheck, dropboxChanged, dropboxCheckClient];

module.exports = { functions };
