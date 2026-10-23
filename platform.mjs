import { resolve } from 'node:path';

export function runtimePaths(home, platform, env = {}) {
  const mac = platform === 'darwin';
  const own = mac ? `${home}/Library/Caches/blip-cli` : `${home}/.cache/blip-cli`;
  const cache = mac ? `${own}/engine` : `${home}/.cache/net.blip.Blip`;
  const data = mac ? `${home}/Library/Application Support/blip-cli/engine` : `${home}/.local/share/net.blip.Blip`;
  const configHome = env.XDG_CONFIG_HOME?.startsWith('/') ? env.XDG_CONFIG_HOME : null;
  return {
    own, cache, data,
    socket: resolve(env.BLIP_SOCK ?? `${cache}/sock`),
    app: resolve(env.BLIP_APP ?? `${home}/.local/lib/blip-cli/blip-core`),
    library: resolve(env.BLIP_LIB ?? `${home}/.local/lib/blip-cli/${mac ? 'BlipKit.framework/Versions/A/BlipKit' : 'libblip.so'}`),
    config: configHome ? `${configHome}/blip-cli/config.json` : mac ? `${home}/Library/Application Support/blip-cli/config.json` : `${home}/.config/blip-cli/config.json`,
    engineVersion: mac ? '1.2.3' : '1.2.6',
    protectedData: [data, `${home}/.local/share/net.blip.Blip`, `${home}/Library/Group Containers/AY8UB8KTUX.blip`],
  };
}
