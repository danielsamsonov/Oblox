// A transaction owns a complete community snapshot. PostgreSQL row locks also
// serialize overlapping deployments; no account or game depends on Render's disk.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const MAX_BYTES = 32 * 1024 * 1024;
const fresh = () => ({version:1, instance_id:crypto.randomBytes(12).toString('hex'), users:{}, sessions:{}, friends:[], requests:[], games:{}});
function validate(value) {
  const object = (x) => x && typeof x === 'object' && !Array.isArray(x);
  if (!object(value) || value.version !== 1 || !object(value.users) || !object(value.sessions) ||
      !Array.isArray(value.friends) || !Array.isArray(value.requests) || !object(value.games)) {
    throw new Error('Invalid community store; restore its backup instead of resetting player data.');
  }
  return value;
}
function encode(value) {
  const encoded = JSON.stringify(validate(value));
  if (Buffer.byteLength(encoded) > MAX_BYTES) throw new Error('Community storage capacity reached.');
  return encoded;
}
function sequential(adapter) {
  let tail = Promise.resolve(), closing, healthy = false;
  adapter.ready.then(() => {healthy = true;}, () => {});
  return {
    ...adapter,
    isHealthy:() => healthy,
    run(operation) {
      const result = tail.then(async () => {
        try {const value = await adapter.run(operation); healthy = true; return value;}
        catch (error) {healthy = false; throw error;}
      });
      tail = result.catch(() => {});
      return result;
    },
    close() { if (!closing) closing = tail.then(() => adapter.close()); return closing; }
  };
}
function jsonStore() {
  const directory = path.resolve(process.env.OBLOX_DATA_DIR || path.join(__dirname, 'data'));
  fs.mkdirSync(directory, {recursive:true});
  const release = require('./store_lock')(directory);
  const filename = path.join(directory,'community.json');
  let state = fs.existsSync(filename) ? validate(JSON.parse(fs.readFileSync(filename,'utf8'))) : fresh();
  function persist(next) {
    const encoded = encode(next), temporary = filename + '.tmp';
    const fd = fs.openSync(temporary,'w',0o600);
    try { fs.writeFileSync(fd,encoded); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary,filename);
    state = JSON.parse(encoded);
  }
  if (typeof state.instance_id !== 'string' || !/^[a-f0-9]{24}$/.test(state.instance_id)) state.instance_id = fresh().instance_id;
  persist(state);
  return sequential({kind:'json', ready:Promise.resolve(state),
    async run(operation) {
      const next = JSON.parse(JSON.stringify(state));
      const result = await operation(next,{loadCreation:async (gameId) => next.games[gameId].creation});
      if (result.commit && result.dirty) persist(next);
      return result.value;
    },
    close:release
  });
}
function postgresStore(connectionString) {
  // pg verifies the provider certificate. Never disable TLS verification for a
  // cloud database. Plain connections are accepted only for loopback test/local DBs.
  let url;
  try {
    url = new URL(connectionString);
    if (!['postgres:','postgresql:'].includes(url.protocol) || !url.hostname || !url.pathname.slice(1)) throw new Error();
  } catch {throw new Error('DATABASE_URL must be a valid PostgreSQL connection URL.');}
  const local = ['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  const ssl = local && url.searchParams.get('sslmode') === 'disable' ? false : {rejectUnauthorized:true};
  for (const key of ['sslmode','sslcert','sslkey','sslrootcert']) url.searchParams.delete(key);
  const {Pool} = require('pg');
  const pool = new Pool({connectionString:url.toString(),ssl,max:2,idleTimeoutMillis:10000,
    connectionTimeoutMillis:15000,query_timeout:15000,application_name:'oblox-community'});
  // Idle connection loss is recoverable on the next request and must not print
  // provider connection strings, usernames, query parameters, or database contents.
  pool.on('error',() => console.error('Community database connection interrupted.'));
  let cachedRevision, cachedState;
  function split(state) {
    const core = JSON.parse(encode(state)), payloads = [];
    for (const [gameId,game] of Object.entries(core.games)) {
      if (Array.isArray(game.creation.parts)) {
        payloads.push([gameId,JSON.stringify(game.creation)]);
        game.part_count = game.creation.parts.length;
        delete game.creation.parts; delete game.creation.ui;
      }
    }
    return {core,encoded:encode(core),payloads};
  }
  async function writePayloads(client,payloads) {
    for (const [gameId,creation] of payloads) {
      await client.query('INSERT INTO oblox_game_payloads (game_id,creation) VALUES ($1,$2::jsonb) ON CONFLICT (game_id) DO UPDATE SET creation=EXCLUDED.creation',[gameId,creation]);
    }
  }
  const ready = (async () => {
    const client = await pool.connect();
    try {
      // Serialize first-time schema creation, including simultaneous deployments.
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(184940521, 1)");
      await client.query('CREATE TABLE IF NOT EXISTS oblox_community (singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton), state jsonb NOT NULL, revision bigint NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now())');
      await client.query('ALTER TABLE oblox_community ADD COLUMN IF NOT EXISTS revision bigint NOT NULL DEFAULT 0');
      await client.query('CREATE TABLE IF NOT EXISTS oblox_game_payloads (game_id text PRIMARY KEY,creation jsonb NOT NULL)');
      await client.query('INSERT INTO oblox_community (singleton,state) VALUES (true,$1::jsonb) ON CONFLICT (singleton) DO NOTHING',[encode(fresh())]);
      const result = await client.query('SELECT state,revision FROM oblox_community WHERE singleton=true FOR UPDATE');
      const state = validate(result.rows[0].state);
      if (!/^[a-f0-9]{24}$/.test(state.instance_id || '')) throw new Error('Invalid community server identity.');
      const separated = split(state);
      await writePayloads(client,separated.payloads);
      let revision = result.rows[0].revision;
      if (separated.payloads.length) {
        const updated = await client.query('UPDATE oblox_community SET state=$1::jsonb,revision=revision+1,updated_at=now() WHERE singleton=true RETURNING revision',[separated.encoded]);
        revision = updated.rows[0].revision;
      }
      await client.query('COMMIT');
      cachedRevision = String(revision); cachedState = separated.encoded;
      return separated.core;
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  })();
  return sequential({kind:'postgres',ready,
    async run(operation) {
      await ready;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("SET LOCAL lock_timeout = '10s'");
        await client.query("SET LOCAL idle_in_transaction_session_timeout = '20s'");
        const selected = await client.query('SELECT revision FROM oblox_community WHERE singleton=true FOR UPDATE');
        if (selected.rowCount !== 1) throw new Error('Community state is missing.');
        const revision = String(selected.rows[0].revision);
        let encoded = cachedState;
        if (cachedRevision !== revision) {
          const loaded = await client.query('SELECT state FROM oblox_community WHERE singleton=true');
          encoded = encode(loaded.rows[0].state);
        }
        const state = validate(JSON.parse(encoded));
        const previousIds = Object.keys(state.games);
        const result = await operation(state,{loadCreation:async (gameId) => {
          const loaded = await client.query('SELECT creation FROM oblox_game_payloads WHERE game_id=$1',[gameId]);
          if (loaded.rowCount !== 1) throw new Error('Published game data is missing.');
          return loaded.rows[0].creation;
        }});
        let nextRevision = revision, nextEncoded = encoded;
        if (result.commit && result.dirty) {
          const separated = split(state);
          await writePayloads(client,separated.payloads);
          const deletedIds = previousIds.filter((gameId) => !Object.hasOwn(state.games,gameId));
          if (deletedIds.length) await client.query('DELETE FROM oblox_game_payloads WHERE game_id=ANY($1::text[])',[deletedIds]);
          const updated = await client.query('UPDATE oblox_community SET state=$1::jsonb,revision=revision+1,updated_at=now() WHERE singleton=true RETURNING revision',[separated.encoded]);
          nextRevision = String(updated.rows[0].revision); nextEncoded = separated.encoded;
        }
        await client.query(result.commit ? 'COMMIT' : 'ROLLBACK');
        // Advance the cache only after a confirmed COMMIT. Failed writes never
        // leak into a later read, including failures raised at COMMIT itself.
        if (result.commit) {cachedRevision = nextRevision; cachedState = nextEncoded;}
        return result.value;
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
      finally { client.release(); }
    },
    close:() => pool.end()
  });
}
module.exports = () => {
  if (process.env.OBLOX_REQUIRE_DATABASE === '1' && !process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for cloud storage.');
  return process.env.DATABASE_URL ? postgresStore(process.env.DATABASE_URL) : jsonStore();
};
