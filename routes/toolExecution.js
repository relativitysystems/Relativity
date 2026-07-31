'use strict';

// EL3 (Architecture/architecture/LIVE_EMAIL_LOOKUP.md S1.1 step 7,
// ADR-010) — the single, generic, provider-agnostic endpoint AIKB calls to
// execute a bounded tool. Authenticated by the existing clientId-scoped
// signed envelope (requireServiceRequest, unchanged, no new signing
// scheme) exactly like POST /api/integrations/slack/deliver's reversed
// AIKB -> Relativity direction.
//
// Always responds 200 on a well-authenticated request — a business-level
// tool failure (e.g. an unrecognized tool name) is expressed as a named
// status/reason in the JSON body, never as an HTTP error status. Only an
// authentication failure (missing/tampered/expired envelope) gets a real
// HTTP error, from requireServiceRequest itself. This anticipates S9's
// "no silent fallback, every non-ok status reaches the caller as an
// explicit named reason" design.
//
// requestingMemberId/origin/originMetadata (the full payload shape S1.1
// step 7 specifies) are read here and passed through — EL4 is what
// actually authorizes against requestingMemberId (services/
// emailLiveLookupService.js's 8-gate chain); origin/originMetadata remain
// unused pending EL9's audit logging.
//
// clientId is read from req.serviceRequest (the verified, envelope-bound
// field), never from req.servicePayload — the same discipline every other
// signed route in this file's neighborhood follows.

const express = require('express');
const requireServiceRequest = require('../middleware/requireServiceRequest');
const toolExecutionService = require('../services/toolExecutionService');

const router = express.Router();

router.post('/execute', requireServiceRequest, async (req, res) => {
  const { toolName, args, requestingMemberId } = req.servicePayload || {};
  const { clientId } = req.serviceRequest;
  const result = await toolExecutionService.executeTool({ toolName, args, clientId, requestingMemberId });
  return res.status(200).json(result);
});

module.exports = router;
