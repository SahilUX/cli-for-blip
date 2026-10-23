import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, readlinkSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const installer = fileURLToPath(new URL('../install.sh', import.meta.url));

test('installer refuses unrelated files and keeps an existing runtime on download failure', { skip: process.platform !== 'linux', timeout: 15000 }, (t) => {
  const home = mkdtempSync(join(tmpdir(), 'blip-install-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const runtime = join(home, '.local/lib/blip-cli'), bin = join(home, '.local/bin'), mocks = join(home, 'mocks');
  mkdirSync(bin, { recursive: true }); mkdirSync(runtime, { recursive: true }); mkdirSync(mocks);
  writeFileSync(join(runtime, 'keep'), 'previous engine');
  const env = { PATH: `${mocks}:${process.env.PATH}`, HOME: home };
  const run = () => spawnSync('bash', [installer], { env, encoding: 'utf8' });
  const unmanaged = run();
  assert.equal(unmanaged.status, 1); assert.match(unmanaged.stderr, /refusing to replace an unmanaged install/);
  writeFileSync(join(runtime, '.blip-cli-install'), '1.2.6\n');
  writeFileSync(join(bin, 'blip'), 'unrelated command');
  const conflict = run();
  assert.equal(conflict.status, 1); assert.match(conflict.stderr, /refusing to replace an existing file/);
  assert.equal(readFileSync(join(bin, 'blip'), 'utf8'), 'unrelated command');
  rmSync(join(bin, 'blip')); symlinkSync(join(home, 'old/blip.mjs'), join(bin, 'blip'));
  writeFileSync(join(mocks, 'curl'), '#!/bin/sh\nexit 7\n', { mode: 0o700 });
  const failed = run();
  assert.equal(failed.status, 7);
  assert.equal(readFileSync(join(runtime, 'keep'), 'utf8'), 'previous engine');
  assert.equal(readlinkSync(join(bin, 'blip')), join(home, 'old/blip.mjs'));
  assert.deepEqual(readdirSync(join(home, '.local/lib')), ['blip-cli']);
  // A download that succeeds but contains the wrong bytes must also preserve it.
  writeFileSync(join(mocks, 'curl'), '#!/bin/sh\nwhile [ "$1" != "--output" ]; do shift; done\nprintf invalid > "$2"\n', { mode: 0o700 });
  const hash = run();
  assert.equal(hash.status, 1); assert.match(hash.stderr, /archive SHA-256 does not match/);
  assert.equal(readFileSync(join(runtime, 'keep'), 'utf8'), 'previous engine');
  assert.equal(readlinkSync(join(bin, 'blip')), join(home, 'old/blip.mjs'));
  assert.deepEqual(readdirSync(join(home, '.local/lib')), ['blip-cli']);
});
