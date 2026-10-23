#!/usr/bin/env node
// blip: headless command line for the Blip native engine, over its local DRPC socket.
// Reverse-engineered from Blip 1.2.6 (Go core, storj.io/drpc v0.0.32, service
// /rpc.Service/{GetState,Dispatch}, events packed as protobuf Any). Needs Node >= 22.
// Every command except status and stop starts the native engine in the background if it isn't running.
// Sends only to the signed-in account's own devices; matching is by device id or exact name, case-insensitive.
//   blip login [email]            sign in with the code Blip emails you
//   blip logout                   sign out and remove this device from the account
//   blip send <path>... [--to d]  send files/folders to one of your devices, wait for completion
//   blip devices | transfers [id] | status | start | stop
import { randomUUID } from 'node:crypto';
import { resolve, dirname, basename } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync, openSync, rmSync, renameSync, chmodSync, realpathSync, statSync, lstatSync, readlinkSync } from 'node:fs';
import { homedir, hostname, type, release } from 'node:os';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { call, fields, uv } from './drpc.mjs';

const HOME = homedir();
const HERE = dirname(fileURLToPath(import.meta.url));                                     // this checkout, for the install hint
const SOCK = process.env.BLIP_SOCK ?? `${HOME}/.cache/net.blip.Blip/sock`;
const APP = resolve(process.env.BLIP_APP ?? `${HOME}/.local/lib/blip-cli/blip-core`);
const LIB = resolve(process.env.BLIP_LIB ?? `${HOME}/.local/lib/blip-cli/libblip.so`);
const DATA = `${HOME}/.local/share/net.blip.Blip`;
const OWN = `${HOME}/.cache/blip-cli`;                                                     // pid file, start lock and app log, private to the user
const PIDFILE = `${OWN}/pid`, LOCK = `${OWN}/start.lock`, LOG = `${OWN}/app.log`;
const TMP = `${OWN}/tmp`;                                                                   // private TMPDIR for the engine
const XDG = process.env.XDG_CONFIG_HOME;
const CONFIG = `${XDG?.startsWith('/') ? XDG : `${HOME}/.config`}/blip-cli/config.json`;   // remembered --to device
const STATUS = ['Unknown', 'Created', 'InviteRequested', 'Invited', 'Pending', 'Active', 'Paused', 'ResumeRequested', 'Completed', 'Cancelled'];
const REG = ['NotStarted', 'SendingCode', 'CodeSent', 'Registering'];                     // frontend.Registration.status
const USAGE = `usage: blip <command>
  login [email] [--name <device name>]   sign in with the code Blip emails you
  logout                                 sign out and remove this device from your account
  send <path>... [--to <device>]         send files or folders and wait until they arrive
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
  if (auth) return { email: str(fields(auth.value).find((f) => f.tag === 203)) };
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
// needs it too, especially before registering a fresh device.
const initializeCore = () => dispatch('SetUserAgent', ld(1, Buffer.concat([
  vi(102, 5), s(200, type()), s(201, release()), s(300, 'net.blip.blip-cli'),
  s(301, 'blip-cli'), s(302, '1.2.6'),
])));

// Background native engine. The same socket can also belong to a separately running desktop app.
// Only "nothing listens on the socket" means Blip isn't running; a hung or incompatible app is an error, not a reason to start a second one.
const reachable = () => getState().then(() => true, (e) => { if (e.syscall === 'connect' && ['ENOENT', 'ECONNREFUSED'].includes(e.code)) return false; throw e; });
const answers = () => getState().then(() => true, () => false);                          // while starting or stopping, any failure means "not yet"
const running = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
// /proc/<pid>/stat fields after the command name: [0] is field 3 (state), [2] pgrp, [19] starttime.
const procStat = (pid) => { try { const t = readFileSync(`/proc/${pid}/stat`, 'utf8'); return t.slice(t.lastIndexOf(')') + 2).split(' '); } catch { return null; } };
// The pid file holds "<pid> <starttime>", so a reused pid after a reboot or crash never matches.
function ownPid() {
  let pid, since;
  try { [pid, since] = readFileSync(PIDFILE, 'utf8').trim().split(' '); } catch { return 0; }
  const st = /^[1-9][0-9]*$/.test(pid) && procStat(pid);
  if (st && st[2] === pid && st[19] === since && !'ZX'.includes(st[0])) return Number(pid);   // a zombie (no reaping init in a container) has exited
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
  if (!existsSync(APP)) die(`Blip is not installed at ${APP}. Install it with ${HERE}/install.sh (or set BLIP_APP)`);
  if (process.platform !== 'linux') die('starting the native Blip core is supported only on Linux');
  if (!existsSync(LIB)) die(`Blip core is not installed at ${LIB}. Run ${HERE}/install.sh (or set BLIP_LIB)`);
  if (basename(SOCK) !== 'sock') die('native startup requires BLIP_SOCK to end in /sock');
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
      if (path === DATA || path === `${HOME}/.cache/net.blip.Blip`) chmodSync(path, 0o700);
    }
    const log = openSync(LOG, 'a', 0o600);                                             // append mode for native diagnostics
    process.umask(process.umask(0o022) | 0o022);                                           // the app creates its socket under this umask: no one else may write to (connect to) it
    const child = spawn(argv[0], argv.slice(1), { cwd: HOME, env: { ...process.env, TMPDIR: TMP }, detached: true, stdio: ['ignore', log, log] });
    let gone = false; child.on('exit', () => { gone = true; }); exited = () => gone;
    child.on('error', (e) => die(`could not run ${argv[0]}: ${e.message}`));
    writeFileSync(PIDFILE, `${child.pid} ${procStat(child.pid)?.[19]}`, { mode: 0o600 }); child.unref();
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
async function signedIn() {
  let me = session(await getState());
  for (let i = 0; !me.email && started && i < 10; i++) { await sleep(500); me = session(await getState()); }   // a freshly started app may still be loading its session
  if (!me.email) die('not signed in (run: blip login)');
  return me;
}

async function ownDevices() {
  const users = fields((await getState()).find((f) => f.tag === 500)?.value ?? Buffer.alloc(0));
  const self = entries(users, 1).filter(({ val }) => fields(val).find((f) => f.tag === 10)?.value === 1); // is_self
  const out = self.flatMap(({ key: userId, val }) => entries(fields(val), 7).map(({ val: dev }) => {
    const d = fields(dev); const g = (t) => d.find((f) => f.tag === t);
    return { userId, deviceId: str(g(1)), name: str(g(3)), isThis: g(6)?.value === 1 };
  }));
  // Cross-check the reverse-engineered is_self flag: exactly one user is you, and it owns this device.
  if (self.length !== 1 || !out.some((d) => d.isThis)) die("can't tell which devices are yours (is this a supported Blip version?)");
  return out;
}
async function transfers() {
  return entries(await getState(), 600).map(({ key, val }) => {
    const t = fields(val); const g = (n) => t.find((f) => f.tag === n);
    const error = (n) => (g(n) ? str(fields(g(n).value).find((f) => f.tag === 2)) : '');  // 600 local error, 601 the other device's error
    const status = g(800)?.value ?? 0;
    return { id: key, status: STATUS[status] ?? `status ${status}`, direction: g(700)?.value === 2 ? 'out' : 'in', err: error(600), remoteErr: error(601) };
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
const config = () => { try { const c = JSON.parse(readFileSync(CONFIG, 'utf8')); return c && typeof c === 'object' ? c : {}; } catch { return {}; } };

process.on('uncaughtException', (e) => {
  if (e.syscall === 'connect') console.error(`Blip not reachable at ${SOCK} (${e.code}). It may have exited, see ${LOG} (set BLIP_SOCK if the socket lives elsewhere)`);
  else console.error(safe(e.message).slice(0, 500));
  process.exit(1);
});
process.on('unhandledRejection', (e) => { throw e; });

let opts;
try {
  opts = parseArgs({ allowPositionals: true, tokens: true, options: { to: { type: 'string', short: 't' }, name: { type: 'string' }, help: { type: 'boolean', short: 'h' } } });
} catch (e) { die(`${e.message}\n${USAGE}`, 2); }
const [cmd, ...args] = opts.positionals; const { values: flag } = opts;
const there = (p) => { try { lstatSync(p); return true; } catch { return false; } };   // a dangling link is there too
// A glob like `blip send *` can expand to a file named --help or --to=x: refuse it rather than read it as an option.
for (const t of opts.tokens) {
  const raw = process.argv[2 + t.index];
  if (t.kind === 'option' && there(raw)) die(`"${raw}" is a file but reads as an option. Put paths after -- (blip send -- <path>...) or start them with ./`, 2);
}
if (!cmd || cmd === 'help' || flag.help) { console.log(USAGE); process.exit(cmd || flag.help ? 0 : 2); }
if (!['login', 'logout', 'send', 'devices', 'transfers', 'status', 'start', 'stop'].includes(cmd)) die(USAGE, 2);

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
  const data = existsSync(DATA) && realpathSync(DATA);                                     // never ship the session: refuse DATA, anything in it, and its parents (~, /)
  if (data) for (const p of abs) { const r = realpathSync(p); if (r === data || r.startsWith(`${data}/`) || data.startsWith(r === '/' ? '/' : `${r}/`)) die(`refusing to send ${p}: it contains Blip's own data, including your session`); }
}

if (cmd === 'stop') { await stop(); process.exit(0); }
if (cmd === 'status' && !(await reachable())) { console.log('Blip is not running (run: blip start)'); process.exit(1); }
const started = await start();
if (cmd === 'start') {
  console.error(started ? 'Blip is running in the background' : 'Blip is already running');
} else if (cmd === 'status') {
  const me = session(await getState());
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
  const me = session(await getState());
  if (!me.email) die('not signed in', 0);
  await dispatch('RemoveDeviceThenLogout');
  await waitFor((st) => !session(st).email, 30000, 'Blip to sign out');
  console.error(`signed out of ${safe(me.email)}`);
} else if (cmd === 'devices') {
  await signedIn();
  for (const d of await ownDevices()) console.log(`${safe(d.name)}${d.isThis ? ' (this device)' : ''}\t${safe(d.deviceId)}`);
} else if (cmd === 'transfers') {
  await signedIn();
  const list = (await transfers()).filter((t) => !args[0] || t.id === args[0]);
  if (args[0] && !list.length) die(`no such transfer: ${safe(args[0])}`);
  for (const t of list) console.log(`${safe(t.id)}\t${t.direction}\t${t.status}${t.err ? `\terr=${safe(t.err)}` : ''}${t.remoteErr ? `\tremote=${safe(t.remoteErr)}` : ''}`);
} else if (cmd === 'send') {
  await signedIn();
  const others = (await ownDevices()).filter((d) => !d.isThis);
  const remembered = typeof config().to === 'string' ? config().to : '';
  const device = flag.to || process.env.BLIP_TO || remembered || (others.length === 1 ? others[0].name : '');
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
