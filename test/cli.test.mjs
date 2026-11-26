// Run with: node --test
// Runs blip.mjs against a fake Blip on a unix socket, with a throwaway HOME. No Blip needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync, existsSync, readFileSync, statSync, realpathSync, symlinkSync, openSync, chmodSync, renameSync } from 'node:fs';
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
  if (st.email) parts.push(ld(201, Buffer.concat([s(203, st.email), s(204, st.deviceId ?? 'dev-here')])));
  else parts.push(ld(200, vi(1, st.reg ?? 0)));                        // Registration.status
  const users = (st.users ?? []).map((u) => ld(1, Buffer.concat([s(1, u.id), ld(2, Buffer.concat([vi(10, u.self ? 1 : 0),
    ...u.devices.map((d) => ld(7, Buffer.concat([s(1, d.id), ld(2, Buffer.concat([s(1, d.id), s(3, d.name), vi(6, d.here ? 1 : 0)]))])))]))])));
  parts.push(ld(500, Buffer.concat(users)));
  if (st.synced ?? true) parts.push(ld(400, vi(3, 1)));          // Messaging.initial_sync_complete
  if (st.config) parts.push(ld(100, Buffer.concat([vi(2, st.config.autoAcceptDisabled ? 1 : 0), ...(st.config.folder ? [s(4, st.config.folder)] : [])])));
  for (const t of st.transfers) parts.push(ld(600, Buffer.concat([s(1, t.id), ld(2, Buffer.concat([vi(700, t.direction ?? 2), vi(800, t.status), ...(t.saved ? [s(501, t.saved)] : []), ...(t.err ? [ld(600, s(2, t.err))] : [])]))])));
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
        const acted = st.transfers.find((t) => ev[0] && t.id === str(ev[0]));
        if (acted && name === 'TransferAcceptanceRequested' && st.afterAccept) acted.status = st.afterAccept;
        if (acted && name === 'TransferDeclineRequested') st.transfers.splice(st.transfers.indexOf(acted), 1);
        if (name === 'SendRegistrationCodeRequested') st.reg = 2;      // CodeSent
        if (name === 'RemoveDeviceThenLogout') { st.onLogout?.(); if (!st.stuck) st.email = ''; if (st.dieOnLogout) st.failing = true; }
        if (name === 'RegistrationRequested' && str(ev[0]) === '123456') st.email = 'me@example.com';
        return c.write(Buffer.concat([frame(2, 1, Buffer.alloc(0)), frame(6, 2, Buffer.alloc(0))]));
      }
      st.reads = (st.reads ?? 0) + 1;
      if (st.syncAfter && st.reads >= st.syncAfter) { st.users = st.later; st.synced = true; }
      if (st.syncAt !== undefined && Date.now() >= st.syncAt) { st.users = st.later; st.synced = true; }
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
  assert.equal(str(agent.find((f) => f.tag === 300)), 'io.github.sahilux.blip-cli');
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

test('status reads Blip once and never starts it, even if Blip stops meanwhile', async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'blip-cli-test-')));
  const sock = join(home, 'sock'), app = join(home, 'app'), launched = join(home, 'launched');
  writeFileSync(app, `#!/bin/sh\ntouch '${launched}'\n`, { mode: 0o700 });
  const reply = Buffer.concat([frame(2, 1, encodeState({ users: [], transfers: [] })), frame(6, 2, Buffer.alloc(0))]);
  const server = net.createServer((c) => { c.on('error', () => {}); c.once('data', () => { c.end(reply); server.close(); }); });
  await new Promise((r) => server.listen(sock, r));
  const r = await blip(home, sock, ['status'], { BLIP_APP: app, BLIP_LIB: app });
  const started = existsSync(launched);
  rmSync(home, { recursive: true, force: true });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, 'Blip is running\nnot signed in (run: blip login)\n');
  assert.equal(started, false, 'status must not launch Blip');
});

test('native startup refuses a socket folder that others can write to', { skip: !['linux', 'darwin'].includes(process.platform) }, async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'blip-cli-test-')));
  const shared = join(home, 'shared'), app = join(home, 'app'), launched = join(home, 'launched');
  mkdirSync(shared); chmodSync(shared, 0o777);
  writeFileSync(app, `#!/bin/sh\ntouch '${launched}'\n`, { mode: 0o700 });
  const r = await blip(home, join(shared, 'sock'), ['start'], { BLIP_APP: app, BLIP_LIB: app });
  const started = existsSync(launched);
  rmSync(home, { recursive: true, force: true });
  assert.equal(r.code, 1);
  assert.equal(r.err, `refusing ${shared} for BLIP_SOCK: Blip keeps its cache there, so it must be a folder you own that no one else can write to\n`);
  assert.equal(started, false);
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
    if (process.platform === 'darwin') {
      // realpath keeps the Data volume firmlink and the /.nofollow prefix, which name the same files.
      for (const alias of [`/System/Volumes/Data${paths(home).data}`, `/.nofollow${paths(home).data}`, `/System/Volumes/Data${home}`, '/System/Volumes/Data']) {
        const r = await blip(home, sock, ['send', alias, '--to', 'Pixel 8']);
        assert.equal(r.code, 1, alias); assert.match(r.err, /Blip's own data/, alias);
      }
    }
    const linkedHome = `${home}-link`;
    symlinkSync(home, linkedHome);
    try {
      const desktop = realpathSync.native(join(home, 'Library/Group Containers/AY8UB8KTUX.blip'));
      const r = await blip(linkedHome, sock, ['send', desktop, '--to', 'Pixel 8']);
      assert.equal(r.code, 1); assert.match(r.err, /Blip's own data/);
    } finally { rmSync(linkedHome); }
    assert.equal(st.events.length, 0);
  } finally { done(); }
});

const IN = (id, status = 3, extra = {}) => ({ id, status, direction: 1, ...extra });

test('every command makes the folder incoming files go to, since the engine fails on a missing one', async () => {
  const st = { email: 'me@example.com', users: [ME] };
  const { home, sock, done } = await setup(st);
  const r = await blip(home, sock, ['devices']);
  const made = existsSync(join(home, 'Downloads'));
  st.config = { folder: join(home, 'elsewhere/in') };
  const r2 = await blip(home, sock, ['devices']);
  const custom = existsSync(join(home, 'elsewhere/in'));
  done();
  assert.equal(r.code, 0); assert.equal(r2.code, 0);
  assert.ok(made); assert.ok(custom);
  assert.match(r.err, /created .*Downloads for incoming files/);
});

test('a folder that cannot be made is a warning, not a failure', async () => {
  const st = { email: 'me@example.com', users: [ME] };
  const { home, sock, done } = await setup(st);
  writeFileSync(join(home, 'Downloads'), 'a file in the way');
  const r = await blip(home, sock, ['devices']);
  done();
  assert.equal(r.code, 0);
  assert.match(r.err, /warning: can't use .*Downloads for incoming files/);
});

test('accept sends the transfer id, and --dir adds the folder', async () => {
  const st = { email: 'me@example.com', users: [ME], transfers: [IN('t1'), IN('t2')], afterAccept: 5 };
  const { home, sock, done } = await setup(st);
  const a = await blip(home, sock, ['accept', 't1']);
  const b = await blip(home, sock, ['accept', 't2', '--dir', 'got']);
  done();
  assert.equal(a.code, 0, a.err); assert.equal(b.code, 0, b.err);
  assert.equal(a.out, 't1\tActive\n');
  const acc = st.events.filter((e) => e.name === 'TransferAcceptanceRequested');
  assert.equal(acc.length, 2);
  assert.equal(str(acc[0].ev[0]), 't1'); assert.equal(acc[0].ev.length, 1);
  assert.equal(str(acc[1].ev[1]), join(home, 'got'));
});

test('accept without an id takes every waiting incoming transfer and nothing else', async () => {
  const st = { email: 'me@example.com', users: [ME], transfers: [IN('a'), IN('b'), IN('done', 8), { id: 'mine', status: 3 }], afterAccept: 5 };
  const { home, sock, done } = await setup(st);
  const r = await blip(home, sock, ['accept']);
  const none = await blip(home, sock, ['accept']);
  done();
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(st.events.filter((e) => e.name === 'TransferAcceptanceRequested').map((e) => str(e.ev[0])), ['a', 'b']);
});

test('accept and decline refuse outgoing, finished and unknown transfers', async () => {
  const st = { email: 'me@example.com', users: [ME], transfers: [{ id: 'mine', status: 3 }, IN('done', 8)] };
  const { home, sock, done } = await setup(st);
  const out = await blip(home, sock, ['accept', 'mine']);
  const fin = await blip(home, sock, ['decline', 'done']);
  const none = await blip(home, sock, ['accept', 'nope']);
  const bare = await blip(home, sock, ['decline']);
  done();
  assert.equal(out.code, 1); assert.match(out.err, /outgoing transfer/);
  assert.equal(fin.code, 1); assert.match(fin.err, /already Completed/);
  assert.equal(none.code, 1); assert.match(none.err, /no such transfer: nope/);
  assert.equal(bare.code, 2);
  assert.equal(st.events.length, 0);
});

test('decline sends the decline event and reports it', async () => {
  const st = { email: 'me@example.com', users: [ME], transfers: [IN('t1')] };
  const { home, sock, done } = await setup(st);
  const r = await blip(home, sock, ['decline', 't1']);
  done();
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, 't1\tdeclined\n');
  assert.equal(st.events[0].name, 'TransferDeclineRequested');
});

test('an accept that leaves the transfer Invited fails with the engine\'s error', async () => {
  const st = { email: 'me@example.com', users: [ME], transfers: [IN('t1', 3, { err: 'stat /x: no such file or directory' })] };
  const { home, sock, done } = await setup(st);
  const r = await blip(home, sock, ['accept', 't1'], { BLIP_TIMEOUT_S: '1' });
  done();
  assert.equal(r.code, 1);
  assert.match(r.err, /t1 is still Invited after accept: Invited err=stat \/x/);
});

test('transfers shows where a received transfer was saved', async () => {
  const st = { email: 'me@example.com', users: [ME], transfers: [IN('t1', 8, { saved: '/home/x/Downloads/a.txt' })] };
  const { home, sock, done } = await setup(st);
  const r = await blip(home, sock, ['transfers']);
  done();
  assert.equal(r.out, 't1\tin\tCompleted\tsaved=/home/x/Downloads/a.txt\n');
});

// What the engine (Linux 1.2.6) logged at logout, in a sandbox against a fake server.
const REMOVED = (id) => `2026/11/25 21:19:13 INFO reducing event type=*event.InsertAnalyticsEvent event="name:\\"DeviceRemove\\"  props:{key:\\"device_id\\"  value:\\"${id}\\"}"\n`;
const SIGNED_OUT = '2026/11/25 21:19:13 INFO reducing event type=*event.InsertAnalyticsEvent event="name:\\"SignOut\\""\n2026/11/25 21:19:13 INFO reducing event type=*event.Logout event=""\n';
const OFFLINE = '2026/11/25 21:19:17 ERROR removing device tag=UserHandler error="performing request: Delete \\"https://example.invalid/devices/dev-here\\": network failure"\n';
async function logout({ before = '', during = '', env = {}, noLog = false, ...more } = {}) {
  const st = { email: 'me@example.com', users: [ME], ...more };
  const { home, sock, done } = await setup(st);
  const log = join(paths(home).own, 'app.log');
  if (!noLog) { mkdirSync(dirname(log), { recursive: true }); writeFileSync(log, before); st.onLogout = () => appendFileSync(log, during); }
  const r = await blip(home, sock, ['logout'], env);
  done();
  return { ...r, events: st.events.map((e) => e.name) };
}

test('logout reports the device as removed only when the engine logged it', async () => {
  const r = await logout({ before: 'INFO older\n', during: REMOVED('dev-here') + SIGNED_OUT });
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /signed out of me@example\.com and removed this device from your account/);
  assert.deepEqual(r.events, ['RemoveDeviceThenLogout']);
});

test('logout exits 4 when the removal is not confirmed', async () => {
  const cases = {
    'the removal failed': { during: OFFLINE + SIGNED_OUT },
    'the log says nothing': { during: SIGNED_OUT },
    'the engine logs elsewhere': { noLog: true },
    'an earlier logout was confirmed': { before: REMOVED('dev-here'), during: OFFLINE + SIGNED_OUT },
    'another device was removed': { during: REMOVED('dev-phone') + SIGNED_OUT },
    'a similar id was removed': { during: REMOVED('dev-here-2') + SIGNED_OUT },
    'the session has no device id': { deviceId: '', during: REMOVED('') + SIGNED_OUT },
    'other logged text imitates the line': { during: `2026/11/25 21:19:13 INFO reducing event type=*event.SomethingElse event="${REMOVED('dev-here').trim()}"\n${SIGNED_OUT}` },
  };
  for (const [what, opts] of Object.entries(cases)) {
    const r = await logout(opts);
    assert.equal(r.code, 4, `${what}: ${r.err}`);
    assert.match(r.err, /signed out of me@example\.com on this machine, but Blip did not confirm .* may still be listed there\. Remove it in Blip on another device/, what);
    assert.doesNotMatch(r.err, /and removed this device/, what);
  }
});

test('logout reads a log that a restart began anew', async () => {
  const home = { before: 'x'.repeat(4000) };
  const st = { email: 'me@example.com', users: [ME] };
  const s2 = await setup(st); const log = join(paths(s2.home).own, 'app.log');
  mkdirSync(dirname(log), { recursive: true }); writeFileSync(log, home.before);
  st.onLogout = () => writeFileSync(log, REMOVED('dev-here'));
  const r = await blip(s2.home, s2.sock, ['logout']);
  s2.done();
  assert.equal(r.code, 0, r.err);
});

test('logout with no one signed in does nothing', async () => {
  const r = await logout({ email: '' });
  assert.equal(r.code, 0);
  assert.equal(r.err.includes('not signed in'), true);
  assert.deepEqual(r.events, []);
});

test('logout exits 3 when Blip does not sign out in time or stops answering', async () => {
  const slow = await logout({ stuck: true, env: { BLIP_TIMEOUT_S: '1' } });
  assert.equal(slow.code, 3); assert.match(slow.err, /has not signed out after 1 s.*may still be listed on your account/);
  const lost = await logout({ dieOnLogout: true });
  assert.equal(lost.code, 3); assert.match(lost.err, /lost contact with Blip while signing out: .*may still be listed on your account/);
});

test('decline checks its arguments before anything else', async () => {
  const st = { users: [ME] };                                          // signed out
  const { home, sock, done } = await setup(st);
  const bare = await blip(home, sock, ['decline']);
  const dir = await blip(home, sock, ['decline', 't1', '--dir', 'x']);
  const offline = await blip(home, join(home, 'none'), ['decline']);
  done();
  for (const r of [bare, offline]) { assert.equal(r.code, 2); assert.match(r.err, /usage: blip decline <id>/); }
  assert.equal(dir.code, 2); assert.match(dir.err, /--dir only goes with accept/);
});

test('devices waits for the first sync after sign-in, and fails clearly without it', async () => {
  // Just after login the engine is signed in but has no device list until it syncs with Blip's server.
  const st = { email: 'me@example.com', users: [], synced: false, syncAfter: 4, later: [ME, OTHER] };
  const { home, sock, done } = await setup(st);
  const late = await blip(home, sock, ['devices']);
  Object.assign(st, { users: [], synced: false, syncAfter: 0 });
  const never = await blip(home, sock, ['devices'], { BLIP_TIMEOUT_S: '1' });
  Object.assign(st, { users: [OTHER], synced: true });
  const wrong = await blip(home, sock, ['devices'], { BLIP_TIMEOUT_S: '1' });
  done();
  assert.equal(late.code, 0, late.err);
  assert.equal(late.out, 'server (this device)\tdev-here\nPixel 8\tdev-phone\n');
  assert.equal(never.code, 1); assert.match(never.err, /has not loaded your devices from its server after 1 s \(is this machine online\?\)/);
  assert.equal(wrong.code, 1); assert.match(wrong.err, /can't tell which devices are yours \(is this a supported Blip version\?\)/);
});

test('send waits for the first sync instead of refusing', async () => {
  // The device list shows up 1.5 s after the command starts, well after send first asks for it.
  const st = { email: 'me@example.com', users: [], synced: false, syncAt: Date.now() + 1e9, later: [ME] };
  const { home, sock, done } = await setup(st);
  writeFileSync(join(home, 'a.txt'), 'hi');
  st.syncAt = Date.now() + 1500;
  const r = await blip(home, sock, ['send', 'a.txt', '--to', 'Pixel 8']);
  done();
  assert.equal(r.code, 0, r.err);
  assert.equal(st.events[0].name, 'TransferCreateRequested');
  assert.equal(str(fields(st.events[0].ev[1].value)[1]), 'dev-phone');
});

test('a device list from before the sync is used only for an exact device id', async () => {
  const twin = { id: 'user-me', self: true, devices: [...ME.devices, { id: 'dev-phone-2', name: 'Pixel 8' }] };
  // Before the sync the engine still has an old list with one Pixel 8; the synced list has two.
  const st = { email: 'me@example.com', users: [ME], synced: false, syncAt: Date.now() + 1e9, later: [twin] };
  const { home, sock, done } = await setup(st);
  writeFileSync(join(home, 'a.txt'), 'hi');
  const env = { BLIP_TIMEOUT_S: '1' };
  const list = await blip(home, sock, ['devices'], env);
  const byName = await blip(home, sock, ['send', 'a.txt', '--to', 'Pixel 8'], env);
  const onlyOne = await blip(home, sock, ['send', 'a.txt'], env);
  const byId = await blip(home, sock, ['send', 'a.txt', '--to', 'dev-phone'], env);
  const created = st.events.filter((e) => e.name === 'TransferCreateRequested').length;
  st.syncAt = 0;                                                       // now the sync arrives
  const synced = await blip(home, sock, ['send', 'a.txt', '--to', 'Pixel 8'], env);
  done();
  assert.equal(list.code, 0); assert.match(list.err, /note: Blip has not finished syncing your devices .* may be out of date/);
  assert.equal(list.out, 'server (this device)\tdev-here\nPixel 8\tdev-phone\n');
  for (const r of [byName, onlyOne]) { assert.equal(r.code, 1, r.err); assert.match(r.err, /has not finished syncing .*pass the device id from blip devices with --to/); }
  assert.equal(byId.code, 0, byId.err);
  assert.equal(created, 1);
  assert.equal(synced.code, 1); assert.match(synced.err, /ambiguous device "Pixel 8"/);
});

test('folder and auto-accept show the engine\'s settings and send changes', async () => {
  const st = { email: 'me@example.com', users: [ME], config: {} };
  const { home, sock, done } = await setup(st);
  const dir = join(home, 'new place');
  const show = await blip(home, sock, ['folder']);
  const a = await blip(home, sock, ['auto-accept']);
  const bad = await blip(home, sock, ['auto-accept', 'maybe']);
  st.config = { folder: dir, autoAcceptDisabled: true };
  const set = await blip(home, sock, ['folder', dir]);
  const off = await blip(home, sock, ['auto-accept', 'off']);
  const b = await blip(home, sock, ['auto-accept']);
  const made = existsSync(dir);
  done();
  assert.equal(show.out, `incoming files are saved to ${join(home, 'Downloads')} (default)\n`);
  assert.equal(a.out, 'auto-accept is on\n');
  assert.equal(bad.code, 2);
  assert.equal(set.out, `incoming files are saved to ${dir}\n`);
  assert.equal(b.out, 'auto-accept is off\n');
  const folderEv = st.events.find((e) => e.name === 'TransferSetCustomDefaultSavePath');
  assert.equal(str(folderEv.ev[0]), dir);
  assert.ok(made);
  assert.equal(st.events.find((e) => e.name === 'TransferSetAutoAccept').ev[0].value, 0);
});
