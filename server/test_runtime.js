// Regression coverage for discovery, startup isolation, HTTP/WS bad input, and graceful restarts.
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const dgram = require('node:dgram');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');
const clientAddress = require('./client_address');
const data = fs.mkdtempSync(path.join(os.tmpdir(),'oblox-runtime-test-'));
const children = [];
let server;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve,ms));
async function unusedUDPPort() {
  const socket = dgram.createSocket('udp4');
  await new Promise((resolve) => socket.bind(0,'127.0.0.1',resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve)); return port;
}
async function launch(env, reusePid = false) {
  const script = path.join(__dirname,'server.js');
  const seed = 'const fs=require("node:fs"),path=require("node:path");const p=path.join(process.env.OBLOX_DATA_DIR,"server.lock");const old=JSON.parse(fs.readFileSync(p,"utf8"));old.pid=process.pid;fs.writeFileSync(p,JSON.stringify(old));require(process.argv[1]);';
  const child = spawn(process.execPath,reusePid ? ['-e',seed,script] : [script],{
    env:{...process.env,PORT:'0',HOST:'127.0.0.1',OBLOX_DATA_DIR:data,OBLOX_DISCOVERY_PORT:'0',...env,DATABASE_URL:'',OBLOX_REQUIRE_DATABASE:'0'},
    stdio:['ignore','pipe','pipe','ipc']
  });
  children.push(child);
  let stdout = '', stderr = '';
  child.stdout.on('data',(c) => stdout += c); child.stderr.on('data',(c) => stderr += c);
  return {child,get stdout(){return stdout;},get stderr(){return stderr;}};
}
async function ready(instance) {
  for (let n=0;n<100;n++) {
    const match = instance.stdout.match(/Oblox server on :(\d+)/);
    if (match) return 'http://127.0.0.1:'+match[1];
    if (instance.child.exitCode !== null) throw new Error(instance.stderr);
    await delay(50);
  }
  throw new Error('Server startup timeout');
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null || !child.connected) return;
  const exit = new Promise((resolve) => child.once('exit',resolve));
  child.send('oblox:shutdown'); await exit;
}
async function discover(port, nonce) {
  const socket = dgram.createSocket('udp4');
  try {
    await new Promise((resolve) => socket.bind(0,'127.0.0.1',resolve));
    const reply = new Promise((resolve,reject) => {
      const timer = setTimeout(() => reject(new Error('Discovery timed out')),2000);
      socket.once('message',(raw,remote) => {clearTimeout(timer);resolve({value:JSON.parse(raw),remote});});
    });
    socket.send(Buffer.from(JSON.stringify({service:'oblox-discover',version:1,nonce})),port,'127.0.0.1');
    return await reply;
  } finally {socket.close();}
}
(async () => {
  try {
    const oldProxy = process.env.TRUST_PROXY_HOPS;
    const request = {socket:{remoteAddress:'127.0.0.1'},headers:{'x-forwarded-for':'203.0.113.99, 198.51.100.7'}};
    delete process.env.TRUST_PROXY_HOPS;
    assert.equal(clientAddress(request),'127.0.0.1','Do not trust forged forwarding headers by default');
    process.env.TRUST_PROXY_HOPS='1';
    assert.equal(clientAddress(request),'198.51.100.7','Use rightmost forwarded address for one explicitly trusted hop');
    assert.equal(clientAddress({...request,headers:{'x-forwarded-for':'spoof, 198.51.100.7'}}),'127.0.0.1');
    process.env.TRUST_PROXY_HOPS='3'; assert.equal(clientAddress(request),'127.0.0.1');
    if (oldProxy === undefined) delete process.env.TRUST_PROXY_HOPS; else process.env.TRUST_PROXY_HOPS=oldProxy;
    const lockDirectory = path.join(data,'same-process-lock-test'); fs.mkdirSync(lockDirectory);
    const lock = require('./store_lock'); const release = lock(lockDirectory);
    assert.throws(() => lock(lockDirectory),/already owns/);
    if (process.platform === 'win32') assert.throws(() => lock(lockDirectory.toUpperCase()),/already owns/);
    release(); fs.rmdirSync(lockDirectory);
    const discoveryPort = await unusedUDPPort();
    server = await launch({OBLOX_DISCOVERY_PORT:String(discoveryPort)});
    const base = await ready(server);
    await delay(80);
    const health = await (await fetch(base+'/api/health')).json();
    assert.equal(health.build,require('./package.json').version); assert.equal(health.version,2);
    const found = await discover(discoveryPort,'test_nonce_123');
    assert.equal(found.value.instance_id,health.instance_id); assert.equal(found.value.port,health.port);
    assert.equal(found.value.nonce,'test_nonce_123'); assert.equal(found.remote.address,'127.0.0.1');
    assert(!JSON.stringify(found.value).includes('token')); assert(!JSON.stringify(found.value).includes('data_dir'));
    // Second process must not become another writer of the same store.
    const duplicate = await launch({});
    await new Promise((resolve) => duplicate.child.once('exit',resolve));
    assert.notEqual(duplicate.child.exitCode,0); assert.match(duplicate.stderr,/already open by server PID/);
    assert.equal((await (await fetch(base+'/api/health')).json()).instance_id,health.instance_id);
    const malformed = await fetch(base+'/api/auth/register',{method:'POST',body:'{broken'});
    assert.equal(malformed.status,400); assert.equal((await malformed.json()).error_code,'invalid_json');
    const oversized = await fetch(base+'/api/auth/register',{method:'POST',body:JSON.stringify({huge:'x'.repeat(2*1024*1024)})});
    assert.equal(oversized.status,413); assert.equal((await oversized.json()).error_code,'payload_too_large');
    // Oversized WebSocket payload used to emit an unhandled error and kill the whole server.
    const ws = new WebSocket(base.replace(/^http/,'ws')+'/ws');
    ws.on('error',() => {});
    await new Promise((resolve) => ws.once('open',resolve));
    const closed = new Promise((resolve) => ws.once('close',resolve));
    ws.send('x'.repeat(10000)); await closed;
    assert.equal((await fetch(base+'/api/health')).status,200);
    await stop(server.child);
    assert(!fs.existsSync(path.join(data,'server.lock')));
    const restarted = await launch({});
    const restartedBase = await ready(restarted);
    assert.equal((await (await fetch(restartedBase+'/api/health')).json()).instance_id,health.instance_id);
    await stop(restarted.child);
    const crash = await launch({});
    await ready(crash);
    const crashed = new Promise((resolve) => crash.child.once('exit',resolve));
    crash.child.kill('SIGKILL'); await crashed;
    assert(fs.existsSync(path.join(data,'server.lock')),'Abrupt termination should leave the old lock');
    // Simulate a container restart which reuses the old process ID (often PID 1).
    const samePidRestart = await launch({},true);
    const samePidBase = await ready(samePidRestart);
    assert.equal((await (await fetch(samePidBase+'/api/health')).json()).instance_id,health.instance_id);
    await stop(samePidRestart.child);
    console.log('RUNTIME PASS: proxy trust defaults, UDP discovery, stable health identity, one writer lock, JSON/size errors, malformed WS isolation, graceful stop/restart, SIGKILL and container PID reuse.');
  } finally {
    for (const child of children) await stop(child);
    fs.rmSync(data,{recursive:true,force:true});
  }
})().catch((error) => {console.error(error);process.exitCode=1;});
