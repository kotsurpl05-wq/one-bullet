const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { loadServerInstance } = require("./helpers/server_loader.js");
const { createTestWorld } = require("./helpers/test_utils.js");

test("R2 Boss Mechanics & Parity Validation Suite", async (t) => {
  const inst = loadServerInstance();
  const { ctx, cleanup } = inst;

  t.after(() => {
    cleanup();
  });

  await t.test("1. Boss scaling formulas across Tiers 1-6 (HP, Room multiplier, Speed, Radius)", () => {
    const { world } = createTestWorld(ctx);

    const expectedTiers = [
      { wave: 5, tier: 1, baseHp: 7600, roomHp: 8360, speed: 38, radius: 46 },
      { wave: 10, tier: 2, baseHp: 12000, roomHp: 13200, speed: 40.86, radius: 46 },
      { wave: 15, tier: 3, baseHp: 18000, roomHp: 19800, speed: 43.72, radius: 46 },
      { wave: 20, tier: 4, baseHp: 25600, roomHp: 28160, speed: 46.58, radius: 46 },
      { wave: 25, tier: 5, baseHp: 34800, roomHp: 38280, speed: 49.44, radius: 46 },
      { wave: 30, tier: 6, baseHp: 45600, roomHp: 50160, speed: 52.3, radius: 46 }
    ];

    for (const exp of expectedTiers) {
      world.wave = exp.wave;
      const boss = ctx.createServerEnemy(world, "boss", 500, 500, true);

      assert.equal(boss.bossTier, exp.tier, `Wave ${exp.wave} should produce tier ${exp.tier}`);
      assert.equal(boss.hp, exp.roomHp, `Tier ${exp.tier} run HP should be ${exp.roomHp} (got ${boss.hp})`);
      assert.equal(boss.maxHp, exp.roomHp);
      assert.equal(boss.r, exp.radius);
      assert.ok(
        Math.abs(boss.speed - exp.speed) < 0.01,
        `Tier ${exp.tier} speed should be ~${exp.speed} (got ${boss.speed})`
      );

      // Verify wave-scaled boss XP
      const xp = ctx.getServerEnemyExperience(boss);
      assert.equal(xp, 1050 + exp.tier * 275, `Tier ${exp.tier} boss XP should be ${1050 + exp.tier * 275} (got ${xp})`);
    }
  });

  await t.test("2. Dash & Shockwave Burst mechanics (telegraph -> dashing -> shockwave burst)", () => {
    const { world, player1: player } = createTestWorld(ctx);
    world.wave = 10;
    const boss = ctx.createServerEnemy(world, "boss", 400, 400, true);
    boss.bossTier = 2;
    boss.hasEnteredArena = true;
    boss.phase = 1; // Phase >= 1 enables dash
    boss.dashState = "none";
    boss.dashCooldown = 0; // Trigger immediately
    world.enemies.set(boss.id, boss);

    const initialProjectiles = world.enemyProjectiles.size;

    // Trigger shockwave directly
    ctx.shootServerBossShockwave(world, boss);

    assert.equal(
      world.enemyProjectiles.size,
      initialProjectiles + 8,
      "Shockwave must generate exactly 8 radial projectiles"
    );

    // Verify shockwave projectiles properties
    const shockwaveProjectiles = [...world.enemyProjectiles.values()].slice(-8);
    for (const proj of shockwaveProjectiles) {
      assert.equal(proj.color, "#ff496c");
      // Base damage 100, scaled by getEnemyDamageMultiplier(wave=10) = 1 + 9*0.02 = 1.18 -> 118
      assert.equal(proj.damage, 118);
      assert.equal(proj.r, 5.2);
      const speed = Math.hypot(proj.vx, proj.vy);
      assert.ok(Math.abs(speed - 190) < 1.0, `Expected speed ~190, got ${speed}`);
    }
  });

  await t.test("3. Shield & Orbiting Drones mechanics (50% HP threshold & damage reduction)", () => {
    const { world, player1: player } = createTestWorld(ctx);
    world.wave = 10;
    const boss = ctx.createServerEnemy(world, "boss", 500, 500, true);
    boss.bossTier = 2;
    boss.hasEnteredArena = true;
    world.enemies.set(boss.id, boss);

    assert.equal(boss.shieldActive, false);
    assert.equal(boss.shieldTriggered, false);

    // Trigger drone spawn
    ctx.spawnServerBossDrones(world, boss);

    assert.equal(boss.shieldActive, true, "Boss shield should become active");
    assert.equal(boss.shieldTriggered, true, "Boss shieldTriggered flag should be true");

    // Verify 4 corner shield pylons spawned
    const drones = [...world.enemies.values()].filter(e => (e.type === "boss_drone" || e.type === "boss_pylon") && e.bossId === boss.id);
    assert.equal(drones.length, 4, "Exactly 4 corner shield pylons should spawn");

    for (const drone of drones) {
      assert.equal(drone.hp, 1750);
      assert.equal(drone.maxHp, 1750);
      assert.equal(drone.hasEnteredArena, true);
    }

    // Verify 90% damage reduction on shielded boss: only 10% gets through.
    const hpBefore = boss.hp;
    ctx.damageServerEnemy(world, boss.id, 100, player);
    const damageTaken = hpBefore - boss.hp;
    assert.equal(damageTaken, 10, "Shielded boss must take only 10% damage (10 instead of 100)");

    // A lethal hit through the shield removes every encounter-owned pylon
    // immediately, without waiting for another AI update.
    boss.hp = 5;
    ctx.damageServerEnemy(world, boss.id, 100, player);
    assert.equal(world.enemies.has(boss.id), false, "Boss must be removed after lethal shielded damage");
    assert.equal(
      [...world.enemies.values()].filter(e =>
        (e.type === "boss_drone" || e.type === "boss_pylon") && e.bossId === boss.id
      ).length,
      0,
      "All pylons must self-destruct with their boss"
    );
  });

  await t.test("3.1 Boss Shield Pylon HP Scaling across tiers (wave 10, 20, 30, 50) for Room and Solo", () => {
    const expectedTiers = [
      { wave: 10, tier: 2, roomHp: 1750, soloHp: 875 },
      { wave: 15, tier: 3, roomHp: 2625, soloHp: 1313 },
      { wave: 20, tier: 4, roomHp: 3733, soloHp: 1867 },
      { wave: 30, tier: 6, roomHp: 6650, soloHp: 3325 },
      { wave: 40, tier: 8, roomHp: 10500, soloHp: 5250 },
      { wave: 50, tier: 10, roomHp: 15283, soloHp: 7642 },
    ];

    for (const exp of expectedTiers) {
      const base = ctx.createEnemyBase("boss_drone", exp.wave);
      assert.equal(base.hp, exp.roomHp, `Wave ${exp.wave} (Tier ${exp.tier}) base pylon HP should be ${exp.roomHp}`);

      // Verify spawnServerBossDrones adheres to the wave/tier scaling
      const { world } = createTestWorld(ctx);
      world.wave = exp.wave;
      const boss = ctx.createServerEnemy(world, "boss", 500, 500, true);
      boss.bossTier = exp.tier;
      world.enemies.set(boss.id, boss);

      ctx.spawnServerBossDrones(world, boss);
      const drones = [...world.enemies.values()].filter(e => (e.type === "boss_drone" || e.type === "boss_pylon") && e.bossId === boss.id);
      assert.equal(drones.length, 4);
      for (const drone of drones) {
        assert.equal(drone.hp, exp.roomHp, `Room pylon HP on wave ${exp.wave} should be ${exp.roomHp}`);
        assert.equal(drone.maxHp, exp.roomHp);
      }

      // Solo HP calculation: Math.max(1, Math.round(base.hp * 0.5))
      const computedSoloHp = Math.max(1, Math.round(base.hp * 0.5));
      assert.equal(computedSoloHp, exp.soloHp, `Solo pylon HP on wave ${exp.wave} should be ${exp.soloHp}`);
    }
  });

  await t.test("3.2 Menu preview consumes the shared one-player room profile", () => {
    const clientHtml = fs.readFileSync(
      path.resolve(__dirname, "../public/index.html"),
      "utf8"
    );

    assert.match(
      clientHtml,
      /const PREVIEW_ROOM_BALANCE = GameShared\.getRoomBalance\(1\);/,
      "The non-interactive menu preview must consume the shared one-player profile"
    );
    assert.match(
      clientHtml,
      /GameShared\.scaleEnemyHp\(base\.hp, type, 1\)/,
      "Enemy HP must use shared room-balance math"
    );
    assert.match(
      clientHtml,
      /GameShared\.scaleExperience\([\s\S]{0,80}getEnemyExperienceAmount\(enemy\),[\s\S]{0,30}1[\s\S]{0,10}\)/,
      "Enemy crystal drops must use shared room-balance math"
    );
    assert.match(
      clientHtml,
      /isBossLike\(enemy\) && enemy\.shieldActive[\s\S]{0,120}damage = Math\.max\(1, Math\.floor\(damage \* 0\.1\)\)/,
      "Menu preview shield must reduce incoming boss damage by 90%"
    );
    assert.match(
      clientHtml,
      /if \(isBossOrMini\) \{\s*destroyPreviewBossPylons\(enemy\);\s*\}/,
      "Menu preview boss death must immediately destroy its remaining pylons"
    );

    const damageStart = clientHtml.indexOf("function damageEnemy");
    const damageEnd = clientHtml.indexOf("function registerRepairKill", damageStart);
    const damageSource = clientHtml.slice(damageStart, damageEnd);
    const previewBoss = {
      id: 100,
      type: "boss",
      hp: 1000,
      maxHp: 1000,
      shieldActive: true,
      turretMode: false,
      x: 100,
      y: 100,
      color: "#fff"
    };
    const damageContext = vm.createContext({
      enemies: [previewBoss],
      stats: {},
      isBossLike: enemy => enemy.type === "boss" || enemy.type === "mini_boss",
      createParticles() {},
      createRing() {},
      addDamageNumber() {},
      killEnemy() {},
      soundManager: { playHit() {}, playCritHit() {} },
      totalDamageDealt: 0,
      Math,
      Number
    });
    vm.runInContext(`${damageSource}; this.damageEnemy = damageEnemy;`, damageContext);
    damageContext.damageEnemy(previewBoss, 100);
    assert.equal(previewBoss.hp, 990, "Real preview damage path must let only 10% through the shield");

    const destroyStart = clientHtml.indexOf("function destroyPreviewBossPylons");
    const destroyEnd = clientHtml.indexOf("function damageEnemy", destroyStart);
    const destroySource = clientHtml.slice(destroyStart, destroyEnd);
    const pylonA = { id: 101, type: "boss_drone", bossId: previewBoss.id, x: 1, y: 1 };
    const pylonB = { id: 102, type: "boss_pylon", bossId: previewBoss.id, x: 2, y: 2 };
    const unrelated = { id: 103, type: "boss_drone", bossId: 999, x: 3, y: 3 };
    const destroyContext = vm.createContext({
      enemies: [previewBoss, pylonA, unrelated, pylonB],
      createParticles() {},
      createRing() {},
      screenShake: 0,
      Math
    });
    vm.runInContext(`${destroySource}; this.destroyPreviewBossPylons = destroyPreviewBossPylons;`, destroyContext);
    assert.equal(destroyContext.destroyPreviewBossPylons(previewBoss), 2);
    assert.deepEqual(
      destroyContext.enemies.map(enemy => enemy.id),
      [previewBoss.id, unrelated.id],
      "Solo cleanup must remove only pylons owned by the dead boss"
    );

    const waveFiveBoss = ctx.createEnemyBase("boss", 5);
    assert.equal(Math.round(waveFiveBoss.hp * 0.5), 3800);
  });

  await t.test("4. Telegraphed Piercing Sniper Bolt mechanics (high speed, 2 damage)", () => {
    const { world } = createTestWorld(ctx);
    world.wave = 10;
    const boss = ctx.createServerEnemy(world, "boss", 300, 300, true);
    boss.bossTier = 2;
    world.enemies.set(boss.id, boss);

    const initialProjCount = world.enemyProjectiles.size;
    const targetX = 600;
    const targetY = 300;

    ctx.shootServerBossSniperBolt(world, boss, targetX, targetY);

    assert.equal(world.enemyProjectiles.size, initialProjCount + 1);
    const sniperBolt = [...world.enemyProjectiles.values()].pop();

    assert.equal(sniperBolt.damage, 236, "Sniper bolt base damage 200 scaled by wave-10 multiplier (1.18) = 236");
    assert.equal(sniperBolt.color, "#ff1744");
    assert.equal(sniperBolt.r, 7.2);
    const speed = Math.hypot(sniperBolt.vx, sniperBolt.vy);
    assert.ok(Math.abs(speed - 900) < 1.0, `Sniper bolt speed should be 900, got ${speed}`);
    assert.ok(sniperBolt.vx > 0, "Sniper bolt should travel toward target (positive vx)");
  });

  await t.test("5. Spiral Bullet Hell mechanics (Phase 2 <33% HP)", () => {
    const { world } = createTestWorld(ctx);
    world.wave = 15;
    const boss = ctx.createServerEnemy(world, "boss", 500, 500, true);
    boss.bossTier = 3;
    boss.maxHp = 220;
    boss.hp = 50; // HP ratio = 50 / 220 = 0.227 < 0.33 -> Phase 2
    boss.hasEnteredArena = true;

    const hpRatio = boss.hp / boss.maxHp;
    const phase = hpRatio < 0.33 ? 2 : hpRatio < 0.66 ? 1 : 0;
    assert.equal(phase, 2, "Boss at 22.7% HP must be in Phase 2 (Rage phase)");

    // Radial attack in Phase 2 produces 8 + 2*2 + min(2*2, 6) = 8 + 4 + 4 = 16 projectiles
    const initialCount = world.enemyProjectiles.size;
    ctx.shootServerBossRadial(world, boss, phase);
    const radialCount = world.enemyProjectiles.size - initialCount;
    assert.equal(radialCount, 16, `Phase 2 Tier 3 radial burst should have 16 projectiles, got ${radialCount}`);
  });

  await t.test("6. Parity Audit: detect missing solo mode boss functions in public/index.html", () => {
    const indexHtmlPath = path.resolve(process.cwd(), "public/index.html");
    const html = fs.readFileSync(indexHtmlPath, "utf8");

    // Verify calls exist in index.html
    assert.ok(html.includes("spawnBossDrones(enemy)"), "index.html calls spawnBossDrones");
    assert.ok(html.includes("shootBossShockwave(enemy)"), "index.html calls shootBossShockwave");
    assert.ok(html.includes("shootBossSniperBolt(enemy"), "index.html calls shootBossSniperBolt");

    // Verify definitions are present in index.html
    const hasSpawnBossDronesDef = /function\s+spawnBossDrones\s*\(/.test(html);
    const hasShootBossShockwaveDef = /function\s+shootBossShockwave\s*\(/.test(html);
    const hasShootBossSniperBoltDef = /function\s+shootBossSniperBolt\s*\(/.test(html);

    assert.equal(hasSpawnBossDronesDef, true, "Solo mode has spawnBossDrones definition");
    assert.equal(hasShootBossShockwaveDef, true, "Solo mode has shootBossShockwave definition");
    assert.equal(hasShootBossSniperBoltDef, true, "Solo mode has shootBossSniperBolt definition");
  });

  await t.test("7. Reroll Rules: Grant every 2 levels and on Boss kill", () => {
    const { room, world, player1: player } = createTestWorld(ctx);
    player.rerolls = 1;

    // Level 1 -> 2 (Even level: +1 reroll)
    world.experience = 0;
    world.experienceToNext = 10;
    ctx.addServerExperience(room, 10);
    assert.equal(world.level, 2);
    assert.equal(player.rerolls, 2, "Level 2 (even) must grant +1 reroll (total: 2)");

    // Level 2 -> 3 (Odd level: 0 reroll)
    world.experienceToNext = 10;
    ctx.addServerExperience(room, 10);
    assert.equal(world.level, 3);
    assert.equal(player.rerolls, 2, "Level 3 (odd) must NOT grant reroll (total remains: 2)");

    // Level 3 -> 4 (Even level: +1 reroll)
    world.experienceToNext = 10;
    ctx.addServerExperience(room, 10);
    assert.equal(world.level, 4);
    assert.equal(player.rerolls, 3, "Level 4 (even) must grant +1 reroll (total: 3)");

    // Killing a normal enemy does NOT grant rerolls
    const normalEnemy = ctx.createServerEnemy(world, "runner", 100, 100);
    world.enemies.set(normalEnemy.id, normalEnemy);
    ctx.killServerEnemy(world, normalEnemy, player);
    assert.equal(player.rerolls, 3, "Normal kill must NOT grant rerolls");

    // Killing a BOSS grants +1 reroll
    const bossEnemy = ctx.createServerEnemy(world, "boss", 200, 200);
    world.enemies.set(bossEnemy.id, bossEnemy);
    ctx.killServerEnemy(world, bossEnemy, player);
    assert.equal(player.rerolls, 4, "Boss kill must grant +1 reroll (total: 4)");
  });
});
