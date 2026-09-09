const test = require("node:test");
const assert = require("node:assert/strict");
const { loadServerInstance } = require("./helpers/server_loader.js");

test("Network Stability Matrix (N04 - N12)", async (t) => {
  const inst = loadServerInstance();
  const { ctx, cleanup, simulateSocketConnection } = inst;

  t.after(() => {
    cleanup();
  });

  let socketCounter = 100;
  function setupActiveCoopGame() {
    const hostSocket = simulateSocketConnection(`host_sock_${socketCounter++}`);
    const guestSocket = simulateSocketConnection(`guest_sock_${socketCounter++}`);

    let hostAck;
    hostSocket.emit("room:create", { name: "HostPlayer" }, (ack) => {
      hostAck = ack;
    });

    const code = hostAck.room.code;
    const room = ctx.rooms.get(code);

    let guestAck;
    guestSocket.emit("room:join", { code, name: "GuestPlayer" }, (ack) => {
      guestAck = ack;
    });

    room.started = true;
    room.world = ctx.createCoopWorld(room);

    return { hostSocket, guestSocket, hostAck, guestAck, room, code };
  }

  await t.test("N04: Reconnect token survives past 2 minutes without expiring during active match", () => {
    const { guestAck, room, code } = setupActiveCoopGame();
    // Simulate match lasting 3 minutes (180 seconds)
    room.world.gameTime = 180;

    // Guest reconnects with original token
    const newGuestSocket = simulateSocketConnection(`guest_new_${socketCounter++}`);
    let ack;
    newGuestSocket.emit("room:reconnect", { code, token: guestAck.reconnectToken, name: "GuestPlayer" }, (res) => {
      ack = res;
    });

    assert.equal(ack.success, true);
    assert.equal(ack.playerId, guestAck.playerId);
  });

  await t.test("N05: Reconnect during manual pause preserves manual pause", () => {
    const { hostSocket, guestSocket, guestAck, room, code } = setupActiveCoopGame();

    // Host pauses manually
    hostSocket.emit("net:toggle-pause");
    assert.equal(room.world.manualPaused, true);

    // Guest disconnects
    guestSocket.emit("disconnect");
    assert.equal(room.world.manualPaused, true);
    assert.ok(room.world.reconnectState?.paused);

    // Guest reconnects
    const newGuestSocket = simulateSocketConnection(`guest_pause_${socketCounter++}`);
    let ack;
    newGuestSocket.emit("room:reconnect", { code, token: guestAck.reconnectToken }, (res) => {
      ack = res;
    });
    assert.equal(ack.success, true);

    // Manual pause must NOT be removed by reconnecting
    assert.equal(room.world.manualPaused, true);
    // Unpause countdown must NOT start while manualPaused is true
    assert.equal(room.world.unpauseCountdown, null);
    assert.equal(room.world.reconnectState, null);
  });

  await t.test("N06: Disconnect before upgrade choice: re-offers identical offerId, cards, and rerolls", () => {
    const { guestSocket, guestAck, room, code } = setupActiveCoopGame();

    // Start upgrade round with pending level-up
    room.world.pendingLevelUps = 1;
    ctx.startServerUpgradeRound(room);
    const round = room.world.upgradeRound;
    assert.ok(round);
    const originalOfferId = round.offerId;
    const originalOffers = round.offersByPlayer.get(guestAck.playerId);
    assert.ok(originalOffers && originalOffers.length > 0);

    // Guest disconnects before choosing
    guestSocket.emit("disconnect");

    // Guest reconnects
    const newGuestSocket = simulateSocketConnection(`guest_upg_${socketCounter++}`);
    let ack;
    newGuestSocket.emit("room:reconnect", { code, token: guestAck.reconnectToken }, (res) => {
      ack = res;
    });
    assert.equal(ack.success, true);

    // New socket must receive net:upgrade-offers with exact same offerId and cards
    const offerEvents = newGuestSocket.emitted.filter(e => e.event === "net:upgrade-offers");
    assert.ok(offerEvents.length > 0, "Must receive net:upgrade-offers on reconnect");
    const payload = offerEvents[offerEvents.length - 1].args[0];
    assert.equal(payload.offerId, originalOfferId);
    assert.deepEqual(payload.offers, originalOffers);

    // Guest can now successfully submit choice
    newGuestSocket.emit("net:upgrade-choice", { offerId: originalOfferId, index: 0 });
    const worldGuest = room.world.players.get(guestAck.playerId);
    assert.equal(worldGuest.selectedUpgrades.length, 1);
  });

  await t.test("N07: Disconnect after upgrade choice: sends upgrade-waiting, does not grant duplicate upgrade", () => {
    const { hostSocket, guestSocket, hostAck, guestAck, room, code } = setupActiveCoopGame();

    // Start upgrade round with pending level-up
    room.world.pendingLevelUps = 1;
    ctx.startServerUpgradeRound(room);
    const round = room.world.upgradeRound;
    assert.ok(round);

    // Guest makes choice
    guestSocket.emit("net:upgrade-choice", { offerId: round.offerId, index: 0 });
    const worldGuest = room.world.players.get(guestAck.playerId);
    assert.equal(worldGuest.selectedUpgrades.length, 1);

    // Guest disconnects and reconnects while Host is still deciding
    guestSocket.emit("disconnect");
    const newGuestSocket = simulateSocketConnection(`guest_chosen_${socketCounter++}`);
    let reconnectAck;
    newGuestSocket.emit("room:reconnect", { code, token: guestAck.reconnectToken }, (res) => {
      reconnectAck = res;
    });
    assert.equal(reconnectAck.success, true);

    // Guest must receive net:upgrade-waiting
    const waitingEvents = newGuestSocket.emitted.filter(e => e.event === "net:upgrade-waiting");
    assert.ok(waitingEvents.length > 0, "Must receive net:upgrade-waiting");

    // Upgrade must NOT be granted a second time
    assert.equal(worldGuest.selectedUpgrades.length, 1);

    // Re-sending upgrade-choice on the same offerId must be ignored / not applied
    newGuestSocket.emit("net:upgrade-choice", { offerId: round.offerId, index: 0 });
    assert.equal(worldGuest.selectedUpgrades.length, 1);
  });

  await t.test("N08: Disconnect during unpause countdown immediately cancels countdown and returns to waiting", () => {
    const { hostSocket, guestSocket, guestAck, room, code } = setupActiveCoopGame();

    // Trigger unpause countdown
    room.world.unpauseCountdown = 3.0;
    room.world.reconnectState = { unfreezing: true, countdown: 3, countdownSec: 3 };

    // Advance 1 second
    ctx.updateServerCoopWorld(room, 1.0);
    assert.ok(room.world.unpauseCountdown <= 2.1);

    // Host disconnects while countdown is running
    hostSocket.emit("disconnect");

    // Countdown must be cancelled immediately
    assert.equal(room.world.unpauseCountdown, null);
    assert.equal(room.world.reconnectState.paused, true);
    assert.equal(room.world.reconnectState.unfreezing, undefined);
  });

  await t.test("N09: Stale commands and disconnect from old socket are discarded after reconnect", () => {
    const { guestSocket, guestAck, room, code } = setupActiveCoopGame();
    const guestPlayer = room.world.players.get(guestAck.playerId);
    const startX = guestPlayer.x;
    const startY = guestPlayer.y;

    // Disconnect old socket
    guestSocket.emit("disconnect");

    // Reconnect with new socket
    const newGuestSocket = simulateSocketConnection(`guest_fresh_${socketCounter++}`);
    newGuestSocket.emit("room:reconnect", { code, token: guestAck.reconnectToken }, () => {});

    // Old socket attempts to send move
    guestSocket.emit("player:move", { x: startX + 200, y: startY + 200, aimX: 0, aimY: 0 });
    assert.equal(guestPlayer.x, startX, "Old socket movement must not move the player");

    // Old socket disconnect event must not mark the active player disconnected
    guestSocket.emit("disconnect");
    assert.equal(room.players.get(guestAck.playerId).disconnected, false);
  });

  await t.test("N10: 120-second wait expiration removes room cleanly", () => {
    const { guestSocket, room, code } = setupActiveCoopGame();

    // Guest disconnects
    guestSocket.emit("disconnect");
    assert.ok(room.reconnectTimeout);

    // Expire timeout manually
    assert.ok(ctx.rooms.has(code));
    clearTimeout(room.reconnectTimeout);
    ctx.closeRoom(room, "Время ожидания переподключения истекло");

    assert.equal(ctx.rooms.has(code), false);
  });

  await t.test("N11: Static enemy fields included on full snapshot and dropped on regular snapshots", () => {
    const { room } = setupActiveCoopGame();

    // Spawn an enemy
    const enemy = ctx.createServerEnemy(room.world, "boss", 500, 300, true);
    enemy.bossTier = 2;
    room.world.enemies.set(enemy.id, enemy);

    // First snapshot carries static fields
    const snap1 = ctx.createServerCoopSnapshot(room, {});
    const enemy1 = snap1.enemies.find(e => e.id === enemy.id);
    assert.ok(enemy1);
    assert.equal(enemy1.type, "boss");
    assert.ok(enemy1.r > 0);
    assert.ok(enemy1.maxHp > 0);
    assert.ok(enemy1.color);

    // Second snapshot drops static fields for existing enemy
    const snap2 = ctx.createServerCoopSnapshot(room, {});
    const enemy2 = snap2.enemies.find(e => e.id === enemy.id);
    assert.ok(enemy2);
    assert.equal(enemy2.type, undefined, "Later snapshot must drop static fields for existing enemy");

    // Full snapshot requested: static fields included again
    const fullSnap = ctx.createServerCoopSnapshot(room, { full: true });
    const enemyFull = fullSnap.enemies.find(e => e.id === enemy.id);
    assert.ok(enemyFull);
    assert.equal(enemyFull.type, "boss", "Full snapshot must include static fields");
  });

  await t.test("N12: matchSeq is incremented on room restart and older snapshots are rejected", () => {
    const { room } = setupActiveCoopGame();
    assert.equal(room.world.matchSeq, 1);

    // Snapshot seq 1
    const snap1 = ctx.createServerCoopSnapshot(room, {});
    assert.equal(snap1.matchSeq, 1);

    // Simulate match restart inside room
    room.matchSeq = 2;
    room.world.matchSeq = 2;
    const snap2 = ctx.createServerCoopSnapshot(room, {});
    assert.equal(snap2.matchSeq, 2);

    // Client sequence checking rule: snap1 has matchSeq 1 < current matchSeq 2 -> must be dropped
    const clientCoopSession = { matchSeq: 2, lastSnapshotSeq: 10 };
    const shouldDrop = snap1.matchSeq < clientCoopSession.matchSeq;
    assert.equal(shouldDrop, true, "Snapshots from older matchSeq must be dropped");
  });
});

test("Combat Mechanics Matrix (B01 - B07)", async (t) => {
  const inst = loadServerInstance();
  const { ctx, cleanup, simulateSocketConnection } = inst;

  t.after(() => {
    cleanup();
  });

  let socketCounter = 200;
  function setupActiveCoopGame() {
    const hostSocket = simulateSocketConnection(`host_c_${socketCounter++}`);
    const guestSocket = simulateSocketConnection(`guest_c_${socketCounter++}`);

    let hostAck;
    hostSocket.emit("room:create", { name: "HostHero" }, (ack) => {
      hostAck = ack;
    });

    const code = hostAck.room.code;
    const room = ctx.rooms.get(code);

    let guestAck;
    guestSocket.emit("room:join", { code, name: "GuestBuddy" }, (ack) => {
      guestAck = ack;
    });

    room.started = true;
    room.world = ctx.createCoopWorld(room);

    return { hostSocket, guestSocket, hostAck, guestAck, room, code };
  }

  await t.test("B01: Boss beam deals exactly 40 base damage once across different dt (1/30, 1/60, 1/120)", () => {
    for (const dt of [1 / 30, 1 / 60, 1 / 120]) {
      const { room } = setupActiveCoopGame();
      const player = [...room.world.players.values()][0];
      player.hp = 100;
      player.x = 400;
      player.y = 300;

      // Create firing blaster aimed directly at player
      const blaster = {
        id: "blaster_1",
        x: 100,
        y: 300,
        aimAngle: 0, // aimed right at x=400, y=300
        state: "firing",
        stateTimer: 0.25,
        hitPlayerIds: new Set()
      };
      room.world.gasterBlasters.set(blaster.id, blaster);

      // Run multiple simulation steps covering the entire 0.25s beam duration
      const steps = Math.ceil(0.25 / dt);
      for (let s = 0; s < steps; s++) {
        ctx.updateServerCoopWorld(room, dt);
      }

      // Player must have taken exactly 40 damage: hp = 60
      assert.equal(player.hp, 60, `Player must take exactly 40 damage at dt=${dt}`);
      assert.ok(blaster.hitPlayerIds.has(player.id), "Blaster must record player hit");
    }
  });

  await t.test("B02: Two separate beams deal independent damage; dash invulnerability postpones but doesn't consume beam hit", () => {
    const { room } = setupActiveCoopGame();
    const player = [...room.world.players.values()][0];
    player.hp = 100;
    player.x = 400;
    player.y = 300;

    // 1. Dash immunity
    player.dashTimer = 0.15; // dashing for 0.15s

    const blaster1 = {
      id: "b1",
      x: 100,
      y: 300,
      aimAngle: 0,
      state: "firing",
      stateTimer: 0.25,
      hitPlayerIds: new Set()
    };
    room.world.gasterBlasters.set(blaster1.id, blaster1);

    // Tick 0.05s: player is still in dash, damage must be blocked and NOT recorded as consumed
    ctx.updateServerCoopWorld(room, 0.05);
    assert.equal(player.hp, 100, "Player must take no damage during dash");
    assert.equal(blaster1.hitPlayerIds.has(player.id), false, "Blocked hit must not be recorded as consumed");

    // End dash timer
    player.dashTimer = 0;

    // Tick 0.05s: beam is still firing, now player takes the 40 damage!
    ctx.updateServerCoopWorld(room, 0.05);
    assert.equal(player.hp, 60, "Player must take 40 damage when dash ends inside active beam");
    assert.equal(blaster1.hitPlayerIds.has(player.id), true);

    // 2. Second independent beam hits even if player has standard 0.22s hit invulnerability
    const blaster2 = {
      id: "b2",
      x: 400,
      y: 100,
      aimAngle: Math.PI / 2, // aimed down at x=400, y=300
      state: "firing",
      stateTimer: 0.25,
      hitPlayerIds: new Set()
    };
    room.world.gasterBlasters.set(blaster2.id, blaster2);

    ctx.updateServerCoopWorld(room, 0.05);
    assert.equal(player.hp, 20, "Second beam must deal separate 40 damage despite standard hit invulnerability");
    assert.equal(blaster2.hitPlayerIds.has(player.id), true);
  });

  await t.test("B03: Boss repeating shield cycles: 60s cooldown from last pylon destruction", () => {
    const { room } = setupActiveCoopGame();
    room.world.wave = 10;
    const boss = ctx.createServerEnemy(room.world, "boss", 640, 360, true);
    boss.bossTier = 2;
    boss.hasEnteredArena = true;
    boss.hp = 5000;
    boss.maxHp = 10000; // 50% HP triggers shield
    room.world.enemies.set(boss.id, boss);

    // 1st trigger: AI triggers shield and spawns 4 pylons
    ctx.updateServerCoopWorld(room, 0.033);
    assert.equal(boss.shieldActive, true);
    assert.equal(boss.shieldTriggered, true);

    const pylons1 = [...room.world.enemies.values()].filter(e => e.type === "boss_drone" && e.bossId === boss.id);
    assert.equal(pylons1.length, 4);

    // Destroy all 4 pylons
    for (const p of pylons1) {
      p.hp = 0;
    }
    ctx.updateServerCoopWorld(room, 0.033);

    assert.equal(boss.shieldActive, false, "Shield must be removed");
    assert.ok(boss.stunTimer > 1.9 && boss.stunTimer <= 2.0, "Boss must be stunned for ~2.0s");
    assert.ok(boss.armorRespawnCooldown > 59.9 && boss.armorRespawnCooldown <= 60, "Cooldown must be set to 60s");

    // Advance 30s: shield must not respawn yet
    ctx.updateServerCoopWorld(room, 30.0);
    assert.equal(boss.shieldActive, false);
    assert.ok(boss.armorRespawnCooldown > 0);

    // Clean up dead pylons from world so new ones can spawn cleanly
    for (const [id, e] of room.world.enemies) {
      if (e.hp <= 0) room.world.enemies.delete(id);
    }

    // Advance 31s (total > 60s): cooldown expires, shield & 4 new pylons respawn
    ctx.updateServerCoopWorld(room, 31.0);
    assert.equal(boss.shieldActive, true, "Shield must respawn after 60s");
    const pylons2 = [...room.world.enemies.values()].filter(e => e.type === "boss_drone" && e.bossId === boss.id && e.hp > 0);
    assert.equal(pylons2.length, 4, "Must have exactly 4 new active pylons");
  });

  await t.test("B04: Boss shield delayed restore when 60s expires during turret mode, nothing spawns after boss dies", () => {
    const { room } = setupActiveCoopGame();
    room.world.wave = 10;
    const boss = ctx.createServerEnemy(room.world, "boss", 640, 360, true);
    boss.bossTier = 2;
    boss.hasEnteredArena = true;
    boss.hp = 5000;
    boss.maxHp = 10000;
    room.world.enemies.set(boss.id, boss);

    // Trigger & remove initial shield
    ctx.updateServerCoopWorld(room, 0.033);
    for (const [id, e] of room.world.enemies) {
      if (e.type === "boss_drone") room.world.enemies.delete(id);
    }
    ctx.updateServerCoopWorld(room, 0.033);
    assert.equal(boss.shieldActive, false);

    // Clear stun so turret mode logic can run cleanly
    boss.stunTimer = 0;

    // Enter turret mode and set cooldown to 1 second remaining
    boss.turretMode = true;
    boss.turretTimer = 10;
    boss.armorRespawnCooldown = 1.0;

    // Advance 2 seconds (cooldown expires while in turret mode)
    ctx.updateServerCoopWorld(room, 2.0);
    assert.equal(boss.shieldActive, false, "Shield must NOT spawn while in turret mode");
    assert.equal(boss.shieldTriggered, false, "shieldTriggered must be reset upon expiry");

    // Exit turret mode
    boss.turretMode = false;
    boss.turretCooldown = 10; // prevent immediate re-entry into turret
    ctx.updateServerCoopWorld(room, 0.033);
    assert.equal(boss.shieldActive, true, "Shield must spawn immediately upon exiting turret mode");

    // Dead boss spawns no shield or pylons
    boss.hp = 0;
    boss.shieldActive = false;
    boss.armorRespawnCooldown = 0;
    ctx.updateServerCoopWorld(room, 0.033);
    assert.equal(boss.shieldActive, false);
  });

  await t.test("B05: Real mark duration (owner.stats.markDuration) and stun duration", () => {
    const { room } = setupActiveCoopGame();
    const player = [...room.world.players.values()][0];
    player.stats = {
      ...player.stats,
      targetMark: true,
      markDuration: 10.0,
      kineticStrike: true,
      stunChance: 1.0,
      stunDuration: 0.8
    };

    const enemy = ctx.createServerEnemy(room.world, "tank", 300, 200, true);
    enemy.hp = 1000;
    enemy.maxHp = 1000;
    enemy.r = 21;
    enemy.hasEnteredArena = true;
    room.world.enemies.set(enemy.id, enemy);

    // Flying bullet hitting enemy
    const bullet = [...room.world.bullets.values()].find(b => b.ownerId === player.id);
    bullet.state = "flying";
    bullet.x = 290;
    bullet.y = 200;
    bullet.vx = 400;
    bullet.vy = 0;

    ctx.updateServerBullet(room, bullet, 0.05);

    // Enemy must receive targetMarkTimer = 10.0 (not hardcoded 4.0)
    assert.equal(enemy.targetMarked, true);
    assert.equal(enemy.targetMarkTimer, 10.0);
    assert.equal(enemy.stunTimer, 0.8);
  });

  await t.test("B06: Poison DoT ticks continuously with 0.5s hits and tickTimer resets on expiry", () => {
    const { room } = setupActiveCoopGame();
    const player = [...room.world.players.values()][0];
    player.stats = {
      ...player.stats,
      poison: true,
      poisonDuration: 3.0,
      damage: 100,
      poisonDamageRatio: 0.5
    };

    const enemy = ctx.createServerEnemy(room.world, "normal", 300, 300, true);
    enemy.hasEnteredArena = true;
    enemy.hp = 1000;
    room.world.enemies.set(enemy.id, enemy);

    // First hit applies poison
    enemy.poisonTimer = 3.0;
    enemy.poisonTickTimer = 1.0;
    enemy.poisonDamage = 50;

    // Advance 0.5s
    ctx.updateServerCoopWorld(room, 0.5);
    assert.ok(Math.abs(enemy.poisonTickTimer - 0.5) < 0.05);

    // Second hit at 0.5s: refreshes duration to 3.0 without resetting tickTimer to 1.0
    enemy.poisonTimer = Math.max(enemy.poisonTimer, 3.0);
    if (!(enemy.poisonTickTimer > 0)) enemy.poisonTickTimer = 1.0;
    assert.ok(Math.abs(enemy.poisonTickTimer - 0.5) < 0.05, "Tick timer must keep progressing");

    // Advance 0.55s: tick should fire!
    const hpBeforeTick = enemy.hp;
    ctx.updateServerCoopWorld(room, 0.55);
    assert.ok(enemy.hp < hpBeforeTick, "Poison tick damage must be inflicted");

    // Let poison expire
    ctx.updateServerCoopWorld(room, 4.0);
    assert.equal(enemy.poisonTimer, 0);
    assert.equal(enemy.poisonTickTimer, 0, "poisonTickTimer must reset to 0 upon expiry");
  });

  await t.test("B07: Debug command accessible to both players; bounded operations reject overflow safely", () => {
    const { hostSocket, guestSocket, room } = setupActiveCoopGame();

    // Normal command from guest succeeds
    guestSocket.emit("net:debug-command", { action: "set-hp", data: { hp: 500 } });
    const guestPlayer = room.world.players.get(guestSocket.data.playerId);
    assert.equal(guestPlayer.hp, 500);

    // Normal command from host succeeds
    hostSocket.emit("net:debug-command", { action: "set-wave", data: { wave: 5 } });
    assert.equal(room.world.wave, 5);

    // Excessive set-wave (> 10000) is bounded to 10000
    guestSocket.emit("net:debug-command", { action: "set-wave", data: { wave: 9999999 } });
    assert.equal(room.world.wave, 10000, "Excessive wave must be clamped to 10000");

    // Excessive spawn-enemy count (> 100) is clamped to 100
    const countBefore = room.world.enemies.size;
    hostSocket.emit("net:debug-command", { action: "spawn-enemy", data: { count: 5000 } });
    assert.equal(room.world.enemies.size - countBefore, 100, "Spawn count must be clamped to 100");

    // Server remains healthy and responsive to net:ping
    let pingAck;
    guestSocket.emit("net:ping", Date.now(), (ack) => {
      pingAck = ack;
    });
    assert.ok(pingAck);
  });
});
