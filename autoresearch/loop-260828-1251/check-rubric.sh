#!/usr/bin/env bash
# Rubric checker for decisions/hermes-memory-provider-integration.md
# Outputs a single integer: number of rubric checks passed (max 28).
set -u
F="$(git rev-parse --show-toplevel)/decisions/hermes-memory-provider-integration.md"
score=0
pass() { score=$((score+1)); }
[ -f "$F" ] || { echo 0; exit 0; }

c() { grep -qiE "$1" "$F" && pass; }

# --- Existence / substance ---
words=$(wc -w < "$F")
[ "$words" -ge 1500 ] && pass                                                  # 1 substantive length
grep -qiE '^#{1,2} +(Decision|Recommendation)' "$F" && grep -qiE '(integrate|do not integrate|conditional|go|no-go)' "$F" && pass  # 2 explicit decision

# --- Architecture ---
c 'subprocess|shell.?out|CLI (shim|wrapper|invocation)'                        # 3 CLI transport option
c 'MCP.*(stdio|client)|stdio.*MCP'                                             # 4 MCP stdio option
c '(HTTP|REST).*(shim|sidecar|service|daemon)|long.?running (node|process)'    # 5 shim/daemon option
grep -qiE '^#{1,3} +(Chosen|Selected|Recommended) (architecture|approach|option)|architecture.*(chosen|selected|recommended)' "$F" && pass  # 6 a choice is made

# --- MemoryProvider contract mapping ---
c 'is_available'                                                               # 7
c 'initialize\('                                                               # 8
c 'get_tool_schemas'                                                           # 9
c 'prefetch'                                                                   # 10
c 'sync_turn'                                                                  # 11
c 'handle_tool_call'                                                           # 12
c 'backup_paths'                                                               # 13
c 'on_session_end|on_pre_compress'                                             # 14 dream/consolidation hooks

# --- Known hard problems (from exploration reports) ---
c 'hermes_home'                                                                # 15 profile scoping kwarg
c 'ENGRAM_DB_PATH|DB.?per.?profile|per.?profile (DB|database)'                 # 16 tenancy solution
c '8.?(second|s).*(timeout|budget)|_EXTERNAL_PREFETCH_TIMEOUT'                 # 17 prefetch timeout
c '(node|process|startup).*(latency|cold.?start|spawn cost)|cold.?start'       # 18 node startup latency
c 'non.?blocking|daemon thread|background (write|thread)'                      # 19 sync threading
c '0\.95|dedup'                                                                # 20 dedup discard mismatch
c 'WAL|single.?writer|writer lock'                                             # 21 sqlite contention
c 'no auth|unauthenticated|0\.0\.0\.0|CORS'                                    # 22 exposure risk
c 'engram_[a-z]+|tool.?name.*(prefix|namespac)|namespac.*tool'                 # 23 tool namespacing
c 'one external provider|mutual.?exclus|single.?provider'                      # 24 exclusivity rule
c 'hermes memory off|rollback|reversib'                                       # 25 rollback path

# --- Decision quality ---
grep -qiE '^#{1,3} +Risks?' "$F" && [ "$(grep -cE '^\|' "$F")" -ge 5 ] && pass # 26 risk table
c 'holographic|mem0'                                                           # 27 compared to bundled providers
[ "$(grep -oE '[A-Za-z0-9_./-]+\.(py|ts|md|yaml):[0-9]+' "$F" | sort -u | wc -l)" -ge 15 ] && pass  # 28 >=15 file:line citations

echo "$score"
