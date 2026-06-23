const express = require('express');
const router = express.Router();
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const apiKey = require('../middleware/apiKey');
const clientAuth = require('../middleware/clientAuth');
const googleDriveService = require('../services/googleDriveService');
const aikbService = require('../services/aikbService');
const supabaseService = require('../services/supabaseService');
const config = require('../config');

const ALLOWED_EXTENSIONS = new Set(['.txt', '.md', '.pdf', '.docx']);
const MAX_FILE_MB = config.limits.maxFileSizeMb;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    cb(null, ALLOWED_EXTENSIONS.has(path.extname(file.originalname).toLowerCase()));
  },
});

/**
 * GET /api/google-drive/files/:clientId
 *
 * Returns file metadata for the client's connected Google Drive.
 * Automatically refreshes the access token if expired.
 */
router.get('/google-drive/files/:clientId', apiKey, async (req, res) => {
  const { clientId } = req.params;
  try {
    const accessToken = await googleDriveService.getValidAccessToken(clientId);
    const files = await googleDriveService.listFiles(accessToken);
    res.json({ clientId, files });
  } catch (err) {
    console.error('Google Drive files error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/google-drive/file/:clientId/:fileId
 *
 * Streams the raw file content from Google Drive.
 * Used for AI knowledge base ingestion.
 */
router.get('/google-drive/file/:clientId/:fileId', apiKey, async (req, res) => {
  const { clientId, fileId } = req.params;
  try {
    const accessToken = await googleDriveService.getValidAccessToken(clientId);
    const driveResponse = await googleDriveService.downloadFile(accessToken, fileId);

    const contentType = driveResponse.headers['content-type'];
    if (contentType) res.setHeader('Content-Type', contentType);

    driveResponse.data.pipe(res);
  } catch (err) {
    console.error('Google Drive file download error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---- Knowledge Base (portal_upload) ----

router.post('/knowledge/upload', clientAuth, (req, res, next) => {
  if (req.member && req.member.role === 'viewer') {
    return res.status(403).json({ error: 'Viewers cannot upload documents' });
  }
  next();
}, (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE'
        ? `File too large. Maximum size is ${MAX_FILE_MB} MB.`
        : (err.message || 'File upload error.');
      return res.status(400).json({ error: msg });
    }
    next();
  });
}, async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file provided or unsupported file type (.txt, .md, .pdf, .docx only).' });
  }

  const clientId = req.client.id;
  const sourceFileId = crypto.randomUUID();

  // Enforce document count limit before accepting the upload
  try {
    const existing = await aikbService.listDocuments(clientId);
    const count = (existing.documents || (Array.isArray(existing) ? existing : [])).filter(d => d.status !== 'deleted').length;
    if (count >= config.limits.maxDocuments) {
      return res.status(429).json({
        error: `Document limit reached (${config.limits.maxDocuments} max). Delete some documents to upload new ones.`,
      });
    }
  } catch { /* non-blocking — proceed if count check fails */ }

  try {
    await aikbService.uploadAndIngest({
      clientId,
      sourceFileId,
      fileName: req.file.originalname,
      mimeType: req.file.mimetype,
      fileBuffer: req.file.buffer,
    });
    res.status(201).json({ success: true, sourceFileId });
  } catch (err) {
    console.error('POST /api/knowledge/upload error:', err.message);
    res.status(500).json({ error: 'Upload failed. Please try again.' });
  }
});

router.get('/knowledge/documents', clientAuth, async (req, res) => {
  try {
    const data = await aikbService.listDocuments(req.client.id);
    res.json(data);
  } catch (err) {
    console.error('GET /api/knowledge/documents error:', err.message);
    res.status(500).json({ error: 'Could not load your documents. Please try again.' });
  }
});

router.get('/knowledge/jobs', clientAuth, async (req, res) => {
  try {
    const data = await aikbService.listIngestionJobs(req.client.id);
    res.json(data);
  } catch (err) {
    console.error('GET /api/knowledge/jobs error:', err.message);
    res.json({ jobs: [] }); // graceful fallback — endpoint may not exist on AIKB yet
  }
});

router.get('/knowledge/summary', clientAuth, async (req, res) => {
  try {
    const data = await aikbService.getClientSummary(req.client.id);
    res.json(data);
  } catch (err) {
    console.error('GET /api/knowledge/summary error:', err.message);
    res.status(500).json({ error: 'Could not load your AI knowledge base data. Please try again.' });
  }
});

router.get('/knowledge/analytics', clientAuth, async (req, res) => {
  try {
    const data = await aikbService.getClientAnalytics(req.client.id);
    res.json(data);
  } catch (err) {
    console.error('GET /api/knowledge/analytics error:', err.message);
    res.status(500).json({ error: 'Could not load analytics. Please try again.' });
  }
});

router.get('/knowledge/usage', clientAuth, async (req, res) => {
  try {
    const data = await aikbService.listDocuments(req.client.id);
    const docs = (data.documents || (Array.isArray(data) ? data : [])).filter(d => d.status !== 'deleted');
    res.json({
      documentCount: docs.length,
      maxDocuments: config.limits.maxDocuments,
      maxFileSizeMb: config.limits.maxFileSizeMb,
    });
  } catch (err) {
    console.error('GET /api/knowledge/usage error:', err.message);
    res.status(500).json({ error: 'Could not load usage data.' });
  }
});

router.post('/knowledge/query', clientAuth, async (req, res) => {
  const { query, sessionId } = req.body;
  if (!query || typeof query !== 'string' || !query.trim()) {
    return res.status(400).json({ error: 'query is required' });
  }
  try {
    const data = await aikbService.queryKnowledge(req.client.id, query.trim(), sessionId || null);
    // Record which member owns this session in the local mapping table
    const returnedSessionId = data.sessionId || data.session_id;
    if (returnedSessionId && req.member?.id) {
      supabaseService.createMemberSession(req.client.id, req.member.id, returnedSessionId)
        .catch(err => console.error('createMemberSession failed:', err.message));
    }
    res.json(data);
  } catch (err) {
    console.error('POST /api/knowledge/query error:', err.message);
    res.status(500).json({ error: 'Could not get an answer. Please try again.' });
  }
});

router.post('/knowledge/gaps', clientAuth, async (req, res) => {
  const { sessionId, messageId, question, reason } = req.body;
  if (!sessionId || !question || !reason) {
    return res.status(400).json({ error: 'sessionId, question, and reason are required' });
  }
  try {
    const result = await aikbService.saveKnowledgeGap({
      clientId: req.client.id,
      sessionId,
      messageId: messageId || null,
      question,
      reason,
    });
    res.json({ success: true, gap: result.gap });
  } catch (err) {
    console.error('POST /api/knowledge/gaps error:', err.message);
    res.status(500).json({ error: 'Could not save knowledge gap.' });
  }
});

router.get('/knowledge/chat/sessions', clientAuth, async (req, res) => {
  try {
    const [allSessions, memberSessionIds] = await Promise.all([
      aikbService.listChatSessions(req.client.id),
      supabaseService.getMemberSessionIds(req.client.id, req.member.id),
    ]);
    const idSet = new Set(memberSessionIds);
    const sessions = Array.isArray(allSessions) ? allSessions : (allSessions.sessions || []);
    const filtered = sessions.filter(s => idSet.has(s.id || s.session_id));
    res.json(filtered);
  } catch (err) {
    console.error('GET /api/knowledge/chat/sessions error:', err.message);
    res.status(500).json({ error: 'Could not load chat history.' });
  }
});

router.get('/knowledge/chat/sessions/:sessionId/messages', clientAuth, async (req, res) => {
  const { sessionId } = req.params;
  try {
    // Verify ownership via local mapping
    const memberSessionIds = await supabaseService.getMemberSessionIds(req.client.id, req.member.id);
    if (!memberSessionIds.includes(sessionId)) {
      return res.status(403).json({ error: 'Session not found' });
    }
    const data = await aikbService.listChatMessages(req.client.id, sessionId);
    res.json(data);
  } catch (err) {
    console.error('GET /api/knowledge/chat/sessions/:sessionId/messages error:', err.message);
    res.status(500).json({ error: 'Could not load messages.' });
  }
});

router.delete('/knowledge/chat/sessions/:sessionId', clientAuth, async (req, res) => {
  const { sessionId } = req.params;
  try {
    const memberSessionIds = await supabaseService.getMemberSessionIds(req.client.id, req.member.id);
    if (!memberSessionIds.includes(sessionId)) {
      return res.status(403).json({ error: 'Session not found' });
    }
    await aikbService.deleteChatSession(req.client.id, sessionId);
    await supabaseService.deleteMemberSession(req.client.id, req.member.id, sessionId);
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/knowledge/chat/sessions/:sessionId error:', err.message);
    res.status(500).json({ error: 'Could not delete session.' });
  }
});

router.delete('/knowledge/chat/history', clientAuth, async (req, res) => {
  try {
    const memberSessionIds = await supabaseService.getMemberSessionIds(req.client.id, req.member.id);
    // Delete each of this member's sessions from AIKB
    await Promise.all(
      memberSessionIds.map(sid =>
        aikbService.deleteChatSession(req.client.id, sid).catch(() => {})
      )
    );
    await supabaseService.deleteMemberAllSessions(req.client.id, req.member.id);
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/knowledge/chat/history error:', err.message);
    res.status(500).json({ error: 'Could not clear history.' });
  }
});

router.patch('/knowledge/chat/sessions/:sessionId/title', clientAuth, async (req, res) => {
  const { title } = req.body;
  const { sessionId } = req.params;
  if (!title || typeof title !== 'string' || !title.trim()) {
    return res.status(400).json({ error: 'title is required' });
  }
  try {
    const memberSessionIds = await supabaseService.getMemberSessionIds(req.client.id, req.member.id);
    if (!memberSessionIds.includes(sessionId)) {
      return res.status(403).json({ error: 'Session not found' });
    }
    const data = await aikbService.updateChatSessionTitle(req.client.id, sessionId, title.trim());
    res.json(data);
  } catch (err) {
    console.error('PATCH /api/knowledge/chat/sessions/:sessionId/title error:', err.message);
    res.status(500).json({ error: 'Could not update session title.' });
  }
});

router.delete('/knowledge/document/:sourceFileId', clientAuth, async (req, res) => {
  try {
    await aikbService.deleteDocument(req.client.id, req.params.sourceFileId);
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/knowledge/document error:', err.message);
    res.status(500).json({ error: 'Could not delete document. Please try again.' });
  }
});

router.post('/portal/issues', clientAuth, async (req, res) => {
  const { subject, issueType, message } = req.body;
  if (!subject || !issueType || !message) {
    return res.status(400).json({ error: 'subject, issueType, and message are required.' });
  }
  try {
    const issue = await supabaseService.createPortalIssue({
      clientId: req.client.id,
      submittedBy: req.user?.id || null,
      submittedEmail: req.user?.email || null,
      subject,
      issueType,
      message,
    });
    res.status(201).json(issue);
  } catch (err) {
    console.error('portal/issues POST error:', err.message);
    res.status(500).json({ error: 'Could not submit your issue. Please try again.' });
  }
});

module.exports = router;
