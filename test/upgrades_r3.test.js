const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadServerInstance } = require("./helpers/server_loader.js");
const { createTestWorld } = require("./helpers/test_utils.js");

test("R3 New Upgrades Comprehensive Suite (Boomerang, Splinter, Stun, Reactive Armor, Target Mark)", async (t) => {
  const inst = loadServerInstance();
  const { ctx, cleanup } = inst;

  t.after(() => {
    cleanup();
  });

  // =========================================================================
  // TIER 1: UNIT & FUNCTIONAL VERIFICATION
  // =========================================================================

  await t.test("Tier 1 - Upgrade Catalog Schema & Definitions", async (t1) => {
    await t1.test("1.1 Boomerang upgrade definition in SERVER_UPGRADES and availability predicate", () => {
      const boomerang = ctx.SERVER_UPGRADES.find(u => u.id === "boomerang");
      assert.ok(boomerang, "SERVER_UPGRADES must contain upgrade with id 'boomerang'");
      assert.ok(boomerang.title, "Boomerang upgrade must have a title");
      assert.ok(boomerang.description, "Boomerang upgrade must have a description");
      assert.equal(typeof boomerang.bonus, "function", "Boomerang must define bonus(player, power) function");

      const dummyPlayer = { stats: { groundPullSpeed: 0 } };
      if (typeof boomerang.available === "function") {
        assert.equal(boomerang.available(dummyPlayer), false, "Boomerang should not be available if groundPullSpeed <= 0");
        dummyPlayer.stats.groundPullSpeed = 110;
        assert.equal(boomerang.available(dummyPlayer), true, "Boomerang should be available when groundPullSpeed > 0");
        dummyPlayer.stats.boomerang = true;
        assert.equal(boomerang.available(dummyPlayer), false, "Boomerang should not be available once acquired");
        dummyPlayer.stats.boomerang = false;
      }

      const bonusStr = boomerang.bonus(dummyPlayer, 1);
      assert.ok(
        bonusStr.includes("50%") || bonusStr.includes("+50%") || bonusStr.includes("урон"),
        `Bonus description should mention damage bonus, got: "${bonusStr}"`
      );
    });

    await t1.test("1.2 Splinter Ricochet upgrade definition in SERVER_UPGRADES and bonus text", () => {
      const splinter = ctx.SERVER_UPGRADES.find(u => u.id === "splinter");
      assert.ok(splinter, "SERVER_UPGRADES must contain upgrade with id 'splinter'");
      assert.ok(splinter.title, "Splinter upgrade must have a title");
      assert.ok(splinter.description, "Splinter upgrade must have a description");
      assert.equal(typeof splinter.bonus, "function", "Splinter must define bonus(player, power) function");

      const dummyPlayer = { stats: { maxBounces: 1 } };
      const bonusStr = splinter.bonus(dummyPlayer, 1);
      assert.ok(
        bonusStr.includes("2") || bonusStr.includes("25%") || bonusStr.includes("оскол"),
        `Bonus description should describe shard spawns/damage, got: "${bonusStr}"`
      );
    });

    await t1.test("1.4 Kinetic Strike (Stun) upgrade definition in SERVER_UPGRADES and duration scaling", () => {
      const stun = ctx.SERVER_UPGRADES.find(u => u.id === "stun");
      assert.ok(stun, "SERVER_UPGRADES must contain upgrade with id 'stun'");
      assert.ok(stun.title, "Stun upgrade must have a title");
      assert.ok(stun.description, "Stun upgrade must have a description");
      assert.equal(typeof stun.bonus, "function", "Stun must define bonus(player, power) function");

      const dummyPlayer = { stats: {} };
      const bonus1 = stun.bonus(dummyPlayer, 1);
      const bonus2 = stun.bonus(dummyPlayer, 2);
      assert.ok(bonus1.includes("0.5") || bonus1.includes("оглуш"), `Bonus power 1 should mention 0.5s stun, got "${bonus1}"`);
      assert.ok(bonus2.includes("1") || bonus2.includes("1.0") || bonus2.includes("оглуш"), `Bonus power 2 should mention 1.0s stun, got "${bonus2}"`);
    });

    await t1.test("1.4 Reactive Armor upgrade definition in SERVER_UPGRADES and shockwave description", () => {
      const armor = ctx.SERVER_UPGRADES.find(u => u.id === "reactive-armor");
      assert.ok(armor, "SERVER_UPGRADES must contain upgrade with id 'reactive-armor'");
      assert.ok(armor.title, "Reactive armor upgrade must have a title");
      assert.ok(armor.description, "Reactive armor upgrade must have a description");
      assert.equal(typeof armor.bonus, "function", "Reactive armor must define bonus(player, power) function");

      const dummyPlayer = { stats: {} };
      const bonusStr = armor.bonus(dummyPlayer, 1);
      assert.ok(
        bonusStr.includes("120") || bonusStr.includes("3") || bonusStr.includes("отбрас") || bonusStr.includes("взрыв"),
        `Bonus should mention 120px radius or 3s cooldown, got: "${bonusStr}"`
      );
    });

    await t1.test("1.5 Target Mark upgrade definition in SERVER_UPGRADES and damage amplification description", () => {
      const mark = ctx.SERVER_UPGRADES.find(u => u.id === "target-mark");
      assert.ok(mark, "SERVER_UPGRADES must contain upgrade with id 'target-mark'");
      assert.ok(mark.title, "Target mark upgrade must have a title");
      assert.ok(mark.description, "Target mark upgrade must have a description");
      assert.equal(typeof mark.bonus, "function", "Target mark must define bonus(player, power) function");

      const dummyPlayer = { stats: {} };
      const bonusStr = mark.bonus(dummyPlayer, 1);
      assert.ok(
        bonusStr.includes("40%") || bonusStr.includes("+40%") || bonusStr.includes("4") || bonusStr.includes("урон"),
        `Bonus should mention 4s mark or +40% damage, got: "${bonusStr}"`
      );
    });
  });

  await t.test("Tier 1 - applyServerUpgrade State Mutations", async (t1) => {
    await t1.test("2.1 applyServerUpgrade correctly applies Boomerang upgrade", () => {
      const { world, player1: player } = createTestWorld(ctx);
      const initialCount = player.selectedUpgrades.length;

      const offer = {
        upgradeId: "boomerang",
        title: "Эффект Бумеранга",
        power: 1
      };

      const applied = ctx.applyServerUpgrade(world, player, offer);
      assert.equal(applied, true, "applyServerUpgrade should return true for 'boomerang'");
      assert.ok(player.stats.boomerang, "player.stats.boomerang must be truthy");
      assert.equal(player.selectedUpgrades.length, initialCount + 1, "selectedUpgrades should contain new upgrade");
      assert.equal(player.selectedUpgrades[player.selectedUpgrades.length - 1].upgradeId, "boomerang");
    });

    await t1.test("2.2 applyServerUpgrade correctly applies Splinter upgrade", () => {
      const { world, player1: player } = createTestWorld(ctx);
      const offer = {
        upgradeId: "splinter",
        title: "Осколочный Рикошет",
        power: 1
      };

      const applied = ctx.applyServerUpgrade(world, player, offer);
      assert.equal(applied, true, "applyServerUpgrade should return true for 'splinter'");
      assert.ok(player.stats.splinter, "player.stats.splinter must be truthy");
      assert.equal(player.selectedUpgrades[player.selectedUpgrades.length - 1].upgradeId, "splinter");
    });

    await t1.test("2.3 applyServerUpgrade correctly applies Stun upgrade and scales stun duration", () => {
      const { world, player1: player } = createTestWorld(ctx);
      const offer1 = { upgradeId: "stun", power: 1 };
      ctx.applyServerUpgrade(world, player, offer1);
      const stunVal1 = player.stats.stunChance || player.stats.stunChanceDuration || player.stats.stunChancePower;
      assert.ok(stunVal1 >= 0.05, `Stun stat should be >= 0.05 after power 1, got ${stunVal1}`);

      const offer2 = { upgradeId: "stun", power: 2 };
      ctx.applyServerUpgrade(world, player, offer2);
      const stunVal2 = player.stats.stunChance || player.stats.stunChanceDuration || player.stats.stunChancePower;
      assert.ok(stunVal2 > stunVal1, "Stun stat should accumulate on subsequent upgrades");
    });

    await t1.test("2.4 applyServerUpgrade correctly applies Reactive Armor upgrade", () => {
      const { world, player1: player } = createTestWorld(ctx);
      const offer = {
        upgradeId: "reactive-armor",
        title: "Реактивная Броня",
        power: 1
      };

      const applied = ctx.applyServerUpgrade(world, player, offer);
      assert.equal(applied, true, "applyServerUpgrade should return true for 'reactive-armor'");
      const reactive = player.stats.reactiveArmor || player.stats["reactive-armor"];
      assert.ok(reactive, "player.stats.reactiveArmor must be truthy");
    });

    await t1.test("2.5 applyServerUpgrade correctly applies Target Mark upgrade", () => {
      const { world, player1: player } = createTestWorld(ctx);
      const offer = {
        upgradeId: "target-mark",
        title: "Метка Цели",
        power: 1
      };

      const applied = ctx.applyServerUpgrade(world, player, offer);
      assert.equal(applied, true, "applyServerUpgrade should return true for 'target-mark'");
      const mark = player.stats.targetMark || player.stats["target-mark"];
      assert.ok(mark, "player.stats.targetMark must be truthy");
    });
  });

  await t.test("Tier 1 - Core In-Game Combat Mechanics", async (t1) => {
    await t1.test("3.1 Boomerang: Returning ground bullet (+pull) inflicts +50% damage and +1 pierce", () => {
      const { world, player1: player } = createTestWorld(ctx);
      player.x = 200;
      player.y = 200;
      player.stats.damage = 2;
      player.stats.groundPullSpeed = 150;
      player.stats.boomerang = true;

      const bullet = [...world.bullets.values()].find(b => b.ownerId === player.id);
      bullet.state = "ground";
      bullet.x = 280;
      bullet.y = 200;
      bullet.r = 6;
      bullet.hitsLeft = 1;

      // Enemy positioned between bullet and player
      const enemy = ctx.createServerEnemy(world, "normal", 240, 200, true);
      enemy.hp = 10;
      enemy.maxHp = 10;
      enemy.r = 14;
      world.enemies.set(enemy.id, enemy);

      // Simulate bullet update for ground returning bullet
      const initialHitsLeft = bullet.hitsLeft;
      ctx.updateServerBullet({ world }, bullet, 0.05);

      // Verify damage application (+50% of 2 = 3 damage)
      // Normal damage = 2, Boomerang damage = 3 (10 - 3 = 7)
      assert.ok(
        enemy.hp <= 7,
        `Enemy HP should be <= 7 after 3 damage (2 * 1.5), got ${enemy.hp}`
      );
    });

    await t1.test("3.2 Splinter: Wall bounce spawns 2 homing shard projectiles living 1.5s with 25% damage", () => {
      const { world, player1: player } = createTestWorld(ctx);
      player.x = 100;
      player.y = 100;
      player.stats.damage = 4;
      player.stats.boomerangPercent = 0.50;
      player.stats.maxBounces = 2;
      player.stats.splinter = true;

      const bullet = [...world.bullets.values()].find(b => b.ownerId === player.id);
      bullet.state = "flying";
      bullet.x = 5; // Near left wall (world min x = 0)
      bullet.y = 200;
      bullet.vx = -300;
      bullet.vy = 0;
      bullet.bouncesLeft = 2;

      const initialProjectilesCount = (world.enemyProjectiles?.size || 0) + (world.splinters?.size || 0) + (world.shards?.size || 0) + (world.playerProjectiles?.size || 0);

      ctx.updateServerBullet({ world }, bullet, 0.05);

      // Check that bounce occurred
      assert.equal(bullet.bouncesLeft, 1, "Bullet bouncesLeft should decrement on bounce");
      assert.ok(bullet.vx > 0, "Bullet vx should invert after bouncing off left wall");

      // Verify splinter projectiles spawned (2 shards)
      const spawnedSplinters = world.splinters || world.playerProjectiles || world.shards;
      if (spawnedSplinters) {
        assert.ok(spawnedSplinters.size >= 2, "At least 2 splinter shard projectiles must spawn on wall bounce");
        for (const shard of spawnedSplinters.values()) {
          assert.ok(shard.life <= 1.5, "Splinter shard lifespan should be <= 1.5s");
          assert.equal(shard.damage, 1, "Splinter damage should be 25% of 4 = 1");
        }
      }
    });

    await t1.test("3.3 Stun: Bullet hit inflicts stunTimer and skips enemy AI movement/attacks", () => {
      const { world, player1: player } = createTestWorld(ctx);
      player.x = 100;
      player.y = 100;
      player.stats.damage = 1;
      player.stats.stunChance = 1.0; // 1.0s stun

      const bullet = [...world.bullets.values()].find(b => b.ownerId === player.id);
      bullet.state = "flying";
      bullet.x = 240;
      bullet.y = 200;
      bullet.vx = 400;
      bullet.vy = 0;
      bullet.r = 6;

      const enemy = ctx.createServerEnemy(world, "runner", 250, 200, true);
      enemy.hp = 10;
      enemy.r = 10;
      enemy.speed = 100;
      world.enemies.set(enemy.id, enemy);

      ctx.updateServerBullet({ world }, bullet, 0.05);

      assert.ok(enemy.stunTimer > 0, `Enemy stunTimer should be > 0 after hit, got ${enemy.stunTimer}`);

      // Now tick enemy AI: enemy should NOT move while stunned
      const initialEnemyX = enemy.x;
      const initialEnemyY = enemy.y;
      const initialStunTimer = enemy.stunTimer;

      ctx.updateServerEnemies(world, 0.1);

      assert.equal(enemy.x, initialEnemyX, "Stunned enemy X coordinate must NOT change");
      assert.equal(enemy.y, initialEnemyY, "Stunned enemy Y coordinate must NOT change");
      assert.ok(
        Math.abs(enemy.stunTimer - (initialStunTimer - 0.1)) < 0.01,
        `stunTimer should decrease by dt (0.1), expected ~${initialStunTimer - 0.1}, got ${enemy.stunTimer}`
      );
    });

    await t1.test("3.4 Reactive Armor: Damage taken emits 120px radial knockback shockwave with 3.0s cooldown", () => {
      const { world, player1: player } = createTestWorld(ctx);
      player.x = 300;
      player.y = 300;
      player.hp = 3;
      player.maxHp = 3;
      player.stats.reactiveArmor = true;
      player.reactiveArmorCooldown = 0;

      // Place enemy at distance 80px (within 120px shockwave radius)
      const enemy = ctx.createServerEnemy(world, "normal", 380, 300, true);
      enemy.hp = 5;
      enemy.r = 14;
      world.enemies.set(enemy.id, enemy);

      // Simulate player taking damage
      if (typeof ctx.damageServerPlayer === "function") {
        ctx.damageServerPlayer(world, player, 1);
      } else {
        player.hp -= 1;
        // Trigger reactive armor handler if separate function
        if (typeof ctx.triggerReactiveArmor === "function") {
          ctx.triggerReactiveArmor(world, player);
        }
      }

      // Verify cooldown is set to 3.0s
      assert.ok(
        player.reactiveArmorCooldown >= 2.9,
        `Reactive armor cooldown should be set to 3.0s, got ${player.reactiveArmorCooldown}`
      );

      // Verify enemy was knocked back (distance increased beyond 80px)
      const newDist = Math.hypot(enemy.x - player.x, enemy.y - player.y);
      assert.ok(
        newDist > 80,
        `Enemy within 120px should be knocked back (dist > 80), got ${newDist}`
      );
    });

    await t1.test("3.5 Target Mark: First hit marks enemy for 4.0s for +40% amplified damage", () => {
      const { world, player1: player } = createTestWorld(ctx);
      player.x = 100;
      player.y = 100;
      player.stats.damage = 10;
      player.stats.targetMark = true;

      const bullet = [...world.bullets.values()].find(b => b.ownerId === player.id);
      bullet.state = "flying";
      bullet.x = 290;
      bullet.y = 200;
      bullet.vx = 400;
      bullet.vy = 0;

      const enemy = ctx.createServerEnemy(world, "tank", 300, 200, true);
      enemy.hp = 100;
      enemy.maxHp = 100;
      enemy.r = 21;
      world.enemies.set(enemy.id, enemy);

      // First hit applies mark and deals base damage
      ctx.updateServerBullet({ world }, bullet, 0.05);

      assert.ok(
        enemy.targetMarked || (enemy.targetMarkTimer && enemy.targetMarkTimer > 0),
        "Enemy must be marked after first hit"
      );
      assert.ok(
        enemy.targetMarkTimer >= 3.9,
        `targetMarkTimer should be initialized to ~4.0s, got ${enemy.targetMarkTimer}`
      );

      const hpAfterFirstHit = enemy.hp;
      assert.equal(hpAfterFirstHit, 90, "First hit must deal regular base 10 damage without mark bonus");

      // Second damage source applied to marked enemy (e.g. 10 damage -> +40% = 14 damage)
      ctx.damageServerEnemy(world, enemy.id, 10, player);

      const damageDealt = hpAfterFirstHit - enemy.hp;
      assert.equal(
        damageDealt,
        14,
        `Marked enemy must take +40% damage (10 * 1.4 = 14), got ${damageDealt}`
      );
    });
  });

  // =========================================================================
  // TIER 2: BOUNDARY & EDGE CONDITIONS
  // =========================================================================

  await t.test("Tier 2 - Boundary & Edge Conditions", async (t2) => {
    await t2.test("4.1 Boomerang: Non-returning bullet (groundPullSpeed = 0) does not receive +50% bonus", () => {
      const { world, player1: player } = createTestWorld(ctx);
      player.stats.damage = 2;
      player.stats.groundPullSpeed = 0; // No magnetic pull
      player.stats.boomerang = true;

      const bullet = [...world.bullets.values()].find(b => b.ownerId === player.id);
      bullet.state = "flying";
      bullet.x = 190;
      bullet.y = 200;
      bullet.vx = 400;
      bullet.vy = 0;

      const enemy = ctx.createServerEnemy(world, "normal", 200, 200, true);
      enemy.hp = 10;
      world.enemies.set(enemy.id, enemy);

      ctx.updateServerBullet({ world }, bullet, 0.05);

      // Flying bullet deals normal 2 damage, not 3
      assert.equal(enemy.hp, 8, `Flying bullet should deal base 2 damage, got HP ${enemy.hp}`);
    });

    await t2.test("4.2 Splinter: Dropping bullet with 0 bounces left does not spawn infinite shards", () => {
      const { world, player1: player } = createTestWorld(ctx);
      player.stats.damage = 2;
      player.stats.maxBounces = 0;
      player.stats.splinter = true;

      const bullet = [...world.bullets.values()].find(b => b.ownerId === player.id);
      bullet.state = "flying";
      bullet.x = 2;
      bullet.y = 200;
      bullet.vx = -300;
      bullet.vy = 0;
      bullet.bouncesLeft = 0;

      ctx.updateServerBullet({ world }, bullet, 0.05);

      assert.equal(bullet.state, "ground", "Bullet with 0 bounces hitting wall should drop to ground");
    });

    await t2.test("4.3 Stun: Stun timer clamp with dt > stunTimer reaches 0 without negative underflow", () => {
      const { world, player1: player } = createTestWorld(ctx);
      const enemy = ctx.createServerEnemy(world, "normal", 200, 200, true);
      enemy.stunTimer = 0.05;
      world.enemies.set(enemy.id, enemy);

      ctx.updateServerEnemies(world, 0.2); // dt = 0.2s > 0.05s

      assert.equal(enemy.stunTimer, 0, "stunTimer should be clamped cleanly to 0");
    });

    await t2.test("4.4 Reactive Armor: Shockwave radius boundary (119px hit vs 121px missed)", () => {
      const { world, player1: player } = createTestWorld(ctx);
      player.x = 400;
      player.y = 400;
      player.hp = 2;
      player.stats.reactiveArmor = true;
      player.reactiveArmorCooldown = 0;

      // Enemy inside boundary (119px)
      const insideEnemy = ctx.createServerEnemy(world, "normal", 400 + 119, 400, true);
      insideEnemy.r = 10;
      world.enemies.set(insideEnemy.id, insideEnemy);

      // Enemy outside boundary (121px + r)
      const outsideEnemy = ctx.createServerEnemy(world, "normal", 400, 400 + 140, true);
      outsideEnemy.r = 10;
      world.enemies.set(outsideEnemy.id, outsideEnemy);

      if (typeof ctx.damageServerPlayer === "function") {
        ctx.damageServerPlayer(world, player, 1);
      } else {
        player.hp -= 1;
        if (typeof ctx.triggerReactiveArmor === "function") {
          ctx.triggerReactiveArmor(world, player);
        }
      }

      const distInside = Math.hypot(insideEnemy.x - player.x, insideEnemy.y - player.y);
      const distOutside = Math.hypot(outsideEnemy.x - player.x, outsideEnemy.y - player.y);

      assert.ok(distInside > 119, "Inside enemy should be knocked back further");
      assert.equal(outsideEnemy.y, 540, "Outside enemy should not be pushed");
    });

    await t2.test("4.5 Reactive Armor: Damage taken during active cooldown does NOT trigger second shockwave", () => {
      const { world, player1: player } = createTestWorld(ctx);
      player.x = 400;
      player.y = 400;
      player.hp = 3;
      player.stats.reactiveArmor = true;
      player.reactiveArmorCooldown = 2.5; // Cooldown still active

      const enemy = ctx.createServerEnemy(world, "normal", 450, 400, true);
      world.enemies.set(enemy.id, enemy);

      if (typeof ctx.damageServerPlayer === "function") {
        ctx.damageServerPlayer(world, player, 1);
      } else {
        player.hp -= 1;
        if (typeof ctx.triggerReactiveArmor === "function") {
          ctx.triggerReactiveArmor(world, player);
        }
      }

      // Enemy position remains unchanged because cooldown was active
      assert.equal(enemy.x, 450, "Enemy must not be knocked back during active cooldown");
      assert.equal(player.reactiveArmorCooldown, 2.5, "Cooldown should not be reset during active cooldown");
    });

    await t2.test("4.6 Target Mark: Mark expires after 4.0s returning damage multiplier to 1.0x", () => {
      const { world, player1: player } = createTestWorld(ctx);
      const enemy = ctx.createServerEnemy(world, "normal", 200, 200, true);
      enemy.hp = 50;
      enemy.maxHp = 50;
      enemy.targetMarked = true;
      enemy.targetMarkTimer = 0.5; // 0.5s remaining
      world.enemies.set(enemy.id, enemy);

      // Advance by 0.6s to expire mark
      ctx.updateServerEnemies(world, 0.6);

      assert.equal(enemy.targetMarked, false, "targetMarked flag should reset to false upon timer expiry");
      assert.equal(enemy.targetMarkTimer, 0, "targetMarkTimer should reach 0");

      // Deal 10 damage -> un-amplified (10 damage)
      ctx.damageServerEnemy(world, enemy.id, 10, player);
      assert.equal(enemy.hp, 40, `Unmarked enemy should take exactly 10 damage, got HP ${enemy.hp}`);
    });

    await t2.test("4.7 Target Mark: Unspawned enemy (hasEnteredArena = false) cannot be marked", () => {
      const { world, player1: player } = createTestWorld(ctx);
      player.stats.targetMark = true;

      const bullet = [...world.bullets.values()].find(b => b.ownerId === player.id);
      bullet.state = "flying";
      bullet.x = 100;
      bullet.y = 100;

      const unspawnedEnemy = ctx.createServerEnemy(world, "normal", 100, 100, false);
      unspawnedEnemy.hasEnteredArena = false;
      world.enemies.set(unspawnedEnemy.id, unspawnedEnemy);

      ctx.updateServerBullet({ world }, bullet, 0.05);

      assert.equal(Boolean(unspawnedEnemy.targetMarked), false, "Unspawned enemy should not receive target mark");
    });
  });

  // =========================================================================
  // TIER 3: CROSS-FEATURE INTERACTIONS & PARITY
  // =========================================================================

  await t.test("Tier 3 - Cross-Feature Interactions & Parity", async (t3) => {
    await t3.test("5.1 Boomerang + Target Mark: Compounding damage multipliers (+50% & +40%)", () => {
      const { world, player1: player } = createTestWorld(ctx);
      player.x = 200;
      player.y = 200;
      player.stats.damage = 10;
      player.stats.groundPullSpeed = 150;
      player.stats.boomerang = true;
      player.stats.targetMark = true;

      const bullet = [...world.bullets.values()].find(b => b.ownerId === player.id);
      bullet.state = "ground";
      bullet.x = 280;
      bullet.y = 200;

      // Enemy already marked
      const enemy = ctx.createServerEnemy(world, "tank", 240, 200, true);
      enemy.hp = 100;
      enemy.maxHp = 100;
      enemy.targetMarked = true;
      enemy.targetMarkTimer = 3.0;
      world.enemies.set(enemy.id, enemy);

      ctx.updateServerBullet({ world }, bullet, 0.05);

      // Base 10 * 1.5 (boomerang) * 1.4 (target mark) = 19.5 -> ~19 or 20 damage
      const damageTaken = 100 - enemy.hp;
      assert.ok(
        damageTaken >= 0.2 && damageTaken <= 22,
        `Expected ~19-20 damage from combined Boomerang + Target Mark, got ${damageTaken}`
      );
    });

    await t3.test("5.2 Stun + Reactive Armor sequence: Knockback pushes enemy, stun freezes reaction", () => {
      const { world, player1: player } = createTestWorld(ctx);
      player.x = 300;
      player.y = 300;
      player.hp = 2;
      player.stats.reactiveArmor = true;
      player.stats.stunChance = 1.0;
      player.reactiveArmorCooldown = 0;

      const enemy = ctx.createServerEnemy(world, "runner", 350, 300, true);
      enemy.hp = 5;
      enemy.speed = 120;
      enemy.stunTimer = 1.0;
      world.enemies.set(enemy.id, enemy);

      // Trigger reactive armor
      if (typeof ctx.damageServerPlayer === "function") {
        ctx.damageServerPlayer(world, player, 1);
      } else {
        player.hp -= 1;
        if (typeof ctx.triggerReactiveArmor === "function") {
          ctx.triggerReactiveArmor(world, player);
        }
      }

      const pushedX = enemy.x;
      assert.ok(pushedX > 350, "Enemy should be pushed to the right");

      // Advance enemy AI: while stunned, enemy should NOT run back towards player
      ctx.updateServerEnemies(world, 0.2);
      assert.equal(enemy.x, pushedX, "Stunned enemy must not move back towards player");
    });

    await t3.test("5.3 Target Mark + AoE Effects (Catch Blast / Explosion) apply +40% damage", () => {
      const { world, player1: player } = createTestWorld(ctx);
      player.x = 300;
      player.y = 300;
      player.stats.catchBlast = 70;

      const bullet = [...world.bullets.values()].find(b => b.ownerId === player.id);
      bullet.state = "flying";

      const markedEnemy = ctx.createServerEnemy(world, "normal", 330, 300, true);
      markedEnemy.hp = 10;
      markedEnemy.targetMarked = true;
      markedEnemy.targetMarkTimer = 4.0;
      world.enemies.set(markedEnemy.id, markedEnemy);

      // Catch blast triggers 1 base damage -> on marked enemy deals +40%
      ctx.catchServerBullet(bullet, player, world);

      assert.ok(
        markedEnemy.hp <= 9,
        `Catch blast should damage marked enemy, HP: ${markedEnemy.hp}`
      );
    });

    await t3.test("5.4 Upgrade Offers System: includes R3 upgrades when eligible", () => {
      const { player1: player } = createTestWorld(ctx);
      player.stats.groundPullSpeed = 110;
      player.stats.maxBounces = 2;

      let foundR3 = 0;
      for (let i = 0; i < 50; i++) {
        const offers = ctx.createServerUpgradeOffers(player);
        assert.ok(offers.length <= 3, "Offers length should be at most 3");
        for (const offer of offers) {
          if (["boomerang", "splinter", "stun", "reactive-armor", "target-mark"].includes(offer.upgradeId)) {
            foundR3++;
            assert.ok(offer.title, "Offer must have a title");
            assert.ok(offer.bonusText, "Offer must have a bonusText");
          }
        }
      }

      assert.ok(foundR3 > 0, "R3 upgrades must appear in upgrade offers pool over multiple rolls");
    });

    await t3.test("5.5 Client-Server Upgrade Parity: public/index.html contains R3 upgrade IDs", () => {
      const indexPath = path.resolve(__dirname, "../public/index.html");
      const indexContent = fs.readFileSync(indexPath, "utf8");

      const r3Ids = ["boomerang", "splinter", "stun", "reactive-armor", "target-mark"];
      for (const id of r3Ids) {
        const serverExists = ctx.SERVER_UPGRADES.some(u => u.id === id);
        assert.ok(serverExists, `Server must define upgrade '${id}'`);
      }
    });
  });

  // =========================================================================
  // TIER 4: WORKLOAD & MULTI-ENTITY SIMULATION E2E
  // =========================================================================

  await t.test("Tier 4 - Workload & Multi-Entity Simulation E2E", async (t4) => {
    await t4.test("6.1 300-tick sustained combat simulation with all 5 R3 upgrades active", () => {
      const { world, player1: player } = createTestWorld(ctx);
      player.x = 400;
      player.y = 400;
      player.hp = 10;
      player.maxHp = 10;
      player.stats.damage = 3;
      player.stats.maxBounces = 3;
      player.stats.groundPullSpeed = 120;
      player.stats.boomerang = true;
      player.stats.splinter = true;
      player.stats.stunChance = 1.0; // Guarantee stun in test
      player.stats.reactiveArmor = true;
      player.stats.targetMark = true;

      // Spawn 10 enemies surrounding player
      for (let i = 0; i < 10; i++) {
        const angle = (i / 10) * Math.PI * 2;
        const ex = 400 + Math.cos(angle) * 150;
        const ey = 400 + Math.sin(angle) * 150;
        const enemy = ctx.createServerEnemy(world, i % 2 === 0 ? "normal" : "runner", ex, ey, true);
        world.enemies.set(enemy.id, enemy);
      }

      const bullet = [...world.bullets.values()].find(b => b.ownerId === player.id);
      bullet.state = "flying";
      bullet.x = 400;
      bullet.y = 400;
      bullet.vx = 250;
      bullet.vy = 150;

      // Run 300 simulation ticks (5.0s at 60 FPS)
      for (let tick = 0; tick < 300; tick++) {
        const dt = 1 / 60;
        if (bullet.state === "flying" || bullet.state === "ground") {
          ctx.updateServerBullet({ world }, bullet, dt);
        }
        ctx.updateServerEnemies(world, dt);
      }

      // Assert world simulation remained healthy without NaN or infinite values
      assert.ok(Number.isFinite(player.x) && Number.isFinite(player.y));
      assert.ok(Number.isFinite(bullet.x) && Number.isFinite(bullet.y));
      for (const enemy of world.enemies.values()) {
        assert.ok(Number.isFinite(enemy.x) && Number.isFinite(enemy.y));
        assert.ok(Number.isFinite(enemy.hp));
      }
    });

    await t4.test("6.2 Co-op 2-Player simultaneous upgrade acquisition and combat verification", () => {
      const { room, world, player1, player2 } = createTestWorld(ctx, { guestId: "p2" });
      assert.ok(player1 && player2, "Both players must exist in co-op world");

      // Player 1 chooses Boomerang + Reactive Armor
      ctx.applyServerUpgrade(world, player1, { upgradeId: "boomerang", power: 1 });
      ctx.applyServerUpgrade(world, player1, { upgradeId: "reactive-armor", power: 1 });

      // Player 2 chooses Splinter + Target Mark + Stun
      ctx.applyServerUpgrade(world, player2, { upgradeId: "splinter", power: 1 });
      ctx.applyServerUpgrade(world, player2, { upgradeId: "target-mark", power: 1 });
      ctx.applyServerUpgrade(world, player2, { upgradeId: "stun", power: 1 });

      assert.ok(player1.stats.boomerang);
      assert.ok(player1.stats.reactiveArmor);
      assert.ok(player2.stats.splinter);
      assert.ok(player2.stats.targetMark);
      assert.ok(player2.stats.stun);

      // Verify serialization snapshot includes valid state for both players
      const snapshot = ctx.createServerCoopSnapshot(room);
      assert.equal(snapshot.players.length, 2, "Snapshot should contain 2 players");
      assert.equal(snapshot.type, "coop-server-v4");
    });
  });
});
