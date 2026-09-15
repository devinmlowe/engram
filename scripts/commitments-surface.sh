#!/usr/bin/env bash
# commitments-surface.sh — compact digest of engram's commitments ledger for the
# Hermes heartbeats (12:00 / 20:00 CT). Queries the `commitments` MCP tool over
# the local HTTP MCP endpoint (LaunchAgent ai.hermes.engram-mcp, :9907) and prints:
#
#   Commitments: N pending (O overdue, D due within 7 days)
#   OVERDUE: / DUE THIS WEEK: sections (id prefix, content, due, subject)
#
# Prints NOTHING when there are no pending commitments (empty state), so it can
# be injected into a heartbeat prompt unconditionally. Exit 0 on success; exit 1
# with a one-line stderr message when the endpoint is unreachable.
#
# Dogfood: consumed manually by Atlas this week; wiring into the heartbeat prompt
# is a follow-up — this script does not touch the cron jobs.
#
# Env: ENGRAM_MCP_URL (default http://127.0.0.1:9907/mcp), COMMITMENTS_DUE_DAYS (7),
#      COMMITMENTS_LIMIT (200)

set -u
MCP_URL="${ENGRAM_MCP_URL:-http://127.0.0.1:9907/mcp}"
DUE_DAYS="${COMMITMENTS_DUE_DAYS:-7}"
LIMIT="${COMMITMENTS_LIMIT:-200}"

python3 - "$MCP_URL" "$DUE_DAYS" "$LIMIT" <<'PY'
import json, sys, urllib.request, xml.etree.ElementTree as ET
from datetime import date, datetime, timezone

url, due_days, limit = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
H = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream"}

def post(body, sid=None):
    h = dict(H)
    if sid: h["Mcp-Session-Id"] = sid
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers=h, method="POST")
    with urllib.request.urlopen(req, timeout=20) as r:
        raw = r.read().decode(); ct = r.headers.get("content-type", ""); sid = r.headers.get("mcp-session-id") or sid
    msgs = []
    if "text/event-stream" in ct:
        for line in raw.splitlines():
            if line.startswith("data:"):
                try: msgs.append(json.loads(line[5:].strip()))
                except Exception: pass
    elif raw.strip():
        msgs.append(json.loads(raw))
    return msgs, sid

try:
    _, sid = post({"jsonrpc": "2.0", "id": 1, "method": "initialize",
                   "params": {"protocolVersion": "2025-03-26", "capabilities": {},
                              "clientInfo": {"name": "commitments-surface", "version": "1"}}})
    post({"jsonrpc": "2.0", "method": "notifications/initialized"}, sid)
    msgs, _ = post({"jsonrpc": "2.0", "id": 2, "method": "tools/call",
                    "params": {"name": "commitments",
                               "arguments": {"status": "pending", "limit": limit, "budget": 10000}}}, sid)
except Exception as e:
    print(f"commitments-surface: engram MCP unreachable at {url}: {e}", file=sys.stderr); sys.exit(1)

result = next((m.get("result") for m in msgs if m.get("id") == 2), None)
if not result or result.get("isError"):
    print(f"commitments-surface: tool error: {json.dumps(result)[:200]}", file=sys.stderr); sys.exit(1)

text = result["content"][0]["text"]
try:
    root = ET.fromstring(text)
except ET.ParseError as e:
    print(f"commitments-surface: bad XML from commitments tool: {e}", file=sys.stderr); sys.exit(1)

items = root.findall("commitment")
total = int(root.get("total") or len(items))
if total == 0:
    sys.exit(0)  # empty state: print nothing

today = datetime.now(timezone.utc).date()
def due_of(el):
    d = el.get("due")
    return date.fromisoformat(d) if d else None

overdue = [i for i in items if i.get("overdue") == "true"]
soon = [i for i in items if due_of(i) and i.get("overdue") != "true" and (due_of(i) - today).days <= due_days]

def line(i):
    who = i.get("subject", "devin")
    tag = "" if who == "devin" else f" [owed by {who}]"
    due = f" (due {i.get('due')})" if i.get("due") else ""
    return f"  - {i.get('id','')[:8]}  {(i.text or '').strip()}{due}{tag}"

print(f"Commitments: {total} pending ({len(overdue)} overdue, {len(soon)} due within {due_days} days)")
if overdue:
    print("OVERDUE:")
    for i in overdue: print(line(i))
if soon:
    print(f"DUE WITHIN {due_days} DAYS:")
    for i in sorted(soon, key=lambda i: i.get("due")): print(line(i))
if not overdue and not soon:
    print("No dated items due soon; newest pending:")
    for i in items[:5]: print(line(i))
print("  (resolve with the commitments_update tool or `engram commitment-done <id>`)")
PY
