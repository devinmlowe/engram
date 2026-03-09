#!/usr/bin/env bash
# check-deps.sh — Verify no circular or disallowed cross-domain imports in engram.
#
# Exit codes:
#   0  All checks pass
#   1  Dependency violations found
#
# Known acceptable exceptions (excluded from violation count):
#   - _core/search/orchestrator.ts imports from episodic/, semantic/, graph/
#     (search coordination — TODO for Phase 2+ callback/registry pattern)
#   - dream/daemon.ts imports from semantic/ and episodic/ (pipeline orchestrator)
#   - graph/extractor.ts type-imports from semantic/ (type-only, erased at runtime)
#   - mcp/ and cli/ are interface layers — may import any domain
#   - web/ is an interface layer — may import any domain

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="$SCRIPT_DIR/../src"
VIOLATIONS=0

red()   { printf '\033[0;31m%s\033[0m\n' "$1"; }
green() { printf '\033[0;32m%s\033[0m\n' "$1"; }
yellow(){ printf '\033[0;33m%s\033[0m\n' "$1"; }

# ── Check 1: _core/ should not import from domain directories ────────────────

echo "=== Check 1: _core/ imports from domain directories ==="

DOMAIN_PATTERN='from ['\''"]\.{0,2}/(episodic|semantic|graph|dream|cli|mcp|web|migration|interfaces)/'
CORE_VIOLATIONS=$(grep -rn --include='*.ts' -E "$DOMAIN_PATTERN" "$SRC_DIR/_core/" 2>/dev/null || true)

# Also catch relative imports that go up from _core into domain dirs
RELATIVE_PATTERN='from ['\''"]\.\./(episodic|semantic|graph|dream|cli|mcp|web|migration|interfaces)/'
CORE_RELATIVE=$(grep -rn --include='*.ts' -E "$RELATIVE_PATTERN" "$SRC_DIR/_core/" 2>/dev/null || true)

CORE_ALL=$(printf '%s\n%s' "$CORE_VIOLATIONS" "$CORE_RELATIVE" | sort -u | grep -v '^$' || true)

if [ -n "$CORE_ALL" ]; then
  # Filter known exception: orchestrator.ts importing search functions
  CORE_UNEXPECTED=$(echo "$CORE_ALL" | grep -v '_core/search/orchestrator\.ts' || true)

  if [ -n "$CORE_UNEXPECTED" ]; then
    red "VIOLATION: _core/ has unexpected domain imports:"
    echo "$CORE_UNEXPECTED"
    VIOLATIONS=$((VIOLATIONS + $(echo "$CORE_UNEXPECTED" | wc -l | tr -d ' ')))
  fi

  CORE_EXPECTED=$(echo "$CORE_ALL" | grep '_core/search/orchestrator\.ts' || true)
  if [ -n "$CORE_EXPECTED" ]; then
    yellow "KNOWN EXCEPTION (orchestrator cross-domain imports):"
    echo "$CORE_EXPECTED"
  fi
else
  green "PASS: _core/ has no domain imports"
fi

echo ""

# ── Check 2: Cross-domain imports between domain modules ─────────────────────

echo "=== Check 2: Cross-domain imports ==="

check_domain() {
  local domain="$1"
  shift
  local forbidden=("$@")

  local pattern
  pattern=$(IFS='|'; echo "${forbidden[*]}")
  local import_pattern="from ['\"]\.\./(${pattern})/"

  local hits
  hits=$(grep -rn --include='*.ts' -E "$import_pattern" "$SRC_DIR/$domain/" 2>/dev/null || true)

  if [ -n "$hits" ]; then
    # Filter known exceptions
    local unexpected
    unexpected=$(echo "$hits" \
      | grep -v 'dream/daemon\.ts' \
      | grep -v 'dream/scheduler\.ts' \
      | grep -v 'graph/extractor\.ts.*import type.*from.*semantic' \
      || true)

    if [ -n "$unexpected" ]; then
      red "VIOLATION: $domain/ has unexpected cross-domain imports:"
      echo "$unexpected"
      VIOLATIONS=$((VIOLATIONS + $(echo "$unexpected" | wc -l | tr -d ' ')))
    fi

    local expected
    expected=$(echo "$hits" \
      | grep -E '(dream/daemon\.ts|dream/scheduler\.ts|graph/extractor\.ts.*import type.*from.*semantic)' \
      || true)

    if [ -n "$expected" ]; then
      yellow "KNOWN EXCEPTION ($domain/):"
      echo "$expected"
    fi
  else
    green "PASS: $domain/ has no cross-domain imports"
  fi
}

check_domain "episodic"  "semantic" "graph" "dream"
check_domain "semantic"  "episodic" "graph" "dream"
check_domain "graph"     "episodic" "semantic" "dream"
check_domain "dream"     "episodic" "semantic" "graph"

echo ""

# ── Check 3: Old circular dependency chain broken ────────────────────────────

echo "=== Check 3: Old circular dependency chain (episodic → semantic → episodic) ==="

# Check if semantic/search imports from episodic
SEM_TO_EPI=$(grep -rn --include='*.ts' -E "from ['\"].*episodic" "$SRC_DIR/semantic/" 2>/dev/null || true)
# Check if episodic imports embeddings from semantic (old pattern)
EPI_TO_SEM_EMB=$(grep -rn --include='*.ts' -E "from ['\"].*semantic.*(embed|Embed)" "$SRC_DIR/episodic/" 2>/dev/null || true)

if [ -z "$SEM_TO_EPI" ] && [ -z "$EPI_TO_SEM_EMB" ]; then
  green "PASS: Old circular dependency chain is broken"
  echo "  - semantic/ does not import from episodic/"
  echo "  - episodic/ does not import embeddings from semantic/"
  echo "  - Both use _core/embeddings/ instead"
else
  red "VIOLATION: Circular dependency remnants found:"
  [ -n "$SEM_TO_EPI" ] && echo "  semantic → episodic: $SEM_TO_EPI"
  [ -n "$EPI_TO_SEM_EMB" ] && echo "  episodic → semantic embeddings: $EPI_TO_SEM_EMB"
  VIOLATIONS=$((VIOLATIONS + 1))
fi

echo ""

# ── Summary ──────────────────────────────────────────────────────────────────

echo "=== Summary ==="
if [ "$VIOLATIONS" -gt 0 ]; then
  red "FAILED: $VIOLATIONS violation(s) found"
  exit 1
else
  green "ALL CHECKS PASSED"
  exit 0
fi
