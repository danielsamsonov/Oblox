// Bounded binary request reader. The body is consumed before a database transaction.
module.exports=function readBinary(req,limit){return new Promise((resolve,reject)=>{
  let size=0,finished=false;const chunks=[];
  const timer=setTimeout(()=>fail('Upload timed out.',408,'request_timeout'),30000);timer.unref();
  function fail(message,status,code){if(finished)return;finished=true;clearTimeout(timer);chunks.length=0;const e=new Error(message);e.status=status;e.code=code;reject(e);}
  req.on('data',chunk=>{size+=chunk.length;if(size>limit){fail('File is too large.',413,'payload_too_large');return;}if(!finished)chunks.push(chunk);});
  req.once('end',()=>{if(finished)return;finished=true;clearTimeout(timer);resolve(Buffer.concat(chunks));});
  req.once('aborted',()=>fail('Upload was interrupted.',400,'request_interrupted'));req.once('error',()=>fail('Upload was interrupted.',400,'request_interrupted'));
  if(Number(req.headers['content-length']||0)>limit)fail('File is too large.',413,'payload_too_large');
});};
