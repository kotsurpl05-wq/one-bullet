const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadServerInstance } = require("./helpers/server_loader.js");
const { createTestWorld } = require("./helpers/test_utils.js");

test("M1 Rebalance & Foundation Suite (Requirement R1)", async (t) => {
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
  // 1. BOSS HP SCALING & COOP MULTIPLIER (Items 1 & 2)
  // =========================================================================
  await t.test("1.1 Polynomial Boss HP scaling formula: 48 + tier * 20 + tier * tier * 8", () => {
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

  await t.test("1.2 COOP_BOSS_HP_MULTIPLIER = 1.8 and Wave 30 HP >= 800 (821)", () => {
    const { world } = createTestWorld(ctx);
    assert.equal(ctx.COOP_BOSS_HP_MULTIPLIER, 1.8, "COOP_BOSS_HP_MULTIPLIER must be 1.8");

    // Wave 30 -> tier 6 -> baseHp = 456 -> coopHp = Math.round(456 * 1.8) = 821
    world.wave = 30;
    const bossWave30 = ctx.createServerEnemy(world, "boss", 400, 300, true);
    assert.ok(bossWave30.hp >= 800, `Wave 30 Boss HP must be >= 800 (got ${bossWave30.hp})`);
    assert.equal(bossWave30.hp, 821, "Wave 30 Boss HP should be exactly 821");
    assert.equal(bossWave30.maxHp, 821);
  });

  await t.test("1.3 Client & Server Boss HP parity across waves 5, 10, 15, 20, 25, 30", () => {
    const indexHtmlPath = path.resolve(process.cwd(), "public/index.html");
    const html = fs.readFileSync(indexHtmlPath, "utf8");

    // Verify polynomial formula exists in public/index.html
    assert.ok(
      html.includes("48 +") && html.includes("bossTier * 20") && html.includes("bossTier * bossTier * 8"),
      "public/index.html must use the polynomial boss HP formula: 48 + bossTier * 20 + bossTier * bossTier * 8"
    );

    const { world } = createTestWorld(ctx);
    const waves = [
      { wave: 5, tier: 1, baseHp: 76, coopHp: 137 },
      { wave: 10, tier: 2, baseHp: 120, coopHp: 216 },
      { wave: 15, tier: 3, baseHp: 180, coopHp: 324 },
      { wave: 20, tier: 4, baseHp: 256, coopHp: 461 },
      { wave: 25, tier: 5, baseHp: 348, coopHp: 626 },
      { wave: 30, tier: 6, baseHp: 456, coopHp: 821 }
    ];

    for (const item of waves) {
      world.wave = item.wave;
      const boss = ctx.createServerEnemy(world, "boss", 500, 500, true);
      assert.equal(boss.bossTier, item.tier, `Wave ${item.wave} must have bossTier ${item.tier}`);
      assert.equal(boss.hp, item.coopHp, `Wave ${item.wave} coop HP should be ${item.coopHp}`);
    }
  });

  // =========================================================================
  // 2. BOSS XP SCALING & BOSSTIER ATTACHMENT (Item 3)
  // =========================================================================
  await t.test("2.1 Wave-scaled co-op boss XP: 8 + bossTier * 2 and bossTier property on entity", () => {
    const { world } = createTestWorld(ctx);

    const waves = [
      { wave: 5, expectedTier: 1, expectedXp: 10 },
      { wave: 10, expectedTier: 2, expectedXp: 12 },
      { wave: 15, expectedTier: 3, expectedXp: 14 },
      { wave: 20, expectedTier: 4, expectedXp: 16 },
      { wave: 25, expectedTier: 5, expectedXp: 18 },
      { wave: 30, expectedTier: 6, expectedXp: 20 }
    ];

    for (const item of waves) {
      world.wave = item.wave;
      const boss = ctx.createServerEnemy(world, "boss", 500, 500, true);
      assert.equal(boss.bossTier, item.expectedTier, `Enemy object must possess bossTier === ${item.expectedTier}`);
      const xp = ctx.getServerEnemyExperience(boss);
      assert.equal(xp, item.expectedXp, `Boss tier ${item.expectedTier} must drop ${item.expectedXp} XP`);
    }
  });

  await t.test("2.2 Client getEnemyExperienceAmount parity with server", () => {
    const indexHtmlPath = path.resolve(process.cwd(), "public/index.html");
    const html = fs.readFileSync(indexHtmlPath, "utf8");

    assert.ok(
      html.includes("8 + bossTier * 2"),
      "public/index.html getEnemyExperienceAmount must calculate 8 + bossTier * 2 for boss"
    );
  });

  // =========================================================================
  // 3. SECOND BULLET RARITY (Item 4)
  // =========================================================================
  await t.test("3.1 second-bullet has fixedRarity: 'rare' in server and client", () => {
    const secondBullet = ctx.SERVER_UPGRADES.find(u => u.id === "second-bullet");
    assert.ok(secondBullet, "second-bullet must exist in SERVER_UPGRADES");
    assert.equal(secondBullet.fixedRarity, "rare", "second-bullet fixedRarity must be 'rare' on server");

    const rolled = ctx.rollServerUpgradeRarity(secondBullet);
    assert.equal(rolled.key, "rare", "Rolled rarity for second-bullet must be rare");
    assert.equal(rolled.power, 2, "Rare rarity power must be 2");

    const indexHtmlPath = path.resolve(process.cwd(), "public/index.html");
    const html = fs.readFileSync(indexHtmlPath, "utf8");
    assert.match(
      html,
      /title:\s*"Запасной патрон"[\s\S]*?fixedRarity:\s*"rare"/,
      "public/index.html must declare fixedRarity: 'rare' for 'Запасной патрон'"
    );
  });

  // =========================================================================
  // 4. CRITICAL REBALANCE (Item 5)
  // =========================================================================
  await t.test("4.1 Critical strike +18% per common power, 2.5x crit damage multiplier", () => {
    const criticalUpgrade = ctx.SERVER_UPGRADES.find(u => u.id === "critical");
    assert.ok(criticalUpgrade, "critical upgrade must exist");

    const { player1 } = createTestWorld(ctx);
    player1.stats.critChance = 0.0;

    // Power 1 bonus text (18%)
    const bonusCommon = criticalUpgrade.bonus(player1, 1);
    assert.match(bonusCommon, /18%/, "Common power 1 must describe +18% crit chance");

    // Power 2 bonus text (36%)
    const bonusRare = criticalUpgrade.bonus(player1, 2);
    assert.match(bonusRare, /36%/, "Rare power 2 must describe +36% crit chance");

    // Application
    ctx.applyServerUpgrade(player1, "critical", 1);
    assert.ok(Math.abs(player1.stats.critChance - 0.18) < 1e-4, "Crit chance after power 1 should be 0.18");

    // Verify 2.5x multiplier in server.js source and client source
    const serverPath = path.resolve(process.cwd(), "server.js");
    const serverCode = fs.readFileSync(serverPath, "utf8");
    assert.ok(
      serverCode.includes("baseDamage * 2.5"),
      "server.js bullet hit damage must use baseDamage * 2.5 for critical hits"
    );

    const indexHtmlPath = path.resolve(process.cwd(), "public/index.html");
    const html = fs.readFileSync(indexHtmlPath, "utf8");
    assert.ok(
      html.includes("stats.damage * 2.5"),
      "public/index.html bullet hit damage must use stats.damage * 2.5 for critical hits"
    );
  });

  // =========================================================================
  // 5. MAGNETIC FIELD MERGE (Item 6)
  // =========================================================================
  await t.test("5.1 'Магнитное поле' grants dual pickup radius (+35) and ground pull (+110) per power", () => {
    const magneticUpgrade = ctx.SERVER_UPGRADES.find(
      u => u.id === "pickup" || u.id === "magnetic-field"
    );
    assert.ok(magneticUpgrade, "Merged magnetic upgrade must exist");
    assert.equal(magneticUpgrade.title, "Магнитное поле", "Title must be 'Магнитное поле'");

    const { player1 } = createTestWorld(ctx);
    player1.stats.pickupRadius = 0;
    player1.stats.groundPullSpeed = 0;

    ctx.applyServerUpgrade(player1, magneticUpgrade.id, 1);
    assert.equal(player1.stats.pickupRadius, 35, "pickupRadius should increase by 35");
    assert.equal(player1.stats.groundPullSpeed, 110, "groundPullSpeed should increase by 110");

    // Apply with power = 2
    ctx.applyServerUpgrade(player1, magneticUpgrade.id, 2);
    assert.equal(player1.stats.pickupRadius, 35 + 70, "pickupRadius should be 105");
    assert.equal(player1.stats.groundPullSpeed, 110 + 220, "groundPullSpeed should be 330");
  });

  await t.test("5.2 Removal of magnet mutual exclusivity in draft availability", () => {
    const indexHtmlPath = path.resolve(process.cwd(), "public/index.html");
    const html = fs.readFileSync(indexHtmlPath, "utf8");

    assert.ok(
      !html.includes('upgrade.title === "Магнитный захват" && (stats.groundPullSpeed || 0) > 0'),
      "Mutual exclusivity check for magnets must be removed from public/index.html"
    );
    assert.ok(
      html.includes('"Магнитное поле": `<svg'),
      "upgradeIcons in public/index.html must include 'Магнитное поле'"
    );
  });

  // =========================================================================
  // 6. SMOOTHED STEPPED XP CURVE (Item 7)
  // =========================================================================
  await t.test("6.1 Stepped XP formula: floor((10 + progression * 4 + floor(progression / 5) * 5) * 0.8)", () => {
    function expectedXp(lvl) {
      const progression = Math.max(0, lvl - 1);
      return Math.floor((10 + progression * 4 + Math.floor(progression / 5) * 5) * 0.8);
    }

    const testLevels = [
      { level: 1, expected: 8 },
      { level: 2, expected: 11 },
      { level: 3, expected: 14 },
      { level: 4, expected: 17 },
      { level: 5, expected: 20 },
      { level: 6, expected: 28 },   // +5 Step at progression 5
      { level: 7, expected: 31 },
      { level: 10, expected: 40 },
      { level: 11, expected: 48 },  // +5 Step at progression 10
      { level: 15, expected: 60 },
      { level: 16, expected: 68 },  // +5 Step at progression 15
      { level: 20, expected: 80 },
      { level: 21, expected: 88 }  // +5 Step at progression 20
    ];

    for (const item of testLevels) {
      const serverXp = ctx.getServerExperienceRequirement(item.level);
      const expected = expectedXp(item.level);
      assert.equal(serverXp, expected, `Level ${item.level} XP requirement must be ${expected}, got ${serverXp}`);
    }
  });

  await t.test("6.2 Client getExperienceRequirement parity with server across levels 1-30", () => {
    const indexHtmlPath = path.resolve(process.cwd(), "public/index.html");
    const html = fs.readFileSync(indexHtmlPath, "utf8");

    const match = html.match(/function\s+getExperienceRequirement\s*\([^)]*\)\s*\{([\s\S]*?)\n\s{4}\}/);
    assert.ok(match, "getExperienceRequirement must be present in public/index.html");

    const clientGetXp = new Function("level", match[1]);

    for (let lvl = 1; lvl <= 30; lvl++) {
      const serverXp = ctx.getServerExperienceRequirement(lvl);
      const clientXp = clientGetXp(lvl);
      assert.equal(clientXp, serverXp, `Level ${lvl} mismatch: client ${clientXp} vs server ${serverXp}`);
    }

    // Check initial HUD value is 0 / 10
    assert.ok(html.includes('<strong id="experienceValue">0 / 10</strong>'), "Initial HUD must display 0 / 10");
  });

  // =========================================================================
  // 7. INTEGRATION & END-TO-END WORKLOAD SIMULATION
  // =========================================================================
  await t.test("7.1 Full 30-wave progression simulation with rebalanced mechanics", () => {
    const { room, world, player1 } = createTestWorld(ctx);
    world.level = 1;
    world.experience = 0;
    world.experienceToNext = ctx.getServerExperienceRequirement(1);

    let totalBossesKilled = 0;
    const bossHpCheck = {
      5: 137,
      10: 216,
      15: 324,
      20: 461,
      25: 626,
      30: 821
    };

    for (let wave = 1; wave <= 30; wave++) {
      world.wave = wave;

      if (wave % 5 === 0) {
        totalBossesKilled++;
        const boss = ctx.createServerEnemy(world, "boss", 500, 500, true);
        assert.equal(boss.hp, bossHpCheck[wave], `Wave ${wave} Boss HP must be ${bossHpCheck[wave]}`);

        const xp = ctx.getServerEnemyExperience(boss);
        const tier = Math.floor(wave / 5);
        assert.equal(xp, 8 + tier * 2, `Wave ${wave} Boss XP must be ${8 + tier * 2}`);

        ctx.addServerExperience(room, xp);
      } else {
        // Regular wave kills
        ctx.addServerExperience(room, 12);
      }
    }

    assert.equal(totalBossesKilled, 6, "Must encounter exactly 6 bosses in 30 waves");
    assert.ok(world.level >= 10, "World level should advance smoothly through stepped progression");
  });
});
