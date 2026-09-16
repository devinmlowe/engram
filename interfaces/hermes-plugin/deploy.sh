#!/usr/bin/env bash
# Deploy the engram Hermes memory-provider plugin into the user-lane plugin
# directory of $HERMES_HOME and, optionally, of each named profile. Copies
# (never symlinks) the runtime files so each target is self-contained and
# `hermes plugins doctor` can copytree it.
#
# Usage:
#   interfaces/hermes-plugin/deploy.sh
#       -> deploys only to $HERMES_HOME/plugins/engram (default ~/.hermes)
#   ENGRAM_PLUGIN_PROFILES="career pmp" interfaces/hermes-plugin/deploy.sh
#       -> additionally deploys to $HERMES_HOME/profiles/<name>/plugins/engram
#          for each space-separated profile name (missing profiles are skipped)
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# HERMES_ROOT is honoured for backwards compatibility with earlier rollouts.
HERMES_HOME="${HERMES_HOME:-${HERMES_ROOT:-$HOME/.hermes}}"
# __init__.py is the entry point (HTTP transport); provider.py + mcp_client.py
# are the stdio transport it can select via engram.json. cli.py and
# config_schema.py are stdio-only companions that Hermes auto-loads when
# present, so they are deliberately NOT copied alongside the HTTP default.
RUNTIME_FILES=(__init__.py provider.py mcp_client.py plugin.yaml README.md)
# Space-separated profile names; empty/unset means "default profile only".
PROFILES=(${ENGRAM_PLUGIN_PROFILES:-})

for f in "${RUNTIME_FILES[@]}"; do
  [ -f "$SRC/$f" ] || { echo "deploy: missing $SRC/$f" >&2; exit 1; }
done

targets=("$HERMES_HOME/plugins/engram")
if [ "${#PROFILES[@]}" -eq 0 ]; then
  echo "hint: deploying to the default profile only ($HERMES_HOME)."
  echo "hint: set ENGRAM_PLUGIN_PROFILES=\"name1 name2\" to also deploy to $HERMES_HOME/profiles/<name>/plugins/engram."
fi
for p in ${PROFILES[@]+"${PROFILES[@]}"}; do
  if [ -d "$HERMES_HOME/profiles/$p" ]; then
    targets+=("$HERMES_HOME/profiles/$p/plugins/engram")
  else
    echo "skip: profile '$p' not present at $HERMES_HOME/profiles/$p"
  fi
done

for dst in "${targets[@]}"; do
  case "$dst" in
    "$HERMES_HOME"/plugins/engram|"$HERMES_HOME"/profiles/*/plugins/engram) ;;
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
