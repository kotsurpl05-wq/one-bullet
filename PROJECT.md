# Project: One Bullet Multiplayer 2D Roguelike Audit & Hardening

## Architecture
- **Client**: `public/index.html` (Canvas-based rendering, client-side prediction, bullet simulation, solo mode loop, WebSocket client).
- **Server**: `server.js` (Node.js WebSocket/HTTP server, room management, coop game loop, authoritative boss logic, state broadcast).
- **Test Harness**: `test/` (Node.js/Jest/Mocha/custom test suites evaluating auth, abilities, empirical sync).

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | Multiplayer Synchronization & Latency | Client-authoritative coords (net:input @ 60Hz), muzzle origin bullet firing, reconciliation, bounce/hit deduplication under 50-200ms latency & jitter | M1 | ORIGINAL_REQUEST §1 |
| 2 | Boss Scaling & Mechanics Parity | Tier scaling formulas, 4 mechanics (Dash & Shockwave, Spiral Bullet Hell <33% HP, Shield & Drones @ 50% HP + 2s stun, Sniper Beam), Solo vs Coop parity | M2 | ORIGINAL_REQUEST §2 |
| 3 | Lobby & Game Lifecycle State Integrity | Host/guest ready toggling, 3s countdown, cancellation on unready/disconnect, game over restart flow, input sanitization, room auth hardening, cleanup | M3 | ORIGINAL_REQUEST §3 |
| 4 | Test Coverage & Empirical Validation | Run all test suites in test/, assess passes/failures, identify missing regressions and edge cases | M4 | ORIGINAL_REQUEST §4 |
| 5 | Synthesis, Actionable Recommendations & Benchmarks | Severity categorization (Critical, Warning, Optimization, Suggestion), remediation code snippets, benchmark scripts | M5 | ORIGINAL_REQUEST §5 |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| 1 | Netcode & Sync Audit (R1) | Deep inspection of client & server sync, latency resilience, bullet physics | none | IN_PROGRESS |
| 2 | Boss Scaling & Parity Audit (R2) | Solo (index.html) vs Coop (server.js) mechanics, tier math, 4 special moves | none | IN_PROGRESS |
| 3 | Lobby & Lifecycle Audit (R3) | Room states, countdown, ready toggling, restarts, auth, disconnect teardown | none | IN_PROGRESS |
| 4 | Test Execution & Empirical Validation (R4) | Execute test files, verify coverage gaps, empirical behavior | none | IN_PROGRESS |
| 5 | Synthesis, Adversarial Challenge & Reporting (R5) | Full consolidated report with categorized findings & benchmark scripts | M1, M2, M3, M4 | PLANNED |

## Interface Contracts
- WebSocket protocol: `net:input`, `net:state`, `room:create`, `room:join`, `room:ready`, `room:start`, `game:over`, `game:restart`.
- Boss state object: `{ hp, maxHp, x, y, vx, vy, state, phase, shield, drones, beam, shockwave }`.
- Bullet state: `{ id, x, y, vx, vy, ownerId, bounces, active }`.
