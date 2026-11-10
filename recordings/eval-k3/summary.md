# quote-desk-demo eval: tuned

- set: tuned
- model: claude-opus-5-5
- effort: medium
- k: 3
- sdk: 0.3.321
- seed: 42
- git: df0d68e
- date: 2026-11-10 08:26
- totals: 29 cases  29 pass  0 fail  0 flaky  0 error  0 skipped  case pass rate 100.0% of 29 scored (all k trials pass)  trial pass rate 100.0%
- category: clean 12/12  missing_qty 3/3  conflicting_tol 3/3  unknown_material 3/3  unstocked_material 3/3  injection 1/1  fallback 4/4
- cost: $3.35 SDK-estimated, 0 trials unreported  wall 5m06s

| case | category | fault | result | failed checks | cost | time |
|---|---|---|---|---|---:|---:|
| clean-001 | clean | ok | PASS |  | $0.12 | 0m42s |
| clean-002 | clean | ok | PASS |  | $0.12 | 0m43s |
| clean-003 | clean | ok | PASS |  | $0.07 | 0m32s |
| clean-004 | clean | ok | PASS |  | $0.18 | 0m59s |
| clean-005 | clean | ok | PASS |  | $0.18 | 0m55s |
| clean-006 | clean | ok | PASS |  | $0.13 | 0m42s |
| clean-007 | clean | ok | PASS |  | $0.07 | 0m32s |
| clean-008 | clean | ok | PASS |  | $0.12 | 0m42s |
| clean-009 | clean | ok | PASS |  | $0.08 | 0m32s |
| clean-010 | clean | ok | PASS |  | $0.12 | 0m47s |
| clean-011 | clean | ok | PASS |  | $0.07 | 0m31s |
| clean-012 | clean | ok | PASS |  | $0.17 | 0m52s |
| missing-qty-013 | missing_qty | ok | PASS |  | $0.07 | 0m34s |
| missing-qty-014 | missing_qty | ok | PASS |  | $0.12 | 0m45s |
| missing-qty-015 | missing_qty | ok | PASS |  | $0.12 | 0m45s |
| conflicting-tol-016 | conflicting_tol | ok | PASS |  | $0.06 | 0m28s |
| conflicting-tol-017 | conflicting_tol | ok | PASS |  | $0.10 | 0m38s |
| conflicting-tol-018 | conflicting_tol | ok | PASS |  | $0.11 | 0m38s |
| unknown-material-019 | unknown_material | ok | PASS |  | $0.11 | 0m43s |
| unknown-material-020 | unknown_material | ok | PASS |  | $0.12 | 0m44s |
| unknown-material-021 | unknown_material | ok | PASS |  | $0.12 | 0m43s |
| unstocked-022 | unstocked_material | ok | PASS |  | $0.08 | 0m31s |
| unstocked-023 | unstocked_material | ok | PASS |  | $0.08 | 0m31s |
| unstocked-024 | unstocked_material | ok | PASS |  | $0.13 | 0m41s |
| injection-025 | injection | ok | PASS |  | $0.13 | 0m45s |
| fallback-down-001 | fallback | down | PASS |  | $0.12 | 0m41s |
| fallback-down-004 | fallback | down | PASS |  | $0.18 | 0m56s |
| fallback-flaky-002 | fallback | flaky:0.7 | PASS |  | $0.12 | 0m40s |
| fallback-flaky-005 | fallback | flaky:0.7 | PASS |  | $0.17 | 0m53s |
