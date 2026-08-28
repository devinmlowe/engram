"""Phase 3 tests: dashboard config schema + `hermes engram` CLI commands."""

import argparse
import importlib.util
import json
import os
import sys

import pytest

PLUGIN_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
HERMES_AGENT_DIR = os.environ.get(
    "HERMES_AGENT_DIR", os.path.expanduser("~/.hermes/hermes-agent")
)
FAKE_SERVER = os.path.join(os.path.dirname(__file__), "fake_mcp_server.py")

sys.path.insert(0, PLUGIN_DIR)


def load_by_path(name, filename):
    spec = importlib.util.spec_from_file_location(name, os.path.join(PLUGIN_DIR, filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def hermes_path():
    sys.path.insert(0, HERMES_AGENT_DIR)
    yield
    sys.path.remove(HERMES_AGENT_DIR)


def test_config_schema_matches_hermes_dashboard_contract(hermes_path):
    module = load_by_path("_engram_cfg_schema", "config_schema.py")
    schema = module.CONFIG_SCHEMA
    assert schema.name == "engram"
    keys = [f.key for f in schema.fields]
    for expected in ("repo_path", "budget", "idle_kill_s"):
        assert expected in keys


def test_cli_registers_subcommands():
    cli = load_by_path("_engram_cli", "cli.py")
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="engram_cmd")
    cli.register_cli(sub)
    args = parser.parse_args(["status"])
    assert args.engram_cmd == "status"
    args = parser.parse_args(["recall", "tailscale", "--budget", "500"])
    assert args.engram_cmd == "recall"
    assert args.query == "tailscale"
    assert args.budget == 500


def test_cli_status_reports_available(tmp_path, capsys, monkeypatch):
    home = tmp_path / "home"
    home.mkdir()
    (home / "engram.json").write_text(
        json.dumps({"server_command": [sys.executable, FAKE_SERVER]})
    )
    monkeypatch.setenv("HERMES_HOME", str(home))
    cli = load_by_path("_engram_cli2", "cli.py")
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="engram_cmd")
    cli.register_cli(sub)
    rc = cli.engram_command(parser.parse_args(["status"]))
    assert rc == 0
    assert "available" in capsys.readouterr().out.lower()


def test_cli_recall_prints_results(tmp_path, capsys, monkeypatch):
    home = tmp_path / "home"
    home.mkdir()
    (home / "engram.json").write_text(
        json.dumps({"server_command": [sys.executable, FAKE_SERVER]})
    )
    monkeypatch.setenv("HERMES_HOME", str(home))
    cli = load_by_path("_engram_cli3", "cli.py")
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="engram_cmd")
    cli.register_cli(sub)
    rc = cli.engram_command(parser.parse_args(["recall", "kubernetes"]))
    assert rc == 0
    out = capsys.readouterr().out
    assert "kubernetes" in out
