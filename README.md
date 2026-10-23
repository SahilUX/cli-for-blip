# blip

Send files and folders to your own [Blip](https://blip.net) devices from the terminal, on a Linux machine with no screen.

`blip` runs Blip's native transfer engine directly and talks to its local RPC socket. It needs no GUI app, Java runtime, virtual display, or D-Bus session. It is unofficial and not affiliated with Blip Studio Inc. The Node.js client has no npm dependencies; a small C launcher hosts the proprietary engine downloaded from Blip. The native interface and RPC messages were derived from Blip 1.2.6 for Linux.

```sh
blip login                          # sign in with the code Blip emails you
blip send report.pdf --to "Pixel 8" # waits until the transfer completes
blip send photos/                   # same device as last time
blip logout
```

## What you need

- Linux with glibc on x86-64. The aarch64 installer is experimental; its runtime has not been tested. macOS is not supported yet
- Node.js 22 or newer (`node --version` to check)
- A C compiler (`cc`), `git`, `curl`, `tar`, and `sha256sum` to install. On Debian or Ubuntu: `sudo apt install build-essential git curl tar coreutils`
- A Blip account, with Blip also installed on at least one other device you want to send to

The installer downloads the official Linux archive, verifies its pinned SHA-256 checksum, and extracts only the native engine library. The GUI app and its JVM are never installed. You still use Blip's proprietary engine and service, so [Blip's terms of service](https://blip.net/terms-of-service) apply. Commercial use requires a Business plan.

## Use with an agent

Install the reusable [blip-cli-skill](https://github.com/SahilUX/blip-cli-skill#readme) to let an agent send files with this CLI. Its README includes installation instructions for agent skill directories.

The skill provides instructions only. It requires this CLI, Node.js 22 or newer, the native Blip engine installed by this repository, an account signed in on the sending machine, and Blip on the receiving device. Installing the skill does not install or authenticate any of those prerequisites.

## Install

Clone the repository into a directory that only you can write to, such as one under your home directory. `~/.local/bin/blip` links into the clone, so whoever can write to the clone controls what `blip` runs.

```sh
git clone https://github.com/SahilUX/blip-cli.git
cd blip-cli
./install.sh
```

`install.sh` builds `native/host.c`, installs the launcher and native library in `~/.local/lib/blip-cli`, and links `~/.local/bin/blip` to this checkout. It pins Blip 1.2.6 because the hosting ABI is undocumented. Re-running it repairs the installation at that version. It stages and checks the replacement before switching, and restores the previous runtime if activation fails.

If you already run the GUI app through `~/.local/bin/blip`, stop it and update that service before installing. That path becomes the CLI. See [Migrate from the desktop runtime](#migrate-from-the-desktop-runtime).

Make sure `~/.local/bin` is on your `PATH`. On Debian and Ubuntu, `~/.profile` adds it for login shells only, so a non-interactive shell, as in `ssh server blip ...`, cron, or a service, doesn't find `blip`. Use the full path, `~/.local/bin/blip`, there. The same goes for `node` if it lives somewhere like nvm: `blip` runs it with `/usr/bin/env node`, so `node` has to be on that shell's `PATH` too.

To update the CLI, pull this repository and run `./install.sh` again. A running engine keeps its old code until you run `blip stop` and `blip start`. Updating the engine version requires verifying its native ABI and protocol and changing the installer pins.

Don't move or delete the clone while `blip` is installed. If you move it, relink from the new place with `ln -sfn "$PWD/blip.mjs" ~/.local/bin/blip`. Running `./install.sh` there also works, but it updates Blip too.

## Uninstall

Run these before you delete the clone:

```sh
blip logout              # sign out and remove this machine from your device list
blip stop                # stop the background app that blip started
rm ~/.local/bin/blip
rm -rf ~/.cache/blip-cli "${XDG_CONFIG_HOME:-$HOME/.config}/blip-cli"
```

Remove the installed native runtime with `rm -rf ~/.local/lib/blip-cli`. Your sign-in and Blip data stay in `~/.local/share/net.blip.Blip`; delete that directory only if you want to remove them too.

## Sign in

```sh
blip login
```

`blip` asks for your email, and Blip emails you a 6-digit code. Type it at the `code:` prompt. A wrong code gets you two more tries. You can also pass the email as an argument (`blip login you@example.com`), but then it stays in your shell history.

`login` reads from the terminal. Over ssh, `ssh -t host blip login` works best. It also reads answers piped to it, one per line. If the input ends before you type the code, `login` stops with `sign-in cancelled: no more input`, and Blip has already emailed a code you can ignore. Ctrl-C stops it with `sign-in cancelled` and exit code 130.

This machine joins your account as a device named after its hostname, up to the first dot. Pass `--name "Home server"` to pick another name. An empty name counts as unset. Blip's servers and your other devices see this name.

```
starting Blip in the background...
email: you@example.com
Blip emailed a 6-digit code to you@example.com
code: 123456
signed in as you@example.com, this device is "home-server"
```

The session survives restarts, so you sign in once. `blip logout` signs out and removes this machine from your device list, which is what **Sign out** in the app's settings does.

`login` and `logout` follow Blip's sign-in flow through RPC. Fresh email-code login remains experimental until tested end to end with this native host.

## The background app

Every command except `status` and `stop` starts the native engine if it isn't running yet. A detached `blip-core` process loads the library directly. It keeps running after the command exits, so later commands are fast and your other devices can reach this one. No desktop login or display is needed.

```sh
blip status   # is Blip running (exit code 1 if not), and who is signed in
blip start    # start it now
blip stop     # stop it
```

The app's output goes to `~/.cache/blip-cli/app.log`. Each start moves the previous log to `app.log.1`, so the log of an app that runs for months keeps growing until the next restart. The engine keeps temporary files in `~/.cache/blip-cli/tmp`, which `blip stop` removes. Only you can read the directory, the logs, and those temporary files.

The app inherits the environment of the command that starts it, so start it from a shell that doesn't hold secrets you don't want it to see. `blip` starts it with a umask that keeps other users from writing to, and so connecting to, its socket.

While the app runs, this machine is a Blip device like any other, and it receives as well as sends. Depending on the app's auto-accept setting, transfers from your own devices may be saved here without a prompt and with no size limit. `blip` can't accept, decline or cancel transfers or change that setting, and `blip transfers` lists incoming ones only as `in`. If you only want to send, run `blip stop` when you're done. Every command except `status` and `stop` starts the app again.

If Blip is already running some other way and answers on its socket, for example as a systemd service or in a desktop session, `blip` uses that instance. Native startup never asks the engine to take over another instance. Don't run `blip` while such an instance is still starting up, or `blip` starts a second one. `blip stop` only stops an instance that `blip` started.

To start Blip at boot, add this line to your crontab (`crontab -e`):

```
@reboot $HOME/.local/bin/blip start
```

Cron runs jobs with `PATH=/usr/bin:/bin`. If `command -v node` prints a path outside those two directories, for example under nvm, put its directory first:

```
@reboot PATH=/home/you/.nvm/versions/node/v22.12.0/bin:/usr/bin:/bin $HOME/.local/bin/blip start
```

Some systems stop a user's processes at logout (systemd-logind `KillUserProcesses=yes`). There, an app started from an ssh session stops when you log out, so start it at boot instead.

## Migrate from the desktop runtime

The native host uses the same `~/.local/share/net.blip.Blip` data directory and `~/.cache/net.blip.Blip/sock` socket as the Linux desktop app. Stop the old app before starting the native host. Your existing sign-in and device identity are preserved.

If services launch the app through `~/.local/bin/blip`, stop and disable them before installing this CLI. After `./install.sh`, start the native host with `blip start`. Configure boot startup to run that command rather than launching the old desktop executable or its Xvfb wrapper.

Once the native host works, remove the old desktop installation with its official uninstaller. For the tarball installation, download the installer from `https://static.blip.net/linux/install.sh` and run it with `--uninstall`. Keep Blip's data directory. The native runtime lives separately in `~/.local/lib/blip-cli`.

## Send files

```sh
blip send report.pdf --to "Pixel 8"
```

`send` prints progress to stderr and blocks until the transfer finishes. It first names the transfer, then prints a line each time the state changes.

```
transfer <transfer-id> -> Pixel 8
Invited
Active
Completed
```

The exact states you see depend on how quickly the other device answers. The first line may read `not created yet` for a moment before the transfer shows up. If Blip reports an error, the line ends with ` err=` and the local error text, ` remote=` and the other device's error text, or both. The full list of states is in [How it works](#how-it-works).

Several files, folders, or a mix go in one transfer:

```sh
blip send notes.txt photo.jpg ./project-assets/ --to "Work laptop"
```

A folder goes with everything in it, including hidden files such as `.git` or `.env`. The app reads the files when the transfer runs, not when you type the command, so a file you change in the meantime goes out changed.

`blip` remembers the last `--to` device, so after the first send you can leave it out:

```sh
blip send another.pdf
```

The device is picked in this order: `--to` (or `-t`), then `BLIP_TO`, then the remembered device in `~/.config/blip-cli/config.json`, then your only other device if you have just one. An empty value counts as unset. Without any of these, `send` exits with code 2 and asks for `--to`.

A few rules about the device:

- Give its name or its id from `blip devices`. The name must match exactly, ignoring case. Quote it when it contains spaces.
- Only devices on your own account are considered, so a typo can't send anything to another person. If `blip` can't tell which devices are yours, it refuses to send.
- The device you are running on is skipped.

`send` checks its paths before it starts Blip:

- Every path has to exist. A missing one stops the command with `not found: <absolute path>`.
- An empty argument, such as an unset shell variable, stops it with `empty path (an unset variable?)` and exit code 2.
- `send` refuses Blip's own data folder, anything in it, and any folder that contains it, such as `~` or `/`. That folder holds your session. The message is `refusing to send <path>: it contains Blip's own data, including your session`.
- Devices, FIFOs, sockets, and anything under `/dev`, `/proc` or `/sys`, or reached through a link there such as `/dev/stdin`, stop it with `refusing to send <path>: not a regular file or folder`. This only covers the paths you name, not what is inside a folder you send.
- A file whose name looks like an option, such as `--help`, stops the command with exit code 2. When paths come from a glob or a script, put them after `--`: `blip send --to "Pixel 8" -- *`.

The receiving device needs Blip open (phones) or awake (computers).

Stopping `send` early doesn't cancel the transfer. If you press Ctrl-C, `send` gives up waiting, or Blip stops answering after the transfer was created, the background app keeps the transfer and may still deliver it. `send` says so and prints the transfer id. To stop the transfer, decline or cancel it on the receiving device.

## Devices and transfers

`devices` prints one line per device on your account, with the device name, a tab, and its id. The machine you are on is marked.

```
Pixel 8	<device-id>
Work laptop	<device-id>
home-server (this device)	<device-id>
```

`transfers` lists the transfers the app knows about, one per line, as id, direction (`out` or `in`) and state. Pass a transfer id to see just that one. An id that isn't there prints `no such transfer: <id>` and exits with code 1. If a transfer failed, the line ends with a tab and `err=` followed by the local error text, a tab and `remote=` followed by the other device's error text, or both.

```
<transfer-id>	out	Completed
```

Control characters in names, ids, and error texts from Blip are printed as `\uXXXX` escapes.

## Exit codes and settings

| Code | Meaning |
|---|---|
| 0 | Success. For `send`, the transfer completed |
| 1 | Error: not signed in, a failed or cancelled transfer, an unknown or ambiguous device, an unknown transfer id, a missing or refused path, Blip not running (`status`), or Blip failed to start or stop |
| 2 | Wrong usage, such as `send` with no path, an empty path, no device to send to, or an invalid `BLIP_TIMEOUT_S` |
| 3 | `send` gave up waiting, or lost contact with Blip after creating the transfer. The transfer stays queued in Blip |
| 130, 143 | `send` was interrupted (Ctrl-C) or terminated, and the transfer stays queued in Blip. `login` also exits with 130 on Ctrl-C |

| Variable | Default | Effect |
|---|---|---|
| `BLIP_TO` | | Device `send` uses when there is no `--to` |
| `BLIP_TIMEOUT_S` | `300` | Seconds `send` waits for completion before exiting with code 3. Must be a positive number |
| `BLIP_DEVICE_NAME` | hostname up to the first dot | Device name `login` registers, unless `--name` is given |
| `BLIP_APP` | `~/.local/lib/blip-cli/blip-core` | Path of the native host executable, which takes library, cache directory, and data directory arguments |
| `BLIP_LIB` | `~/.local/lib/blip-cli/libblip.so` | Path of the native Blip 1.2.6 library |
| `BLIP_SOCK` | `~/.cache/net.blip.Blip/sock` | Path of the Blip socket. It must be a socket you own. Native startup requires the basename `sock` |
| `XDG_CONFIG_HOME` | `~/.config` | `blip` keeps the remembered device in `$XDG_CONFIG_HOME/blip-cli/config.json` |

Whatever answers on `BLIP_SOCK` sees your email, your sign-in code, and the paths you send. Anyone who can connect to the socket can read your Blip session.

The exit codes make `send` easy to use in scripts:

```sh
if BLIP_TIMEOUT_S=120 blip send backup.tar.gz --to "Pixel 8"; then
  echo "delivered"
else
  code=$?
  if [ "$code" -eq 3 ]; then
    echo "still not delivered after 2 minutes, check later with: blip transfers"
  else
    echo "send failed with code $code"
  fi
fi
```

## Troubleshooting

### Blip does not start

`blip` prints `Blip exited during startup` or `Blip did not open its socket within 60 s`. Read the end of the app log:

```sh
tail -50 ~/.cache/blip-cli/app.log
```

The log holds everything the engine prints. It may include sign-in events, your email address, device names and ids, file names, and network addresses. Treat it as private and remove sensitive data before sharing an excerpt.

`Blip is not installed` means the native host executable is missing. `Blip core is not installed` means the native library is missing. Run `./install.sh`, or point `BLIP_APP` and `BLIP_LIB` at the installed native host and library. `BLIP_APP` no longer accepts the desktop executable.

`starting the native Blip core is supported only on Linux` means you attempted automatic startup on an unsupported OS. `native startup requires BLIP_SOCK to end in /sock` means the engine cannot use the chosen socket filename. An existing socket with another filename can still be used.

The app log reports native loading errors, including `could not load Blip core` and `unsupported Blip core: missing hosting symbols`. Check that the library matches the host architecture and supported Blip version. The installer checks both hosting symbols before activating it.

`Blip answers but unexpected reply from Blip (is this a supported Blip version?)` means the app came up but speaks a protocol `blip` doesn't understand, usually after a Blip update. See [Caveats](#caveats).

`another blip command is still starting Blip` means a second `blip` waited 60 s for the first one to start the app. Run `blip status` to see whether it came up.

### Blip runs but doesn't answer

A bare `timeout` error means the socket accepted the connection but the app did not answer within 15 seconds. Run `blip stop`, then try again.

`unexpected reply from Blip (is this a supported Blip version?)` and `can't tell which devices are yours (is this a supported Blip version?)` mean the app answered with something `blip` doesn't understand. This usually follows a Blip update. See [Caveats](#caveats).

`refusing <socket>: it is not a socket you own` means the path in `BLIP_SOCK` (or the default path) is not a socket, or another user owns it.

### Blip does not stop

`Blip did not stop within 10 s` means the app that `blip` started ignored the stop signal. Check the log, then run `blip stop` again.

`Blip still answers on its socket after 10 s` means another Blip is running, for example as a systemd service, or the app is stuck.

### Not signed in

`send`, `devices` and `transfers` exit with code 1 and `not signed in (run: blip login)` until you sign in. `blip logout` with no one signed in prints `not signed in` and exits with code 0. `blip login` when an account is already signed in prints `already signed in as <email> (run blip logout first to switch accounts)` and exits with code 0.

### Device not found or ambiguous

```
no such device "Pixle 8" among your own devices (see: blip devices)
```

Run `blip devices` and copy the name from there. If the device is missing from the list, it is not on the account this machine is signed in to. The machine you are running on never matches, because you can't send to yourself.

The same message says `ambiguous` when two of your devices share one name. Pass the device id from `blip devices` instead of the name.

### Timeout, exit code 3

```
timed out waiting (peer offline or not accepting?); transfer <transfer-id> stays queued in Blip and may still be delivered (check: blip transfers <transfer-id>)
```

The transfer was created, but the other device never finished it. The usual cause is a phone with Blip closed or a laptop that is asleep. Wake the device, then check the transfer with `blip transfers <transfer-id>`. For large files on a slow link, raise the limit with `BLIP_TIMEOUT_S`.

Don't run the same `send` again right away. The first transfer is still queued, and a second one would deliver the files twice.

## How it works

DRPC frames look like this: `control byte | varint stream | varint message | varint length | data`. The low bit of the control byte is the done flag. drpc splits a message over 64 KiB into several frames, and the frame with the done flag set is the last one. A call is Invoke (method name), Message (request), CloseSend.

| Call | Purpose |
|---|---|
| `/rpc.Service/GetState` | returns a message whose field 2 is `State`. The session is a oneof of `Registration` (tag 200, signed out) and `Auth` (tag 201, signed in). Devices are under `State.users` (tag 500) and transfers under tag 600 |
| `/rpc.Service/Dispatch` | takes `DispatchRequest{event: Any}` |

Signing in is two events: `event.SendRegistrationCodeRequested{email, device_name}`, then `event.RegistrationRequested{code, device_dedupe_id, device_name, device_kind}`. `Registration.status` goes 0 NotStarted, 1 SendingCode, 2 CodeSent, 3 Registering, and errors land in `Registration.error` (tag 999). The dedupe id is the first 36 characters of `~/.local/share/net.blip.Blip/hardwareinfo/device-dedupe-id.txt`, the file the app itself uses, so signing in again replaces this device instead of adding one. If the file doesn't exist yet, `blip login` creates it with a new random UUID. If it doesn't start with a UUID, `login` stops and names the file. Signing out is `event.RemoveDeviceThenLogout{}`.

Sending is three events: `event.TransferCreateRequested{transfer_id, peer_id}`, `event.TransferAddContentRequested{transfer_id, locations[]}` and `event.TransferInviteRequested{transfer_id, peer_id}`, where `blip.PeerId{user_id, device_id}`. Transfer status (tag 800): 1 Created, 2 InviteRequested, 3 Invited, 4 Pending, 5 Active, 6 Paused, 7 ResumeRequested, 8 Completed, 9 Cancelled.

The host loads `libblip_host` and `libblip_host_stop` with `dlopen` and `dlsym`. It starts hosting without takeover, handles SIGINT and SIGTERM, calls the engine's stop function, and exits without unloading Go code while its threads may still exist. The CLI sends `event.SetUserAgent` after native startup and before fresh registration. REA supplied Go build information and native disassembly for this interface.

The method names and field numbers come from the Wire-generated protobuf classes in the Blip 1.2.6 Linux app (`rpc.DispatchRequest`, `net.blip.libblip.event.*` and `net.blip.libblip.frontend.{State,Registration,Auth,Transfer,Users}`). See [LEGAL.md](LEGAL.md) for what that review covered and what it didn't settle.

## Caveats

This depends on undocumented internals. A Blip update may change method names or field numbers. `blip` then stops with `unexpected reply from Blip` or `can't tell which devices are yours` rather than guessing, until someone updates it for the new version.

Never print raw `GetState` output or read `~/.local/share/net.blip.Blip/state.dat`. Both hold session credentials for the signed-in account.

## Development

`node --test` runs the tests. They drive the CLI and DRPC client against a fake socket server with a throwaway `HOME`. Native host tests compile a fake library with `cc`, and Linux lifecycle tests use a fake daemon. No Blip account or installed engine is needed. Run real-engine startup checks on Linux with a throwaway `HOME`, and never print raw state or read `state.dat`.

## License and Blip attribution

Copyright 2026 Sahil Saleem. This repository's code and documentation are available under the [MIT license](LICENSE).

[Blip](https://blip.net/) is proprietary software provided by Blip Studio Inc. Blip's software, trademarks, and content belong to Blip Studio Inc. This CLI is an independent, unofficial project, with no affiliation with or endorsement by Blip Studio Inc. The MIT license does not license Blip's app, services, trademarks, or other proprietary material.

Use of Blip remains subject to [Blip's terms of service](https://blip.net/terms-of-service), including its commercial licensing requirements and restrictions on trademark use. Attribution does not establish permission to use Blip's trademarks or legal clearance for reverse engineering or use of its undocumented RPC interface. See [LEGAL.md](LEGAL.md) for the source review and remaining uncertainty.
