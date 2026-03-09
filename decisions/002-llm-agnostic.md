# ADR-002: LLM and Agent Agnosticism

**Status**: Accepted
**Date**: 2026-03-09

## Context

Engram was built for Claude Code with Anthropic API calls, Claude-specific conversation archive formats, and MCP (a Claude Code protocol). The question arose whether the system should be scoped to Claude Code or designed for any LLM agent.

## Decision

Engram is **agent and model agnostic**. The memory architecture (episodic/semantic/graph), the dream pipeline, and the search engine are not inherently tied to any provider. Claude Code is the current primary consumer but not an architectural constraint.

The unified LLM factory (`_core/llm/`) abstracts provider differences. MCP and CLI interfaces serve as adapter layers. Conversation ingestion should support pluggable archive formats.

## Consequences

- No Anthropic-specific assumptions in core domains
- `_core/llm/` must support multiple providers (Ollama, OpenRouter, Anthropic, future)
- Archive ingestion needs a format abstraction (currently hardcoded to `~/.claude/projects/`)
- MCP remains the primary machine interface; CLI remains the primary human interface
- Testing must not require any specific API key
