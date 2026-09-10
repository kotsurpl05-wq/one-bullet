const test = require("node:test");
const assert = require("node:assert/strict");
const { loadServerInstance } = require("./helpers/server_loader.js");

test("Room 2-Minute Reconnect Grace Period Suite", async (t) => {
  const inst = loadServerInstance();
  const { ctx, cleanup, simulateSocketConnection } = inst;

  t.after(() => {
    cleanup();
  });

  let socketCounter = 1;
  function setupActiveRoomGame() {
    const hostSocket = simulateSocketConnection(`host_sock_${socketCounter++}`);
    const guestSocket = simulateSocketConnection(`guest_sock_${socketCounter++}`);

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

    // Start active game
    room.started = true;
    room.world = ctx.createRoomWorld(room);

    return {
      hostSocket,
      guestSocket,
      hostAck,
      guestAck,
      room,
      code
    };
  }

  await t.test("1. room:create and room:join generate valid 16-hex reconnectToken", () => {
    const { hostAck, guestAck, room } = setupActiveRoomGame();

    assert.ok(hostAck.reconnectToken, "Host must receive reconnectToken");
    assert.equal(typeof hostAck.reconnectToken, "string");
    assert.equal(hostAck.reconnectToken.length, 16);

    assert.ok(guestAck.reconnectToken, "Guest must receive reconnectToken");
    assert.equal(typeof guestAck.reconnectToken, "string");
    assert.equal(guestAck.reconnectToken.length, 16);

    const hostPlayer = [...room.players.values()].find(p => p.role === "host");
    const guestPlayer = [...room.players.values()].find(p => p.role === "guest");

    assert.equal(hostPlayer.reconnectToken, hostAck.reconnectToken);
    assert.equal(guestPlayer.reconnectToken, guestAck.reconnectToken);
  });

  await t.test("2. Disconnecting during active game pauses world and sets 120s timeout without closing room", () => {
    const { guestSocket, room, code } = setupActiveRoomGame();

    // Guest disconnects
    guestSocket.emit("disconnect");

    // Room must still exist in memory!
    assert.ok(ctx.rooms.has(code), "Room must not be deleted upon player disconnect during match");
    assert.equal(room.started, true, "Game must remain in started state");
    assert.ok(room.world, "World state must be preserved");

    // Reconnect state must be active
    assert.ok(room.world.reconnectState, "reconnectState must be created");
    assert.equal(room.world.reconnectState.paused, true, "World must be paused");
    assert.equal(room.world.reconnectState.playerName, "GuestBuddy");
    assert.equal(room.world.reconnectState.role, "guest");
    assert.ok(room.reconnectTimeout !== null, "120s reconnectTimeout must be active");
  });

  await t.test("3. Successful reconnect waits for sync acknowledgement before countdown", () => {
    const { guestSocket, guestAck, room, code } = setupActiveRoomGame();

    // Guest disconnects
    guestSocket.emit("disconnect");
    assert.equal(room.world.reconnectState.paused, true);

    // Guest reconnects with new socket
    const newGuestSocket = simulateSocketConnection(`new_guest_sock_${socketCounter++}`);

    let reconnectAck;
    newGuestSocket.emit("room:reconnect", {
      code,
      token: guestAck.reconnectToken,
      name: "GuestBuddy"
    }, (ack) => {
      reconnectAck = ack;
    });

    assert.ok(reconnectAck, "Must receive reconnect acknowledgement");
    assert.equal(reconnectAck.success, true, "Reconnect must succeed");
    assert.equal(reconnectAck.role, "guest");
    assert.equal(reconnectAck.playerId, guestAck.playerId, "Stable player ID must survive reconnect");

    assert.equal(room.world.reconnectState?.syncing, true, "World must wait for the restored client to apply its full snapshot");
    assert.equal(room.world.unpauseCountdown, null, "Countdown must not start before sync acknowledgement");
    ctx.updateServerRoomWorld(room, 4);
    assert.equal(room.world.reconnectState?.syncing, true, "Simulation must remain paused even after the normal countdown duration");

    newGuestSocket.emit("net:sync-ack");
    assert.equal(room.players.get(guestAck.playerId).stateSynced, true);
    assert.equal(room.world.reconnectState?.unfreezing, true, "Sync acknowledgement starts the single resume countdown");
    assert.equal(room.world.unpauseCountdown, 3);
    assert.equal(room.reconnectTimeout, null, "reconnectTimeout must be cleared");

    assert.ok(room.world.players.has(guestAck.playerId), "World player keeps its stable ID");
    assert.equal(room.players.get(guestAck.playerId).socketId, newGuestSocket.id, "Transport binding must move to the new socket");
  });

  await t.test("4. Reconnect fails if token is invalid or room does not exist", () => {
    const { code } = setupActiveRoomGame();

    const strangerSocket = simulateSocketConnection(`stranger_sock_${socketCounter++}`);

    let failAck;
    strangerSocket.emit("room:reconnect", {
      code,
      token: "invalid_token_9999",
      name: "Stranger"
    }, (ack) => {
      failAck = ack;
    });

    assert.equal(failAck.success, false);
    assert.equal(failAck.message, "Недействительный токен переподключения");
  });

  await t.test("5. Remaining player can cancel waiting via room:cancel-reconnect-wait", () => {
    const { hostSocket, guestSocket, room, code } = setupActiveRoomGame();

    // Guest disconnects
    guestSocket.emit("disconnect");
    assert.ok(room.world.reconnectState);

    // Host decides not to wait 2 minutes
    let cancelAck;
    hostSocket.emit("room:cancel-reconnect-wait", {}, (ack) => {
      cancelAck = ack;
    });

    assert.equal(cancelAck.success, true);
    assert.equal(ctx.rooms.has(code), false, "Room must be closed after cancelling wait");
  });

  await t.test("6. repeated reconnect preserves identity, state and rejects the old transport", () => {
    const { guestSocket, guestAck, room, code } = setupActiveRoomGame();
    const playerId = guestAck.playerId;
    const worldPlayer = room.world.players.get(playerId);
    worldPlayer.hp = 37;
    const ownedBullet = [...room.world.bullets.values()].find(bullet => bullet.ownerId === playerId);

    guestSocket.emit("disconnect");
    const replacement = simulateSocketConnection(`replacement_${socketCounter++}`);
    let firstAck;
    replacement.emit("room:reconnect", { code, token: guestAck.reconnectToken }, ack => { firstAck = ack; });
    replacement.emit("net:sync-ack");

    assert.equal(firstAck.playerId, playerId);
    assert.equal(room.world.players.get(playerId), worldPlayer);
    assert.equal(worldPlayer.hp, 37);
    assert.equal(ownedBullet.ownerId, playerId);
    guestSocket.emit("disconnect");
    assert.equal(room.players.get(playerId).disconnected, false, "late disconnect from old socket is ignored");

    replacement.emit("disconnect");
    const replacement2 = simulateSocketConnection(`replacement_${socketCounter++}`);
    let secondAck;
    replacement2.emit("room:reconnect", { code, token: guestAck.reconnectToken }, ack => { secondAck = ack; });
    replacement2.emit("net:sync-ack");
    assert.equal(secondAck.playerId, playerId);
    assert.equal(room.players.size, 2);
    assert.equal(room.world.players.size, 2);
  });

  await t.test("7. one returning player cannot resume while the other is still missing", () => {
    const { hostSocket, guestSocket, hostAck, guestAck, room, code } = setupActiveRoomGame();
    hostSocket.emit("disconnect");
    guestSocket.emit("disconnect");

    const hostReplacement = simulateSocketConnection(`replacement_${socketCounter++}`);
    hostReplacement.emit("room:reconnect", { code, token: hostAck.reconnectToken }, () => {});
    hostReplacement.emit("net:sync-ack");
    assert.equal(room.world.reconnectState.paused, true);
    assert.deepEqual([...room.world.reconnectState.disconnectedIds], [guestAck.playerId]);

    const guestReplacement = simulateSocketConnection(`replacement_${socketCounter++}`);
    guestReplacement.emit("room:reconnect", { code, token: guestAck.reconnectToken }, () => {});
    assert.equal(room.world.reconnectState.syncing, true);
    assert.equal(room.world.unpauseCountdown, null);
    guestReplacement.emit("net:sync-ack");
    assert.equal(room.world.reconnectState.unfreezing, true);
    assert.equal(room.world.reconnectState.countdown, 3);
  });

  await t.test("8. room:join cannot claim a disconnected active slot without its token", () => {
    const { guestSocket, room, code } = setupActiveRoomGame();
    guestSocket.emit("disconnect");
    const stranger = simulateSocketConnection(`stranger_${socketCounter++}`);
    let ack;
    stranger.emit("room:join", { code, name: "GuestBuddy" }, result => { ack = result; });
    assert.equal(ack.success, false);
    assert.equal(room.players.size, 2);
  });

  await t.test("9. explicit room:leave is final and does not leave a reconnect ghost slot", () => {
    const { guestSocket, room, code } = setupActiveRoomGame();
    let ack;
    guestSocket.emit("room:leave", {}, result => { ack = result; });

    assert.equal(ack.success, true);
    assert.equal(ctx.rooms.has(code), false, "An explicit final leave closes the active two-player room");
    assert.equal(room.reconnectTimeout || null, null);
    for (const player of room.players.values()) {
      assert.equal(player.reconnectTimeout || null, null);
    }
  });
});
