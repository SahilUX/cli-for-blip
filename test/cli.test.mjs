// Run with: node --test
// Runs blip.mjs against a fake Blip on a unix socket, with a throwaway HOME. No Blip needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync, statSync, realpathSync, symlinkSync, openSync, chmodSync, renameSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimePaths } from '../platform.mjs';
import { fields, uv } from '../drpc.mjs';

const paths = (home) => runtimePaths(home, process.platform);
const DRPC = new URL('../drpc.mjs', import.meta.url).href;
const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'blip.mjs');
const ld = (tag, b) => Buffer.concat([uv((tag << 3) | 2), uv(b.length), b]);
const s = (tag, v) => ld(tag, Buffer.from(v));
const vi = (tag, n) => Buffer.concat([uv(tag << 3), uv(n)]);
const frame = (kind, msg, data) => Buffer.concat([Buffer.from([(kind << 1) | 1]), uv(1), uv(msg), uv(data.length), data]);
const str = (f) => f?.value.toString('utf8');

const ME = { id: 'user-me', self: true, devices: [{ id: 'dev-here', name: 'server', here: true }, { id: 'dev-phone', name: 'Pixel 8' }] };
const OTHER = { id: 'user-other', self: false, devices: [{ id: 'dev-theirs', name: 'Laptop' }] };

function encodeState(st) {
  const parts = [];
  if (st.email) parts.push(ld(201, s(203, st.email)));
  else parts.push(ld(200, vi(1, st.reg ?? 0)));                        // Registration.status
  const users = (st.users ?? []).map((u) => ld(1, Buffer.concat([s(1, u.id), ld(2, Buffer.concat([vi(10, u.self ? 1 : 0),
    ...u.devices.map((d) => ld(7, Buffer.concat([s(1, d.id), ld(2, Buffer.concat([s(1, d.id), s(3, d.name), vi(6, d.here ? 1 : 0)]))])))]))])));
  parts.push(ld(500, Buffer.concat(users)));
  for (const t of st.transfers) parts.push(ld(600, Buffer.concat([s(1, t.id), ld(2, Buffer.concat([vi(700, 2), vi(800, t.status)]))])));
  return ld(2, Buffer.concat(parts));
}

// A fake Blip that answers GetState from `st` and records Dispatch events. New transfers get status st.newStatus.
// Like drpc, it ends each reply with CloseSend and leaves the connection to the client.
async function fakeBlip(dir, st, { garbage = false } = {}) {
  st.transfers ??= []; st.newStatus ??= 8; st.events = [];
  const path = join(dir, 'sock');
  const server = net.createServer((c) => {
    let buf = Buffer.alloc(0); const got = [];
    c.on('error', () => {});
    c.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {                                                      // frames: control, stream, msg, len, data (all varints < 128 here except len)
        if (buf.length < 4) break;
        let p = 3, len = 0, shift = 0, b;
        do { b = buf[p++]; len |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80);
        if (buf.length < p + len) break;
        got.push({ kind: buf[0] >> 1, data: buf.subarray(p, p + len) }); buf = buf.subarray(p + len);
      }
      if (!got.some((f) => f.kind === 6)) return;
      const method = got[0].data.toString();
      if (garbage) return c.end(Buffer.concat([frame(2, 1, Buffer.from([0x12, 0x40, 0x01])), frame(5, 2, Buffer.alloc(0))]));
      if (method.endsWith('/Dispatch')) {
        const any = fields(fields(got[1].data)[0].value);
        const name = str(any.find((f) => f.tag === 1)).replace('type.googleapis.com/event.', '');
        const ev = fields(any.find((f) => f.tag === 2)?.value ?? Buffer.alloc(0));
        st.events.push({ name, ev });
        if (name === 'TransferCreateRequested') st.transfers.push({ id: str(ev[0]), status: st.newStatus });
        if (name === 'TransferInviteRequested' && st.failAfterInvite) st.failing = true;
        if (name === 'SendRegistrationCodeRequested') st.reg = 2;      // CodeSent
        if (name === 'RegistrationRequested' && str(ev[0]) === '123456') st.email = 'me@example.com';
        return c.write(Buffer.concat([frame(2, 1, Buffer.alloc(0)), frame(6, 2, Buffer.alloc(0))]));
      }
      if (st.failing) return c.write(frame(3, 2, Buffer.concat([Buffer.alloc(8), Buffer.from('boom')])));
      c.write(Buffer.concat([frame(2, 1, encodeState(st)), frame(6, 2, Buffer.alloc(0))]));
    });
  });
  await new Promise((r) => server.listen(path, r));
  return { path, close: () => server.close() };
}

function blip(home, sock, args, extraEnv = {}, { input, stdin = 'pipe' } = {}) {
  const env = { PATH: process.env.PATH, HOME: home, BLIP_SOCK: sock, BLIP_APP: join(home, 'no-app'), ...extraEnv };
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], { env, cwd: home, stdio: [stdin, 'pipe', 'pipe'] });
    if (input !== undefined) p.stdin.end(input);
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => resolve({ code, out, err }));
  });
}

async function setup(st, opts) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'blip-cli-test-')));
  const fake = await fakeBlip(home, st, opts);
  return { home, sock: fake.path, done: () => { fake.close(); rmSync(home, { recursive: true, force: true }); } };
}

test('devices lists only your own devices and marks this one', async () => {
  const { home, sock, done } = await setup({ email: 'me@example.com', users: [ME, OTHER] });
  const r = await blip(home, sock, ['devices']);
  done();
  assert.equal(r.code, 0);
  assert.equal(r.out, 'server (this device)\tdev-here\nPixel 8\tdev-phone\n');
});

test('send creates, fills and invites one transfer, then remembers the device privately', async () => {
  const st = { email: 'me@example.com', users: [ME, OTHER] };
  const { home, sock, done } = await setup(st);
  writeFileSync(join(home, 'a.txt'), 'hi');
  const r = await blip(home, sock, ['send', 'a.txt', '--to', 'pixel 8']);
  const config = paths(home).config;
  const remembered = JSON.parse(readFileSync(config, 'utf8')).to, mode = statSync(config).mode & 0o777;
  done();
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(st.events.map((e) => e.name), ['TransferCreateRequested', 'TransferAddContentRequested', 'TransferInviteRequested']);
  assert.equal(str(st.events[1].ev[1]), join(home, 'a.txt'));
  assert.equal(remembered, 'pixel 8');
  assert.equal(mode, 0o600);
});

test('send never matches a device on someone else\'s account', async () => {
  const st = { email: 'me@example.com', users: [ME, OTHER] };
  const { home, sock, done } = await setup(st);
  writeFileSync(join(home, 'a.txt'), 'hi');
  const r = await blip(home, sock, ['send', 'a.txt', '--to', 'Laptop']);
  done();
  assert.equal(r.code, 1);
  assert.match(r.err, /no such device "Laptop"/);
  assert.equal(st.events.length, 0);
});

test('send refuses folders that hold Blip\'s own data, and empty paths', async () => {
  const st = { email: 'me@example.com', users: [ME] };
  const { home, sock, done } = await setup(st);
  mkdirSync(join(home, '.local/share/net.blip.Blip'), { recursive: true });
  const results = [];
  for (const p of [home, '/', join(home, '.local'), join(home, '.local/share/net.blip.Blip')]) results.push(await blip(home, sock, ['send', p, '--to', 'Pixel 8']));
  const empty = await blip(home, sock, ['send', '', '--to', 'Pixel 8']);
  done();
  for (const r of results) { assert.equal(r.code, 1); assert.match(r.err, /refusing to send .*Blip's own data/); }
  assert.equal(empty.code, 2);
  assert.equal(st.events.length, 0);
});

test('send refuses devices, FIFOs and links to them', async () => {
  const st = { email: 'me@example.com', users: [ME] };
  const { home, sock, done } = await setup(st);
  execFileSync('mkfifo', [join(home, 'pipe')]);
  symlinkSync('/dev/null', join(home, 'null-link'));
  const results = [];
  for (const p of ['/dev/null', join(home, 'pipe'), join(home, 'null-link')]) results.push(await blip(home, sock, ['send', p, '--to', 'Pixel 8']));
  done();
  for (const r of results) { assert.equal(r.code, 1); assert.match(r.err, /refusing to send .*: not a regular file or folder/); }
  assert.equal(st.events.length, 0);
});

test('native startup reports missing installation', async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'blip-cli-test-')));
  try {
    const r = await blip(home, join(home, 'sock'), ['start']);
    assert.equal(r.code, 1);
    assert.match(r.err, /Blip is not installed/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('native startup checks its library and socket name', { skip: !['linux', 'darwin'].includes(process.platform) }, async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'blip-cli-test-')));
  try {
    const env = { BLIP_APP: process.execPath, BLIP_LIB: join(home, 'missing.so') };
    const missing = await blip(home, join(home, 'sock'), ['start'], env);
    assert.equal(missing.code, 1); assert.match(missing.err, /Blip core is not installed/);
    const path = await blip(home, join(home, 'other-socket'), ['start'], { ...env, BLIP_LIB: process.execPath });
    assert.equal(path.code, 1); assert.equal(path.err, 'native startup requires BLIP_SOCK to end in /sock\n');
    const long = await blip(home, '/' + 'é'.repeat(60) + '/sock', ['start'], { ...env, BLIP_LIB: process.execPath });
    assert.equal(long.code, 1); assert.match(long.err, /socket path is too long/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('send refuses /dev/stdin and links to it, which the app would open as its own stdin', async () => {
  const st = { email: 'me@example.com', users: [ME] };
  const { home, sock, done } = await setup(st);
  writeFileSync(join(home, 'a.txt'), 'hi');
  symlinkSync('/dev/stdin', join(home, 'in-link'));
  const results = [];
  for (const p of ['/dev/stdin', join(home, 'in-link')]) results.push(await blip(home, sock, ['send', p, '--to', 'Pixel 8'], {}, { stdin: openSync(join(home, 'a.txt'), 'r') }));
  done();
  for (const r of results) { assert.equal(r.code, 1); assert.match(r.err, /refusing to send .*: not a regular file or folder/); }
  assert.equal(st.events.length, 0);
});

test('a dangling link named like an option is refused too', async () => {
  const { home, sock, done } = await setup({ email: 'me@example.com', users: [ME] });
  symlinkSync(join(home, 'gone'), join(home, '--help'));
  const r = await blip(home, sock, ['send', '--help']);
  done();
  assert.equal(r.code, 2); assert.match(r.err, /is a file but reads as an option/);
});

test('send ignores a remembered device that is not a string', async () => {
  const st = { email: 'me@example.com', users: [ME] };
  const { home, sock, done } = await setup(st);
  writeFileSync(join(home, 'a.txt'), 'hi');
  mkdirSync(dirname(paths(home).config), { recursive: true });
  writeFileSync(paths(home).config, '{"to": 5}');
  const r = await blip(home, sock, ['send', 'a.txt']);                  // falls back to the only other device
  done();
  assert.equal(r.code, 0, r.err);
});

test('an error from Blip after the transfer exists keeps the transfer id, exit 3', async () => {
  const st = { email: 'me@example.com', users: [ME], newStatus: 5, failAfterInvite: true };
  const { home, sock, done } = await setup(st);
  writeFileSync(join(home, 'a.txt'), 'hi');
  const r = await blip(home, sock, ['send', 'a.txt']);
  done();
  assert.equal(r.code, 3);
  assert.match(r.err, /drpc error: boom; transfer .* stays queued in Blip/);
});

test('login reads piped answers, and stops cleanly when the input ends', async () => {
  const st = { users: [] };
  const { home, sock, done } = await setup(st);
  const eof = await blip(home, sock, ['login', 'me@example.com'], { BLIP_DEVICE_NAME: ' ' }, { input: '' });
  const agent = fields(st.events.find((e) => e.name === 'SetUserAgent').ev[0].value);
  assert.equal(agent.find((f) => f.tag === 102).value, 5);
  assert.equal(str(agent.find((f) => f.tag === 301)), 'blip-cli');
  const sentName = str(st.events.find((e) => e.name === 'SendRegistrationCodeRequested').ev.find((f) => f.tag === 2));
  st.reg = 0;
  const piped = await blip(home, sock, ['login'], {}, { input: 'me@example.com\n123456\n' });
  done();
  assert.equal(eof.code, 1); assert.match(eof.err, /sign-in cancelled: no more input/);
  assert.equal(sentName, hostname().split('.')[0]);                     // a blank BLIP_DEVICE_NAME counts as unset
  assert.equal(piped.code, 0, piped.err); assert.match(piped.err, /signed in as me@example.com/);
});

test('a send that times out says the transfer is still queued', async () => {
  const st = { email: 'me@example.com', users: [ME], newStatus: 5 };
  const { home, sock, done } = await setup(st);
  writeFileSync(join(home, 'a.txt'), 'hi');
  const r = await blip(home, sock, ['send', 'a.txt'], { BLIP_TIMEOUT_S: '1' });
  done();
  assert.equal(r.code, 3);
  assert.match(r.err, /timed out waiting .*stays queued in Blip/);
});

test('an unexpected reply is an error, not a reason to start a second Blip', async () => {
  const { home, sock, done } = await setup({}, { garbage: true });
  const r = await blip(home, sock, ['status']);
  done();
  assert.equal(r.code, 1);
  assert.match(r.err, /unexpected reply from Blip/);
  assert.doesNotMatch(r.err, /not installed|starting Blip/);
});

test('stop ignores a pid file that does not name a process blip started', async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'blip-cli-test-')));
  mkdirSync(paths(home).own, { recursive: true });
  writeFileSync(join(paths(home).own, 'pid'), '-1');
  const r = await blip(home, join(home, 'no-sock'), ['stop']);
  const left = existsSync(join(paths(home).own, 'pid'));
  rmSync(home, { recursive: true, force: true });
  assert.equal(r.code, 0);
  assert.equal(r.err, 'Blip is not running\n');
  assert.equal(left, false);
});

test('send matches a device by id, and treats an empty --to as unset', async () => {
  const st = { email: 'me@example.com', users: [ME] };
  const { home, sock, done } = await setup(st);
  writeFileSync(join(home, 'a.txt'), 'hi');
  const byId = await blip(home, sock, ['send', 'a.txt', '--to', 'dev-phone']);
  const empty = await blip(home, sock, ['send', 'a.txt', '--to=']);
  done();
  assert.equal(byId.code, 0, byId.err);
  assert.equal(empty.code, 0, empty.err);                             // falls back to the remembered device
});

test('send checks its arguments before it touches Blip', async () => {
  const st = { email: 'me@example.com', users: [ME] };
  const { home, sock, done } = await setup(st);
  writeFileSync(join(home, '--help'), 'x');
  writeFileSync(join(home, 'a.txt'), 'hi');
  const flagFile = await blip(home, sock, ['send', '--help', '--to', 'Pixel 8']);
  const badTimeout = await blip(home, sock, ['send', 'a.txt'], { BLIP_TIMEOUT_S: '0' });
  const missing = await blip(home, join(home, 'no-sock'), ['send', 'nope.txt']);
  const dashed = await blip(home, sock, ['send', '--to', 'Pixel 8', '--', '--help']);
  done();
  assert.equal(flagFile.code, 2); assert.match(flagFile.err, /is a file but reads as an option/);
  assert.equal(badTimeout.code, 2); assert.match(badTimeout.err, /BLIP_TIMEOUT_S must be a positive number/);
  assert.equal(missing.code, 1); assert.match(missing.err, /^not found: /);
  assert.equal(dashed.code, 0, dashed.err);
  assert.equal(st.events.filter((e) => e.name === 'TransferCreateRequested').length, 1);
});

test('status does not start Blip', async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'blip-cli-test-')));
  const r = await blip(home, join(home, 'no-sock'), ['status']);
  rmSync(home, { recursive: true, force: true });
  assert.equal(r.code, 1);
  assert.equal(r.out, 'Blip is not running (run: blip start)\n');
  assert.equal(r.err, '');
});

test('transfers reports an unknown id, and devices escapes control characters in names', async () => {
  const st = { email: 'me@example.com', users: [{ ...ME, devices: [{ id: 'dev-here', name: 'evil\x1b[2Jname', here: true }] }] };
  st.transfers = [{ id: 't1', status: 9 }];
  const { home, sock, done } = await setup(st);
  const unknown = await blip(home, sock, ['transfers', 'nope']);
  const devices = await blip(home, sock, ['devices']);
  done();
  assert.equal(unknown.code, 1); assert.match(unknown.err, /no such transfer: nope/);
  assert.equal(devices.out, 'evil\\u001b[2Jname (this device)\tdev-here\n');
});

test('a socket that is not a socket is refused', async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'blip-cli-test-')));
  writeFileSync(join(home, 'fake-sock'), '');
  const r = await blip(home, join(home, 'fake-sock'), ['devices']);
  rmSync(home, { recursive: true, force: true });
  assert.equal(r.code, 1);
  assert.match(r.err, /refusing .*fake-sock: it is not a socket you own/);
});

// A detached child serving a minimal RPC state exercises the CLI's real Linux
// pid/starttime checks without a Blip installation or account.
test('native lifecycle starts one private daemon without display tools and stops only its own process', { skip: !['linux', 'darwin'].includes(process.platform), timeout: 15000 }, async (t) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'blip-cli-life-')));
  const cache = join(home, 'shared-cache'), sock = join(cache, 'sock');
  mkdirSync(cache); chmodSync(cache, 0o750);
  const app = join(home, 'fake-core.mjs'), lib = join(home, 'fake.so');
  const env = { BLIP_APP: app, BLIP_LIB: lib, PATH: '/nonexistent' };
  t.after(async () => { await blip(home, sock, ['stop'], env); rmSync(home, { recursive: true, force: true }); });
  const helper = join(home, 'identity-helper');
  execFileSync('cc', ['-std=c11', '-O2', join(dirname(CLI), 'native/host.c'), '-ldl', '-o', helper]);
  writeFileSync(lib, 'fixture');
  const response = Buffer.concat([frame(2, 1, encodeState({ transfers: [] })), frame(6, 2, Buffer.alloc(0))]);
  writeFileSync(app, `#!${process.execPath}
import net from 'node:net';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
if (process.argv[2] === '--identity') {
  try { process.stdout.write(execFileSync(${JSON.stringify(helper)}, process.argv.slice(2))); }
  catch (e) { process.exit(e.status ?? 3); }
  process.exit(0);
}
const [lib, cache, data] = process.argv.slice(2);
fs.writeFileSync(data + '/launch.json', JSON.stringify({ args: process.argv.slice(2), tmp: process.env.TMPDIR, pid: process.pid }));
const server = net.createServer(c => {
  c.on('error', () => {});
  c.once('data', b => {
    const dispatch = b.includes(Buffer.from('/Dispatch'));
    if (dispatch) fs.appendFileSync(data + '/events', b);
    if (dispatch) setTimeout(() => { fs.writeFileSync(data + '/initialized', 'ready'); c.end(Buffer.from('050102000d010300', 'hex')); }, 500);
    else c.end(Buffer.from('${response.toString('hex')}', 'hex'));
  });
});
server.listen(cache + '/sock');
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`, { mode: 0o700 });
  const firstStart = blip(home, sock, ['start'], env);
  const until = Date.now() + 3000;
  while (!existsSync(sock) && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
  assert.equal(existsSync(sock), true);
  // The second command sees a listening socket while initialization is still
  // in flight. It must wait for the starter, rather than returning early.
  const secondStart = await blip(home, sock, ['start'], env);
  assert.equal(existsSync(join(paths(home).data, 'initialized')), true);
  const starts = [await firstStart, secondStart];
  for (const r of starts) assert.equal(r.code, 0, r.err);
  assert.equal(starts.filter(r => /starting Blip/.test(r.err)).length, 1);
  const launch = JSON.parse(readFileSync(join(paths(home).data, 'launch.json'), 'utf8'));
  assert.deepEqual(launch.args, [lib, cache, paths(home).data]);
  assert.equal(launch.tmp, join(paths(home).own, 'tmp'));
  assert.ok(readFileSync(join(paths(home).data, 'events')).includes(Buffer.from('event.SetUserAgent')));
  assert.equal(statSync(cache).mode & 0o777, 0o750, 'custom directory permissions must be preserved');
  for (const path of [paths(home).data, paths(home).own]) assert.equal(statSync(path).mode & 0o777, 0o700);
  assert.equal(statSync(join(paths(home).own, 'app.log')).mode & 0o777, 0o600);
  const status = await blip(home, sock, ['status'], env);
  assert.equal(status.code, 0); assert.match(status.out, /running in the background/);
  const pidFile = join(paths(home).own, 'pid');
  const ownership = readFileSync(pidFile, 'utf8');
  if (process.platform === 'darwin') {
    renameSync(helper, `${helper}.absent`);
    const broken = await blip(home, sock, ['stop'], env);
    assert.equal(broken.code, 1); assert.match(broken.err, /could not verify Blip process/);
    assert.equal(readFileSync(pidFile, 'utf8'), ownership, 'helper failure must preserve the ownership record');
    assert.doesNotThrow(() => process.kill(launch.pid, 0));
    renameSync(`${helper}.absent`, helper);
  }
  const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => other.kill('SIGTERM'));
  let group, since;
  if (process.platform === 'darwin') {
    [, group, since] = execFileSync(helper, ['--identity', String(other.pid)], { encoding: 'utf8' }).trim().split(' ');
  } else {
    const raw = readFileSync(`/proc/${other.pid}/stat`, 'utf8');
    const st = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
    group = st[2]; since = st[19];
  }
  assert.notEqual(group, String(other.pid));
  writeFileSync(pidFile, `${other.pid} ${since}`);
  const nonLeader = await blip(home, sock, ['stop'], env);
  assert.equal(nonLeader.code, 1); assert.match(nonLeader.err, /blip did not start it/);
  assert.doesNotThrow(() => process.kill(other.pid, 0), 'a matching timestamp without process-group ownership must be refused');
  other.kill('SIGTERM');
  writeFileSync(pidFile, `${launch.pid} incorrect-start-time`);
  const refused = await blip(home, sock, ['stop'], env);
  assert.equal(refused.code, 1); assert.match(refused.err, /blip did not start it/);
  assert.doesNotThrow(() => process.kill(launch.pid, 0), 'a mismatched start time must not signal the process');
  writeFileSync(pidFile, ownership);
  const stopped = await blip(home, sock, ['stop'], env);
  assert.equal(stopped.code, 0, stopped.err); assert.match(stopped.err, /Blip stopped/);
  assert.equal(existsSync(join(paths(home).own, 'tmp')), false);
  assert.throws(() => process.kill(launch.pid, 0), { code: 'ESRCH' });
});

test('stop refuses a running instance it did not start', async () => {
  const { home, sock, done } = await setup({ users: [] });
  try {
    const r = await blip(home, sock, ['stop']);
    assert.equal(r.code, 1);
    assert.equal(r.err, 'Blip is running, but blip did not start it (a service or the desktop app?). Stop it there\n');
  } finally { done(); }
});

test('send protects the active profile and the Mac desktop container through links', async () => {
  const st = { email: 'me@example.com', users: [ME] };
  const { home, sock, done } = await setup(st);
  try {
    for (const data of [paths(home).data, join(home, 'Library/Group Containers/AY8UB8KTUX.blip')]) {
      mkdirSync(data, { recursive: true });
      if (process.platform === 'darwin') {
        const lower = await blip(home, sock, ['send', data.toLowerCase(), '--to', 'Pixel 8']);
        // This Mac uses case-insensitive APFS. On a case-sensitive volume the
        // alternate spelling may simply be absent, which is also safe.
        assert.equal(lower.code, 1); assert.match(lower.err, /Blip's own data|not found/);
      }
      const link = join(home, 'profile-link');
      symlinkSync(data, link);
      const r = await blip(home, sock, ['send', link, '--to', 'Pixel 8']);
      assert.equal(r.code, 1); assert.match(r.err, /Blip's own data/);
      rmSync(link);
    }
    assert.equal(st.events.length, 0);
  } finally { done(); }
});
