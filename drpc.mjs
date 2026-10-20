// Minimal DRPC (storj.io/drpc v0.0.32) unary client over a unix socket.
import net from 'node:net';
const K = { Invoke: 1, Message: 2, Error: 3, Cancel: 4, Close: 5, CloseSend: 6, InvokeMetadata: 7 };
const MAX = 4 << 20;                                                                       // drpc's default MaximumBufferSize
export const uv = (n) => { const o = []; n = BigInt.asUintN(64, BigInt(n)); do { let b = Number(n & 0x7fn); n >>= 7n; if (n) b |= 0x80; o.push(b); } while (n); return Buffer.from(o); };
const frame = (kind, stream, msg, data = Buffer.alloc(0)) =>
  Buffer.concat([Buffer.from([(kind << 1) | 1]), uv(stream), uv(msg), uv(data.length), data]);
function readVarint(buf, i) { let r = 0n, s = 0n; for (;;) { if (i >= buf.length || s > 63n) return null; const b = buf[i++]; r |= BigInt(b & 0x7f) << s; if (!(b & 0x80)) return [Number(r), i]; s += 7n; } }
function parseFrames(buf) {
  const out = []; let i = 0;
  while (buf.length - i >= 4) {
    const c = buf[i]; let p = i + 1, v;
    if (!(v = readVarint(buf, p))) break; const stream = v[0]; p = v[1];
    if (!(v = readVarint(buf, p))) break; const msg = v[0]; p = v[1];
    if (!(v = readVarint(buf, p))) break; const len = v[0]; p = v[1];
    if (p + len > buf.length) break;
    out.push({ kind: (c & 0x7e) >> 1, done: !!(c & 1), stream, msg, data: buf.subarray(p, p + len) });
    i = p + len;
  }
  return [out, buf.subarray(i)];
}
// Error packets carry an 8-byte big-endian code before the message text.
const errText = (d) => (d.length >= 8 ? d.subarray(8) : d).toString('utf8');
export function call(sockPath, method, request) {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(sockPath);
    let buf = Buffer.alloc(0), parts = [], size = 0, msgId = -1, reply = null, settled = false;
    const finish = (err, value) => { if (settled) return; settled = true; clearTimeout(t); s.destroy(); if (err) reject(err); else resolve(value); };
    const t = setTimeout(() => finish(new Error('timeout')), 15000);
    s.on('connect', () => s.write(Buffer.concat([
      frame(K.Invoke, 1, 1, Buffer.from(method)), frame(K.Message, 1, 2, request), frame(K.CloseSend, 1, 3)])));
    s.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length > MAX + 64) return finish(new Error('drpc reply too large'));
      let fr; [fr, buf] = parseFrames(buf);
      for (const f of fr) {
        if (f.kind === K.Message) {                                                          // messages over 64 KiB arrive split; the done bit marks the last frame
          if (f.msg !== msgId) { parts = []; size = 0; msgId = f.msg; }
          parts.push(f.data); size += f.data.length;
          if (size > MAX) return finish(new Error('drpc reply too large'));
          if (f.done) { reply = Buffer.concat(parts); parts = []; size = 0; }
        } else if (f.kind === K.Error) return finish(new Error('drpc error: ' + errText(f.data)));
        else if (f.kind === K.Close || f.kind === K.CloseSend) return finish(null, reply ?? Buffer.alloc(0));
      }
    });
    s.on('error', (e) => finish(e));
    s.on('close', () => finish(new Error('Blip closed the connection without replying')));
  });
}
// generic protobuf walker: returns [{tag, wire, value(Buffer|number)}]
export function fields(buf) {
  const out = []; let i = 0;
  const need = (v) => v ?? malformed();
  while (i < buf.length) {
    let v = need(readVarint(buf, i)); const key = v[0]; i = v[1]; const tag = key >> 3, wire = key & 7;
    if (wire === 0) { v = need(readVarint(buf, i)); out.push({ tag, wire, value: v[0] }); i = v[1]; continue; }
    const len = wire === 2 ? (v = need(readVarint(buf, i)), i = v[1], v[0]) : wire === 1 ? 8 : wire === 5 ? 4 : malformed();
    if (i + len > buf.length) malformed();
    out.push({ tag, wire, value: buf.subarray(i, i + len) }); i += len;
  }
  return out;
}
function malformed() { throw new Error('unexpected reply from Blip (is this a supported Blip version?)'); }
