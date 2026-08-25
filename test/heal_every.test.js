const test = require("node:test");
const assert = require("node:assert/strict");
const { loadServerInstance } = require("./helpers/server_loader.js");
const { createTestWorld } = require("./helpers/test_utils.js");

test("R2.2 Emergency Repair (healEvery & repairKillProgress) Suite", async (t) => {
  const inst = loadServerInstance();
  const { ctx, cleanup } = inst;

  t.after(() => {
    cleanup();
  });

  await t.test("1. Kill accumulation increments repairKillProgress up to healEvery", () => {
    const { world, player1: player } = createTestWorld(ctx);
    player.stats.healEvery = 5;
    player.stats.repairKillProgress = 0;
    player.hp = 1;
    player.maxHp = 3;

    for (let i = 1; i <= 4; i++) {
      const enemy = ctx.createServerEnemy(world, "normal", 100, 100, true);
      enemy.hp = 1;
      world.enemies.set(enemy.id, enemy);
      ctx.killServerEnemy(world, enemy, player);
      assert.equal(player.stats.repairKillProgress, i, `Progress should be ${i} after ${i} kills`);
      assert.equal(player.hp, 1, "Player should not heal before reaching healEvery threshold");
    }
  });

  await t.test("2. Reaching healEvery heals +1 HP, resets progress to 0, sets 1.75s cooldown", () => {
    const { world, player1: player } = createTestWorld(ctx);
    player.stats.healEvery = 5;
    player.stats.repairKillProgress = 4;
    player.hp = 200;
    player.maxHp = 400;
    player.repairHealCooldown = 0;

    const enemy = ctx.createServerEnemy(world, "normal", 100, 100, true);
    enemy.hp = 1;
    world.enemies.set(enemy.id, enemy);

    ctx.killServerEnemy(world, enemy, player);

    assert.equal(player.hp, 300, "Player HP should heal from 200 to 300");
    assert.equal(player.stats.repairKillProgress, 0, "Progress should reset to 0 upon healing");
    assert.equal(player.repairHealCooldown, 1.75, "Cooldown should be set to 1.75 seconds");
  });

  await t.test("3. Cooldown enforcement: kills during cooldown are ignored until cooldown expires", () => {
    const { room, world, player1: player } = createTestWorld(ctx);
    player.stats.healEvery = 5;
    player.stats.repairKillProgress = 0;
    player.hp = 200;
    player.maxHp = 400;
    player.repairHealCooldown = 1.75;

    // Kill enemy while cooldown is active
    const enemy1 = ctx.createServerEnemy(world, "normal", 100, 100, true);
    enemy1.hp = 1;
    world.enemies.set(enemy1.id, enemy1);
    ctx.killServerEnemy(world, enemy1, player);

    assert.equal(player.stats.repairKillProgress, 0, "Progress should NOT increment during active cooldown");

    // Advance cooldown by dt = 1.0s (remaining: 0.75s)
    player.repairHealCooldown = Math.max(0, player.repairHealCooldown - 1.0);
    assert.equal(player.repairHealCooldown, 0.75);

    const enemy2 = ctx.createServerEnemy(world, "normal", 100, 100, true);
    enemy2.hp = 1;
    world.enemies.set(enemy2.id, enemy2);
    ctx.killServerEnemy(world, enemy2, player);
    assert.equal(player.stats.repairKillProgress, 0, "Progress still 0 while 0.75s cooldown remains");

    // Advance cooldown past expiration (remaining: 0s)
    player.repairHealCooldown = Math.max(0, player.repairHealCooldown - 1.0);
    assert.equal(player.repairHealCooldown, 0);

    const enemy3 = ctx.createServerEnemy(world, "normal", 100, 100, true);
    enemy3.hp = 1;
    world.enemies.set(enemy3.id, enemy3);
    ctx.killServerEnemy(world, enemy3, player);
    assert.equal(player.stats.repairKillProgress, 1, "Progress should increment once cooldown expires");
  });

  await t.test("4. Full HP clamping to healEvery - 1 and immediate heal upon taking damage", () => {
    const { world, player1: player } = createTestWorld(ctx);
    player.stats.healEvery = 5;
    player.stats.repairKillProgress = 4;
    player.hp = 300;
    player.maxHp = 300; // Full HP
    player.repairHealCooldown = 0;

    // 5th kill at full HP
    const enemy1 = ctx.createServerEnemy(world, "normal", 100, 100, true);
    enemy1.hp = 1;
    world.enemies.set(enemy1.id, enemy1);
    ctx.killServerEnemy(world, enemy1, player);

    assert.equal(player.stats.repairKillProgress, 4, "Progress must clamp at healEvery - 1 (4) when full HP");
    assert.equal(player.hp, 300, "HP remains at maxHp");
    assert.equal(player.repairHealCooldown, 0, "No cooldown triggered when full HP");

    // 6th kill at full HP
    const enemy2 = ctx.createServerEnemy(world, "normal", 100, 100, true);
    enemy2.hp = 1;
    world.enemies.set(enemy2.id, enemy2);
    ctx.killServerEnemy(world, enemy2, player);
    assert.equal(player.stats.repairKillProgress, 4, "Progress remains clamped at 4 on repeated kills at full HP");

    // Player takes damage
    player.hp = 200;

    // Next kill should immediately heal player to 3 and reset progress to 0
    const enemy3 = ctx.createServerEnemy(world, "normal", 100, 100, true);
    enemy3.hp = 1;
    world.enemies.set(enemy3.id, enemy3);
    ctx.killServerEnemy(world, enemy3, player);

    assert.equal(player.hp, 300, "Player immediately healed to full HP on next kill");
    assert.equal(player.stats.repairKillProgress, 0, "Progress reset to 0");
    assert.equal(player.repairHealCooldown, 1.75, "Cooldown set to 1.75s");
  });

  await t.test("5. Kill credit under different damage types (bullet, explosive, chain lightning, catch blast, unassigned)", () => {
    const { world, player1: p1, player2: p2 } = createTestWorld(ctx);
    p1.stats.healEvery = 10;
    p1.stats.repairKillProgress = 0;
    p2.stats.healEvery = 10;
    p2.stats.repairKillProgress = 0;

    // 5a. Direct bullet hit kill by p1
    const enemy1 = ctx.createServerEnemy(world, "normal", 100, 100, true);
    enemy1.hp = 1;
    world.enemies.set(enemy1.id, enemy1);
    ctx.damageServerEnemy(world, enemy1.id, 1, p1);
    assert.equal(p1.stats.repairKillProgress, 1, "P1 should get bullet kill credit");
    assert.equal(p2.stats.repairKillProgress, 0, "P2 should NOT get bullet kill credit");

    // 5b. Catch blast kill by p2
    p2.stats.catchBlast = 70;
    p2.x = 200;
    p2.y = 200;
    const bullet2 = [...world.bullets.values()].find(b => b.ownerId === p2.id);
    bullet2.state = "flying";
    const enemy2 = ctx.createServerEnemy(world, "normal", 230, 200, true);
    enemy2.hp = 1;
    world.enemies.set(enemy2.id, enemy2);
    ctx.catchServerBullet(bullet2, p2, world);
    assert.equal(p1.stats.repairKillProgress, 1, "P1 progress unchanged");
    assert.equal(p2.stats.repairKillProgress, 1, "P2 should get catch blast kill credit");

    // 5c. Explosive damage kill by p1
    p1.stats.explosionRadius = 60;
    p1.stats.damage = 2;
    const enemy3 = ctx.createServerEnemy(world, "normal", 300, 300, true);
    enemy3.hp = 1;
    world.enemies.set(enemy3.id, enemy3);
    ctx.damageServerEnemy(world, enemy3.id, 1, p1);
    assert.equal(p1.stats.repairKillProgress, 2, "P1 should get explosive kill credit");
    assert.equal(p2.stats.repairKillProgress, 1, "P2 progress unchanged");

    // 5d. Chain lightning kill by p2
    const enemy4 = ctx.createServerEnemy(world, "normal", 400, 400, true);
    enemy4.hp = 1;
    world.enemies.set(enemy4.id, enemy4);
    ctx.damageServerEnemy(world, enemy4.id, 1, p2);
    assert.equal(p1.stats.repairKillProgress, 2, "P1 progress unchanged");
    assert.equal(p2.stats.repairKillProgress, 2, "P2 should get chain lightning kill credit");

    // 5e. Unattributed/environmental kill (killerPlayer = null/undefined)
    const enemy5 = ctx.createServerEnemy(world, "normal", 500, 500, true);
    enemy5.hp = 1;
    world.enemies.set(enemy5.id, enemy5);
    ctx.killServerEnemy(world, enemy5, null);
    assert.equal(p1.stats.repairKillProgress, 3, "P1 receives progress on unassigned kill");
    assert.equal(p2.stats.repairKillProgress, 3, "P2 receives progress on unassigned kill");
  });

  await t.test("6. Dead player does not accumulate progress", () => {
    const { world, player1: player } = createTestWorld(ctx);
    player.stats.healEvery = 5;
    player.stats.repairKillProgress = 0;
    player.alive = false;

    const enemy = ctx.createServerEnemy(world, "normal", 100, 100, true);
    enemy.hp = 1;
    world.enemies.set(enemy.id, enemy);

    ctx.killServerEnemy(world, enemy, player);
    assert.equal(player.stats.repairKillProgress, 0, "Dead player must not gain repair progress");
  });

  await t.test("7. Upgrade selection properly re-clamps repairKillProgress", () => {
    const { world, player1: player } = createTestWorld(ctx);
    player.stats.healEvery = 16;
    player.stats.repairKillProgress = 14;

    // Apply emergency-repair upgrade tier 2
    ctx.applyServerUpgrade(world, player, { upgradeId: "emergency-repair", power: 2 });

    assert.equal(player.stats.healEvery, 13, `healEvery should be 16 - 3 = 13 (was 16, now ${player.stats.healEvery})`);
    assert.equal(
      player.stats.repairKillProgress,
      12,
      `repairKillProgress was 14, now clamped to healEvery - 1 (12)`
    );
  });
});
