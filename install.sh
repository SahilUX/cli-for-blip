#!/usr/bin/env bash
# Install or update Blip, then make ~/.local/bin/blip run this CLI instead of the app window.
# Re-run it to update Blip: the official installer refuses to touch a ~/.local/bin/blip it
# doesn't own, so the link is handed back to it for the update and taken over again after.
set -euo pipefail
here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
link="$HOME/.local/bin/blip"

(( $# == 0 )) || { echo 'usage: ./install.sh (it takes no arguments)' >&2; exit 2; }
[[ $(uname -s) == Linux ]] || { echo 'Blip for Linux only runs on Linux' >&2; exit 1; }
node -e 'process.exit(+process.versions.node.split(".")[0] >= 22 ? 0 : 1)' 2>/dev/null ||
  { echo 'blip needs Node.js 22 or newer' >&2; exit 1; }
[[ -x $here/blip.mjs ]] || chmod +x -- "$here/blip.mjs"

# Any link to a blip.mjs is this CLI's, even one left by a clone that has since moved.
# If the official installer fails, even after linking the app there, point the link at this CLI again.
if [[ -L $link && $(readlink -- "$link") == */blip.mjs ]]; then
  trap '[[ $(readlink -- "$link" 2>/dev/null) == */blip.mjs ]] || ln -sfn -- "$here/blip.mjs" "$link"' EXIT
  rm -- "$link"
fi
curl -fsSL https://static.blip.net/linux/install.sh | bash
mkdir -p -- "${link%/*}"
ln -sfn -- "$here/blip.mjs" "$link"

command -v xvfb-run >/dev/null && command -v xauth >/dev/null ||
  echo 'note: install Xvfb and xauth (Debian/Ubuntu: sudo apt install xvfb xauth) so Blip can run without a screen' >&2
command -v dbus-run-session >/dev/null || echo 'note: install D-Bus (Debian/Ubuntu: sudo apt install dbus) so Blip can run without a desktop session' >&2
[[ :$PATH: == *":$HOME/.local/bin:"* ]] || echo "note: add ~/.local/bin to your PATH to run blip" >&2
echo "blip is installed. Next: blip login"
