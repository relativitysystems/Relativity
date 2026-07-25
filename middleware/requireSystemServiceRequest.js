'use strict';

// Verifies the system-scoped HMAC service-request envelope (EM8 —
// EMAIL_INGESTION.md §18.3, §31) on inbound AIKB -> Relativity callbacks
// that carry no clientId at all — currently only
// POST /api/integrations/email/sync/tick. See services/serviceRequestAuth.js
// for the envelope format and the honest scope note. Deliberately a
// SEPARATE middleware from requireServiceRequest, not a variant of it — a
// system envelope must never be mistaken for (or silently accepted in place
// of) a clientId-scoped one, and vice versa; keeping them as two functions
// makes that impossible by construction rather than by convention.
//
// On success, attaches the VERIFIED { idempotencyKey, requestId } to
// req.systemRequest — there is no clientId to attach, by design.

const config = require('../config');
const { verifySystemServiceRequest } = require('../services/serviceRequestAuth');

module.exports = function requireSystemServiceRequest(req, res, next) {
  const secret = config.serviceRequest.signingSecret;
  if (!secret) {
    return res.status(500).json({ error: 'Service request signing is not configured on this server.' });
  }

  const body = req.body || {};
  const { requestId, issuedAt, expiresAt, idempotencyKey, signature, payload } = body;

  const result = verifySystemServiceRequest({
    envelope: { requestId, issuedAt, expiresAt, idempotencyKey, signature },
    payload,
    secret,
  });

  if (!result.ok) {
    return res.status(401).json({ error: 'Invalid service request.' });
  }

  req.systemRequest = { idempotencyKey: result.idempotencyKey, requestId: result.requestId };
  req.servicePayload = payload || {};
  next();
};
