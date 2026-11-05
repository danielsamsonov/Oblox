// Test-only preload: aggregate query shapes and byte counts, never player data,
// SQL parameters, credentials, or connection strings. Not used by npm start.
const pg = require('pg');
const original = pg.Client.prototype.query;
const metrics = {coreReads:0,payloadReads:0,revisionReads:0,assetBlobReads:0,rowBytes:0};
pg.Client.prototype.query = function(...args) {
  const result = original.apply(this,args);
  if (!result || typeof result.then !== 'function') return result;
  const sql = typeof args[0] === 'string' ? args[0] : args[0].text;
  return result.then((response) => {
    if (/^SELECT state(?:,| FROM)/.test(sql)) metrics.coreReads++;
    if (/^SELECT creation FROM/.test(sql)) metrics.payloadReads++;
    if (/FROM oblox_assets/.test(sql) && /\ba\.data\b|SELECT data|SELECT \*/.test(sql)) metrics.assetBlobReads++;
    if (/^SELECT revision FROM/.test(sql)) metrics.revisionReads++;
    metrics.rowBytes += Buffer.byteLength(JSON.stringify(response.rows));
    return response;
  });
};
process.on('message',(message) => {
  if (message && message.t === 'oblox:test:pgMetrics' && process.connected) process.send({t:message.t,id:message.id,metrics});
});
