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
# Implemented as a self-contained node program (Node 22+: global fetch), so the
# only external tool is node — the same requirement as engram itself. The file
# stays a single deployable script; the deployed copy lives at
# ~/.hermes/scripts/fleet/commitments-surface.sh.
#
# Env: ENGRAM_MCP_URL (default http://127.0.0.1:9907/mcp), COMMITMENTS_DUE_DAYS (7),
#      COMMITMENTS_LIMIT (200), NODE_BIN (override the node binary)

set -u
MCP_URL="${ENGRAM_MCP_URL:-http://127.0.0.1:9907/mcp}"
DUE_DAYS="${COMMITMENTS_DUE_DAYS:-7}"
LIMIT="${COMMITMENTS_LIMIT:-200}"

NODE_BIN="${NODE_BIN:-$(command -v node 2>/dev/null || true)}"
if [ -z "$NODE_BIN" ]; then
    echo "commitments-surface: node not found — install Node.js 22+ (https://nodejs.org) or set NODE_BIN" >&2
    exit 1
fi

"$NODE_BIN" - "$MCP_URL" "$DUE_DAYS" "$LIMIT" <<'JS'
"use strict";
const [url, dueDaysArg, limitArg] = process.argv.slice(-3);
const dueDays = Number(dueDaysArg);
const limit = Number(limitArg);
const BASE_HEADERS = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };

function fail(message) {
  process.stderr.write(`commitments-surface: ${message}\n`);
  process.exit(1);
}

// One JSON-RPC POST; returns the parsed messages (SSE frames or a JSON body) and the session id.
async function post(body, sid) {
  const headers = { ...BASE_HEADERS };
  if (sid) headers["Mcp-Session-Id"] = sid;
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const raw = await res.text();
  const contentType = res.headers.get("content-type") || "";
  const nextSid = res.headers.get("mcp-session-id") || sid;
  const msgs = [];
  if (contentType.includes("text/event-stream")) {
    for (const line of raw.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      try { msgs.push(JSON.parse(line.slice(5).trim())); } catch { /* keep-alive or partial frame */ }
    }
  } else if (raw.trim()) {
    msgs.push(JSON.parse(raw));
  }
  return [msgs, nextSid];
}

// The tool answers in engram's XML dialect (see src/semantic/commitments.ts); attributes and
// text are escaped with exactly &amp; &lt; &gt; &quot;, so a small regex reader is sufficient.
const unescapeXml = (s) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
const attrsOf = (s) =>
  Object.fromEntries([...s.matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [m[1], unescapeXml(m[2])]));

const utcDay = (d) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
const dayOf = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || "");
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
};

async function main() {
  let msgs;
  try {
    let sid;
    [, sid] = await post({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "commitments-surface", version: "1" } },
    });
    await post({ jsonrpc: "2.0", method: "notifications/initialized" }, sid);
    [msgs] = await post({
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "commitments", arguments: { status: "pending", limit, budget: 10000 } },
    }, sid);
  } catch (e) {
    fail(`engram MCP unreachable at ${url}: ${e && e.message ? e.message : e}`);
  }

  const result = msgs.find((m) => m && m.id === 2)?.result;
  if (!result || result.isError) fail(`tool error: ${JSON.stringify(result ?? null).slice(0, 200)}`);

  const text = result.content?.[0]?.text ?? "";
  const rootMatch = /<engram_commitments\b([^>]*)>/.exec(text);
  if (!rootMatch) fail("bad XML from commitments tool: missing <engram_commitments> root");
  const root = attrsOf(rootMatch[1]);
  const items = [...text.matchAll(/<commitment\b([^>]*)>([\s\S]*?)<\/commitment>/g)].map((m) => ({
    ...attrsOf(m[1]),
    text: unescapeXml(m[2]).trim(),
  }));

  const total = Number(root.total ?? items.length);
  if (total === 0) return; // empty state: print nothing

  const today = utcDay(new Date());
  const daysUntil = (i) => {
    const due = dayOf(i.due);
    return due === null ? null : Math.round((due - today) / 86400000);
  };
  const overdue = items.filter((i) => i.overdue === "true");
  const soon = items.filter((i) => {
    const d = daysUntil(i);
    return d !== null && i.overdue !== "true" && d <= dueDays;
  });

  const line = (i) => {
    const who = i.subject ?? "devin";
    const tag = who === "devin" ? "" : ` [owed by ${who}]`;
    const due = i.due ? ` (due ${i.due})` : "";
    return `  - ${(i.id ?? "").slice(0, 8)}  ${i.text}${due}${tag}`;
  };

  const out = [];
  out.push(`Commitments: ${total} pending (${overdue.length} overdue, ${soon.length} due within ${dueDays} days)`);
  if (overdue.length) {
    out.push("OVERDUE:");
    for (const i of overdue) out.push(line(i));
  }
  if (soon.length) {
    out.push(`DUE WITHIN ${dueDays} DAYS:`);
    for (const i of [...soon].sort((a, b) => (a.due ?? "").localeCompare(b.due ?? ""))) out.push(line(i));
  }
  if (!overdue.length && !soon.length) {
    out.push("No dated items due soon; newest pending:");
    for (const i of items.slice(0, 5)) out.push(line(i));
  }
  out.push("  (resolve with the commitments_update tool or `engram commitment-done <id>`)");
  process.stdout.write(out.join("\n") + "\n");
}

main().catch((e) => fail(String(e && e.stack ? e.stack : e)));
JS
