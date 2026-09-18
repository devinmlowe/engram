"""Packaging tests: the plugin must satisfy Hermes's discovery + registration
contract (plugins/memory/__init__.py) without importing Hermes internals, and
``register()`` must pick the transport named in engram.json."""

import importlib.util
import json
import os

import yaml

PLUGIN_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))


class FakeCtx:
    def __init__(self):
        self.registered = []

    def register_memory_provider(self, instance):
        self.registered.append(instance)

    def register_tool(self, *a, **k):
        pass

    def register_hook(self, *a, **k):
        pass

    def register_cli_command(self, *a, **k):
        pass


def load_plugin_module(name="_engram_plugin_test"):
    spec = importlib.util.spec_from_file_location(
        name, os.path.join(PLUGIN_DIR, "__init__.py")
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_init_passes_hermes_dir_scan_heuristic():
    # Hermes user-plugin discovery reads the first 8192 bytes of __init__.py
    # looking for 'register_memory_provider' or 'MemoryProvider'.
    with open(os.path.join(PLUGIN_DIR, "__init__.py")) as fh:
        head = fh.read(8192)
    assert "register_memory_provider" in head


def test_plugin_yaml_declares_identity():
    with open(os.path.join(PLUGIN_DIR, "plugin.yaml")) as fh:
        meta = yaml.safe_load(fh)
    assert meta["name"] == "engram"
    assert meta["version"]
    assert "knowledge graph" in meta["description"].lower()


def test_register_entry_point_registers_provider_instance(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    module = load_plugin_module()
    ctx = FakeCtx()
    module.register(ctx)
    assert len(ctx.registered) == 1
    assert ctx.registered[0].name == "engram"


def test_register_defaults_to_http_transport(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    module = load_plugin_module("_engram_plugin_http")
    ctx = FakeCtx()
    module.register(ctx)
    provider = ctx.registered[0]
    assert isinstance(provider, module.EngramMemoryProvider)
    assert [s["name"] for s in provider.get_tool_schemas()] == ["engram_memory_save", "engram_memory_forget"]


def test_register_selects_stdio_transport_from_config(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    (tmp_path / "engram.json").write_text(json.dumps({"transport": "stdio"}))
    module = load_plugin_module("_engram_plugin_stdio")
    ctx = FakeCtx()
    module.register(ctx)
    provider = ctx.registered[0]
    assert provider.name == "engram"
    assert not isinstance(provider, module.EngramMemoryProvider)
    assert type(provider).__module__ == "provider"
    assert {s["name"] for s in provider.get_tool_schemas()} >= {"engram_recall", "engram_remember", "engram_forget"}


def test_unknown_transport_falls_back_to_http(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    (tmp_path / "engram.json").write_text(json.dumps({"transport": "carrier-pigeon"}))
    module = load_plugin_module("_engram_plugin_fallback")
    assert module.selected_transport() == module.TRANSPORT_HTTP
    assert isinstance(module.make_provider(), module.EngramMemoryProvider)


def test_src_docs_exist():
    for doc in ("SPEC.md", "README.md"):
        path = os.path.join(PLUGIN_DIR, doc)
        assert os.path.isfile(path), f"{doc} missing"
        assert os.path.getsize(path) > 200
