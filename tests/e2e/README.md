# End-to-End Tests

Full pipeline and interface integration tests that exercise the complete system from input to output.

## In Scope

- Full pipeline test: sync → embed → search → extract → consolidate → graph → dream
- MCP server integration test: tool listing, recall, remember, explore, reflect

## Out of Scope

- Unit tests for individual modules (see sibling directories)
- Contract tests (see [contracts/](../contracts/))

## See Also

- [tests/](../) — Parent test directory
- [src/interfaces/](../../src/interfaces/) — Interface modules under test
