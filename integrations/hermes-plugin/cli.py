"""`hermes engram` CLI subcommands (registered only while engram is the
active memory provider, per Hermes's discover_plugin_cli_commands contract)."""

import json
import os
import sys

_here = os.path.dirname(os.path.abspath(__file__))
if _here not in sys.path:
    sys.path.insert(0, _here)


def register_cli(subparser):
    """Build the ``hermes engram`` subcommand tree.

    Hermes passes the ``hermes engram`` ArgumentParser itself (see
    hermes_cli/main.py plugin CLI wiring); we attach our own subparsers.
    """
    commands = subparser.add_subparsers(dest="engram_cmd")

    commands.add_parser("status", help="Show engram provider status")

    recall = commands.add_parser("recall", help="Query the knowledge graph")
    recall.add_argument("query", help="What to recall")
    recall.add_argument("--budget", type=int, default=1200, help="Token budget")


def _make_provider():
    from provider import EngramMemoryProvider

    hermes_home = os.environ.get("HERMES_HOME", os.path.expanduser("~/.hermes"))
    provider = EngramMemoryProvider()
    provider.initialize(
        "cli", hermes_home=hermes_home, platform="cli",
        agent_context="primary",
        agent_identity=os.environ.get("HERMES_PROFILE", "default"),
    )
    return provider


def engram_command(args) -> int:
    cmd = getattr(args, "engram_cmd", None)

    if cmd == "status":
        provider = _make_provider()
        available = provider.is_available()
        print(f"engram provider: {'available' if available else 'NOT available'}")
        print(f"  write scope: {provider._write_scope()}")
        print(f"  config: {json.dumps(provider._config, default=str)}")
        return 0 if available else 1

    if cmd == "recall":
        provider = _make_provider()
        try:
            # Go through the client directly: prefetch() swallows errors and
            # ignores --budget by design (it serves Hermes's turn path)
            client = provider._ensure_client()
            call: dict = {"query": args.query, "budget": int(args.budget)}
            if provider._config.get("sources"):
                call["sources"] = provider._config["sources"]
            text = client.call_tool("recall", call, timeout=60.0)
            print(text if text else "(no results)")
            return 0
        except Exception as exc:
            print(f"engram recall failed: {exc}", file=sys.stderr)
            return 1
        finally:
            provider.shutdown()

    print("usage: hermes engram {status|recall}", file=sys.stderr)
    return 2
