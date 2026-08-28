"""Stdio JSON-RPC 2.0 client for engram's MCP server (ADR-010 Phase 1).

Speaks the newline-delimited JSON-RPC framing used by the MCP TS SDK's
StdioServerTransport. Stdlib-only — no `mcp` pip dependency — so the plugin
loads in any Hermes environment.

Thread-safety: a single lock serializes requests; responses are matched by id.
The child is spawned in its own process group so stop() can reap stragglers.
"""

from __future__ import annotations

import json
import os
import queue
import signal
import subprocess
import threading
from typing import Any, Dict, List, Optional

PROTOCOL_VERSION = "2024-11-05"
DEFAULT_TIMEOUT_S = 30.0


class McpError(RuntimeError):
    """JSON-RPC error response, transport failure, or timeout."""


class McpStdioClient:
    def __init__(
        self,
        command: List[str],
        env: Optional[Dict[str, str]] = None,
        cwd: Optional[str] = None,
    ) -> None:
        self._command = command
        self._env = env
        self._cwd = cwd
        self._proc: Optional[subprocess.Popen] = None
        self._lock = threading.Lock()
        self._next_id = 0
        self._responses: "queue.Queue[dict]" = queue.Queue()
        self._reader: Optional[threading.Thread] = None
        self.server_info: Dict[str, Any] = {}

    # ── lifecycle ────────────────────────────────────────────────

    @property
    def alive(self) -> bool:
        return self._proc is not None and self._proc.poll() is None

    @property
    def pid(self) -> int:
        if self._proc is None:
            raise McpError("not started")
        return self._proc.pid

    def start(self, timeout: float = DEFAULT_TIMEOUT_S) -> None:
        if self.alive:
            return
        env = dict(os.environ)
        if self._env:
            env.update(self._env)
        self._proc = subprocess.Popen(
            self._command,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            cwd=self._cwd,
            env=env,
            text=True,
            bufsize=1,
            start_new_session=True,
        )
        self._reader = threading.Thread(target=self._read_loop, daemon=True)
        self._reader.start()

        result = self._request(
            "initialize",
            {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": {"name": "hermes-engram-provider", "version": "0.1.0"},
            },
            timeout=timeout,
        )
        self.server_info = result.get("serverInfo", {})
        self._notify("notifications/initialized")

    def stop(self, grace_s: float = 3.0) -> None:
        proc = self._proc
        if proc is None:
            return
        self._proc = None
        try:
            if proc.poll() is None:
                try:
                    proc.stdin.close()  # EOF ends the stdio transport
                except Exception:
                    pass
                try:
                    proc.wait(timeout=grace_s)
                except subprocess.TimeoutExpired:
                    try:
                        os.killpg(proc.pid, signal.SIGTERM)
                        proc.wait(timeout=grace_s)
                    except Exception:
                        try:
                            os.killpg(proc.pid, signal.SIGKILL)
                        except Exception:
                            pass
                        proc.wait(timeout=grace_s)
        finally:
            for stream in (proc.stdout, proc.stderr):
                try:
                    if stream:
                        stream.close()
                except Exception:
                    pass

    # ── MCP operations ───────────────────────────────────────────

    def list_tools(self, timeout: float = DEFAULT_TIMEOUT_S) -> List[Dict[str, Any]]:
        return self._request("tools/list", {}, timeout=timeout).get("tools", [])

    def call_tool(
        self,
        name: str,
        arguments: Dict[str, Any],
        timeout: float = DEFAULT_TIMEOUT_S,
    ) -> str:
        result = self._request(
            "tools/call", {"name": name, "arguments": arguments}, timeout=timeout
        )
        parts = [
            c.get("text", "")
            for c in result.get("content", [])
            if c.get("type") == "text"
        ]
        return "\n".join(parts)

    # ── JSON-RPC plumbing ────────────────────────────────────────

    def _read_loop(self) -> None:
        proc = self._proc
        if proc is None or proc.stdout is None:
            return
        for line in proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue  # non-protocol chatter on stdout
            if "id" in msg and ("result" in msg or "error" in msg):
                self._responses.put(msg)

    def _notify(self, method: str) -> None:
        self._send({"jsonrpc": "2.0", "method": method})

    def _request(
        self, method: str, params: Dict[str, Any], timeout: float
    ) -> Dict[str, Any]:
        with self._lock:
            self._next_id += 1
            msg_id = self._next_id
            self._send(
                {"jsonrpc": "2.0", "id": msg_id, "method": method, "params": params}
            )
            while True:
                try:
                    msg = self._responses.get(timeout=timeout)
                except queue.Empty:
                    raise McpError(f"{method} timed out after {timeout}s") from None
                if msg.get("id") != msg_id:
                    continue  # stale response from a timed-out call
                if "error" in msg:
                    err = msg["error"]
                    raise McpError(f"{err.get('message', 'unknown error')} (code {err.get('code')})")
                return msg.get("result", {})

    def _send(self, msg: Dict[str, Any]) -> None:
        proc = self._proc
        if proc is None or proc.stdin is None or proc.poll() is not None:
            raise McpError("MCP child process is not running")
        try:
            proc.stdin.write(json.dumps(msg) + "\n")
            proc.stdin.flush()
        except (BrokenPipeError, OSError) as exc:
            raise McpError(f"failed to write to MCP child: {exc}") from exc
