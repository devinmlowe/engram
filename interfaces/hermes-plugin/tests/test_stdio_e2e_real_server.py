"""End-to-end: EngramMemoryProvider against the REAL built engram MCP server.

Uses a temp SQLite DB (ENGRAM_DB_PATH) and forces the child inline
(ENGRAM_MCP_STANDALONE=1) so it never bridges to a running daemon (#138) —
the live graph is never touched.
Requires dist/interfaces/mcp/server.js (npm run build) and the local
embedding model cache; skips cleanly when the build is absent.
"""

import json
import os
import sys

import pytest

PLUGIN_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
REPO_ROOT = os.path.abspath(os.path.join(PLUGIN_DIR, "..", ".."))
SERVER_JS = os.path.join(REPO_ROOT, "dist", "interfaces", "mcp", "server.js")

sys.path.insert(0, PLUGIN_DIR)

from provider import EngramMemoryProvider  # noqa: E402

pytestmark = pytest.mark.skipif(
    not os.path.isfile(SERVER_JS), reason="engram dist not built (npm run build)"
)

CALL_TIMEOUT = 120.0  # first call loads the embedding model


def make_provider(tmp_path, profile):
    hermes_home = tmp_path / f"home-{profile}"
    hermes_home.mkdir(exist_ok=True)
    (hermes_home / "engram.json").write_text(
        json.dumps({
            "repo_path": REPO_ROOT,
            "db_path": str(tmp_path / "e2e-engram.db"),
            "budget": 800,
            "extra_env": {"ENGRAM_MCP_STANDALONE": "1"},
        })
    )
    p = EngramMemoryProvider()
    p.initialize(
        f"sess-{profile}", hermes_home=str(hermes_home), platform="cli",
        agent_context="primary", agent_identity=profile,
    )
    return p


def test_full_write_read_scope_cycle(tmp_path):
    alpha = make_provider(tmp_path, "alpha")
    beta = make_provider(tmp_path, "beta")
    try:
        # alpha writes a scoped memory through the real server
        raw = alpha.handle_tool_call(
            "engram_remember",
            {"content": "Interview with Acme Corp scheduled for next Tuesday", "type": "fact"},
        )
        # first call may exceed the default timeout while the model loads —
        # retry once with a long timeout via the underlying client
        parsed = json.loads(raw)
        if not parsed["ok"]:
            client = alpha._ensure_client()
            result = client.call_tool(
                "remember",
                {"content": "Interview with Acme Corp scheduled for next Tuesday", "type": "fact"},
                timeout=CALL_TIMEOUT,
            )
            parsed = {"ok": True, "result": result}
        assert parsed["ok"], parsed
        assert "emember" in parsed["result"] or "Merged" in parsed["result"]

        # alpha recalls it (global + hermes:alpha scopes).
        # NB: the <engram_memory> envelope echoes the query attribute, so
        # assertions must target memory CONTENT, never the query terms.
        alpha_recall = alpha._ensure_client().call_tool(
            "recall", {"query": "Acme interview", "sources": ["semantic"]},
            timeout=CALL_TIMEOUT,
        )
        assert "Acme Corp scheduled" in alpha_recall
        assert 'total_results="0"' not in alpha_recall

        # beta must NOT see alpha's scoped memory
        beta_recall = beta._ensure_client().call_tool(
            "recall", {"query": "Acme interview", "sources": ["semantic"]},
            timeout=CALL_TIMEOUT,
        )
        assert "Acme Corp scheduled" not in beta_recall
        assert 'total_results="0"' in beta_recall
    finally:
        alpha.shutdown()
        beta.shutdown()
