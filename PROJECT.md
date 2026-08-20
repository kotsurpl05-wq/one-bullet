# Project: One Bullet Co-op Bugfix, Desync Resolution, Upgrades & Stability

## Architecture
- **Server**: Node.js + Express + Socket.IO (`server.js`). Authoritative 60 Hz simulation for world state, enemy AI, wave spawning, combat collisions, player stats/upgrades, room lifecycle, and snapshot broadcasting.
- **Client**: Vanilla JavaScript + Canvas (`public/index.html`, `public/network.js`). Client-side prediction for responsive local movement, smooth interpolation for remote players and local server reconciliation, socket event communication with volatile transport for continuous inputs.

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | R1.1 Server Reconciliation | Smooth interpolation (dt * 6.0 convergence <=500ms) when client-server desync > 50px | M1 | Survey E1 |
| 2 | R1.2 Volatile Input Emission | `socket.volatile.emit("net:input")` to drop stale packets during network lag | M1 | Survey E1 |
| 3 | R1.3 InputTimer Precision | `inputTimer -= COOP_INPUT_INTERVAL` instead of `= 0` to preserve sampling accuracy | M1 | Survey E1 |
| 4 | R1.4 Uninterrupted Prediction | Remove freeze on `waitingForSnapshot` so client simulation predicts immediately | M1 | Survey E1 |
| 5 | R1.5 Request Timeout | `request()` in `network.js` has timeout (6s <= 10s) and resolves gracefully on timeout | M1 | Survey E1 |
| 6 | R2.1 Impulse Catch (`catchBlast`) | `catchServerBullet` deals 1 dmg to enemies within `catchBlast + enemy.r` of catching player | M2 | Survey E2 |
| 7 | R2.2 Emergency Repair (`healEvery`) | `killServerEnemy` tracks `repairKillProgress`, heals +1 HP on reaching `healEvery` with 1.75s cooldown | M2 | Survey E2 |
| 8 | R3.1 `room:restart` Host Validation | Reject restart requests from non-host players | M2 | Survey E2 |
| 9 | R3.2 `room:return-to-lobby` Auth | Reject return-to-lobby requests from non-host players | M2 | Survey E2 |
| 10 | R3.3 `room:set-difficulty` Validation | Validate difficulty against `["easy", "normal", "hard"]` and forbid during active game | M2 | Survey E2 |
| 11 | R3.4 Shoot Position Drift Clamp | Tighten `shootServerBullet` position teleport from 180px to <= 60px | M2 | Survey E2 |
| 12 | R4.1 "Shooter" Enemy Integration | Add shooter to wave spawning (wave >= 5, roll < 0.22), stats factory, and 2-crystal XP | M2 | Survey E3 |
| 13 | R4.2 Inactive Room GC | Periodic GC (60s) cleaning rooms inactive > 15m or empty, with `touchRoom()` on all events | M2 | Survey E3 |
| 14 | R5 Automated Test Suite & E2E | Comprehensive automated test suite (`node --test`), syntax check, server startup verification | M3 | Survey E1/E2/E3 |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Client Desync & Network Hardening | `public/network.js`, `public/index.html` (Reconciliation lerp, volatile input, inputTimer, prediction, timeout) | none | IN_PROGRESS |
| M2 | Server Logic Hardening | `server.js` (R2 Upgrades: catchBlast & healEvery, R3 Auth & Teleport clamp, R4 Shooter Enemy & Inactive GC) | none | PLANNED |
| M3 | Test Suite & E2E Verification | `package.json`, `test/*.test.js` (Automated unit/integration tests for R1-R4, E2E validation, server boot) | M1, M2 | PLANNED |

## Interface Contracts
### Client ↔ Server Movement & Reconciliation
- `net:input`: Volatile packet `{ dx, dy, aimX, aimY }` sent at 60 Hz.
- `net:snapshot`: Broadcast containing `players: [{ id, x, y, hp, maxHp, stats, ... }]`.
- Local player predicts at 60 FPS. If `hypot(serverX - x, serverY - y) > 50px`, lerps towards `(serverX, serverY)` via `dt * 6.0`.
- If `hypot(serverX - x, serverY - y) > 300px`, snaps immediately to `(serverX, serverY)`.

### Client ↔ Server Room Management
- `room:restart`: Requires `room.hostId === socket.id`. Emits `room:started` and initial snapshot.
- `room:return-to-lobby`: Requires `room.hostId === socket.id`. Emits `room:returned-to-lobby`.
- `room:set-difficulty`: Requires `room.hostId === socket.id` and `!room.started`. Accepts only `"easy" | "normal" | "hard"`.

### Co-op Upgrades Contract
- `player.stats.catchBlast`: Integer radius (e.g. 65, 130). When bullet is caught, damages enemies within `radius + enemy.r` for 1 dmg.
- `player.stats.healEvery`: Target kill count (e.g. 15, 10, 5). When `repairKillProgress` reaches `healEvery`, heals +1 HP up to `player.maxHp`, resets progress to 0 (or clamps to `healEvery - 1` if full HP), and triggers 1.75s cooldown.

### Shooter Enemy Contract
- Type: `"shooter"`. Radius: 14, Color: `"#50d890"`, Speed: `48 + level * 1.3`, HP: `2 + Math.floor(level / 6)`.
- Spawns at Wave >= 5, roll < 0.22. Drops 2 crystals.

### Room Lifecycle Contract
- Rooms track `lastActivity: number` (timestamp).
- Any socket interaction or input in the room updates `lastActivity = Date.now()`.
- Sweeper checks every 60s: if `Date.now() - lastActivity > 15 * 60 * 1000` or `players.size === 0`, closes room and notifies players.

## Code Layout
- `server.js` — Main server entry point and game world simulation.
- `public/network.js` — Client network manager (`NetworkManager`).
- `public/index.html` — Client game engine, rendering, prediction loop, solo mode, co-op UI.
- `package.json` — NPM project configuration and test runner scripts.
- `test/` — Unit and integration tests (`node --test`).
