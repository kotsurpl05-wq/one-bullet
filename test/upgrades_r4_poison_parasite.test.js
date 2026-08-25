const test = require("node:test");
const assert = require("node:assert/strict");
const { loadServerInstance } = require("./helpers/server_loader.js");
const { createTestWorld } = require("./helpers/test_utils.js");

test("R4 Poison Bullet and Parasite Bullet Comprehensive Suite", async (t) => {
  const inst = loadServerInstance();
  const { ctx, cleanup } = inst;

  t.after(() => {
    cleanup();
  });

  // =========================================================================
  // TIER 1: UPGRADE CATALOG & SCHEMA VALIDATION
  // =========================================================================

  await t.test("Tier 1.1: Poison Bullet catalog schema and availability", () => {
    const { player1 } = createTestWorld(ctx);
    assert.equal(player1.stats.poison, false);

    const poisonUpg = ctx.SERVER_UPGRADES.find(u => u.id === "poison");
    assert.ok(poisonUpg, "Poison upgrade must exist in SERVER_UPGRADES");
    assert.equal(poisonUpg.fixedRarity, "rare");
    assert.equal(poisonUpg.available(player1), true);

    const poisonDmgUpg = ctx.SERVER_UPGRADES.find(u => u.id === "poison-damage");
    assert.ok(poisonDmgUpg);
    assert.equal(poisonDmgUpg.available(player1), false, "Poison damage must be locked before poison is acquired");

    const poisonDurUpg = ctx.SERVER_UPGRADES.find(u => u.id === "poison-duration");
    assert.ok(poisonDurUpg);
    assert.equal(poisonDurUpg.available(player1), false, "Poison duration must be locked before poison is acquired");
  });

  await t.test("Tier 1.2: Parasite Bullet catalog schema and availability", () => {
    const { player1 } = createTestWorld(ctx);
    assert.equal(player1.stats.parasite, false);

    const parasiteUpg = ctx.SERVER_UPGRADES.find(u => u.id === "parasite");
    assert.ok(parasiteUpg, "Parasite upgrade must exist in SERVER_UPGRADES");
    assert.equal(parasiteUpg.fixedRarity, "rare");
    assert.equal(parasiteUpg.available(player1), true);

    const parasiteChanceUpg = ctx.SERVER_UPGRADES.find(u => u.id === "parasite-chance");
    assert.ok(parasiteChanceUpg);
    assert.equal(parasiteChanceUpg.available(player1), false, "Parasite chance must be locked before parasite is acquired");

    const parasiteCountUpg = ctx.SERVER_UPGRADES.find(u => u.id === "parasite-count");
    assert.ok(parasiteCountUpg);
    assert.equal(parasiteCountUpg.available(player1), false, "Parasite count must be locked before parasite is acquired");

    const parasiteDmgUpg = ctx.SERVER_UPGRADES.find(u => u.id === "parasite-damage");
    assert.ok(parasiteDmgUpg);
    assert.equal(parasiteDmgUpg.available(player1), false, "Parasite damage must be locked before parasite is acquired");
  });

  // =========================================================================
  // TIER 2: STATE MUTATIONS & UPGRADE SCALING CAPS
  // =========================================================================

  await t.test("Tier 2.1: applyServerUpgrade for Poison and its sub-upgrades with caps", () => {
    const { world, player1 } = createTestWorld(ctx);

    // Apply base poison
    ctx.applyServerUpgrade(world, player1, { id: "poison", power: 1 });
    assert.equal(player1.stats.poison, true);
    assert.equal(player1.stats.poisonDamage, 50);
    assert.equal(player1.stats.poisonDuration, 2.0);

    // Upgrade poison damage with power 3 (+1.5 -> 2.0)
    ctx.applyServerUpgrade(world, player1, { id: "poison-damage", power: 3 });
    assert.equal(player1.stats.poisonDamage, 200);

    // Exceed damage cap (5.0 max)
    ctx.applyServerUpgrade(world, player1, { id: "poison-damage", power: 10 });
    assert.equal(player1.stats.poisonDamage, 500, "Poison damage must clamp at 5.0 max");

    const poisonDmgUpg = ctx.SERVER_UPGRADES.find(u => u.id === "poison-damage");
    assert.equal(poisonDmgUpg.available(player1), false, "Poison damage must become unavailable once capped at 500");

    // Upgrade poison duration with power 2 (+2.0s -> 4.0s)
    ctx.applyServerUpgrade(world, player1, { id: "poison-duration", power: 2 });
    assert.equal(player1.stats.poisonDuration, 4.0);

    // Exceed duration cap (5.0s max)
    ctx.applyServerUpgrade(world, player1, { id: "poison-duration", power: 5 });
    assert.equal(player1.stats.poisonDuration, 5.0, "Poison duration must clamp at 5.0s max");

    const poisonDurUpg = ctx.SERVER_UPGRADES.find(u => u.id === "poison-duration");
    assert.equal(poisonDurUpg.available(player1), false, "Poison duration must become unavailable once capped at 5.0s");
  });

  await t.test("Tier 2.2: applyServerUpgrade for Parasite and its sub-upgrades with caps", () => {
    const { world, player1 } = createTestWorld(ctx);

    // Apply base parasite
    ctx.applyServerUpgrade(world, player1, { id: "parasite", power: 1 });
    assert.equal(player1.stats.parasite, true);
    assert.equal(player1.stats.parasiteChance, 0.25);
    assert.equal(player1.stats.parasiteCount, 1);
    assert.equal(player1.stats.parasiteDamage, 75);

    // Upgrade parasite chance with power 2 (+10% -> 35%)
    ctx.applyServerUpgrade(world, player1, { id: "parasite-chance", power: 2 });
    assert.equal(player1.stats.parasiteChance, 0.35);

    // Exceed chance cap (50% max)
    ctx.applyServerUpgrade(world, player1, { id: "parasite-chance", power: 10 });
    assert.equal(player1.stats.parasiteChance, 0.50, "Parasite chance must clamp at 0.50 (50%)");

    const parasiteChanceUpg = ctx.SERVER_UPGRADES.find(u => u.id === "parasite-chance");
    assert.equal(parasiteChanceUpg.available(player1), false, "Parasite chance must become unavailable once capped at 50%");

    // Upgrade parasite count (+2 -> 3)
    ctx.applyServerUpgrade(world, player1, { id: "parasite-count", power: 2 });
    assert.equal(player1.stats.parasiteCount, 3);

    // Exceed count cap (5 max)
    ctx.applyServerUpgrade(world, player1, { id: "parasite-count", power: 10 });
    assert.equal(player1.stats.parasiteCount, 5, "Parasite count must clamp at 5 max");

    const parasiteCountUpg = ctx.SERVER_UPGRADES.find(u => u.id === "parasite-count");
    assert.equal(parasiteCountUpg.available(player1), false, "Parasite count must become unavailable once capped at 5");

    // Upgrade parasite damage (+1.0 -> 2.0)
    ctx.applyServerUpgrade(world, player1, { id: "parasite-damage", power: 2 });
    assert.equal(player1.stats.parasiteDamage, 175);

    // Exceed damage cap (4.0 max)
    ctx.applyServerUpgrade(world, player1, { id: "parasite-damage", power: 10 });
    assert.equal(player1.stats.parasiteDamage, 400, "Parasite damage must clamp at 4.0 max");

    const parasiteDmgUpg = ctx.SERVER_UPGRADES.find(u => u.id === "parasite-damage");
    assert.equal(parasiteDmgUpg.available(player1), false, "Parasite damage must become unavailable once capped at 400");
  });

  // =========================================================================
  // TIER 3: IN-GAME COMBAT SIMULATION & MECHANICS VERIFICATION
  // =========================================================================

  await t.test("Tier 3.1: Poison Bullet DoT application and 1.0s periodic tick damage", () => {
    const { room, world, player1 } = createTestWorld(ctx);
    player1.stats.poison = true;
    player1.stats.poisonDamage = 150;
    player1.stats.poisonDuration = 3.0;

    const enemy = ctx.createServerEnemy(world, "tank", 400, 400, true);
    enemy.hp = 2000;
    enemy.maxHp = 2000;
    enemy.hasEnteredArena = true;
    enemy.spawnEdge = null;
    world.enemies.set(enemy.id, enemy);

    const bullet = ctx.createServerBullet(world, player1, 395, 400, 200, 0);
    bullet.state = "flying";
    bullet.hitsLeft = 1;
    world.bullets.set(bullet.id, bullet);

    // Hit enemy
    ctx.updateServerBullet(room, bullet, 0.05);

    assert.ok(enemy.poisonTimer >= 2.9, `Poison timer must be initialized to ~3.0s, got ${enemy.poisonTimer}`);
    assert.equal(enemy.poisonDamage, 150);
    const hpAfterInitialHit = enemy.hp;

    // Advance 0.5s (no tick yet)
    ctx.updateServerEnemies(world, 0.5);
    assert.equal(enemy.hp, hpAfterInitialHit, "HP should not change before 1.0s tick");

    // Advance another 0.6s (total > 1.0s, triggering 1 tick of 1.5 damage)
    ctx.updateServerEnemies(world, 0.6);
    assert.equal(enemy.hp, hpAfterInitialHit - 150, "Poison tick must deal 1.5 damage at 1.0s");

    // Advance another 1.0s (triggering 2nd tick of 1.5 damage)
    ctx.updateServerEnemies(world, 1.0);
    assert.equal(enemy.hp, hpAfterInitialHit - 300, "Second poison tick must deal another 1.5 damage");
  });

  await t.test("Tier 3.2: Parasite death trigger spawns homing spores delivering authoritative damage", () => {
    const { room, world, player1 } = createTestWorld(ctx);
    player1.stats.parasite = true;
    player1.stats.parasiteChance = 1.0; // guaranteed for test
    player1.stats.parasiteCount = 2;
    player1.stats.parasiteDamage = 200;

    const victimEnemy = ctx.createServerEnemy(world, "tank", 300, 300, true);
    victimEnemy.hp = 50;
    victimEnemy.maxHp = 1000;
    victimEnemy.hasEnteredArena = true;
    victimEnemy.spawnEdge = null;
    victimEnemy.parasiteInfested = true;
    victimEnemy.parasiteCount = 2;
    victimEnemy.parasiteDamage = 200;
    world.enemies.set(victimEnemy.id, victimEnemy);

    const targetEnemy = ctx.createServerEnemy(world, "tank", 350, 300, true);
    targetEnemy.hp = 2000;
    targetEnemy.maxHp = 2000;
    targetEnemy.hasEnteredArena = true;
    targetEnemy.spawnEdge = null;
    world.enemies.set(targetEnemy.id, targetEnemy);

    const bullet = ctx.createServerBullet(world, player1, 295, 300, 200, 0);
    bullet.state = "flying";
    bullet.hitsLeft = 1;
    world.bullets.set(bullet.id, bullet);

    // Bullet hits and kills victimEnemy (1 HP)
    ctx.updateServerBullet(room, bullet, 0.05);

    // Victim enemy died and spawned 2 parasite spores
    assert.equal(world.enemies.has(victimEnemy.id), false, "Victim enemy must be dead");
    assert.equal(world.parasites.size, 2, "Must spawn 2 parasite spores on infested enemy death");

    // Update parasites simulation to let spores home in and strike targetEnemy
    for (let step = 0; step < 20; step++) {
      ctx.updateServerParasites(world, 0.05);
    }

    assert.ok(
      targetEnemy.hp <= 1800,
      `Target enemy must take parasite damage (hp <= 18), got ${targetEnemy.hp}`
    );
  });
});
