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

function aikbHeaders(authHeader) {
  const headers = { 'x-api-key': aikbConfig.apiKey };
  if (authHeader) headers.Authorization = authHeader;
  return headers;
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

async function queryKnowledge(clientId, query, sessionId, authHeader) {
  try {
    const body = { clientId, question: query };
    if (sessionId) body.sessionId = sessionId;
    const res = await axios.post(
      `${aikbConfig.apiBaseUrl}/api/knowledge/query`,
      body,
      { headers: aikbHeaders(authHeader) }
    );
    return res.data;
  } catch (err) {
    throw new Error(`AIKB query failed: ${extractAxiosError(err)}`);
  }
}

async function saveKnowledgeGap({ clientId, sessionId, messageId, question, reason }) {
  try {
    const res = await axios.post(
      `${aikbConfig.apiBaseUrl}/api/knowledge/gaps`,
      { clientId, sessionId, messageId: messageId || null, question, reason },
      { headers: aikbHeaders() }
    );
    return res.data;
  } catch (err) {
    throw new Error(`AIKB saveKnowledgeGap failed: ${extractAxiosError(err)}`);
  }
}

async function listChatSessions(clientId, authHeader) {
  try {
    const res = await axios.get(
      `${aikbConfig.apiBaseUrl}/api/knowledge/chat/sessions/${clientId}`,
      { headers: aikbHeaders(authHeader) }
    );
    return res.data;
  } catch (err) {
    throw new Error(`AIKB listChatSessions failed: ${extractAxiosError(err)}`);
  }
}

async function listChatMessages(clientId, sessionId, authHeader) {
  try {
    const res = await axios.get(
      `${aikbConfig.apiBaseUrl}/api/knowledge/chat/sessions/${clientId}/${sessionId}/messages`,
      { headers: aikbHeaders(authHeader) }
    );
    return res.data;
  } catch (err) {
    throw new Error(`AIKB listChatMessages failed: ${extractAxiosError(err)}`);
  }
}

async function deleteChatSession(clientId, sessionId, authHeader) {
  try {
    await axios.delete(
      `${aikbConfig.apiBaseUrl}/api/knowledge/chat/sessions/${clientId}/${sessionId}`,
      { headers: aikbHeaders(authHeader) }
    );
  } catch (err) {
    throw new Error(`AIKB deleteChatSession failed: ${extractAxiosError(err)}`);
  }
}

async function clearChatHistory(clientId, authHeader) {
  try {
    await axios.delete(
      `${aikbConfig.apiBaseUrl}/api/knowledge/chat/history/${clientId}`,
      { headers: aikbHeaders(authHeader) }
    );
  } catch (err) {
    throw new Error(`AIKB clearChatHistory failed: ${extractAxiosError(err)}`);
  }
}

async function updateChatSessionTitle(clientId, sessionId, title, authHeader) {
  try {
    const res = await axios.patch(
      `${aikbConfig.apiBaseUrl}/api/knowledge/chat/sessions/${clientId}/${sessionId}/title`,
      { title },
      { headers: aikbHeaders(authHeader) }
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

// ---------------------------------------------------------------------------
// Knowledge collections (Milestone 5)
// ---------------------------------------------------------------------------

async function listCollections(clientId) {
  try {
    const res = await axios.get(`${aikbConfig.apiBaseUrl}/api/knowledge/collections/${clientId}`, {
      headers: aikbHeaders(),
    });
    return res.data;
  } catch (err) {
    throw new Error(`AIKB listCollections failed: ${extractAxiosError(err)}`);
  }
}

async function createCollection(clientId, name) {
  try {
    const res = await axios.post(
      `${aikbConfig.apiBaseUrl}/api/knowledge/collections`,
      { clientId, name },
      { headers: aikbHeaders() }
    );
    return res.data;
  } catch (err) {
    const error = new Error(`AIKB createCollection failed: ${extractAxiosError(err)}`);
    error.status = err.response?.status;
    error.responseBody = err.response?.data;
    throw error;
  }
}

async function renameCollection(clientId, collectionId, name) {
  try {
    const res = await axios.patch(
      `${aikbConfig.apiBaseUrl}/api/knowledge/collections/${collectionId}`,
      { clientId, name },
      { headers: aikbHeaders() }
    );
    return res.data;
  } catch (err) {
    const error = new Error(`AIKB renameCollection failed: ${extractAxiosError(err)}`);
    error.status = err.response?.status;
    error.responseBody = err.response?.data;
    throw error;
  }
}

async function deleteCollection(clientId, collectionId) {
  try {
    const res = await axios.delete(`${aikbConfig.apiBaseUrl}/api/knowledge/collections/${collectionId}`, {
      headers: aikbHeaders(),
      data: { clientId },
    });
    return res.data;
  } catch (err) {
    const error = new Error(`AIKB deleteCollection failed: ${extractAxiosError(err)}`);
    error.status = err.response?.status;
    error.responseBody = err.response?.data;
    throw error;
  }
}

async function moveDocumentCollection(clientId, sourceFileId, collectionId) {
  try {
    const res = await axios.patch(
      `${aikbConfig.apiBaseUrl}/api/knowledge/document/by-source/collection`,
      { clientId, sourceFileId, sourceProvider: 'portal_upload', collectionId },
      { headers: aikbHeaders() }
    );
    return res.data;
  } catch (err) {
    const error = new Error(`AIKB moveDocumentCollection failed: ${extractAxiosError(err)}`);
    error.status = err.response?.status;
    error.responseBody = err.response?.data;
    throw error;
  }
}

async function listIngestionJobs(clientId) {
  try {
    const [jobsRes, documentsData] = await Promise.all([
      axios.get(`${aikbConfig.apiBaseUrl}/api/knowledge/jobs/${clientId}`, { headers: aikbHeaders() }),
      listDocuments(clientId).catch(() => null),
    ]);

    const jobs = jobsRes.data.jobs || (Array.isArray(jobsRes.data) ? jobsRes.data : []);
    const docs = documentsData
      ? (documentsData.documents || (Array.isArray(documentsData) ? documentsData : []))
      : [];

    // Jobs from AIKB sometimes only carry sourceFileId — join against knowledge_documents
    // (by sourceFileId) so the UI can show the real file name instead of a raw UUID.
    const docsBySourceId = new Map();
    for (const doc of docs) {
      const id = doc.sourceFileId || doc.source_file_id;
      if (id) docsBySourceId.set(id, doc);
    }

    const enrichedJobs = jobs.map((job) => {
      const sourceFileId = job.sourceFileId || job.source_file_id || null;
      const matchedDoc = sourceFileId ? docsBySourceId.get(sourceFileId) : null;
      const fileName = job.fileName || job.file_name
        || (matchedDoc && (matchedDoc.fileName || matchedDoc.file_name || matchedDoc.name))
        || null;
      const documentId = job.documentId || job.document_id
        || (matchedDoc && (matchedDoc.id || matchedDoc.documentId || matchedDoc.document_id))
        || null;

      return { ...job, fileName, documentId };
    });

    return { jobs: enrichedJobs };
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

// Superset of getClientSummary + getClientAnalytics + listIngestionJobs in one
// round trip (backlog L5) — use this instead of calling all three when a
// caller needs data from more than one of them for the same client (e.g. the
// admin dashboard's per-client health check).
async function getClientKnowledgeStats(clientId) {
  try {
    const res = await axios.get(
      `${aikbConfig.apiBaseUrl}/api/knowledge/stats/${clientId}`,
      { headers: aikbHeaders() }
    );
    return res.data;
  } catch (err) {
    if (err.response?.status === 404) return {};
    throw new Error(`AIKB getClientKnowledgeStats failed: ${extractAxiosError(err)}`);
  }
}

async function deleteClientData(clientId) {
  try {
    const res = await axios.delete(
      `${aikbConfig.apiBaseUrl}/api/knowledge/client/${clientId}`,
      { headers: aikbHeaders() }
    );
    return res.data;
  } catch (err) {
    throw new Error(`AIKB deleteClientData failed: ${extractAxiosError(err)}`);
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
  saveKnowledgeGap,
  deleteDocument,
  listChatSessions,
  listChatMessages,
  deleteChatSession,
  clearChatHistory,
  updateChatSessionTitle,
  listIngestionJobs,
  getClientSummary,
  getClientAnalytics,
  getClientKnowledgeStats,
  getClientDocumentStats,
  deleteClientData,
  listCollections,
  createCollection,
  renameCollection,
  deleteCollection,
  moveDocumentCollection,
};
