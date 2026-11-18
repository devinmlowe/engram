# Engram recall eval report

Generated: 2026-11-18T22:37:59.529Z · store mode: hermetic · path: `/var/folders/86/fg8k7lmx4x70_z4xh5mc_d580000gn/T/engram-eval-4VgTK3/engram.db`

## Conflict verdict

Conflict-axis stale-surfacing rate: **0.0000** (materially-weak threshold ≥ 0.3) → materiallyWeak: **false**. This number is the evidence, not a verdict on Engram.

## Suites

| suite | n | metric | value |
| --- | --- | --- | --- |
| conflicts | 1 | stale-surfacing rate | 0.0000 |
| conflicts | 1 | recall@1 | 1.0000 |
| conflicts | 1 | recall@3 | 1.0000 |
| conflicts | 1 | recall@10 | 1.0000 |
| temporal | 1 | ordering-correct rate | 1.0000 |
| redaction | 0 | hash-leakage rate | 0.0000 |

## Query-conditioned vs plain-query slice

| slice | n | stale-surfacing rate | recall@3 |
| --- | --- | --- | --- |
| plain | 1 | 0.0000 | 1.0000 |
| conditioned | 1 | 0.0000 | 1.0000 |

Run duration: 33912 ms. Read-only: the store was opened with `readonly: true`.
