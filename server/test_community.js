// Self-contained account, friendship, publishing, persistence, and legacy-protocol integration test.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'oblox-community-test-'));
let processServer;
let base;
const sockets = [];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function start() {
  processServer = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: {...process.env, PORT: '0', HOST: '127.0.0.1', OBLOX_DISCOVERY_PORT:'0', OBLOX_DATA_DIR: directory}, stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });
  await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Server startup timeout: ' + output)), 5000);
    processServer.on('exit', (code) => {clearTimeout(timer); reject(new Error('Server exited ' + code + ': ' + output));});
    processServer.stderr.on('data', (chunk) => {output += chunk;});
    processServer.stdout.on('data', (chunk) => {
      output += chunk;
      const match = output.match(/Oblox server on :(\d+)/);
      if (match) { base = 'http://127.0.0.1:' + match[1]; clearTimeout(timer); resolve(); }
    });
  });
}
async function stop() {
  for (const ws of sockets.splice(0)) ws.terminate();
  if (processServer && processServer.exitCode === null) {
    const done = new Promise((resolve) => processServer.once('exit', resolve));
    processServer.send('oblox:shutdown'); await done;
  }
}
async function api(method, route, payload, token, status = 200) {
  const response = await fetch(base + route, {method,
    headers: {'Content-Type': 'application/json', ...(token ? {Authorization: 'Bearer ' + token} : {})},
    ...(payload !== undefined ? {body: JSON.stringify(payload)} : {})});
  const body = await response.json();
  assert.equal(response.status, status, route + ' ' + JSON.stringify(body));
  return body;
}
async function wsClient(hello, expect = 'welcome') {
  const ws = new WebSocket(base.replace(/^http/, 'ws') + '/ws'); sockets.push(ws);
  const message = await new Promise((resolve,reject) => {
    const timer = setTimeout(() => reject(new Error('WS timeout')), 3000);
    ws.once('error',reject);
    ws.on('open',() => ws.send(JSON.stringify({t:'hello',world:'neon_obby',name:'Impersonated',...hello})));
    ws.once('message',(data) => {clearTimeout(timer); resolve(JSON.parse(data));});
  });
  assert.equal(message.t,expect,JSON.stringify(message));
  return {ws,message};
}
(async () => {
  try {
    await start();
    const health = await api('GET','/api/health');
    assert.equal(health.service,'oblox-community'); assert.equal(health.version,2); assert.match(health.instance_id,/^[a-f0-9]{24}$/);
    const a = await api('POST','/api/auth/register',{username:'AliceReal',password:'Alice-test-password'});
    const b = await api('POST','/api/auth/register',{username:'BobReal',password:'Bob-test-password'});
    const c = await api('POST','/api/auth/register',{username:'ClaraReal',password:'Clara-test-password'});
    assert.equal((await api('POST','/api/auth/register',{username:'alicereal',password:'another-password'},null,409)).error_code,'username_taken');
    assert.equal((await api('POST','/api/auth/login',{username:'AliceReal',password:'wrong-password'},null,401)).error_code,'invalid_credentials');
    assert.equal((await api('POST','/api/auth/register',{username:'Тест',password:'long-password'},null,400)).error_code,'invalid_fields');
    const login = await api('POST','/api/auth/login',{username:'ALICEREAL',password:'Alice-test-password'});
    assert.equal(login.user.id,a.user.id);
    assert.equal((await api('GET','/api/auth/me',undefined,a.token)).user.username,'AliceReal');
    await api('GET','/api/auth/me',undefined,'bad-token',401);
    const users = (await api('GET','/api/users?q=bOb',undefined,a.token)).users;
    assert.equal(users[0].id,b.user.id); assert(!JSON.stringify(users).includes('password'));
    await api('POST','/api/friends/requests',{user_id:b.user.id},a.token);
    await api('POST','/api/friends/requests',{user_id:b.user.id},a.token); // idempotent
    await api('POST','/api/friends/requests',{user_id:'__proto__'},a.token,404);
    assert.equal((await api('GET','/api/friends',undefined,b.token)).incoming[0].id,a.user.id);
    await api('POST','/api/friends/requests/'+a.user.id+'/accept',{},c.token,404);
    await api('POST','/api/friends/requests/'+a.user.id+'/accept',{},b.token);
    assert.equal((await api('GET','/api/friends',undefined,a.token)).friends[0].id,b.user.id);
    assert.equal((await api('GET','/api/friends',undefined,b.token)).friends[0].id,a.user.id);
    const authSocket = await wsClient({token:a.token,name:'ForgedName'});
    const observer = await wsClient({name:'Observer'});
    assert.equal(observer.message.players.find((p) => p.user_id === a.user.id).name,'AliceReal');
    let friend = (await api('GET','/api/friends',undefined,b.token)).friends[0];
    assert.equal(friend.status,'ingame'); assert.equal(friend.world,'neon_obby'); assert.equal(friend.server,1);
    const impersonator = await wsClient({name:'AliceReal'});
    const observer2 = await wsClient({name:'ObserverTwo'});
    assert(observer2.message.players.some((p) => p.name === 'Guest_AliceReal' && !p.user_id));
    await wsClient({token:'0'.repeat(64)},'error');
    for (const ws of sockets.splice(0)) ws.terminate();
    const creation = {id:'local-world',title:'Published test world',sky:'day',music:'isles',folders:['Start'],
      parts:[{t:'block',name:'Base',p:[0,-.5,0],s:[20,1,20],c:'6cc04a'}, {t:'spawn',name:'Spawn',p:[0,0,0]},
        {t:'sign',name:'Welcome',p:[2,0,0],text:'Welcome!',events:[{on:'start',do:[{a:'message',text:'Hello'}]}]}],
      ui:[{id:'Counter',k:'coins',x:40,y:800,w:200,h:56,text:'{coins}',color:'ffffff',bg:'00000099',click:[]}]};
    await api('POST','/api/games',{creation},undefined,401);
    const published = await api('POST','/api/games',{creation},a.token);
    const gameId = published.game.id;
    assert.equal(published.creation.parts.length,3); assert.equal(published.creation.published_id,gameId);
    const gameSocket = await wsClient({world:'creation:'+gameId,token:a.token});
    assert.equal(gameSocket.message.world,'creation:'+gameId);
    await wsClient({world:'creation:__proto__'},'error');
    await wsClient({world:'creation:'+'f'.repeat(24)},'error');
    for (const ws of sockets.splice(0)) ws.terminate();
    assert.equal((await api('GET','/api/games')).games[0].id,gameId);
    const downloaded = await api('GET','/api/games/'+gameId);
    assert.equal(downloaded.creation.ui[0].k,'coins'); assert.equal(downloaded.game.creator,'AliceReal');
    const updated = await api('POST','/api/games',{creation:{...creation,published_id:gameId,title:'Revision two'}},a.token);
    assert.equal(updated.game.revision,2);
    await api('POST','/api/games',{creation:{...creation,published_id:gameId}},b.token,403);
    await api('DELETE','/api/games/'+gameId,undefined,b.token,403);
    await api('POST','/api/games',{creation:{...creation,parts:[{t:'spawn',p:[0,0,0]},{t:'not-a-part'}]}},a.token,400);
    await api('POST','/api/games',{creation:{...creation,parts:[{t:'spawn',p:[0,0,0],s:[0,2,3]}]}},a.token,400);
    await api('POST','/api/games',{creation:{...creation,parts:[{t:'spawn',p:[0,0,0],events:[{on:'start',do:[{a:'execute_script'}]}]}]}},a.token,400);
    const raw = fs.readFileSync(path.join(directory,'community.json'),'utf8');
    assert(!raw.includes('Alice-test-password')); assert(!raw.includes(a.token));
    await stop(); await start();
    assert.equal((await api('GET','/api/health')).instance_id,health.instance_id);
    assert.equal((await api('GET','/api/auth/me',undefined,a.token)).user.id,a.user.id);
    assert.equal((await api('GET','/api/friends',undefined,a.token)).friends[0].id,b.user.id);
    assert.equal((await api('GET','/api/games/'+gameId)).game.title,'Revision two');
    await api('DELETE','/api/friends/'+a.user.id,undefined,b.token);
    assert.equal((await api('GET','/api/friends',undefined,a.token)).friends.length,0);
    await api('POST','/api/friends/requests',{user_id:b.user.id},a.token);
    await api('DELETE','/api/friends/'+a.user.id,undefined,b.token);
    assert.equal((await api('GET','/api/friends',undefined,a.token)).outgoing.length,0);
    await api('DELETE','/api/games/'+gameId,undefined,a.token);
    await api('GET','/api/games/'+gameId,undefined,null,404);
    await api('POST','/api/auth/logout',{},a.token);
    await api('GET','/api/auth/me',undefined,a.token,401);
    console.log('COMMUNITY PASS: auth, friends, identity/presence, publish/download/revision, ownership, validation, restart persistence, delete/logout.');
    const legacy = spawn(process.execPath,[path.join(__dirname,'test_client.js'),base],{stdio:'inherit'});
    const code = await new Promise((resolve) => legacy.once('exit',resolve));
    assert.equal(code,0,'Legacy room/chat/payment regression');
    console.log('ALL BACKEND TESTS PASS');
  } finally {
    await stop();
    fs.rmSync(directory,{recursive:true,force:true});
  }
})().catch((error) => {console.error(error);process.exitCode=1;});
