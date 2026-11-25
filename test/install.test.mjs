import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, chmodSync, writeFileSync, readFileSync, symlinkSync, readlinkSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const mac = process.platform === 'darwin';
const platformSupported = ['linux', 'darwin'].includes(process.platform);
const OURS = '#!/usr/bin/env node\n// blip: headless command line for the Blip native engine, an older clone\n';
const installer = fileURLToPath(new URL('../install.sh', import.meta.url));

test('installer refuses unrelated files and keeps an existing runtime on download failure', { skip: !platformSupported, timeout: 60000 }, (t) => {
  const home = mkdtempSync(join(tmpdir(), 'blip-install-'));
  t.after(() => { if (existsSync(join(home, 'locked'))) chmodSync(join(home, 'locked'), 0o700); rmSync(home, { recursive: true, force: true }); });
  const runtime = join(home, '.local/lib/blip-cli'), bin = join(home, '.local/bin'), mocks = join(home, 'mocks');
  mkdirSync(bin, { recursive: true }); mkdirSync(runtime, { recursive: true }); mkdirSync(mocks);
  writeFileSync(join(runtime, 'keep'), 'previous engine');
  const env = { PATH: `${mocks}:${process.env.PATH}`, HOME: home };
  const run = () => spawnSync('bash', [installer], { env, encoding: 'utf8' });
  const unmanaged = run();
  assert.equal(unmanaged.status, 1); assert.match(unmanaged.stderr, /refusing to replace an unmanaged install/);
  writeFileSync(join(runtime, '.blip-cli-install'), mac ? '1.2.3\n' : '1.2.6\n');
  writeFileSync(join(bin, 'blip'), 'unrelated command');
  const conflict = run();
  assert.equal(conflict.status, 1); assert.match(conflict.stderr, /refusing to replace an existing file/);
  assert.equal(readFileSync(join(bin, 'blip'), 'utf8'), 'unrelated command');
  // Someone else's blip.mjs, and Blip's own launcher unless asked for.
  rmSync(join(bin, 'blip')); mkdirSync(join(home, 'other'));
  writeFileSync(join(home, 'other/blip.mjs'), '#!/usr/bin/env node\n// another tool\n');
  mkdirSync(join(home, '.local/opt/blip/bin'), { recursive: true }); writeFileSync(join(home, '.local/opt/blip/bin/blip'), 'launcher');
  mkdirSync(join(home, 'locked')); writeFileSync(join(home, 'locked/blip.mjs'), '#!/usr/bin/env node\n// another tool\n'); chmodSync(join(home, 'locked'), 0);
  for (const [target, message] of [['other/blip.mjs', /refusing to replace an existing file/], ['gone/blip.mjs', /refusing to replace a link that can't be checked/], ['locked/blip.mjs', /refusing to replace (a link that can't be checked|an existing file)/], ['other', /refusing to replace an existing file/], ['.local/opt/blip/bin/blip', /refusing to replace Blip's own launcher[^]*--replace-launcher/]]) {
    symlinkSync(join(home, target), join(bin, 'blip'));
    const r = run();
    assert.equal(r.status, 1); assert.match(r.stderr, message);
    assert.equal(readlinkSync(join(bin, 'blip')), join(home, target));
    rmSync(join(bin, 'blip'));
  }
  const usage = spawnSync('bash', [installer, '--force'], { env, encoding: 'utf8' });
  assert.equal(usage.status, 2); assert.match(usage.stderr, /usage: \.\/install\.sh \[--replace-launcher\]/);
  mkdirSync(join(home, 'old')); writeFileSync(join(home, 'old/blip.mjs'), OURS);
  symlinkSync(join(home, 'old/blip.mjs'), join(bin, 'blip'));
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

test('installer activates a staged runtime and restores it if activation fails or is terminated', { skip: !platformSupported, timeout: 60000 }, (t) => {
  const home = mkdtempSync(join(tmpdir(), 'blip-activate-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const mocks = join(home, 'mocks'), root = join(home, 'archive'), member = join(root, mac ? 'Blip.app/Contents/Frameworks/BlipKit.framework/Versions/A' : 'blip-1.2.6/lib/runtime/lib');
  mkdirSync(mocks); mkdirSync(member, { recursive: true });
  writeFileSync(join(home, 'fake.c'), 'void libblip_host(int a, const char*b, const char*c, const char*d, const char*e) {}\nvoid libblip_host_stop(void) {}\n');
  execFileSync('cc', [mac ? '-dynamiclib' : '-shared', '-fPIC', join(home, 'fake.c'), '-o', join(member, mac ? 'BlipKit' : 'libblip-jni.so')]);
  const archive = join(home, 'fixture.tar.gz');
  const bundle = () => {
    if (mac) { rmSync(archive, { force: true }); execFileSync('zip', ['-qr', archive, 'Blip.app'], { cwd: root }); }
    else execFileSync('tar', ['-czf', archive, '-C', root, 'blip-1.2.6']);
  };
  bundle();
  // The fixture substitutes archive authentication and Mac code-signature
  // verification. Real checksum rejection is exercised above; official archive
  // and vendor-signature checks run in the real installation smoke test.
  writeFileSync(join(mocks, 'curl'), '#!/bin/sh\nwhile [ "$1" != "--output" ]; do shift; done\ncp "$BLIP_TEST_ARCHIVE" "$2"\n', { mode: 0o700 });
  writeFileSync(join(mocks, 'sha256sum'), '#!/bin/sh\ncat >/dev/null\nexit 0\n', { mode: 0o700 });
  if (mac) writeFileSync(join(mocks, 'codesign'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  if (mac) writeFileSync(join(mocks, 'shasum'), '#!/bin/sh\necho 778b777557e508d65aa91e55305397958418dd25e2ea8090aa70d3c12e04ffa2\n', { mode: 0o700 });
  const runtime = join(home, '.local/lib/blip-cli'), link = join(home, '.local/bin/blip');
  const env = { PATH: `${mocks}:${process.env.PATH}`, HOME: home, BLIP_TEST_ARCHIVE: archive };
  const run = () => spawnSync('bash', [installer], { env, encoding: 'utf8' });
  const installed = run();
  assert.equal(installed.status, 0, installed.stderr);
  if (mac) assert.match(installed.stdout, /separate CLI profile/);
  else assert.match(installed.stdout, /stop its old Blip process/);
  assert.equal(readFileSync(join(runtime, '.blip-cli-install'), 'utf8'), mac ? '1.2.3\n' : '1.2.6\n');
  assert.equal(existsSync(join(runtime, 'blip-core')), true);
  assert.equal(existsSync(join(runtime, mac ? 'BlipKit.framework/Versions/A/BlipKit' : 'libblip.so')), true);
  assert.equal(readlinkSync(link), fileURLToPath(new URL('../blip.mjs', import.meta.url)));
  assert.deepEqual(readdirSync(runtime).sort(), ['.blip-cli-install', 'blip-core', mac ? 'BlipKit.framework' : 'libblip.so'].sort());
  // Installing again keeps a link to this clone. Another blip on PATH is reported, and said to win if it comes first.
  writeFileSync(join(mocks, 'blip'), '#!/bin/sh\n', { mode: 0o700 });
  const bin = join(home, '.local/bin');
  const shadowed = spawnSync('bash', [installer], { env: { ...env, PATH: `${env.PATH}:${bin}` }, encoding: 'utf8' });
  assert.equal(shadowed.status, 0, shadowed.stderr);
  assert.ok(shadowed.stderr.includes(`warning: blip runs ${join(mocks, 'blip')}, which comes before ~/.local/bin`), shadowed.stderr);
  const ahead = spawnSync('bash', [installer], { env: { ...env, PATH: `${bin}:${env.PATH}` }, encoding: 'utf8' });
  assert.equal(ahead.status, 0, ahead.stderr);
  assert.ok(ahead.stderr.includes(`note: another blip is at ${join(mocks, 'blip')}`), ahead.stderr);
  assert.doesNotMatch(ahead.stderr, /warning: blip runs/);
  const missing = spawnSync('bash', [installer], { env: { ...env, PATH: env.PATH.split(':').filter((p) => p.replace(/\/+$/, '') !== bin).join(':') }, encoding: 'utf8' });
  assert.ok(missing.stderr.includes(`warning: blip runs ${join(mocks, 'blip')}, because ~/.local/bin is not on your PATH`), missing.stderr);
  assert.doesNotMatch(missing.stderr, /comes before/);
  rmSync(join(mocks, 'blip'));
  const slash = spawnSync('bash', [installer], { env: { ...env, PATH: `${bin}/:${env.PATH}` }, encoding: 'utf8' });
  assert.doesNotMatch(slash.stderr, /add ~\/\.local\/bin|warning: blip runs/);
  // Blip's own launcher gives way only when asked, and the app itself stays.
  mkdirSync(join(home, '.local/opt/blip/bin'), { recursive: true }); writeFileSync(join(home, '.local/opt/blip/bin/blip'), 'launcher');
  rmSync(link); symlinkSync(join(home, '.local/opt/blip/bin/blip'), link);
  assert.equal(run().status, 1);
  const replaced = spawnSync('bash', [installer, '--replace-launcher'], { env, encoding: 'utf8' });
  assert.equal(replaced.status, 0, replaced.stderr);
  assert.equal(readlinkSync(link), fileURLToPath(new URL('../blip.mjs', import.meta.url)));
  assert.equal(readFileSync(join(home, '.local/opt/blip/bin/blip'), 'utf8'), 'launcher');
  writeFileSync(join(runtime, 'keep'), 'old runtime');
  if (mac) {
    writeFileSync(join(mocks, 'codesign'), '#!/bin/sh\nexit 9\n', { mode: 0o700 });
    const signature = run();
    assert.equal(signature.status, 9);
    assert.equal(readFileSync(join(runtime, 'keep'), 'utf8'), 'old runtime');
    writeFileSync(join(mocks, 'codesign'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  }
  const oldTarget = join(home, 'old/blip.mjs');
  mkdirSync(join(home, 'old')); writeFileSync(oldTarget, OURS);
  rmSync(link); symlinkSync(oldTarget, link);
  for (const failure of ['exit 11', 'kill -TERM "$PPID"; exit 143']) {
    // Fail exactly the final link rename, after the runtime directory switch.
    writeFileSync(join(mocks, 'mv'), `#!/bin/sh\nif [ "$1" = "-Tf" ] || [ "$1" = "-fh" ]; then ${failure}; fi\nexec /bin/mv "$@"\n`, { mode: 0o700 });
    const failed = run();
    assert.equal(failed.status, failure === 'exit 11' ? 11 : 143, failed.stderr);
    assert.equal(readFileSync(join(runtime, 'keep'), 'utf8'), 'old runtime');
    assert.equal(readlinkSync(link), oldTarget);
    assert.deepEqual(readdirSync(join(home, '.local/lib')), ['blip-cli']);
  }
  rmSync(join(mocks, 'mv'));
  // A file that appears while the download runs is kept, and so is the old runtime.
  const curl = readFileSync(join(mocks, 'curl'), 'utf8');
  for (const make of [`printf mine > "${link}"`, `ln -s "${join(home, 'fake.c')}" "${link}"`]) {
    writeFileSync(join(mocks, 'curl'), `${curl}rm "${link}"; ${make}\n`, { mode: 0o700 });
    const raced = run();
    assert.equal(raced.status, 1, raced.stderr); assert.match(raced.stderr, /refusing to replace an existing file/);
    assert.equal(readFileSync(link, 'utf8'), make.startsWith('printf') ? 'mine' : readFileSync(join(home, 'fake.c'), 'utf8'));
    assert.equal(readFileSync(join(runtime, 'keep'), 'utf8'), 'old runtime');
    assert.deepEqual(readdirSync(join(home, '.local/lib')), ['blip-cli']);
    rmSync(link); symlinkSync(oldTarget, link);
  }
  writeFileSync(join(mocks, 'curl'), curl, { mode: 0o700 });
  // A verified archive with a changed layout must fail before activation.
  if (mac) { rmSync(archive); execFileSync('zip', ['-q', archive, 'fake.c'], { cwd: home }); }
  else execFileSync('tar', ['-czf', archive, '-C', home, 'fake.c']);
  const layout = run();
  assert.notEqual(layout.status, 0); assert.match(layout.stderr, /Not found in archive|filename not matched/);
  assert.equal(readFileSync(join(runtime, 'keep'), 'utf8'), 'old runtime');
  assert.equal(readlinkSync(link), oldTarget);
  bundle();
  if (mac) return;
  writeFileSync(join(mocks, 'uname'), '#!/bin/sh\nif [ "$1" = "-s" ]; then echo Linux; else echo aarch64; fi\n', { mode: 0o700 });
  const arm = run();
  assert.equal(arm.status, 0, arm.stderr);
  assert.match(arm.stderr, /aarch64 native runtime is experimental and has not been tested/);
});
