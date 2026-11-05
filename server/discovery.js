// A local/private-network discovery beacon. Never advertises accounts or authentication data.
const dgram = require('node:dgram');
function privateIPv4(address) {
  const a = address.split('.').map(Number);
  return a.length === 4 && (a[0] === 127 || a[0] === 10 || (a[0] === 192 && a[1] === 168)
    || (a[0] === 172 && a[1] >= 16 && a[1] <= 31) || (a[0] === 169 && a[1] === 254));
}
module.exports = function discover(health) {
  const port = Number(process.env.OBLOX_DISCOVERY_PORT === undefined ? 18881 : process.env.OBLOX_DISCOVERY_PORT);
  if (!port) return null;
  if (!Number.isInteger(port) || port < 1 || port > 65535) { console.error('Discovery disabled: invalid OBLOX_DISCOVERY_PORT.'); return null; }
  const socket = dgram.createSocket('udp4');
  const seen = new Map();
  socket.on('error', (error) => {
    console.error('LAN discovery unavailable (' + error.code + '). Manual server address still works.');
    socket.close();
  });
  socket.on('message', (raw, remote) => {
    if (raw.length > 256 || !privateIPv4(remote.address)) return;
    const now = Date.now();
    const state = seen.get(remote.address) || {since: now, count: 0};
    if (now - state.since >= 1000) { state.since = now; state.count = 0; }
    if (++state.count > 5) return;
    seen.set(remote.address,state);
    if (seen.size > 256) for (const [address, value] of seen) if (now - value.since > 10000) seen.delete(address);
    let message;
    try { message = JSON.parse(raw); } catch { return; }
    if (!message || message.service !== 'oblox-discover' || message.version !== 1
      || typeof message.nonce !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(message.nonce)) return;
    const h = health();
    const answer = Buffer.from(JSON.stringify({service: h.service, version: h.version, build: h.build,
      instance_id: h.instance_id, port: h.port, ws_path: '/ws', name: 'Oblox 2', nonce: message.nonce}));
    socket.send(answer,remote.port,remote.address,() => {});
  });
  socket.bind(port,'0.0.0.0',() => console.log('Oblox LAN discovery on UDP :' + port));
  return socket;
};
