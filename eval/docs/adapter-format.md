# External-comparability adapter format

The eval harness accepts external-benchmark fixtures through a documented
adapter format. Fixtures are JSON files under `eval/fixtures/external/`.

## Canonical fixture schema

```jsonc
{
  "benchmark": "longmem-eval | memoryagentbench",
  "label": "shape-derived sample — not official benchmark data",
  "source": { "citation": "arXiv:2410.10813", "note": "…" },
  "cases": [
    {
      "id": "case-1",
      "session": ["turn 1 text", "turn 2 text"],   // raw context turns
      "operations": [                               // knowledge mutations
        { "op": "add", "content": "…" },
        { "op": "update", "before": "…", "after": "…" },
        { "op": "delete", "content": "…" }
      ],
      "query": "the probe question",
      "expected": "the answer that reflects the LATEST state",
      "axis": "knowledge-update | temporal-reasoning | delete-supersede"
    }
  ]
}
```

- **LongMemEval** (arXiv:2410.10813) maps to `axis: knowledge-update` and
  `temporal-reasoning`: cases probe whether recall reflects the *latest*
  value of an updated fact and orders temporally.
- **MemoryAgentBench** (arXiv:2507.05257) maps to `axis: delete-supersede`:
  cases probe whether deleted/superseded facts stay out of recall.

The sample fixtures shipped here (`longmem-eval.sample.json`,
`memoryagentbench.sample.json`) are **shape-derived illustrations authored
for this harness**, not redistributions of official benchmark data; the
`label` field must always say `shape-derived`.

## LoCoMo (arXiv:2402.17753)

Comparability note only. LoCoMo's published vendor scores (88–96%) are
treated as saturated/contaminated; this project makes **no leaderboard
claims** and does not run LoCoMo. LoCoMo is cited solely to position the
harness's metrics relative to the long-term-memory evaluation landscape.
