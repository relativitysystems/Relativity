'use strict';

// Knowledge Collections management (Milestone 5: Slack Knowledge
// Collections). Thin proxy over AIKB's collections endpoints
// (aikb/routes/knowledge.js) — AIKB owns the collections themselves and
// enforces retrieval filtering; Relativity owns who's allowed to manage
// them (owner/admin only for writes, matching this repo's existing
// role-gating convention — see routes/team.js's requireRole).
//
// Mounted at /api in app.js, so internal paths here are prefixed with
// /collections and /knowledge/document/:sourceFileId/collection, matching
// routes/team.js's convention of prefixing its own path segment rather than
// being mounted at a dedicated base.

const express = require('express');
const router = express.Router();
const clientAuth = require('../middleware/clientAuth');
const aikbService = require('../services/aikbService');

const OWNER_ADMIN = ['owner', 'admin'];

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.member || !roles.includes(req.member.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

function passthroughStatus(err, res, fallbackMessage) {
  if (err.status && err.responseBody && err.responseBody.error) {
    return res.status(err.status).json({ error: err.responseBody.error });
  }
  res.status(500).json({ error: fallbackMessage });
}

/**
 * GET /api/collections
 * Any active member (read-only) — matches /api/integrations/slack/status's
 * existing openness to any authenticated, active member.
 */
router.get('/collections', clientAuth, async (req, res) => {
  try {
    const data = await aikbService.listCollections(req.client.id);
    res.json(data);
  } catch (err) {
    console.error('GET /api/collections error:', err.message);
    res.status(500).json({ error: 'Could not load collections.' });
  }
});

/**
 * POST /api/collections
 * owner/admin only. Body: { name }
 */
router.post('/collections', clientAuth, requireRole(...OWNER_ADMIN), async (req, res) => {
  const { name } = req.body;
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'name is required' });
  }
  try {
    const data = await aikbService.createCollection(req.client.id, name.trim());
    res.status(201).json(data);
  } catch (err) {
    console.error('POST /api/collections error:', err.message);
    passthroughStatus(err, res, 'Could not create collection.');
  }
});

/**
 * PATCH /api/collections/:collectionId
 * owner/admin only. Body: { name }
 */
router.patch('/collections/:collectionId', clientAuth, requireRole(...OWNER_ADMIN), async (req, res) => {
  const { name } = req.body;
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'name is required' });
  }
  try {
    const data = await aikbService.renameCollection(req.client.id, req.params.collectionId, name.trim());
    res.json(data);
  } catch (err) {
    console.error('PATCH /api/collections/:collectionId error:', err.message);
    passthroughStatus(err, res, 'Could not rename collection.');
  }
});

/**
 * DELETE /api/collections/:collectionId
 * owner/admin only. Refuses (via AIKB) to delete the default collection or
 * a non-empty one.
 */
router.delete('/collections/:collectionId', clientAuth, requireRole(...OWNER_ADMIN), async (req, res) => {
  try {
    const data = await aikbService.deleteCollection(req.client.id, req.params.collectionId);
    res.json(data);
  } catch (err) {
    console.error('DELETE /api/collections/:collectionId error:', err.message);
    passthroughStatus(err, res, 'Could not delete collection.');
  }
});

/**
 * PATCH /api/knowledge/document/:sourceFileId/collection
 * owner/admin only (same permission level as deleting/uploading a document).
 * Body: { collectionId }
 */
router.patch('/knowledge/document/:sourceFileId/collection', clientAuth, requireRole(...OWNER_ADMIN), async (req, res) => {
  const { collectionId } = req.body;
  if (!collectionId || typeof collectionId !== 'string') {
    return res.status(400).json({ error: 'collectionId is required' });
  }
  try {
    const data = await aikbService.moveDocumentCollection(req.client.id, req.params.sourceFileId, collectionId);
    res.json(data);
  } catch (err) {
    console.error('PATCH /api/knowledge/document/:sourceFileId/collection error:', err.message);
    passthroughStatus(err, res, 'Could not move document.');
  }
});

module.exports = router;
