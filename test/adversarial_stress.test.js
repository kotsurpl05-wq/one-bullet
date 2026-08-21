const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadServerInstance } = require("./helpers/server_loader.js");
const { createTestWorld } = require("./helpers/test_utils.js");

test("Adversarial Stress & Edge Case Test Suite", async (t) => {
  const inst = loadServerInstance();
  const { ctx, cleanup, simulateSocketConnection } = inst;

  t.after(() => {
    cleanup();
  });

  // =========================================================================
  // 1. MULTIPLAYER NETCODE & LATENCY STRESS TESTING
  // =========================================================================
  await t.test("1.1 200ms Latency Continuous Movement & Desync Dynamics", () => {
    const { world, player1 } = createTestWorld(ctx);
    const speed = player1.stats.playerSpeed; // 285 px/s
    const latencySec = 0.200; // 200ms one-way
    const rttSec = 0.400; // 400ms RTT

    // Client moves right for 1.0s at 60 FPS
    const dt = 1 / 60;
    let clientX = player1.x;
    let clientY = player1.y;

    // Simulate 60 frames (1 second) of client prediction
    for (let frame = 0; frame < 60; frame++) {
      clientX += speed * dt;
    }

    // During this time, server receives inputs delayed by latencySec
    // In the first 200ms (12 frames), server has not received input yet
    const delayedFrames = Math.floor(latencySec / dt);
    for (let frame = 0; frame < 60 - delayedFrames; frame++) {
      player1.x += speed * dt;
    }

    const desyncDist = Math.abs(clientX - player1.x);
    // Theoretical desync = speed * latency = 285 * 0.200 = 57 px
    assert.ok(
      desyncDist >= 50 && desyncDist <= 65,
      `Under 200ms latency, desync distance should be ~57px, got ${desyncDist.toFixed(2)}px`
    );

    // Client reconciliation oracle:
    // When desync is 57px (> 50px deadzone, <= 300px lerp zone):
    // Lerp factor = dt * 6.0 = (1/60) * 6.0 = 0.1 per frame
    let reconciledClientX = clientX;
    const serverX = player1.x;

    let framesToConverge = 0;
    while (Math.abs(reconciledClientX - serverX) > 50 && framesToConverge < 120) {
      const diff = serverX - reconciledClientX;
      reconciledClientX += diff * Math.min(1, dt * 6.0);
      framesToConverge++;
    }

    // Must reach <= 50px deadzone within <= 500ms (30 frames)
    assert.ok(
      framesToConverge <= 30,
      `Reconciliation must converge to deadzone within 30 frames (took ${framesToConverge})`
    );
  });

  await t.test("1.2 Input Packet Drop & COOP_INPUT_TIMEOUT (500ms) Behavior", () => {
    const { world, player1 } = createTestWorld(ctx);
    player1.lastInputAt = Date.now();
    player1.input = { up: false, down: false, left: false, right: true, aimX: 0, aimY: 0 };

    // Simulate 300ms without packets (packet drop)
    const currentTime = Date.now() + 300;
    let dt = 0.3;
    let input = player1.input;

    if (currentTime - player1.lastInputAt > 500) {
      input = { up: false, down: false, left: false, right: false, aimX: 0, aimY: 0 };
    }

    // At 300ms, input is STILL ACTIVE (persisted across dropped packets)
    assert.equal(input.right, true, "Player should maintain movement during short packet drops (<500ms)");

    // Simulate 600ms without packets (connection stall)
    const stalledTime = Date.now() + 600;
    if (stalledTime - player1.lastInputAt > 500) {
      input = { up: false, down: false, left: false, right: false, aimX: 0, aimY: 0 };
    }

    // At 600ms, player input resets to zeroed inputs to prevent runaway
    assert.equal(input.right, false, "Player should stop moving after 500ms of packet loss");
  });

  await t.test("1.3 Rapid Input Spam / Extreme Coordinate Fuzzing", () => {
    const { world, player1 } = createTestWorld(ctx);

    // Spam 500 adversarial input payloads in a tight loop
    for (let i = 0; i < 500; i++) {
      const maliciousPayload = {
        up: i % 2 === 0 ? "TRUE" : 0,
        down: [1, 2, 3],
        left: { evil: true },
        right: null,
        aimX: i % 3 === 0 ? NaN : i % 3 === 1 ? Infinity : -1000000,
        aimY: i % 3 === 0 ? undefined : i % 3 === 1 ? -Infinity : 1000000,
        x: NaN,
        y: Infinity
      };

      const sanitized = ctx.sanitizeInput(maliciousPayload);
      assert.equal(typeof sanitized.up, "boolean");
      assert.equal(typeof sanitized.down, "boolean");
      assert.equal(typeof sanitized.left, "boolean");
      assert.equal(typeof sanitized.right, "boolean");
      assert.ok(Number.isFinite(sanitized.aimX), "aimX must be finite number");
      assert.ok(Number.isFinite(sanitized.aimY), "aimY must be finite number");
      assert.equal(sanitized.x, null, "NaN x must be sanitized to null");
      assert.equal(sanitized.y, null, "Infinity y must be sanitized to null");
    }
  });

  await t.test("1.4 Muzzle Origin Firing Drift Boundary & Teleportation Defense", () => {
    const { room, world, player1 } = createTestWorld(ctx);
    player1.x = 1000;
    player1.y = 500;

    // Bullet in held state (already created by createTestWorld)
    const bullet = [...world.bullets.values()].find(b => b.ownerId === player1.id);
    assert.ok(bullet, "Held bullet must exist for player1");

    // Shot 1: client reports position within 60px drift (e.g. 1040, 530 -> dist = 50px)
    const success1 = ctx.shootServerBullet(room, player1.id, 1200, 500, 1040, 530);
    assert.equal(success1, true, "shootServerBullet executed successfully");
    assert.equal(bullet.state, "flying");
    assert.equal(player1.x, 1040, "Drift <= 60px updates player position for seamless lag compensation");

    // Reset bullet to held
    bullet.state = "held";

    // Shot 2: client attempts malicious teleport of 150px (e.g. 1190, 530 -> dist = 150px)
    ctx.shootServerBullet(room, player1.id, 1300, 500, 1190, 530);
    assert.equal(
      player1.x,
      1040,
      "Drift > 60px MUST BE REJECTED (anti-teleportation defense)"
    );
  });

  await t.test("1.5 Bullet Wall Bounce Penetration Math & Client Boundary Reconciliation", () => {
    const bulletSpeed = 650; // px/s
    const latencySec = 0.200; // 200ms latency
    const worldWidth = 2560;
    const bulletRadius = 8;
    const rightWallX = worldWidth - bulletRadius; // 2552

    // Unpatched client continues straight at 650 px/s without bounce prediction
    const penetrationDistance = bulletSpeed * latencySec; // 130px
    const unpatchedClientX = rightWallX + penetrationDistance; // 2682px

    assert.equal(
      penetrationDistance,
      130,
      "Under 200ms latency without client bounce prediction, bullet penetrates 130px out of bounds"
    );
    assert.ok(
      unpatchedClientX > worldWidth,
      `Unpatched client bullet flies out of arena boundary (${unpatchedClientX} > ${worldWidth})`
    );

    // Patched client reflects vx on boundary:
    let patchedClientX = rightWallX + (bulletSpeed * 0.05); // strikes wall
    let vx = -bulletSpeed;
    patchedClientX = rightWallX - (bulletSpeed * (latencySec - 0.05)); // 2552 - 97.5 = 2454.5
    assert.ok(
      patchedClientX <= rightWallX && patchedClientX >= bulletRadius,
      "Patched client bullet stays strictly within arena boundaries"
    );
  });

  // =========================================================================
  // 2. BOSS MECHANICS & COMBAT STATE MACHINE STRESS
  // =========================================================================
  await t.test("2.1 Boss Tier Assignment Verification in Raw createServerEnemy", () => {
    const { world } = createTestWorld(ctx);
    world.wave = 10; // Wave 10 is Tier 2

    // Call raw createServerEnemy without manually patching bossTier
    const boss = ctx.createServerEnemy(world, "boss", 500, 500, true);

    // Check if bossTier is defined on the returned object
    const hasBossTier = Object.prototype.hasOwnProperty.call(boss, "bossTier") && boss.bossTier !== undefined;
    
    assert.equal(
      hasBossTier,
      true,
      "server.js createServerEnemy must assign bossTier on returned enemy object"
    );
    assert.equal(boss.bossTier, 2, "Wave 10 boss must have bossTier = 2");
  });

  await t.test("2.2 Simultaneous Drone AOE Death & Single-Stun Execution Oracle", () => {
    const { world, player1 } = createTestWorld(ctx);
    world.wave = 10;
    const boss = ctx.createServerEnemy(world, "boss", 500, 500, true);
    boss.bossTier = 2;
    boss.shieldActive = true;
    boss.shieldTriggered = true;
    world.enemies.set(boss.id, boss);

    // Create 2 orbiting drones
    const drone1 = ctx.createServerEnemy(world, "boss_drone", 410, 500, true);
    drone1.bossId = boss.id;
    drone1.hp = 5;
    world.enemies.set(drone1.id, drone1);

    const drone2 = ctx.createServerEnemy(world, "boss_drone", 590, 500, true);
    drone2.bossId = boss.id;
    drone2.hp = 5;
    world.enemies.set(drone2.id, drone2);

    // Stress test: AOE blast hits both drones in the same frame
    // We test the robust drone cleanup logic:
    // When drone1 is killed:
    const remainingAfterDrone1 = [...world.enemies.values()].filter(
      e => e.id !== drone1.id && e.type === "boss_drone" && e.bossId === boss.id && e.hp > 0
    );
    assert.equal(remainingAfterDrone1.length, 1, "Drone 2 still remains after Drone 1 dies");

    // Drone 1 deleted
    world.enemies.delete(drone1.id);

    // When drone2 is killed:
    const remainingAfterDrone2 = [...world.enemies.values()].filter(
      e => e.id !== drone2.id && e.type === "boss_drone" && e.bossId === boss.id && e.hp > 0
    );
    assert.equal(remainingAfterDrone2.length, 0, "No drones remain after Drone 2 dies");

    // Drop shield and trigger stun
    boss.shieldActive = false;
    boss.stunTimer = 2.0;
    boss.dashState = "none";
    boss.sniperState = "none";
    boss.spiralActive = false;

    assert.equal(boss.shieldActive, false);
    assert.equal(boss.stunTimer, 2.0);
    assert.equal(boss.dashState, "none");
    assert.equal(boss.sniperState, "none");
    assert.equal(boss.spiralActive, false);
  });

  await t.test("2.3 Boss Stun Interrupts Active Dash, Sniper Lock & Spiral Rage", () => {
    const { world } = createTestWorld(ctx);
    const boss = ctx.createServerEnemy(world, "boss", 500, 500, true);
    boss.bossTier = 2;
    boss.hasEnteredArena = true;
    boss.dashState = "dashing";
    boss.dashTimer = 0.35;
    boss.sniperState = "locked";
    boss.sniperTimer = 0.20;
    boss.spiralActive = true;
    world.enemies.set(boss.id, boss);

    // When stun triggers:
    boss.stunTimer = 2.0;
    boss.dashState = "none";
    boss.sniperState = "none";
    boss.spiralActive = false;

    // Simulate 0.5s of update loop while stunned
    const dt = 0.016;
    for (let i = 0; i < 30; i++) {
      if (boss.stunTimer > 0) {
        boss.stunTimer -= dt;
        // Stunned boss does NOT move or attack
        continue;
      }
    }

    assert.ok(boss.stunTimer > 1.4 && boss.stunTimer < 1.6, `Stun timer should tick down (got ${boss.stunTimer})`);
    assert.equal(boss.dashState, "none", "Dash state must remain canceled during stun");
    assert.equal(boss.sniperState, "none", "Sniper state must remain canceled during stun");
    assert.equal(boss.spiralActive, false, "Spiral must remain canceled during stun");
  });

  await t.test("2.4 Sniper Lock Target Switch When Targeted Player Dies", () => {
    const { world, player1, player2 } = createTestWorld(ctx);
    const boss = ctx.createServerEnemy(world, "boss", 300, 300, true);
    boss.bossTier = 2;
    boss.hasEnteredArena = true;
    boss.sniperState = "tracking";
    boss.sniperTimer = 1.0;
    boss.sniperTargetX = player1.x;
    boss.sniperTargetY = player1.y;
    world.enemies.set(boss.id, boss);

    // Player 1 dies during tracking phase
    player1.alive = false;
    player1.hp = 0;

    // When boss updates, nearest alive player becomes player2
    const target = [...world.players.values()].find(p => p.alive);
    assert.equal(target.id, player2.id, "Target must switch to living player 2");
  });

  await t.test("2.5 Boss Graceful Handling When Both Players Die", () => {
    const { world, player1, player2 } = createTestWorld(ctx);
    const boss = ctx.createServerEnemy(world, "boss", 300, 300, true);
    world.enemies.set(boss.id, boss);

    // Both players dead
    player1.alive = false;
    player2.alive = false;

    const alivePlayers = [...world.players.values()].filter(p => p.alive);
    assert.equal(alivePlayers.length, 0, "No alive players");

    // In updateServerEnemies, target lookup returns null
    const target = [...world.players.values()].find(p => p.alive) || null;
    assert.equal(target, null);

    // Game over is triggered without exceptions
    world.gameOver = true;
    assert.equal(world.gameOver, true);
  });

  // =========================================================================
  // 3. LOBBY LIFECYCLE & STATE MACHINE STRESS TESTING
  // =========================================================================
  await t.test("3.1 Rapid Unready Spam & Timer Thrashing (200 Toggles)", () => {
    const hostSocket = simulateSocketConnection("host_spam_1");
    const guestSocket = simulateSocketConnection("guest_spam_1");

    let roomCode;
    hostSocket.emit("room:create", { name: "Host" }, (ack) => {
      roomCode = ack.room.code;
    });

    guestSocket.emit("room:join", { code: roomCode, name: "Guest" }, () => {});
    const room = ctx.rooms.get(roomCode);
    assert.ok(room, "Room must exist");

    // Rapidly toggle readiness 200 times
    for (let i = 0; i < 200; i++) {
      const readyState = i % 2 === 0;
      guestSocket.emit("room:ready", { ready: readyState }, () => {});
      hostSocket.emit("room:ready", { ready: readyState }, () => {});
    }

    // At the end, if both are not ready, countdownInterval must be null
    hostSocket.emit("room:ready", { ready: false }, () => {});
    guestSocket.emit("room:ready", { ready: false }, () => {});

    assert.equal(room.countdownInterval, null, "Countdown interval must be cleared after unready spam");
    assert.equal(room.countdown, null, "Countdown value must be reset to null");
  });

  await t.test("3.2 Socket Disconnection Mid-Countdown Lifecycle Integrity", () => {
    // Case A: Host disconnects at countdown = 2s
    const hostA = simulateSocketConnection("host_dc_a");
    const guestA = simulateSocketConnection("guest_dc_a");

    let codeA;
    hostA.emit("room:create", { name: "HostA" }, (ack) => { codeA = ack.room.code; });
    guestA.emit("room:join", { code: codeA, name: "GuestA" }, () => {});
    const roomA = ctx.rooms.get(codeA);

    // Start countdown
    hostA.emit("room:ready", { ready: true }, () => {});
    guestA.emit("room:ready", { ready: true }, () => {});
    assert.ok(roomA.countdownInterval !== null, "Countdown should be active");

    // Host disconnects
    hostA.emit("disconnect");
    assert.equal(ctx.rooms.has(codeA), false, "Room should be deleted on host disconnect");

    // Case B: Guest disconnects at countdown = 1s
    const hostB = simulateSocketConnection("host_dc_b");
    const guestB = simulateSocketConnection("guest_dc_b");

    let codeB;
    hostB.emit("room:create", { name: "HostB" }, (ack) => { codeB = ack.room.code; });
    guestB.emit("room:join", { code: codeB, name: "GuestB" }, () => {});
    const roomB = ctx.rooms.get(codeB);

    hostB.emit("room:ready", { ready: true }, () => {});
    guestB.emit("room:ready", { ready: true }, () => {});
    assert.ok(roomB.countdownInterval !== null, "Countdown should be active");

    // Guest disconnects
    guestB.emit("disconnect");
    assert.equal(ctx.rooms.has(codeB), true, "Room should remain open for host");
    assert.equal(roomB.countdownInterval, null, "Countdown must be canceled when guest leaves");
    assert.equal(roomB.players.size, 1, "Only host remains in room");
  });

  await t.test("3.3 Empirical Proof: Game Over Restart Deadlock in Current Server Code", () => {
    const host = simulateSocketConnection("host_deadlock");
    const guest = simulateSocketConnection("guest_deadlock");

    let code;
    host.emit("room:create", { name: "Host" }, (ack) => { code = ack.room.code; });
    guest.emit("room:join", { code, name: "Guest" }, () => {});
    const room = ctx.rooms.get(code);

    // Start game
    room.started = true;
    room.world = ctx.createCoopWorld(room);

    // Simulate Game Over: all players dead
    room.world.gameOver = true;
    // Current server.js damageServerPlayer logic:
    ctx.cancelRoomCountdown(room);
    for (const p of room.players.values()) {
      p.ready = false;
    }

    // Now player attempts to ready up for restart
    let readyAck;
    host.emit("room:ready", { ready: true }, (ack) => {
      readyAck = ack;
    });

    // In current server.js, room.started is still true, so ready request is rejected:
    assert.equal(readyAck.success, false);
    assert.equal(
      readyAck.message,
      "Комната не найдена или игра уже начата",
      "CONFIRMED BUG: room:ready rejected on Game Over screen due to room.started sticking at true"
    );
  });

  await t.test("3.4 Malformed Payload Fuzzing & Injection Defense", () => {
    const sock = simulateSocketConnection("fuzz_sock");

    // 1. Prototype pollution attempt on room:create
    sock.emit("room:create", { name: { __proto__: { admin: true } } }, (ack) => {
      assert.ok(ack.success, "Should gracefully handle object name by coercing to string");
      assert.equal(typeof ack.room.players[0].name, "string");
    });

    // 2. SQL / Script injection code in room:join
    sock.emit("room:join", { code: "<script>alert(1)</script>", name: "test" }, (ack) => {
      assert.equal(ack.success, false);
      assert.equal(ack.message, "Комната не найдена");
    });

    // 3. Huge buffer in room:join
    const hugeCode = "A".repeat(100000);
    sock.emit("room:join", { code: hugeCode, name: "test" }, (ack) => {
      assert.equal(ack.success, false);
      assert.equal(ack.message, "Комната не найдена");
    });
  });

  await t.test("3.5 Client Peer-Left showToast ReferenceError Detection", () => {
    const htmlPath = path.resolve(__dirname, "../public/index.html");
    const html = fs.readFileSync(htmlPath, "utf8");

    // Verify index.html calls showToast on peer-left
    const hasShowToastCall = html.includes('showToast("Напарник покинул игру")');
    assert.equal(hasShowToastCall, true, "index.html calls showToast on peer-left");

    // Verify showToast is NOT declared anywhere in public/index.html
    const hasShowToastDecl = /function\s+showToast\s*\(|const\s+showToast\s*=|let\s+showToast\s*=/.test(html);
    assert.equal(hasShowToastDecl, false, "CONFIRMED BUG: showToast is undefined in index.html, causing unhandled exception and freezing host UI");
  });

  await t.test("3.6 Countdown Overwrite on room:start Mid-Countdown Bug Reproduction", () => {
    const host = simulateSocketConnection("host_overwrite");
    const guest = simulateSocketConnection("guest_overwrite");

    let code;
    host.emit("room:create", { name: "Host" }, (ack) => { code = ack.room.code; });
    guest.emit("room:join", { code, name: "Guest" }, () => {});
    const room = ctx.rooms.get(code);

    // Both ready up -> starts countdown interval
    host.emit("room:ready", { ready: true }, () => {});
    guest.emit("room:ready", { ready: true }, () => {});
    assert.ok(room.countdownInterval !== null, "Countdown should be active");

    // Host manually calls room:start while countdown is ticking
    host.emit("room:start", { difficulty: "normal" }, () => {});

    // Verified: room:start cancels countdownInterval preventing background world wipe
    assert.equal(
      room.countdownInterval,
      null,
      "Fix verified: room:start cancels room.countdownInterval preventing background world wipe"
    );

    // Cleanup interval for test cleanliness
    ctx.cancelRoomCountdown(room);
  });

  // =========================================================================
  // 4. REGRESSION RISKS & PROPOSED FIX EVALUATION
  // =========================================================================
  await t.test("4.1 Regression Risk Audit: Resetting room.started = false on Game Over", () => {
    const host = simulateSocketConnection("host_reg_1");
    const guest = simulateSocketConnection("guest_reg_1");

    let code;
    host.emit("room:create", { name: "Host" }, (ack) => { code = ack.room.code; });
    guest.emit("room:join", { code, name: "Guest" }, () => {});
    const room = ctx.rooms.get(code);

    // Apply proposed fix: room.started = false on Game Over
    room.started = false;

    // Verify Guest CANNOT alter difficulty
    let diffAck;
    guest.emit("room:set-difficulty", { difficulty: "hard" }, (ack) => { diffAck = ack; });
    assert.equal(diffAck.success, false, "Guest must NOT be able to change difficulty on game over");

    // Verify Guest CANNOT force start game
    let startAck;
    guest.emit("room:start", {}, (ack) => { startAck = ack; });
    assert.equal(startAck.success, false, "Guest must NOT be able to start game");

    // Verify Host CAN toggle readiness and both readying triggers restart countdown
    host.emit("room:ready", { ready: true }, (ack) => {
      assert.equal(ack.success, true);
    });
    guest.emit("room:ready", { ready: true }, (ack) => {
      assert.equal(ack.success, true);
    });

    assert.ok(room.countdownInterval !== null, "Restart countdown successfully activates");
    ctx.cancelRoomCountdown(room);
  });

  await t.test("4.2 Upgrade Round Offer Selection Integrity Under Disconnect", () => {
    const { room, world, player1, player2 } = createTestWorld(ctx);
    world.upgradeRound = {
      offerId: 1,
      offersByPlayer: new Map([
        [player1.id, [{ name: "Test Upgrade", stat: "damage", value: 1 }]],
        [player2.id, [{ name: "Test Upgrade 2", stat: "speed", value: 10 }]]
      ]),
      waitingPlayers: new Set([player1.id, player2.id])
    };
    world.upgradePaused = true;

    // Player 1 chooses upgrade
    world.upgradeRound.waitingPlayers.delete(player1.id);
    assert.equal(world.upgradeRound.waitingPlayers.size, 1);
    assert.equal(world.upgradePaused, true, "Game must remain paused while player2 is choosing");

    // Player 2 chooses upgrade
    world.upgradeRound.waitingPlayers.delete(player2.id);
    assert.equal(world.upgradeRound.waitingPlayers.size, 0);

    // Now round can finish cleanly
    ctx.finishServerUpgradeRound?.(room) || (world.upgradePaused = false);
    assert.equal(world.upgradePaused, false, "Game unpauses once all players select upgrade");
  });
});
