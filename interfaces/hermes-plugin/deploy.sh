#!/usr/bin/env bash
# Deploy the engram Hermes memory-provider plugin into every profile's
# user-lane plugin directory. Copies (never symlinks) the runtime files so
# each profile is self-contained and `hermes plugins doctor` can copytree it.
#
# Usage: interfaces/hermes-plugin/deploy.sh
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HERMES_ROOT="${HERMES_ROOT:-$HOME/.hermes}"
RUNTIME_FILES=(__init__.py plugin.yaml README.md)
PROFILES=(career pmp network finance)

for f in "${RUNTIME_FILES[@]}"; do
  [ -f "$SRC/$f" ] || { echo "deploy: missing $SRC/$f" >&2; exit 1; }
done

targets=("$HERMES_ROOT/plugins/engram")
for p in "${PROFILES[@]}"; do
  if [ -d "$HERMES_ROOT/profiles/$p" ]; then
    targets+=("$HERMES_ROOT/profiles/$p/plugins/engram")
  else
    echo "skip: profile '$p' not present at $HERMES_ROOT/profiles/$p"
  fi
done

for dst in "${targets[@]}"; do
  case "$dst" in
    "$HERMES_ROOT"/plugins/engram|"$HERMES_ROOT"/profiles/*/plugins/engram) ;;
    *) echo "deploy: refusing unexpected target $dst" >&2; exit 1 ;;
  esac
  if [ -L "$dst" ]; then
    rm "$dst"                      # stale symlink from the earlier rollout
  elif [ -d "$dst" ]; then
    rm -rf "$dst"                  # previous copy
  fi
  mkdir -p "$dst"
  for f in "${RUNTIME_FILES[@]}"; do
    cp "$SRC/$f" "$dst/$f"
  done
  echo "deployed: $dst"
done

echo "done: ${#targets[@]} target(s). Restart gateways to load the new code."
