'use strict';
const bridge=require('./alekitoBridge');
const {BridgeError}=require('./alekitoBridgePolicy');
const {createOwnerProjectBinding}=require('./alekitoOwnerProjectBinding.cjs');
const {OwnerReadError}=require('./alekitoOwnerReadWire.cjs');
let binding;
async function ownerProjectRead(body){
 try{
  if(!binding)binding=createOwnerProjectBinding({verifyOwnerIngress:bridge.verifyOwnerIngress,ownerRef:'c_74634837c171',accountRef:'af6adeb5076b'});
  return await binding.read(body);
 }catch(error){if(error instanceof OwnerReadError)throw new BridgeError(error.code,error.status);throw error;}
}
module.exports={ownerProjectRead};
