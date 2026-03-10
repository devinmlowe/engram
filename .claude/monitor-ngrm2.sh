#!/usr/bin/env bash
# Monitor ngrm-2:0.1 every 15 minutes for agent stall/pause
# Sends nudge if agent is waiting for input or in plan mode
# Exits when MASTER-PLAN shows all phases complete

TARGET="ngrm-2:0.1"
MASTER_PLAN="/Users/USER/Documents/git/engram-src-extraction/plans/MASTER-PLAN.md"
INTERVAL=900  # 15 minutes
LOG="/tmp/ngrm2-monitor.log"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"
}

nudge() {
  local msg="$1"
  log "NUDGE: $msg"
  # Clear any partial input, then type the message
  tmux send-keys -t "$TARGET" "" 2>/dev/null  # Ctrl-C to clear any pending
  sleep 0.5
  tmux send-keys -t "$TARGET" "$msg" Enter
}

all_phases_complete() {
  if [[ ! -f "$MASTER_PLAN" ]]; then
    return 1
  fi
  # Check if all 4 phases show "complete" or "✓" status
  local incomplete
  incomplete=$(grep -E "^\*\*Status:\*\* (Not started|In progress)" "$MASTER_PLAN" 2>/dev/null | wc -l)
  [[ "$incomplete" -eq 0 ]]
}

is_agent_idle() {
  local content="$1"
  # Agent is idle if: no spinner, has the input prompt, no active tool use
  echo "$content" | grep -qE "^❯\s*$" && \
  ! echo "$content" | grep -qE "✢|⏺|↓.*tokens.*·" && \
  ! echo "$content" | grep -qE "Bash\(|Read\(|Write\(|Agent\("
}

is_in_plan_mode() {
  local content="$1"
  echo "$content" | grep -qiE "plan mode|EnterPlanMode|entering plan|plan approved|approve this plan"
}

is_asking_for_input() {
  local content="$1"
  echo "$content" | grep -qiE "Do you want|Would you like|Should I|please confirm|proceed\?|y/n|yes/no"
}

is_error_stalled() {
  local content="$1"
  echo "$content" | grep -qiE "Error:|ENOENT|Cannot find|Module not found|permission denied" && \
  ! echo "$content" | grep -qE "✢|⏺"
}

NUDGE_MSG='Use your best judgment based on the specification files in /Users/USER/Documents/git/engram-src-extraction/ (SPEC.md, plans/MASTER-PLAN.md, plans/phase-*-plan.md, decisions/). Your role is ORCHESTRATOR ONLY — delegate ALL implementation work to sub-agents using the Agent tool in team-mode. Do NOT write, move, or edit files yourself. Create worktrees for each phase branch. Work through all 4 phases in MASTER-PLAN.md sequentially (Phases 2+3 can run in parallel after Phase 1 merges). Continue working.'

log "Monitor started. Target: $TARGET. Check interval: ${INTERVAL}s"
log "Master plan: $MASTER_PLAN"

while true; do
  sleep "$INTERVAL"

  log "--- Checking $TARGET ---"

  # Check if master plan is complete first
  if all_phases_complete; then
    log "ALL PHASES COMPLETE — master plan finished. Exiting monitor."
    exit 0
  fi

  # Capture pane content
  PANE_CONTENT=$(tmux capture-pane -t "$TARGET" -p -S -80 2>&1)
  if [[ $? -ne 0 ]]; then
    log "ERROR: Could not capture pane $TARGET (session may have ended)"
    continue
  fi

  log "Pane tail: $(echo "$PANE_CONTENT" | tail -5 | tr '\n' '|')"

  if is_in_plan_mode "$PANE_CONTENT"; then
    log "DETECTED: Agent in plan mode — nudging to continue"
    nudge "$NUDGE_MSG"

  elif is_asking_for_input "$PANE_CONTENT"; then
    log "DETECTED: Agent asking for input — nudging with best-judgment directive"
    nudge "$NUDGE_MSG"

  elif is_error_stalled "$PANE_CONTENT"; then
    log "DETECTED: Agent may be stalled on error — nudging"
    nudge "You appear to be stalled on an error. Use your best judgment: fix the issue if it's straightforward, or skip this sub-task and continue with the remaining tasks in the current phase. Refer to the plan files in /Users/USER/Documents/git/engram-src-extraction/plans/ for context. Delegate fixes to sub-agents. Do not implement directly."

  elif is_agent_idle "$PANE_CONTENT"; then
    log "DETECTED: Agent appears idle — nudging to continue"
    nudge "$NUDGE_MSG"

  else
    log "Agent appears active — no action needed"
  fi

done
