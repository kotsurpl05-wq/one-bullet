const test = require("node:test");
const assert = require("node:assert/strict");
const { loadServerInstance } = require("./helpers/server_loader.js");

test("R3.1 - R3.3 Authorization & Difficulty Hardening Suite", async (t) => {
  const inst = loadServerInstance();
  const { ctx, cleanup, simulateSocketConnection } = inst;

  t.after(() => {
    cleanup();
  });

  let socketCounter = 1;
  function setupRoomWithSockets(roomCode = "AUTH01") {
    const hostSocket = simulateSocketConnection(`host_sock_${socketCounter++}`);
    const guestSocket = simulateSocketConnection(`guest_sock_${socketCounter++}`);

    // Create room via host
    let createAck;
    hostSocket.emit("room:create", { name: "HostAlice" }, (ack) => {
      createAck = ack;
    });

    const code = createAck?.code || createAck?.room?.code;
    const room = ctx.rooms.get(code);

    // Join room via guest
    let joinAck;
    guestSocket.emit("room:join", { code, name: "GuestBob" }, (ack) => {
      joinAck = ack;
    });

    return { hostSocket, guestSocket, room, code };
  }

  await t.test("1. room:restart vote: both players must vote to restart", () => {
    const { hostSocket, guestSocket, room } = setupRoomWithSockets("REST01");
    room.started = true;
    room.world = ctx.createCoopWorld(room);
    const originalWorld = room.world;

    // 1a. Guest votes for restart — not enough votes yet
    let guestAck;
    guestSocket.emit("room:restart", {}, (ack) => {
      guestAck = ack;
    });

    assert.equal(guestAck.success, true, "Guest vote must succeed");
    assert.equal(room.world, originalWorld, "World should NOT be recreated with 1 vote");

    // 1b. Host also votes — now restart happens
    let hostAck;
    hostSocket.emit("room:restart", {}, (ack) => {
      hostAck = ack;
    });

    assert.equal(hostAck.success, true, "Host vote must succeed");
    assert.notEqual(room.world, originalWorld, "World should be recreated after both voted");
    assert.equal(room.started, true);
  });

  await t.test("2. room:return-to-lobby authorization: guest rejected, host accepted", () => {
    const { hostSocket, guestSocket, room } = setupRoomWithSockets("LOBBY1");
    room.started = true;
    room.world = ctx.createCoopWorld(room);

    // 2a. Guest attempts return to lobby
    let guestAck;
    guestSocket.emit("room:return-to-lobby", {}, (ack) => {
      guestAck = ack;
    });

    assert.equal(guestAck.success, false, "Guest return-to-lobby must fail");
    assert.equal(guestAck.message, "Только хозяин может вернуть комнату в лобби");
    assert.equal(room.started, true, "Game must remain started");

    // 2b. Host attempts return to lobby
    let hostAck;
    hostSocket.emit("room:return-to-lobby", {}, (ack) => {
      hostAck = ack;
    });

    assert.equal(hostAck.success, true, "Host return-to-lobby must succeed");
    assert.equal(room.started, false, "Game state must become not started");
    assert.equal(room.world, null, "World must be reset to null");
  });

  await t.test("3. room:set-difficulty authorization: guest rejected", () => {
    const { hostSocket, guestSocket, room } = setupRoomWithSockets("DIFF01");

    let guestAck;
    guestSocket.emit("room:set-difficulty", { difficulty: "hard" }, (ack) => {
      guestAck = ack;
    });

    assert.equal(guestAck.success, false, "Guest cannot set difficulty");
    assert.equal(guestAck.message, "Только хозяин может менять сложность");
    assert.equal(room.difficulty, "normal", "Difficulty must remain unchanged");
  });

  await t.test("4. room:set-difficulty validation: rejected during active game", () => {
    const { hostSocket, room } = setupRoomWithSockets("DIFF02");
    room.started = true; // Active game

    let hostAck;
    hostSocket.emit("room:set-difficulty", { difficulty: "hard" }, (ack) => {
      hostAck = ack;
    });

    assert.equal(hostAck.success, false, "Cannot change difficulty during active game");
    assert.equal(hostAck.message, "Нельзя менять сложность во время игры");
    assert.equal(room.difficulty, "normal", "Difficulty must remain unchanged");
  });

  await t.test("5. room:set-difficulty validation: invalid string rejection", () => {
    const { hostSocket, room } = setupRoomWithSockets("DIFF03");

    const invalidValues = [
      "super-easy",
      "god-mode",
      "",
      null,
      undefined,
      123,
      {},
      "NORMAL",
      " hard",
      "easy\n"
    ];

    for (const val of invalidValues) {
      let ackResult;
      hostSocket.emit("room:set-difficulty", { difficulty: val }, (ack) => {
        ackResult = ack;
      });

      assert.equal(ackResult.success, false, `Difficulty '${val}' should be rejected`);
      assert.equal(ackResult.message, "Недопустимый уровень сложности");
      assert.equal(room.difficulty, "normal", "Difficulty should remain normal");
    }
  });

  await t.test("6. room:set-difficulty valid options: easy, normal, hard", () => {
    const { hostSocket, room } = setupRoomWithSockets("DIFF04");

    const validValues = ["easy", "hard", "normal"];

    for (const val of validValues) {
      let ackResult;
      hostSocket.emit("room:set-difficulty", { difficulty: val }, (ack) => {
        ackResult = ack;
      });

      assert.equal(ackResult.success, true, `Difficulty '${val}' should be accepted`);
      assert.equal(room.difficulty, val, `Room difficulty should update to '${val}'`);
    }
  });
});
