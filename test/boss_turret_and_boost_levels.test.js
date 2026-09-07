const test = require("node:test");
const assert = require("node:assert/strict");
const { loadServerInstance } = require("./helpers/server_loader.js");
const { createTestWorld } = require("./helpers/test_utils.js");
const { getUpgradeProgress, findUpgradeDef } = require("../shared/upgrades.js");

test("Boss Turret Mode, Boost Level Rarity & Indicator Suite", async (t) => {
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
  // 1. BOSS TURRET MODE PHASE GATE
  // =========================================================================
  await t.test("1.1 Boss cannot enter turret mode during Phase 0 (HP > 66%)", () => {
    const { world } = createTestWorld(ctx);
    world.wave = 10;
    const boss = ctx.createServerEnemy(world, "boss", 500, 500, true);
    boss.maxHp = 1000;
    boss.hp = 800; // 80% HP -> phase 0
    boss.hasEnteredArena = true;
    boss.turretMode = false;
    boss.turretCooldown = 0;
    world.enemies.set(boss.id, boss);

    ctx.updateServerEnemies(world, 0.1);
    assert.equal(boss.turretMode, false, "Boss must not enter turret mode in Phase 0 (HP > 66%)");
  });

  await t.test("1.2 Boss CAN enter turret mode starting from Phase 1 (HP <= 66%)", () => {
    const { world } = createTestWorld(ctx);
    world.wave = 10;
    const boss = ctx.createServerEnemy(world, "boss", 500, 500, true);
    boss.maxHp = 1000;
    boss.hp = 600; // 60% HP -> phase 1
    boss.hasEnteredArena = true;
    boss.turretMode = false;
    boss.turretCooldown = 0;
    world.enemies.set(boss.id, boss);

    ctx.updateServerEnemies(world, 0.1);
    assert.equal(boss.turretMode, true, "Boss should enter turret mode in Phase 1 (HP <= 66%)");
    assert.equal(boss.turretZoneCooldown, 0, "Entering turret mode should reset turretZoneCooldown to 0");
  });

  await t.test("1.3 Boss CAN enter turret mode in Phase 2 (HP <= 33%)", () => {
    const { world } = createTestWorld(ctx);
    world.wave = 10;
    const boss = ctx.createServerEnemy(world, "boss", 500, 500, true);
    boss.maxHp = 1000;
    boss.hp = 250; // 25% HP -> phase 2
    boss.hasEnteredArena = true;
    boss.turretMode = false;
    boss.turretCooldown = 0;
    boss.shieldTriggered = true;
    boss.shieldActive = false;
    world.enemies.set(boss.id, boss);

    ctx.updateServerEnemies(world, 0.1);
    assert.equal(boss.turretMode, true, "Boss should enter turret mode in Phase 2");
  });

  // =========================================================================
  // 2. BOSS TURRET MODE ZONE PATTERN & INTENSITY REDUCTION (~30%)
  // =========================================================================
  await t.test("2.1 Turret mode zone count is reduced by ~30% across patterns", () => {
    const patterns = ["cluster", "line", "circle", "cross", "grid", "chase"];

    let totalNormalZones = 0;
    let totalTurretZones = 0;

    for (let i = 0; i < patterns.length; i++) {
      const pat = patterns[i];

      const { world: worldNormal, player1: p1Normal } = createTestWorld(ctx);
      const bossNormal = ctx.createServerEnemy(worldNormal, "boss", 500, 500, true);
      bossNormal.turretMode = false;
      bossNormal.serverZonePatternIdx = i;
      ctx.spawnServerZonePattern(worldNormal, bossNormal, p1Normal);
      const normalCount = worldNormal.damageZones.size;
      totalNormalZones += normalCount;

      const { world: worldTurret, player1: p1Turret } = createTestWorld(ctx);
      const bossTurret = ctx.createServerEnemy(worldTurret, "boss", 500, 500, true);
      bossTurret.turretMode = true;
      bossTurret.serverZonePatternIdx = i;
      ctx.spawnServerZonePattern(worldTurret, bossTurret, p1Turret);
      const turretCount = worldTurret.damageZones.size;
      totalTurretZones += turretCount;

      assert.ok(
        turretCount <= normalCount,
        `Pattern ${pat}: turret count (${turretCount}) should be <= normal count (${normalCount})`
      );
    }

    // Normal: 5 + 5 + 6 + 5 + 9 + 5 = 35 zones
    // Turret: 4 + 3 + 4 + 4 + 6 + 4 = 25 zones
    assert.equal(totalNormalZones, 35, "Base total zones across 6 patterns should be 35");
    assert.equal(totalTurretZones, 25, "Turret total zones across 6 patterns should be 25");
    const reductionPercent = ((totalNormalZones - totalTurretZones) / totalNormalZones) * 100;
    assert.ok(
      reductionPercent >= 28 && reductionPercent <= 32,
      `Zone reduction should be ~30% (actual: ${reductionPercent.toFixed(1)}%)`
    );
  });

  await t.test("2.2 Turret zone attack cooldown uses 3.9s interval (30% less frequent than 2.75s)", () => {
    const { world, player1 } = createTestWorld(ctx);
    const boss = ctx.createServerEnemy(world, "boss", 500, 500, true);
    boss.turretMode = true;
    boss.turretZoneCooldown = 0;
    boss.turretBlasterCooldown = 0;
    boss.turretBlasterState = "idle";

    // Call updateServerBossTurretAttacks(world, boss, target, dt)
    ctx.updateServerBossTurretAttacks(world, boss, player1, 0.1);
    // After blaster trigger, turretZoneCooldown should be set to 3.9
    assert.equal(boss.turretZoneCooldown, 3.9, "turretZoneCooldown should be initialized to 3.9s");
  });

  // =========================================================================
  // 3. UPGRADE QUALITY ROLL RESTRICTION BASED ON LEVEL
  // =========================================================================
  await t.test("3.1 When 1 upgrade is left to cap, only common rarity can be rolled", () => {
    const { player1 } = createTestWorld(ctx);
    // critical max is 6. Set current to 5 (remaining = 1)
    player1.stats.critChance = 0.5; // 5 steps of 0.1

    const critUpgrade = ctx.SERVER_UPGRADES.find(u => u.id === "critical");
    assert.ok(critUpgrade);

    const progress = getUpgradeProgress(player1, "critical");
    assert.equal(progress.current, 5);
    assert.equal(progress.max, 6);

    // Force random to 0.001 (which would normally roll legendary)
    const origRandom = ctx.Math.random;
    ctx.Math.random = () => 0.001;
    try {
      const rolledRarity = ctx.rollServerUpgradeRarity(critUpgrade, player1);
      assert.equal(
        rolledRarity.key,
        "common",
        "With 1 upgrade left to cap, rollServerUpgradeRarity must return common"
      );
    } finally {
      ctx.Math.random = origRandom;
    }
  });

  await t.test("3.2 When 2 upgrades are left to cap, rare is the maximum allowed rarity (no legendary)", () => {
    const { player1 } = createTestWorld(ctx);
    // critical max is 6. Set current to 4 (remaining = 2)
    player1.stats.critChance = 0.4;

    const critUpgrade = ctx.SERVER_UPGRADES.find(u => u.id === "critical");
    const progress = getUpgradeProgress(player1, "critical");
    assert.equal(progress.current, 4);
    assert.equal(progress.max, 6);

    const origRandom = ctx.Math.random;
    ctx.Math.random = () => 0.001; // normally legendary, but capped at rare
    try {
      const rolledRarity = ctx.rollServerUpgradeRarity(critUpgrade, player1);
      assert.equal(
        rolledRarity.key,
        "rare",
        "With 2 upgrades left to cap, legendary roll must be downgraded to rare"
      );
    } finally {
      ctx.Math.random = origRandom;
    }
  });

  await t.test("3.3 Inherently legendary upgrades (fixedRarity: 'legendary') remain legendary even near cap", () => {
    const { player1 } = createTestWorld(ctx);
    // homing is fixedRarity: "legendary", max 3. Set current to 2 (remaining = 1)
    player1.stats.homing = 2;

    const homingUpgrade = ctx.SERVER_UPGRADES.find(u => u.id === "homing");
    assert.ok(homingUpgrade);
    assert.equal(homingUpgrade.fixedRarity, "legendary");

    const progress = getUpgradeProgress(player1, "homing");
    assert.equal(progress.current, 2);
    assert.equal(progress.max, 3);

    const rolledRarity = ctx.rollServerUpgradeRarity(homingUpgrade, player1);
    assert.equal(
      rolledRarity.key,
      "legendary",
      "Fixed legendary upgrade must retain legendary rarity even with 1 upgrade remaining"
    );
  });

  // =========================================================================
  // 4. LEVEL PROGRESS INDICATOR x/z
  // =========================================================================
  await t.test("4.1 getUpgradeProgress correctly computes current and max levels", () => {
    const { player1 } = createTestWorld(ctx);

    // Boomerang (boolean)
    assert.deepEqual(getUpgradeProgress(player1, "boomerang"), { current: 0, max: 1 });
    player1.stats.boomerang = true;
    assert.deepEqual(getUpgradeProgress(player1, "boomerang"), { current: 1, max: 1 });

    // Second bullet (magazineSize: max 1 upgrade, base 1 -> magazineSize 2)
    player1.stats.magazineSize = 1;
    assert.deepEqual(getUpgradeProgress(player1, "second-bullet"), { current: 0, max: 1 });
    player1.stats.magazineSize = 2;
    assert.deepEqual(getUpgradeProgress(player1, "second-bullet"), { current: 1, max: 1 });

    // Caliber (bulletRadius: base 7, max 5 levels)
    player1.stats.bulletRadius = 7;
    assert.deepEqual(getUpgradeProgress(player1, "caliber"), { current: 0, max: 5 });
    player1.stats.bulletRadius = 13;
    assert.deepEqual(getUpgradeProgress(player1, "caliber"), { current: 2, max: 5 });

    // Damage (uncapped: max Infinity, base 100, step 100)
    player1.stats.damage = 100;
    assert.deepEqual(getUpgradeProgress(player1, "damage"), { current: 0, max: Infinity });
    player1.stats.damage = 200;
    assert.deepEqual(getUpgradeProgress(player1, "damage"), { current: 1, max: Infinity });
  });

  await t.test("4.2 createServerUpgradeOffers attaches levelText, currentLevel, and maxLevel", () => {
    const { player1 } = createTestWorld(ctx);
    player1.stats.critChance = 0.2; // 2 steps

    const offers = ctx.createServerUpgradeOffers(player1);
    assert.equal(offers.length, 3);

    for (const offer of offers) {
      assert.ok(typeof offer.levelText === "string", "offer must have levelText");
      assert.ok(typeof offer.currentLevel === "number", "offer must have currentLevel");
      assert.ok(
        typeof offer.maxLevel === "number" || offer.maxLevel === "∞",
        "offer must have maxLevel (number or '∞')"
      );
      assert.match(
        offer.levelText,
        /^\d+\/(\d+|∞)$/,
        `levelText '${offer.levelText}' must match format x/z or x/∞`
      );
    }
  });

  // =========================================================================
  // 5. MAGNET SPEED BUFF (115 px/s)
  // =========================================================================
  await t.test("5.1 Boomerang sets groundPullSpeed to 115 px/s and describes 115 px/s", () => {
    const { world, player1 } = createTestWorld(ctx);
    player1.stats.groundPullSpeed = 0;

    const boomerangDef = findUpgradeDef("boomerang");
    assert.ok(boomerangDef);

    ctx.applyServerUpgrade(world, player1, { upgradeId: "boomerang", power: 1 });
    assert.equal(player1.stats.groundPullSpeed, 115, "Boomerang must set groundPullSpeed to 115");

    const bonusText = boomerangDef.bonus(player1, 1);
    assert.ok(bonusText.includes("115"), `Bonus text should mention 115 px/s: ${bonusText}`);
  });

  // =========================================================================
  // 6. PHASE 3 BOSS INTENSITY REDUCTION (~30%)
  // =========================================================================
  await t.test("6.1 Phase 3 (phase === 2) spawns reduced zone counts (~30% less zones)", () => {
    const patterns = ["cluster", "line", "circle", "cross", "grid", "chase"];

    let totalPhase3Zones = 0;
    for (let i = 0; i < patterns.length; i++) {
      const { world, player1 } = createTestWorld(ctx);
      const boss = ctx.createServerEnemy(world, "boss", 500, 500, true);
      boss.turretMode = false;
      boss.phase = 2;
      boss.serverZonePatternIdx = i;
      ctx.spawnServerZonePattern(world, boss, player1);
      totalPhase3Zones += world.damageZones.size;
    }

    assert.equal(totalPhase3Zones, 25, "Phase 3 total zones across 6 patterns should be 25 (30% reduction from 35)");
  });

  await t.test("6.2 Phase 3 boss attack cooldowns are 30% less intense", () => {
    const { world, player1 } = createTestWorld(ctx);
    world.wave = 10;
    const boss = ctx.createServerEnemy(world, "boss", 500, 500, true);
    boss.maxHp = 1000;
    boss.hp = 250; // 25% -> phase 2
    boss.phase = 2;
    boss.hasEnteredArena = true;
    boss.shieldTriggered = true;
    boss.shieldActive = false;
    boss.turretMode = false;
    boss.turretCooldown = 999;
    boss.shootCooldown = 0;
    boss.radialCooldown = 0;
    boss.normalBlasterCooldown = 0;
    boss.normalZoneCooldown = 0;
    world.enemies.set(boss.id, boss);

    ctx.updateServerEnemies(world, 0.05);

    assert.equal(boss.shootCooldown, 1.35, "Phase 3 shootCooldown should reset to 1.35s (~30% longer than 1.03s)");
    assert.equal(boss.radialCooldown, 3.9, "Phase 3 radialCooldown should reset to 3.9s (~30% longer than 3.0s)");
    assert.equal(boss.normalBlasterCooldown, 2.85, "Phase 3 normalBlasterCooldown should reset to 2.85s (30% less frequent than 2.0s)");
    assert.equal(boss.normalZoneCooldown, 2.85, "Phase 3 normalZoneCooldown should reset to 2.85s (30% less frequent than 2.0s)");
  });
});

