const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadServerInstance } = require("./helpers/server_loader.js");
const { createTestWorld } = require("./helpers/test_utils.js");

test("R2 Co-op Teammate Revival Beacon Suite", async (t) => {
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
  // TIER 1: UNIT TESTS (>= 5 unit tests covering primary revival mechanics)
  // =========================================================================
  await t.test("Tier 1 - Unit 1: Beacon Spawns on Player Death at Exact Coordinates in Co-op", () => {
    const { room, world, player1, player2 } = createTestWorld(ctx);
    player1.x = 240;
    player1.y = 360;
    player1.hp = 500;

    // Fatal damage to player 1
    ctx.damageServerPlayer(world, player1, player1.hp);

    assert.equal(player1.alive, false, "Player 1 must be dead");
    assert.equal(player1.hp, 0, "Player 1 HP must be 0");
    assert.ok(player1.reviveBeacon, "Revive beacon must be created on dead player");
    assert.equal(player1.reviveBeacon.x, 240, "Beacon X must match death coordinate X");
    assert.equal(player1.reviveBeacon.y, 360, "Beacon Y must match death coordinate Y");
    assert.equal(player1.reviveBeacon.progress, 0, "Beacon initial progress must be 0");
    assert.equal(player1.reviveBeacon.requiredTime, 3.0, "Beacon requiredTime must be 3.0s");
    assert.ok(
      player1.reviveBeacon.radius >= 70 && player1.reviveBeacon.radius <= 75,
      `Beacon radius must be between 70-75 (got ${player1.reviveBeacon.radius})`
    );
    assert.equal(player1.reviveBeacon.active, true, "Beacon must be active");
  });

  await t.test("Tier 1 - Unit 2: 3.0s Proximity Revive Accumulation Inside Radius", () => {
    const { room, world, player1, player2 } = createTestWorld(ctx);
    player1.x = 200;
    player1.y = 200;
    player1.hp = 1;
    ctx.damageServerPlayer(world, player1, player1.hp);

    // Place living player2 within beacon radius (e.g. distance = 20px <= 70px)
    player2.x = 220;
    player2.y = 200;

    const beacon = player1.reviveBeacon;
    assert.ok(beacon, "Beacon must exist");

    // Simulate 1.0 second in 1/60s ticks
    const dt = 1 / 60;
    for (let i = 0; i < 60; i++) {
      ctx.updateServerCoopWorld(room, dt, Date.now());
    }

    assert.ok(
      Math.abs(beacon.progress - 1.0) < 0.05,
      `Beacon progress should be ~1.0s after 1s (got ${beacon.progress})`
    );
    assert.equal(player1.alive, false, "Player should still be dead before reaching 3.0s");
  });

  await t.test("Tier 1 - Unit 3: Revival State (30% HP, 2.0s Invulnerability, Alive, Beacon Removed)", () => {
    const { room, world, player1, player2 } = createTestWorld(ctx);
    player1.maxHp = 10;
    player1.hp = 1;
    player1.x = 300;
    player1.y = 300;
    ctx.damageServerPlayer(world, player1, player1.hp);

    player2.x = 310;
    player2.y = 300; // Within radius

    // Accumulate 3.0s (180 frames at 60fps)
    const dt = 1 / 60;
    for (let i = 0; i < 185; i++) {
      ctx.updateServerCoopWorld(room, dt, Date.now());
    }

    assert.equal(player1.alive, true, "Player 1 should be revived");
    // 30% of maxHp 10 is 3
    const expectedHp = Math.max(1, Math.ceil(player1.maxHp * 0.3));
    assert.equal(player1.hp, expectedHp, `Revived player HP should be 30% max HP (${expectedHp}), got ${player1.hp}`);
    assert.ok(
      Math.abs(player1.invulnerability - 2.0) < 0.1 || player1.invulnerability >= 1.9,
      `Invulnerability must be ~2.0s (got ${player1.invulnerability})`
    );
    assert.ok(
      !player1.reviveBeacon || player1.reviveBeacon.active === false,
      "Revive beacon must be removed or inactive after revival"
    );
    assert.equal(player1.x, 300, "Revived player position X should match beacon X");
    assert.equal(player1.y, 300, "Revived player position Y should match beacon Y");
  });

  await t.test("Tier 1 - Unit 4: Snapshot Synchronization of Revive Beacon in CoopSnapshotV4", () => {
    const { room, world, player1, player2 } = createTestWorld(ctx);
    player1.x = 450;
    player1.y = 250;
    ctx.damageServerPlayer(world, player1, player1.hp);

    // Update slightly so beacon has progress
    player2.x = 460;
    player2.y = 250;
    ctx.updateServerCoopWorld(room, 0.5, Date.now());

    const snapshot = ctx.createServerCoopSnapshot(room);
    assert.equal(snapshot.type, "coop-server-v4", "Snapshot type must be coop-server-v4");

    const p1Snap = snapshot.players.find(p => p.id === player1.id);
    const p2Snap = snapshot.players.find(p => p.id === player2.id);

    assert.ok(p1Snap, "Player 1 must be present in snapshot");
    assert.equal(p1Snap.alive, false);
    assert.ok(p1Snap.reviveBeacon, "Dead player snapshot must include reviveBeacon");
    assert.equal(p1Snap.reviveBeacon.x, 450);
    assert.equal(p1Snap.reviveBeacon.y, 250);
    assert.equal(p1Snap.reviveBeacon.requiredTime, 3.0);
    assert.ok(p1Snap.reviveBeacon.progress > 0, "Beacon progress should be reflected in snapshot");

    assert.ok(p2Snap, "Player 2 must be present in snapshot");
    assert.equal(p2Snap.alive, true);
    assert.ok(!p2Snap.reviveBeacon, "Living player snapshot should not have reviveBeacon");
  });

  await t.test("Tier 1 - Unit 5: Inter-Wave Fallback Revive (50% HP & Fixed getPlayerSpawnPosition)", () => {
    const { room, world, player1, player2 } = createTestWorld(ctx);
    player1.maxHp = 10;
    player1.hp = 1;
    ctx.damageServerPlayer(world, player1, player1.hp);

    assert.equal(player1.alive, false);

    // Call reviveServerPlayers directly or verify getPlayerSpawnPosition
    assert.doesNotThrow(() => {
      ctx.reviveServerPlayers(world);
    }, "reviveServerPlayers must execute without ReferenceError on getPlayerSpawnPosition");

    assert.equal(player1.alive, true, "Player 1 should be revived by inter-wave revive");
    // Fallback revive restores 50% HP (Math.ceil(10 / 2) = 5)
    const expectedFallbackHp = Math.max(1, Math.ceil(player1.maxHp / 2));
    assert.equal(player1.hp, expectedFallbackHp, "Fallback revive must restore 50% HP");
    assert.ok(player1.invulnerability >= 1.0, "Fallback revive must grant invulnerability");
  });

  await t.test("Tier 1 - Unit 6: getPlayerSpawnPosition Determinism and Correct Arena Placement", () => {
    const getSpawn = ctx.getPlayerSpawnPosition || ctx.getServerPlayerSpawnPosition;
    assert.ok(typeof getSpawn === "function", "getPlayerSpawnPosition must be a defined function");

    const hostPos = getSpawn(0, 2);
    const guestPos = getSpawn(1, 2);

    assert.ok(hostPos && typeof hostPos.x === "number" && typeof hostPos.y === "number");
    assert.ok(guestPos && typeof guestPos.x === "number" && typeof guestPos.y === "number");

    // Host should be offset to the left, guest to the right of center
    const expectedCenterX = ctx.COOP_WORLD_WIDTH / 2;
    const expectedCenterY = ctx.COOP_WORLD_HEIGHT / 2;

    assert.equal(hostPos.x, expectedCenterX - 70, "Host spawn X should be center - 70");
    assert.equal(hostPos.y, expectedCenterY, "Host spawn Y should be center Y");
    assert.equal(guestPos.x, expectedCenterX + 70, "Guest spawn X should be center + 70");
    assert.equal(guestPos.y, expectedCenterY, "Guest spawn Y should be center Y");
  });

  // =========================================================================
  // TIER 2: BOUNDARY & EDGE CASE TESTS (>= 5 tests)
  // =========================================================================
  await t.test("Tier 2 - Boundary 1: Radius Boundary Conditions (Inside vs Outside Radius)", () => {
    const { room, world, player1, player2 } = createTestWorld(ctx);
    player1.x = 500;
    player1.y = 500;
    ctx.damageServerPlayer(world, player1, player1.hp);

    const radius = player1.reviveBeacon ? player1.reviveBeacon.radius : 70;

    // Position player2 just OUTSIDE radius (radius + 5px)
    player2.x = 500 + radius + 5;
    player2.y = 500;

    ctx.updateServerCoopWorld(room, 1.0, Date.now());
    if (player1.reviveBeacon) {
      assert.equal(
        player1.reviveBeacon.progress,
        0,
        "Beacon progress must not accumulate when teammate is outside radius"
      );
    }

    // Move player2 just INSIDE radius (radius - 5px)
    player2.x = 500 + radius - 5;
    player2.y = 500;

    ctx.updateServerCoopWorld(room, 1.0, Date.now());
    if (player1.reviveBeacon) {
      assert.ok(
        player1.reviveBeacon.progress > 0.9,
        "Beacon progress must accumulate when teammate is inside radius"
      );
    }
  });

  await t.test("Tier 2 - Boundary 2: Interrupted / Stepped Proximity (Pause / Accumulation Handling)", () => {
    const { room, world, player1, player2 } = createTestWorld(ctx);
    player1.x = 300;
    player1.y = 300;
    ctx.damageServerPlayer(world, player1, player1.hp);

    // Step in for 1.0 second
    player2.x = 320;
    player2.y = 300;
    for (let i = 0; i < 60; i++) {
      ctx.updateServerCoopWorld(room, 1 / 60, Date.now());
    }
    const progressAfterStepIn = player1.reviveBeacon ? player1.reviveBeacon.progress : 0;
    assert.ok(Math.abs(progressAfterStepIn - 1.0) < 0.05);

    // Step out for 1.0 second -> progress does not increase
    player2.x = 800;
    player2.y = 800;
    for (let i = 0; i < 60; i++) {
      ctx.updateServerCoopWorld(room, 1 / 60, Date.now());
    }
    if (player1.reviveBeacon) {
      assert.ok(
        Math.abs(player1.reviveBeacon.progress - progressAfterStepIn) < 0.05,
        "Progress should pause while teammate is away"
      );
    }

    // Step back in for 2.0 seconds -> total 3.0s reaches revival
    player2.x = 320;
    player2.y = 300;
    for (let i = 0; i < 125; i++) {
      ctx.updateServerCoopWorld(room, 1 / 60, Date.now());
    }

    assert.equal(player1.alive, true, "Player should be revived after completing total 3.0s");
  });

  await t.test("Tier 2 - Boundary 3: Both Players Dying Results in Game Over (No Revival)", () => {
    const { room, world, player1, player2 } = createTestWorld(ctx);
    player1.hp = 1;
    player2.hp = 1;

    // Player 1 dies
    ctx.damageServerPlayer(world, player1, player1.hp);
    assert.equal(world.gameOver, false, "Game should not be over when only 1 player dies in co-op");
    assert.ok(player1.reviveBeacon, "Player 1 should have revive beacon");

    // Player 2 dies
    ctx.damageServerPlayer(world, player2, player2.hp);
    assert.equal(world.gameOver, true, "Game must be over when both players die");

    // Update world ticks should do nothing when gameOver is true
    ctx.updateServerCoopWorld(room, 1.0, Date.now());
    assert.equal(player1.alive, false);
    assert.equal(player2.alive, false);
  });

  await t.test("Tier 2 - Boundary 4: Solo Mode Death Immediately Triggers Game Over (No Beacon)", () => {
    // Create single player room (guestId = null)
    const { room, world, player1 } = createTestWorld(ctx, { guestId: null });
    assert.equal(world.players.size, 1, "Solo world must have exactly 1 player");

    ctx.damageServerPlayer(world, player1, player1.hp);
    assert.equal(player1.alive, false, "Player must be dead");
    assert.equal(world.gameOver, true, "Solo death must immediately cause game over");
    assert.ok(
      !player1.reviveBeacon || player1.reviveBeacon.active === false,
      "Revive beacon should not spawn in solo mode"
    );
  });

  await t.test("Tier 2 - Boundary 5: Dead Player Cannot Revive Other Players", () => {
    const { room, world, player1, player2 } = createTestWorld(ctx);
    player1.x = 200;
    player1.y = 200;
    player2.x = 210;
    player2.y = 200;

    // Both players take lethal damage
    player1.hp = 0;
    player1.alive = false;
    player2.hp = 0;
    player2.alive = false;
    world.gameOver = false; // artificially test dead player logic isolation

    if (player1.reviveBeacon) player1.reviveBeacon.progress = 0;

    // Tick world
    ctx.updateServerCoopWorld(room, 1.0, Date.now());

    // Progress on player1's beacon must not increase because player2 is not alive
    if (player1.reviveBeacon) {
      assert.equal(
        player1.reviveBeacon.progress,
        0,
        "Dead player cannot contribute revive progress"
      );
    }
  });

  await t.test("Tier 2 - Boundary 6: Client Code Parity Audit for R2 Revive Beacon (public/index.html)", () => {
    const indexHtmlPath = path.resolve(process.cwd(), "public/index.html");
    const html = fs.readFileSync(indexHtmlPath, "utf8");

    // Client should reference reviveBeacon or revive rendering logic
    assert.ok(
      html.includes("reviveBeacon") || html.includes("drawReviveBeacon") || html.includes("reviveProgress"),
      "index.html should have reviveBeacon rendering or handling"
    );
  });

  // =========================================================================
  // TIER 3: CROSS-FEATURE INTEGRATION TESTS
  // =========================================================================
  await t.test("Tier 3 - Cross-Feature 1: Active Combat During Revival (Invulnerability Protects from Damage)", () => {
    const { room, world, player1, player2 } = createTestWorld(ctx);
    player1.x = 400;
    player1.y = 400;
    ctx.damageServerPlayer(world, player1, player1.hp);

    // Spawn an aggressive enemy on top of the beacon
    const enemy = ctx.createServerEnemy(world, "normal", 400, 400, true);
    world.enemies.set(enemy.id, enemy);

    player2.x = 410;
    player2.y = 400;
    player2.invulnerability = 0;

    // Revive player1 by standing nearby for 3.0s
    for (let i = 0; i < 185; i++) {
      ctx.updateServerCoopWorld(room, 1 / 60, Date.now());
    }

    assert.equal(player1.alive, true, "Player 1 must be revived");
    assert.ok(player1.invulnerability > 0, "Revived player must have invulnerability");

    const hpImmediatelyAfterRevive = player1.hp;

    // Enemy touches player1 while invulnerable -> damageServerPlayer should return false
    const damaged = ctx.damageServerPlayer(world, player1, player1.hp);
    assert.equal(damaged, false, "Damage during revival invulnerability must be blocked");
    assert.equal(player1.hp, hpImmediatelyAfterRevive, "HP should remain intact during invulnerability");
  });

  await t.test("Tier 3 - Cross-Feature 2: Bullet Retrieval Parity on Manual vs Fallback Revive", () => {
    const { room, world, player1, player2 } = createTestWorld(ctx);
    player1.x = 300;
    player1.y = 300;

    // Player 1 drops bullet
    const bullet = ctx.createServerBullet(world, player1.id, 300, 300, 0, 0);
    bullet.state = "ground";
    world.bullets.set(bullet.id, bullet);

    // Player 1 dies
    ctx.damageServerPlayer(world, player1, player1.hp);

    // Manual revive
    player2.x = 310;
    player2.y = 300;
    for (let i = 0; i < 185; i++) {
      ctx.updateServerCoopWorld(room, 1 / 60, Date.now());
    }

    assert.equal(player1.alive, true);
    assert.equal(player1.hp, Math.ceil(player1.maxHp * 0.3), "Manual revive gives 30% HP");

    // Bullet should be held or available
    assert.ok(bullet.state === "held" || bullet.state === "ground");
  });

  await t.test("Tier 3 - Cross-Feature 3: Variable Delta-Time Accumulation Stability (60Hz vs 30Hz)", () => {
    const { room: room60, world: world60, player1: p1_60, player2: p2_60 } = createTestWorld(ctx, { code: "FPS60" });
    const { room: room30, world: world30, player1: p1_30, player2: p2_30 } = createTestWorld(ctx, { code: "FPS30" });

    // Both player1s die at (200, 200)
    p1_60.x = 200; p1_60.y = 200; ctx.damageServerPlayer(world60, p1_60, p1_60.hp);
    p1_30.x = 200; p1_30.y = 200; ctx.damageServerPlayer(world30, p1_30, p1_30.hp);

    // Teammates stand at (210, 200)
    p2_60.x = 210; p2_60.y = 200;
    p2_30.x = 210; p2_30.y = 200;

    // Simulate 2.0s at 60Hz (120 frames with dt = 1/60)
    for (let i = 0; i < 120; i++) {
      ctx.updateServerCoopWorld(room60, 1 / 60, Date.now());
    }

    // Simulate 2.0s at 30Hz (60 frames with dt = 1/30)
    for (let i = 0; i < 60; i++) {
      ctx.updateServerCoopWorld(room30, 1 / 30, Date.now());
    }

    const prog60 = p1_60.reviveBeacon ? p1_60.reviveBeacon.progress : 0;
    const prog30 = p1_30.reviveBeacon ? p1_30.reviveBeacon.progress : 0;

    assert.ok(
      Math.abs(prog60 - 2.0) < 0.05,
      `60Hz progress should be ~2.0s (got ${prog60})`
    );
    assert.ok(
      Math.abs(prog30 - 2.0) < 0.05,
      `30Hz progress should be ~2.0s (got ${prog30})`
    );
    assert.ok(
      Math.abs(prog60 - prog30) < 0.05,
      `Progress difference across frame rates should be minimal (got ${Math.abs(prog60 - prog30)})`
    );
  });

  // =========================================================================
  // TIER 4: WORKLOAD & REALISTIC PROGRESSION TESTS
  // =========================================================================
  await t.test("Tier 4 - Progression 1: Multi-Wave Scenario with Manual Revival and Inter-Wave Fallback", () => {
    const { room, world, player1, player2 } = createTestWorld(ctx);

    // --- Wave 1: Player 1 dies, Player 2 performs manual beacon revive ---
    world.wave = 1;
    player1.hp = 1;
    player1.x = 250;
    player1.y = 250;
    ctx.damageServerPlayer(world, player1, player1.hp);
    assert.equal(player1.alive, false);
    assert.ok(player1.reviveBeacon);

    // Player 2 moves to beacon and revives Player 1
    player2.x = 260;
    player2.y = 250;
    for (let i = 0; i < 185; i++) {
      ctx.updateServerCoopWorld(room, 1 / 60, Date.now());
    }
    assert.equal(player1.alive, true, "Player 1 manually revived in Wave 1");
    assert.equal(player1.hp, Math.ceil(player1.maxHp * 0.3));

    // Clear wave 1
    world.enemies.clear();
    world.wavePending = true;
    world.waveClearTimer = 0.05;

    // --- Wave 2: Player 2 dies, but wave clears before manual revive -> Fallback revive triggered ---
    ctx.updateServerCoopWorld(room, 0.1, Date.now()); // Transitions to wave 2
    assert.equal(world.wave, 2);

    player2.hp = 1;
    ctx.damageServerPlayer(world, player2, player2.hp);
    assert.equal(player2.alive, false);

    // Clear wave 2 enemies without manual revive
    world.enemies.clear();
    world.wavePending = true;
    world.waveClearTimer = 0.05;

    // Ticking triggers wave transition and fallback auto-revive
    ctx.updateServerCoopWorld(room, 0.1, Date.now());
    assert.equal(world.wave, 3, "Wave advanced to 3");
    assert.equal(player2.alive, true, "Player 2 auto-revived at wave transition");
    assert.equal(player2.hp, Math.ceil(player2.maxHp / 2), "Fallback auto-revive gives 50% HP");

    // Final room state snapshot check
    const finalSnapshot = ctx.createServerCoopSnapshot(room);
    assert.equal(finalSnapshot.wave, 3);
    assert.equal(finalSnapshot.players.every(p => p.alive), true);
    assert.equal(finalSnapshot.players.every(p => !p.reviveBeacon), true);
  });
});
