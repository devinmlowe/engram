"""Contract tests for the engram Hermes memory-provider plugin.

Run from the engram repo root:

    PYTHONPATH=~/.hermes/hermes-agent python3 -m pytest interfaces/hermes-plugin/tests/ -q

HTTP is mocked by monkeypatching ``urllib.request.urlopen``; no server needed.
"""

from __future__ import annotations

import importlib.util
import json
import logging
import sys
import threading
import time
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
        self.forget_text = '<forgotten id="x" />'
        self.ingest_text = json.dumps({"conversationId": "c1", "created": True})
        self.fail = fail or {}          # {"health"|"initialize"|"recall"|"remember"|"ingest_turn": Exception|int|str}
                                        # str = the server answers with an isError result carrying that text
        self.calls = []                 # (method, path, rpc_method, session, args)
        self.threads = []               # thread name per recorded call
        self.gate = None                # threading.Event: ingest_turn blocks until set
        self.auth_headers = []          # Authorization header per recorded call (None when absent)
        self.required_token = None      # when set, /mcp without the matching bearer answers 401 (#27)
        self.ingest_started = threading.Event()

    def ingest_calls(self):
        return [c[4] for c in self.calls if c[2] == "tools/call" and c[4] and "turn_index" in c[4]]

    def remember_calls(self):
        return [c[4] for c in self.calls if c[2] == "tools/call" and c[4] and "content" in c[4]]

    def __call__(self, req, timeout=None):
        path = req.full_url[len(BASE):]
        body = req.data
        rpc = json.loads(body) if body else {}
        rpc_method = rpc.get("method")
        session = req.headers.get("Mcp-session-id") or req.headers.get("mcp-session-id")
        self.calls.append((req.get_method(), path, rpc_method, session,
                           (rpc.get("params") or {}).get("arguments")))
        self.threads.append(threading.current_thread().name)
        self.auth_headers.append(req.headers.get("Authorization"))
        if self.required_token and path == "/mcp" and req.headers.get("Authorization") != f"Bearer {self.required_token}":
            raise urllib.error.HTTPError(req.full_url, 401, "unauthorized", _Headers(), None)

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
            if name in ("ingest_turn", "remember"):
                self.ingest_started.set()
                if self.gate is not None:
                    assert self.gate.wait(timeout=5), "ingest gate never released"
            if isinstance(self.fail.get(name), str):
                return _Resp(200, _sse({"jsonrpc": "2.0", "id": rpc["id"],
                                        "result": {"content": [{"type": "text", "text": self.fail[name]}],
                                                   "isError": True}}),
                             {"content-type": "text/event-stream"})
            _maybe_fail(name)
            text = {"recall": self.recall_text, "ingest_turn": self.ingest_text,
                    "forget": self.forget_text}.get(name, self.remember_text)
            return _Resp(200, _sse({"jsonrpc": "2.0", "id": rpc["id"],
                                    "result": {"content": [{"type": "text", "text": text}]}}),
                         {"content-type": "text/event-stream"})
        raise AssertionError(f"unexpected request {req.get_method()} {path} {rpc_method}")


@pytest.fixture
def server(monkeypatch):
    srv = FakeServer()
    monkeypatch.setattr(urllib.request, "urlopen", srv)
    return srv


@pytest.fixture(autouse=True)
def no_warmup(plugin, monkeypatch):
    """initialize() fires a background warm-up recall (#17); keep call
    sequences deterministic here. The warm-up has its own tests below."""
    monkeypatch.setattr(plugin, "_WARMUP_ENABLED", False)


@pytest.fixture
def provider(plugin, tmp_path, monkeypatch, server):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    p = plugin.EngramMemoryProvider()
    p.initialize("sess-1", hermes_home=str(tmp_path), platform="cli")
    yield p
    p.shutdown()


# ---------------------------------------------------------------------------
# Availability
# ---------------------------------------------------------------------------

def test_is_available_checks_config_only_no_network(plugin, server, tmp_path):
    fresh = plugin.EngramMemoryProvider()
    assert fresh.is_available() is True
    assert fresh.unavailable_reason() == ""
    assert server.calls == []

    (tmp_path / "engram.json").write_text(json.dumps({"base_url": ""}))
    p = plugin.EngramMemoryProvider()
    p._hermes_home = str(tmp_path)
    assert p.is_available() is False
    assert "base_url" in p.unavailable_reason()

    (tmp_path / "engram.json").write_text("{not json")
    q = plugin.EngramMemoryProvider()
    q._hermes_home = str(tmp_path)
    assert q.is_available() is False
    assert "engram.json" in q.unavailable_reason()
    assert server.calls == []


def test_initialize_probes_health_once(provider, server):
    assert [c[:2] for c in server.calls] == [("GET", "/health")]
    assert provider.unavailable_reason() == ""


def test_initialize_with_unreachable_server_records_reason_and_prefetch_stays_safe(plugin, server, tmp_path):
    server.fail["health"] = urllib.error.URLError("connection refused")
    p = plugin.EngramMemoryProvider()
    p.initialize("s", hermes_home=str(tmp_path))
    assert "unreachable" in p.unavailable_reason()
    assert p.is_available() is True                     # config is fine; the daemon is what is down
    server.fail["recall"] = urllib.error.URLError("connection refused")
    assert p.prefetch("q") == "" and p.recall_status() is None
    del server.fail["recall"]
    assert "port 9907" in p.prefetch("engram HTTP MCP server")
    assert p.unavailable_reason() == ""                 # a later success clears the startup hint
    p.shutdown()


def test_initialize_records_degraded_and_non_200_health(plugin, server, tmp_path):
    server.health = {"status": "degraded"}
    p = plugin.EngramMemoryProvider()
    p.initialize("s", hermes_home=str(tmp_path))
    assert "status ok" in p.unavailable_reason()
    server.health = {"status": "ok"}
    server.fail["health"] = 503
    q = plugin.EngramMemoryProvider()
    q.initialize("s", hermes_home=str(tmp_path))
    assert "HTTP 503" in q.unavailable_reason()


# ---------------------------------------------------------------------------
# prefetch
# ---------------------------------------------------------------------------

def test_prefetch_success_returns_recalled_text(provider, server):
    out = provider.prefetch("engram HTTP MCP server")
    assert "port 9907" in out
    # health probe at initialize, then the MCP handshake, then tools/call recall
    assert server.calls[0][:2] == ("GET", "/health")
    methods = [c[2] for c in server.calls]
    assert methods[1:3] == ["initialize", "notifications/initialized"]
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
    server.fail["recall"] = urllib.error.URLError("connection refused")
    assert provider.prefetch("anything") == ""
    assert provider.recall_status() is None


# ---------------------------------------------------------------------------
# #17 — timeouts are not silent; warm-up on initialize
# ---------------------------------------------------------------------------

def test_prefetch_timeout_warns_once_and_recall_status_marks_the_miss(provider, server, caplog):
    server.fail["recall"] = TimeoutError("timed out")
    with caplog.at_level(logging.WARNING, logger=provider.__class__.__module__):
        assert provider.prefetch("first") == ""
        assert provider.prefetch("second") == ""
    warnings = [r for r in caplog.records if r.levelno == logging.WARNING and "timed out" in r.getMessage()]
    assert len(warnings) == 1                                   # rate-limited across consecutive misses
    assert "4.0s" in warnings[0].getMessage() and "engram.json" in warnings[0].getMessage()

    status = provider.recall_status()
    assert status is not None and status.count == 0
    assert "timed out" in status.provider_label and "no memory this turn" in status.provider_label
    assert status.glyph != "🧠"                                  # visibly not a recall

    # urlopen-wrapped timeouts count too, and a later success clears the miss.
    server.fail["recall"] = urllib.error.URLError(TimeoutError("timed out"))
    assert provider.prefetch("third") == "" and provider.recall_status().count == 0
    del server.fail["recall"]
    assert "port 9907" in provider.prefetch("engram HTTP MCP server")
    assert provider.recall_status().provider_label == "Engram"

    # a non-timeout failure is still quiet (debug only) and reports no status
    server.fail["recall"] = urllib.error.URLError("connection refused")
    caplog.clear()
    with caplog.at_level(logging.WARNING, logger=provider.__class__.__module__):
        assert provider.prefetch("x") == ""
    assert not [r for r in caplog.records if r.levelno == logging.WARNING]
    assert provider.recall_status() is None


def test_prefetch_timeout_warning_repeats_after_the_interval(plugin, provider, server, caplog, monkeypatch):
    monkeypatch.setattr(plugin, "_TIMEOUT_WARN_INTERVAL_SECS", 0.0)
    server.fail["recall"] = TimeoutError("timed out")
    with caplog.at_level(logging.WARNING, logger=plugin.__name__):
        provider.prefetch("a")
        provider.prefetch("b")
    assert len([r for r in caplog.records if "timed out" in r.getMessage()]) == 2


def test_save_config_defaults_write_timeout_4s(plugin, provider, tmp_path):
    defaults = {f["key"]: f["default"] for f in provider.get_config_schema()}
    provider.save_config(defaults, str(tmp_path))
    data = json.loads((tmp_path / "engram.json").read_text())
    assert data["timeout_secs"] == 4.0
    assert plugin._load_config(str(tmp_path))["timeout_secs"] == 4.0
    assert plugin.DEFAULT_TIMEOUT_SECS == 4.0


def _init_with_warmup(plugin, server, tmp_path, monkeypatch, **kwargs):
    monkeypatch.setattr(plugin, "_WARMUP_ENABLED", True)
    p = plugin.EngramMemoryProvider()
    p.initialize("s", hermes_home=str(tmp_path), **kwargs)
    if p._warmup_thread is not None:
        p._warmup_thread.join(timeout=5)
        assert not p._warmup_thread.is_alive()
    return p


def test_initialize_issues_one_cheap_non_reinforcing_warmup_recall(plugin, server, tmp_path, monkeypatch):
    p = _init_with_warmup(plugin, server, tmp_path, monkeypatch)
    recalls = [c[4] for c in server.calls if c[2] == "tools/call"]
    assert recalls == [{"query": "session warm-up", "limit": 1, "budget": 100, "reinforce": False}]
    assert p.recall_status() is None                            # warm-up is not a turn
    assert p.unavailable_reason() == ""
    assert "port 9907" in p.prefetch("engram HTTP MCP server")   # session reused
    assert [c[2] for c in server.calls].count("initialize") == 1
    p.shutdown()


@pytest.mark.parametrize("failure", [TimeoutError("timed out"), urllib.error.URLError("refused"), 500])
def test_initialize_survives_a_failing_or_slow_warmup(plugin, server, tmp_path, monkeypatch, failure, caplog):
    server.fail["recall"] = failure
    with caplog.at_level(logging.WARNING, logger=plugin.__name__):
        p = _init_with_warmup(plugin, server, tmp_path, monkeypatch)
    assert p.unavailable_reason() == ""
    assert p._consecutive_failures == 0                         # never feeds the breaker
    assert p.recall_status() is None
    assert not [r for r in caplog.records if r.levelno == logging.WARNING]
    del server.fail["recall"]
    assert "port 9907" in p.prefetch("engram HTTP MCP server")
    p.shutdown()


def test_no_warmup_when_prefetch_is_off_for_the_context_or_daemon_is_down(plugin, server, tmp_path, monkeypatch):
    p = _init_with_warmup(plugin, server, tmp_path, monkeypatch, agent_context="cron")
    assert p._warmup_thread is None and [c[2] for c in server.calls if c[2] == "tools/call"] == []
    server.calls.clear()
    server.fail["health"] = urllib.error.URLError("connection refused")
    q = _init_with_warmup(plugin, server, tmp_path, monkeypatch)
    assert q._warmup_thread is None and [c[:2] for c in server.calls] == [("GET", "/health")]


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
    n = len(server.calls)
    assert provider.prefetch("   ") == ""
    assert len(server.calls) == n


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
    n = len(server.calls)
    res = json.loads(provider.handle_tool_call("engram_memory_save", {}))
    assert "content" in res["error"]
    assert len(server.calls) == n


def test_tool_call_rejects_bad_type_and_importance(provider, server):
    assert "Invalid type" in json.loads(
        provider.handle_tool_call("engram_memory_save", {"content": "x", "type": "rumor"}))["error"]
    assert "importance" in json.loads(
        provider.handle_tool_call("engram_memory_save", {"content": "x", "importance": 7}))["error"]
    assert [c[1] for c in server.calls] == ["/health"]


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
# engram_memory_forget (#55)
# ---------------------------------------------------------------------------

def test_forget_by_memory_id_calls_forget_under_the_profile_scope(provider, server):
    server.forget_text = '<forgotten id="abc-123" scope="hermes:default" hard="false" />'
    res = json.loads(provider.handle_tool_call("engram_memory_forget", {"memory_id": " abc-123 "}))
    assert res == {"result": server.forget_text}
    _, _, rpc, _, args = server.calls[-1]
    assert rpc == "tools/call"
    assert args == {"memory_id": "abc-123", "scope": provider._write_scope()}


def test_forget_by_query_forwards_confirm(provider, server):
    server.forget_text = '<forget_candidates query="old fact" count="2" forgotten="none" />'
    res = json.loads(provider.handle_tool_call("engram_memory_forget", {"query": "old fact"}))
    assert res == {"result": server.forget_text}
    assert server.calls[-1][4] == {"query": "old fact", "confirm": False, "scope": provider._write_scope()}
    provider.handle_tool_call("engram_memory_forget", {"query": "old fact", "confirm": True})
    assert server.calls[-1][4] == {"query": "old fact", "confirm": True, "scope": provider._write_scope()}


def test_forget_requires_exactly_one_of_id_or_query_before_any_http(provider, server):
    n = len(server.calls)
    assert "exactly one" in json.loads(provider.handle_tool_call("engram_memory_forget", {}))["error"]
    assert "exactly one" in json.loads(
        provider.handle_tool_call("engram_memory_forget", {"memory_id": "abc-123", "query": "x"}))["error"]
    assert "exactly one" in json.loads(provider.handle_tool_call("engram_memory_forget", {"memory_id": "  "}))["error"]
    assert len(server.calls) == n


def test_forget_backend_error_and_breaker(provider, server, plugin):
    server.fail["forget"] = urllib.error.URLError("connection refused")
    res = json.loads(provider.handle_tool_call("engram_memory_forget", {"memory_id": "abc-123"}))
    assert res["error"].startswith("engram forget failed")
    server.fail["recall"] = urllib.error.URLError("down")
    for _ in range(plugin._BREAKER_THRESHOLD):
        provider.prefetch("q")
    n = len(server.calls)
    assert "temporarily unavailable" in json.loads(
        provider.handle_tool_call("engram_memory_forget", {"memory_id": "abc-123"}))["error"]
    assert len(server.calls) == n


# ---------------------------------------------------------------------------
# Schemas, prompt block, config, misc contract
# ---------------------------------------------------------------------------

def test_tool_schema_shape(provider):
    schemas = provider.get_tool_schemas()
    assert [s["name"] for s in schemas] == ["engram_memory_save", "engram_memory_forget"]
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
    assert cfg == {"base_url": "http://127.0.0.1:9907", "timeout_secs": 4.0,
                   "prefetch_token_budget": 300, "sync_turns": True, "mirror_memory_writes": True,
                   "prefetch_contexts": ["primary"], "token": ""}
    keys = [f["key"] for f in provider.get_config_schema()]
    assert keys == ["base_url", "timeout_secs", "prefetch_token_budget", "sync_turns",
                    "mirror_memory_writes", "prefetch_contexts", "token"]
    # the bearer token (#27) is the only secret field
    assert [f["key"] for f in provider.get_config_schema() if f.get("secret")] == ["token"]


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
    assert provider.on_session_end([]) is None
    assert provider.on_memory_write("remove", "memory", "x") is None
    assert provider.on_pre_compress([]) == ""
    assert [c[1] for c in server.calls] == ["/health"]


# ---------------------------------------------------------------------------
# sync_turn (W3): bounded queue + context-bound drain posting ingest_turn
# ---------------------------------------------------------------------------

TOOL_MESSAGES = [
    {"role": "user", "content": "earlier question"},
    {"role": "assistant", "content": "earlier answer", "tool_calls": [
        {"id": "old", "type": "function", "function": {"name": "stale", "arguments": "{}"}}]},
    {"role": "tool", "tool_call_id": "old", "content": "ignored"},
    {"role": "user", "content": [{"type": "text", "text": "what time is it"}]},
    {"role": "assistant", "content": None, "tool_calls": [
        {"id": "c1", "type": "function", "function": {"name": "clock", "arguments": "{\"tz\": \"UTC\"}"}}]},
    {"role": "tool", "tool_call_id": "c1", "content": "12:00"},
    {"role": "assistant", "content": "It is noon"},
]


def _wait_for(pred, timeout=5.0):
    deadline = time.monotonic() + timeout
    while not pred():
        assert time.monotonic() < deadline, "condition not met in time"
        time.sleep(0.01)


def test_sync_turn_enqueues_fast_without_network_on_caller_thread(provider, server):
    server.gate = threading.Event()
    t0 = time.perf_counter()
    for i in range(5):
        provider.sync_turn(f"u{i}", f"a{i}", session_id="s1")
    elapsed_ms = (time.perf_counter() - t0) * 1000
    assert elapsed_ms < 10, f"sync_turn took {elapsed_ms:.1f} ms"
    server.gate.set()
    provider.shutdown()
    assert len(server.ingest_calls()) == 5
    # Every request before shutdown's session DELETE came from the drain thread, never the caller.
    # Only initialize's one-off /health probe and shutdown's session DELETE run on the caller thread.
    assert all(name.startswith("engram-sync")
               for name, call in zip(server.threads, server.calls)
               if call[0] != "DELETE" and call[1] != "/health")


def test_drain_posts_ingest_turn_with_scope_session_and_text(plugin, server, tmp_path):
    home = tmp_path / "profiles" / "career"
    home.mkdir(parents=True)
    p = plugin.EngramMemoryProvider()
    p.initialize("init-sess", hermes_home=str(home), platform="cli")
    p.sync_turn("what time is it", "It is noon", session_id="conv-42",
                messages=TOOL_MESSAGES, turn_author={"id": "u", "name": "devin", "is_bot": False})
    p.shutdown()
    (args,) = server.ingest_calls()
    assert args["scope"] == "hermes:career"
    assert args["session_id"] == "conv-42"
    assert args["turn_index"] == 0
    assert args["user_text"] == "what time is it"
    assert args["assistant_text"] == "It is noon"
    assert args["source"] == "hermes"
    assert args["timestamp"].endswith("+00:00")
    assert args["tool_calls"] == [{"name": "clock", "input": {"tz": "UTC"}, "output": "12:00"}]
    assert args["author"] == {"id": "u", "name": "devin", "is_bot": False}     # #18
    assert server.calls[-1][0] == "DELETE"           # shutdown closed the MCP session after draining


def test_scope_prefers_agent_identity_then_default_home(plugin, server, tmp_path):
    p = plugin.EngramMemoryProvider()
    p.initialize("s", hermes_home=str(tmp_path), agent_identity="ops")
    p.sync_turn("u", "a", session_id="x")
    p.shutdown()
    assert server.ingest_calls()[-1]["scope"] == "hermes:ops"

    q = plugin.EngramMemoryProvider()
    q.initialize("fallback-sess", hermes_home=str(tmp_path))   # not a profile home -> default
    q.sync_turn("u", "a")                                      # no session_id -> initialize's
    q.shutdown()
    last = server.ingest_calls()[-1]
    assert last["scope"] == "hermes:default"
    assert last["session_id"] == "fallback-sess"
    assert "tool_calls" not in last
    assert "author" not in last                       # no turn_author -> no author key (#18)


def test_turn_author_maps_is_bot_faithfully_and_drops_unknown_keys(provider, server):
    provider.sync_turn("u", "a", session_id="s", turn_author={"id": 42, "name": "bot", "is_bot": True, "handle": "x"})
    provider.sync_turn("u", "a", session_id="s", turn_author={"name": "anon"})
    provider.sync_turn("u", "a", session_id="s", turn_author={})
    provider.shutdown()
    authors = [c.get("author") for c in server.ingest_calls()]
    assert authors == [{"id": "42", "name": "bot", "is_bot": True}, {"name": "anon"}, None]


def test_turn_index_increments_per_session(provider, server):
    for _ in range(3):
        provider.sync_turn("u", "a", session_id="A")
    provider.sync_turn("u", "a", session_id="B")
    provider.sync_turn("u", "a", session_id="A")
    provider.shutdown()
    seen = [(c["session_id"], c["turn_index"]) for c in server.ingest_calls()]
    assert seen == [("A", 0), ("A", 1), ("A", 2), ("B", 0), ("A", 3)]


def test_overflow_drops_oldest_and_never_blocks(provider, server, plugin):
    server.gate = threading.Event()
    provider.sync_turn("u0", "a0", session_id="s")
    assert server.ingest_started.wait(timeout=5)       # turn 0 is in flight, blocked in urlopen
    t0 = time.perf_counter()
    for i in range(1, 40):
        provider.sync_turn(f"u{i}", f"a{i}", session_id="s")
    assert (time.perf_counter() - t0) < 0.05
    assert provider._sync_queue.qsize() == plugin._SYNC_QUEUE_MAX == 16
    server.gate.set()
    provider.shutdown()
    posted = [c["turn_index"] for c in server.ingest_calls()]
    assert posted == [0] + list(range(24, 40))


def test_breaker_open_parks_turn_without_posting(provider, server, plugin):
    server.fail["recall"] = urllib.error.URLError("down")
    for _ in range(plugin._BREAKER_THRESHOLD):
        provider.prefetch("q")
    n = len(server.calls)
    provider.sync_turn("u", "a", session_id="s")
    t0 = time.perf_counter()
    provider.shutdown()                               # parked items are not waited on
    assert (time.perf_counter() - t0) < 1.0
    assert len(server.calls) == n
    assert server.ingest_calls() == []
    assert provider._sync_queue.qsize() == 1           # parked, not dropped (#18)
    assert provider.unavailable_reason() == ""         # nothing overflowed


def test_breaker_cooldown_lapse_posts_the_parked_turn(provider, server, plugin, monkeypatch):
    monkeypatch.setattr(plugin, "_BREAKER_COOLDOWN_SECS", 0.05)
    server.fail["recall"] = urllib.error.URLError("down")
    for _ in range(plugin._BREAKER_THRESHOLD):
        provider.prefetch("q")
    assert provider._is_breaker_open()
    provider.sync_turn("parked", "a", session_id="s", turn_author={"id": "u", "name": "d", "is_bot": False})
    _wait_for(lambda: server.ingest_calls(), timeout=5.0)
    (args,) = server.ingest_calls()
    assert args["user_text"] == "parked" and args["turn_index"] == 0
    assert args["author"] == {"id": "u", "name": "d", "is_bot": False}
    assert not provider._is_breaker_open()
    provider.shutdown()
    assert server.ingest_calls() == [args]             # posted exactly once


def test_breaker_open_overflow_drops_are_counted_in_unavailable_reason(provider, server, plugin):
    server.fail["recall"] = urllib.error.URLError("down")
    for _ in range(plugin._BREAKER_THRESHOLD):
        provider.prefetch("q")
    for i in range(plugin._SYNC_QUEUE_MAX + 3):
        provider.sync_turn(f"u{i}", f"a{i}", session_id="s")
    assert provider._sync_queue.qsize() == plugin._SYNC_QUEUE_MAX
    assert "3 queued turn(s) dropped while the circuit breaker was open" in provider.unavailable_reason()
    provider.shutdown()
    assert server.ingest_calls() == []


def test_ingest_failures_count_toward_breaker(provider, server, plugin, monkeypatch):
    monkeypatch.setattr(plugin, "_SYNC_DRAIN_POLL_SECS", 0.01)
    server.fail["ingest_turn"] = urllib.error.URLError("down")
    for i in range(plugin._BREAKER_THRESHOLD):
        provider.sync_turn(f"u{i}", "a", session_id="s")
    provider.shutdown()
    assert provider._is_breaker_open()
    calls = server.ingest_calls()
    assert len(calls) == plugin._BREAKER_THRESHOLD
    # A transport failure keeps the item: every attempt was the same head turn (#41)
    assert {c["turn_index"] for c in calls} == {0}
    assert provider._sync_queue.qsize() == plugin._BREAKER_THRESHOLD - 1   # the rest are parked
    assert provider._sync_pending == plugin._BREAKER_THRESHOLD              # the head is held, not dropped


def test_half_open_probe_failure_keeps_the_parked_turn_and_reopens(provider, server, plugin, monkeypatch):
    """#41: after the cooldown exactly one probe posts; if the daemon is still
    down the breaker re-opens at once with the failure count intact and the
    parked turn is still queued. Once the daemon is back, the turn posts."""
    monkeypatch.setattr(plugin, "_BREAKER_COOLDOWN_SECS", 0.05)
    server.fail["recall"] = urllib.error.URLError("down")
    for _ in range(plugin._BREAKER_THRESHOLD):
        provider.prefetch("q")
    assert provider._is_breaker_open()
    monkeypatch.setattr(plugin, "_BREAKER_COOLDOWN_SECS", 60)    # the re-open must use a long cooldown
    server.fail["ingest_turn"] = urllib.error.URLError("still down")
    provider.sync_turn("parked", "a", session_id="s")
    _wait_for(lambda: server.ingest_calls(), timeout=5.0)
    time.sleep(0.6)                                                # enough for several more polls
    assert len(server.ingest_calls()) == 1                         # exactly one probe per cooldown
    assert provider._is_breaker_open()                             # re-opened, not half-open
    assert provider._consecutive_failures == plugin._BREAKER_THRESHOLD   # count not reset
    assert provider._sync_pending == 1                             # the turn is still parked
    n = len(server.calls)
    assert provider.prefetch("q") == "" and len(server.calls) == n  # nobody else probes while open
    # Daemon comes back and the cooldown lapses: the parked turn posts and the breaker closes.
    del server.fail["ingest_turn"]
    del server.fail["recall"]
    with provider._breaker_lock:
        provider._breaker_open_until = 0.0
    _wait_for(lambda: len(server.ingest_calls()) == 2, timeout=5.0)
    _wait_for(lambda: provider._sync_pending == 0, timeout=5.0)
    assert [c["turn_index"] for c in server.ingest_calls()] == [0, 0]
    assert not provider._is_breaker_open() and provider._consecutive_failures == 0
    provider.shutdown()
    assert len(server.ingest_calls()) == 2                         # nothing posted twice after success


def test_half_open_allows_one_probe_at_a_time(provider, server, plugin, monkeypatch):
    server.fail["recall"] = urllib.error.URLError("down")
    for _ in range(plugin._BREAKER_THRESHOLD):
        provider.prefetch("q")
    with provider._breaker_lock:
        provider._breaker_open_until = 0.0                         # cooldown lapsed
    assert provider._breaker_permits_call()                        # first caller is the probe
    assert not provider._breaker_permits_call()                    # second caller waits
    assert provider._is_breaker_open()                             # status: still open
    provider._record_success()
    assert provider._breaker_permits_call() and not provider._is_breaker_open()


def test_stale_half_open_probe_counts_as_failed(provider, server, plugin, monkeypatch):
    monkeypatch.setattr(plugin, "_BREAKER_PROBE_TTL_SECS", 0.01)
    server.fail["recall"] = urllib.error.URLError("down")
    for _ in range(plugin._BREAKER_THRESHOLD):
        provider.prefetch("q")
    with provider._breaker_lock:
        provider._breaker_open_until = 0.0
    assert provider._breaker_permits_call()                        # probe granted and never reported
    time.sleep(0.02)
    assert provider._is_breaker_open()                             # expired probe => re-opened
    assert not provider._breaker_permits_call()
    assert provider._breaker_open_until > time.monotonic()


def test_rejected_item_is_dropped_and_does_not_block_the_queue(provider, server, plugin, caplog):
    server.fail["ingest_turn"] = "turn rejected: user_text too long"
    provider.sync_turn("bad", "a", session_id="s")
    _wait_for(lambda: server.ingest_calls(), timeout=5.0)
    _wait_for(lambda: provider._sync_pending == 0, timeout=5.0)
    del server.fail["ingest_turn"]
    provider.sync_turn("good", "a", session_id="s")
    _wait_for(lambda: len(server.ingest_calls()) == 2, timeout=5.0)
    assert [c["user_text"] for c in server.ingest_calls()] == ["bad", "good"]   # no retry of the bad one
    assert provider._consecutive_failures == 0                     # the good post reset the count


def test_sync_turns_disabled_is_noop(plugin, server, tmp_path):
    (tmp_path / "engram.json").write_text(json.dumps({"sync_turns": False}))
    p = plugin.EngramMemoryProvider()
    p.initialize("s", hermes_home=str(tmp_path))
    p.sync_turn("u", "a", session_id="s")
    assert p._sync_thread is None
    p.shutdown()
    assert server.ingest_calls() == [] and [c[1] for c in server.calls] == ["/health"]


def test_shutdown_drains_pending_within_deadline(provider, server):
    server.gate = threading.Event()
    for i in range(5):
        provider.sync_turn(f"u{i}", f"a{i}", session_id="s")
    server.gate.set()
    t0 = time.perf_counter()
    provider.shutdown()
    assert (time.perf_counter() - t0) < 3.0
    assert [c["turn_index"] for c in server.ingest_calls()] == [0, 1, 2, 3, 4]
    assert provider._sync_queue.empty()


def test_shutdown_deadline_bounds_a_stuck_server(provider, server, plugin, monkeypatch):
    monkeypatch.setattr(plugin, "_SHUTDOWN_DRAIN_SECS", 0.3)
    server.gate = threading.Event()                    # never released: post hangs until urlopen timeout
    provider.sync_turn("u", "a", session_id="s")
    assert server.ingest_started.wait(timeout=5)
    t0 = time.perf_counter()
    provider.shutdown()
    assert (time.perf_counter() - t0) < 1.5
    server.gate.set()


# ---------------------------------------------------------------------------
# on_memory_write (W4): mirror MEMORY.md / USER.md writes into engram remember
# ---------------------------------------------------------------------------

def test_memory_write_add_posts_remember_with_scope_and_type(plugin, server, tmp_path):
    home = tmp_path / "profiles" / "career"
    home.mkdir(parents=True)
    p = plugin.EngramMemoryProvider()
    p.initialize("s", hermes_home=str(home))
    p.on_memory_write("add", "memory", "Repo uses pnpm, not npm",
                      metadata={"write_origin": "memory_tool", "session_id": "s"})
    p.shutdown()
    (args,) = server.remember_calls()
    assert args == {"content": "Repo uses pnpm, not npm", "type": "fact", "importance": 0.6,
                    "source": "hermes-mirror", "context": "mirrored from built-in memory: add",
                    "scope": "hermes:career"}


def test_memory_write_replace_posts_new_content_only(provider, server):
    provider.on_memory_write("replace", "memory", "Repo uses bun",
                             metadata={"old_text": "Repo uses pnpm, not npm"})
    provider.shutdown()
    (args,) = server.remember_calls()
    assert args["content"] == "Repo uses bun"
    assert "pnpm" not in json.dumps(args)
    assert args["source"] == "hermes-mirror"
    assert args["context"] == "mirrored from built-in memory: replace"


def test_memory_write_remove_posts_nothing(provider, server):
    provider.on_memory_write("remove", "memory", "Repo uses bun", metadata={"old_text": "x"})
    provider.on_memory_write("delete", "user", "y")        # unknown action: also ignored
    provider.on_memory_write("add", "memory", "   ")        # blank content: ignored
    assert provider._sync_thread is None
    provider.shutdown()
    assert [c[1] for c in server.calls] == ["/health"]           # startup probe only; no MCP session opened


def test_memory_write_user_target_is_preference(provider, server):
    provider.on_memory_write("add", "user", "Prefers terse answers")
    provider.shutdown()
    (args,) = server.remember_calls()
    assert args["type"] == "preference" and args["scope"] == "hermes:default"


def test_memory_write_returns_fast_without_network_on_caller_thread(provider, server):
    server.gate = threading.Event()
    t0 = time.perf_counter()
    for i in range(5):
        provider.on_memory_write("add", "memory", f"fact {i}")
    assert (time.perf_counter() - t0) * 1000 < 10
    server.gate.set()
    provider.shutdown()
    assert len(server.remember_calls()) == 5
    # Only initialize's one-off /health probe and shutdown's session DELETE run on the caller thread.
    assert all(name.startswith("engram-sync")
               for name, call in zip(server.threads, server.calls)
               if call[0] != "DELETE" and call[1] != "/health")


def test_memory_write_shares_queue_with_turns_in_order(provider, server):
    provider.sync_turn("u", "a", session_id="s")
    provider.on_memory_write("add", "memory", "mid")
    provider.sync_turn("u2", "a2", session_id="s")
    provider.shutdown()
    tools = [c[4].get("turn_index", "remember") for c in server.calls if c[2] == "tools/call"]
    assert tools == [0, "remember", 1]


def test_mirror_memory_writes_disabled_is_noop(plugin, server, tmp_path):
    (tmp_path / "engram.json").write_text(json.dumps({"mirror_memory_writes": False}))
    p = plugin.EngramMemoryProvider()
    p.initialize("s", hermes_home=str(tmp_path))
    p.on_memory_write("add", "memory", "x")
    assert p._sync_thread is None
    p.sync_turn("u", "a", session_id="s")                  # turns are governed by sync_turns, not this key
    p.shutdown()
    assert len(server.ingest_calls()) == 1 and server.remember_calls() == []


def test_memory_write_breaker_open_skips_post(provider, server, plugin):
    server.fail["recall"] = urllib.error.URLError("down")
    for _ in range(plugin._BREAKER_THRESHOLD):
        provider.prefetch("q")
    n = len(server.calls)
    provider.on_memory_write("add", "memory", "x")
    provider.shutdown()
    assert len(server.calls) == n and server.remember_calls() == []


# ---------------------------------------------------------------------------
# agent_context gating (W5)
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("context", ["cron", "subagent", "flush"])
def test_non_primary_context_enqueues_nothing(plugin, server, tmp_path, context):
    p = plugin.EngramMemoryProvider()
    p.initialize("s", hermes_home=str(tmp_path), agent_context=context)
    p.sync_turn("u", "a", session_id="s")
    p.on_memory_write("add", "memory", "x")
    assert p._sync_thread is None and p._sync_queue.empty()
    p.shutdown()
    assert [c[1] for c in server.calls] == ["/health"]


def test_cron_context_prefetch_is_skipped_without_network(plugin, server, tmp_path):
    p = plugin.EngramMemoryProvider()
    p.initialize("s", hermes_home=str(tmp_path), agent_context="cron")
    n = len(server.calls)
    assert p.prefetch("engram HTTP MCP server") == ""
    assert p.recall_status() is None
    assert len(server.calls) == n
    # explicit saves from a cron job are still honoured (documented choice)
    res = json.loads(p.handle_tool_call("engram_memory_save", {"content": "x"}))
    assert "result" in res
    p.shutdown()


@pytest.mark.parametrize("kwargs", [{}, {"agent_context": "primary"}, {"agent_context": ""}])
def test_primary_or_absent_context_is_unchanged(plugin, server, tmp_path, kwargs):
    p = plugin.EngramMemoryProvider()
    p.initialize("s", hermes_home=str(tmp_path), **kwargs)
    assert "port 9907" in p.prefetch("engram HTTP MCP server")
    p.sync_turn("u", "a", session_id="s")
    p.on_memory_write("add", "memory", "x")
    p.shutdown()
    assert len(server.ingest_calls()) == 1 and len(server.remember_calls()) == 1


def test_prefetch_contexts_opts_cron_into_recall_but_not_writes(plugin, server, tmp_path):
    (tmp_path / "engram.json").write_text(json.dumps({"prefetch_contexts": ["primary", "cron"]}))
    p = plugin.EngramMemoryProvider()
    p.initialize("s", hermes_home=str(tmp_path), agent_context="cron")
    assert "port 9907" in p.prefetch("engram HTTP MCP server")
    p.sync_turn("u", "a", session_id="s")
    p.on_memory_write("add", "memory", "x")
    assert p._sync_thread is None
    p.shutdown()
    assert server.ingest_calls() == [] and server.remember_calls() == []


def test_prefetch_contexts_accepts_comma_string_and_rejects_junk(plugin, tmp_path):
    (tmp_path / "engram.json").write_text(json.dumps({"prefetch_contexts": " cron, primary "}))
    assert plugin._load_config(str(tmp_path))["prefetch_contexts"] == ["cron", "primary"]
    (tmp_path / "engram.json").write_text(json.dumps({"prefetch_contexts": 7}))
    assert plugin._load_config(str(tmp_path))["prefetch_contexts"] == ["primary"]


def test_register_collects_provider(plugin):
    class Ctx:
        provider = None

        def register_memory_provider(self, p):
            self.provider = p
    ctx = Ctx()
    plugin.register(ctx)
    assert isinstance(ctx.provider, plugin.EngramMemoryProvider)
    assert ctx.provider.name == "engram"


# ---------------------------------------------------------------------------
# bearer token (#27)
# ---------------------------------------------------------------------------

def test_token_is_sent_as_bearer_on_mcp_but_never_on_health(plugin, server, tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    (tmp_path / "engram.json").write_text(json.dumps({"token": " s3cr3t "}))
    server.required_token = "s3cr3t"
    p = plugin.EngramMemoryProvider()
    p.initialize("s", hermes_home=str(tmp_path), platform="cli")
    assert p.unavailable_reason() == ""                          # /health probe needs no token
    assert "port 9907" in p.prefetch("engram HTTP MCP server")   # initialize + recall carried the bearer
    mcp_auth = [a for (c, a) in zip(server.calls, server.auth_headers) if c[1] == "/mcp"]
    assert mcp_auth and all(a == "Bearer s3cr3t" for a in mcp_auth)
    health_auth = [a for (c, a) in zip(server.calls, server.auth_headers) if c[1] == "/health"]
    assert health_auth == [None]
    p.shutdown()


def test_missing_token_against_an_authenticated_daemon_is_a_plain_failure(plugin, server, tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    server.required_token = "s3cr3t"
    p = plugin.EngramMemoryProvider()
    p.initialize("s", hermes_home=str(tmp_path), platform="cli")
    assert p.prefetch("q") == ""                                  # 401 -> empty recall, no exception
    assert p._consecutive_failures == 1
    p.shutdown()


def test_token_change_recreates_the_client(plugin, server, tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    p = plugin.EngramMemoryProvider()
    p.initialize("s", hermes_home=str(tmp_path), platform="cli")
    first = p._get_client()
    assert first.token == ""
    p.save_config({"token": "abc"}, str(tmp_path))
    second = p._get_client()
    assert second is not first and second.token == "abc"
    assert any(f["key"] == "token" and f.get("secret") for f in p.get_config_schema())
    p.shutdown()
