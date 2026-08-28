"""Contract tests for EngramMemoryProvider against Hermes's REAL ABC (ADR-010)."""

import json
import os
import sys
import time

import pytest

PLUGIN_DIR = os.path.join(os.path.dirname(__file__), "..")
sys.path.insert(0, PLUGIN_DIR)

from provider import EngramMemoryProvider, load_hermes_memory_provider_abc  # noqa: E402

FAKE_SERVER = os.path.join(os.path.dirname(__file__), "fake_mcp_server.py")


def make_provider(tmp_path, **config_overrides):
    """Provider wired to the fake MCP server via config injection."""
    config = {
        "server_command": [sys.executable, FAKE_SERVER],
        "idle_kill_s": 600,
        **config_overrides,
    }
    hermes_home = tmp_path / "hermes_home"
    hermes_home.mkdir(exist_ok=True)
    (hermes_home / "engram.json").write_text(json.dumps(config))
    return EngramMemoryProvider(), str(hermes_home)


def test_subclasses_real_hermes_abc(tmp_path):
    abc = load_hermes_memory_provider_abc()
    provider, _ = make_provider(tmp_path)
    assert isinstance(provider, abc)
    assert provider.name == "engram"


def test_tool_schemas_are_namespaced_openai_format(tmp_path):
    provider, home = make_provider(tmp_path)
    provider.initialize("sess-1", hermes_home=home, platform="cli", agent_context="primary")
    schemas = provider.get_tool_schemas()
    assert len(schemas) >= 3
    for schema in schemas:
        assert schema["name"].startswith("engram_")
        assert "description" in schema
        assert schema["parameters"]["type"] == "object"


def test_non_primary_context_never_spawns(tmp_path):
    provider, home = make_provider(tmp_path)
    provider.initialize("sess-c", hermes_home=home, platform="cron", agent_context="cron")
    assert provider.prefetch("what is the deploy strategy?") == ""
    assert provider.child_pid is None
    provider.shutdown()


def test_prefetch_lazily_spawns_and_returns_recall_text(tmp_path):
    provider, home = make_provider(tmp_path)
    provider.initialize(
        "sess-p", hermes_home=home, platform="cli",
        agent_context="primary", agent_identity="career",
    )
    assert provider.child_pid is None  # lazy — no spawn at init
    text = provider.prefetch("kubernetes rollout")
    assert provider.child_pid is not None
    payload = json.loads(text)
    assert payload["tool"] == "recall"
    assert payload["args"]["query"] == "kubernetes rollout"
    provider.shutdown()


def test_child_env_carries_profile_scope(tmp_path):
    provider, home = make_provider(tmp_path)
    provider.initialize(
        "sess-s", hermes_home=home, platform="cli",
        agent_context="primary", agent_identity="career",
    )
    payload = json.loads(provider.prefetch("anything"))
    assert payload["env_scope"] == "hermes:career"
    provider.shutdown()


def test_handle_tool_call_proxies_and_returns_json_string(tmp_path):
    provider, home = make_provider(tmp_path)
    provider.initialize("sess-t", hermes_home=home, platform="cli", agent_context="primary")
    raw = provider.handle_tool_call("engram_recall", {"query": "tailscale"})
    assert isinstance(raw, str)
    parsed = json.loads(raw)
    assert parsed["ok"] is True
    inner = json.loads(parsed["result"])
    assert inner["tool"] == "recall"
    provider.shutdown()


def test_handle_tool_call_unknown_tool_returns_error_json(tmp_path):
    provider, home = make_provider(tmp_path)
    provider.initialize("sess-u", hermes_home=home, platform="cli", agent_context="primary")
    parsed = json.loads(provider.handle_tool_call("engram_nope", {}))
    assert parsed["ok"] is False
    assert "unknown" in parsed["error"].lower()
    provider.shutdown()


def test_handle_tool_call_surfaces_tool_level_errors(tmp_path):
    provider, home = make_provider(tmp_path)
    provider.initialize("sess-e", hermes_home=home, platform="cli", agent_context="primary")
    provider._client = None
    # route the namespaced tool at the fake server's failing tool
    import provider as provider_module
    provider_module._TOOL_MAP["engram_toolerr"] = "toolerr"
    try:
        parsed = json.loads(provider.handle_tool_call("engram_toolerr", {}))
        assert parsed["ok"] is False
        assert "database is locked" in parsed["error"]
    finally:
        del provider_module._TOOL_MAP["engram_toolerr"]
        provider.shutdown()


def test_on_memory_write_mirrors_into_graph(tmp_path):
    log = tmp_path / "writes.jsonl"
    provider, home = make_provider(tmp_path, extra_env={"FAKE_LOG": str(log)})
    provider.initialize(
        "sess-w", hermes_home=home, platform="cli",
        agent_context="primary", agent_identity="career",
    )
    provider.prefetch("warm up")  # ensure child running
    provider.on_memory_write("add", "memory", "Devin prefers fish shell")
    provider.flush_writes()
    lines = [json.loads(l) for l in log.read_text().splitlines() if l.strip()]
    remembers = [l for l in lines if l["tool"] == "remember"]
    assert len(remembers) == 1
    assert remembers[0]["args"]["content"] == "Devin prefers fish shell"
    provider.shutdown()


def test_remove_actions_are_not_mirrored(tmp_path):
    log = tmp_path / "writes2.jsonl"
    provider, home = make_provider(tmp_path, extra_env={"FAKE_LOG": str(log)})
    provider.initialize("sess-r", hermes_home=home, platform="cli", agent_context="primary")
    provider.prefetch("warm up")
    provider.on_memory_write("remove", "memory", "old fact")
    provider.flush_writes()
    content = log.read_text() if log.exists() else ""
    assert "remove" not in content and "old fact" not in content
    provider.shutdown()


def test_backup_paths_is_deliberately_empty(tmp_path):
    provider, _ = make_provider(tmp_path)
    assert provider.backup_paths() == []


def test_is_available_without_node_or_dist_is_false(tmp_path):
    provider = EngramMemoryProvider()
    provider._config = {"repo_path": str(tmp_path / "nonexistent")}
    assert provider.is_available() is False


def test_shutdown_stops_child(tmp_path):
    provider, home = make_provider(tmp_path)
    provider.initialize("sess-x", hermes_home=home, platform="cli", agent_context="primary")
    provider.prefetch("spawn it")
    pid = provider.child_pid
    provider.shutdown()
    assert provider.child_pid is None
    with pytest.raises(OSError):
        os.kill(pid, 0)


def test_no_respawn_after_shutdown(tmp_path):
    provider, home = make_provider(tmp_path)
    provider.initialize("sess-z", hermes_home=home, platform="cli", agent_context="primary")
    provider.prefetch("spawn it")
    provider.shutdown()
    assert provider.child_pid is None
    # late writes/reads after shutdown must not bring a child back
    provider.on_memory_write("add", "memory", "late fact")
    provider.flush_writes(timeout=0.5)
    assert provider.child_pid is None
    assert provider.prefetch("anything") == ""
    assert provider.child_pid is None
    # a fresh initialize re-opens the door
    provider.initialize("sess-z2", hermes_home=home, platform="cli", agent_context="primary")
    assert provider.prefetch("again") != ""
    provider.shutdown()


def test_idle_child_is_reaped_automatically_without_manual_polling(tmp_path):
    provider, home = make_provider(tmp_path, idle_kill_s=1)
    provider.initialize("sess-auto", hermes_home=home, platform="cli", agent_context="primary")
    provider.prefetch("spawn it")
    assert provider.child_pid is not None
    deadline = time.monotonic() + 4.0
    while provider.child_pid is not None and time.monotonic() < deadline:
        time.sleep(0.1)
    assert provider.child_pid is None  # reaper thread did it, nobody called reap_if_idle
    # a later call transparently respawns (and restarts the reaper)
    assert provider.prefetch("again") != ""
    assert provider.child_pid is not None
    provider.shutdown()


def test_idle_kill_reaps_quiet_child(tmp_path):
    provider, home = make_provider(tmp_path, idle_kill_s=1)
    provider.initialize("sess-i", hermes_home=home, platform="cli", agent_context="primary")
    provider.prefetch("spawn it")
    pid = provider.child_pid
    assert pid is not None
    time.sleep(1.3)
    provider.reap_if_idle()
    assert provider.child_pid is None
    provider.shutdown()


def test_dashboard_flat_json_config_is_honored(tmp_path):
    """Hermes's dashboard persists flat_json provider config at
    <hermes_home>/<provider>/config.json — it must be read, and win."""
    provider, home = make_provider(tmp_path, budget=500)
    dash_dir = tmp_path / "hermes_home" / "engram"
    dash_dir.mkdir()
    (dash_dir / "config.json").write_text(json.dumps({"budget": 777, "idle_kill_s": 42}))
    provider.initialize("sess-d", hermes_home=home, platform="cli", agent_context="primary")
    assert provider._config["budget"] == 777
    assert provider._config["idle_kill_s"] == 42
    assert provider._config["server_command"]  # engram.json keys still present
    provider.shutdown()


def test_get_config_schema_and_save_config(tmp_path):
    provider, home = make_provider(tmp_path)
    schema = provider.get_config_schema()
    keys = [f["key"] for f in schema]
    assert "budget" in keys and "idle_kill_s" in keys
    provider.save_config({"budget": 900}, home)
    saved = json.loads((tmp_path / "hermes_home" / "engram.json").read_text())
    assert saved["budget"] == 900
    mode = os.stat(tmp_path / "hermes_home" / "engram.json").st_mode & 0o777
    assert mode == 0o600
