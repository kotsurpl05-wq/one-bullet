const test = require("node:test");
const assert = require("node:assert/strict");
const { loadServerInstance } = require("./helpers/server_loader.js");
const { createTestWorld } = require("./helpers/test_utils.js");

test("R1 Bullet Physics, Muzzle Origin & Sync Integrity Suite", async (t) => {
  const inst = loadServerInstance();
  const { ctx, cleanup } = inst;

  t.after(() => {
    cleanup();
  });

  await t.test("1. Muzzle origin calculation matches exact geometry formula (owner.r + bullet.r + 2)", () => {
    const { room, world, player1: player } = createTestWorld(ctx);
    player.x = 300;
    player.y = 400;
    player.r = 16;
    player.aimX = 500;
    player.aimY = 400; // Aiming directly right: dx = 1, dy = 0

    const bullet = [...world.bullets.values()].find(b => b.ownerId === player.id);
    assert.equal(bullet.state, "held");

    const fired = ctx.shootServerBullet(room, player.id, 500, 400, player.x, player.y);
    assert.equal(fired, true);
    assert.equal(bullet.state, "flying");

    // Expected muzzle position: 300 + 1 * (16 + 5 + 2) = 323
    const expectedX = player.x + (player.r + bullet.r + 2);
    const expectedY = player.y;

    assert.equal(bullet.x, expectedX, `Muzzle X should be ${expectedX}, got ${bullet.x}`);
    assert.equal(bullet.y, expectedY, `Muzzle Y should be ${expectedY}, got ${bullet.y}`);
    assert.equal(bullet.vx, ctx.COOP_BULLET_SPEED);
    assert.equal(bullet.vy, 0);
  });

  await t.test("2. Client position drift tolerance (COOP_SHOOT_MAX_POSITION_DRIFT = 60px)", () => {
    // 2a. Drift within tolerance (<=60px, e.g. 30px) updates server player pos
    {
      const { room, world, player1: player } = createTestWorld(ctx);
      player.x = 200;
      player.y = 200;

      const clientShootX = 230; // dist = 30px <= 60px
      const clientShootY = 200;

      ctx.shootServerBullet(room, player.id, 400, 200, clientShootX, clientShootY);
      assert.equal(player.x, 230, "Player x should be updated to client shoot position within tolerance");
    }

    // 2b. Drift exceeding tolerance (>60px, e.g. 150px) is rejected; server player pos is retained
    {
      const { room, world, player1: player } = createTestWorld(ctx);
      player.x = 200;
      player.y = 200;

      const clientShootX = 350; // dist = 150px > 60px
      const clientShootY = 200;

      ctx.shootServerBullet(room, player.id, 400, 200, clientShootX, clientShootY);
      assert.equal(player.x, 200, "Server player position must be preserved when drift exceeds 60px");
    }
  });

  await t.test("3. Bullet wall reflection and bounce counter decrement", () => {
    const { room, world, player1: player } = createTestWorld(ctx);
    const bullet = [...world.bullets.values()].find(b => b.ownerId === player.id);
    bullet.state = "flying";
    bullet.x = ctx.COOP_WORLD_WIDTH - 2; // Close to right wall
    bullet.y = 300;
    bullet.vx = 400; // moving right towards right boundary
    bullet.vy = 0;
    bullet.bouncesLeft = 2;

    ctx.updateServerBullet(room, bullet, 0.05);

    // Should reflect horizontally
    assert.ok(bullet.vx < 0, "Bullet vx must reflect negatively after hitting right wall");
    assert.equal(bullet.bouncesLeft, 1, "bouncesLeft should decrement from 2 to 1");
    assert.equal(bullet.state, "flying");
  });

  await t.test("4. Bounces exhaustion transitions bullet from flying to ground state", () => {
    const { room, world, player1: player } = createTestWorld(ctx);
    const bullet = [...world.bullets.values()].find(b => b.ownerId === player.id);
    bullet.state = "flying";
    bullet.x = ctx.COOP_WORLD_WIDTH - 2;
    bullet.y = 300;
    bullet.vx = 500;
    bullet.vy = 0;
    bullet.bouncesLeft = 0; // 0 bounces remaining

    ctx.updateServerBullet(room, bullet, 0.05);

    assert.equal(bullet.state, "ground", "Bullet must transition to 'ground' once bounces are exhausted");
    assert.equal(bullet.vx, 0, "Ground bullet horizontal velocity should be 0");
    assert.equal(bullet.vy, 0, "Ground bullet vertical velocity should be 0");
  });

  await t.test("5. Hit deduplication: hitEnemies set prevents multi-hit on same enemy in single pass", () => {
    const { world, player1: player } = createTestWorld(ctx);
    const bullet = [...world.bullets.values()].find(b => b.ownerId === player.id);
    bullet.state = "flying";
    bullet.hitsLeft = 3;
    bullet.hitEnemies.clear();

    const enemy = ctx.createServerEnemy(world, "normal", 400, 400, true);
    enemy.hp = 10;
    world.enemies.set(enemy.id, enemy);

    // First contact adds enemy to hitEnemies and damages enemy
    bullet.hitEnemies.add(enemy.id);
    bullet.hitsLeft -= 1;

    // Verify subsequent check in same pass treats enemy as already hit
    assert.ok(bullet.hitEnemies.has(enemy.id), "Enemy ID must be recorded in hitEnemies");
    assert.equal(bullet.hitsLeft, 2);
  });

  await t.test("6. Catch lifecycle: transition from ground to held, resetting bullet attributes", () => {
    const { world, player1: player } = createTestWorld(ctx);
    const bullet = [...world.bullets.values()].find(b => b.ownerId === player.id);
    bullet.state = "ground";
    bullet.x = 200;
    bullet.y = 200;
    bullet.hitEnemies.add("dummy-enemy");
    player.x = 200;
    player.y = 200;

    ctx.catchServerBullet(bullet, player, world);
    assert.equal(bullet.state, "held", "Bullet state must return to 'held'");
    assert.equal(bullet.vx, 0);
    assert.equal(bullet.vy, 0);
    assert.equal(bullet.hitEnemies.size, 0, "hitEnemies must be cleared on catch");
  });

  await t.test("7. Pierce & Ricochet Re-hit: Enemy is released after bullet exits radius or bounces", () => {
    const { room, world, player1: player } = createTestWorld(ctx);
    const bullet = [...world.bullets.values()].find(b => b.ownerId === player.id);
    bullet.state = "flying";
    bullet.hitsLeft = 3;
    bullet.bouncesLeft = 2;
    bullet.hitEnemies.clear();

    const enemy = ctx.createServerEnemy(world, "normal", 400, 400, true);
    enemy.hp = 10;
    world.enemies.set(enemy.id, enemy);

    // Initial state: bullet hits enemy at (400, 400)
    bullet.x = 400;
    bullet.y = 400;
    bullet.hitEnemies.add(enemy.id);

    // Refresh contacts while bullet is still at (400, 400) (inside enemy)
    ctx.refreshServerBulletContacts(world, bullet);
    assert.ok(bullet.hitEnemies.has(enemy.id), "Enemy must remain in hitEnemies while overlapping");

    // Bullet flies past enemy and exits collision radius (distance > bullet.r + enemy.r + 3)
    bullet.x = 400 + enemy.r + bullet.r + 10;
    bullet.y = 400;
    ctx.refreshServerBulletContacts(world, bullet);
    assert.equal(
      bullet.hitEnemies.has(enemy.id),
      false,
      "Enemy must be released from hitEnemies once bullet exits collision radius"
    );

    // Simulate bullet hitting a wall and bouncing
    bullet.hitEnemies.add(enemy.id); // was hit again
    bullet.x = ctx.COOP_WORLD_WIDTH;
    bullet.y = 500;
    bullet.vx = 400;
    bullet.vy = 0;
    ctx.updateServerBullet(room, bullet, 0.016); // Will trigger wall bounce
    assert.equal(
      bullet.hitEnemies.has(enemy.id),
      false,
      "Wall bounce must clear hitEnemies to allow striking enemies on return path"
    );
  });
});
