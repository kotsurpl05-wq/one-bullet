# E2E Test Infra: One Bullet Co-op Arena

## Test Philosophy
- Opaque-box, requirement-driven, deterministic.
- VM-isolated execution via `test/helpers/server_loader.js` without network or GUI flakiness.
- Continuous coverage across 5 distinct test tiers.

## Feature Inventory & Test Mapping
| # | Feature | Requirement Source | Tier 1 (Unit/Feature) | Tier 2 (Boundary/Edge) | Tier 3 (Cross-Feature) | Tier 4 (Workload/E2E) |
|---|---------|-------------------|:---------------------:|:----------------------:|:----------------------:|:---------------------:|
| 1 | Polynomial Boss HP | ORIGINAL_REQUEST §R1 | >=5 | >=5 | ✓ | ✓ |
| 2 | Boss Multiplier (1.8) | ORIGINAL_REQUEST §R1 | >=5 | >=5 | ✓ | ✓ |
| 3 | Wave-scaled Boss XP | ORIGINAL_REQUEST §R1 | >=5 | >=5 | ✓ | ✓ |
| 4 | Second Bullet Rare | ORIGINAL_REQUEST §R1 | >=5 | >=5 | ✓ | ✓ |
| 5 | Critical 18% / 2.5x | ORIGINAL_REQUEST §R1 | >=5 | >=5 | ✓ | ✓ |
| 6 | Magnetic Field Merge | ORIGINAL_REQUEST §R1 | >=5 | >=5 | ✓ | ✓ |
| 7 | Stepped XP Curve | ORIGINAL_REQUEST §R1 | >=5 | >=5 | ✓ | ✓ |
| 8 | Revive Beacon Spawn | ORIGINAL_REQUEST §R2 | >=5 | >=5 | ✓ | ✓ |
| 9 | 3s Proximity Revive | ORIGINAL_REQUEST §R2 | >=5 | >=5 | ✓ | ✓ |
| 10 | Revive HUD & Visuals | ORIGINAL_REQUEST §R2 | >=5 | >=5 | ✓ | ✓ |
| 11 | Fallback Wave Revive | ORIGINAL_REQUEST §R2 | >=5 | >=5 | ✓ | ✓ |
| 12 | Upgrade: Boomerang | ORIGINAL_REQUEST §R3 | >=5 | >=5 | ✓ | ✓ |
| 13 | Upgrade: Splinter | ORIGINAL_REQUEST §R3 | >=5 | >=5 | ✓ | ✓ |
| 14 | Upgrade: Stun | ORIGINAL_REQUEST §R3 | >=5 | >=5 | ✓ | ✓ |
| 15 | Upgrade: Reactive Armor | ORIGINAL_REQUEST §R3 | >=5 | >=5 | ✓ | ✓ |
| 16 | Upgrade: Target Mark | ORIGINAL_REQUEST §R3 | >=5 | >=5 | ✓ | ✓ |
| 17 | Enemy: Phantom | ORIGINAL_REQUEST §R4 | >=5 | >=5 | ✓ | ✓ |
| 18 | Enemy: Magnetizer | ORIGINAL_REQUEST §R4 | >=5 | >=5 | ✓ | ✓ |
| 19 | Enemy: Twins & Tether | ORIGINAL_REQUEST §R4 | >=5 | >=5 | ✓ | ✓ |
| 20 | Visual Juice Mechanisms | ORIGINAL_REQUEST §R5 | >=5 | >=5 | ✓ | ✓ |

## Test Suites Architecture
- `test/rebalance_r1.test.js`: Boss HP scaling, multiplier 1.8, wave 30 HP >= 800, boss XP, crit 18%/2.5x, magnetic-field consolidation, XP progression.
- `test/revive_beacon_r2.test.js`: Beacon creation on death, proximity accumulation (3s), 30% HP + 1.5s invulnerability, inter-wave fallback revive with fixed `getPlayerSpawnPosition`.
- `test/upgrades_r3.test.js`: Boomerang ground damage, splinter wall ricochets, stun status & AI freeze, reactive armor radial blast & cooldown, target mark 4s 1.3x damage multiplier.
- `test/enemies_r4.test.js`: Phantom 5s phase cycle (2s intangible), magnetizer 200px trajectory bending, twin pair spawning, laser tether damage, twin enrage on death.
- `test/visuals_contract_r5.test.js`: Client AST and structure contract verification for hit-stop, bullet trails, floating numbers, catch rings, and celebration effects.
- `test/e2e_integration.test.js`: Integrated full game scenarios combining multiple waves, upgrades, boss fights, teammate revival, and win/loss states.

## Test Runner Invocation
```bash
node --test test/*.test.js
```
Expected: 100% tests passing, zero errors.
