# blip-cli

Zero-dependency Node (>=22) client for the local DRPC socket of the Blip Linux
desktop app. `blip.mjs` holds the `blip` command (it also starts the app
headless in the background), `drpc.mjs` holds the DRPC framing and a generic
protobuf walker, and `install.sh` installs Blip and links `~/.local/bin/blip`.

- Keep it dependency-free.
- Run `node --test` after every change. `test/` drives the CLI and the DRPC
  client against a fake Blip on a unix socket, so it needs no Blip install.
  When you add or change a message, a guard or an exit code, add a test there.
- `start`, `stop` and real sign-in need Linux with Blip installed. To test
  them without touching this machine's session, run with a throwaway `HOME`
  and `BLIP_APP` pointing at the installed app. A test login still adds a
  device to the account you sign in to, under the name you pass with
  `--name`. Pick a distinct name and run `blip logout` afterwards, which
  removes that device again.
- Don't run `install.sh` on a machine whose systemd unit launches
  `~/.local/bin/blip`: after install that path is this CLI, not the app.
- When you change a message, exit code or default in `blip.mjs`, update the
  matching text in `README.md`.

Never print raw `GetState` output or read Blip's `state.dat` while testing:
both hold the signed-in account's session credentials.
