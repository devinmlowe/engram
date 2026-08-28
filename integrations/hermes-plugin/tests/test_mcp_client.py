"""Tests for the stdio JSON-RPC MCP client (ADR-010 Phase 1)."""

import json
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from mcp_client import McpStdioClient, McpError  # noqa: E402

FAKE_SERVER = os.path.join(os.path.dirname(__file__), "fake_mcp_server.py")


@pytest.fixture
def client():
    c = McpStdioClient([sys.executable, FAKE_SERVER])
    yield c
    c.stop()


def test_start_performs_initialize_handshake(client):
    client.start()
    assert client.alive
    assert client.server_info["name"] == "fake-engram"


def test_list_tools_returns_tool_definitions(client):
    client.start()
    tools = client.list_tools()
    names = [t["name"] for t in tools]
    assert names == ["recall", "remember"]
    assert tools[0]["inputSchema"]["required"] == ["query"]


def test_call_tool_returns_joined_text_content(client):
    client.start()
    text = client.call_tool("recall", {"query": "kubernetes"})
    payload = json.loads(text)
    assert payload["tool"] == "recall"
    assert payload["args"] == {"query": "kubernetes"}


def test_env_is_passed_to_child():
    c = McpStdioClient([sys.executable, FAKE_SERVER], env={"ENGRAM_SCOPE": "hermes:career"})
    try:
        c.start()
        payload = json.loads(c.call_tool("recall", {"query": "x"}))
        assert payload["env_scope"] == "hermes:career"
    finally:
        c.stop()


def test_tool_error_raises_mcp_error(client):
    client.start()
    with pytest.raises(McpError, match="boom"):
        client.call_tool("boom", {})


def test_tool_level_is_error_result_raises_mcp_error(client):
    client.start()
    with pytest.raises(McpError, match="database is locked"):
        client.call_tool("toolerr", {})
    # client remains usable afterwards
    assert json.loads(client.call_tool("recall", {"query": "x"}))["tool"] == "recall"


def test_call_tool_timeout():
    c = McpStdioClient([sys.executable, FAKE_SERVER], env={"FAKE_SLOW_S": "5"})
    try:
        c.start()
        with pytest.raises(McpError, match="[Tt]imed? ?out"):
            c.call_tool("slow", {}, timeout=0.5)
    finally:
        c.stop()


def test_failed_start_does_not_leak_child():
    c = McpStdioClient([sys.executable, FAKE_SERVER], env={"FAKE_HANG_INIT": "10"})
    with pytest.raises(McpError, match="[Tt]imed? ?out"):
        c.start(timeout=0.5)
    assert not c.alive
    # the spawned process must be reaped, not orphaned
    assert c._proc is None


def test_stop_terminates_child(client):
    client.start()
    pid = client.pid
    client.stop()
    assert not client.alive
    # process must actually be gone
    with pytest.raises(OSError):
        os.kill(pid, 0)


def test_stop_is_idempotent_and_start_lazy():
    c = McpStdioClient([sys.executable, FAKE_SERVER])
    assert not c.alive
    c.stop()  # never started — must not raise
    assert not c.alive
