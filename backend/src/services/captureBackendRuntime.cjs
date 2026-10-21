'use strict';
const bridge=require('./alekitoBridge');
const readRuntime=require('./humanReadRuntime.cjs');
const pool=require('../db');
const policy=require('./capturePolicy.cjs');
const {createHumanCaptureBackend}=require('./captureBackend.cjs');
// Existing private owner ingress + turn ledger guard; no new SQL schema or owner attestation.
module.exports=createHumanCaptureBackend({enabled:policy.enabled,resolveVerifiedEndpoint:bridge.resolveVerifiedHumanReadEndpoint,assertTurnPolicy:input=>readRuntime.createHistoryGuard(pool).assertTurnPolicy(input)});
