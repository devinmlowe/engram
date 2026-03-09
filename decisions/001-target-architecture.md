# ADR-001: Specs Describe Target Architecture

**Status**: Accepted
**Date**: 2026-03-09

## Context

Engram was vibe-coded with 21 identified structural issues including boundary violations, missing abstractions, circular dependencies, and coupling. The SRC specification process required a decision: should specs document the current (broken) architecture, or describe the intended target architecture?

## Decision

Specs describe the **target architecture**. The 21 structural issues become the gap between current implementation and specification. Each significant remediation is tracked as a separate ADR. The specs serve as the refactoring roadmap.

## Consequences

- Specs are aspirational — current code does not fully conform
- Each structural issue has a clear resolution path defined by the spec it violates
- Refactoring work is traceable: issue → spec violation → ADR → code change
- Risk: specs may describe boundaries that prove impractical during implementation; ADRs capture any deviations
