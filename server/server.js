// Oblox online server: one process serves the WebSocket game rooms (/ws) and a small HTTP API.
// Run locally:  npm install && npm start      (port 8080, or $PORT on hosting services)
const http = require("http");
const { WebSocketServer } = require("ws");
const pay = require("./payments");
const community = require("./community")({ clients: () => wss.clients });
const readBody = require("./http_body");
const startDiscovery = require("./discovery");
const BUILD = "2.1.1";
let storageReady = false;
community.ready.then(() => {storageReady = true;}, () => {
  console.error("Oblox community storage startup failed. Check DATABASE_URL and database availability.");
  process.exitCode = 1;
  shutdown();
});

const PORT = Number(process.env.PORT || 8080);
const ROOM_SIZE = 16;
const SERVERS_PER_GAME = 3;
const NAME_RE = /^[A-Za-z0-9_]{3,20}$/;
const ROOM_RE = /^[a-z0-9_:\-]{1,64}$/;
const OUTFIT_KEYS = ["skin", "shirt", "pants", "face", "hair", "hair_color", "hat", "jacket", "back", "shoes"];

let nextId = 1;
const rooms = new Map(); // room name -> Set of clients

// ------------------------------------------------------------------ helpers
function clean(s, max) {
  return String(s == null ? "" : s).replace(/[\u0000-\u001f<>]/g, "").slice(0, max);
}
function cleanOutfit(o) {
  const out = {};
  if (o && typeof o === "object") {
    for (const k of OUTFIT_KEYS) out[k] = clean(o[k], 32).replace(/[^A-Za-z0-9_]/g, "");
  }
  return out;
}
function num(v, lim) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(-lim, Math.min(lim, n)) : 0;
}
function send(c, msg) {
  if (c.readyState === 1) c.send(JSON.stringify(msg));
}
function broadcast(room, msg, except) {
  const set = rooms.get(room);
  if (!set) return;
  const data = JSON.stringify(msg);
  for (const c of set) if (c !== except && c.readyState === 1) c.send(data);
}
function info(c) {
  return { id: c.id, user_id: c.user_id || "", name: c.name, outfit: c.outfit, p: c.p, r: c.r, coins: c.coins };
}
// Every game has exactly SERVERS_PER_GAME servers (rooms "world#1".."world#3").
// The game shows them as codes like NEON-2 and can ask for a specific one.
function roomName(world, n) {
  return `${world}#${n}`;
}
function roomSize(world, n) {
  const set = rooms.get(roomName(world, n));
  return set ? set.size : 0;
}
// Wanted server if it has space; otherwise the fullest server that still has space (so people meet). 0 = all full.
function pickServer(world, want) {
  if (want >= 1 && want <= SERVERS_PER_GAME) return roomSize(world, want) < ROOM_SIZE ? want : 0;
  let best = 0;
  let bestCount = -1;
  for (let n = 1; n <= SERVERS_PER_GAME; n++) {
    const size = roomSize(world, n);
    if (size < ROOM_SIZE && size > bestCount) {
      best = n;
      bestCount = size;
    }
  }
  return best;
}
function stats() {
  const worlds = {};
  const servers = {}; // world -> { "1": count, "2": count, "3": count }
  const players = [];
  let total = 0;
  for (const [name, set] of rooms) {
    const [world, n] = name.split("#");
    worlds[world] = (worlds[world] || 0) + set.size;
    servers[world] = servers[world] || {};
    servers[world][n] = set.size;
    total += set.size;
    for (const c of set) if (players.length < 100) players.push({ user_id: c.user_id || "", name: c.name, world, server: Number(n) });
  }
  return { total, worlds, servers, servers_per_game: SERVERS_PER_GAME, room_size: ROOM_SIZE, players, payments: pay.publicInfo() };
}

// ------------------------------------------------------------------ HTTP
function baseUrl(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL;
  const proto = req.headers["x-forwarded-proto"] || "http";
  return `${proto}://${req.headers.host}`;
}
function json(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}
function html(res, code, text) {
  res.writeHead(code, { "Content-Type": "text/html; charset=utf-8" });
  res.end(text);
}
function health() {
  return { service: "oblox-community", version: 2, build: BUILD, ready:storageReady && community.isHealthy(), storage:community.storageKind, instance_id: community.instanceId(),
    port: server.address() ? server.address().port : PORT, ws_path: "/ws",
    capabilities: ["accounts", "friends", "published_games", "rooms", "lan_discovery"] };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    const path = url.pathname;
    if (req.method === "GET" && path === "/api/health") {
      const healthy = storageReady && await community.checkHealth();
      return json(res, healthy ? 200 : 503, health());
    }
    if (await community.handle(req, res, url)) return;
    if (req.method === "GET" && (path === "/" || path === "/api/stats")) return json(res, 200, stats());
    if (req.method === "POST" && path === "/api/checkout") {
      const body = JSON.parse((await readBody(req, 100000)) || "{}");
      const r = await pay.createCheckout(clean(body.bundle, 16), clean(body.player, 20), baseUrl(req));
      return r.error ? json(res, r.code, { error: r.error }) : json(res, 200, r);
    }
    let m = path.match(/^\/api\/order\/([a-f0-9]{6,32})$/);
    if (req.method === "GET" && m) {
      const o = pay.getOrder(m[1]);
      return o ? json(res, 200, o) : json(res, 404, { error: "not found" });
    }
    m = path.match(/^\/api\/order\/([a-f0-9]{6,32})\/claim$/);
    if (req.method === "POST" && m) return json(res, 200, { amount: pay.claim(m[1]) });
    if (req.method === "POST" && path === "/api/stripe/webhook") {
      const raw = await readBody(req, 100000);
      return json(res, pay.stripeWebhook(raw, req.headers["stripe-signature"]) ? 200 : 400, {});
    }
    m = path.match(/^\/pay\/([a-f0-9]{6,32})(\/(confirm|cancel|done))?$/);
    if (m) {
      const action = m[3] || "";
      if (action === "" && req.method === "GET") {
        if (pay.MODE !== "mock") return html(res, 404, "Not found");
        return html(res, 200, pay.mockPage(m[1]));
      }
      if (action === "confirm" && req.method === "POST" && pay.MODE === "mock") {
        pay.setStatus(m[1], "paid");
        return html(res, 200, pay.resultPage(true));
      }
      if (action === "cancel") {
        pay.setStatus(m[1], "canceled");
        return html(res, 200, pay.resultPage(false));
      }
      if (action === "done") return html(res, 200, pay.resultPage(true));
    }
    json(res, 404, { error: "not found", error_code: "not_found" });
  } catch (e) {
    if (!res.headersSent && !res.destroyed) json(res, e.status || 400, { error: e.status ? e.message : "bad request", error_code: e.code || "invalid_request" });
  }
});
server.requestTimeout = 30000;
server.headersTimeout = 15000;

// ------------------------------------------------------------------ WebSocket game rooms
const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 8 * 1024 });

wss.on("connection", (c) => {
  c.id = 0;
  c.alive = true;
  c.lastChat = 0;
  c.msgs = 0;
  // Malformed/oversized WebSocket frames must close that connection, not the server.
  c.on("error", () => {});
  const helloTimeout = setTimeout(() => { if (!c.id) c.close(1008, "Send hello first"); }, 10000);
  helloTimeout.unref();
  c.on("pong", () => (c.alive = true));
  c.on("message", async (raw) => {
    if (++c.msgs > 60) return; // per-second flood limit
    let d;
    try {
      d = JSON.parse(raw);
    } catch {
      return;
    }
    if (!d || typeof d !== "object") return;
    if (d.t === "hello" && !c.id) {
      if (c.joining) return;
      c.joining = true;
      const world = clean(d.world, 64).toLowerCase();
      let result;
      try { result = await community.checkHello(d.token,clean(d.name,20),world); }
      catch {
        send(c,{t:"error",code:"storage",error_code:"storage_error",text:"Server storage is temporarily unavailable. Try again later."});
        return c.close(1013,"Storage unavailable");
      } finally {c.joining = false;}
      if (c.readyState !== 1 || c.id) return;
      const account = result.account;
      if (d.token && !account) return send(c, { t: "error", code: "auth", error_code: "session_expired", text: "Your session expired. Sign in again." }), c.close();
      let name = account ? account.username : clean(d.name, 20);
      if (!NAME_RE.test(name) || !ROOM_RE.test(world)) return send(c, { t: "error", text: "bad hello" }), c.close();
      if (!result.canJoin) return send(c, { t: "error", code: "not_found", text: "This game is not published on this server." }), c.close();
      // Guests cannot take the name of a registered player.
      if (!account && result.registeredName) name = "Guest_" + name;
      const n = pickServer(world, Math.floor(num(d.server, 100)));
      if (!n) {
        const text = d.server ? "That server is full. Try another one." : "All servers of this game are full.";
        return send(c, { t: "error", code: "full", text }), c.close();
      }
      c.id = nextId++;
      clearTimeout(helloTimeout);
      c.name = name;
      c.user_id = account ? account.id : "";
      c.session_hash = account ? community.hashToken(d.token) : "";
      c.world = world;
      c.outfit = cleanOutfit(d.outfit);
      c.p = [0, 0, 0];
      c.r = 0;
      c.coins = 0;
      c.server = n;
      c.room = roomName(world, n);
      if (!rooms.has(c.room)) rooms.set(c.room, new Set());
      const set = rooms.get(c.room);
      send(c, { t: "welcome", id: c.id, room: c.room, world, server: n, players: [...set].map(info) });
      set.add(c);
      broadcast(c.room, { t: "join", ...info(c) }, c);
      console.log(`+ ${name} -> ${c.room} (${set.size})`);
      return;
    }
    if (!c.id) return;
    switch (d.t) {
      case "state":
        if (Array.isArray(d.p) && d.p.length === 3) c.p = d.p.map((v) => Math.round(num(v, 1e5) * 100) / 100);
        c.r = Math.round(num(d.r, 100) * 100) / 100;
        broadcast(c.room, { t: "state", id: c.id, p: c.p, r: c.r, s: Math.round(num(d.s, 100) * 10) / 10, g: !!d.g }, c);
        break;
      case "chat": {
        const now = Date.now();
        const text = clean(d.text, 120).trim();
        if (!text || now - c.lastChat < 800) return;
        c.lastChat = now;
        broadcast(c.room, { t: "chat", id: c.id, name: c.name, text }, c);
        break;
      }
      case "coins":
        c.coins = Math.max(0, Math.min(1e6, Math.floor(num(d.n, 1e6))));
        broadcast(c.room, { t: "coins", id: c.id, n: c.coins }, c);
        break;
      case "outfit":
        c.outfit = cleanOutfit(d.outfit);
        broadcast(c.room, { t: "outfit", id: c.id, outfit: c.outfit }, c);
        break;
      case "stats":
        send(c, { t: "stats", ...stats() });
        break;
    }
  });
  c.on("close", () => {
    clearTimeout(helloTimeout);
    if (!c.id) return;
    const set = rooms.get(c.room);
    if (set) {
      set.delete(c);
      if (set.size === 0) rooms.delete(c.room);
    }
    broadcast(c.room, { t: "leave", id: c.id });
    console.log(`- ${c.name} <- ${c.room}`);
  });
});

// reset flood counters every second, drop dead sockets every 25 s (keeps free hosting connections alive)
const floodTimer = setInterval(() => wss.clients.forEach((c) => (c.msgs = 0)), 1000);
const pingTimer = setInterval(() => {
  wss.clients.forEach((c) => {
    if (!c.alive) return c.terminate();
    c.alive = false;
    c.ping();
  });
}, 25000);

let discovery;
server.on("error", (error) => {
  console.error("Oblox server startup failed (" + error.code + "): " + error.message);
  process.exitCode = 1;
  shutdown();
});
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(floodTimer); clearInterval(pingTimer);
  if (discovery) { try { discovery.close(); } catch {} }
  for (const c of wss.clients) c.terminate();
  wss.close();
  server.close(() => { community.releaseStore().finally(() => {if (process.connected) process.disconnect();}); });
  if (server.closeIdleConnections) server.closeIdleConnections();
  setTimeout(() => { community.releaseStore(); process.exit(process.exitCode || 0); }, 1500).unref();
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
// Test harnesses and supervised launchers may request a graceful stop over their private IPC channel.
process.on("message", (message) => { if (message === "oblox:shutdown") shutdown(); });
server.listen(PORT, process.env.HOST || "0.0.0.0", () => {
  console.log(`Oblox server on :${server.address().port}  (payments: ${pay.MODE}, build: ${BUILD})`);
  discovery = startDiscovery(health);
});
