# CLI for Blip

An unofficial command line tool that works with [Blip](https://blip.net). Send files and folders to your own Blip devices from the terminal, on Linux or macOS without opening the desktop app.

CLI for Blip is an independent project. It is not affiliated with, endorsed by, or sponsored by Blip Studio Inc. Blip is a trademark of Blip Studio Inc., and its name appears here only to say what this tool works with.

I made this for free, for Blip to implement if they want to. Blip has not approved or endorsed it.

The command is `blip`. Blip's own Linux app uses the same name for its launcher, so read [The `blip` command name](#the-blip-command-name) if you have both. This command runs Blip's native transfer engine directly and talks to its local RPC socket. It needs no GUI app, Java runtime, virtual display, or D-Bus session. The Node.js client has no npm dependencies; a small C launcher hosts the proprietary engine downloaded from Blip. Linux uses Blip 1.2.6; macOS uses the signed BlipKit framework from Blip 1.2.3.

```sh
blip login                          # sign in with the code Blip emails you
blip send report.pdf --to "Pixel 8" # waits until the transfer completes
blip send photos/                   # same device as last time
blip logout
```

## What you need

- Linux with glibc on x86-64, or macOS on Apple Silicon. macOS support is a preview: native installation, email-code login, lifecycle and authenticated outgoing file and folder transfers are verified on macOS 27.0.1. Linux aarch64 and Intel macOS are experimental
- Node.js 22 or newer (`node --version` to check)
- A C compiler (`cc`), `git`, and `curl` to install. Linux also needs `tar` and `sha256sum`. On Debian or Ubuntu: `sudo apt install build-essential git curl tar coreutils`
- On macOS, install the Xcode Command Line Tools with `xcode-select --install` if needed. The installer also uses the system `unzip`, `shasum`, and `codesign` commands
- A Blip account, with Blip also installed on at least one other device you want to send to

The installer downloads the official archive and verifies its pinned SHA-256 checksum. Linux keeps only the native engine library. macOS keeps the intact BlipKit framework and verifies its signature integrity; its `Info.plist` and resources are required for that signature to remain valid. The installer never installs or launches the GUI app. The Mac framework links Apple system frameworks, including AppKit and SwiftUI, but does not open an app window. You still use Blip's proprietary engine and service, so [Blip's terms of service](https://blip.net/terms-of-service) apply. Commercial use requires a Business plan.

## Use with an agent

Install the reusable [cli-for-blip-skill](https://github.com/SahilUX/cli-for-blip-skill#readme) to let an agent send files with this CLI. Its README includes installation instructions for agent skill directories.

The skill provides instructions only. It requires this CLI, Node.js 22 or newer, the native Blip engine installed by this repository, an account signed in on the sending machine, and Blip on the receiving device. Installing the skill does not install or authenticate any of those prerequisites.

## Install

Clone the repository into a directory that only you can write to, such as one under your home directory. `~/.local/bin/blip` links into the clone, so whoever can write to the clone controls what `blip` runs.

```sh
git clone https://github.com/SahilUX/cli-for-blip.git
cd cli-for-blip
./install.sh
```

`install.sh` builds `native/host.c`, installs the launcher and native library in `~/.local/lib/blip-cli`, and links `~/.local/bin/blip` to this checkout. It pins Linux Blip 1.2.6 and macOS Blip 1.2.3 because the hosting ABI is undocumented. Re-running it repairs the installation at that version. It stages and checks the replacement before switching, and restores the previous runtime if activation fails.

If you already run the GUI app through `~/.local/bin/blip`, the installer stops unless you choose to replace it. See [The `blip` command name](#the-blip-command-name) and [Migrate from the desktop runtime](#migrate-from-the-linux-desktop-runtime).

Make sure `~/.local/bin` is on your `PATH`. On Debian and Ubuntu, `~/.profile` adds it for login shells only, so a non-interactive shell, as in `ssh server blip ...`, cron, or a service, doesn't find `blip`. Use the full path, `~/.local/bin/blip`, there. The same goes for `node` if it lives somewhere like nvm: `blip` runs it with `/usr/bin/env node`, so `node` has to be on that shell's `PATH` too.

To update the CLI, pull this repository and run `./install.sh` again. A running engine keeps its old code until you run `blip stop` and `blip start`. Updating the engine version requires verifying its native ABI and protocol and changing the installer pins.

Don't move or delete the clone while `blip` is installed. If you move it, relink from the new place with `ln -sfn "$PWD/blip.mjs" ~/.local/bin/blip`. Running `./install.sh` there also works; it downloads and reinstalls the pinned engine.

If your clone still points at the repository's earlier name, `blip-cli`, GitHub redirects it. To use the new address, run `git remote set-url origin https://github.com/SahilUX/cli-for-blip.git` in the clone. You don't need to rename or move it.

## The `blip` command name

This CLI's command is `blip`, and Blip's own Linux app also calls its launcher `blip`. Only one of them can be `~/.local/bin/blip`. `install.sh` checks what is there first:

| `~/.local/bin/blip` is | `install.sh` |
|---|---|
| Nothing | Creates the link to this CLI |
| A link to a clone of this CLI, or to a `blip.mjs` that no longer exists | Points it at this clone |
| Blip's launcher, a link to `~/.local/opt/blip/bin/blip` | Stops, unless you pass `--replace-launcher` |
| Any other file, folder, or link | Stops and changes nothing. Move it first |

To choose which one owns the name:

- **This CLI:** run `./install.sh --replace-launcher`, or uninstall the Blip app first. `--replace-launcher` changes only that link. The app stays in `~/.local/opt/blip`, and its menu entry still starts it, because that entry uses the full path.
- **Blip's launcher:** run `./install.sh --replace-launcher`, then give the CLI a name of your own and put the launcher back. Do this again after every update, and use your name wherever this README says `blip`:

  ```sh
  ln -sfn "$PWD/blip.mjs" ~/.local/bin/my-blip
  ln -sfn ~/.local/opt/blip/bin/blip ~/.local/bin/blip
  ```

Blip's installer also refuses to replace this CLI's link. Remove `~/.local/bin/blip` before you run it.

A `blip` elsewhere on your `PATH`, such as one from a packaged Blip app in `/usr/bin` or `/snap/bin`, isn't touched. Whichever directory comes first on `PATH` wins, and the wrong one may open the Blip app instead of running your command. `install.sh` warns when another `blip` comes first, and mentions one that comes later. It can only see the `PATH` it runs with, so check again in other shells, cron jobs, and services:

```sh
command -v blip      # which one this shell runs
type -a blip         # every blip on PATH (bash and zsh)
readlink ~/.local/bin/blip   # ends in /blip.mjs when it is this CLI
```

If the wrong one runs, put `~/.local/bin` first on `PATH`, or use the full path `~/.local/bin/blip`. A shell that was already open may remember the old one until you run `hash -r` or open a new shell. A shell alias or function named `blip` also takes precedence.

## Platform paths

The install, config, cache, and macOS profile paths still use the project's earlier name, `blip-cli`, so existing installations keep working.

| Purpose | Linux | macOS |
|---|---|---|
| Native host | `~/.local/lib/blip-cli/blip-core` | Same |
| Native library | `~/.local/lib/blip-cli/libblip.so` | `~/.local/lib/blip-cli/BlipKit.framework/Versions/A/BlipKit` |
| RPC socket | `~/.cache/net.blip.Blip/sock` | `~/Library/Caches/blip-cli/engine/sock` |
| Session and device data | `~/.local/share/net.blip.Blip` | `~/Library/Application Support/blip-cli/engine` |
| Log, PID, start lock, temporary files | `~/.cache/blip-cli` | `~/Library/Caches/blip-cli` |
| Remembered device | `~/.config/blip-cli/config.json` | `~/Library/Application Support/blip-cli/config.json` |

An absolute `XDG_CONFIG_HOME` overrides the remembered-device directory on either platform. `BLIP_APP`, `BLIP_LIB`, and `BLIP_SOCK` override the host, library, and socket paths. The socket's directory is also the engine's cache directory.

The Mac CLI has its own profile. The CLI does not read or migrate the desktop app's credential files in its protected Group Container, and does not stop that app. Run `blip login --name "Mac CLI"` to register a separate device. Keep the desktop app if you want its GUI as well. Unlike the desktop app's Group Container, the CLI profile is protected only by Unix permissions (mode 700), like the Linux profile.

## Uninstall

Run these before you delete the clone:

```sh
blip logout              # sign out and remove this machine from your device list (exit code 4: removal not confirmed)
blip stop                # stop the background app that blip started
rm ~/.local/bin/blip
rm -rf ~/.cache/blip-cli "${XDG_CONFIG_HOME:-$HOME/.config}/blip-cli"
```

Remove the installed native runtime with `rm -rf ~/.local/lib/blip-cli`. On macOS, also remove `~/Library/Caches/blip-cli` and the remembered-device `config.json` listed above. The engine profile remains in the platform data directory; delete that directory only if you want to remove it too. On Linux the engine also keeps its cache and socket in `~/.cache/net.blip.Blip`, which it shares with the desktop app; remove it together with the data directory. We have not audited every Apple system storage location the proprietary framework may use.

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

The session survives restarts, so you sign in once. On macOS this is separate from signing in to the desktop app. `blip logout` asks Blip to remove this machine from your device list and sign out, which is what **Sign out** in the app's settings does.

Blip's engine signs out on this machine even if removing the device failed, for example because you are offline. `logout` checks the engine's log and reports what it found:

| Exit code | What happened |
|---|---|
| 0 | Signed out, and the engine logged that the device was removed from your account. Also when no one was signed in |
| 4 | Signed out on this machine, but the removal is not confirmed. The device may still be on your account |
| 3 | Not signed out after 30 seconds (or `BLIP_TIMEOUT_S`, if smaller), or `blip` lost contact with the engine. The engine may still finish, so check `blip status` |

After exit code 4, remove the device in Blip on another device with **Remove this device**. You can also run `blip login` and then `blip logout` on this machine once you are online. Exit code 4 is also what you get when the engine's log isn't in the log file listed under [Platform paths](#platform-paths), as with a Blip that `blip` did not start.

`login` and `logout` follow Blip's sign-in flow through RPC. Email-code login has been verified on macOS and Linux x86-64, and a real logout on Linux x86-64. Real-service logout on macOS is still unverified. The log check was tested against the Linux engine. If the macOS engine logs it differently, `logout` exits with code 4 even when the removal worked.

## The background app

Every command except `status` and `stop` starts the native engine if it isn't running yet. A detached `blip-core` process loads the library directly. It keeps running after the command exits, so later commands are fast and your other devices can reach this one. On Linux, no desktop login or display is needed. On macOS, unattended and SSH use have not been verified (see [macOS file access](#macos-file-access)).

```sh
blip status   # is Blip running (exit code 1 if not), and who is signed in
blip start    # start it now
blip stop     # stop it
```

The engine's output goes to `app.log` in the platform log directory listed above. Each start moves the previous log to `app.log.1`, so the log of an app that runs for months keeps growing until the next restart. The engine keeps temporary files in `tmp` in that directory, which `blip stop` removes. Only you can read the directory, the logs, and those temporary files.

The app inherits the environment of the command that starts it, so start it from a shell that doesn't hold secrets you don't want it to see. `blip` starts it with a umask that keeps other users from writing to, and so connecting to, its socket.

When `blip` starts the engine, and again at `login`, it sends the engine a user agent with your OS name and kernel release, as the desktop app does, and names the client `blip-cli` (app id `io.github.sahilux.blip-cli`). The engine appears to pass this on to Blip's servers, so Blip can tell that this device uses an unofficial client.

While the app runs, this machine is a Blip device like any other, and it receives as well as sends. Depending on the app's auto-accept setting, transfers from your own devices may be saved here without a prompt and with no size limit. See [Receive files](#receive-files). `blip` can't cancel a transfer. If you only want to send, run `blip stop` when you're done. Every command except `status` and `stop` starts the app again.

On Linux, if Blip is already running some other way and answers on its socket, for example as a systemd service or in a desktop session, `blip` uses that instance. On macOS the desktop app uses its own profile and socket, so `blip` always runs its own engine. Native startup never asks the engine to take over another instance. Don't run `blip` while such an instance is still starting up, or `blip` starts a second one. `blip stop` only stops an instance that `blip` started.

On Linux, to start Blip at boot, add this line to your crontab (`crontab -e`):

```
@reboot $HOME/.local/bin/blip start
```

Cron runs jobs with `PATH=/usr/bin:/bin`. If `command -v node` prints a path outside those two directories, for example under nvm, put its directory first:

```
@reboot PATH=/home/you/.nvm/versions/node/v22.12.0/bin:/usr/bin:/bin $HOME/.local/bin/blip start
```

Some systems stop a user's processes at logout (systemd-logind `KillUserProcesses=yes`). There, an app started from an ssh session stops when you log out, so start it at boot instead.

## Migrate from the Linux desktop runtime

On Linux, the native host uses the same `~/.local/share/net.blip.Blip` data directory and `~/.cache/net.blip.Blip/sock` socket as the Linux desktop app. Stop the old app before starting the native host. Your existing sign-in and device identity are preserved.

If services launch the app through `~/.local/bin/blip`, stop and disable them before installing this CLI. After `./install.sh --replace-launcher`, start the native host with `blip start`. Configure boot startup to run that command rather than launching the old desktop executable or its Xvfb wrapper.

On Linux, once the native host works, remove the old desktop installation with its official uninstaller. For the tarball installation, download the installer from `https://static.blip.net/linux/install.sh` and run it with `--uninstall`. Keep Blip's data directory. The native runtime lives separately in `~/.local/lib/blip-cli`.

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

The exact states you see depend on how quickly the other device answers. The first line may read `not created yet` for a moment before the transfer shows up. If Blip reports an error, the line ends with ` err=` and the local error text, ` remote=` and the other device's error text, or both. The full list of states is in [For Nerds](#for-nerds).

Several files, folders, or a mix go in one transfer:

```sh
blip send notes.txt photo.jpg ./project-assets/ --to "Work laptop"
```

A folder goes with everything in it, including hidden files such as `.git` or `.env`. The app reads the files when the transfer runs, not when you type the command, so a file you change in the meantime goes out changed.

`blip` remembers the last `--to` device, so after the first send you can leave it out:

```sh
blip send another.pdf
```

The device is picked in this order: `--to` (or `-t`), then `BLIP_TO`, then the remembered device in the platform config file, then your only other device if you have just one. An empty value counts as unset. Without any of these, `send` exits with code 2 and asks for `--to`.

A few rules about the device:

- Give its name or its id from `blip devices`. The name must match exactly, ignoring case. Quote it when it contains spaces.
- Only devices on your own account are considered, so a typo can't send anything to another person. If `blip` can't tell which devices are yours, it refuses to send.
- The device you are running on is skipped.

`send` checks its paths before it starts Blip:

- Every path has to exist. A missing one stops the command with `not found: <absolute path>`.
- An empty argument, such as an unset shell variable, stops it with `empty path (an unset variable?)` and exit code 2.
- `send` refuses Blip's own data folders (this CLI's profile and, on macOS, the desktop app's Group Container), anything in them, and any folder that contains them, such as `~` or `/`. Those folders hold your session. The message is `refusing to send <path>: it contains Blip's own data, including your session`. The check compares paths, so it can't recognize copies or hard links of that data elsewhere.
- Devices, FIFOs, sockets, and anything under `/dev`, `/proc` or `/sys`, or reached through a link there such as `/dev/stdin`, stop it with `refusing to send <path>: not a regular file or folder`. This only covers the paths you name, not what is inside a folder you send.
- A file whose name looks like an option, such as `--help`, stops the command with exit code 2. When paths come from a glob or a script, put them after `--`: `blip send --to "Pixel 8" -- *`.

The receiving device needs Blip open (phones) or awake (computers).

Stopping `send` early doesn't cancel the transfer. If you press Ctrl-C, `send` gives up waiting, or Blip stops answering after the transfer was created, the background app keeps the transfer and may still deliver it. `send` says so and prints the transfer id. To stop the transfer, decline or cancel it on the receiving device.

## Receive files

While Blip runs, files your other devices send to this one land in the receive folder, which is `~/Downloads` unless you set another. Blip doesn't create that folder, and a transfer that fails on a missing folder stays `Invited` and shows `err=stat <folder>: no such file or directory`. So every `blip` command that starts or reaches the app creates the folder first (and says `created <folder> for incoming files`). If it can't, it prints a warning and carries on. `blip start` at boot (see [The background app](#the-background-app)) is enough to keep the folder there.

```sh
blip folder                  # show where incoming files are saved
blip folder ~/Inbox          # save them there instead (signed in; creates the folder)
blip auto-accept             # show whether your own devices' transfers are saved without asking
blip auto-accept off         # ask first (signed in); `on` turns it back on
blip transfers               # incoming ones show as "in"; a finished one ends with saved=<path>
blip accept <id>             # accept one incoming transfer that is waiting (state Invited)
blip accept                  # accept every incoming transfer that is waiting
blip accept <id> --dir ~/x   # accept it and save it into that folder
blip decline <id>            # decline an incoming transfer
```

`accept` and `decline` wait up to 15 seconds (or `BLIP_TIMEOUT_S`, if smaller) for Blip to act, then print the new state: `<id>`, a tab, and `Active`, `Completed`, `declined` or similar. If the transfer is still `Invited`, they print the error Blip reports and exit with code 1. They refuse outgoing transfers and finished ones. A transfer that got stuck on a missing folder can be accepted again once the folder exists.

## Devices and transfers

`devices` prints one line per device on your account, with the device name, a tab, and its id. The machine you are on is marked.

```
Pixel 8	<device-id>
Work laptop	<device-id>
home-server (this device)	<device-id>
```

`transfers` lists the transfers the app knows about, one per line, as id, direction (`out` or `in`) and state. Pass a transfer id to see just that one. An id that isn't there prints `no such transfer: <id>` and exits with code 1. If a transfer failed, the line ends with a tab and `err=` followed by the local error text, a tab and `remote=` followed by the other device's error text, or both. Once Blip has saved an incoming transfer, the line ends with a tab and `saved=` followed by where it put it.

```
<transfer-id>	out	Completed
```

Control characters in names, ids, and error texts from Blip are printed as `\uXXXX` escapes.

## Exit codes and settings

| Code | Meaning |
|---|---|
| 0 | Success. For `send`, the transfer completed |
| 1 | Error: not signed in, a failed or cancelled transfer, an unknown or ambiguous device, an unknown transfer id, an `accept` or `decline` that Blip did not act on, a missing or refused path, Blip not running (`status`), or Blip failed to start or stop |
| 2 | Wrong usage, such as `send` with no path, an empty path, no device to send to, or an invalid `BLIP_TIMEOUT_S`, `decline` with no id, or an unknown `auto-accept` value |
| 3 | `send` gave up waiting, or lost contact with Blip after creating the transfer. The transfer stays queued in Blip. Also `logout` when Blip did not sign out in time or stopped answering |
| 4 | `logout` signed out on this machine, but Blip did not confirm removing the device from your account. See [Sign in](#sign-in) |
| 130, 143 | `send` was interrupted (Ctrl-C) or terminated, and the transfer stays queued in Blip. `login` also exits with 130 on Ctrl-C |

| Variable | Default | Effect |
|---|---|---|
| `BLIP_TO` | | Device `send` uses when there is no `--to` |
| `BLIP_TIMEOUT_S` | `300` | Seconds `send` waits for completion before exiting with code 3. Must be a positive number. A smaller value also shortens the waits of `accept`, `decline`, and `logout` |
| `BLIP_DEVICE_NAME` | hostname up to the first dot | Device name `login` registers, unless `--name` is given |
| `BLIP_APP` | `~/.local/lib/blip-cli/blip-core` | Path of the native host executable, which takes library, cache directory, and data directory arguments. On macOS it must also answer `--identity <pid>`, as the installed `blip-core` does |
| `BLIP_LIB` | See platform paths | Path of the native library or intact Mac framework binary |
| `BLIP_SOCK` | See platform paths | Path of the Blip socket. It must be a socket you own. Native startup requires the basename `sock`. Its directory is also the engine's cache directory, so it must be a folder you own that no one else can write to; `blip` creates a missing one with mode 700 |
| `XDG_CONFIG_HOME` | See platform paths | An absolute override keeps the remembered device in `$XDG_CONFIG_HOME/blip-cli/config.json` |

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
tail -50 ~/.cache/blip-cli/app.log  # Linux; use ~/Library/Caches/blip-cli/app.log on macOS
```

The log holds everything the engine prints. It may include sign-in events, your email address, device names and ids, file names, and network addresses. Treat it as private and remove sensitive data before sharing an excerpt.

`Blip is not installed` means the native host executable is missing. `Blip core is not installed` means the native library is missing. Run `./install.sh`, or point `BLIP_APP` and `BLIP_LIB` at the installed native host and library. `BLIP_APP` must point at the native host `blip-core`. If you set it to the old desktop executable, unset it: `blip` would run that program with native-host arguments.

`starting the native Blip core is supported only on Linux and macOS` means you attempted automatic startup on an unsupported OS. `native startup requires BLIP_SOCK to end in /sock` means the engine cannot use the chosen socket filename. `Blip socket path is too long` means the path exceeds the OS limit; set `BLIP_SOCK` to a shorter path ending in `/sock`, in a folder only you can write to (not `/tmp`). An existing socket with another filename can still be used. `refusing <folder> for BLIP_SOCK: Blip keeps its cache there, so it must be a folder you own that no one else can write to` means another user owns that folder or others can write to it. Use a folder of your own, for example `mkdir -m 700 ~/blip` and `BLIP_SOCK=$HOME/blip/sock`.

The app log reports native loading errors, including `could not load Blip core` and `unsupported Blip core: missing hosting symbols`. Check that the library matches the host architecture and supported Blip version. The installer checks both hosting symbols before activating it. On macOS, a process-identity helper failure preserves the PID record and prints `could not verify Blip process`; check `BLIP_APP` or reinstall the native host, then retry `stop`.

`Blip answers but unexpected reply from Blip (is this a supported Blip version?)` means the app came up but speaks a protocol `blip` doesn't understand, usually after a Blip update. See [Caveats](#caveats).

`another blip command is still starting Blip` means a second `blip` waited 60 s for the first one to start the app. Run `blip status` to see whether it came up.

### Blip runs but doesn't answer

A bare `timeout` error means the socket accepted the connection but the app did not answer within 15 seconds. Run `blip stop`, then try again.

`unexpected reply from Blip (is this a supported Blip version?)` and `can't tell which devices are yours (is this a supported Blip version?)` mean the app answered with something `blip` doesn't understand. This usually follows a Blip update. See [Caveats](#caveats).

`refusing <socket>: it is not a socket you own` means the path in `BLIP_SOCK` (or the default path) is not a socket, or another user owns it.

### Blip does not stop

`Blip did not stop within 10 s` means the app that `blip` started ignored the stop signal. Check the log, then run `blip stop` again.

`Blip still answers on its socket after 10 s` means another Blip is running, for example as a systemd service, or the app is stuck.

### macOS file access

On macOS, a file-read failure can mean that the launching terminal or app needs access under System Settings > Privacy & Security > Files and Folders. The CLI does not grant itself permissions. A remote SSH session may have different permissions from a local terminal; unattended SSH use has not been verified.

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

## For Nerds

### What we reverse engineered

We reverse engineered the local control interface between Blip's desktop frontend and its native engine. We did not rebuild Blip's account service, networking, encryption, or file-transfer engine. Those still run inside Blip's proprietary code. Our code supplies a terminal interface and a small host for that engine.

On Linux, Blip 1.2.6 packages a Kotlin desktop frontend, a JVM, generated protobuf classes, and a Go engine behind a JNI library. We inspected:

- `lib/runtime/lib/libblip-jni.so`, which exports the native hosting functions as well as JNI bindings.
- `lib/app/libblip-jvm.jar`, especially `LibBlip.Companion`, `Core`, the Wire-generated `frontend` and `event` messages, and the device-kind enum.
- `lib/app/desktopApp-desktop-1.2.6.jar`, whose startup code showed the cache/data arguments and production server address supplied to the engine.

[REA](https://github.com/morluto/rea) supplied Go build information and native disassembly through GNU objdump. We compared the native calls with Java API and bytecode listings from `javap`. That established the hosting argument order, the RPC service names, the protobuf field numbers, and the initialization event the frontend sends. We verified wire enum values rather than treating Java enum positions as protocol values.

On macOS, Blip 1.2.3 puts its native engine in `Blip.app/Contents/Frameworks/BlipKit.framework/Versions/A/BlipKit`. Its universal binary exports the same hosting functions. REA identified the embedded Go engine in the arm64 image, and a small launcher proved that it could serve the existing RPC protocol without starting the desktop executable.

### What parts of the app we use

The Linux installer downloads the official archive and retains `libblip-jni.so` as `libblip.so`. Despite its JNI name, that library exports a C interface that works without Java. The previous Xvfb/D-Bus/JVM setup is no longer needed.

The Mac installer retains the complete signed `BlipKit.framework`. Extracting only its executable binary failed signature validation because the signature also binds `Info.plist` and framework resources. Keeping the framework intact lets us verify and load the vendor's unmodified code. It still links Apple system frameworks, including AppKit and SwiftUI; we do not launch the Blip desktop frontend or copy its protected account profile.

Neither platform installs the GUI executable. No Blip binaries, generated schema classes, or decompiled implementation bodies are committed to this repository. The installer downloads the platform-specific pinned archive from Blip and verifies its checksum. The Mac installer also verifies framework signature integrity. See [LEGAL.md](LEGAL.md) for provenance and the limits of this review.

### How we implemented the headless host

`native/host.c` uses `dlopen` and `dlsym` to load two exported functions:

```c
void libblip_host(int takeover, const char *cache, const char *data,
                 const char *server, const char *signaller);
void libblip_host_stop(void);
```

The launcher passes `takeover = 0`, the platform cache and data directories, `https://prod.blip.net`, and a null optional signaller. The engine owns its RPC socket, session persistence, and transfers. SIGINT and SIGTERM set a flag; the launcher's main loop then calls `libblip_host_stop` outside the signal handler. It exits without unloading Go code while engine threads might still use it.

`blip.mjs` starts that host as a detached process, waits for a usable socket, and sends `event.SetUserAgent`, which the desktop frontend normally supplies. A start lock keeps concurrent commands from racing that initialization. Before stopping a daemon, the CLI checks its PID, process group and kernel start timestamp. Linux reads `/proc`; macOS asks the native helper for `sysctl` process metadata and checks the UID too. A failed identity lookup does not authorize signalling another process.

`platform.mjs` defines paths and protocol-version metadata. macOS uses a separate CLI profile under `~/Library` because the desktop app's Group Container is privacy-protected. The send guard protects both profiles and handles case variants, symlinked home directories, and the `/System/Volumes/Data` and `/.nofollow` spellings of the same paths on Mac filesystems. `drpc.mjs` contains the framing and protobuf walker, using Node's built-in modules rather than an npm RPC or protobuf dependency.

### How the RPC protocol works

DRPC frames look like this: `control byte | varint stream | varint message | varint length | data`. The low bit of the control byte is the done flag. drpc splits a message over 64 KiB into several frames, and the frame with the done flag set is the last one. A call is Invoke (method name), Message (request), CloseSend.

| Call | Purpose |
|---|---|
| `/rpc.Service/GetState` | returns a message whose field 2 is `State`. The session is a oneof of `Registration` (tag 200, signed out) and `Auth` (tag 201, signed in). Devices are under `State.users` (tag 500) and transfers under tag 600 |
| `/rpc.Service/Dispatch` | takes `DispatchRequest{event: Any}` |

Signing in is two events: `event.SendRegistrationCodeRequested{email, device_name}`, then `event.RegistrationRequested{code, device_dedupe_id, device_name, device_kind}`. `Registration.status` goes 0 NotStarted, 1 SendingCode, 2 CodeSent, 3 Registering, and errors land in `Registration.error` (tag 999). The dedupe id is the first 36 characters of `hardwareinfo/device-dedupe-id.txt` in the session data directory (see [Platform paths](#platform-paths)), so signing in again replaces this device instead of adding one. On Linux it is the file the desktop app uses too; on macOS it belongs to the separate CLI profile. If the file doesn't exist yet, `blip login` creates it with a new random UUID. If it doesn't start with a UUID, `login` stops and names the file. Signing out is `event.RemoveDeviceThenLogout{}`. The engine sends one `DELETE /devices/<id>` for its own device. A failure only logs `removing device` and an error. After a success it logs an `InsertAnalyticsEvent` named `DeviceRemove` with the device id. Either way it then signs out, so `logout` looks for that success line in the log.

Receiving: `event.TransferAcceptanceRequested{transfer_id, save_path}` (the path is optional), `event.TransferDeclineRequested{transfer_id}`, `event.TransferSetAutoAccept{auto_accept}` and `event.TransferSetCustomDefaultSavePath{path}`. `State.config` (tag 100) holds `auto_accept_disabled` (tag 2) and `custom_default_save_path` (tag 4); with no custom path the engine saves to `~/Downloads`. A transfer's saved location is tag 501. A signed-out engine logs these events but did not report the change in `State.config`, and a signed-in engine hasn't been checked, so `folder <path>` and `auto-accept on|off` require a sign-in and fail with a timeout if Blip never reports the change.

Sending is three events: `event.TransferCreateRequested{transfer_id, peer_id}`, `event.TransferAddContentRequested{transfer_id, locations[]}` and `event.TransferInviteRequested{transfer_id, peer_id}`, where `blip.PeerId{user_id, device_id}`. Transfer status (tag 800): 1 Created, 2 InviteRequested, 3 Invited, 4 Pending, 5 Active, 6 Paused, 7 ResumeRequested, 8 Completed, 9 Cancelled.

The method names and field numbers come from the Wire-generated protobuf classes in the Blip 1.2.6 Linux app (`rpc.DispatchRequest`, `net.blip.libblip.event.*` and `net.blip.libblip.frontend.{State,Registration,Auth,Transfer,Users}`). See [LEGAL.md](LEGAL.md) for what that review covered and what it didn't settle.

## Caveats

This depends on undocumented internals. A Blip update may change method names or field numbers. `blip` then stops with `unexpected reply from Blip` or `can't tell which devices are yours` rather than guessing, until someone updates it for the new version.

Never print raw `GetState` output or read `state.dat` in the session data directory (`~/.local/share/net.blip.Blip` on Linux, `~/Library/Application Support/blip-cli/engine` on macOS). Both hold session credentials for the signed-in account.

## Development

`node --test` runs the tests. They drive the CLI and DRPC client against a fake socket server with a throwaway `HOME`. Native host tests compile a fake library with `cc`, and Linux and macOS lifecycle tests use a fake daemon. No Blip account or installed engine is needed. Run real-engine startup checks with a throwaway `HOME`, and never print raw state or read `state.dat`.

## License and Blip attribution

Copyright 2026 Sahil Saleem. This repository's code and documentation are available under the [MIT license](LICENSE).

[Blip](https://blip.net/) is proprietary software provided by Blip Studio Inc. Blip's software, trademarks, and content belong to Blip Studio Inc. This CLI is an independent, unofficial project, with no affiliation with or endorsement by Blip Studio Inc. The MIT license does not license Blip's app, services, trademarks, or other proprietary material.

Use of Blip remains subject to [Blip's terms of service](https://blip.net/terms-of-service), including its commercial licensing requirements and restrictions on trademark use. Attribution does not establish permission to use Blip's trademarks or legal clearance for reverse engineering or use of its undocumented RPC interface. See [LEGAL.md](LEGAL.md) for the source review and remaining uncertainty.
