# Project: One Bullet Co-op Arena Enhancement (R1–R5)

## Architecture
"One Bullet" is a 2-player cooperative and solo bullet-hell arena game.
- **Backend (`server.js`)**: Authoritative Node.js + Express + Socket.IO server running 60Hz physics and game simulation. Emits 20Hz state snapshots (`coop-server-v4`) to clients.
- **Frontend (`public/index.html`)**: Vanilla JavaScript HTML5 Canvas client. Runs solo local authoritative simulation and co-op client rendering with prediction, lerp reconciliation, UI, particle effects, and sound engine.
- **Test Infrastructure (`test/`)**: Node built-in test runner (`node:test`, `node:assert/strict`) with `test/helpers/server_loader.js` VM isolation framework.

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | Polynomial Boss HP Scaling | Boss HP scales with `48 + tier * 20 + tier * tier * 8` (`tier = Math.floor(wave / 5)`). | M1 | ORIGINAL_REQUEST §R1 |
| 2 | Co-op Boss HP Multiplier | `COOP_BOSS_HP_MULTIPLIER` set to 1.8. Boss HP on Wave 30 >= 800 (actual 821). | M1 | ORIGINAL_REQUEST §R1 |
| 3 | Wave-Scaled Co-op Boss XP | Boss XP in co-op scales with `8 + bossTier * 2` matching solo mode. | M1 | ORIGINAL_REQUEST §R1 |
| 4 | Second Bullet Rare Rarity | `second-bullet` upgrade fixed rarity changed from `"common"` to `"rare"`. | M1 | ORIGINAL_REQUEST §R1 |
| 5 | Critical Mechanism Rebalance | Critical chance bonus set to +18% per common power (`0.18 * power`), crit multiplier set to 2.5x. | M1 | ORIGINAL_REQUEST §R1 |
| 6 | Magnetic Field Consolidation | Merge `pickup` and `recall-magnet` into «Магнитное поле» (`magnetic-field` / `pickup`). | M1 | ORIGINAL_REQUEST §R1 |
| 7 | Smoothed Stepped XP Curve | XP curve formula `10 + progression * 4 + Math.floor(progression / 5) * 5` where `progression = level - 1`. | M1 | ORIGINAL_REQUEST §R1 |
| 8 | Manual Revive Beacon Spawn | Teammate death leaves a beacon at death coordinates in co-op. | M2 | ORIGINAL_REQUEST §R2 |
| 9 | 3s Proximity Revive Mechanic | Living player within beacon radius (70-75px) for 3.0s revives partner with 30% HP and 1.5s invulnerability. | M2 | ORIGINAL_REQUEST §R2 |
| 10 | Revive Visuals & HUD Sync | Pulsing beacon in arena, circular revive progress ring, and teammate HUD indicator synced to both players. | M2 | ORIGINAL_REQUEST §R2 |
| 11 | Fallback Wave Auto-Revive | Preserve between-wave auto-revive at 50% HP and fix `getPlayerSpawnPosition` bug in server.js. | M2 | ORIGINAL_REQUEST §R2 |
| 12 | Upgrade: Boomerang | Returning ground bullet (`groundPullSpeed > 0`) deals +50% damage and gains +1 pierce. | M3 | ORIGINAL_REQUEST §R3 |
| 13 | Upgrade: Splinter Ricochet | Wall bounce spawns 2 homing shard projectiles living 1.5s, each dealing 25% damage. | M3 | ORIGINAL_REQUEST §R3 |
| 14 | Upgrade: Kinetic Strike (Stun) | Bullet hit inflicts `stunTimer = 0.5s * power`; enemy skips movement and attacks while stunned. | M3 | ORIGINAL_REQUEST §R3 |
| 15 | Upgrade: Reactive Armor | Taking damage emits 120px shockwave pushing enemies away; 3.0s cooldown. | M3 | ORIGINAL_REQUEST §R3 |
| 16 | Upgrade: Target Mark | Bullet hit marks enemy for 4.0s; marked enemy takes +30% damage (1.3x multiplier) from all sources. | M3 | ORIGINAL_REQUEST §R3 |
| 17 | Enemy: Phantom | Spawns wave 10+. $r=12, v=75+2w, \text{HP}=1+\lfloor w/8\rfloor$. 5s phase cycle (2s intangible/invulnerable, 3s tangible). | M4 | ORIGINAL_REQUEST §R4 |
| 18 | Enemy: Magnetizer | Spawns wave 8+. $r=16, v=40+1.2w, \text{HP}=3+\lfloor w/4\rfloor$, color `#c084fc`. Bends flying bullet paths within 200px. | M4 | ORIGINAL_REQUEST §R4 |
| 19 | Enemy: Connected Twins | Spawns wave 12+ in pairs. $r=10, v=90+2w, \text{HP}=2+\lfloor w/5\rfloor$. Laser line damages player. Partner enrages (+50% speed, red glow) on death. | M4 | ORIGINAL_REQUEST §R4 |
| 20 | Visual Juice: Hit Stop | ~40ms client rendering freeze / frame hold on boss kill and critical hit. | M5 | ORIGINAL_REQUEST §R5 |
| 21 | Visual Juice: Bullet Trails | Flying bullets emit fading particle trail matching player's primary color. | M5 | ORIGINAL_REQUEST §R5 |
| 22 | Visual Juice: Floating Damage Numbers | Floating damage popups on enemy hits: yellow for normal, red + enlarged font for crits. | M5 | ORIGINAL_REQUEST §R5 |
| 23 | Visual Juice: Intercept Catch Wave | Expanding ripple ring rendered when bullet is caught. | M5 | ORIGINAL_REQUEST §R5 |
| 24 | Visual Juice: Boss Kill Celebration | 0.3s time slowdown + dramatic 60+ particle explosion + multi-ring shockwaves on boss defeat. | M5 | ORIGINAL_REQUEST §R5 |
| 25 | Comprehensive Test & Verification | 100% passing E2E and unit test suite across all 5 requirement tiers and adversarial stress tests. | M6 | ORIGINAL_REQUEST Acceptance Criteria |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Rebalance & Foundation (R1) | Polynomial Boss HP, multiplier 1.8, boss XP, second-bullet rare, crit 18%/2.5x, magnetic-field consolidation, XP curve | none | PLANNED |
| M2 | Co-op Teammate Revival (R2) | Beacon creation, 3s proximity revive, 30% HP + 1.5s invulnerability, snapshot sync, visual beacon & progress bar, wave auto-revive fix | M1 | PLANNED |
| M3 | 5 New Upgrades (R3) | Boomerang, Splinter, Stun, Reactive Armor, Target Mark logic, stats, offers, and visuals across server and client | M1 | PLANNED |
| M4 | 3 New Enemy Types (R4) | Phantom, Magnetizer, Connected Twins creation, AI, mechanics, wave thresholds, and rendering | M1 | PLANNED |
| M5 | Visual Juice Pipeline (R5) | Hit stop, bullet trails, floating damage numbers, catch wave, boss kill celebration in client | M1, M2, M3, M4 | PLANNED |
| M6 | E2E Testing & Verification | Comprehensive test suites across Tiers 1-5, unit/system tests, and adversarial coverage hardening | M1, M2, M3, M4, M5 | PLANNED |

## Interface Contracts
### Snapshot Protocol (`net:snapshot`)
```typescript
interface CoopSnapshotV4 {
  type: "coop-server-v4";
  serverTime: number;
  players: Array<{
    id: string;
    x: number;
    y: number;
    hp: number;
    maxHp: number;
    alive: boolean;
    invulnerability: number;
    reviveBeacon?: {
      x: number;
      y: number;
      progress: number;
      requiredTime: number; // 3.0
      radius: number; // 70
      active: boolean;
    };
  }>;
  enemies: Array<{
    id: number;
    type: string;
    x: number;
    y: number;
    hp: number;
    maxHp: number;
    r: number;
    stunTimer?: number;
    isPhased?: boolean;
    targetMarked?: boolean;
    twinPartnerId?: number;
    isEnraged?: boolean;
  }>;
  bullets: Array<{
    id: number;
    ownerId: string;
    x: number;
    y: number;
    vx: number;
    vy: number;
    state: "held" | "flying" | "ground";
  }>;
}
```

### Upgrade Data Schema
- `id`: Unique identifier string
- `title`: Localized title
- `description`: Localized description
- `fixedRarity`: Optional string `"common"` | `"rare"` | `"legendary"`
- `available(player)`: Boolean condition function
- `bonus(player, power)`: Localized dynamic tooltip string
- `apply(player, power)` / `applyWithPower(power)`: Modifier application

## Code Layout
- `server.js`: Authoritative server logic, physics, enemy AI, wave spawning, upgrade engine, socket communication.
- `public/index.html`: Client solo simulation, co-op rendering, prediction, particle engines, HUD, audio, UI.
- `test/`: Test suites executed via `node --test test/*.test.js`.
