const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const crypto = require('crypto');
const config = require('../config');
const { aikb: aikbConfig } = config;
const { signServiceRequest } = require('./serviceRequestAuth');

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

// Test-only seam: lets tests substitute a fake Storage client instead of
// constructing a real @supabase/supabase-js client from env config. Never
// called by application code — see test/aikbService.test.js.
function _setAikbSupabaseClientForTests(client) { _client = client; }
function _resetAikbSupabaseClientForTests() { _client = null; }

// EM10.5 Scenario 3 follow-up (Architecture/architecture/EM10_5_STAGING_CHECKLIST.md
// bug log): uploads/{clientId}/{sourceFileId} is deterministic, and every
// original caller of uploadAndIngest (portal upload, ZIP import, Google
// Drive import — see routes/api.js) mints sourceFileId fresh via
// crypto.randomUUID() per call, so that path can never legitimately already
// exist there. upsert: false was a correct, defensive "this must be new;
// fail loudly if it isn't" guard under that invariant.
//
// Gmail ingestion (EM6) passes sourceFileId = the Gmail message id, which is
// STABLE — the same value is legitimately re-submitted on every re-scan
// (historical Full Scan revisits every currently-matching message
// unconditionally, before AIKB's own content-hash dedup ever runs; see
// emailSyncService.js's runHistoricalPage / processCandidateMessage). Under
// upsert: false, any repeat scan of already-ingested mail — or any
// delete-then-reimport cycle — fails at this storage write with "The
// resource already exists" before AIKB gets a chance to decide whether the
// content is unchanged, already indexed, or needs rebuilding.
//
// This is an explicit, testable allowlist keyed only on sourceProvider —
// deliberately not inferred from the file name or storage path. 'microsoft'
// is intentionally NOT included: no Relativity code path ingests
// Microsoft/Outlook email today (it exists only as an allowed sourceProvider
// enum value in oauthConnectionsService.js's SUPPORTED_PROVIDERS and AIKB's
// /ingest validation) — add it here only once a real stable-message-id
// ingestion path for it exists.
const STABLE_SOURCE_ID_PROVIDERS = new Set(['gmail']);

function allowsStorageOverwrite(sourceProvider) {
  return STABLE_SOURCE_ID_PROVIDERS.has(sourceProvider);
}

function aikbHeaders(authHeader) {
  const headers = { 'x-api-key': aikbConfig.apiKey };
  if (authHeader) headers.Authorization = authHeader;
  return headers;
}

function extractAxiosError(err) {
  return err.response?.data?.error || err.response?.data?.message || err.message;
}

// Backlog H4 — signs the additive HMAC service-request envelope (the same
// one aikbAskClient.js already uses for POST /ask) for AIKB's other
// clientId-scoped x-api-key-only routes: ingest, document delete, client
// delete, the documents/collections listing and mutation routes, and (H4's
// previously-residual scope) the jobs/summary/analytics/stats reporting
// routes. The envelope cryptographically binds clientId to the request, so
// a leaked shared x-api-key alone can no longer be used to act on an
// arbitrary client through these routes. idempotencyKey has no dedup
// meaning for these routes (unlike /ask's Slack-question flow) — it's
// generated fresh per call purely to satisfy the envelope schema, which
// requires one. Sent alongside the unchanged AIKB_API_KEY (defense in
// depth, not a replacement — see aikbHeaders()).
function signedEnvelope(clientId, payload) {
  const signingSecret = config.serviceRequest.signingSecret;
  if (!signingSecret) {
    throw new Error('SERVICE_REQUEST_SIGNING_SECRET is not configured on this server.');
  }
  return signServiceRequest({
    clientId,
    idempotencyKey: crypto.randomUUID(),
    payload,
    secret: signingSecret,
  });
}

async function uploadToStorage(clientId, sourceFileId, fileBuffer, mimeType, sourceProvider = 'portal_upload') {
  const storagePath = `uploads/${clientId}/${sourceFileId}`;
  // Direct atomic upsert for stable-identity providers (Gmail) rather than a
  // delete-then-upload — a delete-first strategy would leave a window where
  // the path is empty and a concurrent read/reindex sees no object at all.
  const { error } = await getAikbSupabase().storage
    .from(aikbConfig.storageBucket)
    .upload(storagePath, fileBuffer, { contentType: mimeType, upsert: allowsStorageOverwrite(sourceProvider) });

  if (error) throw new Error(`AIKB storage upload failed: ${error.message}`);
  return storagePath;
}

// EM6 (EMAIL_INGESTION.md §14.2): sourceProvider/collectionId/emailMetadata
// are all optional and additive — every existing portal_upload caller
// (routes/api.js's upload/ZIP-import/Google-Drive-import flows) passes none
// of them and is unaffected. collectionId lets a caller (an email
// ingestion rule's destination_collection_id, §22) route straight to a
// non-default collection at first insert; emailMetadata is required by
// AIKB's /ingest route whenever sourceProvider is gmail/microsoft.
async function uploadAndIngest({ clientId, sourceFileId, fileName, mimeType, fileBuffer, sourceProvider = 'portal_upload', collectionId, emailMetadata }) {
  const storagePath = await uploadToStorage(clientId, sourceFileId, fileBuffer, mimeType, sourceProvider);
  const payload = { sourceProvider, sourceFileId, fileName, mimeType, storagePath };
  if (collectionId) payload.collectionId = collectionId;
  if (emailMetadata) payload.emailMetadata = emailMetadata;
  const envelope = signedEnvelope(clientId, payload);

  try {
    await axios.post(
      `${aikbConfig.apiBaseUrl}/api/knowledge/ingest`,
      { ...envelope, payload },
      { headers: aikbHeaders() }
    );
  } catch (err) {
    throw new Error(`AIKB ingest failed: ${extractAxiosError(err)}`);
  }
}

// EM9 (EMAIL_INGESTION.md §24.1, §24.5) — filters is optional and additive;
// every existing caller (countActiveDocuments, tombstoneMessages,
// getClientDocumentStats, etc.) passes none and is unaffected. Used by
// emailConnectionService.js's disconnect-with-cleanup path to enumerate
// only the documents a specific offboarded/disconnecting member contributed
// (contributingMemberId), rather than every document for the client.
async function listDocuments(clientId, filters = {}) {
  const envelope = signedEnvelope(clientId, filters);
  try {
    const res = await axios.get(`${aikbConfig.apiBaseUrl}/api/knowledge/documents/${clientId}`, {
      headers: aikbHeaders(),
      data: { ...envelope, payload: filters },
    });
    return res.data;
  } catch (err) {
    throw new Error(`AIKB listDocuments failed: ${extractAxiosError(err)}`);
  }
}

async function queryKnowledge(clientId, query, sessionId, authHeader, allowedCollectionIds = null, emailLookupOptions = {}) {
  try {
    const body = { clientId, question: query };
    if (sessionId) body.sessionId = sessionId;
    // Backlog M10: forwarded as-is to aikb's /api/knowledge/query, which
    // already supports allowedCollectionIds (null = unrestricted, an array
    // restricts retrieval) — aikb needed no changes for this.
    if (Array.isArray(allowedCollectionIds)) body.allowedCollectionIds = allowedCollectionIds;
    // EL6 (LIVE_EMAIL_LOOKUP.md §1.1 step 4) — emailLookupAvailable is
    // Relativity's own real signal (services/emailLiveLookupService.js#isLiveLookupAvailable),
    // computed by the route before this call; forceLiveLookup is the "Live
    // email" mode override (§2.1). Both default false/absent when the
    // caller omits emailLookupOptions, unchanged from before EL6.
    if (emailLookupOptions.emailLookupAvailable) body.emailLookupAvailable = true;
    if (emailLookupOptions.forceLiveLookup) body.forceLiveLookup = true;
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
  const payload = { sourceFileId, sourceProvider: 'portal_upload' };
  const envelope = signedEnvelope(clientId, payload);
  try {
    await axios.delete(`${aikbConfig.apiBaseUrl}/api/knowledge/document/by-source`, {
      headers: aikbHeaders(),
      data: { ...envelope, payload },
    });
  } catch (err) {
    throw new Error(`AIKB deleteDocument failed: ${extractAxiosError(err)}`);
  }
}

// EM6 (EMAIL_INGESTION.md §14.2, §24.2) — tombstones an email-sourced
// document by its real AIKB document UUID, not by source (email's
// documentId is never returned synchronously from uploadAndIngest, since
// /ingest only enqueues an async Inngest event — see
// services/emailSyncService.js's findEmailDocumentIdsBySource, which
// resolves the real id via listDocuments before calling this). Deliberately
// does NOT send sourceProvider in the payload — AIKB's DELETE /document/:id
// route only uses that field for its own by-source validation branch, which
// this id-based call never takes (§14.2: "no AIKB change needed here at
// all").
async function deleteDocumentById(clientId, documentId) {
  const payload = {};
  const envelope = signedEnvelope(clientId, payload);
  try {
    await axios.delete(`${aikbConfig.apiBaseUrl}/api/knowledge/document/${documentId}`, {
      headers: aikbHeaders(),
      data: { ...envelope, payload },
    });
  } catch (err) {
    throw new Error(`AIKB deleteDocumentById failed: ${extractAxiosError(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Knowledge collections (Milestone 5)
// ---------------------------------------------------------------------------

async function listCollections(clientId) {
  const envelope = signedEnvelope(clientId, {});
  try {
    const res = await axios.get(`${aikbConfig.apiBaseUrl}/api/knowledge/collections/${clientId}`, {
      headers: aikbHeaders(),
      data: { ...envelope, payload: {} },
    });
    return res.data;
  } catch (err) {
    throw new Error(`AIKB listCollections failed: ${extractAxiosError(err)}`);
  }
}

async function createCollection(clientId, name) {
  const payload = { name };
  const envelope = signedEnvelope(clientId, payload);
  try {
    const res = await axios.post(
      `${aikbConfig.apiBaseUrl}/api/knowledge/collections`,
      { ...envelope, payload },
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
  const payload = { name };
  const envelope = signedEnvelope(clientId, payload);
  try {
    const res = await axios.patch(
      `${aikbConfig.apiBaseUrl}/api/knowledge/collections/${collectionId}`,
      { ...envelope, payload },
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
  const envelope = signedEnvelope(clientId, {});
  try {
    const res = await axios.delete(`${aikbConfig.apiBaseUrl}/api/knowledge/collections/${collectionId}`, {
      headers: aikbHeaders(),
      data: { ...envelope, payload: {} },
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
  const payload = { sourceFileId, sourceProvider: 'portal_upload', collectionId };
  const envelope = signedEnvelope(clientId, payload);
  try {
    const res = await axios.patch(
      `${aikbConfig.apiBaseUrl}/api/knowledge/document/by-source/collection`,
      { ...envelope, payload },
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
    const envelope = signedEnvelope(clientId, {});
    const [jobsRes, documentsData] = await Promise.all([
      axios.get(`${aikbConfig.apiBaseUrl}/api/knowledge/jobs/${clientId}`, {
        headers: aikbHeaders(),
        data: { ...envelope, payload: {} },
      }),
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
    const envelope = signedEnvelope(clientId, {});
    const res = await axios.get(
      `${aikbConfig.apiBaseUrl}/api/knowledge/summary/${clientId}`,
      { headers: aikbHeaders(), data: { ...envelope, payload: {} } }
    );
    return res.data;
  } catch (err) {
    if (err.response?.status === 404) return {};
    throw new Error(`AIKB getClientSummary failed: ${extractAxiosError(err)}`);
  }
}

async function getClientAnalytics(clientId) {
  try {
    const envelope = signedEnvelope(clientId, {});
    const res = await axios.get(
      `${aikbConfig.apiBaseUrl}/api/knowledge/analytics/${clientId}`,
      { headers: aikbHeaders(), data: { ...envelope, payload: {} } }
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
    const envelope = signedEnvelope(clientId, {});
    const res = await axios.get(
      `${aikbConfig.apiBaseUrl}/api/knowledge/stats/${clientId}`,
      { headers: aikbHeaders(), data: { ...envelope, payload: {} } }
    );
    return res.data;
  } catch (err) {
    if (err.response?.status === 404) return {};
    throw new Error(`AIKB getClientKnowledgeStats failed: ${extractAxiosError(err)}`);
  }
}

async function deleteClientData(clientId) {
  const envelope = signedEnvelope(clientId, {});
  try {
    const res = await axios.delete(
      `${aikbConfig.apiBaseUrl}/api/knowledge/client/${clientId}`,
      { headers: aikbHeaders(), data: { ...envelope, payload: {} } }
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

// ---------------------------------------------------------------------------
// Knowledge gap admin review (Backlog M5) — same signed-envelope pattern as
// the collections functions above.
// ---------------------------------------------------------------------------

async function listKnowledgeGaps(clientId, { status } = {}) {
  const payload = status ? { status } : {};
  const envelope = signedEnvelope(clientId, payload);
  try {
    const res = await axios.get(`${aikbConfig.apiBaseUrl}/api/knowledge/gaps/${clientId}`, {
      headers: aikbHeaders(),
      data: { ...envelope, payload },
    });
    return res.data;
  } catch (err) {
    throw new Error(`AIKB listKnowledgeGaps failed: ${extractAxiosError(err)}`);
  }
}

async function updateKnowledgeGapStatus(clientId, gapId, status) {
  const payload = { status };
  const envelope = signedEnvelope(clientId, payload);
  try {
    const res = await axios.patch(
      `${aikbConfig.apiBaseUrl}/api/knowledge/gaps/${gapId}`,
      { ...envelope, payload },
      { headers: aikbHeaders() }
    );
    return res.data;
  } catch (err) {
    const error = new Error(`AIKB updateKnowledgeGapStatus failed: ${extractAxiosError(err)}`);
    error.status = err.response?.status;
    error.responseBody = err.response?.data;
    throw error;
  }
}

module.exports = {
  uploadToStorage,
  allowsStorageOverwrite,
  uploadAndIngest,
  listDocuments,
  queryKnowledge,
  saveKnowledgeGap,
  deleteDocument,
  deleteDocumentById,
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
  listKnowledgeGaps,
  updateKnowledgeGapStatus,
  _setAikbSupabaseClientForTests,
  _resetAikbSupabaseClientForTests,
};
