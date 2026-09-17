"""W0: the file-path fallback in ``load_hermes_memory_provider_abc`` must
register the module in ``sys.modules`` before executing it. Hermes 0.21.x's
``memory_provider.py`` defines ``@dataclass`` classes, and dataclass resolution
looks the defining module up by name; an unregistered module yields
``AttributeError: 'NoneType' object has no attribute '__dict__'`` on Python 3.14.

The fallback only runs when ``agent`` is NOT importable, so this test drives a
child interpreter with PYTHONPATH stripped.
"""

import os
import subprocess
import sys

import pytest

PLUGIN_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
HERMES_AGENT_DIR = os.environ.get(
    "HERMES_AGENT_DIR", os.path.expanduser("~/.hermes/hermes-agent")
)

pytestmark = pytest.mark.skipif(
    not os.path.exists(os.path.join(HERMES_AGENT_DIR, "agent", "memory_provider.py")),
    reason="Hermes agent checkout not present",
)


def test_fallback_loader_registers_module_before_exec():
    env = {k: v for k, v in os.environ.items() if k not in ("PYTHONPATH", "PYTHONHOME")}
    env["HERMES_AGENT_DIR"] = HERMES_AGENT_DIR
    code = (
        "import sys; sys.path.insert(0, %r); "
        "import provider; "
        "assert '_hermes_memory_provider' in sys.modules, 'module not registered'; "
        "print(provider.MemoryProviderBase.__name__)"
    ) % PLUGIN_DIR
    proc = subprocess.run(
        [sys.executable, "-c", code], env=env, capture_output=True, text=True, timeout=60
    )
    assert proc.returncode == 0, proc.stderr
    assert proc.stdout.strip() == "MemoryProvider"


def test_fallback_loader_expands_literal_tilde_in_hermes_agent_dir(tmp_path):
    """#33: HERMES_AGENT_DIR="~/..." (fish does not expand `~` inside
    `VAR=~/...`) must expand against $HOME, not resolve relative to cwd."""
    fake_home = tmp_path / "home"
    fake_home.mkdir()
    (fake_home / "hermes-agent").symlink_to(HERMES_AGENT_DIR, target_is_directory=True)
    cwd = tmp_path / "cwd"
    cwd.mkdir()

    env = {k: v for k, v in os.environ.items() if k not in ("PYTHONPATH", "PYTHONHOME")}
    env["HOME"] = str(fake_home)
    env["HERMES_AGENT_DIR"] = "~/hermes-agent"
    code = (
        "import sys; sys.path.insert(0, %r); "
        "import provider; "
        "print(provider.MemoryProviderBase.__name__)"
    ) % PLUGIN_DIR
    proc = subprocess.run(
        [sys.executable, "-c", code], env=env, cwd=str(cwd),
        capture_output=True, text=True, timeout=60,
    )
    assert proc.returncode == 0, proc.stderr
    assert proc.stdout.strip() == "MemoryProvider"
    assert not any(name.startswith("~") for name in os.listdir(cwd))
