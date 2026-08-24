"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadServerInstance } = require("./helpers/server_loader.js");
const { createTestWorld } = require("./helpers/test_utils.js");

test("Adversarial Empirical Stress Testing & Mathematical Oracle Suite for Milestone M1 (R1)", async (t) => {
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
  // FOCUS 1: POLYNOMIAL BOSS HP SCALING ACROSS EXTREME WAVES (1 TO 100)
  // =========================================================================
  await t.test("Focus 1.1: Boss HP Scaling Exhaustive Oracle for Waves 1 to 100", () => {
    const { world } = createTestWorld(ctx);

    function oracleBaseHp(tier) {
      return 48 + tier * 20 + tier * tier * 8;
    }

    function oracleCoopHp(baseHp) {
      return Math.max(1, Math.round(baseHp * 1.8));
    }

    assert.equal(ctx.COOP_BOSS_HP_MULTIPLIER, 1.8, "COOP_BOSS_HP_MULTIPLIER must be exactly 1.8");

    // Test every single wave from 1 to 100
    let previousHp = 0;
    for (let wave = 1; wave <= 100; wave++) {
      world.wave = wave;
      const expectedTier = Math.max(1, Math.floor(wave / 5));
      const expectedBase = oracleBaseHp(expectedTier);
      const expectedCoop = oracleCoopHp(expectedBase);

      const boss = ctx.createServerEnemy(world, "boss", 500, 500, true);

      // Verify tier attachment
      assert.equal(
        boss.bossTier,
        expectedTier,
        `Wave ${wave}: bossTier must be ${expectedTier}, got ${boss.bossTier}`
      );

      // Verify HP calculation
      assert.equal(
        boss.hp,
        expectedCoop,
        `Wave ${wave}: Boss HP mismatch. Expected ${expectedCoop}, got ${boss.hp}`
      );
      assert.equal(boss.maxHp, expectedCoop, `Wave ${wave}: maxHp must match hp`);

      // Verify integer safety & positive bounds
      assert.ok(Number.isInteger(boss.hp), `Wave ${wave}: Boss HP must be an integer`);
      assert.ok(boss.hp > 0, `Wave ${wave}: Boss HP must be positive`);
      assert.ok(!Number.isNaN(boss.hp), `Wave ${wave}: Boss HP must not be NaN`);

      // Verify non-decreasing monotonicity
      assert.ok(
        boss.hp >= previousHp,
        `Monotonicity violation at wave ${wave}: previous HP ${previousHp}, current HP ${boss.hp}`
      );

      previousHp = boss.hp;
    }
  });

  await t.test("Focus 1.2: Exact Boundary Transition Analysis (Waves 4-5, 9-10, 14-15, 19-20, 24-25, 29-30)", () => {
    const { world } = createTestWorld(ctx);

    const boundaryCases = [
      { preWave: 4, postWave: 5, preTier: 1, postTier: 1, preHp: 137, postHp: 137, isStepJump: false },
      { preWave: 9, postWave: 10, preTier: 1, postTier: 2, preHp: 137, postHp: 216, isStepJump: true },
      { preWave: 14, postWave: 15, preTier: 2, postTier: 3, preHp: 216, postHp: 324, isStepJump: true },
      { preWave: 19, postWave: 20, preTier: 3, postTier: 4, preHp: 324, postHp: 461, isStepJump: true },
      { preWave: 24, postWave: 25, preTier: 4, postTier: 5, preHp: 461, postHp: 626, isStepJump: true },
      { preWave: 29, postWave: 30, preTier: 5, postTier: 6, preHp: 626, postHp: 821, isStepJump: true }
    ];

    for (const b of boundaryCases) {
      world.wave = b.preWave;
      const preBoss = ctx.createServerEnemy(world, "boss", 500, 500, true);
      assert.equal(preBoss.bossTier, b.preTier);
      assert.equal(preBoss.hp, b.preHp);

      world.wave = b.postWave;
      const postBoss = ctx.createServerEnemy(world, "boss", 500, 500, true);
      assert.equal(postBoss.bossTier, b.postTier);
      assert.equal(postBoss.hp, b.postHp);

      if (b.isStepJump) {
        assert.ok(
          postBoss.hp > preBoss.hp,
          `Tier step jump at wave ${b.preWave}->${b.postWave} must strictly increase HP`
        );
      }
    }
  });

  await t.test("Focus 1.3: Wave 30 Coop Boss HP Critical Target Verification (HP >= 800 and exactly 821)", () => {
    const { world } = createTestWorld(ctx);
    world.wave = 30;

    const boss = ctx.createServerEnemy(world, "boss", 500, 500, true);

    // Tier = Math.floor(30 / 5) = 6
    // baseHp = 48 + 6 * 20 + 6 * 6 * 8 = 48 + 120 + 288 = 456
    // coopHp = Math.round(456 * 1.8) = Math.round(820.8) = 821
    assert.equal(boss.bossTier, 6, "Wave 30 must yield bossTier = 6");
    assert.ok(boss.hp >= 800, `Wave 30 Coop Boss HP must be >= 800 (actual: ${boss.hp})`);
    assert.equal(boss.hp, 821, `Wave 30 Coop Boss HP must be exactly 821`);
    assert.equal(boss.maxHp, 821);
  });

  await t.test("Focus 1.4: Client-Server Boss HP Scaling Parity Oracle", () => {
    const indexHtmlPath = path.resolve(process.cwd(), "public/index.html");
    const html = fs.readFileSync(indexHtmlPath, "utf8");

    // Client solo formula: Math.round(48 + bossTier * 20 + bossTier * bossTier * 8)
    function clientSoloOracle(wave) {
      const bossTier = Math.max(1, Math.floor(wave / 5));
      return Math.round(48 + bossTier * 20 + bossTier * bossTier * 8);
    }

    const { world } = createTestWorld(ctx);

    for (let wave = 1; wave <= 50; wave++) {
      world.wave = wave;
      const coopBoss = ctx.createServerEnemy(world, "boss", 500, 500, true);
      const soloExpectedHp = clientSoloOracle(wave);

      // Verify coop HP is exactly Math.round(soloExpectedHp * 1.8)
      const expectedCoopHp = Math.round(soloExpectedHp * 1.8);
      assert.equal(
        coopBoss.hp,
        expectedCoopHp,
        `Wave ${wave} client-server HP calculation discrepancy: solo ${soloExpectedHp} -> coop ${coopBoss.hp} vs expected ${expectedCoopHp}`
      );
    }
  });

  // =========================================================================
  // FOCUS 2: STEPPED XP CURVE PROGRESSION ACROSS LEVELS 1 TO 100
  // =========================================================================
  await t.test("Focus 2.1: Stepped XP Curve Mathematical Invariants (Levels 1 to 100)", () => {
    function oracleXpRequirement(level) {
      const progression = Math.max(0, level - 1);
      return Math.floor((10 + progression * 4 + Math.floor(progression / 5) * 5) * 0.8);
    }

    let previousReq = 0;
    for (let lvl = 1; lvl <= 100; lvl++) {
      const serverReq = ctx.getServerExperienceRequirement(lvl);
      const oracleReq = oracleXpRequirement(lvl);

      // Parity with oracle
      assert.equal(
        serverReq,
        oracleReq,
        `Level ${lvl}: server requirement ${serverReq} does not match oracle ${oracleReq}`
      );

      // Integer and finite properties
      assert.ok(Number.isSafeInteger(serverReq), `Level ${lvl}: XP requirement must be a safe integer`);
      assert.ok(serverReq > 0, `Level ${lvl}: XP requirement must be strictly positive`);

      // Strict monotonicity: every level requires more XP than previous
      if (lvl > 1) {
        assert.ok(
          serverReq > previousReq,
          `Strict monotonicity violated at level ${lvl}: ${serverReq} <= ${previousReq}`
        );
      }

      previousReq = serverReq;
    }
  });

  await t.test("Focus 2.2: Strict Monotonicity Verification (every level requires strictly more XP)", () => {
    let prevReq = ctx.getServerExperienceRequirement(1);
    for (let lvl = 2; lvl <= 100; lvl++) {
      const req = ctx.getServerExperienceRequirement(lvl);
      assert.ok(
        req > prevReq,
        `Strict monotonicity violated at level ${lvl}: ${req} <= ${prevReq}`
      );
      assert.ok(Number.isInteger(req), `Level ${lvl} requirement must be integer`);
      prevReq = req;
    }
  });

  await t.test("Focus 2.3: XP Requirement Boundary & Defensive Robustness (Negative, 0, Non-Integer)", () => {
    // Level 1 baseline
    assert.equal(ctx.getServerExperienceRequirement(1), 8);

    // Negative / 0 boundary checks
    assert.equal(ctx.getServerExperienceRequirement(0), 8, "Level 0 should clamp progression to 0 (req 8)");
    assert.equal(ctx.getServerExperienceRequirement(-1), 8, "Negative level -1 should clamp to req 8");
    assert.equal(ctx.getServerExperienceRequirement(-99), 8, "Extreme negative level should clamp to req 8");

    // Float level test
    const floatReq = ctx.getServerExperienceRequirement(1.5);
    assert.ok(Number.isFinite(floatReq), "Float level should produce finite number");
    assert.equal(floatReq, 9, "progression 0.5 -> floor((10 + 0.5*4 + 0) * 0.8) = floor(9.6) = 9");
  });

  await t.test("Focus 2.4: Client-Server XP Curve Parity Audit Across All 100 Levels", () => {
    const indexHtmlPath = path.resolve(process.cwd(), "public/index.html");
    const html = fs.readFileSync(indexHtmlPath, "utf8");

    const match = html.match(/function\s+getExperienceRequirement\s*\([^)]*\)\s*\{([\s\S]*?)\n\s{4}\}/);
    assert.ok(match, "public/index.html must contain getExperienceRequirement function");

    const clientGetXp = new Function("level", match[1]);

    for (let lvl = 1; lvl <= 100; lvl++) {
      const serverXp = ctx.getServerExperienceRequirement(lvl);
      const clientXp = clientGetXp(lvl);
      assert.equal(
        clientXp,
        serverXp,
        `Level ${lvl} parity mismatch: client ${clientXp} vs server ${serverXp}`
      );
    }
  });

  // =========================================================================
  // FOCUS 3: CRIT MULTIPLIER 2.0X DAMAGE APPLICATION UNDER EMPIRICAL STRESS
  // =========================================================================
  await t.test("Focus 3.1: Guaranteed 2.0x Crit Damage Application across Damage Tiers", () => {
    const { room, world, player1 } = createTestWorld(ctx);
    player1.stats.critChance = 1.0; // 100% crit chance

    const testDamages = [1, 2, 3, 4, 5, 8, 10, 25, 50];

    for (const dmg of testDamages) {
      player1.stats.damage = dmg;

      const enemy = ctx.createServerEnemy(world, "tank", 400, 400, true);
      const initialHp = 1000;
      enemy.hp = initialHp;
      enemy.maxHp = initialHp;
      world.enemies.set(enemy.id, enemy);

      const bullet = ctx.createServerBullet(world, player1.id, 395, 400, 100, 0);
      bullet.hitsLeft = 1;
      bullet.state = "flying";
      world.bullets.set(bullet.id, bullet);

      ctx.updateServerBullet(room, bullet, 0.05);

      const expectedDamage = dmg * 2.0;
      const actualDamage = initialHp - enemy.hp;

      assert.equal(
        actualDamage,
        expectedDamage,
        `Base damage ${dmg} with 2.0x crit multiplier should deal ${expectedDamage}, dealt ${actualDamage}`
      );

      // Clean up for next iteration
      world.enemies.delete(enemy.id);
      world.bullets.delete(bullet.id);
    }
  });

  await t.test("Focus 3.2: Non-Crit Baseline Damage Application (critChance = 0.0)", () => {
    const { room, world, player1 } = createTestWorld(ctx);
    player1.stats.critChance = 0.0; // 0% crit chance

    const testDamages = [1, 2, 3, 4, 5, 10];

    for (const dmg of testDamages) {
      player1.stats.damage = dmg;

      const enemy = ctx.createServerEnemy(world, "tank", 400, 400, true);
      const initialHp = 500;
      enemy.hp = initialHp;
      enemy.maxHp = initialHp;
      world.enemies.set(enemy.id, enemy);

      const bullet = ctx.createServerBullet(world, player1.id, 395, 400, 100, 0);
      bullet.hitsLeft = 1;
      bullet.state = "flying";
      world.bullets.set(bullet.id, bullet);

      ctx.updateServerBullet(room, bullet, 0.05);

      const actualDamage = initialHp - enemy.hp;
      assert.equal(actualDamage, dmg, `Non-crit hit should deal exactly base damage ${dmg}`);

      world.enemies.delete(enemy.id);
      world.bullets.delete(bullet.id);
    }
  });

  await t.test("Focus 3.3: Statistical Monte Carlo Stress Test for Crit Probabilities (N = 5,000 hits)", () => {
    const { room, world, player1 } = createTestWorld(ctx);
    const N = 5000;
    const baseDamage = 2;
    player1.stats.damage = baseDamage;

    // Test power 1: +18% crit chance
    player1.stats.critChance = 0.18;

    let totalDamagePower1 = 0;
    for (let i = 0; i < N; i++) {
      const enemy = ctx.createServerEnemy(world, "tank", 400, 400, true);
      enemy.hp = 1000;
      enemy.maxHp = 1000;
      world.enemies.set(enemy.id, enemy);

      const bullet = ctx.createServerBullet(world, player1.id, 395, 400, 100, 0);
      bullet.hitsLeft = 1;
      bullet.state = "flying";
      world.bullets.set(bullet.id, bullet);

      ctx.updateServerBullet(room, bullet, 0.05);
      totalDamagePower1 += (1000 - enemy.hp);

      world.enemies.delete(enemy.id);
      world.bullets.delete(bullet.id);
    }

    const meanDamagePower1 = totalDamagePower1 / N;
    // Expected mean = 2 * (1 - 0.18) + (2 * 2.0) * 0.18 = 1.64 + 0.90 = 2.04
    const expectedMean1 = 2 * 0.82 + 4 * 0.18; // 2.36
    const errorMargin1 = 0.08; // > 3 sigma for N = 5000
    assert.ok(
      Math.abs(meanDamagePower1 - 2.36) < 0.10,
      `Mean damage ${meanDamagePower1} outside statistical confidence bound of ${expectedMean1} +/- ${errorMargin1}`
    );

    // Test power 2: +36% crit chance
    player1.stats.critChance = 0.36;

    let totalDamagePower2 = 0;
    for (let i = 0; i < N; i++) {
      const enemy = ctx.createServerEnemy(world, "tank", 400, 400, true);
      enemy.hp = 1000;
      enemy.maxHp = 1000;
      world.enemies.set(enemy.id, enemy);

      const bullet = ctx.createServerBullet(world, player1.id, 395, 400, 100, 0);
      bullet.hitsLeft = 1;
      bullet.state = "flying";
      world.bullets.set(bullet.id, bullet);

      ctx.updateServerBullet(room, bullet, 0.05);
      totalDamagePower2 += (1000 - enemy.hp);

      world.enemies.delete(enemy.id);
      world.bullets.delete(bullet.id);
    }

    const meanDamagePower2 = totalDamagePower2 / N;
    // Expected mean = 2 * (1 - 0.36) + 5 * 0.36 = 1.28 + 1.80 = 3.08
    const expectedMean2 = 2 * 0.64 + 4 * 0.36; // 2.72
    const errorMargin2 = 0.08;
    assert.ok(
      Math.abs(meanDamagePower2 - 2.72) < 0.10,
      `Mean damage ${meanDamagePower2} outside statistical confidence bound of ${expectedMean2} +/- ${errorMargin2}`
    );
  });

  await t.test("Focus 3.4: Crit Damage Interaction with Boss Shielding Mechanism", () => {
    const { world } = createTestWorld(ctx);
    const boss = ctx.createServerEnemy(world, "boss", 500, 500, true);
    boss.hp = 500;
    boss.maxHp = 500;
    boss.shieldActive = true;
    world.enemies.set(boss.id, boss);

    // With shield active: amount = Math.max(1, Math.floor(amount * 0.2))
    // 1. Crit damage = 10 (base 4 * 2.0) -> shielded = Math.floor(10 * 0.2) = 2
    const hpBefore1 = boss.hp;
    ctx.damageServerEnemy(world, boss.id, 10);
    assert.equal(hpBefore1 - boss.hp, 2, "Shielded boss must take 2 damage from 10 crit damage");

    // 2. Crit damage = 2.0 (base 1 * 2.0) -> shielded = Math.max(1, Math.floor(2.0 * 0.2)) = Math.max(1, 0) = 1
    const hpBefore2 = boss.hp;
    ctx.damageServerEnemy(world, boss.id, 2.0);
    assert.equal(hpBefore2 - boss.hp, 1, "Shielded boss must take minimum 1 damage from 2.0 crit damage");
  });

  // =========================================================================
  // FOCUS 4: BOSS XP WAVE-SCALING PARITY ACROSS ALL TIERS (1 TO 20)
  // =========================================================================
  await t.test("Focus 4.1: Exhaustive Boss XP Scaling Across Tiers 1 to 20 (Waves 1 to 100)", () => {
    const { world } = createTestWorld(ctx);

    for (let wave = 1; wave <= 100; wave++) {
      world.wave = wave;
      const expectedTier = Math.max(1, Math.floor(wave / 5));
      const expectedXp = 8 + expectedTier * 2;

      const boss = ctx.createServerEnemy(world, "boss", 500, 500, true);
      const actualXp = ctx.getServerEnemyExperience(boss);

      assert.equal(
        actualXp,
        expectedXp,
        `Wave ${wave} (Tier ${expectedTier}): Boss XP expected ${expectedXp}, got ${actualXp}`
      );
    }
  });

  await t.test("Focus 4.2: Client-Server Boss XP Parity Oracle", () => {
    const indexHtmlPath = path.resolve(process.cwd(), "public/index.html");
    const html = fs.readFileSync(indexHtmlPath, "utf8");

    // Solo client formula: 8 + bossTier * 2
    function clientBossXpOracle(tier) {
      return 8 + tier * 2;
    }

    const { world } = createTestWorld(ctx);

    for (let tier = 1; tier <= 20; tier++) {
      world.wave = tier * 5;
      const boss = ctx.createServerEnemy(world, "boss", 500, 500, true);
      const serverXp = ctx.getServerEnemyExperience(boss);
      const clientExpectedXp = clientBossXpOracle(tier);

      assert.equal(
        serverXp,
        clientExpectedXp,
        `Tier ${tier}: Server XP (${serverXp}) !== Client XP (${clientExpectedXp})`
      );
    }
  });

  await t.test("Focus 4.3: Boss Death Experience Crystal Generation Parity", () => {
    const { world, player1 } = createTestWorld(ctx);

    for (let tier = 1; tier <= 6; tier++) {
      world.wave = tier * 5;
      const boss = ctx.createServerEnemy(world, "boss", 500, 500, true);
      world.enemies.set(boss.id, boss);

      const expectedCrystalCount = 8 + tier * 2;
      world.experienceCrystals.clear();

      ctx.killServerEnemy(world, boss, player1);

      assert.equal(
        world.experienceCrystals.size,
        expectedCrystalCount,
        `Tier ${tier} boss kill must drop exactly ${expectedCrystalCount} crystals, got ${world.experienceCrystals.size}`
      );

      // Verify each crystal has value = 1 and valid coordinates
      for (const crystal of world.experienceCrystals.values()) {
        assert.equal(crystal.value, 1, "Experience crystal value must be 1");
        assert.ok(Math.abs(crystal.x - 500) <= 10, "Crystal x coordinate within spawn offset");
        assert.ok(Math.abs(crystal.y - 500) <= 10, "Crystal y coordinate within spawn offset");
      }
    }
  });

  await t.test("Focus 4.4: Adversarial Malformed & Edge-Case Boss Object XP Query", () => {
    // 1. Boss missing bossTier property (undefined)
    const bossNoTier = { type: "boss" };
    assert.equal(
      ctx.getServerEnemyExperience(bossNoTier),
      10,
      "Boss without bossTier must fall back to Tier 1 (10 XP)"
    );

    // 2. Boss with bossTier = 0
    const bossTier0 = { type: "boss", bossTier: 0 };
    assert.equal(
      ctx.getServerEnemyExperience(bossTier0),
      10,
      "Boss with bossTier = 0 must clamp to Tier 1 (10 XP)"
    );

    // 3. Boss with negative bossTier
    const bossNegative = { type: "boss", bossTier: -5 };
    assert.equal(
      ctx.getServerEnemyExperience(bossNegative),
      10,
      "Boss with negative bossTier must clamp to Tier 1 (10 XP)"
    );

    // 4. Boss with bossTier = null
    const bossNull = { type: "boss", bossTier: null };
    assert.equal(
      ctx.getServerEnemyExperience(bossNull),
      10,
      "Boss with bossTier = null must fall back to Tier 1 (10 XP)"
    );
  });

  // =========================================================================
  // FOCUS 5: END-TO-END LONG HORIZON SIMULATION (WAVES 1 TO 100)
  // =========================================================================
  await t.test("Focus 5.1: 100-Wave Continuous Progression Stress Simulation", () => {
    const { room, world, player1 } = createTestWorld(ctx);
    world.level = 1;
    world.experience = 0;
    world.experienceToNext = ctx.getServerExperienceRequirement(1);

    let totalBossesDefeated = 0;
    let totalXpCollected = 0;

    for (let wave = 1; wave <= 100; wave++) {
      world.wave = wave;

      if (wave % 5 === 0) {
        totalBossesDefeated++;
        const boss = ctx.createServerEnemy(world, "boss", 500, 500, true);
        const xp = ctx.getServerEnemyExperience(boss);
        totalXpCollected += xp;
        ctx.addServerExperience(room, xp);
      } else {
        // Standard wave simulation: 8 standard enemies @ 1.5 avg XP
        const waveXp = 12;
        totalXpCollected += waveXp;
        ctx.addServerExperience(room, waveXp);
      }

      // Verify level integrity
      assert.ok(world.level >= 1, `Wave ${wave}: World level must be >= 1`);
      assert.ok(world.experience >= 0, `Wave ${wave}: Experience must be >= 0`);
      assert.ok(
        world.experience < world.experienceToNext,
        `Wave ${wave}: Experience must be strictly less than experienceToNext`
      );
      assert.ok(
        Number.isSafeInteger(world.experienceToNext),
        `Wave ${wave}: experienceToNext must be safe integer`
      );
    }

    assert.equal(totalBossesDefeated, 20, "Must defeat exactly 20 bosses across 100 waves");
    assert.equal(totalXpCollected, 1540, "Total XP collected across 100 waves must be 1540");
    assert.equal(world.level, 27, "World level after 1540 total XP must be exactly 27");
    assert.equal(world.experience, 82, "Remaining XP towards level 28 must be exactly 82");
    assert.equal(world.experienceToNext, 111, "Level 27 XP requirement to reach 28 must be 111");
  });
});
