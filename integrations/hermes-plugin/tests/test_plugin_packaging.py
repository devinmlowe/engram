"""Packaging tests: the plugin must satisfy Hermes's discovery + registration
contract (plugins/memory/__init__.py) without importing Hermes internals."""

import importlib.util
import os

import yaml

PLUGIN_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))


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


def test_register_entry_point_registers_provider_instance():
    spec = importlib.util.spec_from_file_location(
        "_engram_plugin_test", os.path.join(PLUGIN_DIR, "__init__.py")
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    registered = []

    class FakeCtx:
        def register_memory_provider(self, instance):
            registered.append(instance)

        def register_tool(self, *a, **k):
            pass

        def register_hook(self, *a, **k):
            pass

        def register_cli_command(self, *a, **k):
            pass

    module.register(FakeCtx())
    assert len(registered) == 1
    assert registered[0].name == "engram"


def test_src_docs_exist():
    for doc in ("SPEC.md", "README.md"):
        path = os.path.join(PLUGIN_DIR, doc)
        assert os.path.isfile(path), f"{doc} missing"
        assert os.path.getsize(path) > 200
