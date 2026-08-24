const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadServerInstance } = require("./helpers/server_loader.js");
const { createTestWorld } = require("./helpers/test_utils.js");

test("R6 Major Feature Pack: Energy Dash, Incubator Swarms, 5% Medkits & Bullet Skins", async (t) => {
  const inst = loadServerInstance();
  const { ctx, cleanup } = inst;

  t.after(() => {
    cleanup();
  });

  await t.test("Tier 1: Incubator Enemy & Minion Swarm Mechanics", async (t1) => {
    await t1.test("1.1 Incubator creation sets proper attributes (r=22, color #059669, spawnTimer=4.5s)", () => {
      const { world } = createTestWorld(ctx);
      world.wave = 6;
      const incubator = ctx.createServerEnemy(world, "incubator", 400, 300, true);

      assert.ok(incubator, "Incubator instance must be created");
      assert.equal(incubator.type, "incubator");
      assert.equal(incubator.r, 22);
      assert.equal(incubator.color, "#059669");
      assert.equal(incubator.spawnTimer, 4.5, "Incubator spawn timer must start at 4.5s");
      assert.ok(incubator.hp >= 6, `Incubator base HP must be >= 6, got ${incubator.hp}`);
    });

    await t1.test("1.2 Minion creation sets proper agile attributes (r=7, speed > 130, hp=1)", () => {
      const { world } = createTestWorld(ctx);
      world.wave = 6;
      const minion = ctx.createServerEnemy(world, "minion", 400, 300, true);

      assert.ok(minion, "Minion instance must be created");
      assert.equal(minion.type, "minion");
      assert.equal(minion.r, 7);
      assert.equal(minion.hp, 1);
      assert.equal(minion.maxHp, 1);
      assert.ok(minion.speed >= 130, `Minion speed should be >= 130, got ${minion.speed}`);
    });

    await t1.test("1.3 Incubator periodically spawns 2-3 minions after 4.5s countdown", () => {
      const { world } = createTestWorld(ctx);
      world.wave = 6;
      const incubator = ctx.createServerEnemy(world, "incubator", 400, 300, true);
      incubator.hasEnteredArena = true;
      incubator.spawnTimer = 0.1; // Almost ready to spawn
      world.enemies.set(incubator.id, incubator);

      assert.equal(world.enemies.size, 1);

      // Advance by 0.2s -> triggers minion spawn
      ctx.updateServerEnemies(world, 0.2);

      assert.ok(
        world.enemies.size >= 3,
        `World enemies count must be >= 3 (1 incubator + 2-3 minions), got ${world.enemies.size}`
      );

      const minions = [...world.enemies.values()].filter(e => e.type === "minion");
      assert.ok(minions.length >= 2, `Must have spawned at least 2 minions, got ${minions.length}`);
      assert.equal(incubator.spawnTimer, 4.5, "spawnTimer should reset back to 4.5s");
    });
  });

  await t.test("Tier 2: Medkit Drops & Health Recovery System", async (t2) => {
    await t2.test("2.1 Medkits collection is initialized in world", () => {
      const { world } = createTestWorld(ctx);
      assert.equal(world.medkits?.constructor?.name, "Map", "world.medkits must be a Map");
      assert.equal(world.medkits.size, 0);
    });

    await t2.test("2.2 Picking up a medkit heals +1 HP clamped to player maxHp", () => {
      const { room, world, player1 } = createTestWorld(ctx);
      player1.maxHp = 5;
      player1.hp = 2; // Damaged player

      const medkitId = 101;
      world.medkits.set(medkitId, {
        id: medkitId,
        x: player1.x + 5, // Touching player
        y: player1.y + 5,
        r: 12,
        heal: 1,
        life: 35.0
      });

      assert.equal(world.medkits.size, 1);

      // Advance server world simulation to process pickups
      ctx.updateServerCoopWorld(room, 0.05, Date.now());

      assert.equal(world.medkits.size, 0, "Medkit must be collected and removed from world");
      assert.equal(player1.hp, 3, "Player HP must increase by +1 (from 2 to 3)");
    });

    await t2.test("2.3 Medkit heal does not exceed player maxHp", () => {
      const { room, world, player1 } = createTestWorld(ctx);
      player1.maxHp = 5;
      player1.hp = 5; // Full health

      const medkitId = 102;
      world.medkits.set(medkitId, {
        id: medkitId,
        x: player1.x,
        y: player1.y,
        r: 12,
        heal: 1,
        life: 35.0
      });

      ctx.updateServerCoopWorld(room, 0.05, Date.now());

      assert.equal(world.medkits.size, 0, "Medkit should be collected");
      assert.equal(player1.hp, 5, "Player HP must not exceed maxHp (5)");
    });

    await t2.test("2.4 Medkits are serialized in createServerCoopSnapshot", () => {
      const { room, world } = createTestWorld(ctx);
      world.medkits.set(201, { id: 201, x: 250, y: 350, r: 12, life: 30 });

      const snapshot = ctx.createServerCoopSnapshot(room);
      assert.ok(Array.isArray(snapshot.medkits), "Snapshot must contain medkits array");
      assert.equal(snapshot.medkits.length, 1);
      assert.equal(snapshot.medkits[0].id, 201);
      assert.equal(snapshot.medkits[0].x, 250);
      assert.equal(snapshot.medkits[0].y, 350);
    });

    await t2.test("2.5 Medkits DO NOT drop from secondary enemies (minion, shard)", () => {
      const { world, player1 } = createTestWorld(ctx);
      const vm = require("node:vm");
      vm.runInContext("this.__origRandom = Math.random; Math.random = () => 0.0;", ctx);

      try {
        const minion = ctx.createServerEnemy(world, "minion", 400, 300, true);
        world.enemies.set(minion.id, minion);
        ctx.killServerEnemy(world, minion, player1);
        assert.equal(world.medkits.size, 0, "Killing minion must never drop a medkit");

        const shard = ctx.createServerEnemy(world, "shard", 400, 300, true);
        world.enemies.set(shard.id, shard);
        ctx.killServerEnemy(world, shard, player1);
        assert.equal(world.medkits.size, 0, "Killing splitter shard must never drop a medkit");

        const incubator = ctx.createServerEnemy(world, "incubator", 400, 300, true);
        world.enemies.set(incubator.id, incubator);
        ctx.killServerEnemy(world, incubator, player1);
        assert.equal(world.medkits.size, 1, "Killing primary enemy (incubator) can drop a medkit");
      } finally {
        vm.runInContext("if (this.__origRandom) Math.random = this.__origRandom;", ctx);
      }
    });
  });

  await t.test("Tier 3: Client Contracts & Settings Verification", async (t3) => {
    const indexPath = path.join(__dirname, "..", "public", "index.html");
    const indexHtml = fs.readFileSync(indexPath, "utf8");

    await t3.test("3.1 Index HTML contains playDash and playHeal sound triggers", () => {
      assert.ok(indexHtml.includes("playDash()"), "SoundManager must contain playDash()");
      assert.ok(indexHtml.includes("playHeal()"), "SoundManager must contain playHeal()");
    });

    await t3.test("3.2 Index HTML contains triggerDash and 8.0s cooldown check", () => {
      assert.ok(indexHtml.includes("function triggerDash"), "Index HTML must define triggerDash()");
      assert.ok(indexHtml.includes("dashCooldown = 8.0"), "Dash cooldown must be set to 8.0s");
    });

    await t3.test("3.3 Index HTML contains 5 Bullet Skins in settings and renderer", () => {
      assert.ok(indexHtml.includes('data-skin="neon"'), "Settings must have neon skin");
      assert.ok(indexHtml.includes('data-skin="fire"'), "Settings must have fire skin");
      assert.ok(indexHtml.includes('data-skin="quantum"'), "Settings must have quantum skin");
      assert.ok(indexHtml.includes('data-skin="toxic"'), "Settings must have toxic skin");
      assert.ok(indexHtml.includes('data-skin="cosmic"'), "Settings must have cosmic skin");
    });

    await t3.test("3.4 Server updateServerCoopPlayer triggers dash physics on input.dash", () => {
      const { player1 } = createTestWorld(ctx);
      player1.x = 400;
      player1.y = 300;
      player1.input = ctx.sanitizeInput ? ctx.sanitizeInput({ right: true, dash: true }) : { right: true, dash: true };
      player1.dashCooldown = 0;

      // Update server player simulation
      ctx.updateServerCoopPlayer(player1, 0.1, Date.now());

      assert.equal(player1.dashCooldown, 8.0, "dashCooldown must be set to 8s on trigger");
      assert.ok(player1.dashTimer > 0, "dashTimer must be active");
      assert.ok(player1.x > 450, `Player x must have dashed right rapidly (got ${player1.x})`);
      assert.ok(player1.invulnerability >= 0.15, "Invulnerability must be active during dash");
    });

    await t3.test("3.5 Client drawCoopBullet and drawCoop support bullet skins and settings", () => {
      assert.ok(indexHtml.includes("drawCoopBullet"), "drawCoopBullet must exist");
      assert.ok(indexHtml.includes("skin === \"fire\""), "drawCoopBullet must check bullet skin");
      assert.ok(indexHtml.includes("coop-pause"), "Settings must support coop-pause return");
    });

    await t3.test("3.6 Server unpause countdown pauses simulation and grants invulnerability", () => {
      const { world, room, player1 } = createTestWorld(ctx);
      world.manualPaused = false;
      world.unpauseCountdown = 3.0;
      world.unpauseCountdownSec = 3;

      // When countdown is active, world simulation does not tick enemies or damage
      ctx.updateServerCoopWorld(room, 0.5, Date.now());
      assert.equal(world.unpauseCountdown, 2.5);
      assert.equal(world.unpauseCountdownSec, 3);

      // Finish countdown
      ctx.updateServerCoopWorld(room, 2.6, Date.now());
      assert.equal(world.unpauseCountdown, null);
      assert.ok(player1.invulnerability >= 1.0, "Player must receive invulnerability buffer after unpausing");
    });

    await t3.test("3.7 Client crosshair contains Dash Charge Ring for both solo and coop", () => {
      assert.ok(indexHtml.includes("renderCoopUnpauseUI"), "Client must define renderCoopUnpauseUI");
      assert.ok(indexHtml.includes("drawCrosshair"), "Solo drawCrosshair must exist");
      assert.ok(indexHtml.includes("drawCoopCrosshair"), "Coop drawCoopCrosshair must exist");
      assert.ok(indexHtml.includes("startAngle = -Math.PI / 2"), "Crosshair must render circular charge arc");
    });

    await t3.test("3.8 Server createServerCoopSnapshot serializes parasites and client defines drawCoopParasiteSpores", () => {
      const { world, room } = createTestWorld(ctx);
      world.parasites = new Map();
      world.parasites.set(101, { id: 101, x: 250, y: 350, vx: 50, vy: -50, r: 7 });

      const snapshot = ctx.createServerCoopSnapshot(room);
      assert.ok(Array.isArray(snapshot.parasites), "Snapshot must contain parasites array");
      assert.equal(snapshot.parasites.length, 1);
      assert.equal(snapshot.parasites[0].id, 101);
      assert.ok(indexHtml.includes("drawCoopParasiteSpores"), "Client must define drawCoopParasiteSpores");
    });

    await t3.test("3.9 Server player updates smoothly with client-streamed input coordinates", () => {
      const { player1 } = createTestWorld(ctx);
      player1.x = 200;
      player1.y = 200;
      player1.input = ctx.sanitizeInput ? ctx.sanitizeInput({ x: 235.4, y: 218.2 }) : { x: 235.4, y: 218.2 };

      ctx.updateServerCoopPlayer(player1, 0.016, Date.now());
      assert.equal(player1.x, 235.4, "Server player x must match streamed client coordinate without drift");
      assert.equal(player1.y, 218.2, "Server player y must match streamed client coordinate without drift");
    });

    await t3.test("3.10 Both players dying in co-op triggers world.gameOver and cleans up beacons", () => {
      const { world, room, player1, player2 } = createTestWorld(ctx);
      room.started = true;
      // Player 1 is already dead and has active beacon
      player1.alive = false;
      player1.hp = 0;
      player1.reviveBeacon = { x: 300, y: 300, progress: 1.5, active: true };

      // Player 2 takes fatal damage
      player2.hp = 1;
      player2.invulnerability = 0;
      ctx.damageServerPlayer(world, player2, 5);

      assert.equal(player2.alive, false);
      assert.equal(world.gameOver, true, "world.gameOver must be true when all players die");
      assert.equal(player1.reviveBeacon, null, "Revive beacons must be cleared on game over");
      assert.equal(room.started, true, "room.started remains true to allow game over snapshot delivery");
    });

    await t3.test("3.11 Parasites move towards enemy in updateServerCoopWorld", () => {
      const { world, room, player1 } = createTestWorld(ctx);
      room.started = true;
      const enemy = ctx.createServerEnemy(world, "basic", 400, 300, true);
      enemy.hasEnteredArena = true;
      world.enemies.set(enemy.id, enemy);

      world.parasites.set(201, {
        id: 201,
        ownerId: player1.id,
        x: 300,
        y: 300,
        vx: 0,
        vy: 0,
        damage: 2.0,
        r: 7
      });

      ctx.updateServerCoopWorld(room, 0.1, Date.now());
      const spore = world.parasites.get(201);
      assert.ok(spore, "Parasite spore must exist");
      assert.ok(spore.vx > 0, `Parasite vx must accelerate towards enemy (got ${spore.vx})`);
      assert.ok(spore.x > 300, `Parasite x must move towards enemy (got ${spore.x})`);
    });

    await t3.test("3.12 Splinter shards spawn on bounce and update in updateServerCoopWorld", () => {
      const { world, room, player1 } = createTestWorld(ctx);
      room.started = true;
      player1.stats.splinter = true;
      player1.stats.splinterCount = 2;
      player1.stats.splinterDamagePercent = 0.5;

      const bullet = ctx.createServerBullet(world, player1);
      bullet.state = "flying";
      bullet.x = 5;
      bullet.y = 300;
      bullet.vx = -400;
      bullet.vy = 0;
      bullet.bouncesLeft = 2;
      world.bullets.set(bullet.id, bullet);

      ctx.updateServerBullet(room, bullet, 0.05);
      assert.ok(world.splinters.size >= 2, `Splinter shards must spawn on bounce (got ${world.splinters.size})`);

      const snap = ctx.createServerCoopSnapshot(room);
      assert.ok(Array.isArray(snap.splinters), "Snapshot must contain splinters");
      assert.ok(snap.splinters.length >= 2, "Snapshot splinters count must match");
      assert.ok(indexHtml.includes("drawCoopSplinters"), "Client must define drawCoopSplinters");
    });

    await t3.test("3.13 applyServerUpgrade applies pickup and magnet-range correctly", () => {
      const { world, player1 } = createTestWorld(ctx);
      ctx.applyServerUpgrade(world, player1, { upgradeId: "pickup", rarity: { power: 2 } });
      assert.equal(player1.stats.groundPullSpeed, 220);

      ctx.applyServerUpgrade(world, player1, { upgradeId: "magnet-range", rarity: { power: 1 } });
      assert.equal(player1.stats.magnetRangeBonusCells, 5);
    });

    await t3.test("3.14 SoundManager implements playUiTick and playWaveStart without throwing", () => {
      assert.ok(indexHtml.includes("playUiTick()"), "SoundManager must implement playUiTick");
      assert.ok(indexHtml.includes("playWaveStart()"), "SoundManager must implement playWaveStart");
    });

    await t3.test("3.15 Co-op medkits are collected by wounded player, serialized, and rendered in drawCoopScene", () => {
      const { world, room, player1 } = createTestWorld(ctx);
      room.started = true;
      player1.x = 200;
      player1.y = 200;
      player1.hp = 3;
      player1.maxHp = 5;

      world.medkits.set(501, { id: 501, x: 205, y: 205, r: 12, heal: 1, life: 30 });
      ctx.updateServerCoopWorld(room, 0.05, Date.now());

      assert.equal(player1.hp, 4, "Wounded player must gain +1 HP from medkit");
      assert.equal(world.medkits.size, 0, "Consumed medkit must be deleted");

      const snapshot = ctx.createServerCoopSnapshot(room);
      assert.ok(Array.isArray(snapshot.medkits), "Snapshot must contain medkits array");
      assert.ok(indexHtml.includes("drawMedkits()"), "drawCoopScene must call drawMedkits");
    });
  });
});
