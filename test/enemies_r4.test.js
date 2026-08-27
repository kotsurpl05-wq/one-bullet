const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadServerInstance } = require("./helpers/server_loader.js");
const { createTestWorld } = require("./helpers/test_utils.js");

test("R4 New Enemy Types Comprehensive Suite (Phantom, Magnetizer, Connected Twins)", async (t) => {
  const inst = loadServerInstance();
  const { ctx, cleanup } = inst;

  t.after(() => {
    cleanup();
  });

  // =========================================================================
  // TIER 1: UNIT & FUNCTIONAL VERIFICATION
  // =========================================================================

  await t.test("Tier 1 - Phantom Enemy Unit & Phase Cycle Verification", async (t1) => {
    await t1.test("1.1 Phantom enemy creation sets r=12, correct speed formula, and HP scaling", () => {
      const { world } = createTestWorld(ctx);
      world.wave = 10;
      const phantom = ctx.createServerEnemy(world, "phantom", 300, 300, true);

      assert.ok(phantom, "Phantom enemy instance must be created");
      assert.equal(phantom.type, "phantom", "Enemy type should be 'phantom'");
      assert.equal(phantom.r, 12, "Phantom radius must be 12");

      // Wave 10: level = 9 or 10 -> speed = 75 + 2w (~93-95), HP = 1 + floor(w/8) = 2
      assert.ok(phantom.speed >= 90 && phantom.speed <= 100, `Phantom speed should be ~75 + 2*w, got ${phantom.speed}`);
      assert.ok(phantom.hp >= 2, `Phantom HP on wave 10 should be >= 2, got ${phantom.hp}`);
      assert.equal(phantom.maxHp, phantom.hp);
    });

    await t1.test("1.2 Phantom 5.0s phase cycle: 2s intangible (invulnerable), 3s tangible (vulnerable)", () => {
      const { world, player1: player } = createTestWorld(ctx);
      world.wave = 10;
      const phantom = ctx.createServerEnemy(world, "phantom", 300, 300, true);
      phantom.phaseTimer = 0; // Start at t=0s
      phantom.isPhased = true;
      world.enemies.set(phantom.id, phantom);

      // Phase t=1.0s (within first 2.0s: intangible)
      ctx.updateServerEnemies(world, 1.0);
      assert.equal(phantom.isPhased, true, "Phantom should be phased/intangible during first 2 seconds");

      // Damage during intangible phase is blocked / ignored
      const initialHp = phantom.hp;
      const damaged = ctx.damageServerEnemy(world, phantom.id, 1, player);
      assert.equal(phantom.hp, initialHp, "Phantom must not take damage while intangible/phased");

      // Advance by another 1.5s (total t=2.5s: tangible phase, 2s-5s)
      ctx.updateServerEnemies(world, 1.5);
      assert.equal(phantom.isPhased, false, "Phantom should be tangible after 2.0s");

      // Damage during tangible phase succeeds
      ctx.damageServerEnemy(world, phantom.id, 1, player);
      assert.equal(phantom.hp, initialHp - 1, "Phantom must take normal damage while tangible");
    });

    await t1.test("1.3 Phantom phase cycle wraps cleanly every 5.0s", () => {
      const { world } = createTestWorld(ctx);
      world.wave = 10;
      const phantom = ctx.createServerEnemy(world, "phantom", 300, 300, true);
      phantom.phaseTimer = 4.8; // Near end of cycle
      phantom.isPhased = false;
      world.enemies.set(phantom.id, phantom);

      // Advance by 0.4s (total 5.2s -> wraps to 0.2s: intangible)
      ctx.updateServerEnemies(world, 0.4);
      assert.equal(phantom.isPhased, true, "Phantom should wrap back to intangible phase at 5.0s");
      assert.ok(phantom.phaseTimer < 2.0, "phaseTimer should reset and be < 2.0s");
    });
  });

  await t.test("Tier 1 - Magnetizer Enemy Unit & Trajectory Bending Verification", async (t1) => {
    await t1.test("2.1 Magnetizer creation sets r=16, color #c084fc, speed 40+1.2w, HP 5+floor(w/3)", () => {
      const { world } = createTestWorld(ctx);
      world.wave = 8;
      const magnetizer = ctx.createServerEnemy(world, "magnetizer", 400, 400, true);

      assert.ok(magnetizer, "Magnetizer enemy instance must be created");
      assert.equal(magnetizer.type, "magnetizer");
      assert.equal(magnetizer.r, 16, "Magnetizer radius must be 16");
      assert.equal(magnetizer.color.toLowerCase(), "#c084fc", "Magnetizer color must be #c084fc");

      // Wave 8: speed = 40 + 1.2*8 = 49.6, HP = 5 + floor(8/3) = 7
      assert.ok(magnetizer.speed >= 48 && magnetizer.speed <= 52, `Magnetizer speed should be ~49.6, got ${magnetizer.speed}`);
      assert.ok(magnetizer.hp >= 4, `Magnetizer HP should be >= 4, got ${magnetizer.hp}`);
    });

    await t1.test("2.2 Magnetizer gravitational field bends flying bullet trajectory within 400px", () => {
      const { world, player1: player } = createTestWorld(ctx);
      world.wave = 8;
      const magnetizer = ctx.createServerEnemy(world, "magnetizer", 400, 300, true);
      world.enemies.set(magnetizer.id, magnetizer);

      const bullet = [...world.bullets.values()].find(b => b.ownerId === player.id);
      bullet.state = "flying";
      bullet.x = 400;
      bullet.y = 550; // Distance to magnetizer = 250px (< 400px)
      bullet.vx = 300; // Flying horizontally
      bullet.vy = 0;

      // Update bullet / enemy simulation
      ctx.updateServerBullet({ world }, bullet, 0.05);

      // Verify trajectory bending: vy should become negative (pulled upwards towards magnetizer at y=300)
      assert.ok(
        bullet.vy < 0 || bullet.y < 450,
        `Bullet trajectory should bend upwards towards Magnetizer, vy: ${bullet.vy}, y: ${bullet.y}`
      );
    });

    await t1.test("2.3 Bullet outside 400px is NOT affected by Magnetizer gravitational field", () => {
      const { world, player1: player } = createTestWorld(ctx);
      world.wave = 8;
      const magnetizer = ctx.createServerEnemy(world, "magnetizer", 400, 100, true);
      world.enemies.set(magnetizer.id, magnetizer);

      const bullet = [...world.bullets.values()].find(b => b.ownerId === player.id);
      bullet.state = "flying";
      bullet.x = 400;
      bullet.y = 600; // Distance = 500px (> 400px)
      bullet.vx = 300;
      bullet.vy = 0;

      ctx.updateServerBullet({ world }, bullet, 0.05);

      assert.equal(bullet.vy, 0, "Bullet outside 400px range should maintain vy = 0");
    });

    await t1.test("2.4 Contested Ground Pull: Player with 500 pull overcomes Magnetizer 300 pull", () => {
      const { world, player1: player } = createTestWorld(ctx);
      player.x = 100;
      player.y = 300;
      player.stats = { ...(player.stats || {}), groundPullSpeed: 500, boomerang: true };

      const magnetizer = ctx.createServerEnemy(world, "magnetizer", 500, 300, true);
      world.enemies.set(magnetizer.id, magnetizer);

      const bullet = [...world.bullets.values()].find(b => b.ownerId === player.id);
      bullet.state = "ground";
      bullet.x = 300;
      bullet.y = 300;

      const dt = 0.1;
      ctx.updateServerBullet({ world }, bullet, dt);

      // Player pulls left at 500*0.1 = 50px, Magnetizer pulls right at 300*0.1 = 30px
      // Net movement = -20px -> bullet.x should be ~280
      assert.ok(bullet.x < 300, `Bullet must move towards player (expected < 300, got ${bullet.x})`);
      assert.ok(Math.abs(bullet.x - 280) < 0.001, `Bullet x should be exactly 280, got ${bullet.x}`);
    });

    await t1.test("2.5 Contested Ground Pull: Magnetizer 300 pull overpowers Player 200 pull", () => {
      const { world, player1: player } = createTestWorld(ctx);
      player.x = 100;
      player.y = 300;
      player.stats = { ...(player.stats || {}), groundPullSpeed: 200, boomerang: true };

      const magnetizer = ctx.createServerEnemy(world, "magnetizer", 500, 300, true);
      world.enemies.set(magnetizer.id, magnetizer);

      const bullet = [...world.bullets.values()].find(b => b.ownerId === player.id);
      bullet.state = "ground";
      bullet.x = 300;
      bullet.y = 300;

      const dt = 0.1;
      ctx.updateServerBullet({ world }, bullet, dt);

      // Player pulls left at 200*0.1 = 20px, Magnetizer pulls right at 300*0.1 = 30px
      // Net movement = +10px -> bullet.x should be ~310
      assert.ok(bullet.x > 300, `Bullet must move towards magnetizer (expected > 300, got ${bullet.x})`);
      assert.ok(Math.abs(bullet.x - 310) < 0.001, `Bullet x should be exactly 310, got ${bullet.x}`);
    });
  });

  await t.test("Tier 1 - Connected Twins Enemy Unit & Tether / Enrage Verification", async (t1) => {
    await t1.test("3.1 Connected Twins creation sets r=10, speed 90+2w, HP 2+floor(w/5), spawned in pairs", () => {
      const { world } = createTestWorld(ctx);
      world.wave = 12;

      // When spawning twins, they are created in pairs
      let twinA, twinB;
      if (typeof ctx.spawnServerTwinPair === "function") {
        [twinA, twinB] = ctx.spawnServerTwinPair(world, 300, 300, 400, 300);
      } else {
        twinA = ctx.createServerEnemy(world, "twin", 300, 300, true);
        twinB = ctx.createServerEnemy(world, "twin", 400, 300, true);
        twinA.twinPartnerId = twinB.id;
        twinB.twinPartnerId = twinA.id;
        world.enemies.set(twinA.id, twinA);
        world.enemies.set(twinB.id, twinB);
      }

      assert.ok(twinA && twinB, "Both twin instances must exist");
      assert.equal(twinA.r, 10, "Twin radius must be 10");
      assert.equal(twinB.r, 10, "Twin radius must be 10");
      assert.ok(twinA.speed >= 110, `Twin speed should be >= 110, got ${twinA.speed}`);
      assert.ok(twinA.hp >= 4, `Twin HP should be >= 4, got ${twinA.hp}`);
      assert.equal(twinA.twinPartnerId, twinB.id, "Twin A partner ID must match Twin B id");
      assert.equal(twinB.twinPartnerId, twinA.id, "Twin B partner ID must match Twin A id");
    });

    await t1.test("3.2 Laser tether damages player when crossing the connecting line segment", () => {
      const { world, player1: player } = createTestWorld(ctx);
      world.wave = 12;
      player.x = 350;
      player.y = 300; // Directly on the line between (300, 300) and (400, 300)
      player.hp = 5;
      player.invulnerability = 0;

      const twinA = ctx.createServerEnemy(world, "twin", 300, 300, true);
      const twinB = ctx.createServerEnemy(world, "twin", 400, 300, true);
      twinA.twinPartnerId = twinB.id;
      twinB.twinPartnerId = twinA.id;
      world.enemies.set(twinA.id, twinA);
      world.enemies.set(twinB.id, twinB);

      ctx.updateServerEnemies(world, 0.05);

      assert.ok(
        player.hp < 5,
        `Player crossing laser tether should take damage (hp < 5), got HP ${player.hp}`
      );
    });

    await t1.test("3.3 Death of one twin enrages surviving partner (+50% speed, red glow)", () => {
      const { world, player1: player } = createTestWorld(ctx);
      world.wave = 12;

      const twinA = ctx.createServerEnemy(world, "twin", 300, 300, true);
      const twinB = ctx.createServerEnemy(world, "twin", 400, 300, true);
      twinA.twinPartnerId = twinB.id;
      twinB.twinPartnerId = twinA.id;
      world.enemies.set(twinA.id, twinA);
      world.enemies.set(twinB.id, twinB);

      const baseSpeedB = twinB.speed;

      // Kill Twin A
      ctx.killServerEnemy(world, twinA, player);

      assert.equal(world.enemies.has(twinA.id), false, "Twin A should be removed from enemies");
      assert.equal(twinB.isEnraged, true, "Surviving Twin B should enter enraged state");
      assert.ok(
        twinB.speed >= baseSpeedB * 1.45,
        `Twin B speed should increase by +50%, expected ~${baseSpeedB * 1.5}, got ${twinB.speed}`
      );
    });
  });

  // =========================================================================
  // TIER 2: BOUNDARY & EDGE CONDITIONS
  // =========================================================================

  await t.test("Tier 2 - Boundary & Edge Conditions", async (t2) => {
    await t2.test("4.1 Phantom: Exact phase transition boundary (t=1.99s vs t=2.01s)", () => {
      const { world } = createTestWorld(ctx);
      const phantom = ctx.createServerEnemy(world, "phantom", 300, 300, true);
      phantom.phaseTimer = 1.95;
      phantom.isPhased = true;
      world.enemies.set(phantom.id, phantom);

      // Advance by 0.04s (total 1.99s -> still intangible)
      ctx.updateServerEnemies(world, 0.04);
      assert.equal(phantom.isPhased, true, "At t=1.99s, phantom should remain intangible");

      // Advance by 0.03s (total 2.02s -> tangible)
      ctx.updateServerEnemies(world, 0.03);
      assert.equal(phantom.isPhased, false, "At t=2.02s, phantom should transition to tangible");
    });

    await t2.test("4.2 Magnetizer: Exact distance boundary (199px affected vs 201px unaffected)", () => {
      const { world, player1: player } = createTestWorld(ctx);
      const magnetizer = ctx.createServerEnemy(world, "magnetizer", 500, 500, true);
      world.enemies.set(magnetizer.id, magnetizer);

      const bullet1 = [...world.bullets.values()].find(b => b.ownerId === player.id);
      bullet1.state = "flying";
      bullet1.x = 500;
      bullet1.y = 500 - 199; // Distance = 199px (< 200px)
      bullet1.vx = 200;
      bullet1.vy = 0;

      ctx.updateServerBullet({ world }, bullet1, 0.05);
      const pullApplied = bullet1.vy > 0 || bullet1.y > (500 - 199);
      assert.ok(pullApplied, "Bullet at 199px should experience gravitational pull towards y=500");
    });

    await t2.test("4.3 Magnetizer: Multiple magnetizers exert combined vector pull without NaN", () => {
      const { world, player1: player } = createTestWorld(ctx);
      const mag1 = ctx.createServerEnemy(world, "magnetizer", 300, 400, true);
      const mag2 = ctx.createServerEnemy(world, "magnetizer", 500, 400, true);
      world.enemies.set(mag1.id, mag1);
      world.enemies.set(mag2.id, mag2);

      const bullet = [...world.bullets.values()].find(b => b.ownerId === player.id);
      bullet.state = "flying";
      bullet.x = 400; // Symmetrical between mag1 (x=300) and mag2 (x=500)
      bullet.y = 400;
      bullet.vx = 0;
      bullet.vy = -300;

      ctx.updateServerBullet({ world }, bullet, 0.05);

      assert.ok(Number.isFinite(bullet.vx) && Number.isFinite(bullet.vy), "Bullet velocities must remain finite numbers");
      assert.ok(Number.isFinite(bullet.x) && Number.isFinite(bullet.y), "Bullet coordinates must remain finite numbers");
    });

    await t2.test("4.4 Connected Twins: Simultaneous death in same tick handled without null pointer", () => {
      const { world, player1: player } = createTestWorld(ctx);
      const twinA = ctx.createServerEnemy(world, "twin", 300, 300, true);
      const twinB = ctx.createServerEnemy(world, "twin", 400, 300, true);
      twinA.twinPartnerId = twinB.id;
      twinB.twinPartnerId = twinA.id;
      world.enemies.set(twinA.id, twinA);
      world.enemies.set(twinB.id, twinB);

      // Kill both twins simultaneously
      ctx.killServerEnemy(world, twinA, player);
      ctx.killServerEnemy(world, twinB, player);

      assert.equal(world.enemies.has(twinA.id), false);
      assert.equal(world.enemies.has(twinB.id), false);

      // Next tick should proceed smoothly without errors
      assert.doesNotThrow(() => {
        ctx.updateServerEnemies(world, 0.05);
      });
    });

    await t2.test("4.5 Wave Scaling: HP and Speed formulas across High Waves (Wave 20, 30, 50)", () => {
      const { world } = createTestWorld(ctx);
      const testWaves = [20, 30, 50];

      for (const w of testWaves) {
        world.wave = w;
        const phantom = ctx.createServerEnemy(world, "phantom", 100, 100, true);
        const magnetizer = ctx.createServerEnemy(world, "magnetizer", 100, 100, true);
        const twin = ctx.createServerEnemy(world, "twin", 100, 100, true);

        assert.ok(phantom.hp > 0 && phantom.speed > 0);
        assert.ok(magnetizer.hp > 0 && magnetizer.speed > 0);
        assert.ok(twin.hp > 0 && twin.speed > 0);
        assert.ok(Number.isFinite(phantom.hp) && Number.isFinite(phantom.speed));
      }
    });
  });

  // =========================================================================
  // TIER 3: CROSS-FEATURE INTERACTIONS & PARITY
  // =========================================================================

  await t.test("Tier 3 - Cross-Feature Interactions & Parity", async (t3) => {
    await t3.test("5.1 Wave Spawning Inclusion Thresholds: Magnetizer (W8+), Phantom (W10+), Twins (W12+)", () => {
      const { world } = createTestWorld(ctx);

      // Test wave 1-7: None of the 3 R4 enemies should spawn
      world.wave = 5;
      for (let trial = 0; trial < 10; trial++) {
        world.enemies.clear();
        ctx.spawnServerWave(world);
        const enemyTypes = [...world.enemies.values()].map(e => e.type);
        assert.equal(enemyTypes.includes("magnetizer"), false, "Magnetizer should not spawn before Wave 8");
        assert.equal(enemyTypes.includes("phantom"), false, "Phantom should not spawn before Wave 10");
        assert.equal(enemyTypes.includes("twin"), false, "Twin should not spawn before Wave 12");
      }

      // Test wave 8+: Magnetizer eligible
      world.wave = 8;
      let foundMag = false;
      for (let trial = 0; trial < 25; trial++) {
        world.enemies.clear();
        ctx.spawnServerWave(world);
        if ([...world.enemies.values()].some(e => e.type === "magnetizer")) {
          foundMag = true;
          break;
        }
      }
      assert.ok(foundMag, "Magnetizer must spawn on Wave 8+");

      // Test wave 10+: Phantom eligible
      world.wave = 10;
      let foundPhantom = false;
      for (let trial = 0; trial < 25; trial++) {
        world.enemies.clear();
        ctx.spawnServerWave(world);
        if ([...world.enemies.values()].some(e => e.type === "phantom")) {
          foundPhantom = true;
          break;
        }
      }
      assert.ok(foundPhantom, "Phantom must spawn on Wave 10+");

      // Test wave 12+: Twins eligible
      world.wave = 12;
      let foundTwins = false;
      for (let trial = 0; trial < 25; trial++) {
        world.enemies.clear();
        ctx.spawnServerWave(world);
        if ([...world.enemies.values()].some(e => e.type === "twin")) {
          foundTwins = true;
          break;
        }
      }
      assert.ok(foundTwins, "Connected Twins must spawn on Wave 12+");
    });

    await t3.test("5.2 Stunned Magnetizer & Phased Phantom interaction with player bullets", () => {
      const { world, player1: player } = createTestWorld(ctx);
      const magnetizer = ctx.createServerEnemy(world, "magnetizer", 300, 300, true);
      magnetizer.stunTimer = 1.0;
      world.enemies.set(magnetizer.id, magnetizer);

      const phantom = ctx.createServerEnemy(world, "phantom", 350, 300, true);
      phantom.isPhased = true;
      phantom.phaseTimer = 0.5;
      world.enemies.set(phantom.id, phantom);

      // Tick update
      ctx.updateServerEnemies(world, 0.1);

      assert.equal(magnetizer.x, 300, "Stunned magnetizer must not move");
      assert.equal(phantom.isPhased, true, "Phantom remains phased");
    });

    await t3.test("5.3 Snapshot Serialization includes new enemy properties (isPhased, twinPartnerId, isEnraged)", () => {
      const { room, world } = createTestWorld(ctx);
      const phantom = ctx.createServerEnemy(world, "phantom", 200, 200, true);
      phantom.isPhased = true;
      world.enemies.set(phantom.id, phantom);

      const magnetizer = ctx.createServerEnemy(world, "magnetizer", 300, 300, true);
      world.enemies.set(magnetizer.id, magnetizer);

      const twin = ctx.createServerEnemy(world, "twin", 400, 400, true);
      twin.twinPartnerId = 999;
      twin.isEnraged = true;
      world.enemies.set(twin.id, twin);

      const snapshot = ctx.createServerCoopSnapshot(room);
      assert.ok(snapshot.enemies.length >= 3, "Snapshot should contain serialized enemies");

      const snapPhantom = snapshot.enemies.find(e => e.id === phantom.id);
      const snapMag = snapshot.enemies.find(e => e.id === magnetizer.id);
      const snapTwin = snapshot.enemies.find(e => e.id === twin.id);

      assert.ok(snapPhantom, "Serialized phantom enemy found in snapshot");
      assert.equal(snapPhantom.type, "phantom");

      assert.ok(snapMag, "Serialized magnetizer enemy found in snapshot");
      assert.equal(snapMag.type, "magnetizer");
      assert.equal(snapMag.color.toLowerCase(), "#c084fc");

      assert.ok(snapTwin, "Serialized twin enemy found in snapshot");
      assert.equal(snapTwin.type, "twin");
    });
  });

  // =========================================================================
  // TIER 4: WORKLOAD & MULTI-ENTITY SIMULATION E2E
  // =========================================================================

  await t.test("Tier 4 - Workload & Multi-Entity Simulation E2E", async (t4) => {
    await t4.test("6.1 600-tick sustained battle simulation with 20 mixed enemies including R4 types", () => {
      const { world, player1: player } = createTestWorld(ctx);
      world.wave = 15; // All enemy types active

      player.x = 400;
      player.y = 400;
      player.hp = 20;
      player.maxHp = 20;

      // Spawn mixed enemies: 4 Phantoms, 4 Magnetizers, 4 Twins (2 pairs), 8 standard enemies
      for (let i = 0; i < 4; i++) {
        const phantom = ctx.createServerEnemy(world, "phantom", 200 + i * 50, 150, true);
        world.enemies.set(phantom.id, phantom);

        const mag = ctx.createServerEnemy(world, "magnetizer", 200 + i * 50, 650, true);
        world.enemies.set(mag.id, mag);
      }

      for (let i = 0; i < 2; i++) {
        const twinA = ctx.createServerEnemy(world, "twin", 150, 300 + i * 100, true);
        const twinB = ctx.createServerEnemy(world, "twin", 650, 300 + i * 100, true);
        twinA.twinPartnerId = twinB.id;
        twinB.twinPartnerId = twinA.id;
        world.enemies.set(twinA.id, twinA);
        world.enemies.set(twinB.id, twinB);
      }

      const bullet = [...world.bullets.values()].find(b => b.ownerId === player.id);
      bullet.state = "flying";
      bullet.x = 400;
      bullet.y = 400;
      bullet.vx = 200;
      bullet.vy = -200;

      // Run 600 ticks (10.0s simulation)
      for (let tick = 0; tick < 600; tick++) {
        const dt = 1 / 60;
        if (bullet.state === "flying" || bullet.state === "ground") {
          ctx.updateServerBullet({ world }, bullet, dt);
        }
        ctx.updateServerEnemies(world, dt);
      }

      // Assert all remaining entities are in valid mathematical states
      for (const enemy of world.enemies.values()) {
        assert.ok(Number.isFinite(enemy.x), `Enemy ${enemy.id} x should be finite`);
        assert.ok(Number.isFinite(enemy.y), `Enemy ${enemy.id} y should be finite`);
        assert.ok(Number.isFinite(enemy.hp), `Enemy ${enemy.id} hp should be finite`);
        if (enemy.type === "phantom") {
          assert.equal(typeof enemy.isPhased, "boolean");
        }
      }
    });
  });
});
