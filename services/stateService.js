const { createClient } = require('@supabase/supabase-js');
const { supabase: supabaseConfig } = require('../config');

const supabase = createClient(supabaseConfig.url, supabaseConfig.serviceKey);

async function getAllState(clientId) {
  const { data, error } = await supabase
    .from('folder_states')
    .select('*')
    .eq('client_id', clientId);

  if (error) throw new Error(`stateService.getAllState failed: ${error.message}`);
  return data || [];
}

async function getState(clientId, dayFolder, addressFolder) {
  const { data, error } = await supabase
    .from('folder_states')
    .select('*')
    .eq('client_id', clientId)
    .eq('day_folder', dayFolder)
    .eq('address_folder', addressFolder)
    .single();

  if (error && error.code === 'PGRST116') return null;
  if (error) throw new Error(`stateService.getState failed: ${error.message}`);
  return data;
}

async function saveStabilityProgress(clientId, dayFolder, addressFolder, { lastCount, stableCount }) {
  const { error } = await supabase
    .from('folder_states')
    .upsert(
      {
        client_id: clientId,
        day_folder: dayFolder,
        address_folder: addressFolder,
        last_count: lastCount,
        stable_count: stableCount,
        last_seen_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'client_id,day_folder,address_folder' }
    );

  if (error) throw new Error(`stateService.saveStabilityProgress failed: ${error.message}`);
}

async function saveNotificationSent(clientId, dayFolder, addressFolder, fileCount) {
  const { error } = await supabase
    .from('folder_states')
    .upsert(
      {
        client_id: clientId,
        day_folder: dayFolder,
        address_folder: addressFolder,
        last_notified_count: fileCount,
        last_notified_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'client_id,day_folder,address_folder' }
    );

  if (error) throw new Error(`stateService.saveNotificationSent failed: ${error.message}`);
}

async function markDeleted(clientId, dayFolder, addressFolder) {
  const { error } = await supabase
    .from('folder_states')
    .upsert(
      {
        client_id: clientId,
        day_folder: dayFolder,
        address_folder: addressFolder,
        is_deleted: true,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'client_id,day_folder,address_folder' }
    );

  if (error) throw new Error(`stateService.markDeleted failed: ${error.message}`);
}

module.exports = {
  getAllState,
  getState,
  saveStabilityProgress,
  saveNotificationSent,
  markDeleted,
};
