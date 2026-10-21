'use strict';
const {CaptureError}=require('./captureCore.cjs');
function createHumanCaptureRoute({service,mode}){if(!['capture','status'].includes(mode))throw new TypeError('CAPTURE_ROUTE_MODE');return async(req,res)=>{try{return res.json(await service[mode](req.body));}catch(error){const known=error instanceof CaptureError;return res.status(known&&[400,403,409,503].includes(error.status)?error.status:503).json({ok:false,error_code:known?error.code:'CAPTURE_UNAVAILABLE',retry_capture:false});}};}
module.exports={createHumanCaptureRoute};
