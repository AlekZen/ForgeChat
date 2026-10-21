'use strict';
// Existing backend bindings only. Never exports their values or raw MCP output.
const {randomUUID}=require('node:crypto');
class BindingError extends Error{constructor(code){super(code);this.code=code;}}
const fail=code=>{throw new BindingError(code);};
async function limitedJson(response){
  if(!response.ok){const error=new BindingError('MCP_HTTP_DENIED');error.status=response.status;throw error;}
  if(!response.body)fail('MCP_INVALID_RESPONSE');
  let bytes=0;const chunks=[];
  for await(const chunk of response.body){bytes+=chunk.byteLength;if(bytes>524288){await response.body.cancel().catch(()=>{});fail('MCP_RESPONSE_TOO_LARGE');}chunks.push(Buffer.from(chunk));}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{fail('MCP_INVALID_RESPONSE');}
}
function createNexusBinding({env=process.env,fetchImpl=fetch}={}){
  const target=new URL('/api/v1/nexus/mcp',env.NEXUS_INVITAR_URL||'https://diapazo.com');
  if(target.protocol!=='https:'||target.hostname!=='diapazo.com'||target.port||target.username||target.password)fail('MCP_TARGET_INVALID');
  const key=env.NEXUS_LLAVE_ALEKITO_WHATSAPP;
  if(typeof key!=='string'||!key||/[\r\n]/.test(key))fail('MCP_NOT_BOUND');
  async function rpc(method,params,{signal}={}){
    const id=randomUUID();let data;
    try{data=await limitedJson(await fetchImpl(target,{method:'POST',redirect:'error',signal,
      headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json',Accept:'application/json, text/event-stream'},
      body:JSON.stringify({jsonrpc:'2.0',id,method,params})}));}
    catch(error){if(error instanceof BindingError)throw error;fail('MCP_UNAVAILABLE');}
    if(data?.error&&Number.isInteger(data.error.code)){const error=new Error('MCP_RPC_ERROR');error.code=data.error.code;throw error;}
    if(data?.id!==id||data.jsonrpc!=='2.0'||!data.result)fail('MCP_INVALID_RESPONSE');return data.result;
  }
  async function callTool(tool,{signal}={}){
    if(tool?.name!=='contexto_de_contacto')fail('MCP_SCOPE_DENIED');
    if(tool.name==='contexto_de_contacto'&&(!tool.arguments||Object.keys(tool.arguments).join(',')!=='sello'))fail('MCP_INVALID_ARGUMENTS');
    return rpc('tools/call',tool,{signal});
  }
  async function listTools(args={},options={}){if(!args||Object.keys(args).length)fail('MCP_INVALID_ARGUMENTS');return rpc('tools/list',{},options);}
  let adapter;
  const client=Object.freeze({listTools,callTool});
  const get=async()=>adapter||(adapter=import('./existing-nexus-client.mjs').then(m=>m.createExistingNexusClientAdapter({client})));
  return Object.freeze({probe:async()=> (await get()).probe(),readContext:async input=>(await get()).readContext(input),
    counters:async()=>(await get()).counters()});
}
module.exports={createNexusBinding,BindingError};
