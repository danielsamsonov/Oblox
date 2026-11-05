// Destructive integration test: point ONLY at a dedicated oblox_test* database.
// Covers two live server processes, lost-write races and a failure at COMMIT.
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const path = require('node:path');
const {Client} = require('pg');
const WebSocket = require('ws');
const url = process.env.OBLOX_TEST_DATABASE_URL;
if (!url || !/^\/oblox_test[a-z0-9_]*$/i.test(new URL(url).pathname)) {
  console.error('Set OBLOX_TEST_DATABASE_URL to a disposable database named oblox_test*.');
  process.exit(1);
}
const children = [], sockets = [];
let admin;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve,ms));
async function start() {
  const child = spawn(process.execPath,['--require',path.join(__dirname,'test_pg_metrics.js'),path.join(__dirname,'server.js')],{
    env:{...process.env,DATABASE_URL:url,OBLOX_REQUIRE_DATABASE:'1',PORT:'0',HOST:'127.0.0.1',OBLOX_DISCOVERY_PORT:'0'},
    stdio:['ignore','pipe','pipe','ipc']
  });
  children.push(child);
  let output = '';
  child.stdout.on('data',(data) => {output += data;});
  child.stderr.on('data',(data) => {output += data;});
  let base;
  for (let n=0;n<400;n++) {
    if (child.exitCode !== null) throw new Error('Server exited: '+output);
    const match = output.match(/Oblox server on :(\d+)/);
    if (match) {
      base = 'http://127.0.0.1:'+match[1];
      const response = await fetch(base+'/api/health');
      if (response.status === 200) return {child,base,health:await response.json()};
    }
    await sleep(50);
  }
  throw new Error('Server startup timed out: '+output);
}
async function stop(child) {
  if (child.exitCode !== null || !child.connected) return;
  const exit = new Promise((resolve) => child.once('exit',resolve));
  child.send('oblox:shutdown'); await exit;
}
let metricsId = 0;
function metrics(child) {
  const id = ++metricsId;
  return new Promise((resolve,reject) => {
    const timer = setTimeout(() => {child.off('message',receive);reject(new Error('Query metrics IPC timeout'));},2000);
    function receive(message) {
      if (message && message.t === 'oblox:test:pgMetrics' && message.id === id) {
        clearTimeout(timer);child.off('message',receive);resolve(message.metrics);
      }
    }
    child.on('message',receive);child.send({t:'oblox:test:pgMetrics',id});
  });
}
async function api(base,method,route,body,token) {
  const response = await fetch(base+route,{method,
    headers:{'Content-Type':'application/json',...(token ? {Authorization:'Bearer '+token} : {})},
    ...(body === undefined ? {} : {body:JSON.stringify(body)})});
  return {status:response.status,...await response.json()};
}
async function ws(base,hello) {
  const socket = new WebSocket(base.replace(/^http/,'ws')+'/ws'); sockets.push(socket);
  return new Promise((resolve,reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket hello timeout')),5000);
    socket.once('error',reject);
    socket.once('open',() => socket.send(JSON.stringify({t:'hello',name:'GuestTest',world:'neon_obby',...hello})));
    socket.once('message',(raw) => {clearTimeout(timer);resolve(JSON.parse(raw));});
  });
}
const creation = (title) => ({title,parts:[{t:'spawn',name:'Spawn',p:[0,0,0]}]});
(async () => {
  try {
    admin = new Client({connectionString:url}); await admin.connect();
    await admin.query('DROP TABLE IF EXISTS oblox_community CASCADE');
    await admin.query('DROP TABLE IF EXISTS oblox_game_payloads CASCADE');
    const [one,two] = await Promise.all([start(),start()]);
    assert.equal(one.health.storage,'postgres');
    assert.equal(one.health.instance_id,two.health.instance_id,'Concurrent first starts share one durable identity');
    const register = (base,username) => api(base,'POST','/api/auth/register',{username,password:'postgres-test-password'});
    const duplicate = await Promise.all([register(one.base,'AlicePG'),register(two.base,'alicepg')]);
    assert.deepEqual(duplicate.map((r) => r.status).sort(),[200,409],'Case-insensitive registration race has one winner');
    const alice = duplicate.find((r) => r.status === 200);
    const bob = await register(two.base,'BobPG'); assert.equal(bob.status,200);
    assert.equal((await api(two.base,'GET','/api/auth/me',undefined,alice.token)).user.id,alice.user.id);
    assert.equal((await api(one.base,'POST','/api/friends/requests',{user_id:bob.user.id},alice.token)).status,200);
    assert.equal((await api(two.base,'POST','/api/friends/requests/'+alice.user.id+'/accept',{},bob.token)).status,200);
    assert.equal((await api(one.base,'GET','/api/friends',undefined,alice.token)).friends[0].id,bob.user.id);
    const large = creation('First durable world');
    large.parts.push(...Array.from({length:900},(_,i) => ({t:'sign',name:'Sign'+i,p:[i,0,0],text:'x'.repeat(300)})));
    large.ui = [{k:'text',id:'Greeting',text:'Published UI',x:0,y:0,w:200,h:50}];
    const [first,second] = await Promise.all([
      api(one.base,'POST','/api/games',{creation:large},alice.token),
      api(two.base,'POST','/api/games',{creation:creation('Second durable world')},alice.token)
    ]);
    assert.equal(first.status,200); assert.equal(second.status,200);
    assert.equal((await api(two.base,'GET','/api/games')).games.length,2,'Concurrent publications both survive');
    const gameId = first.game.id;
    const separated = (await admin.query("SELECT state->'games'->$1->'creation' AS metadata FROM oblox_community",[gameId])).rows[0].metadata;
    assert.equal(separated.parts,undefined,'Geometry is excluded from the frequently-read core snapshot');
    assert.equal(separated.ui,undefined,'Published UI is excluded from the frequently-read core snapshot');
    assert.equal((await admin.query('SELECT count(*)::int AS count FROM oblox_game_payloads')).rows[0].count,2);
    const downloaded = (await api(two.base,'GET','/api/games/'+gameId)).creation;
    assert.equal(downloaded.parts.length,901,'Geometry loads on explicit game download');
    assert.equal(downloaded.ui[0].text,'Published UI');
    await api(one.base,'GET','/api/friends',undefined,alice.token); // refresh another process's latest core revision
    const before = await metrics(one.child);
    for (let i=0;i<10;i++) {
      assert.equal((await api(one.base,'POST','/api/presence',{},alice.token)).status,200);
      assert.equal((await api(one.base,'GET','/api/friends',undefined,alice.token)).status,200);
    }
    const after = await metrics(one.child);
    assert.equal(after.coreReads,before.coreReads,'Heartbeat reads reuse the revision cache');
    assert.equal(after.payloadReads,before.payloadReads,'Heartbeat reads never download map geometry');
    assert.equal(after.revisionReads-before.revisionReads,20);
    assert(after.rowBytes-before.rowBytes < 2048,'20 heartbeat API requests consume less than 2KiB of database rows');
    const revisions = await Promise.all([one,two].map((server,i) => api(server.base,'POST','/api/games',{
      creation:{...creation('Revision '+i),published_id:gameId}
    },alice.token)));
    assert.deepEqual(revisions.map((r) => r.game.revision).sort(),[2,3]);
    assert.equal((await ws(two.base,{token:alice.token,world:'creation:'+gameId})).t,'welcome');
    assert.equal((await ws(two.base,{name:alice.user.username})).t,'welcome');
    // Failure is raised by a deferred constraint trigger during COMMIT, after
    // UPDATE has succeeded. An early HTTP success would make this test fail.
    await admin.query(`CREATE FUNCTION oblox_test_fail_commit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS (SELECT 1 FROM jsonb_each(NEW.state->'users') u WHERE u.value->>'username'='FailCommit') THEN
          RAISE EXCEPTION 'injected commit failure';
        END IF;
        RETURN NEW;
      END $$`);
    await admin.query('CREATE CONSTRAINT TRIGGER oblox_test_commit_failure AFTER UPDATE ON oblox_community DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION oblox_test_fail_commit()');
    const failed = await register(one.base,'FailCommit');
    assert.equal(failed.status,503); assert.equal(failed.error_code,'storage_error');
    const persisted = (await admin.query("SELECT EXISTS(SELECT 1 FROM oblox_community, jsonb_each(state->'users') u WHERE u.value->>'username'='FailCommit') AS present")).rows[0];
    assert.equal(persisted.present,false,'Failed COMMIT leaves no registered account');
    await admin.query('DROP TRIGGER oblox_test_commit_failure ON oblox_community');
    await admin.query('DROP FUNCTION oblox_test_fail_commit()');
    assert.equal((await fetch(one.base+'/api/health')).status,200,'Health can recover on demand without a periodic DB keepalive');
    assert.equal((await api(two.base,'POST','/api/auth/login',{username:'FailCommit',password:'postgres-test-password'})).status,401);
    await api(one.base,'POST','/api/auth/logout',{},alice.token);
    assert.equal((await ws(two.base,{token:alice.token})).t,'error','Another process observes session revocation at hello');
    await stop(one.child); await stop(two.child);
    const three = await start();
    assert.equal(three.health.instance_id,one.health.instance_id);
    const login = await api(three.base,'POST','/api/auth/login',{username:alice.user.username,password:'postgres-test-password'});
    assert.equal(login.status,200); assert.equal(login.user.id,alice.user.id);
    assert.equal((await api(three.base,'GET','/api/games')).games.find((g) => g.id === gameId).revision,3);
    assert.equal((await api(three.base,'GET','/api/friends',undefined,login.token)).friends[0].id,bob.user.id);
    console.log('POSTGRES PASS: concurrent startup/username/publish/revision, shared friends/sessions, WebSocket refresh, deferred COMMIT failure rollback, on-demand health recovery and process restart persistence.');
  } catch (error) {console.error(error.stack);process.exitCode = 1;}
  finally {
    for (const socket of sockets) socket.terminate();
    await Promise.all(children.map(stop));
    if (admin) {
      await admin.query('DROP TABLE IF EXISTS oblox_community CASCADE').catch(() => {});
      await admin.query('DROP TABLE IF EXISTS oblox_game_payloads CASCADE').catch(() => {});
      await admin.query('DROP FUNCTION IF EXISTS oblox_test_fail_commit()').catch(() => {});
      await admin.end();
    }
  }
})();
