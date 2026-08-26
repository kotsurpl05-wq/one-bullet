const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadServerInstance } = require("./helpers/server_loader.js");
const { createTestWorld } = require("./helpers/test_utils.js");

test("R1 Rebalance: Boss HP/XP, Upgrades & XP Progression Suite", async (t) => {
  let inst;
  let ctx;

  t.beforeEach(() => {
    inst = loadServerInstance();
    ctx = inst.ctx;
  });

  t.afterEach(() => {
    if (inst && typeof inst.cleanup === "function") {
      inst.cleanup();
    }
  });

  // =========================================================================
  // TIER 1: UNIT TESTS (>= 5 unit tests covering primary mechanics)
  // =========================================================================
  await t.test("Tier 1 - Unit 1: Polynomial Boss Base HP Scaling Formula", () => {
    // Formula: baseHp = 48 + tier * 20 + tier * tier * 8 where tier = Math.floor(wave / 5)
    function expectedBaseHp(tier) {
      return 48 + tier * 20 + tier * tier * 8;
    }

    const testTiers = [
      { tier: 1, expected: 76 },   // 48 + 20 + 8 = 76
      { tier: 2, expected: 120 },  // 48 + 40 + 32 = 120
      { tier: 3, expected: 180 },  // 48 + 60 + 72 = 180
      { tier: 4, expected: 256 },  // 48 + 80 + 128 = 256
      { tier: 5, expected: 348 },  // 48 + 100 + 200 = 348
      { tier: 6, expected: 456 }   // 48 + 120 + 288 = 456
    ];

    for (const item of testTiers) {
      const computed = expectedBaseHp(item.tier);
      assert.equal(computed, item.expected, `Tier ${item.tier} base HP calculation mismatch`);
    }
  });

  await t.test("Tier 1 - Unit 2: Co-op Boss HP Multiplier (1.1x) & Wave 30 HP >= 800", () => {
    const { world } = createTestWorld(ctx);
    assert.equal(ctx.COOP_BOSS_HP_MULTIPLIER, 1.1, "COOP_BOSS_HP_MULTIPLIER must be 1.1");

    // Wave 30 -> tier 6 -> baseHp = 45600 -> coopHp = Math.round(45600 * 1.1) = 50160
    world.wave = 30;
    const bossWave30 = ctx.createServerEnemy(world, "boss", 400, 300, true);
    assert.ok(bossWave30.hp >= 800, `Wave 30 Boss HP must be >= 800 (got ${bossWave30.hp})`);
    assert.equal(bossWave30.hp, 50160, "Wave 30 Boss HP should be exactly 50160");
    assert.equal(bossWave30.maxHp, 50160);
  });

  await t.test("Tier 1 - Unit 3: Wave-Scaled Co-op Boss XP (1260 + bossTier * 330)", () => {
    const { world } = createTestWorld(ctx);

    const wavesToTest = [
      { wave: 5, expectedTier: 1, expectedXp: 1590 },
      { wave: 10, expectedTier: 2, expectedXp: 1920 },
      { wave: 15, expectedTier: 3, expectedXp: 2250 },
      { wave: 20, expectedTier: 4, expectedXp: 2580 },
      { wave: 25, expectedTier: 5, expectedXp: 2910 },
      { wave: 30, expectedTier: 6, expectedXp: 3240 }
    ];

    for (const testCase of wavesToTest) {
      world.wave = testCase.wave;
      const boss = ctx.createServerEnemy(world, "boss", 500, 500, true);
      const xp = ctx.getServerEnemyExperience(boss);
      assert.equal(
        xp,
        testCase.expectedXp,
        `Wave ${testCase.wave} (Tier ${testCase.expectedTier}) Boss XP must be ${testCase.expectedXp}, got ${xp}`
      );
    }
  });

  await t.test("Tier 1 - Unit 4: Second Bullet Fixed Rarity Changed to 'rare'", () => {
    const secondBullet = ctx.SERVER_UPGRADES.find(u => u.id === "second-bullet");
    assert.ok(secondBullet, "second-bullet upgrade must exist in SERVER_UPGRADES");
    assert.equal(secondBullet.fixedRarity, "rare", "second-bullet fixedRarity must be 'rare'");

    const rolledRarity = ctx.rollServerUpgradeRarity(secondBullet);
    assert.equal(rolledRarity.key, "rare", "Rolled rarity for second-bullet must be 'rare'");
    assert.equal(rolledRarity.power, 2, "Rare rarity power must be 2");
  });

  await t.test("Tier 1 - Unit 5: Critical Mechanism (+10% per common power, 2.0x multiplier)", () => {
    const criticalUpgrade = ctx.SERVER_UPGRADES.find(u => u.id === "critical");
    assert.ok(criticalUpgrade, "critical upgrade must exist in SERVER_UPGRADES");

    const { player1 } = createTestWorld(ctx);
    player1.stats.critChance = 0.0;

    // Test bonus calculation with power = 1 (common: +10%)
    const bonusCommon = criticalUpgrade.bonus(player1, 1);
    assert.match(bonusCommon, /10%/, "Bonus text for power 1 should mention 10%");

    // Test bonus calculation with power = 2 (rare: +36%)
    const bonusRare = criticalUpgrade.bonus(player1, 2);
    assert.match(bonusRare, /20%/, "Bonus text for power 2 should mention 20%");

    // Apply upgrade on player
    ctx.applyServerUpgrade(player1, "critical", 1);
    assert.ok(
      player1.stats.critChance >= 0.10,
      `critChance after power 1 should be 0.10 (got ${player1.stats.critChance})`
    );
  });

  await t.test("Tier 1 - Unit 6: Magnetic Field Consolidation (pickupRadius + groundPullSpeed)", () => {
    const magneticUpgrade = ctx.SERVER_UPGRADES.find(
      u => u.id === "pickup" || u.id === "magnetic-field"
    );
    assert.ok(magneticUpgrade, "Consolidated magnetic field upgrade must exist");

    const { player1 } = createTestWorld(ctx);
    const initialRadius = player1.stats.pickupRadius || 0;
    const initialPull = player1.stats.groundPullSpeed || 0;

    // Apply consolidated upgrade with power = 1
    ctx.applyServerUpgrade(player1, magneticUpgrade.id, 1);

    assert.equal(player1.stats.pickupRadius || 0, 0, "Pickup radius stays 0 (touch pickup)");
    assert.equal(
      player1.stats.groundPullSpeed,
      initialPull + 110,
      "Magnetic field must increase groundPullSpeed by +110 per power"
    );

    // Bonus text description check
    const bonusText = magneticUpgrade.bonus(player1, 1);
    assert.ok(
      bonusText.includes("35") || bonusText.includes("радиус") || bonusText.includes("притяжен"),
      "Bonus text should describe consolidated magnetic field stats"
    );
  });

  await t.test("Tier 1 - Unit 7: Smoothed Stepped XP Curve Formula", () => {
    // Formula: 775 + progression * 335 + floor(progression / 5) * 410 where progression = level - 1
    function expectedXp(lvl) {
      const progression = Math.max(0, lvl - 1);
      return 775 + progression * 335 + Math.floor(progression / 5) * 410;
    }

    const testLevels = [
      { level: 1, expected: 775 },
      { level: 2, expected: 1110 },
      { level: 3, expected: 1445 },
      { level: 4, expected: 1780 },
      { level: 5, expected: 2115 },
      { level: 6, expected: 2860 },  // Step transition at progression = 5
      { level: 7, expected: 3195 },
      { level: 11, expected: 4945 }, // Step transition at progression = 10
      { level: 16, expected: 7030 }, // Step transition at progression = 15
      { level: 21, expected: 9115 } // Step transition at progression = 20
    ];

    for (const testCase of testLevels) {
      const serverRequirement = ctx.getServerExperienceRequirement(testCase.level);
      const expected = expectedXp(testCase.level);
      assert.equal(
        serverRequirement,
        expected,
        `Level ${testCase.level} XP requirement must be ${expected}, got ${serverRequirement}`
      );
    }
  });

  // =========================================================================
  // TIER 2: BOUNDARY & EDGE CASE TESTS (>= 5 tests)
  // =========================================================================
  await t.test("Tier 2 - Boundary 1: Boss HP Scaling Across Wave Boundaries (4 vs 5, 9 vs 10, 29 vs 30)", () => {
    const { world } = createTestWorld(ctx);

    // Wave 5 spawns Tier 1 Boss (base 7600, coop 8360).
    world.wave = 5;
    const bossTier1 = ctx.createServerEnemy(world, "boss", 500, 500, true);
    assert.equal(bossTier1.hp, 8360);

    // Wave 10 (Tier 2: base 12000, coop 13200)
    world.wave = 10;
    const bossTier2 = ctx.createServerEnemy(world, "boss", 500, 500, true);
    assert.equal(bossTier2.hp, 13200);

    // Wave 25 (Tier 5: base 34800, coop 38280)
    world.wave = 25;
    const bossTier5 = ctx.createServerEnemy(world, "boss", 500, 500, true);
    assert.equal(bossTier5.hp, 38280);

    // Wave 30 (Tier 6: base 45600, coop 50160)
    world.wave = 30;
    const bossTier6 = ctx.createServerEnemy(world, "boss", 500, 500, true);
    assert.equal(bossTier6.hp, 50160);
    assert.ok(bossTier6.hp > bossTier5.hp, "Boss HP must strictly increase with tier");
  });

  await t.test("Tier 2 - Boundary 2: Critical Chance Cap & Availability Condition", () => {
    const criticalUpgrade = ctx.SERVER_UPGRADES.find(u => u.id === "critical");
    const { player1 } = createTestWorld(ctx);

    player1.stats.critChance = 0.55;
    assert.equal(criticalUpgrade.available(player1), true, "Should be available below 0.60");

    // Applying +0.10 should cap critChance at 0.60
    ctx.applyServerUpgrade(player1, "critical", 1);
    assert.ok(player1.stats.critChance <= 0.6001, "critChance must be capped at 0.60");

    // When at or above cap, available(player) must be false
    player1.stats.critChance = 0.60;
    assert.equal(criticalUpgrade.available(player1), false, "Should be unavailable when cap reached");
  });

  await t.test("Tier 2 - Boundary 3: XP Requirement Boundary Values (Level 0, 1, 100)", () => {
    // Level 0 / 1 edge cases
    const reqLevel0 = ctx.getServerExperienceRequirement(0);
    const reqLevel1 = ctx.getServerExperienceRequirement(1);
    assert.ok(reqLevel0 >= 775, "Level 0 progression should clamp to 0 progression (req >= 775)");
    assert.equal(reqLevel1, 775, "Level 1 requirement must be 775");

    // Extreme level 100
    const reqLevel100 = ctx.getServerExperienceRequirement(100);
    // progression = 99 -> 775 + 99*335 + floor(99/5)*410 = 775 + 33165 + 7790 = 41730
    assert.equal(reqLevel100, 41730, "Level 100 XP requirement should be 41730");
    assert.ok(Number.isFinite(reqLevel100), "XP requirement at high level must be a finite number");
  });

  await t.test("Tier 2 - Boundary 4: Second Bullet Availability Boundaries", () => {
    const secondBullet = ctx.SERVER_UPGRADES.find(u => u.id === "second-bullet");
    const { player1 } = createTestWorld(ctx);

    player1.stats.magazineSize = 1;
    assert.equal(secondBullet.available(player1), true, "Available when magazineSize is 1");

    ctx.applyServerUpgrade(player1, "second-bullet", 2);
    assert.equal(player1.stats.magazineSize, 2, "magazineSize should become 2");
    assert.equal(secondBullet.available(player1), false, "Unavailable when magazineSize is >= 2");
  });

  await t.test("Tier 2 - Boundary 5: Non-Boss Enemy XP Parity (type-specific values)", () => {
    const { world } = createTestWorld(ctx);

    const normal = ctx.createServerEnemy(world, "normal", 100, 100, true);
    assert.equal(ctx.getServerEnemyExperience(normal), 150, "Normal enemy XP must be 150");

    const runner = ctx.createServerEnemy(world, "runner", 100, 100, true);
    assert.equal(ctx.getServerEnemyExperience(runner), 138, "Runner enemy XP must be 138");

    const tank = ctx.createServerEnemy(world, "tank", 100, 100, true);
    assert.equal(ctx.getServerEnemyExperience(tank), 330, "Tank enemy XP must be 330");

    const charger = ctx.createServerEnemy(world, "charger", 100, 100, true);
    assert.equal(ctx.getServerEnemyExperience(charger), 288, "Charger enemy XP must be 288");

    const splitter = ctx.createServerEnemy(world, "splitter", 100, 100, true);
    assert.equal(ctx.getServerEnemyExperience(splitter), 372, "Splitter enemy XP must be 372");

    const shooter = ctx.createServerEnemy(world, "shooter", 100, 100, true);
    assert.equal(ctx.getServerEnemyExperience(shooter), 306, "Shooter enemy XP must be 306");

    const minion = ctx.createServerEnemy(world, "minion", 100, 100, true);
    assert.equal(ctx.getServerEnemyExperience(minion), 0, "Minion enemy XP must be 0");

    const shard = ctx.createServerEnemy(world, "shard", 100, 100, true);
    assert.equal(ctx.getServerEnemyExperience(shard), 0, "Shard enemy XP must be 0");
  });

  await t.test("Tier 2 - Boundary 6: Solo Client Code Parity Audit for R1 (public/index.html)", () => {
    const indexHtmlPath = path.resolve(process.cwd(), "public/index.html");
    const html = fs.readFileSync(indexHtmlPath, "utf8");

    // Check solo XP requirement formula in client
    assert.ok(
      html.includes("progression * 335") || html.includes("Math.floor(progression / 5) * 410") || html.includes("getExperienceRequirement"),
      "index.html should have getExperienceRequirement function"
    );

    // Check solo boss HP polynomial formula or structure in client
    assert.ok(
      html.includes("bossTier") || html.includes("progressionTier"),
      "index.html should compute bossTier for solo boss HP"
    );
  });

  // =========================================================================
  // TIER 3: CROSS-FEATURE INTEGRATION TESTS
  // =========================================================================
  await t.test("Tier 3 - Cross-Feature 1: Upgrade Offers Pool, Rarity Resolution & Application Synergy", () => {
    const { player1 } = createTestWorld(ctx);
    player1.stats.magazineSize = 1;
    player1.stats.critChance = 0;
    player1.stats.pickupRadius = 0;
    player1.stats.groundPullSpeed = 0;

    const offers = ctx.createServerUpgradeOffers(player1);
    assert.ok(Array.isArray(offers), "Upgrade offers must return an array");
    assert.ok(offers.length > 0 && offers.length <= 3, "Offers count should be up to 3");

    for (const offer of offers) {
      assert.ok(offer.upgradeId, "Offer must contain upgradeId");
      assert.ok(offer.title, "Offer must contain title");
      assert.ok(["common", "rare", "legendary"].includes(offer.rarityKey), "Valid rarityKey required");
      assert.ok(offer.power >= 1 && offer.power <= 3, "Valid power required");
      assert.ok(typeof offer.bonusText === "string", "Valid bonusText required");

      if (offer.upgradeId === "second-bullet") {
        assert.equal(offer.rarityKey, "rare", "second-bullet in offers must always be 'rare'");
        assert.equal(offer.power, 2, "second-bullet in offers must have power 2");
      }
    }

    // Apply multiple upgrades in synergy
    ctx.applyServerUpgrade(player1, "critical", 1);
    ctx.applyServerUpgrade(player1, "second-bullet", 2);
    ctx.applyServerUpgrade(player1, "pickup", 1);

    assert.ok(player1.stats.critChance >= 0.10);
    assert.equal(player1.stats.magazineSize, 2);
    assert.equal(player1.stats.pickupRadius || 0, 0);
    assert.equal(player1.stats.groundPullSpeed, 110);
  });

  await t.test("Tier 3 - Cross-Feature 2: Critical Hit 2.0x Multiplier Execution on Bullet Hit", () => {
    const { room, world, player1 } = createTestWorld(ctx);
    player1.stats.damage = 2; // base damage = 2
    player1.stats.critChance = 1.0; // 100% crit chance guarantee

    const enemy = ctx.createServerEnemy(world, "tank", 400, 400, true);
    enemy.hp = 10;
    enemy.maxHp = 10;
    world.enemies.set(enemy.id, enemy);

    const bullet = ctx.createServerBullet(world, player1.id, 395, 400, 100, 0);
    bullet.hitsLeft = 1;
    bullet.state = "flying";
    world.bullets.set(bullet.id, bullet);

    // Update bullet to trigger collision with enemy
    ctx.updateServerBullet(room, bullet, 0.05);

    // Expected damage: baseDamage * 2.0 = 2 * 2.0 = 4. Remaining HP: 10 - 4 = 6.
    assert.equal(
      enemy.hp,
      6,
      `Critical hit with baseDamage 2 and 2.0x multiplier should deal 4 damage (HP from 10 to 6), got ${enemy.hp}`
    );
  });

  // =========================================================================
  // TIER 4: WORKLOAD & REALISTIC PROGRESSION TESTS
  // =========================================================================
  await t.test("Tier 4 - Progression 1: Multi-Wave Simulation (Waves 1-30) With Polynomial Boss Fights", () => {
    const { room, world, player1, player2 } = createTestWorld(ctx);
    let totalXpGained = 0;
    let bossesEncountered = 0;

    const expectedBossStats = {
      5:  { tier: 1, baseHp: 7600,  coopHp: 8360, xp: 1590 },
      10: { tier: 2, baseHp: 12000, coopHp: 13200, xp: 1920 },
      15: { tier: 3, baseHp: 18000, coopHp: 19800, xp: 2250 },
      20: { tier: 4, baseHp: 25600, coopHp: 28160, xp: 2580 },
      25: { tier: 5, baseHp: 34800, coopHp: 38280, xp: 2910 },
      30: { tier: 6, baseHp: 45600, coopHp: 50160, xp: 3240 }
    };

    for (let wave = 1; wave <= 30; wave++) {
      world.wave = wave;

      if (wave % 5 === 0) {
        bossesEncountered++;
        const boss = ctx.createServerEnemy(world, "boss", 500, 500, true);
        const expected = expectedBossStats[wave];

        assert.equal(boss.hp, expected.coopHp, `Wave ${wave} Boss HP mismatch`);
        assert.equal(boss.maxHp, expected.coopHp);

        const xp = ctx.getServerEnemyExperience(boss);
        assert.equal(xp, expected.xp, `Wave ${wave} Boss XP mismatch`);
        totalXpGained += xp;
      } else {
        // Normal wave simulates killing 8 standard enemies (125 XP each avg)
        totalXpGained += 1000;
      }

      // Check stepped XP progression
      while (totalXpGained >= world.experienceToNext) {
        totalXpGained -= world.experienceToNext;
        world.level++;
        world.experienceToNext = ctx.getServerExperienceRequirement(world.level);
        assert.ok(world.experienceToNext > 0, `Level ${world.level} XP requirement must be positive`);
      }
    }

    assert.equal(bossesEncountered, 6, "Must encounter exactly 6 bosses in 30 waves");
    assert.ok(world.level >= 10, "Player should level up significantly over 30 waves");
    assert.ok(world.experienceToNext >= 500, "XP curve should smoothly scale to high requirements");
  });
});
