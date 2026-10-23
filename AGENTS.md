# blip-cli

Zero-dependency Node (>=22) client for the local DRPC socket of Blip's native
Linux and macOS engines. `native/host.c` hosts the engine without launching
the desktop app. macOS retains the vendor-signed framework intact.
`install.sh` builds that launcher and extracts the pinned native library from
the official archive, verifying its SHA-256 checksum. No GUI app is installed.
`platform.mjs` defines platform paths and version pins for RPC metadata.

- Keep it dependency-free.
- Run `node --test` after every change. `test/` drives the CLI and the DRPC
  client against a fake Blip on a unix socket, so it needs no Blip install.
  When you add or change a message, a guard or an exit code, add a test there.
- Real-engine startup and sign-in need a supported OS with the native runtime. Use a
  throwaway `HOME` and `BLIP_APP` / `BLIP_LIB` pointing at the native host and
  library to keep tests separate from the live session. A test login adds a
  device to the account you sign in to, under the name you pass with
  `--name`. Pick a distinct name and run `blip logout` afterwards, which
  removes that device again.
- macOS uses its own CLI profile under ~/Library; leave the desktop app
  Group Container and session untouched. Real Mac login and transfer tests
  need that CLI profile signed in. Intel macOS remains experimental.
- Before migrating a Linux desktop service, stop it and replace its desktop launch
  command. The installer changes `~/.local/bin/blip` to the CLI; keep the
  existing data directory to preserve the session and device identity.
- Linux engine pins are 1.2.6; macOS pins are 1.2.3. Keep the Mac framework
  signature valid by retaining its Info.plist and resources. Verify hosting, shutdown
  and RPC compatibility before changing either pin.
- When you change a message, exit code or default in `blip.mjs`, update the
  matching text in `README.md`.

Never print raw `GetState` output or read Blip's `state.dat` while testing:
both hold the signed-in account's session credentials.
