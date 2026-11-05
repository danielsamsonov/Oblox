// Ignore client-supplied forwarding headers unless an operator explicitly trusts a proxy path.
const {isIP} = require('node:net');
module.exports = function clientAddress(req) {
  const peer = req.socket.remoteAddress || 'unknown';
  const hops = Number(process.env.TRUST_PROXY_HOPS || 0);
  if (!Number.isInteger(hops) || hops < 1 || hops > 8) return peer;
  const raw = req.headers['x-forwarded-for'];
  if (typeof raw !== 'string' || raw.length > 2048) return peer;
  const chain = raw.split(',').map((value) => value.trim());
  if (chain.length < hops || chain.length > 32 || chain.some((value) => !isIP(value))) return peer;
  // Walk back from the immediate proxy, never blindly trust the leftmost value.
  return chain[chain.length - hops];
};
