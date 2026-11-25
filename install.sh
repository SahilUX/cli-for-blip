#!/usr/bin/env bash
# Install only Blip's verified native engine and build our small headless host.
set -euo pipefail
umask 077
here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
link="$HOME/.local/bin/blip"
runtime="$HOME/.local/lib/blip-cli"

replace_launcher=false
if (( $# == 1 )) && [[ $1 == --replace-launcher ]]; then replace_launcher=true
elif (( $# )); then echo 'usage: ./install.sh [--replace-launcher]' >&2; exit 2; fi
os=$(uname -s)
arch=$(uname -m)
node -e 'process.exit(+process.versions.node.split(".")[0] >= 22 ? 0 : 1)' 2>/dev/null ||
  { echo 'blip needs Node.js 22 or newer' >&2; exit 1; }
case "$os" in
  Linux)
    version=1.2.6
    library=libblip.so
    tools="cc curl tar sha256sum"
    case "$arch" in
      x86_64) arch=amd64; sha=a88a700e77d58988dc3b1f9ebd38c65782140187a1f17f6a1281b4ab43f5f3df ;;
      aarch64) echo 'note: the aarch64 native runtime is experimental and has not been tested' >&2; sha=0147913600e0b63ab20a39973fc572536a903bbc6f8ee60877a04ea2216eba32 ;;
      *) echo "unsupported architecture: $arch" >&2; exit 1 ;;
    esac
    url="https://static.blip.net/linux/blip-$version-linux-$arch.tar.gz"
    ;;
  Darwin)
    version=1.2.3
    library=BlipKit.framework/Versions/A/BlipKit
    tools="cc curl unzip shasum codesign"
    case "$arch" in
      arm64) ;;
      x86_64) echo 'note: the Intel macOS native runtime is experimental and has not been tested' >&2 ;;
      *) echo "unsupported architecture: $arch" >&2; exit 1 ;;
    esac
    xcode-select -p >/dev/null 2>&1 ||
      { echo 'blip needs the Xcode Command Line Tools (run: xcode-select --install)' >&2; exit 1; }
    url=https://static.blip.net/mac/Blip-20260927200815.zip
    sha=778b777557e508d65aa91e55305397958418dd25e2ea8090aa70d3c12e04ffa2
    ;;
  *) echo 'The headless Blip core is supported only on Linux and macOS' >&2; exit 1 ;;
esac
for tool in $tools; do
  command -v "$tool" >/dev/null || { echo "blip install needs $tool" >&2; exit 1; }
done
if [[ -e $runtime || -L $runtime ]]; then
  [[ -d $runtime && ! -L $runtime && -f $runtime/.blip-cli-install ]] ||
    { echo "refusing to replace an unmanaged install: $runtime" >&2; exit 1; }
fi
# A link to a clone of this CLI is updated. Blip's own installer puts its
# launcher link here too: that one is replaced only when asked. Anything else,
# and any link whose target can't be checked, may belong to someone else.
check_link() {
  local target
  [[ -e $link || -L $link ]] || return 0
  if [[ ! -L $link ]]; then echo "refusing to replace an existing file: $link" >&2; exit 1; fi
  target=$(readlink -- "$link")
  if [[ $target == "$HOME/.local/opt/blip/bin/blip" ]]; then
    [[ $replace_launcher == true ]] && return 0
    echo "refusing to replace Blip's own launcher: $link" >&2
    echo 'Uninstall the Blip app first, or run ./install.sh --replace-launcher to give this CLI that name.' >&2
    exit 1
  fi
  if [[ $target == */blip.mjs && -f $link ]] && [[ $(sed -n 2p -- "$link" 2>/dev/null) == '// blip: headless command line for the Blip '* ]]; then return 0; fi
  if [[ $target == */blip.mjs && ! -f $link ]]; then
    echo "refusing to replace a link that can't be checked: $link -> $target" >&2
    echo 'If it is left over from a clone you moved or deleted, remove the link and run ./install.sh again.' >&2
  else
    echo "refusing to replace an existing file: $link" >&2
  fi
  exit 1
}
check_link

mkdir -p -- "${runtime%/*}" "${link%/*}"
work=$(mktemp -d "${runtime%/*}/.blip-cli-install.XXXXXXXX")
had_previous=false
activated=false
committed=false
cleanup() {
  result=$?
  trap - EXIT
  if [[ $committed == false ]]; then
    [[ $activated == false ]] || rm -rf -- "$runtime"
    [[ $had_previous == false ]] || mv -- "$work/previous" "$runtime"
  fi
  rm -rf -- "$work"
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir -- "$work/next"
cc -std=c11 -O2 -Wall -Wextra -Werror "$here/native/host.c" -ldl -o "$work/next/blip-core"
echo "Downloading Blip $version native engine for $os/$arch..."
curl --fail --silent --show-error --location --retry 3 --output "$work/archive" "$url"
if [[ $os == Linux ]]; then
  printf '%s  %s\n' "$sha" "$work/archive" | sha256sum --check --status ||
    { echo 'Blip archive SHA-256 does not match' >&2; exit 1; }
  tar -xOzf "$work/archive" "blip-$version/lib/runtime/lib/libblip-jni.so" > "$work/next/$library"
else
  actual=$(shasum -a 256 "$work/archive")
  [[ ${actual%% *} == "$sha" ]] || { echo 'Blip archive SHA-256 does not match' >&2; exit 1; }
  # The vendor signature binds Info.plist and framework resources. Keep the
  # framework intact so it can be verified and loaded without re-signing it.
  unzip -q "$work/archive" 'Blip.app/Contents/Frameworks/BlipKit.framework/*' -d "$work/extracted"
  mv -- "$work/extracted/Blip.app/Contents/Frameworks/BlipKit.framework" "$work/next/BlipKit.framework"
  codesign --verify --deep --strict "$work/next/BlipKit.framework"
fi
# Keep the engine library or signed framework, without the desktop executable.
"$work/next/blip-core" --check "$work/next/$library"
printf '%s\n' "$version" > "$work/next/.blip-cli-install"
chmod u+x "$here/blip.mjs"
ln -s -- "$here/blip.mjs" "$work/cli-link"
# Each rename and the flag that records it must happen together, so hold
# Ctrl-C and TERM until the new runtime and link are both in place.
trap '' INT TERM
if [[ -d $runtime ]]; then
  mv -- "$runtime" "$work/previous"
  had_previous=true
fi
mv -- "$work/next" "$runtime"
activated=true
check_link  # again, because the download took a while; a refusal restores the runtime
if [[ $os == Darwin ]]; then
  mv -fh -- "$work/cli-link" "$link"
else
  mv -Tf -- "$work/cli-link" "$link"
fi
committed=true
trap 'exit 130' INT
trap 'exit 143' TERM
on_path=false
[[ :$PATH: != *":$HOME/.local/bin:"* && :$PATH: != *":$HOME/.local/bin/:"* ]] || on_path=true
# Another blip on PATH, such as a packaged Blip app, can run instead of this one.
first=$(type -P blip) || first=
if [[ -n $first && ! $first -ef $link ]]; then
  if [[ $on_path == true ]]; then reason='which comes before ~/.local/bin on your PATH'; else reason='because ~/.local/bin is not on your PATH'; fi
  echo "warning: blip runs $first, $reason. Use $link, or put ~/.local/bin first." >&2
else
  [[ $on_path == true ]] || echo 'note: add ~/.local/bin to your PATH to run blip' >&2
  while IFS= read -r other; do
    [[ $other -ef $link ]] || echo "note: another blip is at $other. Your PATH picks $first first." >&2
  done < <(type -aP blip)
fi
echo 'blip is installed with the native engine. Next: blip login'
if [[ $os == Linux ]]; then
  echo 'For an existing session, stop its old Blip process before running blip start.'
else
  echo 'macOS uses a separate CLI profile; run blip login even if the desktop app is signed in.'
fi
