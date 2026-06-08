const express = require('express');
const router = express.Router();
const apiKey = require('../middleware/apiKey');
const googleDriveService = require('../services/googleDriveService');

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

module.exports = router;
