// Run with: node --test
// Checks the DRPC client and protobuf walker against a mock server on a unix socket. No Blip needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { call, fields, uv } from '../drpc.mjs';

const frame = (kind, msg, data, done = true) => Buffer.concat([Buffer.from([(kind << 1) | (done ? 1 : 0)]), uv(1), uv(msg), uv(data.length), data]);
const MESSAGE = 2, ERROR = 3, CLOSE = 5;

// Starts a server that answers every connection with reply(socket), then runs fn(socketPath).
async function withServer(reply, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'drpc-test-'));
  const path = join(dir, 'sock');
  const server = net.createServer((s) => { s.once('data', () => reply(s)); s.on('error', () => {}); });
  await new Promise((r) => server.listen(path, r));
  try { return await fn(path); } finally { server.close(); rmSync(dir, { recursive: true, force: true }); }
}

test('returns a reply that fits in one frame', async () => {
  const body = Buffer.from('hello');
  const got = await withServer((s) => s.end(Buffer.concat([frame(MESSAGE, 1, body), frame(CLOSE, 2, Buffer.alloc(0))])), (p) => call(p, '/x', Buffer.alloc(0)));
  assert.deepEqual(got, body);
});

test('joins a reply that drpc split into 64 KiB frames', async () => {
  const body = Buffer.alloc(200 * 1024, 7); body[0] = 1; body[body.length - 1] = 2;
  const chunks = [];
  for (let i = 0; i < body.length; i += 64 * 1024) chunks.push(frame(MESSAGE, 1, body.subarray(i, i + 64 * 1024), i + 64 * 1024 >= body.length));
  const got = await withServer((s) => s.end(Buffer.concat([...chunks, frame(CLOSE, 2, Buffer.alloc(0))])), (p) => call(p, '/x', Buffer.alloc(0)));
  assert.equal(got.length, body.length);
  assert.deepEqual(got, body);
});

test('reports the text of an error frame without its code prefix', async () => {
  const data = Buffer.concat([Buffer.alloc(8), Buffer.from('no such method ✓')]);
  await withServer((s) => s.end(frame(ERROR, 1, data)), (p) =>
    assert.rejects(call(p, '/x', Buffer.alloc(0)), { message: 'drpc error: no such method ✓' }));
});

test('fails fast when the peer closes without replying', async () => {
  const t0 = Date.now();
  await withServer((s) => s.end(), (p) => assert.rejects(call(p, '/x', Buffer.alloc(0)), /closed the connection/));
  assert.ok(Date.now() - t0 < 5000);
});

test('refuses a reply over 4 MiB', async () => {
  const big = Buffer.alloc(1024 * 1024);
  await withServer((s) => { for (let i = 0; i < 5; i++) s.write(frame(MESSAGE, 1, big, false)); }, (p) =>
    assert.rejects(call(p, '/x', Buffer.alloc(0)), /too large/));
});

test('fields() walks varint and length-delimited fields', () => {
  const msg = Buffer.concat([uv((1 << 3) | 0), uv(300), uv((2 << 3) | 2), uv(3), Buffer.from('abc')]);
  const f = fields(msg);
  assert.equal(f[0].tag, 1); assert.equal(f[0].value, 300);
  assert.equal(f[1].tag, 2); assert.equal(f[1].value.toString(), 'abc');
});

test('fields() rejects truncated input with a readable error', () => {
  for (const bad of [Buffer.from([0x08]), Buffer.from([0x12, 0x05, 0x61]), Buffer.from([0x0b]), Buffer.from([0x09, 1, 2])])
    assert.throws(() => fields(bad), /unexpected reply from Blip/);
});
