"""EngramMemoryProvider — Hermes memory provider backed by engram (ADR-010).

Architecture (see decisions/hermes-memory-provider-integration.md):
- Spawns engram's MCP server as a persistent stdio child, lazily, and only for
  primary agent contexts (cron/subagent/flush never pay the ~300MB Node cost).
- Reads recall from the shared knowledge graph (scopes: global + own profile).
- Writes are curated only: explicit engram_remember tool calls and mirrors of
  Hermes's built-in MEMORY.md writes (on_memory_write). Raw turns are never
  dumped into the graph; nightly dream consolidation handles distillation.
- The child is scoped via env (ENGRAM_SCOPE / ENGRAM_READ_SCOPES) so no tool
  argument can write outside this profile's scope.
"""

from __future__ import annotations

import json
import os
import shutil
import threading
import time
from typing import Any, Dict, List, Optional

from mcp_client import McpStdioClient, McpError

DEFAULT_REPO_PATH = os.path.expanduser("~/git/engram")
DEFAULT_PREFETCH_BUDGET = 1200
DEFAULT_IDLE_KILL_S = 600.0
PREFETCH_TIMEOUT_S = 6.0  # under Hermes's 8s external-prefetch ceiling

_HERMES_ABC_CACHE: Optional[type] = None


def load_hermes_memory_provider_abc() -> type:
    """Return Hermes's MemoryProvider ABC.

    Under the Hermes runtime `agent.memory_provider` is importable directly.
    Outside it (tests, tooling) we load the module by file path from
    HERMES_AGENT_DIR (default ~/.hermes/hermes-agent).
    """
    global _HERMES_ABC_CACHE
    if _HERMES_ABC_CACHE is not None:
        return _HERMES_ABC_CACHE
    try:
        from agent.memory_provider import MemoryProvider  # type: ignore
    except ImportError:
        import importlib.util

        agent_dir = os.environ.get(
            "HERMES_AGENT_DIR", os.path.expanduser("~/.hermes/hermes-agent")
        )
        path = os.path.join(agent_dir, "agent", "memory_provider.py")
        spec = importlib.util.spec_from_file_location("_hermes_memory_provider", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)  # type: ignore[union-attr]
        MemoryProvider = module.MemoryProvider
    _HERMES_ABC_CACHE = MemoryProvider
    return MemoryProvider


MemoryProviderBase = load_hermes_memory_provider_abc()

_TOOL_MAP = {
    "engram_recall": "recall",
    "engram_explore": "explore",
    "engram_reflect": "reflect",
    "engram_remember": "remember",
}

_TOOL_SCHEMAS: List[Dict[str, Any]] = [
    {
        "name": "engram_recall",
        "description": (
            "Search Devin's long-term knowledge graph (engram) — hybrid vector"
            " + full-text + graph recall over months of project, infrastructure,"
            " and preference knowledge. Use for anything that predates this"
            " conversation."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "What to recall"},
                "budget": {
                    "type": "integer",
                    "description": "Max tokens of results (100-5000)",
                },
                "sources": {
                    "type": "array",
                    "items": {"type": "string", "enum": ["episodic", "semantic", "graph"]},
                },
            },
            "required": ["query"],
        },
    },
    {
        "name": "engram_explore",
        "description": "Traverse the knowledge graph outward from an entity (project, tool, person, concept).",
        "parameters": {
            "type": "object",
            "properties": {
                "entity": {"type": "string"},
                "depth": {"type": "integer", "description": "1-3"},
            },
            "required": ["entity"],
        },
    },
    {
        "name": "engram_reflect",
        "description": "Graph-level analysis: communities, bridges, temporal patterns, health.",
        "parameters": {
            "type": "object",
            "properties": {
                "mode": {
                    "type": "string",
                    "enum": ["communities", "bridges", "temporal", "health", "all"],
                }
            },
        },
    },
    {
        "name": "engram_remember",
        "description": (
            "Store a durable fact/decision/preference into the knowledge graph,"
            " scoped to this profile. Use for things worth recalling across"
            " sessions; near-duplicates are merged automatically."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "content": {"type": "string"},
                "type": {
                    "type": "string",
                    "enum": ["preference", "decision", "pattern", "fact", "solution", "convention"],
                },
                "importance": {"type": "number"},
            },
            "required": ["content"],
        },
    },
]


class EngramMemoryProvider(MemoryProviderBase):  # type: ignore[misc,valid-type]
    def __init__(self) -> None:
        self._config: Dict[str, Any] = {}
        self._hermes_home: str = ""
        self._identity: str = "default"
        self._enabled: bool = False
        self._client: Optional[McpStdioClient] = None
        self._client_lock = threading.Lock()
        self._last_used: float = 0.0
        self._write_q: List[Dict[str, Any]] = []
        self._write_lock = threading.Lock()
        self._write_thread: Optional[threading.Thread] = None
        self._stopping = False
        # Hermes never polls providers for idle work, so the idle-kill must be
        # driven by our own timer thread (started with the first spawn)
        self._reaper: Optional[threading.Thread] = None
        self._reaper_stop = threading.Event()

    # ── identity / availability ──────────────────────────────────

    @property
    def name(self) -> str:
        return "engram"

    def is_available(self) -> bool:
        if self._config.get("server_command"):
            return True
        repo = self._config.get("repo_path", DEFAULT_REPO_PATH)
        server_js = os.path.join(repo, "dist", "interfaces", "mcp", "server.js")
        node = self._config.get("node_path") or shutil.which("node")
        return bool(node) and os.path.isfile(server_js)

    # ── lifecycle ────────────────────────────────────────────────

    def initialize(self, session_id: str, **kwargs: Any) -> None:
        self._hermes_home = kwargs.get("hermes_home", "") or ""
        self._identity = kwargs.get("agent_identity") or "default"
        context = kwargs.get("agent_context") or "primary"
        self._enabled = context == "primary"
        self._stopping = False
        self._config = self._load_config()

    def _config_paths(self) -> List[str]:
        """CLI store (`hermes memory setup` → engram.json) then the dashboard's
        flat_json store (<home>/engram/config.json); later files win."""
        if not self._hermes_home:
            return []
        return [
            os.path.join(self._hermes_home, "engram.json"),
            os.path.join(self._hermes_home, "engram", "config.json"),
        ]

    def _load_config(self) -> Dict[str, Any]:
        config: Dict[str, Any] = dict(self._config)
        for path in self._config_paths():
            if not os.path.isfile(path):
                continue
            try:
                with open(path) as fh:
                    loaded = json.load(fh)
            except (OSError, json.JSONDecodeError):
                continue
            if isinstance(loaded, dict):
                config.update(loaded)
        return config

    def shutdown(self) -> None:
        # Flush first (it may legitimately spawn to deliver queued mirrors),
        # then close the door so a still-running drain can't respawn
        self.flush_writes(timeout=5.0)
        self._stopping = True
        self._reaper_stop.set()
        with self._client_lock:
            if self._client is not None:
                self._client.stop()
                self._client = None
        reaper = self._reaper
        if reaper is not None and reaper.is_alive():
            reaper.join(timeout=1.0)

    # ── child management ─────────────────────────────────────────

    @property
    def child_pid(self) -> Optional[int]:
        client = self._client
        return client.pid if client is not None and client.alive else None

    def _write_scope(self) -> str:
        return f"hermes:{self._identity}"

    def _child_env(self) -> Dict[str, str]:
        env: Dict[str, str] = {
            "ENGRAM_SCOPE": self._write_scope(),
            "ENGRAM_READ_SCOPES": self._config.get(
                "read_scopes", f"global,{self._write_scope()}"
            ),
        }
        if self._config.get("db_path"):
            env["ENGRAM_DB_PATH"] = self._config["db_path"]
        env.update(self._config.get("extra_env", {}))
        return env

    def _server_command(self) -> List[str]:
        if self._config.get("server_command"):
            return list(self._config["server_command"])
        repo = self._config.get("repo_path", DEFAULT_REPO_PATH)
        node = self._config.get("node_path") or shutil.which("node") or "node"
        return [node, os.path.join(repo, "dist", "interfaces", "mcp", "server.js")]

    def _ensure_client(self) -> McpStdioClient:
        if not self._enabled:
            raise McpError("engram provider disabled for this agent context")
        if self._stopping:
            raise McpError("engram provider is shutting down")
        with self._client_lock:
            if self._client is None or not self._client.alive:
                client = McpStdioClient(
                    self._server_command(),
                    env=self._child_env(),
                    cwd=self._config.get("repo_path", DEFAULT_REPO_PATH),
                )
                client.start()
                self._client = client
                self._start_reaper()
            self._last_used = time.monotonic()
            return self._client

    def _start_reaper(self) -> None:
        if self._reaper is not None and self._reaper.is_alive():
            return
        self._reaper_stop.clear()
        self._reaper = threading.Thread(target=self._reaper_loop, daemon=True)
        self._reaper.start()

    def _reaper_loop(self) -> None:
        idle_kill_s = float(self._config.get("idle_kill_s", DEFAULT_IDLE_KILL_S))
        period = max(0.25, idle_kill_s / 2.0)
        while not self._reaper_stop.wait(period):
            self.reap_if_idle()
            with self._client_lock:
                if self._client is None:
                    return  # nothing to watch; the next spawn restarts us

    def reap_if_idle(self) -> None:
        """Kill the child when it has been idle past idle_kill_s (RSS control)."""
        idle_kill_s = float(self._config.get("idle_kill_s", DEFAULT_IDLE_KILL_S))
        with self._client_lock:
            if (
                self._client is not None
                and self._client.alive
                and time.monotonic() - self._last_used > idle_kill_s
            ):
                self._client.stop()
                self._client = None

    # ── recall ───────────────────────────────────────────────────

    def prefetch(self, query: str, *, session_id: str = "") -> str:
        if not self._enabled or not query.strip():
            return ""
        try:
            client = self._ensure_client()
            args: Dict[str, Any] = {
                "query": query,
                "budget": int(self._config.get("budget", DEFAULT_PREFETCH_BUDGET)),
            }
            if self._config.get("sources"):
                args["sources"] = self._config["sources"]
            text = client.call_tool("recall", args, timeout=PREFETCH_TIMEOUT_S)
            self._last_used = time.monotonic()
            return text
        except Exception:
            return ""

    # ── explicit tools ───────────────────────────────────────────

    def get_tool_schemas(self) -> List[Dict[str, Any]]:
        return [dict(s) for s in _TOOL_SCHEMAS]

    def handle_tool_call(self, tool_name: str, args: Dict[str, Any], **kwargs: Any) -> str:
        target = _TOOL_MAP.get(tool_name)
        if target is None:
            return json.dumps({"ok": False, "error": f"unknown engram tool: {tool_name}"})
        try:
            client = self._ensure_client()
            result = client.call_tool(target, args)
            self._last_used = time.monotonic()
            return json.dumps({"ok": True, "result": result})
        except Exception as exc:
            return json.dumps({"ok": False, "error": str(exc)})

    # ── curated write mirror ─────────────────────────────────────

    def on_memory_write(
        self,
        action: str,
        target: str,
        content: str,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> None:
        """Mirror Hermes built-in memory saves into the graph (adds only)."""
        if not self._enabled or action not in ("add", "replace") or not content.strip():
            return
        with self._write_lock:
            self._write_q.append(
                {
                    "content": content,
                    "type": "preference" if target == "user" else "fact",
                }
            )
        self._kick_writer()

    def _kick_writer(self) -> None:
        if self._stopping:
            return
        if self._write_thread is not None and self._write_thread.is_alive():
            return
        self._write_thread = threading.Thread(target=self._drain_writes, daemon=True)
        self._write_thread.start()

    def _drain_writes(self) -> None:
        while True:
            with self._write_lock:
                if not self._write_q:
                    return
                item = self._write_q.pop(0)
            try:
                client = self._ensure_client()
                client.call_tool("remember", item)
                self._last_used = time.monotonic()
            except Exception:
                return  # drop on failure; built-in MEMORY.md still has it

    def flush_writes(self, timeout: float = 10.0) -> None:
        """Block until queued writes are drained (bounded)."""
        thread = self._write_thread
        if thread is not None and thread.is_alive():
            thread.join(timeout=timeout)
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            with self._write_lock:
                if not self._write_q:
                    return
            self._kick_writer()
            time.sleep(0.05)

    # ── config surface ───────────────────────────────────────────

    def get_config_schema(self) -> List[Dict[str, Any]]:
        return [
            {"key": "repo_path", "description": "engram repo root", "default": DEFAULT_REPO_PATH},
            {"key": "node_path", "description": "node binary (blank = PATH lookup)", "required": False},
            {"key": "db_path", "description": "engram DB override (blank = engram default)", "required": False},
            {"key": "budget", "description": "prefetch token budget", "type": "integer", "default": DEFAULT_PREFETCH_BUDGET},
            {"key": "read_scopes", "description": "comma-separated recall scopes", "required": False},
            {"key": "idle_kill_s", "description": "idle seconds before the Node child is reaped", "type": "integer", "default": int(DEFAULT_IDLE_KILL_S)},
        ]

    def save_config(self, values: Dict[str, Any], hermes_home: str) -> None:
        path = os.path.join(hermes_home, "engram.json")
        existing: Dict[str, Any] = {}
        if os.path.isfile(path):
            try:
                with open(path) as fh:
                    existing = json.load(fh)
            except (OSError, json.JSONDecodeError):
                existing = {}
        existing.update(values)
        tmp = path + ".tmp"
        with open(tmp, "w") as fh:
            json.dump(existing, fh, indent=2)
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)

    # ── misc contract surface ────────────────────────────────────

    def system_prompt_block(self) -> str:
        if not self._enabled:
            return ""
        return (
            "Long-term memory: the engram knowledge graph is available via "
            "engram_recall / engram_explore / engram_reflect, and engram_remember "
            "stores durable facts scoped to this profile."
        )

    def backup_paths(self) -> List[str]:
        # Deliberately empty (ADR-010): the engram DB is shared infrastructure
        # with its own backup lifecycle; folding a multi-hundred-MB graph into
        # every profile's `hermes backup` would be worse than excluding it.
        # The plugin's own config (engram.json) lives inside HERMES_HOME and is
        # captured automatically.
        return []
