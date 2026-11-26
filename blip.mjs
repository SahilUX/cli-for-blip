#!/usr/bin/env node
// blip: headless command line for the Blip native engine, over its local DRPC socket.
// Reverse-engineered from Blip 1.2.6 (Go core, storj.io/drpc v0.0.32, service
// /rpc.Service/{GetState,Dispatch}, events packed as protobuf Any). Needs Node >= 22.
// Every command except status and stop starts the native engine in the background if it isn't running.
// Sends only to the signed-in account's own devices; matching is by device id or exact name, case-insensitive.
//   blip login [email]            sign in with the code Blip emails you
//   blip logout                   sign out and remove this device from the account (exit 4: removal not confirmed)
//   blip send <path>... [--to d]  send files/folders to one of your devices, wait for completion
//   blip accept [id] [--dir d]    accept an incoming transfer (no id: every one that is waiting)
//   blip decline <id>             decline an incoming transfer
//   blip folder [path]            show or set where incoming files are saved
//   blip auto-accept [on|off]     show or set whether transfers from your own devices are saved without asking
//   blip devices | transfers [id] | status | start | stop
import { randomUUID } from 'node:crypto';
import { resolve, dirname, basename } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync, openSync, closeSync, readSync, fstatSync, rmSync, renameSync, chmodSync, realpathSync, statSync, lstatSync, readlinkSync } from 'node:fs';
import { homedir, hostname, type, release } from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { call, fields, uv } from './drpc.mjs';
import { runtimePaths } from './platform.mjs';

const HOME = homedir();
const HERE = dirname(fileURLToPath(import.meta.url));                                     // this checkout, for the install hint
const PATHS = runtimePaths(HOME, process.platform, process.env);
const { socket: SOCK, app: APP, library: LIB, data: DATA, own: OWN, config: CONFIG } = PATHS;
const PIDFILE = `${OWN}/pid`, LOCK = `${OWN}/start.lock`, LOG = `${OWN}/app.log`;
const TMP = `${OWN}/tmp`;
const STATUS = ['Unknown', 'Created', 'InviteRequested', 'Invited', 'Pending', 'Active', 'Paused', 'ResumeRequested', 'Completed', 'Cancelled'];
const REG = ['NotStarted', 'SendingCode', 'CodeSent', 'Registering'];                     // frontend.Registration.status
const USAGE = `usage: blip <command>
  login [email] [--name <device name>]   sign in with the code Blip emails you
  logout                                 sign out and remove this device from your account
  send <path>... [--to <device>]         send files or folders and wait until they arrive
  accept [id] [--dir <folder>]           accept an incoming transfer (no id: all waiting ones)
  decline <id>                           decline an incoming transfer
  folder [path]                          show or set the folder incoming files are saved to
  auto-accept [on|off]                   show or set saving your own devices' transfers without asking
  devices                                list your own devices
  transfers [id]                         list transfers and their state
  status                                 show whether Blip runs and who is signed in
  start | stop                           start or stop the background app`;

const str = (f) => f?.value.toString('utf8') ?? '';
const ld = (tag, buf) => Buffer.concat([uv((tag << 3) | 2), uv(buf.length), buf]);        // length-delimited field
const s = (tag, v) => ld(tag, Buffer.from(v));
const vi = (tag, n) => Buffer.concat([uv(tag << 3), uv(n)]);                              // varint field
const peerId = (p) => Buffer.concat([s(1, p.userId), s(2, p.deviceId)]);                  // blip.PeerId
// map<string, Message> fields of a parsed message, as [{key, val}]
const entries = (list, tag) => list.filter((f) => f.tag === tag).map((f) => { const e = fields(f.value); return { key: str(e.find((x) => x.tag === 1)), val: e.find((x) => x.tag === 2)?.value ?? Buffer.alloc(0) }; });
// Text that came from Blip (names, ids, errors) is printed with control and bidi characters escaped.
const safe = (v) => String(v).replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const die = (msg, code = 1) => { console.error(msg); process.exit(code); };

// Whatever answers on the socket sees your email, sign-in code and file paths, so it must be yours.
function checkSock() {
  let st; try { st = lstatSync(SOCK); } catch { return; }                                 // not there yet: start() runs the app
  if (!st.isSocket() || st.uid !== process.getuid()) die(`refusing ${SOCK}: it is not a socket you own`);
}
// State. Never print it raw: Auth (tag 201) holds the session token.
async function getState() {
  checkSock();
  const resp = await call(SOCK, '/rpc.Service/GetState', Buffer.alloc(0));
  const state = fields(resp).find((f) => f.tag === 2);
  if (!state) throw new Error('unexpected reply from Blip (is this a supported Blip version?)');
  return fields(state.value);
}
function session(st) {                                                                     // oneof session: 200 Registration, 201 Auth
  const auth = st.find((f) => f.tag === 201);
  if (auth) { const a = fields(auth.value); return { email: str(a.find((f) => f.tag === 203)), deviceId: str(a.find((f) => f.tag === 204)) }; }
  const r = fields(st.find((f) => f.tag === 200)?.value ?? Buffer.alloc(0)); const err = r.find((f) => f.tag === 999);
  return { reg: REG[r.find((f) => f.tag === 1)?.value ?? 0], err: err ? str(fields(err.value).find((f) => f.tag === 2)) : '' };
}
async function waitFor(pred, ms, what) {
  const deadline = Date.now() + ms;
  for (;;) { const v = pred(await getState()); if (v) return v; if (Date.now() > deadline) die(`timed out waiting for ${what}`); await sleep(500); }
}
const dispatch = (name, msg = Buffer.alloc(0)) => {                                        // DispatchRequest{event: Any{type_url, value}}
  checkSock();
  const any = Buffer.concat([s(1, `type.googleapis.com/event.${name}`), ld(2, msg)]);
  return call(SOCK, '/rpc.Service/Dispatch', ld(1, any));
};

// The desktop frontend normally supplies this after connecting. A headless host
// needs it too, especially before registering a fresh device. The app id is this
// project's own, not one in Blip's net.blip namespace. The version is the
// engine's, because that is the protocol Blip's servers actually talk to.
const initializeCore = () => dispatch('SetUserAgent', ld(1, Buffer.concat([
  vi(102, 5), s(200, type()), s(201, release()), s(300, 'io.github.sahilux.blip-cli'),
  s(301, 'blip-cli'), s(302, PATHS.engineVersion),
])));

// Background native engine. The same socket can also belong to a separately running desktop app.
// Only "nothing listens on the socket" means Blip isn't running; a hung or incompatible app is an error, not a reason to start a second one.
const reachable = () => getState().then(() => true, (e) => { if (e.syscall === 'connect' && ['ENOENT', 'ECONNREFUSED'].includes(e.code)) return false; throw e; });
const answers = () => getState().then(() => true, () => false);                          // while starting or stopping, any failure means "not yet"
const running = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
// /proc/<pid>/stat fields after the command name: [0] is field 3 (state), [2] pgrp, [19] starttime.
const procStat = (pid) => { try { const t = readFileSync(`/proc/${pid}/stat`, 'utf8'); return t.slice(t.lastIndexOf(')') + 2).split(' '); } catch { return null; } };
// The pid file holds a PID and its kernel start timestamp, so reused PIDs
// cannot make stop signal another process. The Mac helper also checks UID.
function processIdentity(pid) {
  if (!/^[1-9][0-9]*$/.test(String(pid))) return null;
  if (process.platform === 'darwin') {
    try {
      const value = execFileSync(APP, ['--identity', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      const match = /^(\d+) (\d+) (\d+:\d+)$/.exec(value);
      if (!match || match[1] !== String(pid)) throw new Error('invalid identity response');
      return { group: match[2], since: match[3] };
    } catch (e) {
      if (e.status === 4) return null;  // gone, zombie or owned by another user
      throw new Error(`could not verify Blip process ${pid}; check BLIP_APP or reinstall the native host before retrying`);
    }
  }
  const st = procStat(pid);
  return st && !'ZX'.includes(st[0]) ? { group: st[2], since: st[19] } : null;
}
function ownPid() {
  let pid, since;
  try { [pid, since] = readFileSync(PIDFILE, 'utf8').trim().split(' '); } catch { return 0; }
  const identity = processIdentity(pid);
  if (identity && identity.group === pid && identity.since === since) return Number(pid);
  rmSync(PIDFILE, { force: true });
  return 0;
}
// One starter at a time, so two commands run together don't launch two apps. A lock whose holder died is stale.
async function lock() {
  const deadline = Date.now() + 60000;
  for (;;) {
    try { writeFileSync(LOCK, String(process.pid), { flag: 'wx', mode: 0o600 }); break; } catch (e) { if (e.code !== 'EEXIST') throw e; }
    let holder, age;
    try { holder = Number(readFileSync(LOCK, 'utf8')); age = Date.now() - statSync(LOCK).mtimeMs; } catch { continue; }
    if ((holder > 0 && !running(holder)) || age > 90000) { rmSync(LOCK, { force: true }); continue; }
    if (Date.now() > deadline) die('another blip command is still starting Blip');
    await sleep(500);
  }
  const release = () => { try { if (readFileSync(LOCK, 'utf8') === String(process.pid)) rmSync(LOCK); } catch {} };
  process.on('exit', release);
  return release;
}
async function start() {
  if (await reachable()) {
    // A concurrent starter may have opened the socket but still be supplying
    // the initial user agent. Wait until it has finished initialization.
    if (existsSync(LOCK)) { const releaseLock = await lock(); releaseLock(); }
    return false;
  }
  if (!['linux', 'darwin'].includes(process.platform)) die('starting the native Blip core is supported only on Linux and macOS');
  if (!existsSync(APP)) die(`Blip is not installed at ${APP}. Install it with ${HERE}/install.sh (or set BLIP_APP)`);
  if (!existsSync(LIB)) die(`Blip core is not installed at ${LIB}. Run ${HERE}/install.sh (or set BLIP_LIB)`);
  if (basename(SOCK) !== 'sock') die('native startup requires BLIP_SOCK to end in /sock');
  const maxSocketBytes = process.platform === 'darwin' ? 103 : 107;
  if (Buffer.byteLength(SOCK) > maxSocketBytes) die(`Blip socket path is too long (maximum ${maxSocketBytes} bytes); set BLIP_SOCK to a shorter path ending in /sock`);
  const argv = [APP, LIB, dirname(SOCK), DATA];
  mkdirSync(OWN, { recursive: true, mode: 0o700 }); chmodSync(OWN, 0o700);
  const releaseLock = await lock();
  if (await reachable()) { releaseLock(); return false; }                                      // another blip started it while we waited
  let exited = () => !ownPid();                                                            // an earlier start that timed out may still be booting
  if (!ownPid()) {
    if (existsSync(LOG)) renameSync(LOG, `${LOG}.1`);                                      // keep one previous run
    rmSync(TMP, { recursive: true, force: true }); mkdirSync(TMP, { mode: 0o700 });
    for (const path of [dirname(SOCK), DATA]) {
      mkdirSync(path, { recursive: true, mode: 0o700 });
      // These two directories belong to Blip. An existing custom socket
      // directory can hold unrelated files, so preserve its permissions.
      if (path === DATA || path === resolve(PATHS.cache)) chmodSync(path, 0o700);
    }
    // The engine keeps its cache next to its socket, so no one else may write there.
    const dir = statSync(dirname(SOCK));
    if (!dir.isDirectory() || dir.uid !== process.getuid() || dir.mode & 0o022) die(`refusing ${dirname(SOCK)} for BLIP_SOCK: Blip keeps its cache there, so it must be a folder you own that no one else can write to`);
    const log = openSync(LOG, 'a', 0o600);                                             // append mode for native diagnostics
    process.umask(process.umask(0o022) | 0o022);                                           // the app creates its socket under this umask: no one else may write to (connect to) it
    const child = spawn(argv[0], argv.slice(1), { cwd: HOME, env: { ...process.env, TMPDIR: TMP }, detached: true, stdio: ['ignore', log, log] });
    let gone = false; child.on('exit', () => { gone = true; }); exited = () => gone;
    child.on('error', (e) => die(`could not run ${argv[0]}: ${e.message}`));
    try {
      const identity = processIdentity(child.pid);
      if (!identity || identity.group !== String(child.pid)) throw new Error(`Blip exited during startup, see ${LOG}`);
      writeFileSync(PIDFILE, `${child.pid} ${identity.since}`, { mode: 0o600 });
    } catch (e) { child.kill('SIGTERM'); throw e; }
    child.unref();
  }
  console.error('starting Blip in the background...');
  const deadline = Date.now() + 60000;
  let last = '';                                                                             // an answer blip can't use, such as after a Blip update
  while (!(await getState().then(() => true, (e) => { last = e.syscall === 'connect' ? '' : e.message; return false; }))) {
    if (exited()) die(`Blip exited during startup, see ${LOG}`);
    if (Date.now() > deadline) die(last ? `Blip answers but ${safe(last)}, see ${LOG}` : `Blip did not open its socket within 60 s, see ${LOG} (it may still be starting; blip stop ends it)`);
    await sleep(500);
  }
  await initializeCore();
  releaseLock();
  return true;
}
async function stop() {
  const pid = ownPid();
  if (!pid) {
    if (await reachable().catch(() => true)) die('Blip is running, but blip did not start it (a service or the desktop app?). Stop it there');
    console.error('Blip is not running'); return;
  }
  try { process.kill(-pid, 'SIGTERM'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
  for (let i = 0; i < 40 && (ownPid() || (await answers())); i++) await sleep(250);
  if (ownPid()) die(`Blip did not stop within 10 s, see ${LOG}`);
  if (await answers()) die('Blip still answers on its socket after 10 s (another instance or a stuck core)');
  rmSync(TMP, { recursive: true, force: true });
  console.error('Blip stopped');
}
async function loadedSession() {
  let me = session(await getState());
  for (let i = 0; !me.email && started && i < 10; i++) { await sleep(500); me = session(await getState()); }   // a freshly started app may still be loading its session
  return me;
}
async function signedIn() {
  const me = await loadedSession();
  if (!me.email) die('not signed in (run: blip login)');
  return me;
}

function devicesIn(st) {
  const users = fields(st.find((f) => f.tag === 500)?.value ?? Buffer.alloc(0));
  const self = entries(users, 1).filter(({ val }) => fields(val).find((f) => f.tag === 10)?.value === 1); // is_self
  const out = self.flatMap(({ key: userId, val }) => entries(fields(val), 7).map(({ val: dev }) => {
    const d = fields(dev); const g = (t) => d.find((f) => f.tag === t);
    return { userId, deviceId: str(g(1)), name: str(g(3)), isThis: g(6)?.value === 1 };
  }));
  // Cross-check the reverse-engineered is_self flag: exactly one user is you, and it owns this device.
  return self.length === 1 && out.some((d) => d.isThis) ? out : null;
}
// State.messaging (tag 400) initial_sync_complete (3): the engine has had its first sync with Blip's server.
const synced = (st) => fields(st.find((f) => f.tag === 400)?.value ?? Buffer.alloc(0)).find((f) => f.tag === 3)?.value === 1;
// Right after sign-in or a start the device list is missing or out of date until that first sync, so wait for both
// the flag and a list that names this device. The flag alone is not trusted: it isn't known whether the engine clears
// it when one account signs out and another signs in, so even a synced engine gets the whole wait before an error.
// At the deadline an unsynced list is still returned, marked, for callers that can use it safely.
const syncWait = () => (timeout > 0 && Number.isFinite(timeout) ? Math.min(timeout, 15) : 15);
async function ownDevices() {
  const deadline = Date.now() + syncWait() * 1000;
  for (;;) {
    const st = await getState();
    const out = devicesIn(st), done = synced(st);
    if (out && done) return { devices: out, synced: true };
    if (Date.now() > deadline) {
      if (out) return { devices: out, synced: false };
      die(done ? "can't tell which devices are yours (is this a supported Blip version?)" : `Blip has not loaded your devices from its server after ${syncWait()} s (is this machine online?). Try again in a moment`);
    }
    await sleep(500);
  }
}
const unsyncedNote = () => `Blip has not finished syncing your devices with its server after ${syncWait()} s (is this machine online?), so this list may be out of date`;
async function transfers() {
  return entries(await getState(), 600).map(({ key, val }) => {
    const t = fields(val); const g = (n) => t.find((f) => f.tag === n);
    const error = (n) => (g(n) ? str(fields(g(n).value).find((f) => f.tag === 2)) : '');  // 600 local error, 601 the other device's error
    const status = g(800)?.value ?? 0;
    return { id: key, status: STATUS[status] ?? `status ${status}`, direction: g(700)?.value === 2 ? 'out' : 'in', err: error(600), remoteErr: error(601), saved: g(501) ? str(g(501)) : '' };
  });
}
const describe = (t) => `${t.status}${t.err ? ` err=${safe(t.err)}` : ''}${t.remoteErr ? ` remote=${safe(t.remoteErr)}` : ''}`;
// Same id file the app itself uses, so a later sign-in replaces this device instead of adding another.
function dedupeId() {
  const path = `${DATA}/hardwareinfo/device-dedupe-id.txt`;
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, `${randomUUID()}\r\n`, { mode: 0o600 });                            // the app's own line ending
  }
  const id = readFileSync(path, 'utf8').trim().slice(0, 36);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) die(`${path} does not start with a device id. Move it away and run blip login again`);
  return id;
}
// At logout the engine asks the server to remove this device, then signs out even if that failed: it only logs the
// error. When the server accepted the removal it logs a DeviceRemove event naming the device, before it signs out.
// Only that line counts as proof, and only in what the log gained after the request. Anything else is unconfirmed,
// including an engine that blip did not start, whose log is somewhere else.
const logSize = () => { try { return statSync(LOG).size; } catch { return 0; } };
function removalLogged(from, deviceId) {
  let log;
  try {
    log = openSync(LOG, 'r');
    const { size } = fstatSync(log); const start = size < from ? 0 : from;                // smaller: a restart began a new log
    const buf = Buffer.alloc(Math.min(size - start, 4 << 20));
    const text = buf.toString('utf8', 0, readSync(log, buf, 0, buf.length, start));
    return !!deviceId && text.split('\n').some((l) => /^\S+ \S+ INFO reducing event type=\*event\.InsertAnalyticsEvent event="name:\s*\\"DeviceRemove\\"/.test(l) && l.includes(`\\"${deviceId}\\"`));
  } catch { return false; } finally { if (log !== undefined) closeSync(log); }
}
// Blip's Config (State tag 100): auto_accept_disabled (2) and custom_default_save_path (4). Without a custom path the engine saves to ~/Downloads.
function receiveSettings(st) {
  const c = fields(st.find((f) => f.tag === 100)?.value ?? Buffer.alloc(0));
  const custom = str(c.find((f) => f.tag === 4));
  return { folder: custom.startsWith('/') ? custom : `${HOME}/Downloads`, custom: custom.startsWith('/'), autoAccept: c.find((f) => f.tag === 2)?.value !== 1 };
}
// The engine doesn't create the folder it saves into, and a transfer that fails on a missing folder stays Invited. So create it before anything can arrive.
async function ensureReceiveFolder() {
  let folder;
  try { folder = receiveSettings(await getState()).folder; } catch { return; }              // best effort: the command itself reports a broken Blip
  try { if (mkdirSync(folder, { recursive: true })) console.error(`created ${safe(folder)} for incoming files`); }
  catch (e) { console.error(`warning: can't use ${safe(folder)} for incoming files: ${safe(e.message)} (set another with: blip folder <path>)`); }
}
const config = () => { try { const c = JSON.parse(readFileSync(CONFIG, 'utf8')); return c && typeof c === 'object' ? c : {}; } catch { return {}; } };

process.on('uncaughtException', (e) => {
  if (e.syscall === 'connect') console.error(`Blip not reachable at ${SOCK} (${e.code}). It may have exited, see ${LOG} (set BLIP_SOCK if the socket lives elsewhere)`);
  else console.error(safe(e.message).slice(0, 500));
  process.exit(1);
});
process.on('unhandledRejection', (e) => { throw e; });

let opts;
try {
  opts = parseArgs({ allowPositionals: true, tokens: true, options: { to: { type: 'string', short: 't' }, name: { type: 'string' }, dir: { type: 'string' }, help: { type: 'boolean', short: 'h' } } });
} catch (e) { die(`${e.message}\n${USAGE}`, 2); }
const [cmd, ...args] = opts.positionals; const { values: flag } = opts;
const there = (p) => { try { lstatSync(p); return true; } catch { return false; } };   // a dangling link is there too
// A glob like `blip send *` can expand to a file named --help or --to=x: refuse it rather than read it as an option.
for (const t of opts.tokens) {
  const raw = process.argv[2 + t.index];
  if (t.kind === 'option' && there(raw)) die(`"${raw}" is a file but reads as an option. Put paths after -- (blip send -- <path>...) or start them with ./`, 2);
}
if (!cmd || cmd === 'help' || flag.help) { console.log(USAGE); process.exit(cmd || flag.help ? 0 : 2); }
if (!['login', 'logout', 'send', 'accept', 'decline', 'folder', 'auto-accept', 'devices', 'transfers', 'status', 'start', 'stop'].includes(cmd)) die(USAGE, 2);

// send: check everything that doesn't need the app before starting it.
const T = process.env.BLIP_TIMEOUT_S?.trim();
const timeout = T ? Number(T) : 300;
let abs = [];
if (cmd === 'send') {
  if (!args.length) die('usage: blip send <path>... [--to <device>]', 2);
  if (args.some((p) => !p.trim())) die('empty path (an unset variable?)', 2);
  if (!(timeout > 0 && Number.isFinite(timeout))) die(`BLIP_TIMEOUT_S must be a positive number of seconds, not "${T}"`, 2);
  abs = args.map((p) => resolve(p));
  for (const p of abs) if (!existsSync(p)) die(`not found: ${p}`);
  // The app would read /dev/zero, a FIFO or /proc/self/environ like a file, and opens /dev/stdin as its own: only plain files and folders go.
  // Check every hop of a link chain as well as the resolved path, since /proc/self/fd links resolve to some other file.
  const sys = (p) => { for (let i = 0; i < 40; i++) { if (/^\/(dev|proc|sys)(\/|$)/.test(p)) return true; let t; try { t = readlinkSync(p); } catch { return false; } p = resolve(dirname(p), t); } return true; };
  for (const p of abs) { const st = statSync(p); if (!(st.isFile() || st.isDirectory()) || sys(p) || sys(realpathSync(p))) die(`refusing to send ${p}: not a regular file or folder`); }
  // Darwin volumes commonly ignore case and normalize Unicode. Be conservative
  // even on case-sensitive volumes rather than risk sending credential data.
  // realpath keeps the /System/Volumes/Data firmlink and the /.nofollow prefix, which name the same files.
  const comparable = (p) => process.platform === 'darwin' ? p.normalize('NFC').toLowerCase().replace(/^\/\.nofollow(?=\/|$)/, '').replace(/^\/system\/volumes\/data(?=\/|$)/, '') || '/' : p;
  const contains = (a, b) => a === b || a.startsWith(`${b}/`) || b.startsWith(a === '/' ? '/' : `${a}/`);
  const desktopData = `${HOME}/Library/Group Containers/AY8UB8KTUX.blip`;
  let canonicalDesktopData = desktopData;
  try { canonicalDesktopData = `${realpathSync.native(HOME)}/Library/Group Containers/AY8UB8KTUX.blip`; } catch {}
  const protectedData = [...PATHS.protectedData, canonicalDesktopData];
  const roots = protectedData.map(comparable);
  for (const p of abs) {
    // Reject obvious credential paths before resolving them, so a normal send
    // never needs to inspect the protected desktop Group Container.
    if (roots.some((data) => contains(comparable(p), data))) die(`refusing to send ${p}: it contains Blip's own data, including your session`);
    const resolved = comparable(realpathSync.native(p));
    for (const path of protectedData) {
      // Resolve our own profile for symlinked HOME/data directories. Leave the
      // desktop Group Container alone: only its known path is compared.
      let data = comparable(path);
      if (path !== desktopData && path !== canonicalDesktopData) {
        try { data = comparable(realpathSync.native(path)); } catch {}
      }
      if (contains(resolved, data)) die(`refusing to send ${p}: it contains Blip's own data, including your session`);
    }
  }
}

if (cmd === 'decline') {
  if (!args[0]) die('usage: blip decline <id> (ids: blip transfers)', 2);
  if (flag.dir) die('--dir only goes with accept', 2);
}

if (cmd === 'stop') { await stop(); process.exit(0); }
// status reads the state once and never starts Blip, even if it stops between two calls.
const current = cmd === 'status' && await getState().catch((e) => { if (e.syscall === 'connect' && ['ENOENT', 'ECONNREFUSED'].includes(e.code)) return null; throw e; });
if (cmd === 'status' && !current) { console.log('Blip is not running (run: blip start)'); process.exit(1); }
const started = cmd !== 'status' && await start();
if (cmd !== 'status') await ensureReceiveFolder();
if (cmd === 'start') {
  console.error(started ? 'Blip is running in the background' : 'Blip is already running');
} else if (cmd === 'status') {
  const me = session(current);
  console.log(`Blip is running${ownPid() ? ' in the background' : ''}`);
  console.log(me.email ? `signed in as ${safe(me.email)}` : 'not signed in (run: blip login)');
} else if (cmd === 'login') {
  const me = session(await getState());
  if (me.email) die(`already signed in as ${safe(me.email)} (run blip logout first to switch accounts)`, 0);
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  rl.on('SIGINT', () => die('\nsign-in cancelled', 130));
  const lines = rl[Symbol.asyncIterator]();                                                // buffers lines, so piped answers aren't lost
  let ended = false; rl.once('close', () => { ended = true; });                          // input ended; buffered lines can still be read
  const ask = async (q) => {
    if (ended) process.stderr.write(q); else { rl.setPrompt(q); rl.prompt(); }
    const { value, done } = await lines.next();
    if (done) die('sign-in cancelled: no more input');
    return value;
  };
  const email = (args[0] ?? (await ask('email: '))).trim();
  if (!email) die('usage: blip login [email]', 2);
  const name = (flag.name || process.env.BLIP_DEVICE_NAME || '').trim() || hostname().split('.')[0];
  // Ignore Registration state left over from an earlier attempt until it changes, or for 1.5 s.
  await initializeCore();
  const t0 = Date.now(); let moved = false;
  await dispatch('SendRegistrationCodeRequested', Buffer.concat([s(1, email), s(2, name)]));
  const sent = await waitFor((st) => { const r = session(st); moved ||= r.reg !== me.reg || r.err !== me.err; return (moved || Date.now() - t0 > 1500) && (r.reg === 'CodeSent' || (r.err && r.reg === 'NotStarted')) && r; }, 30000, 'Blip to send the code');
  if (sent.reg !== 'CodeSent') die(`could not send a code to ${email}: ${safe(sent.err)}`);
  console.error(`Blip emailed a 6-digit code to ${email}`);
  for (let tries = 0; ; tries++) {
    const code = (await ask('code: ')).replace(/\s/g, '');
    const t1 = Date.now();
    await dispatch('RegistrationRequested', Buffer.concat([s(1, code), s(2, dedupeId()), s(3, name), vi(4, 5)])); // device_kind 5 = Desktop
    const r = await waitFor((st) => { const r = session(st); return (r.email || (r.err && r.reg !== 'Registering' && Date.now() - t1 > 1500)) && r; }, 30000, 'Blip to check the code');
    if (r.email) { console.error(`signed in as ${safe(r.email)}, this device is "${name}"`); break; }
    if (tries === 2 || r.reg !== 'CodeSent') die(`sign-in failed: ${safe(r.err)}`);
    console.error(`${safe(r.err)}, try again`);
  }
  rl.close();
} else if (cmd === 'logout') {
  const me = await loadedSession();
  if (!me.email) die('not signed in', 0);
  const from = logSize();
  const seconds = timeout > 0 && Number.isFinite(timeout) ? Math.min(timeout, 30) : 30;
  const pending = 'Blip may still sign out and remove this device later. Until then the device may still be listed on your account, even if blip status says not signed in. Check the device list in Blip on another device';
  try {
    await dispatch('RemoveDeviceThenLogout');
    const deadline = Date.now() + seconds * 1000;
    while (session(await getState()).email) {
      if (Date.now() > deadline) die(`Blip has not signed out after ${seconds} s. It waits for its server to answer; ${pending}`, 3);
      await sleep(500);
    }
  } catch (e) { die(`lost contact with Blip while signing out: ${safe(e.message).slice(0, 200)}; ${pending}`, 3); }
  if (!removalLogged(from, me.deviceId)) die(`signed out of ${safe(me.email)} on this machine, but Blip did not confirm that it removed this device from your account, so the device may still be listed there. Remove it in Blip on another device, or run blip login and then blip logout while online (see ${LOG})`, 4);
  console.error(`signed out of ${safe(me.email)} and removed this device from your account`);
} else if (cmd === 'devices') {
  await signedIn();
  const { devices, synced: fresh } = await ownDevices();
  if (!fresh) console.error(`note: ${unsyncedNote()}`);
  for (const d of devices) console.log(`${safe(d.name)}${d.isThis ? ' (this device)' : ''}\t${safe(d.deviceId)}`);
} else if (cmd === 'transfers') {
  await signedIn();
  const list = (await transfers()).filter((t) => !args[0] || t.id === args[0]);
  if (args[0] && !list.length) die(`no such transfer: ${safe(args[0])}`);
  for (const t of list) console.log(`${safe(t.id)}\t${t.direction}\t${t.status}${t.err ? `\terr=${safe(t.err)}` : ''}${t.remoteErr ? `\tremote=${safe(t.remoteErr)}` : ''}${t.saved ? `\tsaved=${safe(t.saved)}` : ''}`);
} else if (cmd === 'accept' || cmd === 'decline') {
  await signedIn();
  const all = await transfers();
  let targets;
  if (args[0]) {
    const t = all.find((x) => x.id === args[0]);
    if (!t) die(`no such transfer: ${safe(args[0])}`);
    if (t.direction !== 'in') die(`${safe(t.id)} is an outgoing transfer; only incoming ones can be ${cmd}ed`);
    if (['Completed', 'Cancelled'].includes(t.status)) die(`${safe(t.id)} is already ${t.status}; nothing to ${cmd}`);
    targets = [t];
  } else {
    targets = all.filter((t) => t.direction === 'in' && t.status === 'Invited');
    if (!targets.length) { console.error('no incoming transfer is waiting to be accepted'); process.exit(0); }
  }
  let dir = '';
  if (flag.dir) { dir = resolve(flag.dir); mkdirSync(dir, { recursive: true }); }
  const waitMs = timeout > 0 && Number.isFinite(timeout) ? Math.min(timeout, 15) * 1000 : 15000;
  let failed = false;
  for (const t of targets) {
    await dispatch(cmd === 'accept' ? 'TransferAcceptanceRequested' : 'TransferDeclineRequested', Buffer.concat([s(1, t.id), ...(dir ? [s(2, dir)] : [])]));
    // Wait for the engine to act on it; an accept that fails on its side leaves the transfer Invited with an error.
    const deadline = Date.now() + waitMs; let now;
    for (;;) { now = (await transfers()).find((x) => x.id === t.id); if (!now || now.status !== 'Invited' || Date.now() > deadline) break; await sleep(500); }
    if (!now) console.log(`${safe(t.id)}\t${cmd === 'accept' ? 'accepted' : 'declined'}`);
    else if (now.status === 'Invited') { failed = true; console.error(`${safe(t.id)} is still Invited after ${cmd}: ${describe(now)}`); }
    else console.log(`${safe(t.id)}\t${now.status}${now.err ? `\terr=${safe(now.err)}` : ''}`);
  }
  if (failed) process.exit(1);
} else if (cmd === 'folder') {
  const want = args[0] ? resolve(args[0]) : '';
  if (want) {
    await signedIn();
    mkdirSync(want, { recursive: true });
    await dispatch('TransferSetCustomDefaultSavePath', s(1, want));
    await waitFor((st) => receiveSettings(st).folder === want, 10000, 'Blip to use the new folder');
  }
  const { folder, custom } = receiveSettings(await getState());
  console.log(`incoming files are saved to ${safe(folder)}${custom ? '' : ' (default)'}`);
} else if (cmd === 'auto-accept') {
  if (args[0] && !['on', 'off'].includes(args[0])) die('usage: blip auto-accept [on|off]', 2);
  if (args[0]) {
    await signedIn();
    const on = args[0] === 'on';
    await dispatch('TransferSetAutoAccept', vi(1, on ? 1 : 0));
    await waitFor((st) => receiveSettings(st).autoAccept === on, 10000, 'Blip to change auto-accept');
  }
  console.log(`auto-accept is ${receiveSettings(await getState()).autoAccept ? 'on' : 'off'}`);
} else if (cmd === 'send') {
  await signedIn();
  const { devices, synced: fresh } = await ownDevices();
  const others = devices.filter((d) => !d.isThis);
  const remembered = typeof config().to === 'string' ? config().to : '';
  // An unsynced list may miss a device of the same name, so it can't settle a name or pick the only device.
  const device = flag.to || process.env.BLIP_TO || remembered || (fresh && others.length === 1 ? others[0].name : '');
  if (!fresh && !others.some((d) => d.deviceId === device)) die(`${unsyncedNote()}. To send anyway, pass the device id from blip devices with --to`);
  if (!device) die('which device? pass --to <device> (see: blip devices). blip remembers it for next time', 2);
  const key = (n) => n.normalize('NFC').toLowerCase();
  const matches = others.filter((d) => d.deviceId === device || key(d.name) === key(device));
  if (matches.length !== 1) die(`${matches.length ? 'ambiguous' : 'no such'} device "${safe(device)}" among your own devices (see: blip devices)`);
  if (flag.to) { mkdirSync(dirname(CONFIG), { recursive: true, mode: 0o700 }); writeFileSync(CONFIG, JSON.stringify({ ...config(), to: flag.to }) + '\n', { mode: 0o600 }); }
  const peer = matches[0]; const id = randomUUID();
  // Leaving early doesn't cancel anything: the background app keeps the transfer and may still deliver it.
  const queued = `transfer ${id} stays queued in Blip and may still be delivered (check: blip transfers ${id})`;
  process.on('SIGINT', () => die(`interrupted; ${queued}`, 130));
  process.on('SIGTERM', () => die(`terminated; ${queued}`, 143));
  // From here on the transfer may exist, so an error from Blip ends like a timeout: exit 3 with the transfer id.
  process.removeAllListeners('uncaughtException');
  process.on('uncaughtException', (e) => die(`${e.syscall === 'connect' ? `Blip not reachable (${e.code})` : safe(e.message).slice(0, 200)}; ${queued}`, 3));
  await dispatch('TransferCreateRequested', Buffer.concat([s(1, id), ld(2, peerId(peer))]));
  await dispatch('TransferAddContentRequested', Buffer.concat([s(1, id), ...abs.map((p) => s(2, p))]));
  await dispatch('TransferInviteRequested', Buffer.concat([s(1, id), ld(2, peerId(peer))]));
  console.error(`transfer ${id} -> ${safe(peer.name)}`);
  const begun = Date.now(), deadline = begun + timeout * 1000; let last = '';
  for (;;) {
    const t = (await transfers()).find((x) => x.id === id);
    const line = t ? describe(t) : 'not created yet';
    if (line !== last) { console.error(line); last = line; }
    if (t?.status === 'Completed') process.exit(0);
    if (t?.status === 'Cancelled' || t?.err || t?.remoteErr) die(`transfer ${id} ${t.status === 'Cancelled' ? 'was cancelled' : 'failed'}; Blip may still list it (check: blip transfers ${id})`);
    if (!t && Date.now() - begun > 30000) die(`Blip did not create transfer ${id}, see ${LOG}`);
    if (Date.now() > deadline) die(`timed out waiting (peer offline or not accepting?); ${queued}`, 3);
    await sleep(1000);
  }
}
