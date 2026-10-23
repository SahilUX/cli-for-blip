import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, readlinkSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const mac = process.platform === 'darwin';
const platformSupported = ['linux', 'darwin'].includes(process.platform);
const installer = fileURLToPath(new URL('../install.sh', import.meta.url));

test('installer refuses unrelated files and keeps an existing runtime on download failure', { skip: !platformSupported, timeout: 15000 }, (t) => {
  const home = mkdtempSync(join(tmpdir(), 'blip-install-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
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

test('installer activates a staged runtime and restores it if activation fails or is terminated', { skip: !platformSupported, timeout: 15000 }, (t) => {
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
  writeFileSync(join(runtime, 'keep'), 'old runtime');
  if (mac) {
    writeFileSync(join(mocks, 'codesign'), '#!/bin/sh\nexit 9\n', { mode: 0o700 });
    const signature = run();
    assert.equal(signature.status, 9);
    assert.equal(readFileSync(join(runtime, 'keep'), 'utf8'), 'old runtime');
    writeFileSync(join(mocks, 'codesign'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  }
  const oldTarget = join(home, 'old/blip.mjs');
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
