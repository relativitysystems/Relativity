const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const { aikb: aikbConfig } = require('../config');

let _client = null;
function getAikbSupabase() {
  if (!_client) {
    if (!aikbConfig.supabaseUrl || !aikbConfig.supabaseServiceRoleKey) {
      throw new Error('AIKB_SUPABASE_URL and AIKB_SUPABASE_SERVICE_ROLE_KEY must be set');
    }
    _client = createClient(aikbConfig.supabaseUrl, aikbConfig.supabaseServiceRoleKey);
  }
  return _client;
}

function aikbHeaders() {
  return { 'x-api-key': aikbConfig.apiKey };
}

function extractAxiosError(err) {
  return err.response?.data?.error || err.response?.data?.message || err.message;
}

async function uploadToStorage(clientId, sourceFileId, fileBuffer, mimeType) {
  const storagePath = `uploads/${clientId}/${sourceFileId}`;
  const { error } = await getAikbSupabase().storage
    .from(aikbConfig.storageBucket)
    .upload(storagePath, fileBuffer, { contentType: mimeType, upsert: false });

  if (error) throw new Error(`AIKB storage upload failed: ${error.message}`);
  return storagePath;
}

async function uploadAndIngest({ clientId, sourceFileId, fileName, mimeType, fileBuffer }) {
  const storagePath = await uploadToStorage(clientId, sourceFileId, fileBuffer, mimeType);

  try {
    await axios.post(
      `${aikbConfig.apiBaseUrl}/api/knowledge/ingest`,
      { clientId, sourceProvider: 'portal_upload', sourceFileId, fileName, mimeType, storagePath },
      { headers: aikbHeaders() }
    );
  } catch (err) {
    throw new Error(`AIKB ingest failed: ${extractAxiosError(err)}`);
  }
}

async function listDocuments(clientId) {
  try {
    const res = await axios.get(`${aikbConfig.apiBaseUrl}/api/knowledge/documents/${clientId}`, {
      headers: aikbHeaders(),
    });
    return res.data;
  } catch (err) {
    throw new Error(`AIKB listDocuments failed: ${extractAxiosError(err)}`);
  }
}

async function queryKnowledge(clientId, query) {
  try {
    const res = await axios.post(
      `${aikbConfig.apiBaseUrl}/api/knowledge/query`,
      { clientId, question: query },
      { headers: aikbHeaders() }
    );
    return res.data;
  } catch (err) {
    throw new Error(`AIKB query failed: ${extractAxiosError(err)}`);
  }
}

async function deleteDocument(clientId, sourceFileId) {
  try {
    await axios.delete(`${aikbConfig.apiBaseUrl}/api/knowledge/document/by-source`, {
      headers: aikbHeaders(),
      data: { clientId, sourceFileId, sourceProvider: 'portal_upload' },
    });
  } catch (err) {
    throw new Error(`AIKB deleteDocument failed: ${extractAxiosError(err)}`);
  }
}

module.exports = { uploadAndIngest, listDocuments, queryKnowledge, deleteDocument };
