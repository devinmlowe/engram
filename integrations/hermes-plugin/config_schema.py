"""Engram's declared config surface — rendered by Hermes's generic desktop panel.

Loaded by path by plugins/memory/config_schema.get_provider_config_schema();
imports only the pure-data schema module, per the dashboard contract.
"""

from plugins.memory.config_schema import (
    KIND_NUMBER,
    KIND_TEXT,
    ProviderConfigSchema,
    ProviderField,
)

CONFIG_SCHEMA = ProviderConfigSchema(
    name="engram",
    label="Engram",
    storage="flat_json",
    docs_url="https://github.com/devinmlowe/engram",
    fields=(
        ProviderField(
            key="repo_path",
            label="Engram repo",
            kind=KIND_TEXT,
            default="~/git/engram",
            description="Engram checkout containing the built dist/ tree.",
        ),
        ProviderField(
            key="node_path",
            label="Node binary",
            kind=KIND_TEXT,
            default="",
            description="Path to node >=22 (blank = PATH lookup).",
        ),
        ProviderField(
            key="db_path",
            label="Database path",
            kind=KIND_TEXT,
            default="",
            description="Override the engram SQLite DB (blank = engram default).",
        ),
        ProviderField(
            key="budget",
            label="Prefetch budget",
            kind=KIND_NUMBER,
            default=1200,
            description="Token budget for automatic recall before each turn.",
        ),
        ProviderField(
            key="read_scopes",
            label="Read scopes",
            kind=KIND_TEXT,
            default="",
            description="Comma-separated recall scopes (blank = global + this profile).",
        ),
        ProviderField(
            key="idle_kill_s",
            label="Idle kill (s)",
            kind=KIND_NUMBER,
            default=600,
            description="Reap the Node child after this many idle seconds.",
        ),
    ),
)
