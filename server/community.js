// Account, friends and published-world API. One server process owns an atomic JSON store.
// OBLOX_DATA_DIR must point to persistent storage when hosting; never put it under public files.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readBody = require('./http_body');
const clientAddress = require('./client_address');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);
const NAME_RE = /^[A-Za-z0-9_]{3,20}$/;
const ID_RE = /^[a-f0-9]{24}$/;
const TOKEN_RE = /^[a-f0-9]{64}$/;
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const PARTS = new Set(['block','sphere','cylinder','wedge','kill','coin','pad','checkpoint','spawn','finish','teleport','tree','pine','rock','crate','lamp','light','sign']);
const ACTIONS = new Set(['coins','damage','heal','kill','bounce','teleport','message','toggle','spin','move','show_ui','hide_ui','sound','music','win']);
const MATERIALS = new Set(['plastic','neon','glass','metal','wood','ice','smooth']);
const SOUNDS = new Set(['coin','jump','win','checkpoint','pad','boom','thunder','alarm','buy','oof']);
const TRACKS = new Set(['menu','lobby','isles','obby','city','lava','rush','disaster']);
const UI_KINDS = new Set(['text','button','panel','icon','coins','timer','health']);
const SKIES = new Set(['day','night','sunset']);
const GENRES = new Set(['Obby','Adventure','Roleplay','Survival','Arcade']);
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
function number(v, min, max, fallback) {
  if (v === undefined && fallback !== undefined) return fallback;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) fail('number outside supported range');
  return v;
}
function vector(v, fallback, min = -10000, max = 10000) {
  if (v === undefined) return fallback;
  if (!Array.isArray(v) || v.length !== 3) fail('vector must contain three numbers');
  return v.map((n) => number(n, min, max));
}
function color(v, fallback) {
  if (v === undefined) return fallback;
  if (typeof v !== 'string' || !/^(?:[a-f0-9]{6}|[a-f0-9]{8})$/i.test(v)) fail('invalid color');
  return v.toLowerCase();
}
function enumValue(v, choices, fallback) {
  if (v === undefined) return fallback;
  if (!choices.has(v)) fail('unsupported value: ' + text(v, 40));
  return v;
}
function list(v, max, fallback = []) {
  if (v === undefined) return fallback;
  if (!Array.isArray(v) || v.length > max) fail('too many items');
  return v;
}
function boolean(v, fallback) {
  if (v === undefined) return fallback;
  if (typeof v !== 'boolean') fail('expected a boolean');
  return v;
}
function validateWorld(raw) {
  if (!object(raw)) fail('creation must be an object');
  const title = text(raw.title, 80);
  if (!title) fail('add a title before publishing');
  const parts = list(raw.parts, 1000);
  if (!parts.length || !parts.some((p) => object(p) && p.t === 'spawn')) fail('add a Spawn before publishing');
  let actionCount = 0;
  const actions = (a) => list(a, 16).map((item) => {
    if (!object(item) || !ACTIONS.has(item.a)) fail('unsupported action');
    if (++actionCount > 2000) fail('too many actions');
    const out = { a: item.a };
    if (['coins','damage','heal','bounce','spin','move'].includes(item.a)) out.n = number(item.n, -10000, 10000, item.a === 'move' ? 2 : 1);
    if (item.a === 'move') out.xyz = vector(item.xyz, [0,4,0], -1000, 1000);
    if (['teleport','toggle'].includes(item.a)) out.target = text(item.target, 64);
    if (['show_ui','hide_ui'].includes(item.a)) out.ui = text(item.ui, 64);
    if (item.a === 'message') out.text = text(item.text, 300);
    if (item.a === 'sound') out.sound = enumValue(item.sound, SOUNDS, 'coin');
    if (item.a === 'music') out.track = enumValue(item.track, TRACKS, 'menu');
    return out;
  });
  const names = new Set();
  const sanitizedParts = parts.map((p, i) => {
    if (!object(p) || !PARTS.has(p.t)) fail('unsupported part');
    const name = text(p.name, 64) || 'Part' + (i + 1);
    if (names.has(name)) fail('part names must be unique');
    names.add(name);
    const out = {t: p.t, name, p: vector(p.p, [0,0,0]), folder: text(p.folder, 64),
      rot: p.rot === undefined ? [0, number(p.r, -36000, 36000, 0), 0] : vector(p.rot, [0,0,0], -36000, 36000),
      anchored: boolean(p.anchored, true), collide: boolean(p.collide, true), alpha: number(p.alpha, 0, 1, 1)};
    if (p.s !== undefined) out.s = vector(p.s, undefined, 0.1, 512);
    if (p.c !== undefined) out.c = color(p.c);
    if (p.mat !== undefined) out.mat = enumValue(p.mat, MATERIALS);
    if (p.t === 'sign') out.text = text(p.text, 300);
    if (p.t === 'light') out.n = number(p.n, 0, 20, 2);
    if (p.t === 'teleport') out.target = text(p.target, 64);
    out.events = list(p.events, 16).map((ev) => {
      if (!object(ev) || !['touch','start','timer'].includes(ev.on)) fail('unsupported event');
      const result = {on: ev.on, do: actions(ev.do)};
      if (ev.on === 'timer') result.every = number(ev.every, 0.25, 86400, 2);
      return result;
    });
    return out;
  });
  const uiIds = new Set();
  const ui = list(raw.ui, 100).map((el, i) => {
    if (!object(el) || !UI_KINDS.has(el.k)) fail('unsupported UI element');
    const elementId = text(el.id, 64) || 'UI' + (i + 1);
    if (uiIds.has(elementId)) fail('UI ids must be unique');
    uiIds.add(elementId);
    return {id: elementId, k: el.k, x: number(el.x, -1600, 3200, 0), y: number(el.y, -900, 1800, 0),
      w: number(el.w, 8, 3200, 200), h: number(el.h, 8, 1800, 60), text: text(el.text, 1000),
      size: number(el.size, 8, 160, 24), color: color(el.color, 'ffffff'), bg: color(el.bg, '00000000'),
      radius: number(el.radius, 0, 100, 12), visible: boolean(el.visible, true), click: actions(el.click)};
  });
  return {title, desc: text(raw.desc === undefined ? raw.description : raw.desc, 2000), parts: sanitizedParts,
    ui, folders: list(raw.folders, 100).map((f) => text(f, 64)), sky: enumValue(raw.sky, SKIES, 'day'),
    music: enumValue(raw.music, TRACKS, 'isles'), genre: enumValue(raw.genre, GENRES, 'Obby'), published: true};
}

module.exports = function createCommunity({ clients }) {
  const directory = path.resolve(process.env.OBLOX_DATA_DIR || path.join(__dirname, 'data'));
  fs.mkdirSync(directory, {recursive: true});
  const releaseStore = require('./store_lock')(directory);
  const filename = path.join(directory, 'community.json');
  let db = {version: 1, users: {}, sessions: {}, friends: [], requests: [], games: {}};
  if (fs.existsSync(filename)) {
    db = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (db.version !== 1 || !object(db.users) || !object(db.sessions) || !Array.isArray(db.friends) || !Array.isArray(db.requests) || !object(db.games)) {
      throw new Error('Invalid community store; restore its backup instead of resetting player data.');
    }
  }
  const presence = new Map();
  const rateLimits = new Map();
  let persisted = JSON.stringify(db);
  function save() {
    const temporary = filename + '.tmp';
    const encoded = JSON.stringify(db);
    try {
      const fd = fs.openSync(temporary, 'w', 0o600);
      try { fs.writeFileSync(fd, encoded); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temporary, filename);
      persisted = encoded;
    } catch (error) {
      db = JSON.parse(persisted);
      throw error;
    }
  }
  // Add a stable server identity while preserving every existing account and publication.
  if (typeof db.instance_id !== 'string' || !ID_RE.test(db.instance_id)) { db.instance_id = id(); save(); }
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
      code: 'U' + game.id.slice(0,7).toUpperCase(), rating: 0, playing, part_count: game.creation.parts.length};
  }
  function friendLists(user) {
    const friendIds = db.friends.filter((p) => p.split(':').includes(user.id)).map((p) => p.split(':').find((a) => a !== user.id));
    return {friends: friendIds.map((i) => publicUser(db.users[i], user)),
      incoming: db.requests.filter((r) => r.to === user.id).map((r) => publicUser(db.users[r.from], user)),
      outgoing: db.requests.filter((r) => r.from === user.id).map((r) => publicUser(db.users[r.to], user))};
  }
  async function body(req) {
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
  async function handle(req, res, url) {
    const route = url.pathname;
    if (!/^\/api\/(auth|users|friends|games|presence)(\/|$)/.test(route)) return false;
    try {
      if (req.method === 'OPTIONS') { send(res, 200, {}); return true; }
      const remote = clientAddress(req);
      rate('http:' + remote, 300);
      let match;
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
        for (const c of clients()) if (c.session_hash === hash(token)) c.close(1000, 'Signed out');
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
        const existingId = text(source.published_id || source.remote_id || (db.games[source.id] ? source.id : ''),24);
        let game = existingId ? db.games[existingId] : null;
        if (existingId && !game) fail('Published game not found.', 404);
        if (game && game.author_id !== user.id) fail('Only the author can update this game.', 403);
        if (!game && Object.values(db.games).filter((g) => g.author_id === user.id).length >= 100) fail('You may publish up to 100 games.', 409);
        const now = Date.now();
        if (!game) game = {id:id(), author_id:user.id, revision:0, published_at:now};
        creation.id = game.id; creation.published_id = game.id; creation.author_id = user.id;
        game.creation = creation; game.updated_at = now; game.revision++;
        db.games[game.id] = game; save();
        send(res, 200, {game:metadata(game), creation}); return true;
      }
      match = route.match(/^\/api\/games\/([a-f0-9]{24})$/);
      if (match && req.method === 'GET') {
        const game = db.games[match[1]];
        if (!game) fail('Published game not found.', 404);
        send(res, 200, {game:metadata(game),creation:game.creation}); return true;
      }
      if (match && req.method === 'DELETE') {
        const user = requireUser(req); const game = db.games[match[1]];
        if (!game) fail('Published game not found.', 404);
        if (game.author_id !== user.id) fail('Only the author can unpublish this game.', 403);
        delete db.games[game.id]; save(); send(res, 200, {ok:true}); return true;
      }
      send(res, 404, {error:'Not found.', error_code:'not_found'});
    } catch (e) {
      if (!e.status) console.error('Community API:', e.message);
      send(res, e.status || 500, {error: e.status ? e.message : 'Server storage error. Try again later.', error_code:e.status ? e.code : 'storage_error'});
    }
    return true;
  }
  return {handle, authenticate, instanceId: () => db.instance_id, releaseStore,
    canJoinWorld: (world) => !world.startsWith('creation:') || (ID_RE.test(world.slice(9)) && Object.hasOwn(db.games, world.slice(9))),
    isRegisteredName: (name) => Object.values(db.users).some((u) => u.username.toLowerCase() === name.toLowerCase()), hashToken: hash};
};
