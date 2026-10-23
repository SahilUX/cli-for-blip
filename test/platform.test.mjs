import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runtimePaths } from '../platform.mjs';

test('Mac profile is separate from the protected GUI container', () => {
  const p = runtimePaths('/home/person', 'darwin');
  assert.equal(p.data, '/home/person/Library/Application Support/blip-cli/engine');
  assert.equal(p.socket, '/home/person/Library/Caches/blip-cli/engine/sock');
  assert.equal(p.config, '/home/person/Library/Application Support/blip-cli/config.json');
  assert.equal(p.library, '/home/person/.local/lib/blip-cli/BlipKit.framework/Versions/A/BlipKit');
  assert.equal(p.engineVersion, '1.2.3');
  assert.ok(p.protectedData.includes('/home/person/Library/Group Containers/AY8UB8KTUX.blip'));
});
test('Linux keeps its existing profile and overrides work on both platforms', () => {
  const p = runtimePaths('/home/person', 'linux');
  assert.equal(p.data, '/home/person/.local/share/net.blip.Blip');
  assert.equal(p.socket, '/home/person/.cache/net.blip.Blip/sock');
  assert.equal(p.config, '/home/person/.config/blip-cli/config.json');
  assert.equal(p.library, '/home/person/.local/lib/blip-cli/libblip.so');
  for (const os of ['linux', 'darwin']) {
    const custom = runtimePaths('/home/person', os, { BLIP_SOCK: '/tmp/sock', BLIP_APP: '/host', BLIP_LIB: '/lib', XDG_CONFIG_HOME: '/cfg' });
    assert.equal(custom.socket, '/tmp/sock');
    assert.equal(custom.app, '/host'); assert.equal(custom.library, '/lib');
    assert.equal(custom.config, '/cfg/blip-cli/config.json');
    assert.notEqual(runtimePaths('/home/person', os, { XDG_CONFIG_HOME: 'relative' }).config, 'relative/blip-cli/config.json');
  }
});
