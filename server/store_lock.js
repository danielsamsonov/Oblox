// One writer per data directory, even if two launchers start at the same instant.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const heldDirectories = new Set();
// Linux PID namespaces reuse small PIDs across container restarts. A PID alone
// therefore does not identify the process that originally created a volume lock.
function processIdentity(pid) {
  if (process.platform !== 'linux') return '';
  try {
    const stat = fs.readFileSync('/proc/' + pid + '/stat','utf8');
    const startTicks = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)[19];
    const boot = fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim();
    return boot + ':' + startTicks;
  } catch { return ''; }
}
module.exports = function lockStore(directory) {
  directory = path.resolve(directory);
  const directoryKey = process.platform === 'win32' ? directory.toLowerCase() : directory;
  if (heldDirectories.has(directoryKey)) throw new Error('This process already owns the data folder lock.');
  const filename = path.join(directory,'server.lock');
  const owner = crypto.randomBytes(16).toString('hex');
  function acquire() {
    const fd = fs.openSync(filename,'wx',0o600);
    try { fs.writeFileSync(fd,JSON.stringify({pid:process.pid,owner,created_at:Date.now(),process_identity:processIdentity(process.pid)})); }
    finally { fs.closeSync(fd); }
  }
  try { acquire(); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let previous;
    try { previous = JSON.parse(fs.readFileSync(filename,'utf8')); }
    catch { throw new Error('The data folder has an unreadable server.lock. Check that no server is running before removing that lock file.'); }
    let alive = true;
    try { process.kill(Number(previous.pid),0); }
    catch (check) { if (check.code === 'ESRCH') alive = false; }
    // No other live process in our PID namespace can have our own PID. An
    // existing lock with that number came from an earlier process/container.
    if (Number(previous.pid) === process.pid) alive = false;
    const currentIdentity = processIdentity(Number(previous.pid));
    if (previous.process_identity && currentIdentity && previous.process_identity !== currentIdentity) alive = false;
    if (alive) throw new Error('This data folder is already open by server PID ' + previous.pid + '. Connect to that server instead of starting another writer.');
    // Verify the exact lock has not changed before removing a stale owner.
    if (fs.readFileSync(filename,'utf8') !== JSON.stringify(previous)) throw new Error('Data folder lock changed during startup. Try again.');
    fs.unlinkSync(filename);
    acquire();
  }
  let released = false;
  heldDirectories.add(directoryKey);
  function release() {
    if (released) return;
    released = true;
    heldDirectories.delete(directoryKey);
    try {
      const current = JSON.parse(fs.readFileSync(filename,'utf8'));
      if (current.owner === owner && current.pid === process.pid) fs.unlinkSync(filename);
    } catch { /* A missing lock does not change or remove player data. */ }
  }
  process.once('exit',release);
  return release;
};
