# QA-Core eval results

_Generated 2026-06-09T13:18:12.771Z_

| Site | Scenarios | Tests | Passed | Failed | Flaky | Pass-rate | Cost (USD) | Tokens | Time |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| saucedemo | 5 | 6 | 6 | 0 | 0 | 100% | 0.2762 | 11526 | 117s |
| the-internet | 3 | 4 | 2 | 2 | 0 | 50% | 0.2800 | 12935 | 247s |
| practice-todo | 3 | 4 | 3 | 1 | 0 | 75% | 0.2378 | 8927 | 96s |

## Reality-check replay & stability iteration

| Site | Replay pass | Replay fail | Stable | Flaky | Broken | flake_rate |
|---|---:|---:|---:|---:|---:|---:|
| saucedemo | 5 | 0 | 5 | 0 | 0 | 0.0% |
| the-internet | 4 | 1 | 3 | 1 | 0 | 25.0% |
| practice-todo | 3 | 0 | 3 | 0 | 0 | 0.0% |

**Aggregate:** 11/14 tests passed (79%) · $0.7941 total cost across 3 sites.

## Selector cascade distribution

| Site | role | label | testid | css |
|---|---:|---:|---:|---:|
| saucedemo | 15 | 0 | 0 | 4 |
| the-internet | 12 | 0 | 0 | 6 |
| practice-todo | 16 | 0 | 0 | 5 |