// A transaction owns a complete community snapshot. PostgreSQL row locks also
// serialize overlapping deployments; no account or game depends on Render's disk.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {MAX_ASSET,MAX_GAME_ASSETS,MAX_USER_ASSETS}=require('./asset_validation');
const MAX_BYTES = 32 * 1024 * 1024;
const USER_ASSET_BYTES=MAX_USER_ASSETS, GLOBAL_ASSET_BYTES=512*1024*1024, GAME_ASSET_BYTES=MAX_GAME_ASSETS;
const USER_ASSET_COUNT=512,GLOBAL_ASSET_COUNT=4096;
const assetError=(message,status=400,code='invalid_asset')=>{const e=new Error(message);e.status=status;e.code=code;throw e;};
const assetPublic=(a,name)=>({id:a.id,kind:a.kind,name:name||a.name,format:a.format,size:Number(a.size)});
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
  const assetDirectory=path.join(directory,'assets');fs.mkdirSync(assetDirectory,{recursive:true});
  const assetIndexFile=path.join(assetDirectory,'index.json');
  let assetIndex=fs.existsSync(assetIndexFile)?JSON.parse(fs.readFileSync(assetIndexFile,'utf8')):{};
  if(!assetIndex||typeof assetIndex!=='object'||Array.isArray(assetIndex)||Object.entries(assetIndex).some(([id,a])=>!a||a.id!==id||!/^[a-f0-9]{64}$/.test(id)||!['texture','sound','model'].includes(a.kind)||!Number.isInteger(a.size)||a.size<1||a.size>MAX_ASSET||!a.owners||typeof a.owners!=='object'||Array.isArray(a.owners)))throw new Error('Invalid asset index; restore its backup instead of resetting assets.');
  function persistAssets(index){const temporary=assetIndexFile+'.tmp';const fd=fs.openSync(temporary,'w',0o600);try{fs.writeFileSync(fd,JSON.stringify(index));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(temporary,assetIndexFile);assetIndex=index;}
  return sequential({kind:'json', ready:Promise.resolve(state),
    async run(operation) {
      const next = JSON.parse(JSON.stringify(state));
      const draft=JSON.parse(JSON.stringify(assetIndex));let assetsDirty=false;
      const isPublic=(assetId)=>Object.values(next.games).some(g=>(g.creation.assets||[]).some(a=>a.id===assetId));
      const allowed=(a,userId)=>a&&(Object.hasOwn(a.owners,userId||'')||isPublic(a.id));
      const context={loadCreation:async(gameId)=>next.games[gameId].creation,
        async putAsset(userId,asset,data){
          const previous=draft[asset.id];if(previous&&(previous.kind!==asset.kind||previous.format!==asset.format))assetError('Asset type conflict.',409);
          const entries=Object.values(draft),owned=entries.filter(a=>Object.hasOwn(a.owners,userId));
          const total=entries.reduce((n,a)=>n+a.size,0),own=owned.reduce((n,a)=>n+a.size,0);
          if(!previous&&entries.length>=GLOBAL_ASSET_COUNT)assetError('Free server asset library is full.',409,'asset_quota');
          if(!previous?.owners[userId]&&owned.length>=USER_ASSET_COUNT)assetError('Your asset library limit is reached (512 files).',409,'asset_quota');
          if(!previous&&total+asset.size>GLOBAL_ASSET_BYTES)assetError('Free server asset storage is full.',409,'asset_quota');
          if(!previous?.owners[userId]&&own+asset.size>USER_ASSET_BYTES)assetError('Your asset storage limit is reached.',409,'asset_quota');
          const file=path.join(assetDirectory,asset.id+'.bin');
          if(!fs.existsSync(file)){const temporary=file+'.tmp';const fd=fs.openSync(temporary,'w',0o600);try{fs.writeFileSync(fd,data);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(temporary,file);}
          const entry=previous||{...asset,owners:{}};entry.owners[userId]=asset.name;draft[asset.id]=entry;assetsDirty=true;return assetPublic(entry,asset.name);
        },
        async getAsset(assetId,userId,includeData=true){const entry=draft[assetId];if(!allowed(entry,userId))assetError('Asset not found.',404,'not_found');return {...assetPublic(entry,entry.owners[userId]),mime:entry.mime,...(includeData?{data:fs.readFileSync(path.join(assetDirectory,assetId+'.bin'))}:{})};},
        async validateAssets(refs,userId){let bytes=0;return refs.map(ref=>{const entry=draft[ref.id];if(!allowed(entry,userId))assetError('A referenced asset has not been uploaded or is private.',400,'asset_missing');if(entry.kind!==ref.kind)assetError('Referenced asset type does not match.');bytes+=entry.size;if(bytes>GAME_ASSET_BYTES)assetError('A game may reference at most 200 MiB of assets.',413,'asset_quota');return assetPublic(entry,entry.owners[userId]);});},
        async setGameAssets(){},
      };
      const result = await operation(next,context);
      if(result.commit&&assetsDirty)persistAssets(draft);
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
    connectionTimeoutMillis:15000,query_timeout:60000,application_name:'oblox-community'});
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
        // Every authored field stays in the game payload. Heartbeats need only display metadata.
        game.creation={title:game.creation.title,desc:game.creation.desc,genre:game.creation.genre,...(game.creation.thumbnail_asset?{thumbnail_asset:game.creation.thumbnail_asset}:{})};
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
      await client.query('CREATE TABLE IF NOT EXISTS oblox_assets (id text PRIMARY KEY,kind text NOT NULL,format text NOT NULL,name text NOT NULL,mime text NOT NULL,size integer NOT NULL CHECK(size>0 AND size<=52428800),data bytea NOT NULL,created_at timestamptz NOT NULL DEFAULT now())');
      // Widen the previous 8 MiB constraint in the same startup transaction.
      // Existing account, game and asset rows are preserved; later startups do no DDL.
      const assetConstraint=await client.query("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='oblox_assets'::regclass AND conname='oblox_assets_size_check'");
      if(!assetConstraint.rowCount||!assetConstraint.rows[0].definition.includes(String(MAX_ASSET))){
        await client.query('ALTER TABLE oblox_assets DROP CONSTRAINT IF EXISTS oblox_assets_size_check');
        await client.query('ALTER TABLE oblox_assets ADD CONSTRAINT oblox_assets_size_check CHECK(size>0 AND size<=52428800)');
      }
      await client.query('CREATE TABLE IF NOT EXISTS oblox_asset_owners (asset_id text NOT NULL REFERENCES oblox_assets(id),user_id text NOT NULL,name text NOT NULL,PRIMARY KEY(asset_id,user_id))');
      await client.query('CREATE TABLE IF NOT EXISTS oblox_game_assets (game_id text NOT NULL,asset_id text NOT NULL REFERENCES oblox_assets(id),PRIMARY KEY(game_id,asset_id))');
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
        const assetAllowedSql="(EXISTS(SELECT 1 FROM oblox_asset_owners o WHERE o.asset_id=a.id AND o.user_id=$2) OR EXISTS(SELECT 1 FROM oblox_game_assets g WHERE g.asset_id=a.id))";
        const context={loadCreation:async (gameId) => {
          const loaded = await client.query('SELECT creation FROM oblox_game_payloads WHERE game_id=$1',[gameId]);
          if (loaded.rowCount !== 1) throw new Error('Published game data is missing.');
          return loaded.rows[0].creation;
        },
        async putAsset(userId,asset,data){
          const existing=await client.query('SELECT id,kind,format,size FROM oblox_assets WHERE id=$1',[asset.id]);
          if(existing.rowCount&&(existing.rows[0].kind!==asset.kind||existing.rows[0].format!==asset.format))assetError('Asset type conflict.',409);
          const owns=await client.query('SELECT 1 FROM oblox_asset_owners WHERE asset_id=$1 AND user_id=$2',[asset.id,userId]);
          if(!owns.rowCount){const own=await client.query('SELECT COALESCE(sum(a.size),0) AS bytes,count(*) AS count FROM oblox_assets a JOIN oblox_asset_owners o ON o.asset_id=a.id WHERE o.user_id=$1',[userId]);if(Number(own.rows[0].count)>=USER_ASSET_COUNT)assetError('Your asset library limit is reached (512 files).',409,'asset_quota');if(Number(own.rows[0].bytes)+asset.size>USER_ASSET_BYTES)assetError('Your asset storage limit is reached.',409,'asset_quota');}
          if(!existing.rowCount){const total=await client.query('SELECT COALESCE(sum(size),0) AS bytes,count(*) AS count FROM oblox_assets');if(Number(total.rows[0].count)>=GLOBAL_ASSET_COUNT)assetError('Free server asset library is full.',409,'asset_quota');if(Number(total.rows[0].bytes)+asset.size>GLOBAL_ASSET_BYTES)assetError('Free server asset storage is full.',409,'asset_quota');await client.query('INSERT INTO oblox_assets(id,kind,format,name,mime,size,data) VALUES($1,$2,$3,$4,$5,$6,$7)',[asset.id,asset.kind,asset.format,asset.name,asset.mime,asset.size,data]);}
          await client.query('INSERT INTO oblox_asset_owners(asset_id,user_id,name) VALUES($1,$2,$3) ON CONFLICT(asset_id,user_id) DO UPDATE SET name=EXCLUDED.name',[asset.id,userId,asset.name]);return assetPublic(asset);
        },
        async getAsset(assetId,userId,includeData=true){
          // Base64 avoids the text bytea format's doubled wire size, while keeping
          // arbitrary non-UTF8 bytes intact with pg's text protocol.
          const result=await client.query('SELECT a.id,a.kind,a.format,a.name,a.mime,a.size'+(includeData?",encode(a.data,'base64') AS asset_bytes":'')+' FROM oblox_assets a WHERE a.id=$1 AND '+assetAllowedSql,[assetId,userId||'']);
          if(!result.rowCount)assetError('Asset not found.',404,'not_found');const a=result.rows[0];return {...assetPublic(a),mime:a.mime,...(includeData?{data:Buffer.from(a.asset_bytes,'base64')}:{})};
        },
        async validateAssets(refs,userId){
          if(!refs.length)return [];const result=await client.query('SELECT a.id,a.kind,a.format,a.name,a.size FROM oblox_assets a WHERE a.id=ANY($1::text[]) AND '+assetAllowedSql,[refs.map(r=>r.id),userId]);const byId=new Map(result.rows.map(a=>[a.id,a]));let bytes=0;
          return refs.map(ref=>{const a=byId.get(ref.id);if(!a)assetError('A referenced asset has not been uploaded or is private.',400,'asset_missing');if(a.kind!==ref.kind)assetError('Referenced asset type does not match.');bytes+=Number(a.size);if(bytes>GAME_ASSET_BYTES)assetError('A game may reference at most 200 MiB of assets.',413,'asset_quota');return assetPublic(a);});
        },
        async setGameAssets(gameId,ids){await client.query('DELETE FROM oblox_game_assets WHERE game_id=$1',[gameId]);if(ids.length)await client.query('INSERT INTO oblox_game_assets(game_id,asset_id) SELECT $1,unnest($2::text[])',[gameId,ids]);}
        };
        const result = await operation(state,context);
        let nextRevision = revision, nextEncoded = encoded;
        if (result.commit && result.dirty) {
          const separated = split(state);
          await writePayloads(client,separated.payloads);
          const deletedIds = previousIds.filter((gameId) => !Object.hasOwn(state.games,gameId));
          if (deletedIds.length) {await client.query('DELETE FROM oblox_game_assets WHERE game_id=ANY($1::text[])',[deletedIds]);await client.query('DELETE FROM oblox_game_payloads WHERE game_id=ANY($1::text[])',[deletedIds]);}
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
