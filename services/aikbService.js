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

async function queryKnowledge(clientId, query, sessionId) {
  try {
    const body = { clientId, question: query };
    if (sessionId) body.sessionId = sessionId;
    const res = await axios.post(
      `${aikbConfig.apiBaseUrl}/api/knowledge/query`,
      body,
      { headers: aikbHeaders() }
    );
    return res.data;
  } catch (err) {
    throw new Error(`AIKB query failed: ${extractAxiosError(err)}`);
  }
}

async function listChatSessions(clientId) {
  try {
    const res = await axios.get(
      `${aikbConfig.apiBaseUrl}/api/knowledge/chat/sessions/${clientId}`,
      { headers: aikbHeaders() }
    );
    return res.data;
  } catch (err) {
    throw new Error(`AIKB listChatSessions failed: ${extractAxiosError(err)}`);
  }
}

async function listChatMessages(clientId, sessionId) {
  try {
    const res = await axios.get(
      `${aikbConfig.apiBaseUrl}/api/knowledge/chat/sessions/${clientId}/${sessionId}/messages`,
      { headers: aikbHeaders() }
    );
    return res.data;
  } catch (err) {
    throw new Error(`AIKB listChatMessages failed: ${extractAxiosError(err)}`);
  }
}

async function deleteChatSession(clientId, sessionId) {
  try {
    await axios.delete(
      `${aikbConfig.apiBaseUrl}/api/knowledge/chat/sessions/${clientId}/${sessionId}`,
      { headers: aikbHeaders() }
    );
  } catch (err) {
    throw new Error(`AIKB deleteChatSession failed: ${extractAxiosError(err)}`);
  }
}

async function clearChatHistory(clientId) {
  try {
    await axios.delete(
      `${aikbConfig.apiBaseUrl}/api/knowledge/chat/history/${clientId}`,
      { headers: aikbHeaders() }
    );
  } catch (err) {
    throw new Error(`AIKB clearChatHistory failed: ${extractAxiosError(err)}`);
  }
}

async function updateChatSessionTitle(clientId, sessionId, title) {
  try {
    const res = await axios.patch(
      `${aikbConfig.apiBaseUrl}/api/knowledge/chat/sessions/${clientId}/${sessionId}/title`,
      { title },
      { headers: aikbHeaders() }
    );
    return res.data;
  } catch (err) {
    throw new Error(`AIKB updateChatSessionTitle failed: ${extractAxiosError(err)}`);
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

async function listIngestionJobs(clientId) {
  try {
    const res = await axios.get(
      `${aikbConfig.apiBaseUrl}/api/knowledge/jobs/${clientId}`,
      { headers: aikbHeaders() }
    );
    return res.data;
  } catch (err) {
    if (err.response?.status === 404) return { jobs: [] };
    throw new Error(`AIKB listIngestionJobs failed: ${extractAxiosError(err)}`);
  }
}

async function getClientSummary(clientId) {
  try {
    const res = await axios.get(
      `${aikbConfig.apiBaseUrl}/api/knowledge/summary/${clientId}`,
      { headers: aikbHeaders() }
    );
    return res.data;
  } catch (err) {
    if (err.response?.status === 404) return {};
    throw new Error(`AIKB getClientSummary failed: ${extractAxiosError(err)}`);
  }
}

async function getClientAnalytics(clientId) {
  try {
    const res = await axios.get(
      `${aikbConfig.apiBaseUrl}/api/knowledge/analytics/${clientId}`,
      { headers: aikbHeaders() }
    );
    return res.data;
  } catch (err) {
    if (err.response?.status === 404) return {};
    throw new Error(`AIKB getClientAnalytics failed: ${extractAxiosError(err)}`);
  }
}

async function getClientDocumentStats(clientId) {
  try {
    const data = await listDocuments(clientId);
    const allDocs = data.documents || (Array.isArray(data) ? data : []);
    const docs = allDocs.filter(d => d.status !== 'deleted');
    return {
      documentCount: docs.length,
      indexedCount: docs.filter(d => d.status === 'indexed').length,
      failedCount: docs.filter(d => d.status === 'failed').length,
    };
  } catch {
    return { documentCount: null, indexedCount: null, failedCount: null };
  }
}

module.exports = {
  uploadAndIngest,
  listDocuments,
  queryKnowledge,
  deleteDocument,
  listChatSessions,
  listChatMessages,
  deleteChatSession,
  clearChatHistory,
  updateChatSessionTitle,
  listIngestionJobs,
  getClientSummary,
  getClientAnalytics,
  getClientDocumentStats,
};
