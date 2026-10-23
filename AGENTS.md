# blip-cli

Zero-dependency Node (>=22) client for the local DRPC socket of Blip's native
Linux engine. `native/host.c` hosts the engine without Java, Xvfb or D-Bus.
`install.sh` builds that launcher and extracts the pinned native library from
the official archive, verifying its SHA-256 checksum. No GUI app is installed.

- Keep it dependency-free.
- Run `node --test` after every change. `test/` drives the CLI and the DRPC
  client against a fake Blip on a unix socket, so it needs no Blip install.
  When you add or change a message, a guard or an exit code, add a test there.
- Real-engine startup and sign-in need Linux with the native runtime. Use a
  throwaway `HOME` and `BLIP_APP` / `BLIP_LIB` pointing at the native host and
  library to keep tests separate from the live session. A test login adds a
  device to the account you sign in to, under the name you pass with
  `--name`. Pick a distinct name and run `blip logout` afterwards, which
  removes that device again.
- Before migrating a desktop service, stop it and replace its desktop launch
  command. The installer changes `~/.local/bin/blip` to the CLI; keep the
  existing data directory to preserve the session and device identity.
- Engine ABI and archive hashes are pinned to 1.2.6. Verify hosting, shutdown
  and RPC compatibility before changing either pin.
- When you change a message, exit code or default in `blip.mjs`, update the
  matching text in `README.md`.

Never print raw `GetState` output or read Blip's `state.dat` while testing:
both hold the signed-in account's session credentials.
