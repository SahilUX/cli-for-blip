#!/usr/bin/env bash
# Install only Blip's verified native engine and build our small headless host.
set -euo pipefail
umask 077
here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
link="$HOME/.local/bin/blip"
runtime="$HOME/.local/lib/blip-cli"

(( $# == 0 )) || { echo 'usage: ./install.sh (it takes no arguments)' >&2; exit 2; }
[[ $(uname -s) == Linux ]] || { echo 'The headless Blip core is supported only on Linux' >&2; exit 1; }
node -e 'process.exit(+process.versions.node.split(".")[0] >= 22 ? 0 : 1)' 2>/dev/null ||
  { echo 'blip needs Node.js 22 or newer' >&2; exit 1; }
for tool in cc curl tar sha256sum; do
  command -v "$tool" >/dev/null || { echo "blip install needs $tool" >&2; exit 1; }
done
case "$(uname -m)" in
  x86_64) arch=amd64; sha=a88a700e77d58988dc3b1f9ebd38c65782140187a1f17f6a1281b4ab43f5f3df ;;
  aarch64) echo 'note: the aarch64 native runtime is experimental and has not been tested' >&2; arch=aarch64; sha=0147913600e0b63ab20a39973fc572536a903bbc6f8ee60877a04ea2216eba32 ;;
  *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac
if [[ -e $runtime || -L $runtime ]]; then
  [[ -d $runtime && ! -L $runtime && -f $runtime/.blip-cli-install ]] ||
    { echo "refusing to replace an unmanaged install: $runtime" >&2; exit 1; }
fi
if [[ -e $link || -L $link ]]; then
  [[ -L $link ]] && { [[ $(readlink -- "$link") == */blip.mjs ]] || [[ $(readlink -- "$link") == "$HOME/.local/opt/blip/bin/blip" ]]; } ||
    { echo "refusing to replace an existing file: $link" >&2; exit 1; }
fi

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
echo "Downloading Blip 1.2.6 native engine for $arch..."
curl --fail --silent --show-error --location --retry 3 \
  --output "$work/blip.tar.gz" "https://static.blip.net/linux/blip-1.2.6-linux-$arch.tar.gz"
printf '%s  %s\n' "$sha" "$work/blip.tar.gz" | sha256sum --check --status ||
  { echo 'Blip archive SHA-256 does not match' >&2; exit 1; }
# Extract one regular file to stdout, never unpack the app, its JVM or desktop integrations.
tar -xOzf "$work/blip.tar.gz" blip-1.2.6/lib/runtime/lib/libblip-jni.so > "$work/next/libblip.so"
"$work/next/blip-core" --check "$work/next/libblip.so"
printf '1.2.6\n' > "$work/next/.blip-cli-install"
chmod u+x -- "$here/blip.mjs"
ln -s -- "$here/blip.mjs" "$work/cli-link"
if [[ -d $runtime ]]; then
  mv -- "$runtime" "$work/previous"
  had_previous=true
fi
mv -- "$work/next" "$runtime"
activated=true
mv -Tf -- "$work/cli-link" "$link"
committed=true
[[ :$PATH: == *":$HOME/.local/bin:"* ]] || echo 'note: add ~/.local/bin to your PATH to run blip' >&2
echo 'blip is installed with the native engine. Next: blip login'
echo 'For an existing session, stop its old Blip process before running blip start.'
