"""Hermes memory-provider plugin for engram (ADR-010).

Installed by symlinking this directory to $HERMES_HOME/plugins/engram and
setting `memory.provider: engram` in the profile's config.yaml. Hermes
discovers it via the register_memory_provider entry point below.
"""

import os
import sys

_here = os.path.dirname(os.path.abspath(__file__))
if _here not in sys.path:
    sys.path.insert(0, _here)

from provider import EngramMemoryProvider  # noqa: E402


def register(ctx):
    """Hermes plugin entry point: ctx.register_memory_provider(instance)."""
    ctx.register_memory_provider(EngramMemoryProvider())
