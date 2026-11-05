const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const zlib=require('node:zlib');
function png(width=1,height=1,red=255){
  function crc(data){let n=0xffffffff;for(const byte of data){n^=byte;for(let b=0;b<8;b++)n=(n>>>1)^((n&1)?0xedb88320:0);}return(n^0xffffffff)>>>0;}
  function chunk(type,data){const b=Buffer.alloc(data.length+12);b.writeUInt32BE(data.length);b.write(type,4);data.copy(b,8);b.writeUInt32BE(crc(b.subarray(4,8+data.length)),8+data.length);return b;}
  const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(width);ihdr.writeUInt32BE(height,4);ihdr[8]=8;ihdr[9]=6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',zlib.deflateSync(Buffer.from([0,red,20,30,255]))),chunk('IEND',Buffer.alloc(0))]);
}
function wav(){const b=Buffer.alloc(44+800);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(8000,24);b.writeUInt32LE(16000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(800,40);for(let i=44;i<b.length;i+=2)b.writeInt16LE(Math.round(Math.sin(i/20)*1200),i);return b;}
function packGlb(doc,binary=Buffer.alloc(0)){
  let json=Buffer.from(JSON.stringify(doc));json=Buffer.concat([json,Buffer.alloc((4-json.length%4)%4,32)]);binary=Buffer.concat([binary,Buffer.alloc((4-binary.length%4)%4)]);const b=Buffer.alloc(20+json.length+(binary.length?8+binary.length:0));b.write('glTF');b.writeUInt32LE(2,4);b.writeUInt32LE(b.length,8);b.writeUInt32LE(json.length,12);b.writeUInt32LE(0x4e4f534a,16);json.copy(b,20);if(binary.length){const offset=20+json.length;b.writeUInt32LE(binary.length,offset);b.writeUInt32LE(0x004e4942,offset+4);binary.copy(b,offset+8);}return b;
}
function glb(external=false){
  const vertices=Buffer.alloc(44);[0,0,0,1,0,0,0,1,0].forEach((n,i)=>vertices.writeFloatLE(n,i*4));[0,1,2].forEach((n,i)=>vertices.writeUInt16LE(n,36+i*2));
  const doc={asset:{version:'2.0'},scene:0,scenes:[{nodes:[0]}],nodes:[{mesh:0}],meshes:[{primitives:[{attributes:{POSITION:0},indices:1}]}],buffers:[{byteLength:44,...(external?{uri:'https://example.invalid/secret.bin'}:{})}],bufferViews:[{buffer:0,byteOffset:0,byteLength:36},{buffer:0,byteOffset:36,byteLength:6}],accessors:[{bufferView:0,componentType:5126,count:3,type:'VEC3',min:[0,0,0],max:[1,1,0]},{bufferView:1,componentType:5123,count:3,type:'SCALAR'}]};
  return packGlb(doc,vertices);
}
module.exports.fixtures={png,wav,glb,packGlb};
if(require.main===module)(async()=>{
  const pgUrl=process.env.OBLOX_TEST_DATABASE_URL;
  if(pgUrl&&!/^\/oblox_test[a-z0-9_]*$/i.test(new URL(pgUrl).pathname))throw new Error('Asset integration tests require a disposable oblox_test* database.');
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'oblox-assets-'));let child,base,admin,checks=0;
  async function start(){child=spawn(process.execPath,['--require',path.join(__dirname,'test_pg_metrics.js'),path.join(__dirname,'server.js')],{env:{...process.env,DATABASE_URL:pgUrl||'',OBLOX_REQUIRE_DATABASE:pgUrl?'1':'0',PORT:'0',HOST:'127.0.0.1',OBLOX_DISCOVERY_PORT:'0',OBLOX_DATA_DIR:directory},stdio:['ignore','pipe','pipe','ipc']});let output='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);for(let n=0;n<400;n++){if(child.exitCode!==null)throw new Error('Server startup failed: '+output);const m=output.match(/Oblox server on :(\d+)/);if(m){base='http://127.0.0.1:'+m[1];const r=await fetch(base+'/api/health');if(r.status===200)return;}await new Promise(r=>setTimeout(r,25));}throw new Error('Startup timed out.');}
  let metricId=0;
  function metrics(){const id=++metricId;return new Promise((resolve,reject)=>{const timeout=setTimeout(()=>{child.off('message',receive);reject(new Error('Metrics timeout'));},2000);function receive(m){if(m?.t==='oblox:test:pgMetrics'&&m.id===id){clearTimeout(timeout);child.off('message',receive);resolve(m.metrics);}}child.on('message',receive);child.send({t:'oblox:test:pgMetrics',id});});}
  async function stop(){if(!child||child.exitCode!==null)return;const exit=new Promise(r=>child.once('exit',r));child.send('oblox:shutdown');await exit;}
  async function api(method,route,body,token,status=200){const r=await fetch(base+route,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});const data=await r.json();assert.equal(r.status,status,route+' '+JSON.stringify(data));checks++;return data;}
  async function upload(bytes,kind,token,status=200){const r=await fetch(base+'/api/assets?kind='+kind+'&name='+encodeURIComponent('Мой ресурс'),{method:'POST',headers:{'Content-Type':'application/octet-stream',...(token?{Authorization:'Bearer '+token}:{})},body:bytes});const result=await r.json();assert.equal(r.status,status,JSON.stringify(result));checks++;return result.asset;}
  async function download(id,token,status=200,etag){const r=await fetch(base+'/api/assets/'+id,{headers:{...(token?{Authorization:'Bearer '+token}:{}),...(etag?{'If-None-Match':etag}:{})}});assert.equal(r.status,status);checks++;return{bytes:Buffer.from(await r.arrayBuffer()),etag:r.headers.get('etag')};}
  try{
    if(pgUrl){const{Client}=require('pg');admin=new Client({connectionString:pgUrl});await admin.connect();await admin.query('DROP TABLE IF EXISTS oblox_game_assets,oblox_asset_owners,oblox_assets,oblox_game_payloads,oblox_community CASCADE');}
    await start();const a=await api('POST','/api/auth/register',{username:'AssetAuthor',password:'StrongFixturePassword'});const b=await api('POST','/api/auth/register',{username:'AssetVisitor',password:'StrongFixturePassword'});
    await upload(png(),'texture',undefined,401);await upload(Buffer.from('extends Node'),'model',a.token,400);await upload(glb(true),'model',a.token,400);await upload(png(4096,1),'texture',a.token,400);await upload(Buffer.alloc(8*1024*1024+1),'sound',a.token,413);
    const malformedModels=[
      packGlb({asset:{version:'2.0'},nodes:[{children:[0]}]}),
      packGlb({asset:{version:'2.0'},nodes:Array.from({length:33},(_,n)=>n===32?{}:{children:[n+1]})}),
      packGlb({asset:{version:'2.0'},nodes:[{children:[99]}]}),
      packGlb({asset:{version:'2.0'},nodes:{bad:'array'}}),
      packGlb({asset:{version:'2.0'},buffers:[{byteLength:4}],bufferViews:[{buffer:0,byteOffset:3,byteLength:4}]},Buffer.alloc(4)),
      packGlb({asset:{version:'2.0'},accessors:[{componentType:5126,type:'VEC3',count:600001}]}),
      packGlb({asset:{version:'2.0'},buffers:[{byteLength:png(16384,16384).length}],bufferViews:[{buffer:0,byteLength:png(16384,16384).length}],images:[{bufferView:0,mimeType:'image/png'}]},png(16384,16384)),
      packGlb({asset:{version:'2.0'},accessors:[{componentType:5126,type:'VEC3',count:400000}],meshes:[{primitives:[{attributes:{POSITION:0}},{attributes:{POSITION:0}}]}]}),
    ];
    for(const bytes of malformedModels)await upload(bytes,'model',a.token,400);
    const image=await upload(png(),'texture',a.token),sound=await upload(wav(),'sound',a.token),model=await upload(glb(),'model',a.token);assert.equal((await upload(png(),'texture',a.token)).id,image.id);checks++;
    assert.equal(image.id,crypto.createHash('sha256').update(png()).digest('hex'));await download(image.id,undefined,404);await download(image.id,b.token,404);assert((await download(image.id,a.token)).bytes.equals(png()));
    const unknown='f'.repeat(64);
    await api('POST','/api/games',{creation:{title:'Missing asset',parts:[{t:'spawn'},{t:'model',model_asset:unknown}]}},a.token,400);assert(!(await api('GET','/api/games')).games.some(g=>g.title==='Missing asset'));
    const world={schema_version:2,title:'Complete uploaded world',values:{Score:0,Caption:'Привет',Enabled:true},parts:[{t:'spawn',name:'Spawn'},{t:'model',name:'Uploaded model',model_asset:model.id,texture_asset:image.id,events:[{on:'interact',do:[{a:'set_value',key:'Score',value:5},{a:'if_value',key:'Score',op:'gte',value:5,do:[{a:'repeat',n:2,do:[{a:'play_asset',sound_asset:sound.id},{a:'set_text',ui:'Title',text:'Score: {Score}'},{a:'wait',n:0.1}]}],else:[{a:'destroy'}]}]},{on:'value_changed',key:'Score',do:[{a:'set_texture',texture_asset:image.id}]}]},{t:'door',name:'Door',events:[{on:'signal',key:'Open',do:[{a:'set_collision',collide:false},{a:'set_visible',visible:false},{a:'set_position',xyz:[0,5,0]},{a:'rotate',xyz:[0,90,0]}]}]},{t:'conveyor',name:'Conveyor',speed:4}],ui:[{k:'text',id:'Title',text:'Score'}],music_asset:sound.id,thumbnail_asset:image.id,assets:[{id:unknown,local_path:'C:/private/file.glb'}]};
    const published=await api('POST','/api/games',{creation:world},a.token);const gameId=published.game.id;assert.equal(published.creation.assets.length,3);assert(!JSON.stringify(published.creation).includes('private'));assert.equal(published.game.thumbnail_asset,image.id);assert.deepEqual(published.creation.values,world.values);
    const fetched=await api('GET','/api/games/'+gameId);assert.equal(fetched.creation.parts[1].events[0].do[1].do[0].do[0].sound_asset,sound.id);assert.equal(fetched.creation.parts[3].speed,4);
    for(const asset of[image,sound,model]){const result=await download(asset.id);assert.equal(crypto.createHash('sha256').update(result.bytes).digest('hex'),asset.id);await download(asset.id,undefined,304,result.etag);}
    if(admin){const before=await metrics();for(let n=0;n<10;n++){await api('POST','/api/presence',{},a.token);await api('GET','/api/friends',undefined,a.token);}const after=await metrics();assert.equal(after.assetBlobReads,before.assetBlobReads);assert.equal(after.coreReads,before.coreReads);assert.equal(after.payloadReads,before.payloadReads);assert(after.rowBytes-before.rowBytes<2048);checks+=4;}
    for(const bad of [
      {...world,values:{Bad:[]}},
      {...world,values:{'bad key':0}},
      {...world,parts:[{t:'spawn'},{t:'block',texture_asset:sound.id}]},
      {...world,parts:[{t:'spawn',events:[{on:'touch',do:[{a:'run_script',text:'print(1)'}]}]}]},
      {...world,parts:[{t:'spawn',events:[{on:'timer',every:0,do:[]}]}]},
      {...world,parts:[{t:'spawn',events:[{on:'touch',do:[{a:'repeat',n:101,do:[]}]}]}]},
      {...world,parts:[{t:'spawn',events:[{on:'touch',do:[{a:'wait',n:61}]}]}]},
      {...world,parts:[{t:'spawn',events:[{on:'signal',key:'bad key',do:[]}]}]},
    ])await api('POST','/api/games',{creation:bad},a.token,400);
    // Missing-asset update must leave the previous world and revision intact.
    await api('POST','/api/games',{creation:{...world,published_id:gameId,thumbnail_asset:unknown}},a.token,400);assert.equal((await api('GET','/api/games/'+gameId)).game.revision,1);
    if(admin){assert.equal(Number((await admin.query('SELECT count(*) FROM oblox_assets')).rows[0].count),3);const core=(await admin.query('SELECT state FROM oblox_community')).rows[0].state;assert(!JSON.stringify(core).includes('model_asset'));assert(!JSON.stringify(core).includes('values'));checks+=3;}
    if(admin){
      const privateImage=await upload(png(1,1,80),'texture',a.token);
      await admin.query("CREATE OR REPLACE FUNCTION oblox_test_asset_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'simulated asset commit failure'; END $$");
      await admin.query('CREATE CONSTRAINT TRIGGER oblox_test_asset_failure AFTER UPDATE ON oblox_game_payloads DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION oblox_test_asset_failure()');
      await api('POST','/api/games',{creation:{...world,published_id:gameId,thumbnail_asset:privateImage.id}},a.token,503);
      await admin.query('DROP TRIGGER oblox_test_asset_failure ON oblox_game_payloads');
      await admin.query('DROP FUNCTION oblox_test_asset_failure()');
      assert.equal((await api('GET','/api/games/'+gameId)).creation.thumbnail_asset,image.id);
      await download(privateImage.id,undefined,404);checks++;
    }
    await stop();await start();assert.equal((await api('GET','/api/auth/me',undefined,a.token)).user.id,a.user.id);assert.equal((await api('GET','/api/games/'+gameId)).creation.assets.length,3);assert((await download(model.id)).bytes.equals(glb()));
    const copied=await api('POST','/api/games',{creation:{title:'Public asset reuse',parts:[{t:'spawn'},{t:'block',texture_asset:image.id}]}},b.token);
    await api('DELETE','/api/games/'+gameId,undefined,a.token);await download(model.id,undefined,404);await download(image.id);await api('DELETE','/api/games/'+copied.game.id,undefined,b.token);await download(image.id,undefined,404);await download(image.id,a.token);
    console.log('ASSETS '+(pgUrl?'POSTGRES':'JSON')+' PASS '+checks+' checks: format/sizes/private ownership/dedup/canonical complete publication/recursive code/restart/rollback/public reuse/cache.');
  }finally{await stop();if(admin)await admin.end();const resolved=path.resolve(directory);if(path.dirname(resolved)===path.resolve(os.tmpdir())&&path.basename(resolved).startsWith('oblox-assets-'))fs.rmSync(resolved,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
