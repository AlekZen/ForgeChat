'use strict';
const {Router}=require('express');
const bridge=require('../services/alekitoBridge');
const {BridgeError}=require('../services/alekitoBridgePolicy');
const {TurnApiError}=require('../services/alekitoTurnApi');
const {LedgerError}=require('../services/alekitoTurnLedger');
const {OwnershipError}=require('../services/alekitoInboundOwnership');
const router=Router();
const {ownerProjectRead}=require('../services/alekitoOwnerProjectService.cjs');
router.use('/internal/alekito',async(req,res,next)=>{
  res.set('Cache-Control','no-store');
  try { if(!await bridge.internalAuthorized(req)) return res.status(403).json({ok:false,error_code:'INTERNAL_AUTH_REQUIRED'}); next(); }
  catch { return res.status(503).json({ok:false,error_code:'INTERNAL_AUTH_UNAVAILABLE'}); }
});
const endpoint=(action,{accepted=false}={})=>async(req,res)=>{
  try {
    const result=await action(req);
    return res.status(accepted && !result.terminal?202:200).json(result);
  } catch(err) {
    const known=err instanceof BridgeError||err instanceof TurnApiError||err instanceof LedgerError||err instanceof OwnershipError;
    // Never log request bodies, provider responses, seals, headers or secrets.
    if(!known) console.error('[alekito-bridge] operation failed');
    return res.status(known?(err.status||(err.code==='LEDGER_STORAGE_FAILED'?503:409)):503).json({ok:false,error_code:known?err.code:'BRIDGE_UNAVAILABLE',...(known&&err.details?{details:err.details}:{}),retry_post:false});
  }
};
router.get('/internal/alekito/templates',endpoint(()=>bridge.catalog()));
router.post('/internal/alekito/preview',endpoint(req=>bridge.preview(req.body)));
router.post('/internal/alekito/owner-template',endpoint(req=>bridge.sendOwnerTemplate(req.body),{accepted:true}));
router.get('/internal/alekito/owner-template/:request_id',endpoint(req=>bridge.status(req.params.request_id),{accepted:true}));
router.get('/internal/alekito/ingress/latest-owner',endpoint(()=>bridge.latestOwnerIngress()));
router.post('/internal/alekito/ingress/verify',endpoint(req=>bridge.verifyOwnerIngress(req.body)));
router.get('/internal/alekito/nexus-status',endpoint(()=>bridge.nexusStatus()));
router.post('/internal/alekito/conversation/reserve',endpoint(req=>bridge.reserveTurn(req.body)));
router.post('/internal/alekito/conversation/result',endpoint(req=>bridge.completeTurn(req.body)));
router.post('/internal/alekito/conversation/status',endpoint(req=>bridge.turnStatus(req.body)));
router.post('/internal/alekito/conversation/continuity',endpoint(req=>bridge.ownerContinuity(req.body)));
router.post('/internal/alekito/conversation/deliver',endpoint(req=>bridge.deliverTurn(req.body)));
router.post('/internal/alekito/conversation/capture-next',endpoint(req=>bridge.captureNextOwner(req.body)));
router.get('/internal/alekito/conversation/capture/:capture_id',endpoint(req=>bridge.captureStatus(req.params.capture_id)));
router.post('/internal/alekito/context',endpoint(req=>bridge.context(req.body)));
router.post('/internal/alekito/conversation/owner-project-read',endpoint(req=>ownerProjectRead(req.body)));
// This tool wrapper remains inside the existing internal secret+peer middleware.
router.post('/internal/alekito/conversation/human-mission-read-v1',require('../services/humanReadRoute.cjs').createHumanReadRoute({service:require('../services/humanReadRuntime.cjs')}));
router.post('/internal/alekito/conversation/human-mission-capture-v1',require('../services/captureBackendRoute.cjs').createHumanCaptureRoute({mode:'capture',service:require('../services/captureBackendRuntime.cjs')}));
router.post('/internal/alekito/conversation/owner-superpowers-v1',require('../services/ownerSuperpowers.cjs').createOwnerSuperpowersRoute());
router.post('/internal/alekito/conversation/human-mission-capture-status-v1',require('../services/captureBackendRoute.cjs').createHumanCaptureRoute({mode:'status',service:require('../services/captureBackendRuntime.cjs')}));
module.exports={router};
