"""Engram memory plugin — MemoryProvider wrapping the engram HTTP MCP server.

Entry point: ``register(ctx)`` calls ``ctx.register_memory_provider(...)``
with the provider for the configured transport (see ``transport`` below).

Engram (https://github.com/devinmlowe/engram) is a cognitive memory system
that ingests LLM conversation history and consolidates it into structured
knowledge. It exposes a streamable-HTTP MCP server (LaunchAgent
``ai.hermes.engram-mcp``, default ``http://127.0.0.1:9907/mcp``).

Two transports live in this directory and share ``$HERMES_HOME/engram.json``:

* ``http`` (default, this module) — talks to the already-running engram HTTP
  MCP server. Thin, stateless, one save tool.
* ``stdio`` (``provider.py`` + ``mcp_client.py``) — spawns engram's MCP
  server as a lazy stdio child per primary agent context, with per-profile
  scoped writes, ``engram_*`` recall/explore/reflect/remember tools, and a
  ``hermes engram`` CLI (``cli.py``) plus dashboard schema
  (``config_schema.py``). Select it with ``"transport": "stdio"``.

This provider is deliberately thin: recall is automatic (``prefetch`` calls
the ``recall`` MCP tool with the user's message) and the model gets exactly
one tool, ``engram_memory_save``, which proxies to the ``remember`` MCP
tool.

Turn ingestion (``sync_turn``): each completed user/assistant turn is
enqueued (bounded, drop-oldest) and posted by ONE lazily-started daemon
thread to the ``ingest_turn`` MCP tool under ``scope = "hermes:<profile>"``,
so engram's dream pipeline extracts from Hermes conversations and the
memories inherit the profile scope. The caller thread never touches the
network. ``turn_index`` is a per-session in-memory counter seeded at 0 on
process start; the server upserts on (session_id, turn_index), so a restart
re-ingesting index 0.. of a resumed session updates rows in place rather
than duplicating them. ``turn_author`` rides along as ``author``. While the
circuit breaker is open the drain thread parks (queued items stay put and
post once the cooldown lapses) rather than dropping them; only overflow of
the bounded queue loses turns, and that count is reported by
``unavailable_reason()``. ``on_session_end`` remains a no-op.

Built-in memory mirror (``on_memory_write``): ``add``/``replace`` of the
Hermes MEMORY.md / USER.md memory tool are mirrored as ``remember`` under
the same profile scope (``memory`` -> fact, ``user`` -> preference,
``source = "hermes-mirror"``, ``context`` naming the action, modest
importance). ``replace`` sends only the NEW
text; engram's ``remember`` dedups/merges against existing memories, so the
old wording is superseded there rather than deleted here. ``remove`` is a
no-op. Writes ride the same bounded queue/drain thread as turns.

Agent-context gating: Hermes passes ``agent_context`` (primary | subagent |
cron | flush) to ``initialize``. Like the stdio transport, WRITES
(``sync_turn``, ``on_memory_write``) run only for ``primary``; ``prefetch``
runs for the contexts in ``prefetch_contexts`` (default ``["primary"]``, so
a user can opt cron in). An absent/empty context counts as primary. The
explicit ``engram_memory_save`` tool keeps working in every context: a cron
job deciding to store a fact is a deliberate, cheap, one-off write, unlike
per-turn ingestion, and refusing it would silently lose the fact.

Availability: ``is_available`` is config-only per the MemoryProvider
contract (engram.json parses, ``base_url`` is an http(s) URL) — never the
network. The ``GET /health`` probe runs once in ``initialize`` and only
feeds ``unavailable_reason()``; a later successful call clears it.

The MCP server may ALSO be wired as ``mcp_servers.engram`` in config.yaml.
That path is untouched by this plugin; the tool name here is chosen so it
cannot collide with the ``engram``-prefixed MCP tools.

Configuration (non-secret, lives in ``$HERMES_HOME/engram.json``, written by
``hermes memory setup engram``)::

  transport              — "http" (default) or "stdio"
  base_url               — MCP server base URL   (default http://127.0.0.1:9907)
  timeout_secs           — HTTP timeout for health + prefetch (default 4; cold recall on a
                           ~17K-memory store measured ~2 s, warm 0.7–1.1 s; Hermes caps
                           external prefetch at 8 s)
  prefetch_token_budget  — recall token budget per turn (default 300)
  sync_turns             — post each turn to ingest_turn (default true)
  mirror_memory_writes   — mirror MEMORY.md/USER.md adds+replaces to remember (default true)
  prefetch_contexts      — agent contexts that get per-turn recall (default ["primary"])

The stdio transport reads its own keys from the same file (``repo_path``,
``node_path``, ``db_path``, ``budget``, ``read_scopes``, ``idle_kill_s``);
see ``provider.py``. There are no secrets.
"""

from __future__ import annotations

import json
import logging
import os
import queue
import re
import sys
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from agent.memory_provider import MemoryProvider, RecallStatus, spawn_context_thread
from tools.registry import tool_error

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

PROVIDER_NAME = "engram"
CONFIG_FILENAME = "engram.json"
DB_PATH = "~/.local/share/engram/engram.db"

TRANSPORT_HTTP = "http"
TRANSPORT_STDIO = "stdio"
TRANSPORTS = (TRANSPORT_HTTP, TRANSPORT_STDIO)
DEFAULT_TRANSPORT = TRANSPORT_HTTP

DEFAULT_BASE_URL = "http://127.0.0.1:9907"
DEFAULT_TIMEOUT_SECS = 4.0
DEFAULT_PREFETCH_TOKEN_BUDGET = 300
DEFAULT_SYNC_TURNS = True
DEFAULT_MIRROR_MEMORY_WRITES = True
PRIMARY_CONTEXT = "primary"
AGENT_CONTEXTS = ("primary", "subagent", "cron", "flush")
DEFAULT_PREFETCH_CONTEXTS = [PRIMARY_CONTEXT]

# sync_turn: bounded in-memory queue (drop-oldest) drained by one thread.
_SYNC_QUEUE_MAX = 16
_SYNC_DRAIN_POLL_SECS = 0.25
# shutdown() waits at most this long for queued turns to post before closing.
_SHUTDOWN_DRAIN_SECS = 2.0
# prefetch timeouts are logged at WARNING at most once per this interval
# (each miss is still visible in recall_status()).
_TIMEOUT_WARN_INTERVAL_SECS = 600.0
# initialize(): one best-effort recall so the daemon's embedder/reranker are
# hot before the first real turn. Reinforcement off — it must not touch FSRS.
_WARMUP_RECALL_ARGS = {"query": "session warm-up", "limit": 1, "budget": 100, "reinforce": False}
# Tests flip this off so call sequences after initialize() stay deterministic.
_WARMUP_ENABLED = True
# Tool input/output embedded in an ingest_turn payload are clipped client-side
# (the server clips to 1000 chars anyway; this keeps the POST small).
_TOOL_IO_MAX_CHARS = 1000
TURN_SOURCE = "hermes"

# on_memory_write mirror: engram ``remember`` source label + importance.
_MIRROR_SOURCE = "hermes-mirror"
_MIRROR_IMPORTANCE = 0.6
_MIRROR_TYPE_BY_TARGET = {"memory": "fact", "user": "preference"}
_MIRRORED_ACTIONS = ("add", "replace")

# Queue item kinds -> MCP tool.
_KIND_TURN = "turn"
_KIND_WRITE = "write"
_TOOL_BY_KIND = {_KIND_TURN: "ingest_turn", _KIND_WRITE: "remember"}

# The engram ``recall`` schema bounds ``budget`` to [100, 5000].
_RECALL_BUDGET_MIN = 100
_RECALL_BUDGET_MAX = 5000

# ``remember`` is a write and may embed; give it more room than the hot path.
_TOOL_CALL_TIMEOUT_SECS = 30.0
# The initialize handshake is cheap; bound it independently of prefetch.
_HANDSHAKE_TIMEOUT_SECS = 5.0

MCP_PROTOCOL_VERSION = "2025-03-26"

# Circuit breaker: after this many consecutive failures, pause calls for
# _BREAKER_COOLDOWN_SECS so a down server doesn't add latency to every turn.
_BREAKER_THRESHOLD = 5
_BREAKER_COOLDOWN_SECS = 120

MEMORY_TYPES = ("fact", "preference", "decision", "pattern", "solution", "convention")

SAVE_TOOL_NAME = "engram_memory_save"

_TOTAL_RESULTS_RE = re.compile(r'total_results="(\d+)"')

# STATIC by contract: must be byte-identical for the life of a conversation.
# No timestamps, counts, URLs, or config values may appear here.
_SYSTEM_PROMPT_BLOCK = (
    "# Engram Memory\n"
    "Active. Relevant memories from past conversations and consolidated "
    "knowledge are recalled automatically and injected as context before "
    "each turn — you do not need to search for them.\n"
    "When the user states a lasting preference, decision, convention, or "
    "fact worth keeping, store it with engram_memory_save (verbatim, one "
    "fact per call). Skip transient chit-chat and things already stored."
)

SAVE_SCHEMA: Dict[str, Any] = {
    "name": SAVE_TOOL_NAME,
    "description": (
        "Store a durable memory in engram (verbatim, no extraction). Call it "
        "the moment the user states a lasting preference, decision, "
        "convention, solution, or fact worth recalling in future sessions. "
        "Skip transient chit-chat and facts already stored."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "content": {
                "type": "string",
                "description": "The fact, preference, or knowledge to remember.",
            },
            "type": {
                "type": "string",
                "enum": list(MEMORY_TYPES),
                "description": "Kind of memory (default: fact).",
            },
            "importance": {
                "type": "number",
                "minimum": 0,
                "maximum": 1,
                "description": "Importance score 0-1 (default: 0.7).",
            },
        },
        "required": ["content"],
    },
}


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

def _config_path(hermes_home: Optional[str] = None) -> Path:
    if hermes_home:
        return Path(hermes_home).expanduser() / CONFIG_FILENAME
    from hermes_constants import get_hermes_home
    return get_hermes_home() / CONFIG_FILENAME


def _coerce_float(value: Any, default: float, minimum: float) -> float:
    try:
        out = float(value)
    except (TypeError, ValueError):
        return default
    return out if out >= minimum else default


def _coerce_int(value: Any, default: int, minimum: int, maximum: int) -> int:
    try:
        out = int(value)
    except (TypeError, ValueError):
        return default
    return max(minimum, min(out, maximum))


def _coerce_bool(value: Any, default: bool) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        v = value.strip().lower()
        if v in ("1", "true", "yes", "on"):
            return True
        if v in ("0", "false", "no", "off"):
            return False
    return default


def _coerce_contexts(value: Any, default: List[str]) -> List[str]:
    """Accept a JSON list or a comma-separated string of agent contexts; junk -> default."""
    if isinstance(value, str):
        value = value.split(",")
    if not isinstance(value, (list, tuple)):
        return list(default)
    out: List[str] = []
    for item in value:
        name = str(item or "").strip().lower()
        if name in AGENT_CONTEXTS and name not in out:
            out.append(name)
    return out or list(default)


def _read_config_file(hermes_home: Optional[str] = None):
    """-> (dict | None, error). ``None`` dict with "" error means no file."""
    try:
        path = _config_path(hermes_home)
        if not path.exists():
            return None, ""
        file_cfg = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        return None, f"{CONFIG_FILENAME} could not be read: {exc}"
    if not isinstance(file_cfg, dict):
        return None, f"{CONFIG_FILENAME} must contain a JSON object"
    return file_cfg, ""


def _load_config(hermes_home: Optional[str] = None) -> Dict[str, Any]:
    """Documented defaults, overridden by non-empty keys in engram.json."""
    config: Dict[str, Any] = {
        "base_url": DEFAULT_BASE_URL,
        "timeout_secs": DEFAULT_TIMEOUT_SECS,
        "prefetch_token_budget": DEFAULT_PREFETCH_TOKEN_BUDGET,
        "sync_turns": DEFAULT_SYNC_TURNS,
        "mirror_memory_writes": DEFAULT_MIRROR_MEMORY_WRITES,
        "prefetch_contexts": list(DEFAULT_PREFETCH_CONTEXTS),
    }
    file_cfg, err = _read_config_file(hermes_home)
    if err:
        logger.debug("engram: %s", err)
    if file_cfg:
        config.update({k: v for k, v in file_cfg.items() if v is not None and v != ""})

    config["base_url"] = str(config.get("base_url") or DEFAULT_BASE_URL).rstrip("/")
    config["timeout_secs"] = _coerce_float(config.get("timeout_secs"), DEFAULT_TIMEOUT_SECS, 0.1)
    config["prefetch_token_budget"] = _coerce_int(
        config.get("prefetch_token_budget"), DEFAULT_PREFETCH_TOKEN_BUDGET,
        _RECALL_BUDGET_MIN, _RECALL_BUDGET_MAX,
    )
    config["sync_turns"] = _coerce_bool(config.get("sync_turns"), DEFAULT_SYNC_TURNS)
    config["mirror_memory_writes"] = _coerce_bool(
        config.get("mirror_memory_writes"), DEFAULT_MIRROR_MEMORY_WRITES)
    config["prefetch_contexts"] = _coerce_contexts(
        config.get("prefetch_contexts"), DEFAULT_PREFETCH_CONTEXTS)
    return config


# ---------------------------------------------------------------------------
# Profile scope + turn payload helpers
# ---------------------------------------------------------------------------

def _profile_name(hermes_home: Optional[str], agent_identity: Optional[str] = None) -> str:
    """Profile id for the write scope ``hermes:<profile>``.

    Same rule as the stdio transport (``provider.py``): Hermes passes the active
    profile name as ``agent_identity``. Without it, derive from ``hermes_home``
    via Hermes' own resolver (``<root>/profiles/<name>`` -> ``name``; the root
    ``~/.hermes`` itself -> ``default``), else fall back to ``default``.
    """
    identity = str(agent_identity or "").strip()
    if identity:
        return identity
    if hermes_home:
        try:
            from hermes_constants import profile_name_for_home
            name = profile_name_for_home(hermes_home)
        except Exception:
            name = None
        if not name:
            home = Path(hermes_home).expanduser()
            if home.parent.name == "profiles" and not home.name.startswith("."):
                name = home.name
        if name:
            return str(name)
    return "default"


def _content_text(content: Any) -> str:
    """Flatten OpenAI-style message content (str or list of parts) to text."""
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for part in content:
            if isinstance(part, dict):
                if isinstance(part.get("text"), str):
                    parts.append(part["text"])
            elif isinstance(part, str):
                parts.append(part)
        return "\n".join(parts)
    try:
        return json.dumps(content, ensure_ascii=False)
    except (TypeError, ValueError):
        return str(content)


def _clip_io(value: Any) -> Any:
    """Bound a tool input/output for the ingest payload (strings clipped, JSON kept if small)."""
    if isinstance(value, str):
        return value if len(value) <= _TOOL_IO_MAX_CHARS else value[:_TOOL_IO_MAX_CHARS] + "…"
    try:
        encoded = json.dumps(value, ensure_ascii=False)
    except (TypeError, ValueError):
        return _clip_io(str(value))
    return value if len(encoded) <= _TOOL_IO_MAX_CHARS else _clip_io(encoded)


def _turn_author_payload(turn_author: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """Map Hermes' ``turn_author`` ``{id, name, is_bot}`` onto ingest_turn's
    ``author`` object. Keys absent or None are omitted; the server schema is
    closed, so nothing else is forwarded. ``{}`` when there is nothing to send."""
    if not isinstance(turn_author, dict):
        return {}
    author: Dict[str, Any] = {}
    for key in ("id", "name"):
        value = turn_author.get(key)
        if value is not None and str(value) != "":
            author[key] = str(value)
    if turn_author.get("is_bot") is not None:
        author["is_bot"] = bool(turn_author["is_bot"])
    return author


def _extract_tool_calls(messages: Optional[List[Dict[str, Any]]]) -> List[Dict[str, Any]]:
    """Tool calls of the LATEST turn (from the last user message onward), joined
    with their ``role == "tool"`` results, as ``ingest_turn.tool_calls`` items."""
    if not messages:
        return []
    start = 0
    for idx in range(len(messages) - 1, -1, -1):
        m = messages[idx]
        if isinstance(m, dict) and m.get("role") == "user":
            start = idx
            break
    calls: Dict[str, Dict[str, Any]] = {}
    order: List[str] = []
    for m in messages[start:]:
        if not isinstance(m, dict):
            continue
        role = m.get("role")
        if role == "assistant":
            for tc in m.get("tool_calls") or []:
                if not isinstance(tc, dict):
                    continue
                fn = tc.get("function") if isinstance(tc.get("function"), dict) else {}
                name = str(fn.get("name") or tc.get("name") or "").strip()
                if not name:
                    continue
                raw = fn.get("arguments") if "arguments" in fn else tc.get("args")
                if isinstance(raw, str):
                    try:
                        raw = json.loads(raw) if raw.strip() else {}
                    except ValueError:
                        pass
                tid = str(tc.get("id") or tc.get("tool_call_id") or f"_{len(order)}")
                calls[tid] = {"name": name, "input": _clip_io(raw if raw is not None else {})}
                order.append(tid)
        elif role == "tool":
            tid = str(m.get("tool_call_id") or m.get("id") or "")
            if tid in calls:
                calls[tid]["output"] = _clip_io(_content_text(m.get("content")))
    return [calls[t] for t in order]


# ---------------------------------------------------------------------------
# Minimal streamable-HTTP MCP client (stdlib only)
# ---------------------------------------------------------------------------

class EngramMcpError(RuntimeError):
    """Raised for transport, protocol, or tool-level failures."""


def _is_timeout(exc: BaseException) -> bool:
    """True when *exc* (or what it wraps) is a socket/urlopen timeout."""
    seen = 0
    cur: Optional[BaseException] = exc
    while cur is not None and seen < 5:
        if isinstance(cur, TimeoutError):
            return True
        reason = getattr(cur, "reason", None)
        if isinstance(reason, TimeoutError):
            return True
        if "timed out" in str(cur).lower():
            return True
        cur = cur.__cause__ or cur.__context__
        seen += 1
    return False


def _http(method: str, url: str, body: Optional[bytes], headers: Dict[str, str],
          timeout: float):
    """One HTTP round-trip. Returns (status, header_getter, body_bytes).

    Uses ``urllib.request.urlopen`` so tests can monkeypatch it.
    """
    req = urllib.request.Request(url, data=body, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            status = getattr(resp, "status", None) or resp.getcode()
            return status, resp.headers.get, resp.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.headers.get, exc.read()


def _parse_rpc_body(content_type: str, raw: bytes) -> Dict[str, Any]:
    """Decode a JSON-RPC response from either JSON or an SSE event stream."""
    text = raw.decode("utf-8", errors="replace")
    if "text/event-stream" in (content_type or ""):
        last: Optional[Dict[str, Any]] = None
        for line in text.splitlines():
            if line.startswith("data:"):
                payload = line[5:].strip()
                if not payload:
                    continue
                try:
                    obj = json.loads(payload)
                except ValueError:
                    continue
                if isinstance(obj, dict) and ("result" in obj or "error" in obj):
                    last = obj
        if last is None:
            raise EngramMcpError("no JSON-RPC message in event stream")
        return last
    if not text.strip():
        raise EngramMcpError("empty response body")
    obj = json.loads(text)
    if not isinstance(obj, dict):
        raise EngramMcpError("unexpected JSON-RPC payload shape")
    return obj


class EngramMcpClient:
    """Session-caching client for the engram streamable-HTTP MCP endpoint.

    The server hangs (never answers) on an unknown or missing session id, so
    every request is bounded by a timeout and any failure drops the cached
    session, forcing a fresh ``initialize`` on the next call.
    """

    def __init__(self, base_url: str):
        self.base_url = base_url.rstrip("/")
        self.mcp_url = f"{self.base_url}/mcp"
        self._session_id: Optional[str] = None
        self._lock = threading.Lock()
        self._next_id = 1

    # -- helpers --------------------------------------------------------

    def _headers(self, session_id: Optional[str] = None) -> Dict[str, str]:
        h = {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            "User-Agent": "hermes-engram-plugin",
        }
        if session_id:
            h["mcp-session-id"] = session_id
        return h

    def _rpc_id(self) -> int:
        with self._lock:
            rid = self._next_id
            self._next_id += 1
            return rid

    def health(self, timeout: float) -> bool:
        status, _get, raw = _http("GET", f"{self.base_url}/health", None,
                                  {"Accept": "application/json"}, timeout)
        if status != 200:
            raise EngramMcpError(f"/health returned HTTP {status}")
        try:
            data = json.loads(raw.decode("utf-8", errors="replace"))
        except ValueError as exc:
            raise EngramMcpError(f"/health returned non-JSON: {exc}") from exc
        return isinstance(data, dict) and data.get("status") == "ok"

    def _initialize(self, timeout: float) -> str:
        payload = json.dumps({
            "jsonrpc": "2.0", "id": self._rpc_id(), "method": "initialize",
            "params": {
                "protocolVersion": MCP_PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": {"name": "hermes-engram-plugin", "version": "1.0.0"},
            },
        }).encode("utf-8")
        status, get, raw = _http("POST", self.mcp_url, payload, self._headers(), timeout)
        if status != 200:
            raise EngramMcpError(f"initialize returned HTTP {status}")
        msg = _parse_rpc_body(get("content-type") or "", raw)
        if "error" in msg:
            raise EngramMcpError(f"initialize error: {msg['error']}")
        session_id = get("mcp-session-id")
        if not session_id:
            raise EngramMcpError("initialize response carried no mcp-session-id")
        # Per spec the client acknowledges; the server answers 202 with no body.
        notify = json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}).encode("utf-8")
        try:
            _http("POST", self.mcp_url, notify, self._headers(session_id), timeout)
        except Exception as exc:  # non-fatal
            logger.debug("engram: initialized notification failed: %s", exc)
        return session_id

    def _ensure_session(self, timeout: float) -> str:
        with self._lock:
            if self._session_id:
                return self._session_id
        session_id = self._initialize(timeout)
        with self._lock:
            self._session_id = session_id
        return session_id

    def reset_session(self) -> None:
        with self._lock:
            self._session_id = None

    # -- public ---------------------------------------------------------

    def call_tool(self, name: str, arguments: Dict[str, Any], timeout: float) -> str:
        """Invoke an MCP tool and return its concatenated text content."""
        try:
            session_id = self._ensure_session(min(timeout, _HANDSHAKE_TIMEOUT_SECS))
            payload = json.dumps({
                "jsonrpc": "2.0", "id": self._rpc_id(), "method": "tools/call",
                "params": {"name": name, "arguments": arguments},
            }).encode("utf-8")
            status, get, raw = _http("POST", self.mcp_url, payload,
                                     self._headers(session_id), timeout)
            if status != 200:
                raise EngramMcpError(f"tools/call {name} returned HTTP {status}")
            msg = _parse_rpc_body(get("content-type") or "", raw)
        except EngramMcpError:
            self.reset_session()
            raise
        except Exception as exc:
            self.reset_session()
            raise EngramMcpError(f"{type(exc).__name__}: {exc}") from exc

        if "error" in msg:
            err = msg["error"]
            text = err.get("message", str(err)) if isinstance(err, dict) else str(err)
            raise EngramMcpError(f"{name}: {text}")
        result = msg.get("result") or {}
        parts = [c.get("text", "") for c in result.get("content", [])
                 if isinstance(c, dict) and c.get("type") == "text"]
        text = "\n".join(p for p in parts if p)
        if result.get("isError"):
            raise EngramMcpError(f"{name}: {text or 'tool reported an error'}")
        return text

    def close(self) -> None:
        with self._lock:
            session_id, self._session_id = self._session_id, None
        if not session_id:
            return
        try:
            _http("DELETE", self.mcp_url, None, self._headers(session_id), 2.0)
        except Exception:
            pass


# ---------------------------------------------------------------------------
# MemoryProvider implementation
# ---------------------------------------------------------------------------

class EngramMemoryProvider(MemoryProvider):
    """Engram memory: automatic recall via prefetch, explicit save via one tool."""

    def __init__(self):
        self._config: Optional[Dict[str, Any]] = None
        self._hermes_home: Optional[str] = None
        self._client: Optional[EngramMcpClient] = None
        self._unavailable_reason = ""
        self._last_recall_count: Optional[int] = None
        self._last_recall_timed_out = False
        self._last_timeout_warn_at = 0.0
        self._warmup_thread: Optional[threading.Thread] = None
        # Circuit breaker state
        self._consecutive_failures = 0
        self._breaker_open_until = 0.0
        self._breaker_lock = threading.Lock()
        # sync_turn state: profile scope, session fallback, per-session turn
        # counters, bounded queue and the single drain thread.
        self._profile = "default"
        self._session_id = ""
        self._agent_context = PRIMARY_CONTEXT
        self._writes_enabled = True
        self._prefetch_enabled = True
        self._turn_counters: Dict[str, int] = {}
        self._sync_queue: "queue.Queue[Dict[str, Any]]" = queue.Queue(maxsize=_SYNC_QUEUE_MAX)
        self._sync_lock = threading.Lock()
        self._sync_thread: Optional[threading.Thread] = None
        self._sync_stop = threading.Event()
        self._sync_cv = threading.Condition()
        self._sync_pending = 0          # enqueued but not yet posted/skipped
        self._breaker_dropped = 0       # queue overflow drops while the breaker was open

    # -- identity -------------------------------------------------------

    @property
    def name(self) -> str:
        return PROVIDER_NAME

    # -- config / client ------------------------------------------------

    def _cfg(self) -> Dict[str, Any]:
        if self._config is None:
            self._config = _load_config(self._hermes_home)
        return self._config

    def _get_client(self) -> EngramMcpClient:
        base_url = self._cfg()["base_url"]
        if self._client is None or self._client.base_url != base_url:
            self._client = EngramMcpClient(base_url)
        return self._client

    # -- circuit breaker ------------------------------------------------

    def _is_breaker_open(self) -> bool:
        with self._breaker_lock:
            if self._consecutive_failures < _BREAKER_THRESHOLD:
                return False
            if time.monotonic() >= self._breaker_open_until:
                self._consecutive_failures = 0
                return False
            return True

    def _record_success(self) -> None:
        with self._breaker_lock:
            self._consecutive_failures = 0
        self._unavailable_reason = ""

    def _record_failure(self) -> None:
        with self._breaker_lock:
            self._consecutive_failures += 1
            tripped = self._consecutive_failures >= _BREAKER_THRESHOLD
            if tripped:
                self._breaker_open_until = time.monotonic() + _BREAKER_COOLDOWN_SECS
        if tripped:
            logger.warning(
                "engram circuit breaker tripped after %d consecutive failures; "
                "pausing calls for %ds. Check the ai.hermes.engram-mcp LaunchAgent "
                "and %s/health.", _BREAKER_THRESHOLD, _BREAKER_COOLDOWN_SECS,
                self._cfg()["base_url"],
            )

    # -- availability ---------------------------------------------------

    def is_available(self) -> bool:
        """Config/deps only, no network (MemoryProvider contract): engram.json
        parses (or is absent) and ``base_url`` is an http(s) URL. Whether the
        daemon is actually up is probed in ``initialize`` -> ``unavailable_reason``."""
        file_cfg, err = _read_config_file(self._hermes_home)
        if err:
            self._unavailable_reason = err
            return False
        base_url = (file_cfg or {}).get("base_url", DEFAULT_BASE_URL)
        if not isinstance(base_url, str) or not base_url.strip().lower().startswith(("http://", "https://")):
            self._unavailable_reason = (
                f"base_url in {CONFIG_FILENAME} must be an http(s) URL (got {base_url!r}); "
                "run `hermes memory setup engram`"
            )
            return False
        self._unavailable_reason = ""
        return True

    def _probe_health(self) -> None:
        """One GET /health at startup; only informs ``unavailable_reason()``."""
        cfg = self._cfg()
        try:
            ok = self._get_client().health(cfg["timeout_secs"])
        except Exception as exc:
            self._unavailable_reason = (
                f"engram MCP server unreachable at {cfg['base_url']}/health ({exc}). "
                "Check the ai.hermes.engram-mcp LaunchAgent."
            )
            return
        self._unavailable_reason = "" if ok else f"{cfg['base_url']}/health did not report status ok"

    def unavailable_reason(self) -> str:
        reason = self._unavailable_reason
        if self._breaker_dropped:
            note = f"{self._breaker_dropped} queued turn(s) dropped while the circuit breaker was open"
            reason = f"{reason}; {note}" if reason else note
        return reason

    # -- lifecycle ------------------------------------------------------

    def initialize(self, session_id: str, **kwargs) -> None:
        hermes_home = kwargs.get("hermes_home")
        if hermes_home:
            self._hermes_home = str(hermes_home)
        self._config = _load_config(self._hermes_home)
        self._client = EngramMcpClient(self._config["base_url"])
        self._session_id = str(session_id or "")
        self._profile = _profile_name(self._hermes_home, kwargs.get("agent_identity"))
        context = str(kwargs.get("agent_context") or PRIMARY_CONTEXT).strip().lower() or PRIMARY_CONTEXT
        self._agent_context = context
        self._writes_enabled = context == PRIMARY_CONTEXT          # stdio transport's rule
        self._prefetch_enabled = context in self._config["prefetch_contexts"]
        self._probe_health()
        if _WARMUP_ENABLED and self._prefetch_enabled and not self._unavailable_reason:
            self._start_warmup()

    def _start_warmup(self) -> None:
        """One cheap recall in the background so the embedder/reranker are hot
        before the first real turn. Best effort: errors and timeouts are
        swallowed and never touch the breaker or recall_status()."""
        client, timeout = self._get_client(), self._cfg()["timeout_secs"]

        def _warm() -> None:
            try:
                client.call_tool("recall", dict(_WARMUP_RECALL_ARGS), timeout)
            except Exception as exc:
                logger.debug("engram warm-up recall skipped: %s", exc)

        self._warmup_thread = spawn_context_thread(_warm, name=f"engram-warmup-{self._profile}", daemon=True)
        self._warmup_thread.start()

    def shutdown(self) -> None:
        """Drain queued turns (bounded by ``_SHUTDOWN_DRAIN_SECS``), stop the
        drain thread, then close the MCP session."""
        thread = self._sync_thread
        if thread is not None and thread.is_alive():
            with self._sync_cv:
                # Parked items cannot post while the breaker is open; don't wait on them.
                self._sync_cv.wait_for(lambda: self._sync_pending == 0 or self._is_breaker_open(),
                                       timeout=_SHUTDOWN_DRAIN_SECS)
        self._sync_stop.set()
        if thread is not None and thread.is_alive():
            thread.join(timeout=0.5)
        if self._client is not None:
            self._client.close()

    def system_prompt_block(self) -> str:
        return _SYSTEM_PROMPT_BLOCK

    # -- recall ---------------------------------------------------------

    def prefetch(self, query: str, *, session_id: str = "") -> str:
        """Recall context for this turn. Any failure returns "" — memory must
        never break a conversation turn. A timeout is the one failure that is
        not silent: it is logged (rate-limited) and shown by recall_status()."""
        self._last_recall_count = None
        self._last_recall_timed_out = False
        if not self._prefetch_enabled or not query or not query.strip() or self._is_breaker_open():
            return ""
        cfg = self._cfg()
        try:
            text = self._get_client().call_tool(
                "recall",
                {"query": query, "budget": cfg["prefetch_token_budget"]},
                cfg["timeout_secs"],
            )
            self._record_success()
        except Exception as exc:
            self._record_failure()
            if _is_timeout(exc):
                self._note_timeout(cfg["timeout_secs"])
            else:
                logger.debug("engram prefetch failed: %s", exc)
            return ""
        text = (text or "").strip()
        if not text:
            return ""
        m = _TOTAL_RESULTS_RE.search(text)
        count = int(m.group(1)) if m else 0
        if m and count == 0:
            return ""
        self._last_recall_count = count
        return text

    def _note_timeout(self, timeout: float) -> None:
        self._last_recall_timed_out = True
        now = time.monotonic()
        if now - self._last_timeout_warn_at < _TIMEOUT_WARN_INTERVAL_SECS:
            return
        self._last_timeout_warn_at = now
        logger.warning(
            "engram recall timed out after %.1fs; this turn ran without memory context "
            "(further timeouts logged at most every %d min). Raise timeout_secs in %s "
            "or check the daemon's load.",
            timeout, int(_TIMEOUT_WARN_INTERVAL_SECS // 60), CONFIG_FILENAME,
        )

    def recall_status(self) -> Optional[RecallStatus]:
        if self._last_recall_timed_out:
            # RecallStatus has no miss field; the label carries it (count 0
            # renders generically in Hermes' indicator line).
            return RecallStatus(
                provider_label=f"Engram (recall timed out after {self._cfg()['timeout_secs']:g}s; no memory this turn)",
                count=0, glyph="⚠️",
            )
        if self._last_recall_count is None:
            return None
        return RecallStatus(provider_label="Engram", count=self._last_recall_count)

    # -- tools ----------------------------------------------------------

    def get_tool_schemas(self) -> List[Dict[str, Any]]:
        return [SAVE_SCHEMA]

    def handle_tool_call(self, tool_name: str, args: Dict[str, Any], **kwargs) -> str:
        if tool_name != SAVE_TOOL_NAME:
            return tool_error(f"Unknown tool: {tool_name}")
        args = args or {}
        content = args.get("content", "")
        if not isinstance(content, str) or not content.strip():
            return tool_error("Missing required parameter: content")

        arguments: Dict[str, Any] = {"content": content.strip(), "source": "user"}
        mtype = args.get("type")
        if mtype not in (None, ""):
            if mtype not in MEMORY_TYPES:
                return tool_error(f"Invalid type {mtype!r}; expected one of {', '.join(MEMORY_TYPES)}")
            arguments["type"] = mtype
        importance = args.get("importance")
        if importance not in (None, ""):
            try:
                importance = float(importance)
            except (TypeError, ValueError):
                return tool_error("importance must be a number between 0 and 1")
            if not 0.0 <= importance <= 1.0:
                return tool_error("importance must be between 0 and 1")
            arguments["importance"] = importance

        if self._is_breaker_open():
            return tool_error(
                "engram temporarily unavailable (multiple consecutive failures). "
                "Will retry automatically."
            )
        try:
            text = self._get_client().call_tool("remember", arguments, _TOOL_CALL_TIMEOUT_SECS)
            self._record_success()
        except Exception as exc:
            self._record_failure()
            return tool_error(f"engram remember failed: {exc}")
        return json.dumps({"result": text or "Stored."}, ensure_ascii=False)

    # -- turn ingestion (sync_turn) -------------------------------------

    def _write_scope(self) -> str:
        return f"hermes:{self._profile}"

    def sync_turn(self, user_content: str, assistant_content: str, *,
                  session_id: str = "", messages: Optional[List[Dict[str, Any]]] = None,
                  turn_author: Optional[Dict[str, Any]] = None) -> None:
        """Enqueue the turn for ``ingest_turn`` and return immediately.

        Never blocks and never does network on the caller thread. The queue is
        bounded (``_SYNC_QUEUE_MAX``); on overflow the OLDEST queued turn is
        dropped (its turn_index leaves a gap, which the server tolerates).
        ``turn_author`` (``{id, name, is_bot}``) is sent as ``author``.
        Non-primary agent contexts (subagent/cron/flush) enqueue nothing.
        """
        if not self._writes_enabled or not self._cfg()["sync_turns"]:
            return
        user_text = (user_content or "").strip()
        assistant_text = (assistant_content or "").strip()
        if not user_text and not assistant_text:
            return
        sid = str(session_id or "").strip() or self._session_id
        if not sid:
            logger.debug("engram sync_turn: no session id; turn not ingested")
            return
        with self._sync_lock:
            turn_index = self._turn_counters.get(sid, 0)
            self._turn_counters[sid] = turn_index + 1
        item: Dict[str, Any] = {
            "session_id": sid,
            "turn_index": turn_index,
            "scope": self._write_scope(),
            "user_text": user_text,
            "assistant_text": assistant_text,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "source": TURN_SOURCE,
        }
        tool_calls = _extract_tool_calls(messages)
        if tool_calls:
            item["tool_calls"] = tool_calls
        author = _turn_author_payload(turn_author)
        if author:
            item["author"] = author
        self._enqueue(_KIND_TURN, item)

    def _enqueue(self, kind: str, args: Dict[str, Any]) -> None:
        """Push a ``{"kind", "args"}`` item; drop-oldest on overflow; start the drain thread."""
        item = {"kind": kind, "args": args}
        with self._sync_lock:
            dropped = 0
            while True:
                try:
                    self._sync_queue.put_nowait(item)
                    break
                except queue.Full:
                    try:
                        self._sync_queue.get_nowait()
                        dropped += 1
                    except queue.Empty:
                        pass
            with self._sync_cv:
                self._sync_pending += 1 - dropped
            if dropped:
                if self._is_breaker_open():
                    self._breaker_dropped += dropped
                logger.debug("engram sync queue full; dropped %d oldest item(s)", dropped)
            self._ensure_drain_thread()

    def _ensure_drain_thread(self) -> None:
        """Lazily start the single drain thread. Caller holds ``_sync_lock``.
        Goes through ``spawn_context_thread`` so the worker inherits the
        profile-scoped contextvars (HERMES_HOME override); a bare Thread
        would silently land on the default profile."""
        if self._sync_thread is not None and self._sync_thread.is_alive():
            return
        self._sync_stop.clear()
        self._sync_thread = spawn_context_thread(
            self._drain_loop, name=f"engram-sync-{self._profile}", daemon=True)
        self._sync_thread.start()

    def _drain_loop(self) -> None:
        while not self._sync_stop.is_set():
            if self._is_breaker_open():
                # Park: leave queued items in place and re-check after the poll
                # interval; the breaker's cooldown decides when posting resumes.
                self._sync_stop.wait(_SYNC_DRAIN_POLL_SECS)
                continue
            try:
                item = self._sync_queue.get(timeout=_SYNC_DRAIN_POLL_SECS)
            except queue.Empty:
                continue
            try:
                self._post_item(item)
            except Exception as exc:  # never let the worker die
                logger.debug("engram sync drain: unexpected error: %s", exc)
            finally:
                with self._sync_cv:
                    self._sync_pending -= 1
                    self._sync_cv.notify_all()

    def _post_item(self, item: Dict[str, Any]) -> None:
        """Post one queued item (turn -> ingest_turn, write -> remember).
        ``_drain_loop`` never dequeues while the breaker is open; failures
        count toward the breaker exactly like recall and the save tool."""
        tool = _TOOL_BY_KIND.get(item.get("kind"), "ingest_turn")
        args = item["args"]
        try:
            self._get_client().call_tool(tool, args, _TOOL_CALL_TIMEOUT_SECS)
            self._record_success()
        except Exception as exc:
            self._record_failure()
            logger.debug("engram %s failed: %s", tool, exc)

    # -- built-in memory mirror (on_memory_write) ---------------------------

    def on_memory_write(self, action: str, target: str, content: str,
                        metadata: Optional[Dict[str, Any]] = None) -> None:
        """Mirror a committed MEMORY.md / USER.md write into engram (non-blocking).

        ``add``/``replace`` enqueue a ``remember`` under the profile scope with
        the NEW text, ``source: "hermes-mirror"`` and a ``context`` note naming
        the action (``replace`` old text arrives only in ``metadata["old_text"]``
        and is not sent; engram's remember dedup supersedes it). ``remove`` and
        unknown actions are no-ops. Nothing runs on the caller thread but the
        enqueue.
        """
        if action not in _MIRRORED_ACTIONS:
            logger.debug("engram on_memory_write: %s/%s not mirrored", action, target)
            return
        if not self._writes_enabled or not self._cfg()["mirror_memory_writes"]:
            return
        text = (content or "").strip()
        if not text:
            return
        self._enqueue(_KIND_WRITE, {
            "content": text,
            "type": _MIRROR_TYPE_BY_TARGET.get(str(target), "fact"),
            "importance": _MIRROR_IMPORTANCE,
            "source": _MIRROR_SOURCE,
            "context": f"mirrored from built-in memory: {action}",
            "scope": self._write_scope(),
        })

    # -- ingestion hooks still deliberately no-ops --------------------------

    def on_session_end(self, messages: List[Dict[str, Any]]) -> None:
        """No-op in v1 (auto-ingest is out of scope)."""

    def on_pre_compress(self, messages: List[Dict[str, Any]]) -> str:
        return ""

    # -- setup / config -------------------------------------------------

    def get_config_schema(self) -> List[Dict[str, Any]]:
        return [
            {
                "key": "base_url",
                "description": "Engram MCP server base URL (the /mcp and /health endpoints hang off it)",
                "default": DEFAULT_BASE_URL,
                "type": "text",
            },
            {
                "key": "timeout_secs",
                "description": "HTTP timeout in seconds for health checks and per-turn recall",
                "default": DEFAULT_TIMEOUT_SECS,
                "type": "number",
                "minimum": 0.1,
                "step": 0.5,
            },
            {
                "key": "prefetch_token_budget",
                "description": "Token budget for automatic recall injected before each turn",
                "default": DEFAULT_PREFETCH_TOKEN_BUDGET,
                "type": "integer",
                "minimum": _RECALL_BUDGET_MIN,
                "maximum": _RECALL_BUDGET_MAX,
            },
            {
                "key": "sync_turns",
                "description": "Post each completed turn to engram's ingest_turn (background, profile-scoped)",
                "default": DEFAULT_SYNC_TURNS,
                "type": "boolean",
            },
            {
                "key": "mirror_memory_writes",
                "description": "Mirror built-in MEMORY.md/USER.md adds and replaces into engram (background, profile-scoped)",
                "default": DEFAULT_MIRROR_MEMORY_WRITES,
                "type": "boolean",
            },
            {
                "key": "prefetch_contexts",
                "description": "Comma-separated agent contexts that get automatic recall (primary, subagent, cron, flush)",
                "default": ",".join(DEFAULT_PREFETCH_CONTEXTS),
                "type": "text",
            },
        ]

    def save_config(self, values: Dict[str, Any], hermes_home: str) -> None:
        """Merge non-secret values into $HERMES_HOME/engram.json."""
        config_path = Path(hermes_home) / CONFIG_FILENAME
        existing: Dict[str, Any] = {}
        if config_path.exists():
            try:
                loaded = json.loads(config_path.read_text(encoding="utf-8"))
                if isinstance(loaded, dict):
                    existing = loaded
            except Exception:
                pass
        existing.update({k: v for k, v in (values or {}).items() if v is not None})
        try:
            from utils import atomic_json_write
            atomic_json_write(config_path, existing, mode=0o600)
        except Exception:
            config_path.parent.mkdir(parents=True, exist_ok=True)
            config_path.write_text(json.dumps(existing, indent=2) + "\n", encoding="utf-8")
        self._config = None  # re-read on next use

    def backup_paths(self) -> List[str]:
        return [os.path.expanduser(DB_PATH)]


def selected_transport(hermes_home: Optional[str] = None) -> str:
    """Return the configured transport name; unknown values fall back to http."""
    raw = _load_config(hermes_home).get("transport")
    transport = str(raw or DEFAULT_TRANSPORT).strip().lower()
    if transport not in TRANSPORTS:
        logger.warning("engram: unknown transport %r in %s; using %s",
                       raw, CONFIG_FILENAME, DEFAULT_TRANSPORT)
        return DEFAULT_TRANSPORT
    return transport


def make_provider(transport: Optional[str] = None):
    """Instantiate the provider for ``transport`` (default: from engram.json)."""
    transport = transport or selected_transport()
    if transport == TRANSPORT_STDIO:
        # provider.py is a sibling file. Hermes's user-lane loader imports this
        # module as a package, but plain file loads (tests, tooling) do not, so
        # resolve the sibling by path instead of a relative import.
        here = os.path.dirname(os.path.abspath(__file__))
        if here not in sys.path:
            sys.path.insert(0, here)
        from provider import EngramMemoryProvider as StdioEngramMemoryProvider
        return StdioEngramMemoryProvider()
    return EngramMemoryProvider()


def register(ctx) -> None:
    """Register engram as a memory provider plugin."""
    ctx.register_memory_provider(make_provider())
