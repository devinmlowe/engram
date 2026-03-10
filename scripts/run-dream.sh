#!/usr/bin/env bash
cd ~/Documents/git/engram
export OPENROUTER_API_KEY="$OPENROUTER_API_KEY"
LOGFILE=~/.local/share/engram/logs/dream-full-batch-$(date +%Y%m%d-%H%M%S).log
echo "Dream cycle starting — log: $LOGFILE"
npx tsx src/cli/index.ts dream 2>&1 | tee "$LOGFILE"
echo ""
echo "Dream cycle finished. Press any key to close."
read -n1
