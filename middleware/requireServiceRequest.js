'use strict';

// Verifies the additive HMAC service-request envelope on inbound AIKB ->
// Relativity callbacks (Architecture Review Phase 4, Milestone 4, §4.10) —
// currently only POST /api/integrations/slack/deliver. See
// services/serviceRequestAuth.js for the envelope format and the honest
// scope note (this is NOT the full future signed ServiceRequest platform).
//
// On success, attaches the VERIFIED { clientId, idempotencyKey, requestId }
// to req.serviceRequest — downstream handlers must only ever read clientId
// from there, never from req.body.clientId or req.body.payload.

const config = require('../config');
const { verifyServiceRequest } = require('../services/serviceRequestAuth');

module.exports = function requireServiceRequest(req, res, next) {
  const secret = config.serviceRequest.signingSecret;
  if (!secret) {
    return res.status(500).json({ error: 'Service request signing is not configured on this server.' });
  }

  const body = req.body || {};
  const { requestId, issuedAt, expiresAt, clientId, idempotencyKey, signature, payload } = body;

  const result = verifyServiceRequest({
    envelope: { requestId, issuedAt, expiresAt, clientId, idempotencyKey, signature },
    payload,
    secret,
  });

  if (!result.ok) {
    return res.status(401).json({ error: 'Invalid service request.' });
  }

  req.serviceRequest = { clientId: result.clientId, idempotencyKey: result.idempotencyKey, requestId: result.requestId };
  req.servicePayload = payload || {};
  next();
};
