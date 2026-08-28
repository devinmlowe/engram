#!/usr/bin/env bash
# Usage: iter.sh <iteration> <error_type> <error_fixed> <description>
# Runs metric (unchecked worklist items) + guard, appends TSV row. Exits 1 if guard fails.
set -u
cd "$(dirname "$0")/../.." || exit 2
DIR=autoresearch/fix-260828-1545
it=$1; etype=$2; fixed=$3; desc=$4
metric=$(grep -c '^- \[ \]' "$DIR/worklist.md")
prev=$(awk -F'\t' '!/^#/ && $1 ~ /^[0-9]+$/ {m=$6} END{print m}' "$DIR/results.tsv")
delta=$((metric - prev))
commit=$(git rev-parse --short HEAD)
guard=pass; status=keep
log=$(mktemp)
if ! { npx vitest run >"$log" 2>&1 && npm run lint >>"$log" 2>&1 && (cd integrations/hermes-plugin && pytest -q >>"$log" 2>&1); }; then
  guard=fail; status=crash
  echo "GUARD FAILED — tail:"; grep -E "FAIL|✗|×|Error|error TS|failed" "$log" | head -30
fi
[ "$status" = keep ] && [ "$delta" -ge 0 ] && status=discard
printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$it" "$(date -Iseconds)" "$etype" "$fixed" "$commit" "$metric" "$delta" "$guard" "$status" "$desc" >> "$DIR/results.tsv"
echo "iter=$it metric=$metric delta=$delta guard=$guard status=$status"
rm -f "$log"
[ "$guard" = pass ]
