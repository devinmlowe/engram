"""Contract tests for the engram Hermes memory-provider plugin.

Run from the engram repo root:

    PYTHONPATH=~/.hermes/hermes-agent python3 -m pytest interfaces/hermes-plugin/tests/ -q

HTTP is mocked by monkeypatching ``urllib.request.urlopen``; no server needed.
"""

from __future__ import annotations

import importlib.util
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

import pytest

PLUGIN_DIR = Path(__file__).resolve().parent.parent
BASE = "http://127.0.0.1:9907"
SESSION = "11111111-2222-3333-4444-555555555555"

RECALL_XML = (
    '<engram_memory query="engram HTTP MCP server" tokens_used="120" total_results="2">\n'
    '  <semantic type="fact" confidence="50%" importance="high" relevance="100%">\n'
    '    The engram MCP server listens on port 9907 over streamable HTTP.\n'
    '  </semantic>\n'
    '</engram_memory>'
)


# ---------------------------------------------------------------------------
# Module loading
# ---------------------------------------------------------------------------

@pytest.fixture(scope="session")
def plugin():
    """Import the plugin the way the Hermes user-lane loader does."""
    if "agent.memory_provider" not in sys.modules:
        pytest.importorskip("agent.memory_provider")
    spec = importlib.util.spec_from_file_location(
        "_hermes_user_memory.engram", str(PLUGIN_DIR / "__init__.py"),
        submodule_search_locations=[str(PLUGIN_DIR)],
    )
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


# ---------------------------------------------------------------------------
# Fake HTTP layer
# ---------------------------------------------------------------------------

class _Headers(dict):
    def get(self, key, default=None):  # case-insensitive like http.client
        for k, v in self.items():
            if k.lower() == key.lower():
                return v
        return default


class _Resp:
    def __init__(self, status=200, body=b"", headers=None):
        self.status = status
        self._body = body
        self.headers = _Headers(headers or {})

    def getcode(self):
        return self.status

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def _sse(obj) -> bytes:
    return ("event: message\ndata: " + json.dumps(obj) + "\n\n").encode()


class FakeServer:
    """Routes urlopen calls by path + JSON-RPC method and records them."""

    def __init__(self, *, health=None, recall_text=RECALL_XML,
                 remember_text="Remembered: x", fail=None):
        self.health = health if health is not None else {"status": "ok"}
        self.recall_text = recall_text
        self.remember_text = remember_text
        self.fail = fail or {}          # {"health"|"initialize"|"recall"|"remember": Exception|int}
        self.calls = []                 # (method, path, rpc_method, session, args)

    def __call__(self, req, timeout=None):
        path = req.full_url[len(BASE):]
        body = req.data
        rpc = json.loads(body) if body else {}
        rpc_method = rpc.get("method")
        session = req.headers.get("Mcp-session-id") or req.headers.get("mcp-session-id")
        self.calls.append((req.get_method(), path, rpc_method, session,
                           (rpc.get("params") or {}).get("arguments")))

        def _maybe_fail(key):
            f = self.fail.get(key)
            if isinstance(f, BaseException):
                raise f
            if isinstance(f, int):
                raise urllib.error.HTTPError(req.full_url, f, "boom", _Headers(), None)

        if path == "/health":
            _maybe_fail("health")
            return _Resp(200, json.dumps(self.health).encode(),
                         {"content-type": "application/json"})
        if path == "/mcp" and req.get_method() == "DELETE":
            return _Resp(200, b"")
        if rpc_method == "initialize":
            _maybe_fail("initialize")
            return _Resp(200, _sse({"jsonrpc": "2.0", "id": rpc["id"],
                                    "result": {"protocolVersion": "2025-03-26"}}),
                         {"content-type": "text/event-stream", "mcp-session-id": SESSION})
        if rpc_method == "notifications/initialized":
            return _Resp(202, b"")
        if rpc_method == "tools/call":
            assert session == SESSION, "tools/call sent without the session id"
            name = rpc["params"]["name"]
            _maybe_fail(name)
            text = self.recall_text if name == "recall" else self.remember_text
            return _Resp(200, _sse({"jsonrpc": "2.0", "id": rpc["id"],
                                    "result": {"content": [{"type": "text", "text": text}]}}),
                         {"content-type": "text/event-stream"})
        raise AssertionError(f"unexpected request {req.get_method()} {path} {rpc_method}")


@pytest.fixture
def server(monkeypatch):
    srv = FakeServer()
    monkeypatch.setattr(urllib.request, "urlopen", srv)
    return srv


@pytest.fixture
def provider(plugin, tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    p = plugin.EngramMemoryProvider()
    p.initialize("sess-1", hermes_home=str(tmp_path), platform="cli")
    return p


# ---------------------------------------------------------------------------
# Availability
# ---------------------------------------------------------------------------

def test_available_when_health_ok(provider, server):
    assert provider.is_available() is True
    assert provider.unavailable_reason() == ""
    assert server.calls[0][:2] == ("GET", "/health")


def test_unavailable_when_server_down(provider, server):
    server.fail["health"] = urllib.error.URLError("connection refused")
    assert provider.is_available() is False
    assert "unreachable" in provider.unavailable_reason()


def test_unavailable_when_status_not_ok(provider, server):
    server.health = {"status": "degraded"}
    assert provider.is_available() is False
    assert "status ok" in provider.unavailable_reason()


def test_unavailable_on_non_200(provider, server):
    server.fail["health"] = 503
    assert provider.is_available() is False


# ---------------------------------------------------------------------------
# prefetch
# ---------------------------------------------------------------------------

def test_prefetch_success_returns_recalled_text(provider, server):
    out = provider.prefetch("engram HTTP MCP server")
    assert "port 9907" in out
    # initialize handshake, then tools/call recall with the default budget
    methods = [c[2] for c in server.calls]
    assert methods[:2] == ["initialize", "notifications/initialized"]
    _, _, rpc, session, args = server.calls[-1]
    assert rpc == "tools/call" and session == SESSION
    assert args == {"query": "engram HTTP MCP server", "budget": 300}
    status = provider.recall_status()
    assert status is not None and status.count == 2


def test_prefetch_reuses_session(provider, server):
    provider.prefetch("first")
    provider.prefetch("second")
    assert [c[2] for c in server.calls].count("initialize") == 1


def test_prefetch_exception_returns_empty(provider, server):
    server.fail["recall"] = urllib.error.URLError("timed out")
    assert provider.prefetch("anything") == ""
    assert provider.recall_status() is None


def test_prefetch_http_error_returns_empty_and_resets_session(provider, server):
    provider.prefetch("warm")                       # establishes session
    server.fail["recall"] = 500
    assert provider.prefetch("boom") == ""
    del server.fail["recall"]
    provider.prefetch("again")
    assert [c[2] for c in server.calls].count("initialize") == 2


def test_prefetch_empty_when_no_results(provider, server):
    server.recall_text = '<engram_memory query="x" tokens_used="0" total_results="0">\n</engram_memory>'
    assert provider.prefetch("x") == ""
    server.recall_text = ""
    assert provider.prefetch("y") == ""


def test_prefetch_blank_query_makes_no_request(provider, server):
    assert provider.prefetch("   ") == ""
    assert server.calls == []


def test_prefetch_uses_configured_budget(plugin, server, tmp_path):
    (tmp_path / "engram.json").write_text(json.dumps({"prefetch_token_budget": 500}))
    p = plugin.EngramMemoryProvider()
    p.initialize("s", hermes_home=str(tmp_path))
    p.prefetch("q")
    assert server.calls[-1][4]["budget"] == 500


def test_circuit_breaker_opens_after_five_failures(provider, server, plugin):
    server.fail["recall"] = urllib.error.URLError("down")
    for _ in range(plugin._BREAKER_THRESHOLD):
        assert provider.prefetch("q") == ""
    n = len(server.calls)
    assert provider.prefetch("q") == ""          # breaker open: no HTTP at all
    assert len(server.calls) == n
    assert "temporarily unavailable" in json.loads(
        provider.handle_tool_call("engram_memory_save", {"content": "x"}))["error"]


# ---------------------------------------------------------------------------
# handle_tool_call
# ---------------------------------------------------------------------------

def test_tool_call_happy_path(provider, server):
    server.remember_text = "Remembered: the sky is blue"
    res = json.loads(provider.handle_tool_call(
        "engram_memory_save", {"content": "the sky is blue", "type": "fact", "importance": 0.9}))
    assert res == {"result": "Remembered: the sky is blue"}
    _, _, rpc, _, args = server.calls[-1]
    assert rpc == "tools/call"
    assert args == {"content": "the sky is blue", "source": "user", "type": "fact", "importance": 0.9}


def test_tool_call_missing_content(provider, server):
    res = json.loads(provider.handle_tool_call("engram_memory_save", {}))
    assert "content" in res["error"]
    assert server.calls == []


def test_tool_call_rejects_bad_type_and_importance(provider, server):
    assert "Invalid type" in json.loads(
        provider.handle_tool_call("engram_memory_save", {"content": "x", "type": "rumor"}))["error"]
    assert "importance" in json.loads(
        provider.handle_tool_call("engram_memory_save", {"content": "x", "importance": 7}))["error"]
    assert server.calls == []


def test_tool_call_backend_error(provider, server):
    server.fail["remember"] = urllib.error.URLError("connection refused")
    res = json.loads(provider.handle_tool_call("engram_memory_save", {"content": "x"}))
    assert res["error"].startswith("engram remember failed")


def test_tool_call_rpc_error_surfaces(provider, server, monkeypatch):
    def rpc_error(req, timeout=None):
        rpc = json.loads(req.data) if req.data else {}
        if rpc.get("method") == "tools/call":
            return _Resp(200, _sse({"jsonrpc": "2.0", "id": rpc["id"],
                                    "error": {"code": -32602, "message": "content too short"}}),
                         {"content-type": "text/event-stream"})
        return server(req, timeout=timeout)
    monkeypatch.setattr(urllib.request, "urlopen", rpc_error)
    res = json.loads(provider.handle_tool_call("engram_memory_save", {"content": "x"}))
    assert "content too short" in res["error"]


def test_tool_call_unknown_tool(provider, server):
    res = json.loads(provider.handle_tool_call("engram_search", {"query": "x"}))
    assert "Unknown tool" in res["error"]


# ---------------------------------------------------------------------------
# Schemas, prompt block, config, misc contract
# ---------------------------------------------------------------------------

def test_tool_schema_shape(provider):
    schemas = provider.get_tool_schemas()
    assert len(schemas) == 1
    s = schemas[0]
    assert s["name"] == "engram_memory_save"
    assert s["parameters"]["required"] == ["content"]
    props = s["parameters"]["properties"]
    assert props["content"]["type"] == "string"
    assert set(props["type"]["enum"]) == {"fact", "preference", "decision", "pattern", "solution", "convention"}
    assert props["importance"]["minimum"] == 0 and props["importance"]["maximum"] == 1


def test_system_prompt_block_is_byte_stable(provider, server):
    a = provider.system_prompt_block().encode()
    provider.prefetch("mutate some state")
    provider.handle_tool_call("engram_memory_save", {"content": "x"})
    b = provider.system_prompt_block().encode()
    assert a == b and a
    assert not any(ch.isdigit() for ch in a.decode())


def test_config_defaults_and_schema(plugin, provider):
    cfg = plugin._load_config()
    assert cfg == {"base_url": "http://127.0.0.1:9907", "timeout_secs": 2.0, "prefetch_token_budget": 300}
    keys = [f["key"] for f in provider.get_config_schema()]
    assert keys == ["base_url", "timeout_secs", "prefetch_token_budget"]
    assert not any(f.get("secret") for f in provider.get_config_schema())


def test_save_config_round_trip(plugin, provider, tmp_path):
    provider.save_config({"base_url": "http://localhost:9999/", "timeout_secs": "3"}, str(tmp_path))
    data = json.loads((tmp_path / "engram.json").read_text())
    assert data["base_url"] == "http://localhost:9999/"
    cfg = plugin._load_config(str(tmp_path))
    assert cfg["base_url"] == "http://localhost:9999"   # trailing slash stripped
    assert cfg["timeout_secs"] == 3.0
    assert cfg["prefetch_token_budget"] == 300


def test_config_clamps_budget_to_server_bounds(plugin, tmp_path):
    (tmp_path / "engram.json").write_text(json.dumps({"prefetch_token_budget": 10}))
    assert plugin._load_config(str(tmp_path))["prefetch_token_budget"] == 100


def test_backup_paths_expanded(provider):
    (path,) = provider.backup_paths()
    assert path.endswith("/.local/share/engram/engram.db") and "~" not in path


def test_noop_hooks(provider, server):
    assert provider.sync_turn("u", "a") is None
    assert provider.on_session_end([]) is None
    assert provider.on_memory_write("add", "memory", "x") is None
    assert provider.on_pre_compress([]) == ""
    assert server.calls == []


def test_register_collects_provider(plugin):
    class Ctx:
        provider = None

        def register_memory_provider(self, p):
            self.provider = p
    ctx = Ctx()
    plugin.register(ctx)
    assert isinstance(ctx.provider, plugin.EngramMemoryProvider)
    assert ctx.provider.name == "engram"
