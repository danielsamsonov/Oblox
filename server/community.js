// Accounts, friends and published worlds use atomic JSON locally or PostgreSQL in the cloud.
const crypto = require('crypto');
const readBody = require('./http_body');
const clientAddress = require('./client_address');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);
const NAME_RE = /^[A-Za-z0-9_]{3,20}$/;
const ID_RE = /^[a-f0-9]{24}$/;
const TOKEN_RE = /^[a-f0-9]{64}$/;
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const {validateWorld,collectReferences}=require('./world_validation');
const {validateAsset,MAX_ASSET}=require('./asset_validation');
const readBinary=require('./binary_body');
const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');
const id = () => crypto.randomBytes(12).toString('hex');
const text = (s, limit = 100) => String(s == null ? '' : s).replace(/[\u0000-\u001f<>]/g, '').slice(0, limit).trim();
const pair = (a, b) => [a, b].sort().join(':');
function fail(message, status = 400, code) {
  const e = new Error(message); e.status = status;
  e.code = code || ({401:'session_expired',403:'forbidden',404:'not_found',409:'conflict',429:'rate_limited',413:'payload_too_large'}[status] || 'validation_failed');
  throw e;
}
function object(v) { return v && typeof v === 'object' && !Array.isArray(v); }

module.exports = function createCommunity({ clients }) {
  const store = require('./community_store')();
  let db, dirty = false, instanceId = '';
  const ready = store.ready.then((state) => { instanceId = state.instance_id; });
  const presence = new Map();
  const rateLimits = new Map();
  function save() { dirty = true; }
  function rate(key, limit, windowMs = 60000) {
    const now = Date.now();
    let r = rateLimits.get(key);
    if (!r || now >= r.until) { r = {count: 0, until: now + windowMs}; rateLimits.set(key, r); }
    if (++r.count > limit) fail('Too many requests. Please try again later.', 429);
    if (rateLimits.size > 10000) for (const [k, v] of rateLimits) if (v.until < now) rateLimits.delete(k);
  }
  function tokenOf(req) { return String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''); }
  function authenticate(token, touch = true) {
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
    const session = db.sessions[hash(token)];
    if (!session || session.expires_at <= Date.now()) return null;
    const user = db.users[session.user_id];
    if (user && touch) presence.set(user.id, Date.now());
    return user || null;
  }
  function requireUser(req) {
    const u = authenticate(tokenOf(req));
    if (!u) fail('Sign in to your server account first.', 401);
    return u;
  }
  function publicUser(user, viewer) {
    let socket = null;
    for (const c of clients()) if (c.readyState === 1 && c.user_id === user.id && c.id) socket = c;
    const online = !!socket || Date.now() - (presence.get(user.id) || 0) < 70000;
    const relation = !viewer ? '' : (db.friends.includes(pair(viewer.id, user.id)) ? 'friend'
      : db.requests.some((r) => r.from === viewer.id && r.to === user.id) ? 'outgoing'
      : db.requests.some((r) => r.to === viewer.id && r.from === user.id) ? 'incoming' : '');
    return {id: user.id, username: user.username, name: user.username, seed: parseInt(user.id.slice(0, 6), 16) % 997,
      status: socket ? 'ingame' : online ? 'online' : 'offline', online,
      world: socket ? socket.world : '', server: socket ? socket.server : 0, relation};
  }
  function metadata(game) {
    const creator = db.users[game.author_id];
    let playing = 0;
    for (const c of clients()) if (c.readyState === 1 && c.world === 'creation:' + game.id) playing++;
    return {id: game.id, title: game.creation.title, desc: game.creation.desc, description: game.creation.desc,
      author: creator ? creator.username : 'Creator', creator: creator ? creator.username : 'Creator', author_id: game.author_id,
      revision: game.revision, published_at: game.published_at, updated_at: game.updated_at,
      genre: game.creation.genre, category: game.creation.genre, world: 'creation', published: true,
      code: 'U' + game.id.slice(0,7).toUpperCase(), rating: 0, playing, thumbnail_asset:game.creation.thumbnail_asset || '', part_count: game.part_count === undefined ? game.creation.parts.length : game.part_count};
  }
  function friendLists(user) {
    const friendIds = db.friends.filter((p) => p.split(':').includes(user.id)).map((p) => p.split(':').find((a) => a !== user.id));
    return {friends: friendIds.map((i) => publicUser(db.users[i], user)),
      incoming: db.requests.filter((r) => r.to === user.id).map((r) => publicUser(db.users[r.from], user)),
      outgoing: db.requests.filter((r) => r.from === user.id).map((r) => publicUser(db.users[r.to], user))};
  }
  async function body(req) {
    if (req.communityBody !== undefined) return req.communityBody;
    const raw = await readBody(req);
    let value;
    try { value = JSON.parse(raw || '{}'); } catch { fail('Invalid JSON.', 400, 'invalid_json'); }
    if (!object(value)) fail('Expected a JSON object.', 400, 'invalid_fields');
    return value;
  }
  function send(res, status, value) {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS', 'X-Content-Type-Options': 'nosniff'});
    res.end(JSON.stringify(value));
  }
  function session(user) {
    const token = crypto.randomBytes(32).toString('hex');
    const existing = Object.entries(db.sessions).filter(([,s]) => s.user_id === user.id).sort((a,b) => a[1].expires_at - b[1].expires_at);
    while (existing.length >= 10) delete db.sessions[existing.shift()[0]];
    for (const [h, s] of Object.entries(db.sessions)) if (s.expires_at < Date.now()) delete db.sessions[h];
    db.sessions[hash(token)] = {user_id: user.id, expires_at: Date.now() + SESSION_MS};
    presence.set(user.id, Date.now());
    save();
    return {token, user: publicUser(user, user), expires_at: Date.now() + SESSION_MS};
  }
  async function dispatch(req, res, url, transaction, afterCommit) {
    const route = url.pathname;
    if (!/^\/api\/(auth|users|friends|games|presence|assets)(\/|$)/.test(route)) return false;
    try {
      if (req.method === 'OPTIONS') { send(res, 200, {}); return true; }
      const remote = clientAddress(req);
      rate('http:' + remote, 300);
      let match;
      if(req.method==='POST'&&route==='/api/assets'){
        const user=requireUser(req);rate('upload:'+user.id,120);
        const asset=validateAsset(req.assetBody,url.searchParams.get('kind'),url.searchParams.get('name'));
        const stored=await transaction.putAsset(user.id,asset,req.assetBody);send(res,200,{asset:stored});return true;
      }
      match=route.match(/^\/api\/assets\/([a-f0-9]{64})$/);
      if(match&&(req.method==='GET'||req.method==='HEAD')){
        const viewer=authenticate(tokenOf(req),false);
        const asset=await transaction.getAsset(match[1],viewer?.id,false);
        const headers={'Content-Type':asset.mime,'Content-Length':String(asset.size),'ETag':'"'+asset.id+'"','Cache-Control':'private, max-age=31536000, immutable','X-Content-Type-Options':'nosniff','Access-Control-Allow-Origin':'*','Access-Control-Expose-Headers':'ETag, Content-Length'};
        if(req.headers['if-none-match']===headers.ETag){delete headers['Content-Length'];res.writeHead(304,headers);res.end();return true;}
        if(req.method==='HEAD'){res.writeHead(200,headers);res.end();return true;}
        const content=await transaction.getAsset(match[1],viewer?.id,true);res.writeHead(200,headers);res.end(content.data);return true;
      }
      if (req.method === 'POST' && ['/api/auth/register', '/api/auth/login'].includes(route)) {
        rate('auth:' + remote, 20);
        const d = await body(req);
        if (typeof d.username !== 'string' || !NAME_RE.test(d.username) || typeof d.password !== 'string' || d.password.length < 8 || d.password.length > 128) {
          fail('Use a username with 3–20 letters, digits or underscores and a password with 8–128 characters.',400,'invalid_fields');
        }
        let user = Object.values(db.users).find((u) => u.username.toLowerCase() === d.username.toLowerCase());
        if (route.endsWith('/register')) {
          rate('register:' + remote, 50, 86400000);
          if (user) fail('That username is already registered.', 409, 'username_taken');
          const salt = crypto.randomBytes(16).toString('hex');
          const key = await scrypt(d.password, salt, 64);
          if (Object.values(db.users).some((u) => u.username.toLowerCase() === d.username.toLowerCase())) fail('That username is already registered.', 409, 'username_taken');
          user = {id: id(), username: d.username, salt, password_hash: key.toString('hex'), created_at: Date.now()};
          db.users[user.id] = user;
        } else {
          const key = await scrypt(d.password, user ? user.salt : 'oblox-invalid-user', 64);
          if (!user || !crypto.timingSafeEqual(key, Buffer.from(user.password_hash, 'hex'))) fail('Incorrect username or password.', 401, 'invalid_credentials');
        }
        send(res, 200, session(user)); return true;
      }
      if (req.method === 'GET' && route === '/api/auth/me') { const user = requireUser(req); send(res, 200, {user: publicUser(user,user)}); return true; }
      if (req.method === 'POST' && route === '/api/auth/logout') {
        const user = requireUser(req); const token = tokenOf(req);
        delete db.sessions[hash(token)]; presence.delete(user.id); save();
        afterCommit.push(() => {for (const c of clients()) if (c.session_hash === hash(token)) c.close(1000, 'Signed out');});
        send(res, 200, {ok:true}); return true;
      }
      if (req.method === 'POST' && route === '/api/presence') {
        const user = requireUser(req); send(res, 200, {user: publicUser(user,user)}); return true;
      }
      if (req.method === 'GET' && route === '/api/users') {
        const user = requireUser(req); const q = text(url.searchParams.get('q'), 20).toLowerCase();
        const users = q.length < 2 ? [] : Object.values(db.users).filter((u) => u.id !== user.id && u.username.toLowerCase().includes(q)).slice(0,50).map((u) => publicUser(u,user));
        send(res, 200, {users}); return true;
      }
      if (req.method === 'GET' && route === '/api/friends') { const user = requireUser(req); send(res, 200, friendLists(user)); return true; }
      if (req.method === 'POST' && route === '/api/friends/requests') {
        const user = requireUser(req); rate('friend:' + user.id, 30);
        const d = await body(req); const other = typeof d.user_id === 'string' && ID_RE.test(d.user_id) ? db.users[d.user_id] : null;
        if (!other || other.id === user.id) fail('Choose another registered user.', 404);
        if (db.friends.includes(pair(user.id,other.id))) fail('You are already friends.', 409);
        if (db.requests.some((r) => r.from === other.id && r.to === user.id)) fail('Accept this user’s incoming request instead.', 409);
        if (!db.requests.some((r) => r.from === user.id && r.to === other.id)) {
          if (db.requests.filter((r) => r.from === user.id).length >= 100) fail('You already have 100 pending requests.', 409);
          if (db.requests.filter((r) => r.to === other.id).length >= 500) fail('This user cannot receive more requests right now.', 409);
          db.requests.push({from: user.id, to: other.id, created_at: Date.now()}); save();
        }
        send(res, 200, {ok:true, ...friendLists(user)}); return true;
      }
      match = route.match(/^\/api\/friends\/requests\/([a-f0-9]{24})\/accept$/);
      if (req.method === 'POST' && match) {
        const user = requireUser(req); const other = match[1];
        if (!db.requests.some((r) => r.from === other && r.to === user.id)) fail('Friend request not found.', 404);
        if (db.friends.filter((p) => p.split(':').includes(user.id)).length >= 500 || db.friends.filter((p) => p.split(':').includes(other)).length >= 500) fail('Friend list limit reached (500).', 409);
        db.requests = db.requests.filter((r) => !(r.from === other && r.to === user.id));
        if (!db.friends.includes(pair(user.id,other))) db.friends.push(pair(user.id,other));
        save(); send(res, 200, {ok:true, ...friendLists(user)}); return true;
      }
      match = route.match(/^\/api\/friends\/([a-f0-9]{24})$/);
      if (req.method === 'DELETE' && match) {
        const user = requireUser(req); const other = match[1];
        db.friends = db.friends.filter((p) => p !== pair(user.id,other));
        db.requests = db.requests.filter((r) => !(r.from === user.id && r.to === other) && !(r.from === other && r.to === user.id));
        save(); send(res, 200, {ok:true, ...friendLists(user)}); return true;
      }
      if (req.method === 'GET' && route === '/api/games') {
        const q = text(url.searchParams.get('q'), 80).toLowerCase();
        const games = Object.values(db.games).sort((a,b) => b.updated_at - a.updated_at).filter((g) => !q || g.creation.title.toLowerCase().includes(q)).slice(0,200).map(metadata);
        send(res, 200, {games}); return true;
      }
      if (req.method === 'POST' && route === '/api/games') {
        const user = requireUser(req); rate('publish:' + user.id, 20);
        const d = await body(req); const source = object(d.creation) ? d.creation : d;
        const creation = validateWorld(source);
        creation.assets=await transaction.validateAssets(collectReferences(creation),user.id);
        const existingId = text(source.published_id || source.remote_id || (db.games[source.id] ? source.id : ''),24);
        let game = existingId ? db.games[existingId] : null;
        if (existingId && !game) fail('Published game not found.', 404);
        if (game && game.author_id !== user.id) fail('Only the author can update this game.', 403);
        if (!game && Object.values(db.games).filter((g) => g.author_id === user.id).length >= 100) fail('You may publish up to 100 games.', 409);
        const now = Date.now();
        if (!game) game = {id:id(), author_id:user.id, revision:0, published_at:now};
        creation.id = game.id; creation.published_id = game.id; creation.author_id = user.id;
        game.creation = creation; game.part_count = creation.parts.length; game.updated_at = now; game.revision++;
        await transaction.setGameAssets(game.id,creation.assets.map(a=>a.id));
        db.games[game.id] = game; save();
        send(res, 200, {game:metadata(game), creation}); return true;
      }
      match = route.match(/^\/api\/games\/([a-f0-9]{24})$/);
      if (match && req.method === 'GET') {
        const game = db.games[match[1]];
        if (!game) fail('Published game not found.', 404);
        send(res, 200, {game:metadata(game),creation:await transaction.loadCreation(game.id)}); return true;
      }
      if (match && req.method === 'DELETE') {
        const user = requireUser(req); const game = db.games[match[1]];
        if (!game) fail('Published game not found.', 404);
        if (game.author_id !== user.id) fail('Only the author can unpublish this game.', 403);
        delete db.games[game.id]; save(); send(res, 200, {ok:true}); return true;
      }
      send(res, 404, {error:'Not found.', error_code:'not_found'});
    } catch (e) {
      if (!e.status) console.error('Community API operation failed.');
      send(res, e.status || 500, {error: e.status ? e.message : 'Server storage error. Try again later.', error_code:e.status ? e.code : 'storage_error'});
    }
    return true;
  }
  async function handleTransaction(req, res, url) {
    if (!/^\/api\/(auth|users|friends|games|presence|assets)(\/|$)/.test(url.pathname)) return false;
    // Read/limit incoming bodies before obtaining a database lock. A slow client
    // cannot hold up every player's registration or publication transaction.
    if (req.method === 'POST') {
      try { if(url.pathname==='/api/assets')req.assetBody=await readBinary(req,MAX_ASSET);else req.communityBody = await body(req); }
      catch (error) { send(res,error.status || 400,{error:error.message,error_code:error.code || 'invalid_fields'}); return true; }
    }
    try {
      const afterCommit = [];
      const response = await store.run(async (state,transaction) => {
        db = state; dirty = false;
        let buffered;
        const target = {destroyed:false,writableEnded:false,
          writeHead(status,headers) {buffered = {status,headers};},
          end(value) {buffered.body = value; this.writableEnded = true;}};
        try {
          await dispatch(req,target,url,transaction,afterCommit);
          return {commit:buffered.status < 400,dirty,value:buffered};
        } finally {db = undefined;}
      });
      if (response.status < 400) for (const action of afterCommit) {
        try {action();} catch {console.error('Community post-commit notification failed.');}
      }
      if (!res.destroyed && !res.writableEnded) {res.writeHead(response.status,response.headers);res.end(response.body);}
    } catch {
      console.error('Community storage transaction failed.');
      send(res,503,{error:'Server storage is temporarily unavailable. Try again later.',error_code:'storage_error'});
    }
    return true;
  }
  let uploadsInFlight=0;
  async function handle(req,res,url){
    const upload=req.method==='POST'&&url.pathname==='/api/assets';
    if(upload&&uploadsInFlight>=2){send(res,429,{error:'Another upload is in progress. Try again shortly.',error_code:'rate_limited'});req.resume();return true;}
    if(upload)uploadsInFlight++;
    try{
      if(upload){
        rate('upload_request:'+clientAddress(req),300);
        const owner=await store.run(state=>{db=state;try{return{commit:true,dirty:false,value:authenticate(tokenOf(req),false)?.id||''};}finally{db=undefined;}});
        if(!owner){send(res,401,{error:'Sign in to your server account first.',error_code:'session_expired'});req.resume();return true;}
      }
      return await handleTransaction(req,res,url);
    }catch(error){if(!error.status)console.error('Asset upload authorization storage failed.');send(res,error.status||503,{error:error.status?error.message:'Server storage is temporarily unavailable. Try again later.',error_code:error.code||'storage_error'});req.resume();return true;}finally{if(upload)uploadsInFlight--;}
  }
  async function checkHello(token, name, world) {
    return store.run((state) => {
      db = state;
      try {
        const account = token ? authenticate(token) : null;
        const canJoin = !world.startsWith('creation:') || (ID_RE.test(world.slice(9)) && Object.hasOwn(db.games,world.slice(9)));
        const registeredName = Object.values(db.users).some((u) => u.username.toLowerCase() === name.toLowerCase());
        return {commit:true,dirty:false,value:{account,canJoin,registeredName}};
      } finally {db = undefined;}
    });
  }
  let recovery, recoveryAt = 0;
  async function checkHealth() {
    if (store.isHealthy()) return true;
    if (!recovery && Date.now() - recoveryAt >= 10000) {
      recoveryAt = Date.now();
      recovery = store.run((state) => ({commit:true,dirty:false,value:state.instance_id}))
        .then((value) => {instanceId = value;}, () => {})
        .finally(() => {recovery = undefined;});
    }
    if (recovery) await recovery;
    return store.isHealthy();
  }
  return {handle, checkHello, ready, checkHealth, isHealthy:store.isHealthy, storageKind:store.kind, instanceId:() => instanceId, releaseStore:() => store.close(), hashToken:hash};
};
