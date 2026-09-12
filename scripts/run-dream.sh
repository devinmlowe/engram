#!/usr/bin/env bash
# Run a full dream cycle interactively, logging to ~/.local/share/engram/logs.
set -euo pipefail
cd "$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="${ENGRAM_LOGS_DIR:-$HOME/.local/share/engram/logs}"
mkdir -p "$LOG_DIR"
LOGFILE="$LOG_DIR/dream-full-batch-$(date +%Y%m%d-%H%M%S).log"
echo "Dream cycle starting — log: $LOGFILE"
npx tsx src/interfaces/cli/index.ts dream 2>&1 | tee "$LOGFILE"
echo ""
echo "Dream cycle finished. Press any key to close."
read -n1
