#!/usr/bin/env bash
# Pings a Claude session in ngrm-2:0.0 every 15 minutes to monitor ngrm-2:0.1
# Self-healing: if Claude isn't running in the target pane, starts a fresh session

MY_PANE="ngrm-2:0.0"
AGENT_PANE="ngrm-2:0.1"
INTERVAL=900  # 15 minutes
LOG="/tmp/ngrm2-ping.log"
CONTEXT="/Users/USER/Documents/git/engram/.claude/monitor-context.md"
MASTER_PLAN="/Users/USER/Documents/git/engram-src-extraction/plans/MASTER-PLAN.md"

PING_MSG="Check in on ngrm-2:0.1 — capture the pane, assess whether the agent is active/stuck/complete, and intervene via tmux send-keys with a targeted message if needed. Reference /Users/USER/Documents/git/engram-src-extraction/plans/MASTER-PLAN.md for phase completion. Enforce orchestrator-only role (no direct code work, all implementation delegated to sub-agents in team-mode, all work in worktrees). If all 4 phases are complete, report and stop."

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"
}

is_claude_running() {
  # Check if Claude Code is running in the target pane
  local pane_pid
  pane_pid=$(tmux display-message -t "$MY_PANE" -p "#{pane_pid}" 2>/dev/null)
  [[ -n "$pane_pid" ]] && pgrep -P "$pane_pid" -f "claude" >/dev/null 2>&1
}

is_master_plan_complete() {
  [[ -f "$MASTER_PLAN" ]] || return 1
  local incomplete
  incomplete=$(grep -cE "^\*\*Status:\*\* (Not started|In progress)" "$MASTER_PLAN" 2>/dev/null)
  [[ "$incomplete" -eq 0 ]]
}

start_fresh_claude() {
  log "Starting fresh Claude session in $MY_PANE with monitoring context..."
  tmux send-keys -t "$MY_PANE" "cd /Users/USER/Documents/git/engram && claude" Enter
  sleep 10  # give Claude time to start
  tmux send-keys -t "$MY_PANE" "Read /Users/USER/Documents/git/engram/.claude/monitor-context.md then begin monitoring ngrm-2:0.1. ${PING_MSG}" Enter
  log "Fresh Claude session started and given monitoring context"
}

log "Ping monitor started. Target: $MY_PANE. Agent: $AGENT_PANE. Interval: ${INTERVAL}s"

while true; do
  sleep "$INTERVAL"

  log "--- Check cycle ---"

  # Check if master plan complete
  if is_master_plan_complete; then
    log "MASTER PLAN COMPLETE — all phases done. Exiting."
    exit 0
  fi

  # Check if Claude is alive in our pane
  if is_claude_running; then
    log "Claude is running — sending ping"
    tmux send-keys -t "$MY_PANE" "$PING_MSG" Enter
  else
    log "Claude NOT running in $MY_PANE — starting fresh session"
    start_fresh_claude
  fi

  log "Cycle complete"
done
