const test = require("node:test");
const assert = require("node:assert/strict");
const { loadServerInstance } = require("./helpers/server_loader.js");
const { createTestWorld } = require("./helpers/test_utils.js");

test("R2.1 catchBlast Upgrade Suite", async (t) => {
  const inst = loadServerInstance();
  const { ctx, cleanup } = inst;

  t.after(() => {
    cleanup();
  });

  await t.test("1. Single enemy within blast radius receives 1 damage", () => {
    const { world, player1: player } = createTestWorld(ctx);
    player.x = 500;
    player.y = 500;
    player.stats.catchBlast = 65;

    const bullet = [...world.bullets.values()].find(b => b.ownerId === player.id);
    bullet.state = "flying";

    const enemy = ctx.createServerEnemy(world, "normal", 530, 500, true);
    enemy.hp = 300;
    world.enemies.set(enemy.id, enemy);

    ctx.catchServerBullet(bullet, player, world);

    assert.equal(enemy.hp, 225, "Enemy hp should decrease by 1");
    assert.equal(bullet.state, "held", "Bullet state should transition to held");
  });

  await t.test("2. Multiple enemies within blast radius all receive 1 damage", () => {
    const { world, player1: player } = createTestWorld(ctx);
    player.x = 400;
    player.y = 400;
    player.stats.catchBlast = 80;

    const bullet = [...world.bullets.values()].find(b => b.ownerId === player.id);
    bullet.state = "flying";

    const enemies = [];
    for (let i = 0; i < 5; i++) {
      const angle = (i / 5) * Math.PI * 2;
      const ex = 400 + Math.cos(angle) * 50;
      const ey = 400 + Math.sin(angle) * 50;
      const enemy = ctx.createServerEnemy(world, "normal", ex, ey, true);
      enemy.hp = 300;
      world.enemies.set(enemy.id, enemy);
      enemies.push(enemy);
    }

    ctx.catchServerBullet(bullet, player, world);

    for (let i = 0; i < enemies.length; i++) {
      assert.equal(enemies[i].hp, 225, `Enemy ${i} should have taken 1 damage`);
    }
  });

  await t.test("3. Enemy outside blast radius takes 0 damage", () => {
    const { world, player1: player } = createTestWorld(ctx);
    player.x = 400;
    player.y = 400;
    player.stats.catchBlast = 65;

    const bullet = [...world.bullets.values()].find(b => b.ownerId === player.id);
    bullet.state = "flying";

    // Distance = 100 > catchBlast (65) + enemy.r (10) = 75
    const farEnemy = ctx.createServerEnemy(world, "normal", 500, 400, true);
    farEnemy.hp = 300;
    world.enemies.set(farEnemy.id, farEnemy);

    ctx.catchServerBullet(bullet, player, world);

    assert.equal(farEnemy.hp, 300, "Far enemy should take 0 damage");
  });

  await t.test("4. Precise boundary condition (dist == blast + enemy.r vs dist > blast + enemy.r)", () => {
    const { world, player1: player } = createTestWorld(ctx);
    player.x = 200;
    player.y = 200;
    player.stats.catchBlast = 60;

    const bullet = [...world.bullets.values()].find(b => b.ownerId === player.id);
    bullet.state = "flying";

    const enemyR = 12;
    // Exactly at boundary: distance = 60 + 12 = 72
    const edgeEnemy = ctx.createServerEnemy(world, "normal", 200 + 72, 200, true);
    edgeEnemy.r = enemyR;
    edgeEnemy.hp = 300;
    world.enemies.set(edgeEnemy.id, edgeEnemy);

    // Just outside boundary: distance = 72.05
    const outsideEnemy = ctx.createServerEnemy(world, "normal", 200, 200 + 72.05, true);
    outsideEnemy.r = enemyR;
    outsideEnemy.hp = 300;
    world.enemies.set(outsideEnemy.id, outsideEnemy);

    ctx.catchServerBullet(bullet, player, world);

    assert.equal(edgeEnemy.hp, 225, "Edge enemy exactly at boundary <= blast+r should take 1 damage");
    assert.equal(outsideEnemy.hp, 300, "Outside enemy > blast+r should take 0 damage");
  });

  await t.test("5. Unspawned enemy (hasEnteredArena = false) is ignored", () => {
    const { world, player1: player } = createTestWorld(ctx);
    player.x = 300;
    player.y = 300;
    player.stats.catchBlast = 100;

    const bullet = [...world.bullets.values()].find(b => b.ownerId === player.id);
    bullet.state = "flying";

    const unspawnedEnemy = ctx.createServerEnemy(world, "normal", 320, 300, false);
    unspawnedEnemy.hp = 300;
    world.enemies.set(unspawnedEnemy.id, unspawnedEnemy);

    ctx.catchServerBullet(bullet, player, world);

    assert.equal(unspawnedEnemy.hp, 300, "Unspawned enemy must take 0 damage");
  });

  await t.test("6. Zero stat behavior (catchBlast = 0 or undefined)", () => {
    const { world, player1: player } = createTestWorld(ctx);
    player.x = 300;
    player.y = 300;
    player.stats.catchBlast = 0;

    const bullet = [...world.bullets.values()].find(b => b.ownerId === player.id);
    bullet.state = "flying";

    const closeEnemy = ctx.createServerEnemy(world, "normal", 310, 300, true);
    closeEnemy.hp = 300;
    world.enemies.set(closeEnemy.id, closeEnemy);

    ctx.catchServerBullet(bullet, player, world);

    assert.equal(closeEnemy.hp, 300, "Enemy takes 0 damage when catchBlast is 0");
  });

  await t.test("7. Damage attribution and lethal kill credit from catchBlast", () => {
    const { world, player1: player } = createTestWorld(ctx);
    player.x = 300;
    player.y = 300;
    player.stats.catchBlast = 80;
    player.stats.healEvery = 10;
    player.stats.repairKillProgress = 3;

    const bullet = [...world.bullets.values()].find(b => b.ownerId === player.id);
    bullet.state = "flying";

    const weakEnemy = ctx.createServerEnemy(world, "normal", 320, 300, true);
    weakEnemy.hp = 50; // Lethal hit
    world.enemies.set(weakEnemy.id, weakEnemy);

    const initialKills = world.kills;
    ctx.catchServerBullet(bullet, player, world);

    assert.equal(world.enemies.has(weakEnemy.id), false, "Enemy should be dead and removed");
    assert.equal(world.kills, initialKills + 1, "World kills should increment");
    assert.equal(player.stats.repairKillProgress, 4, "Owner player should receive kill progress");
    assert.ok(world.experienceCrystals.size > 0, "XP crystals should drop");
  });
});
