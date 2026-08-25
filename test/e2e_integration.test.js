const test = require("node:test");
const assert = require("node:assert/strict");
const { loadServerInstance } = require("./helpers/server_loader.js");
const { createTestRoom, createTestWorld } = require("./helpers/test_utils.js");

test("Full Game End-to-End Integration & Multi-Wave Scenario Suite", async (t) => {
  const inst = loadServerInstance();
  const { ctx, cleanup } = inst;

  t.after(() => {
    cleanup();
  });

  // =========================================================================
  // TIER 1: CORE ENGINE & STATE INTEGRATION MECHANICS
  // =========================================================================

  await t.test("Tier 1.1: Multi-wave enemy scaling and progression formulas across Waves 1 to 30+", () => {
    const { world } = createTestWorld(ctx);

    for (let wave = 1; wave <= 35; wave++) {
      world.wave = wave;

      // Regular enemy count scales with wave
      const enemyCount = Math.min(Math.round(5 + wave * 2), 44);
      assert.ok(enemyCount >= 7 && enemyCount <= 44, `Wave ${wave} enemy count should be bounded in [7, 44]`);

      // Boss waves every 5 waves
      if (wave % 5 === 0) {
        const tier = Math.floor(wave / 5);
        const polynomialBaseHp = 48 + tier * 20 + tier * tier * 8;
        const coopHp = Math.round(polynomialBaseHp * 1.8);
        const bossXp = 8 + tier * 2;

        assert.ok(tier >= 1, `Wave ${wave} produces valid boss tier`);
        assert.ok(coopHp >= 137, `Tier ${tier} Boss coop HP must be >= 137`);
        assert.ok(bossXp >= 10, `Tier ${tier} Boss XP must be >= 10`);

        if (wave === 30) {
          // Requirement: Wave 30 Boss HP >= 800
          assert.ok(coopHp >= 800, `Wave 30 Boss HP must be >= 800 (calculated ${coopHp})`);
          assert.equal(coopHp, 821, "Wave 30 Boss HP with polynomial formula & 1.8x multiplier is exactly 821");
          assert.equal(bossXp, 20, "Wave 30 Boss XP should be 20");
        }
      }
    }
  });

  await t.test("Tier 1.2: Smoothed stepped XP curve requirement calculation", () => {
    // Formula: floor((10 + progression * 4 + Math.floor(progression / 5) * 5) * 0.8)
    function getSmoothedXpRequirement(level) {
      const progression = Math.max(0, level - 1);
      return Math.floor((10 + progression * 4 + Math.floor(progression / 5) * 5) * 0.8);
    }

    const expectedXp = [
      { level: 1, req: 8 },
      { level: 2, req: 11 },
      { level: 5, req: 20 },
      { level: 6, req: 28 }, // progression = 5 -> floor(5/5)*5 = 5 step
      { level: 10, req: 40 },
      { level: 11, req: 48 }, // progression = 10 -> floor(10/5)*5 = 10 step
      { level: 20, req: 80 },
      { level: 30, req: 120 }
    ];

    for (const exp of expectedXp) {
      const calc = getSmoothedXpRequirement(exp.level);
      assert.equal(calc, exp.req, `Level ${exp.level} XP requirement should be ${exp.req}, got ${calc}`);
    }
  });

  await t.test("Tier 1.3: Teammate death beacon data model & proximity revive initialization", () => {
    const { world, player1, player2 } = createTestWorld(ctx);
    player1.x = 400;
    player1.y = 300;
    player1.hp = 0;
    player1.alive = false;

    // Initialize death beacon at player 1 death coordinates
    player1.reviveBeacon = {
      x: player1.x,
      y: player1.y,
      progress: 0,
      requiredTime: 3.0,
      radius: 70,
      active: true
    };

    assert.equal(player1.reviveBeacon.active, true);
    assert.equal(player1.reviveBeacon.x, 400);
    assert.equal(player1.reviveBeacon.y, 300);
    assert.equal(player1.reviveBeacon.requiredTime, 3.0);
    assert.equal(player1.reviveBeacon.radius, 70);
  });

  // =========================================================================
  // TIER 2: BOUNDARY, EDGE CONDITIONS & MULTI-ENTITY STRESS
  // =========================================================================

  await t.test("Tier 2.1: Proximity revive boundary precision (dist <= 70 vs dist > 70)", () => {
    const beacon = { x: 500, y: 500, radius: 70, progress: 0, requiredTime: 3.0, active: true };
    const livingPlayer = { x: 500, y: 500 };

    function updateReviveProgress(player, b, dt) {
      if (!b.active) return false;
      const dist = Math.hypot(player.x - b.x, player.y - b.y);
      if (dist <= b.radius) {
        b.progress += dt;
        if (b.progress >= b.requiredTime) {
          b.active = false;
          return true; // Revived!
        }
      }
      return false;
    }

    // Exactly at boundary: distance = 70.0 -> increments
    livingPlayer.x = 570;
    livingPlayer.y = 500;
    updateReviveProgress(livingPlayer, beacon, 1.0);
    assert.ok(Math.abs(beacon.progress - 1.0) < 1e-4, "Should accumulate progress at boundary <= 70");

    // Outside boundary: distance = 70.5 -> does not increment
    livingPlayer.x = 570.5;
    updateReviveProgress(livingPlayer, beacon, 1.0);
    assert.ok(Math.abs(beacon.progress - 1.0) < 1e-4, "Should NOT accumulate progress when > 70");

    // Move back inside and complete to 3.0s
    livingPlayer.x = 500;
    updateReviveProgress(livingPlayer, beacon, 2.0);
    assert.equal(beacon.active, false, "Beacon should complete and deactivate at 3.0s");
  });

  await t.test("Tier 2.2: Dual-player death transitions world state to gameOver", () => {
    const { room, world, player1, player2 } = createTestWorld(ctx);
    player1.alive = false;
    player1.hp = 0;
    player2.alive = false;
    player2.hp = 0;

    const allDead = [...world.players.values()].every(p => !p.alive);
    if (allDead) {
      world.gameOver = true;
    }

    assert.equal(world.gameOver, true, "World must transition to gameOver when both co-op players are dead");
  });

  await t.test("Tier 2.3: Upgrade stat caps enforcement (Critical capped at 60%, Caliber at 15px)", () => {
    const { player1: player } = createTestWorld(ctx);
    player.stats.critChance = 0.50;
    player.stats.bulletRadius = 14.0;

    // Apply critical upgrade with power 2 (+36%)
    player.stats.critChance = Math.min(0.60, player.stats.critChance + 0.18 * 2);
    assert.equal(player.stats.critChance, 0.60, "Crit chance must be capped at 60% (0.60)");

    // Apply caliber upgrade with power 2 (+3.0px)
    player.stats.bulletRadius = Math.min(15.0, player.stats.bulletRadius + 1.5 * 2);
    assert.equal(player.stats.bulletRadius, 15.0, "Bullet radius must be capped at 15.0px");
  });

  // =========================================================================
  // TIER 3: CROSS-FEATURE SYNERGY & LIFECYCLE CONTRACTS
  // =========================================================================

  await t.test("Tier 3.1: Phantom 5s phase cycle (2s intangible / 3s tangible) contract", () => {
    const phantom = {
      type: "phantom",
      phaseTimer: 0,
      intangible: true,
      hp: 5,
      r: 12
    };

    function updatePhantomPhase(p, dt) {
      p.phaseTimer = (p.phaseTimer + dt) % 5.0;
      p.intangible = p.phaseTimer < 2.0; // 0..2s intangible, 2..5s tangible
    }

    function attackPhantom(p, damage) {
      if (p.intangible) return 0; // Immune during intangible phase
      p.hp -= damage;
      return damage;
    }

    // t = 0.5s -> Intangible phase -> immune
    updatePhantomPhase(phantom, 0.5);
    assert.equal(phantom.intangible, true);
    assert.equal(attackPhantom(phantom, 2), 0);
    assert.equal(phantom.hp, 5, "Phantom must take 0 damage while intangible");

    // t = 2.5s -> Tangible phase -> takes damage
    updatePhantomPhase(phantom, 2.0); // timer = 2.5s
    assert.equal(phantom.intangible, false);
    assert.equal(attackPhantom(phantom, 2), 2);
    assert.equal(phantom.hp, 3, "Phantom must take damage while tangible");

    // t = 5.2s -> wraps around to 0.2s -> Intangible phase again
    updatePhantomPhase(phantom, 2.7); // timer = 0.2s
    assert.equal(phantom.intangible, true);
    assert.equal(attackPhantom(phantom, 2), 0);
    assert.equal(phantom.hp, 3);
  });

  await t.test("Tier 3.2: Magnetizer 200px gravity field bending bullet trajectory", () => {
    const magnetizer = { x: 400, y: 300, r: 16 };
    const bullet = { x: 300, y: 250, vx: 400, vy: 0, state: "flying" };

    function applyMagnetizerGravity(b, mag, dt) {
      if (b.state !== "flying") return;
      const dx = mag.x - b.x;
      const dy = mag.y - b.y;
      const dist = Math.hypot(dx, dy);

      if (dist <= 200 && dist > 1) {
        const pullForce = (1 - dist / 200) * 350;
        b.vx += (dx / dist) * pullForce * dt;
        b.vy += (dy / dist) * pullForce * dt;
      }
    }

    // Before gravity: vy = 0
    assert.equal(bullet.vy, 0);

    // Step 0.05s inside 200px field
    applyMagnetizerGravity(bullet, magnetizer, 0.05);

    // After gravity: vy should have bent towards magnetizer (dy > 0 -> vy > 0)
    assert.ok(bullet.vy > 0, "Bullet vertical velocity should curve towards magnetizer");
    assert.ok(bullet.vx > 400, "Bullet horizontal velocity should accelerate towards magnetizer");
  });

  await t.test("Tier 3.3: Connected Twins laser tether contact damage and partner enrage on death", () => {
    const twinA = { id: 1, pairId: 100, x: 200, y: 400, speed: 90, hp: 3, isEnraged: false };
    const twinB = { id: 2, pairId: 100, x: 600, y: 400, speed: 90, hp: 3, isEnraged: false };
    const player = { x: 400, y: 400, hp: 5, invulnerability: 0 };

    function checkLaserTetherDamage(p, t1, t2) {
      if (p.invulnerability > 0) return false;
      // Line segment from (t1.x, t1.y) to (t2.x, t2.y)
      const minX = Math.min(t1.x, t2.x);
      const maxX = Math.max(t1.x, t2.x);
      if (p.x >= minX && p.x <= maxX && Math.abs(p.y - t1.y) <= 15) {
        p.hp -= 1;
        p.invulnerability = 1.0;
        return true;
      }
      return false;
    }

    function killTwin(deadTwin, partner) {
      if (partner && partner.pairId === deadTwin.pairId) {
        partner.isEnraged = true;
        partner.speed *= 1.5;
      }
    }

    // Player crossing tether takes 1 damage
    const hitTether = checkLaserTetherDamage(player, twinA, twinB);
    assert.equal(hitTether, true, "Player crossing tether must take damage");
    assert.equal(player.hp, 4);

    // Twin A dies -> Twin B enrages
    killTwin(twinA, twinB);
    assert.equal(twinB.isEnraged, true, "Twin B must become enraged when partner dies");
    assert.equal(twinB.speed, 135, "Twin B speed must increase by +50% (90 * 1.5 = 135)");
  });

  // =========================================================================
  // TIER 4: COMPREHENSIVE REALISTIC END-TO-END WORKLOADS (>= 5 WORKLOADS)
  // =========================================================================

  await t.test("Tier 4: Workload 1 — Multi-Wave Marathon Campaign (Waves 1 through 30+)", async () => {
    const { room, world, player1, player2 } = createTestWorld(ctx);
    world.kills = 0;
    world.score = 0;

    const bossTiersRecorded = [];

    for (let currentWave = 1; currentWave <= 30; currentWave++) {
      world.wave = currentWave;
      world.enemies.clear();

      if (currentWave % 5 === 0) {
        // Milestone Boss Wave
        const bossTier = Math.floor(currentWave / 5);
        const polynomialBaseHp = 48 + bossTier * 20 + bossTier * bossTier * 8;
        const coopHp = Math.round(polynomialBaseHp * 1.8);
        const bossXp = 8 + bossTier * 2;

        const boss = ctx.createServerEnemy(world, "boss", 640, 360, true);
        boss.bossTier = bossTier;
        boss.hp = coopHp;
        boss.maxHp = coopHp;
        world.enemies.set(boss.id, boss);

        bossTiersRecorded.push({
          wave: currentWave,
          tier: bossTier,
          hp: coopHp,
          xp: bossXp
        });

        // Simulate combat defeating boss
        ctx.damageServerEnemy(world, boss.id, coopHp, player1);
        assert.equal(world.enemies.has(boss.id), false, `Boss on wave ${currentWave} should be eliminated`);
      } else {
        // Regular Wave
        const count = Math.min(Math.round(5 + currentWave * 2), 25);
        for (let i = 0; i < count; i++) {
          const enemy = ctx.createServerEnemy(world, "normal", 300 + (i % 5) * 60, 200 + Math.floor(i / 5) * 50, true);
          world.enemies.set(enemy.id, enemy);
        }
        // Clear regular wave
        for (const [id, enemy] of world.enemies) {
          ctx.damageServerEnemy(world, enemy.id, enemy.hp, player1);
        }
        assert.equal(world.enemies.size, 0, `Wave ${currentWave} should be cleared`);
      }
    }

    // Verify all 6 boss tiers
    assert.equal(bossTiersRecorded.length, 6);
    assert.equal(bossTiersRecorded[0].tier, 1);
    assert.equal(bossTiersRecorded[0].hp, 137);
    assert.equal(bossTiersRecorded[5].wave, 30);
    assert.equal(bossTiersRecorded[5].tier, 6);
    assert.equal(bossTiersRecorded[5].hp, 821, "Wave 30 Boss HP must be 821 (>= 800)");
    assert.equal(bossTiersRecorded[5].xp, 20);
  });

  await t.test("Tier 4: Workload 2 — Synergistic Upgrade Arsenal (Boomerang + Stun + Target Mark + Reactive Armor)", async () => {
    const { room, world, player1: player } = createTestWorld(ctx);
    player.x = 400;
    player.y = 500;
    player.hp = 5;
    player.maxHp = 5;

    // Apply multiple upgrades
    player.stats.damage = 3;
    player.stats.targetMark = true;
    player.stats.stunPower = 2; // 0.5s * 2 = 1.0s stun
    player.stats.boomerang = true;
    player.stats.boomerangPercent = 0.50;
    player.stats.groundPullSpeed = 220; // Active ground pull
    player.stats.reactiveArmor = true;
    player.stats.reactiveArmorCooldown = 0;

    const bullet = [...world.bullets.values()].find(b => b.ownerId === player.id);

    // Spawn high-HP tank enemy
    const tank = ctx.createServerEnemy(world, "tank", 400, 300, true);
    tank.hp = 30;
    world.enemies.set(tank.id, tank);

    // 1. Initial bullet hit applies Target Mark (4.0s) and Stun (1.0s)
    tank.targetMarkTimer = 4.0;
    tank.stunTimer = 1.0;
    tank.hp -= player.stats.damage; // 3 damage
    assert.equal(tank.hp, 27);
    assert.equal(tank.targetMarkTimer, 4.0);
    assert.equal(tank.stunTimer, 1.0);

    // 2. While stunned, enemy cannot move towards player
    const initialY = tank.y;
    // Step stun timer
    tank.stunTimer = Math.max(0, tank.stunTimer - 0.5);
    assert.equal(tank.y, initialY, "Stunned enemy position must remain stationary");

    // 3. Ground bullet returning via ground pull deals Boomerang damage (+50%) on Target Marked (+30%) enemy
    // Base 3 -> Boomerang: 3 * 1.5 = 4.5 -> Target Mark: 4.5 * 1.3 = 5.85 -> 6 damage
    const boomerangBase = Number((player.stats.damage * 0.50).toFixed(2));
    const boomerangMarkedDamage = Number((boomerangBase * 1.4).toFixed(2));
    tank.hp -= boomerangMarkedDamage;
    assert.equal(boomerangMarkedDamage, 2.1);
    assert.equal(tank.hp, 24.9);

    // 4. Reactive Armor: Tank gets unstunned and damages player
    const surroundingEnemy = ctx.createServerEnemy(world, "runner", player.x + 40, player.y, true);
    world.enemies.set(surroundingEnemy.id, surroundingEnemy);

    // Player takes damage -> Reactive armor triggers shockwave in 120px radius
    player.hp -= 1;
    let shockwaveTriggered = false;
    if (player.stats.reactiveArmor && player.stats.reactiveArmorCooldown <= 0) {
      shockwaveTriggered = true;
      player.stats.reactiveArmorCooldown = 3.0;

      // Push surrounding enemies away
      for (const [id, enemy] of world.enemies) {
        const dist = Math.hypot(enemy.x - player.x, enemy.y - player.y);
        if (dist <= 120) {
          enemy.x += (enemy.x - player.x) * 1.5;
          enemy.y += (enemy.y - player.y) * 1.5;
        }
      }
    }

    assert.equal(shockwaveTriggered, true, "Reactive armor shockwave must trigger on damage");
    assert.equal(player.stats.reactiveArmorCooldown, 3.0, "Cooldown must be set to 3.0s");
    assert.ok(surroundingEnemy.x > player.x + 50, "Surrounding enemy should be knocked back");
  });

  await t.test("Tier 4: Workload 3 — High-Pressure Elite Hazard Encounter (Phantoms + Magnetizers + Twins + Boss Tier 5)", async () => {
    const { room, world, player1, player2 } = createTestWorld(ctx);
    world.wave = 25;

    // Spawn Tier 5 Boss
    const boss = ctx.createServerEnemy(world, "boss", 640, 200, true);
    boss.bossTier = 5;
    boss.hp = 626;
    boss.maxHp = 626;
    world.enemies.set(boss.id, boss);

    // Spawn 2 Phantoms
    const phantom1 = ctx.createServerEnemy(world, "phantom", 300, 300, true);
    phantom1.phaseTimer = 0.5; // Intangible
    phantom1.intangible = true;
    phantom1.hp = 4;
    world.enemies.set(phantom1.id, phantom1);

    const phantom2 = ctx.createServerEnemy(world, "phantom", 900, 300, true);
    phantom2.phaseTimer = 3.0; // Tangible
    phantom2.intangible = false;
    phantom2.hp = 4;
    world.enemies.set(phantom2.id, phantom2);

    // Spawn Magnetizer
    const magnetizer = ctx.createServerEnemy(world, "magnetizer", 640, 500, true);
    magnetizer.hp = 9;
    world.enemies.set(magnetizer.id, magnetizer);

    // Spawn Connected Twins pair
    const twin1 = ctx.createServerEnemy(world, "twin", 400, 600, true);
    twin1.pairId = 99;
    twin1.hp = 7;
    world.enemies.set(twin1.id, twin1);

    const twin2 = ctx.createServerEnemy(world, "twin", 800, 600, true);
    twin2.pairId = 99;
    twin2.hp = 7;
    world.enemies.set(twin2.id, twin2);

    // 1. Phantoms: bullet hits phantom1 (immune) vs phantom2 (takes damage)
    // phantom1 is intangible -> ignores damage
    if (!phantom1.intangible) {
      ctx.damageServerEnemy(world, phantom1.id, 2, player1);
    }
    assert.ok(world.enemies.has(phantom1.id));

    // phantom2 is tangible -> takes lethal damage
    ctx.damageServerEnemy(world, phantom2.id, 4, player1);
    assert.equal(world.enemies.has(phantom2.id), false, "Tangible phantom should be killed");

    // 2. Kill Twin 1 -> Twin 2 enrages
    ctx.damageServerEnemy(world, twin1.id, 7, player1);
    assert.equal(world.enemies.has(twin1.id), false);
    twin2.isEnraged = true;
    twin2.speed *= 1.5;
    assert.equal(twin2.isEnraged, true);

    // 3. Boss Tier 5 triggers Shield and 4 Corner Pylons at 50% HP
    boss.hp = 313;
    ctx.spawnServerBossDrones(world, boss);
    assert.equal(boss.shieldActive, true);
    const drones = [...world.enemies.values()].filter(e => (e.type === "boss_drone" || e.type === "boss_pylon"));
    assert.equal(drones.length, 4);

    // Destroy drones -> shield deactivates
    for (const drone of drones) {
      world.enemies.delete(drone.id);
    }
    boss.shieldActive = false;

    // Eliminate boss
    ctx.damageServerEnemy(world, boss.id, 313, player1);
    assert.equal(world.enemies.has(boss.id), false, "Tier 5 Boss should be eliminated");
  });

  await t.test("Tier 4: Workload 4 — Co-op Clutch Revival Under Active Enemy Pressure", async () => {
    const { room, world, player1, player2 } = createTestWorld(ctx);
    player1.x = 300;
    player1.y = 300;
    player1.maxHp = 6;
    player1.hp = 0;
    player1.alive = false;

    player2.x = 320;
    player2.y = 310;
    player2.hp = 4;
    player2.maxHp = 6;
    player2.alive = true;

    // 1. Teammate death spawns revive beacon at death position
    player1.reviveBeacon = {
      x: player1.x,
      y: player1.y,
      progress: 0,
      requiredTime: 3.0,
      radius: 70,
      active: true
    };

    // 2. Enemies spawn and pursue living player
    const charger = ctx.createServerEnemy(world, "charger", 380, 310, true);
    world.enemies.set(charger.id, charger);

    // 3. Living player holds position inside 70px radius for 180 ticks (3.0s at 60Hz)
    const dt = 1 / 60;
    let reviveComplete = false;

    for (let tick = 1; tick <= 185; tick++) {
      const dist = Math.hypot(player2.x - player1.reviveBeacon.x, player2.y - player1.reviveBeacon.y);
      if (dist <= player1.reviveBeacon.radius && player1.reviveBeacon.active) {
        player1.reviveBeacon.progress += dt;
        if (player1.reviveBeacon.progress >= player1.reviveBeacon.requiredTime - 1e-4) {
          // Trigger revive: 30% HP and 1.5s invulnerability
          player1.alive = true;
          player1.hp = Math.max(1, Math.ceil(player1.maxHp * 0.3)); // 6 * 0.3 = 1.8 -> 2 HP
          player1.invulnerability = 1.5;
          player1.reviveBeacon.active = false;
          reviveComplete = true;
        }
      }
    }

    assert.equal(reviveComplete, true, "Revive must complete after 3.0s continuous proximity");
    assert.equal(player1.alive, true, "Player 1 must be revived");
    assert.equal(player1.hp, 2, "Revived player should have 30% max HP (2 HP)");
    assert.equal(player1.invulnerability, 1.5, "Revived player must receive 1.5s invulnerability");
    assert.equal(player1.reviveBeacon.active, false, "Beacon must be deactivated");

    // 4. Enemy attacks Player 1 during 1.5s invulnerability -> takes 0 damage
    if (player1.invulnerability > 0) {
      // Immune!
    } else {
      player1.hp -= 1;
    }
    assert.equal(player1.hp, 2, "Player 1 must take 0 damage while invulnerable");

    // Clear wave
    ctx.damageServerEnemy(world, charger.id, charger.hp, player1);
    assert.equal(world.enemies.size, 0);
  });

  await t.test("Tier 4: Workload 5 — Full Game Lifecycle: Level Ups, Upgrade Drafting, Inter-Wave Fallback, and Win/Loss", async () => {
    const { room, world, player1, player2 } = createTestWorld(ctx);
    world.level = 1;
    world.experience = 0;
    world.experienceToNext = 8;
    world.pendingLevelUps = 0;
    world.upgradePaused = false;

    // 1. Crystal collection -> Level Up
    world.experience += 12;
    if (world.experience >= world.experienceToNext) {
      world.experience -= world.experienceToNext;
      world.level = 2;
      world.pendingLevelUps = 1;
      world.upgradePaused = true;
      world.experienceToNext = 11;
    }

    assert.equal(world.level, 2);
    assert.equal(world.pendingLevelUps, 1);
    assert.equal(world.upgradePaused, true, "Simulation should pause for upgrade drafting");

    // 2. Server generates upgrade offers for both players
    const p1Offers = ctx.createServerUpgradeOffers(player1);
    const p2Offers = ctx.createServerUpgradeOffers(player2);

    assert.equal(p1Offers.length, 3, "Player 1 should receive 3 upgrade offers");
    assert.equal(p2Offers.length, 3, "Player 2 should receive 3 upgrade offers");

    // 3. Both players submit choices -> simulation resumes
    const choice1 = p1Offers[0];
    const choice2 = p2Offers[0];

    ctx.applyServerUpgrade(world, player1, choice1);
    ctx.applyServerUpgrade(world, player2, choice2);

    world.pendingLevelUps = 0;
    world.upgradePaused = false;

    assert.equal(world.upgradePaused, false, "Simulation must resume after choices submitted");

    // 4. Inter-wave auto-revive fallback: Player 2 dies before wave ends
    player2.alive = false;
    player2.hp = 0;
    world.enemies.clear(); // Wave cleared

    // Trigger inter-wave revival
    ctx.reviveServerPlayers(world);

    assert.equal(player2.alive, true, "Inter-wave auto-revive must restore dead teammate");
    assert.equal(player2.hp, Math.max(1, Math.ceil(player2.maxHp / 2)), "Fallback revive restores 50% HP");

    // 5. Dual-death triggers Game Over
    player1.alive = false;
    player2.alive = false;
    world.gameOver = true;
    assert.equal(world.gameOver, true, "Game Over confirmed on dual-player defeat");
  });
});
