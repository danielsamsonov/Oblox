// Quick protocol + checkout check against a running server: node test_client.js [http://localhost:8080]
const WebSocket = require("ws");
const base = process.argv[2] || "http://localhost:8080";
const wsUrl = base.replace(/^http/, "ws") + "/ws";

function client(name, server) {
  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl);
    const got = [];
    ws.on("message", (m) => got.push(JSON.parse(m)));
    ws.on("open", () => {
      ws.send(JSON.stringify({ t: "hello", name, world: "neon_obby", server, outfit: { skin: "f2c9a0" } }));
      resolve({ ws, got });
    });
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const a = await client("TestA");
  await wait(200);
  const b = await client("TestB");
  await wait(200);
  a.ws.send(JSON.stringify({ t: "state", p: [1, 2, 3], r: 0.5, s: 4, g: true }));
  b.ws.send(JSON.stringify({ t: "chat", text: "hello <b>A</b>" }));
  await wait(300);
  const ok1 = a.got.some((m) => m.t === "join" && m.name === "TestB");
  const ok2 = b.got.some((m) => m.t === "welcome" && m.players.length === 1);
  const ok3 = b.got.some((m) => m.t === "state" && m.p[2] === 3);
  const ok4 = a.got.some((m) => m.t === "chat" && m.text === "hello bA/b");
  // server codes: C asks for server 2, D follows C there by code; A (server 1) must not see them
  const c = await client("TestC", 2);
  await wait(200);
  const d = await client("TestD", 2);
  await wait(300);
  const okC = c.got.some((m) => m.t === "welcome" && m.server === 2) && d.got.some((m) => m.t === "welcome" && m.server === 2 && m.players.some((p) => p.name === "TestC"));
  const okSplit = !a.got.some((m) => m.t === "join" && m.name === "TestC");
  const stats = await (await fetch(base + "/api/stats")).json();
  const okStats = stats.servers.neon_obby["1"] === 2 && stats.servers.neon_obby["2"] === 2 && stats.players.some((p) => p.name === "TestD" && p.server === 2);
  console.log("server 2 by code", okC, "| servers separate", okSplit, "| stats per server", okStats, JSON.stringify(stats.servers));
  c.ws.close();
  d.ws.close();
  const co = await (await fetch(base + "/api/checkout", { method: "POST", body: JSON.stringify({ bundle: "b800", player: "TestA" }) })).json();
  const id = co.order_id;
  const before = await (await fetch(`${base}/api/order/${id}`)).json();
  await fetch(`${base}/pay/${id}/confirm`, { method: "POST" });
  const after = await (await fetch(`${base}/api/order/${id}`)).json();
  const claim1 = await (await fetch(`${base}/api/order/${id}/claim`, { method: "POST" })).json();
  const claim2 = await (await fetch(`${base}/api/order/${id}/claim`, { method: "POST" })).json();
  console.log("join seen", ok1, "| welcome", ok2, "| state relayed", ok3, "| chat sanitized", ok4);
  console.log("stats total", stats.total, "| order", before.status, "->", after.status, "| claim", claim1.amount, "then", claim2.amount);
  a.ws.close();
  b.ws.close();
  const pass = ok1 && ok2 && ok3 && ok4 && okC && okSplit && okStats && stats.total === 4 && after.status === "paid" && claim1.amount === 800 && claim2.amount === 0;
  console.log(pass ? "ALL PASS" : "FAIL");
  await wait(200);
  process.exitCode = pass ? 0 : 1;
})();
