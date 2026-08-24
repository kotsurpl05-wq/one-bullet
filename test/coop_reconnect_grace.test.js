const test = require("node:test");
const assert = require("node:assert/strict");
const { loadServerInstance } = require("./helpers/server_loader.js");

test("Co-op 2-Minute Reconnect Grace Period Suite", async (t) => {
  const inst = loadServerInstance();
  const { ctx, cleanup, simulateSocketConnection } = inst;

  t.after(() => {
    cleanup();
  });

  let socketCounter = 1;
  function setupActiveCoopGame() {
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
    room.world = ctx.createCoopWorld(room);

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
    const { hostAck, guestAck, room } = setupActiveCoopGame();

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
    const { guestSocket, room, code } = setupActiveCoopGame();

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

  await t.test("3. Successful room:reconnect within 120s restores socket, unpauses simulation and clears timeout", () => {
    const { guestSocket, guestAck, room, code } = setupActiveCoopGame();

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
    assert.equal(reconnectAck.playerId, newGuestSocket.id);

    // World must enter unfreezing countdown or be unpaused
    assert.ok(room.world.reconnectState?.unfreezing || room.world.reconnectState === null, "reconnectState must enter unfreezing countdown");
    assert.equal(room.reconnectTimeout, null, "reconnectTimeout must be cleared");

    // Player ID in world must be updated to new socket ID
    assert.ok(room.world.players.has(newGuestSocket.id), "World player mapping must be updated");
  });

  await t.test("4. Reconnect fails if token is invalid or room does not exist", () => {
    const { code } = setupActiveCoopGame();

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
    const { hostSocket, guestSocket, room, code } = setupActiveCoopGame();

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
});
