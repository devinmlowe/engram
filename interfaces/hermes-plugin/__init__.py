"""Engram memory plugin — MemoryProvider wrapping the engram HTTP MCP server.

Engram (https://github.com/devinmlowe/engram) is a cognitive memory system
that ingests LLM conversation history and consolidates it into structured
knowledge. It exposes a streamable-HTTP MCP server (LaunchAgent
``ai.hermes.engram-mcp``, default ``http://127.0.0.1:9907/mcp``).

This provider is deliberately thin: recall is automatic (``prefetch`` calls
the ``recall`` MCP tool with the user's message) and the model gets exactly
one tool, ``engram_memory_save``, which proxies to the ``remember`` MCP
tool. Ingestion of turns is left to engram's own dream pipeline — the
provider does NOT auto-ingest conversations (``sync_turn`` /
``on_session_end`` / ``on_memory_write`` are no-ops in v1).

The MCP server may ALSO be wired as ``mcp_servers.engram`` in config.yaml.
That path is untouched by this plugin; the tool name here is chosen so it
cannot collide with the ``engram``-prefixed MCP tools.

Configuration (non-secret, lives in ``$HERMES_HOME/engram.json``, written by
``hermes memory setup engram``)::

  base_url               — MCP server base URL   (default http://127.0.0.1:9907)
  timeout_secs           — HTTP timeout for health + prefetch (default 2)
  prefetch_token_budget  — recall token budget per turn (default 300)

There are no secrets.
"""

from __future__ import annotations

import json
import logging
import os
import re
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional

from agent.memory_provider import MemoryProvider, RecallStatus
from tools.registry import tool_error

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

PROVIDER_NAME = "engram"
CONFIG_FILENAME = "engram.json"
DB_PATH = "~/.local/share/engram/engram.db"

DEFAULT_BASE_URL = "http://127.0.0.1:9907"
DEFAULT_TIMEOUT_SECS = 2.0
DEFAULT_PREFETCH_TOKEN_BUDGET = 300

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
        return Path(hermes_home) / CONFIG_FILENAME
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


def _load_config(hermes_home: Optional[str] = None) -> Dict[str, Any]:
    """Documented defaults, overridden by non-empty keys in engram.json."""
    config: Dict[str, Any] = {
        "base_url": DEFAULT_BASE_URL,
        "timeout_secs": DEFAULT_TIMEOUT_SECS,
        "prefetch_token_budget": DEFAULT_PREFETCH_TOKEN_BUDGET,
    }
    try:
        path = _config_path(hermes_home)
        if path.exists():
            file_cfg = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(file_cfg, dict):
                config.update({k: v for k, v in file_cfg.items()
                               if v is not None and v != ""})
    except Exception as exc:
        logger.debug("engram: could not read %s: %s", CONFIG_FILENAME, exc)

    config["base_url"] = str(config.get("base_url") or DEFAULT_BASE_URL).rstrip("/")
    config["timeout_secs"] = _coerce_float(config.get("timeout_secs"), DEFAULT_TIMEOUT_SECS, 0.1)
    config["prefetch_token_budget"] = _coerce_int(
        config.get("prefetch_token_budget"), DEFAULT_PREFETCH_TOKEN_BUDGET,
        _RECALL_BUDGET_MIN, _RECALL_BUDGET_MAX,
    )
    return config


# ---------------------------------------------------------------------------
# Minimal streamable-HTTP MCP client (stdlib only)
# ---------------------------------------------------------------------------

class EngramMcpError(RuntimeError):
    """Raised for transport, protocol, or tool-level failures."""


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
        # Circuit breaker state
        self._consecutive_failures = 0
        self._breaker_open_until = 0.0
        self._breaker_lock = threading.Lock()

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
        """True iff GET {base_url}/health answers 200 with status == "ok"."""
        cfg = self._cfg()
        try:
            ok = self._get_client().health(cfg["timeout_secs"])
        except Exception as exc:
            self._unavailable_reason = (
                f"engram MCP server unreachable at {cfg['base_url']}/health ({exc}). "
                "Check the ai.hermes.engram-mcp LaunchAgent."
            )
            return False
        if not ok:
            self._unavailable_reason = f"{cfg['base_url']}/health did not report status ok"
            return False
        self._unavailable_reason = ""
        return True

    def unavailable_reason(self) -> str:
        return self._unavailable_reason

    # -- lifecycle ------------------------------------------------------

    def initialize(self, session_id: str, **kwargs) -> None:
        hermes_home = kwargs.get("hermes_home")
        if hermes_home:
            self._hermes_home = str(hermes_home)
        self._config = _load_config(self._hermes_home)
        self._client = EngramMcpClient(self._config["base_url"])

    def shutdown(self) -> None:
        if self._client is not None:
            self._client.close()

    def system_prompt_block(self) -> str:
        return _SYSTEM_PROMPT_BLOCK

    # -- recall ---------------------------------------------------------

    def prefetch(self, query: str, *, session_id: str = "") -> str:
        """Recall context for this turn. Any failure returns "" — memory must
        never break a conversation turn."""
        self._last_recall_count = None
        if not query or not query.strip() or self._is_breaker_open():
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

    def recall_status(self) -> Optional[RecallStatus]:
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

    # -- ingestion hooks: deliberate no-ops in v1 -----------------------

    def sync_turn(self, user_content: str, assistant_content: str, *,
                  session_id: str = "", messages=None) -> None:
        """No-op: engram's dream pipeline owns conversation ingestion."""

    def on_session_end(self, messages: List[Dict[str, Any]]) -> None:
        """No-op in v1 (auto-ingest is out of scope)."""

    def on_memory_write(self, action: str, target: str, content: str,
                        metadata: Optional[Dict[str, Any]] = None) -> None:
        """No-op in v1: built-in MEMORY.md writes are not mirrored."""

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


def register(ctx) -> None:
    """Register engram as a memory provider plugin."""
    ctx.register_memory_provider(EngramMemoryProvider())
