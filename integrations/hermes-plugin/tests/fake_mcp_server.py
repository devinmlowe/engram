"""Minimal MCP stdio server for client tests.

Speaks newline-delimited JSON-RPC 2.0 like the TS SDK's StdioServerTransport.
Supports initialize, tools/list, tools/call (echo + slow + fail tools).
"""

import json
import os
import sys
import time

TOOLS = [
    {
        "name": "recall",
        "description": "fake recall",
        "inputSchema": {
            "type": "object",
            "properties": {"query": {"type": "string"}},
            "required": ["query"],
        },
    },
    {
        "name": "remember",
        "description": "fake remember",
        "inputSchema": {
            "type": "object",
            "properties": {"content": {"type": "string"}},
            "required": ["content"],
        },
    },
]


def reply(msg_id, result):
    sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": msg_id, "result": result}) + "\n")
    sys.stdout.flush()


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        msg = json.loads(line)
        method = msg.get("method")
        msg_id = msg.get("id")

        if method == "initialize":
            reply(msg_id, {
                "protocolVersion": "2024-11-05",
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "fake-engram", "version": "0.0.1"},
            })
        elif method == "notifications/initialized":
            continue  # notification, no reply
        elif method == "tools/list":
            reply(msg_id, {"tools": TOOLS})
        elif method == "tools/call":
            name = msg["params"]["name"]
            args = msg["params"].get("arguments", {})
            if name == "slow":
                time.sleep(float(os.environ.get("FAKE_SLOW_S", "5")))
            if name == "boom":
                sys.stdout.write(json.dumps({
                    "jsonrpc": "2.0", "id": msg_id,
                    "error": {"code": -32000, "message": "boom"},
                }) + "\n")
                sys.stdout.flush()
                continue
            reply(msg_id, {
                "content": [{
                    "type": "text",
                    "text": json.dumps({"tool": name, "args": args, "env_scope": os.environ.get("ENGRAM_SCOPE")}),
                }],
            })
        elif msg_id is not None:
            reply(msg_id, {})


if __name__ == "__main__":
    main()
