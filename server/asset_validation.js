const crypto=require('node:crypto');
const zlib=require('node:zlib');
const MAX_ASSET=50*1024*1024, MAX_TEXTURE=4*1024*1024, MAX_AUDIO_SECONDS=3600;
const MAX_GAME_ASSETS=200*1024*1024, MAX_USER_ASSETS=256*1024*1024;
const MP3_BITRATES_HIGH=[0,32,40,48,56,64,80,96,112,128,160,192,224,256,320];
const MP3_BITRATES_LOW=[0,8,16,24,32,40,48,56,64,80,96,112,128,144,160];
const MP3_SAMPLE_RATES=[44100,48000,32000];
function fail(message,status=400,code='invalid_asset'){const e=new Error(message);e.status=status;e.code=code;throw e;}
function dimension(w,h){if(!Number.isInteger(w)||!Number.isInteger(h)||w<1||h<1||w>2048||h>2048)fail('Textures must be at most 2048 by 2048 pixels.');}
function png(data){
  if(data.length<45||!data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return false;
  let pos=8,first=true,ended=false;const compressed=[];
  while(pos+12<=data.length){const length=data.readUInt32BE(pos),type=data.toString('ascii',pos+4,pos+8);if(length>MAX_TEXTURE||pos+length+12>data.length)fail('Invalid PNG data.');
    if(first){if(type!=='IHDR'||length!==13)fail('Invalid PNG header.');dimension(data.readUInt32BE(pos+8),data.readUInt32BE(pos+12));const bits=data[pos+16],color=data[pos+17];const allowed={0:[1,2,4,8,16],2:[8,16],3:[1,2,4,8],4:[8,16],6:[8,16]};if(!allowed[color]?.includes(bits)||data[pos+18]!==0||data[pos+19]!==0||data[pos+20]>1)fail('Invalid PNG encoding.');first=false;}
    if(type==='IDAT')compressed.push(data.subarray(pos+8,pos+8+length));pos+=length+12;
    if(type==='IEND'){if(length!==0)fail('Invalid PNG ending.');ended=true;break;}
  }
  if(!ended||pos!==data.length||!compressed.length)fail('Invalid PNG data.');
  try{zlib.inflateSync(Buffer.concat(compressed),{maxOutputLength:64*1024*1024});}catch{fail('Invalid or oversized PNG image.');}return true;
}
function jpeg(data){
  if(data.length<10||data[0]!==255||data[1]!==216)return false;
  if(data[data.length-2]!==255||data[data.length-1]!==217)fail('Invalid JPEG data.');
  let pos=2,dimensions=false;
  while(pos+4<=data.length){if(data[pos++]!==255)fail('Invalid JPEG marker.');while(data[pos]===255)pos++;const marker=data[pos++];if(marker===218)break;if(marker===217)break;
    if(marker===1||(marker>=208&&marker<=215))continue;const length=data.readUInt16BE(pos);if(length<2||pos+length>data.length)fail('Invalid JPEG length.');
    if([192,193,194].includes(marker)){if(length<8)fail('Invalid JPEG frame.');dimension(data.readUInt16BE(pos+5),data.readUInt16BE(pos+3));dimensions=true;}pos+=length;
  }
  if(!dimensions)fail('JPEG image dimensions were not found.');return true;
}
function wav(data){
  if(data.length<44||data.toString('ascii',0,4)!=='RIFF'||data.toString('ascii',8,12)!=='WAVE')return false;
  if(data.readUInt32LE(4)+8!==data.length)fail('Invalid WAV length.');let pos=12,format=false,samples=false,rate=0,channels=0,bits=0,bytes=0;
  while(pos+8<=data.length){const type=data.toString('ascii',pos,pos+4),length=data.readUInt32LE(pos+4);pos+=8;if(pos+length>data.length)fail('Invalid WAV chunk.');
    if(type==='fmt '){if(length<16)fail('Invalid WAV format.');const encoding=data.readUInt16LE(pos);channels=data.readUInt16LE(pos+2);rate=data.readUInt32LE(pos+4);bits=data.readUInt16LE(pos+14);if(![1,3].includes(encoding)||(encoding===3&&bits!==32)||channels<1||channels>2||rate<8000||rate>192000||![8,16,24,32].includes(bits))fail('WAV must contain mono or stereo PCM audio.');format=true;}
    if(type==='data'){samples=length>0;bytes+=length;}pos+=length+(length%2);
  }
  if(!format||!samples||bytes/(rate*channels*bits/8)>MAX_AUDIO_SECONDS)fail('Invalid or excessively long WAV audio.');return true;
}
function ogg(data){
  if(data.length<58||data.toString('ascii',0,4)!=='OggS')return false;let pos=0,sampleRate=0,first=true;
  while(pos<data.length){if(pos+27>data.length||data.toString('ascii',pos,pos+4)!=='OggS'||data[pos+4]!==0)fail('Invalid Ogg stream.');const count=data[pos+26];if(pos+27+count>data.length)fail('Invalid Ogg page.');let length=0;for(let n=0;n<count;n++)length+=data[pos+27+n];const payload=pos+27+count;if(payload+length>data.length)fail('Invalid Ogg data.');
    if(first){if(length<30||data[payload]!==1||data.toString('ascii',payload+1,payload+7)!=='vorbis')fail('Only Ogg Vorbis audio is supported.');const channels=data[payload+11];sampleRate=data.readUInt32LE(payload+12);if(channels<1||channels>2||sampleRate<8000||sampleRate>192000)fail('Ogg must contain mono or stereo Vorbis audio.');first=false;}
    const granule=data.readBigUInt64LE(pos+6);if(granule!==0xffffffffffffffffn&&granule>BigInt(sampleRate*MAX_AUDIO_SECONDS))fail('Audio must be at most one hour long.');pos=payload+length;
  }return !first;
}
// Check complete MPEG Layer III framing; file extensions and ID3 alone are not audio.
function mp3(data){
  let pos=0,end=data.length,frames=0,seconds=0,stream;
  if(data.toString('ascii',0,3)==='ID3'){
    if(data.length<10||![2,3,4].includes(data[3])||data[4]===255)fail('Invalid MP3 ID3 header.');
    let length=0;for(let n=6;n<10;n++){if(data[n]&128)fail('Invalid MP3 tag length.');length=length*128+data[n];}
    pos=10+length;
    if(data[3]===4&&(data[5]&16)){if(pos+10>end||data.toString('ascii',pos,pos+3)!=='3DI')fail('Invalid MP3 tag footer.');pos+=10;}
    if(pos>=end)fail('MP3 file contains tags but no audio.');
  }
  if(end-pos>=128&&data.toString('ascii',end-128,end-125)==='TAG')end-=128;
  if(end-pos>=32&&data.toString('ascii',end-32,end-24)==='APETAGEX'){
    const length=data.readUInt32LE(end-20);if(length<32||length>end-pos)fail('Invalid MP3 APE tag.');end-=length;
    if(end-pos>=32&&data.toString('ascii',end-32,end-24)==='APETAGEX')end-=32;
  }
  while(pos+4<=end){
    // Encoder padding after the last complete frame is allowed, bounded to 64 KiB.
    if(data[pos]===0&&end-pos<=65536){for(let n=pos;n<end;n++)if(data[n]!==0)fail('Invalid MP3 trailing bytes.');pos=end;break;}
    const a=data[pos],b=data[pos+1],c=data[pos+2],d=data[pos+3];
    const version=(b>>3)&3,layer=(b>>1)&3,bitrateIndex=c>>4,rateIndex=(c>>2)&3;
    if(a!==255||(b&224)!==224||version===1||layer!==1||bitrateIndex===0||bitrateIndex===15||rateIndex===3)fail('Invalid MP3 audio frame.');
    const table=version===3?MP3_BITRATES_HIGH:MP3_BITRATES_LOW;
    const rate=MP3_SAMPLE_RATES[rateIndex]/(version===3?1:version===2?2:4),channels=(d>>6)===3?1:2;
    const identity=version+':'+rate+':'+channels;if(stream&&stream!==identity)fail('MP3 stream format changes between frames.');stream=identity;
    const length=Math.floor((version===3?144000:72000)*table[bitrateIndex]/rate)+((c>>1)&1);
    const side=(version===3?(channels===1?17:32):(channels===1?9:17))+4+((b&1)?0:2);
    if(length<side||pos+length>end)fail('Truncated MP3 audio frame.');
    seconds+=(version===3?1152:576)/rate;if(seconds>MAX_AUDIO_SECONDS)fail('Audio must be at most one hour long.');
    pos+=length;frames++;
  }
  if(pos!==end||frames<2)fail('MP3 needs at least two complete audio frames.');
  return true;
}
function glb(data){
  if(data.length<20||data.toString('ascii',0,4)!=='glTF')return false;
  if(data.readUInt32LE(4)!==2||data.readUInt32LE(8)!==data.length||data.readUInt32LE(16)!==0x4e4f534a)fail('Invalid GLB 2.0 file.');
  const length=data.readUInt32LE(12);if(length>1024*1024||length%4||20+length>data.length)fail('Invalid or oversized GLB JSON.');
  let doc;try{doc=JSON.parse(data.toString('utf8',20,20+length).replace(/[\u0000 ]+$/,''));}catch{fail('Invalid GLB JSON.');}
  const object=v=>v&&typeof v==='object'&&!Array.isArray(v);
  if(!object(doc)||!object(doc.asset)||doc.asset.version!=='2.0')fail('GLB version 2.0 is required.');
  const pending=[doc];let visits=0;
  while(pending.length){const value=pending.pop();if(++visits>100000)fail('GLB is too complex.');if(typeof value==='number'&&(!Number.isFinite(value)||Math.abs(value)>1e12))fail('Invalid GLB number.');if(value&&typeof value==='object'){if(Object.hasOwn(value,'uri'))fail('GLB must embed all data; external URIs are not allowed.');for(const child of Object.values(value))pending.push(child);}}
  function array(value,max,name){if(value===undefined)return [];if(!Array.isArray(value)||value.length>max)fail('Invalid or oversized model '+name+'.');return value;}
  function records(value,max,name){const result=array(value,max,name);if(result.some(v=>!object(v)))fail('Invalid model '+name+'.');return result;}
  function integer(value,min,max){if(!Number.isInteger(value)||value<min||value>max)fail('Invalid model index or range.');return value;}
  function index(value,values){return integer(value,0,values.length-1);}
  const nodes=records(doc.nodes,512,'nodes'),meshes=records(doc.meshes,256,'meshes'),materials=records(doc.materials,256,'materials'),images=records(doc.images,64,'images');
  const buffers=records(doc.buffers,1,'buffers'),views=records(doc.bufferViews,4096,'buffer views'),accessors=records(doc.accessors,4096,'accessors'),scenes=records(doc.scenes,64,'scenes');
  const textures=records(doc.textures,256,'textures'),samplers=records(doc.samplers,256,'samplers'),skins=records(doc.skins,256,'skins'),animations=records(doc.animations,128,'animations'),cameras=records(doc.cameras,128,'cameras');
  let pos=20+length,binary=Buffer.alloc(0),binaryFound=false;
  while(pos<data.length){if(pos+8>data.length)fail('Invalid GLB chunk.');const n=data.readUInt32LE(pos),type=data.readUInt32LE(pos+4);if(n%4||pos+8+n>data.length)fail('Invalid GLB chunk length.');if(type===0x004e4942){if(binaryFound)fail('Only one embedded GLB buffer is supported.');binaryFound=true;binary=data.subarray(pos+8,pos+8+n);}pos+=8+n;}
  for(const buffer of buffers)integer(buffer.byteLength,0,binary.length);
  for(const view of views){index(view.buffer,buffers);const offset=integer(view.byteOffset===undefined?0:view.byteOffset,0,binary.length),size=integer(view.byteLength,1,binary.length);if(offset+size>binary.length||offset+size>buffers[view.buffer].byteLength)fail('Model buffer view is outside its embedded buffer.');if(view.byteStride!==undefined){integer(view.byteStride,4,252);if(view.byteStride%4)fail('Invalid model buffer stride.');}}
  function inside(viewId,offset,size){index(viewId,views);integer(offset,0,views[viewId].byteLength);if(offset+size>views[viewId].byteLength)fail('Model accessor is outside its buffer view.');}
  const componentBytes={5120:1,5121:1,5122:2,5123:2,5125:4,5126:4},dimensions={SCALAR:1,VEC2:2,VEC3:3,VEC4:4,MAT2:4,MAT3:9,MAT4:16};
  let count=0;
  for(const accessor of accessors){count+=integer(accessor.count,0,600000);if(count>600000)fail('Model accessor data is too large.');const component=componentBytes[accessor.componentType],dimension=dimensions[accessor.type];if(!component||!dimension)fail('Invalid model accessor type.');let elementBytes=component*dimension;if(accessor.type.startsWith('MAT')){const columns=Number(accessor.type.slice(3));elementBytes=Math.ceil(columns*component/4)*4*columns;}
    const offset=accessor.byteOffset===undefined?0:accessor.byteOffset;integer(offset,0,binary.length);
    if(accessor.bufferView!==undefined){index(accessor.bufferView,views);const stride=views[accessor.bufferView].byteStride||elementBytes;if(stride<elementBytes)fail('Invalid model accessor stride.');inside(accessor.bufferView,offset,accessor.count?stride*(accessor.count-1)+elementBytes:0);}
    if(accessor.sparse!==undefined){const sparse=accessor.sparse;if(!object(sparse)||!object(sparse.indices)||!object(sparse.values))fail('Invalid sparse model accessor.');integer(sparse.count,1,accessor.count);if(![5121,5123,5125].includes(sparse.indices.componentType))fail('Invalid sparse accessor indices.');inside(sparse.indices.bufferView,sparse.indices.byteOffset||0,sparse.count*componentBytes[sparse.indices.componentType]);inside(sparse.values.bufferView,sparse.values.byteOffset||0,sparse.count*elementBytes);}
    for(const field of ['min','max'])if(accessor[field]!==undefined){if(!Array.isArray(accessor[field])||accessor[field].length!==dimension||accessor[field].some(n=>typeof n!=='number'||!Number.isFinite(n)))fail('Invalid accessor bounds.');}
  }
  for(const image of images){index(image.bufferView,views);const view=views[image.bufferView],bytes=binary.subarray(view.byteOffset||0,(view.byteOffset||0)+view.byteLength);if(bytes.length>MAX_TEXTURE)fail('Embedded textures must be at most 4 MiB.');if(!(['image/png','image/jpeg'].includes(image.mimeType)))fail('Embedded model textures must be PNG or JPEG.');if(image.mimeType==='image/png'?!png(bytes):!jpeg(bytes))fail('Invalid embedded model texture.');}
  for(const texture of textures){if(texture.source!==undefined)index(texture.source,images);if(texture.sampler!==undefined)index(texture.sampler,samplers);}
  let primitiveCount=0,referencedVertices=0;
  for(const mesh of meshes){const primitives=records(mesh.primitives,256,'mesh primitives');primitiveCount+=primitives.length;if(primitiveCount>1024)fail('Model has too many mesh primitives.');if(!primitives.length)fail('A model mesh must have primitives.');for(const primitive of primitives){if(!object(primitive.attributes))fail('Invalid model vertex attributes.');for(const value of Object.values(primitive.attributes))index(value,accessors);if(primitive.attributes.POSITION!==undefined){referencedVertices+=accessors[primitive.attributes.POSITION].count;if(referencedVertices>600000)fail('Model duplicates too many vertices.');}if(primitive.indices!==undefined)index(primitive.indices,accessors);if(primitive.material!==undefined)index(primitive.material,materials);if(primitive.mode!==undefined)integer(primitive.mode,0,6);for(const target of records(primitive.targets,64,'morph targets'))for(const value of Object.values(target))index(value,accessors);}}
  const parents=Array(nodes.length).fill(0),state=Array(nodes.length).fill(0),height=Array(nodes.length).fill(0);
  for(const node of nodes){for(const child of array(node.children,512,'node children')){index(child,nodes);if(++parents[child]>1)fail('Model nodes cannot have multiple parents.');}if(node.mesh!==undefined)index(node.mesh,meshes);if(node.skin!==undefined)index(node.skin,skins);if(node.camera!==undefined)index(node.camera,cameras);for(const [field,size]of[['translation',3],['rotation',4],['scale',3],['matrix',16]])if(node[field]!==undefined&&(array(node[field],size,'transform').length!==size||node[field].some(n=>typeof n!=='number'||!Number.isFinite(n))))fail('Invalid node transform.');}
  function visit(n){if(state[n]===1)fail('Model node hierarchy contains a cycle.');if(state[n]===2)return height[n];state[n]=1;let result=1;for(const child of nodes[n].children||[])result=Math.max(result,1+visit(child));if(result>32)fail('Model node hierarchy is too deep.');state[n]=2;return height[n]=result;}
  for(let n=0;n<nodes.length;n++)visit(n);
  for(const scene of scenes)for(const root of array(scene.nodes,512,'scene nodes')){index(root,nodes);if(parents[root])fail('Scene root must not be a child node.');}if(doc.scene!==undefined)index(doc.scene,scenes);
  for(const skin of skins){if(skin.inverseBindMatrices!==undefined)index(skin.inverseBindMatrices,accessors);if(skin.skeleton!==undefined)index(skin.skeleton,nodes);for(const joint of array(skin.joints,512,'skin joints'))index(joint,nodes);}
  for(const animation of animations){const samples=records(animation.samplers,1024,'animation samplers');for(const sampler of samples){index(sampler.input,accessors);index(sampler.output,accessors);}for(const channel of records(animation.channels,1024,'animation channels')){index(channel.sampler,samples);if(!object(channel.target))fail('Invalid animation target.');if(channel.target.node!==undefined)index(channel.target.node,nodes);}}
  return true;
}
function validateAsset(data,kind,name){
  if(!Buffer.isBuffer(data)||!data.length||data.length>MAX_ASSET)fail('File must be between 1 byte and 50 MiB.',413,'payload_too_large');if(!['texture','sound','model'].includes(kind))fail('Choose texture, sound or model.');
  let format,mime;
  try{
    if(kind==='texture'){if(data.length>MAX_TEXTURE)fail('Texture must be at most 4 MiB.',413,'payload_too_large');if(png(data)){format='png';mime='image/png';}else if(jpeg(data)){format='jpg';mime='image/jpeg';}}
    if(kind==='sound'){if(wav(data)){format='wav';mime='audio/wav';}else if(ogg(data)){format='ogg';mime='audio/ogg';}else if((data[0]===255&&(data[1]&224)===224)||data.toString('ascii',0,3)==='ID3'){mp3(data);format='mp3';mime='audio/mpeg';}}
    if(kind==='model'&&glb(data)){format='glb';mime='model/gltf-binary';}
  }catch(e){if(e.status)throw e;fail('Invalid media file.');}
  if(!format)fail('Unsupported file format. Use PNG/JPEG, MP3/WAV/Ogg Vorbis or embedded GLB.');
  return {id:crypto.createHash('sha256').update(data).digest('hex'),kind,name:String(name||'My asset').replace(/[\u0000-\u001f<>/\\]/g,'').slice(0,100).trim()||'My asset',format,size:data.length,mime};
}
module.exports={validateAsset,MAX_ASSET,MAX_TEXTURE,MAX_GAME_ASSETS,MAX_USER_ASSETS};
