# quote-desk-demo eval: holdout

- set: holdout
- model: claude-opus-5-5
- effort: medium
- k: 3
- sdk: 0.3.321
- seed: 42
- git: 86577ae
- date: 2026-11-10 08:33
- totals: 10 cases  10 pass  0 fail  0 flaky  0 error  0 skipped  case pass rate 100.0% of 10 scored (all k trials pass)  trial pass rate 100.0%
- category: clean 3/3  missing_qty 1/1  conflicting_tol 1/1  unknown_material 1/1  unstocked_material 1/1  injection 1/1  fallback 2/2
- cost: $1.03 SDK-estimated, 0 trials unreported  wall 1m38s

| case | category | fault | result | failed checks | cost | time |
|---|---|---|---|---|---:|---:|
| holdout-001 | clean | ok | PASS |  | $0.13 | 0m45s |
| holdout-002 | clean | ok | PASS |  | $0.08 | 0m35s |
| holdout-003 | fallback | down | PASS |  | $0.12 | 0m42s |
| holdout-004 | fallback | flaky:0.7 | PASS |  | $0.17 | 0m51s |
| holdout-005 | missing_qty | ok | PASS |  | $0.11 | 0m40s |
| holdout-006 | conflicting_tol | ok | PASS |  | $0.06 | 0m28s |
| holdout-007 | unknown_material | ok | PASS |  | $0.07 | 0m34s |
| holdout-008 | unstocked_material | ok | PASS |  | $0.08 | 0m31s |
| holdout-009 | injection | ok | PASS |  | $0.08 | 0m31s |
| holdout-010 | clean | ok | PASS |  | $0.13 | 0m43s |
