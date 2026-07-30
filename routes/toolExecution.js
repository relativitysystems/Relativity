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
// step 7 specifies) are accepted here but not yet used for anything —
// no authorization gate beyond signature verification exists this
// milestone; that's EL4.

const express = require('express');
const requireServiceRequest = require('../middleware/requireServiceRequest');
const toolExecutionService = require('../services/toolExecutionService');

const router = express.Router();

router.post('/execute', requireServiceRequest, async (req, res) => {
  const { toolName, args } = req.servicePayload || {};
  const result = await toolExecutionService.executeTool({ toolName, args });
  return res.status(200).json(result);
});

module.exports = router;
