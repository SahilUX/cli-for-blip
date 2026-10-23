import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const compiler = spawnSync('cc', ['--version']).status === 0;
const supported = ['linux', 'darwin'].includes(process.platform);
const pause = () => new Promise((r) => setTimeout(r, 20));

test('native host checks the ABI, passes hosting arguments and stops gracefully', { skip: !compiler || !supported, timeout: 10000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'blip-host-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = join(dir, 'blip-core'), library = join(dir, 'fake.so');
  const source = fileURLToPath(new URL('../native/host.c', import.meta.url));
  execFileSync('cc', ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', source, '-ldl', '-o', host]);
  writeFileSync(join(dir, 'fake.c'), `
#include <stdio.h>
#include <stdlib.h>
static const char *cache;
void libblip_host(int takeover, const char *c, const char *data, const char *server, const char *signaller) {
  cache = c;
  char path[4096]; snprintf(path, sizeof path, "%s/called", c);
  FILE *file = fopen(path, "w"); if (!file) abort();
  fprintf(file, "%d\\n%s\\n%s\\n%s\\n%s\\n", takeover, c, data, server, signaller ? signaller : "NULL");
  fclose(file);
}
void libblip_host_stop(void) {
  char path[4096]; snprintf(path, sizeof path, "%s/stopped", cache);
  FILE *file = fopen(path, "w"); if (!file) abort(); fclose(file);
}
`);
  execFileSync('cc', [process.platform === 'darwin' ? '-dynamiclib' : '-shared', '-fPIC', join(dir, 'fake.c'), '-o', library]);
  assert.equal(spawnSync(host, []).status, 2);
  const missing = spawnSync(host, ['--check', join(dir, 'absent.so')], { encoding: 'utf8' });
  assert.equal(missing.status, 1); assert.match(missing.stderr, /could not load Blip core/);
  assert.equal(spawnSync(host, ['--check', library]).status, 0);
  assert.equal(existsSync(join(dir, 'called')), false, '--check must not start a core');
  for (const signal of ['SIGTERM', 'SIGINT']) {
    rmSync(join(dir, 'called'), { force: true }); rmSync(join(dir, 'stopped'), { force: true });
    const child = spawn(host, [library, dir, join(dir, 'data')], { stdio: 'ignore' });
    t.after(() => { if (child.exitCode === null && !child.signalCode) child.kill('SIGKILL'); });
    const exit = new Promise((r) => child.once('exit', (code, sig) => r({ code, sig })));
    const until = Date.now() + 3000;
    while (!existsSync(join(dir, 'called')) && Date.now() < until) await pause();
    assert.equal(existsSync(join(dir, 'called')), true, 'host did not call the library');
    assert.equal(readFileSync(join(dir, 'called'), 'utf8'), `0\n${dir}\n${join(dir, 'data')}\nhttps://prod.blip.net\nNULL\n`);
    child.kill(signal);
    assert.deepEqual(await exit, { code: 0, sig: null });
    assert.equal(existsSync(join(dir, 'stopped')), true, 'stop must run outside the signal handler');
  }
  writeFileSync(join(dir, 'bad.c'), 'void unrelated(void) {}\n');
  execFileSync('cc', [process.platform === 'darwin' ? '-dynamiclib' : '-shared', '-fPIC', join(dir, 'bad.c'), '-o', library]);
  const bad = spawnSync(host, ['--check', library], { encoding: 'utf8' });
  assert.equal(bad.status, 1); assert.equal(bad.stderr, 'unsupported Blip core: missing hosting symbols\n');
});
