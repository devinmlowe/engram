# Engram recall eval report

Generated: 2026-11-18T22:44:49.100Z · store mode: live · path: `/Users/devinmlowe/.local/share/engram/engram.db`

## Conflict verdict

Conflict-axis stale-surfacing rate: **0.0600** (materially-weak threshold ≥ 0.3) → materiallyWeak: **false**. This number is the evidence, not a verdict on Engram.

## Suites

| suite | n | metric | value |
| --- | --- | --- | --- |
| conflicts | 50 | stale-surfacing rate | 0.0600 |
| conflicts | 50 | recall@1 | 0.0200 |
| conflicts | 50 | recall@3 | 0.0600 |
| conflicts | 50 | recall@10 | 0.3800 |
| temporal | 18 | ordering-correct rate | 0.8333 |
| redaction | 13 | hash-leakage rate | 0.0000 |

## Query-conditioned vs plain-query slice

| slice | n | stale-surfacing rate | recall@3 |
| --- | --- | --- | --- |
| plain | 50 | 0.0600 | 0.0600 |
| conditioned | 50 | 0.0600 | 0.0600 |

Run duration: 12129 ms. Read-only: the store was opened with `readonly: true`.
