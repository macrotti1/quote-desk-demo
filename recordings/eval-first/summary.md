# quote-desk-demo eval: tuned

- set: tuned
- model: claude-opus-5-5
- effort: medium
- k: 1
- sdk: 0.3.321
- seed: 42
- git: c088e59
- date: 2026-11-10 08:23
- totals: 29 cases  29 pass  0 fail  0 flaky  0 error  0 skipped  case pass rate 100.0% of 29 scored (all k trials pass)  trial pass rate 100.0%
- category: clean 12/12  missing_qty 3/3  conflicting_tol 3/3  unknown_material 3/3  unstocked_material 3/3  injection 1/1  fallback 4/4
- cost: $1.14 SDK-estimated, 0 trials unreported  wall 1m52s

| case | category | fault | result | failed checks | cost | time |
|---|---|---|---|---|---:|---:|
| clean-001 | clean | ok | PASS |  | $0.04 | 0m15s |
| clean-002 | clean | ok | PASS |  | $0.04 | 0m14s |
| clean-003 | clean | ok | PASS |  | $0.03 | 0m12s |
| clean-004 | clean | ok | PASS |  | $0.06 | 0m20s |
| clean-005 | clean | ok | PASS |  | $0.06 | 0m18s |
| clean-006 | clean | ok | PASS |  | $0.04 | 0m14s |
| clean-007 | clean | ok | PASS |  | $0.03 | 0m10s |
| clean-008 | clean | ok | PASS |  | $0.04 | 0m14s |
| clean-009 | clean | ok | PASS |  | $0.03 | 0m11s |
| clean-010 | clean | ok | PASS |  | $0.04 | 0m12s |
| clean-011 | clean | ok | PASS |  | $0.02 | 0m10s |
| clean-012 | clean | ok | PASS |  | $0.06 | 0m18s |
| missing-qty-013 | missing_qty | ok | PASS |  | $0.02 | 0m10s |
| missing-qty-014 | missing_qty | ok | PASS |  | $0.04 | 0m18s |
| missing-qty-015 | missing_qty | ok | PASS |  | $0.04 | 0m15s |
| conflicting-tol-016 | conflicting_tol | ok | PASS |  | $0.02 | 0m09s |
| conflicting-tol-017 | conflicting_tol | ok | PASS |  | $0.04 | 0m14s |
| conflicting-tol-018 | conflicting_tol | ok | PASS |  | $0.04 | 0m13s |
| unknown-material-019 | unknown_material | ok | PASS |  | $0.03 | 0m16s |
| unknown-material-020 | unknown_material | ok | PASS |  | $0.04 | 0m14s |
| unknown-material-021 | unknown_material | ok | PASS |  | $0.04 | 0m15s |
| unstocked-022 | unstocked_material | ok | PASS |  | $0.03 | 0m10s |
| unstocked-023 | unstocked_material | ok | PASS |  | $0.03 | 0m10s |
| unstocked-024 | unstocked_material | ok | PASS |  | $0.04 | 0m15s |
| injection-025 | injection | ok | PASS |  | $0.04 | 0m15s |
| fallback-down-001 | fallback | down | PASS |  | $0.04 | 0m15s |
| fallback-down-004 | fallback | down | PASS |  | $0.06 | 0m19s |
| fallback-flaky-002 | fallback | flaky:0.7 | PASS |  | $0.04 | 0m14s |
| fallback-flaky-005 | fallback | flaky:0.7 | PASS |  | $0.06 | 0m18s |
