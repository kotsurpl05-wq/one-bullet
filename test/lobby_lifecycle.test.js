const test = require("node:test");
const assert = require("node:assert/strict");
const { loadServerInstance } = require("./helpers/server_loader.js");

test("R3 Lobby & Game Lifecycle State Integrity Suite", async (t) => {
  const inst = loadServerInstance();
  const { ctx, cleanup, simulateSocketConnection } = inst;

  t.after(() => {
    cleanup();
  });

  let socketIdCounter = 100;

  await t.test("1. Room creation: assigns host role, sanitizes name, initializes lobby state", () => {
    const hostSocket = simulateSocketConnection(`host_${socketIdCounter++}`);
    let ackResult;
    hostSocket.emit("room:create", { name: "  HostMaster  " }, (ack) => {
      ackResult = ack;
    });

    assert.equal(ackResult.success, true);
    assert.equal(ackResult.role, "host");
    assert.equal(ackResult.playerId, hostSocket.id);

    const room = ctx.rooms.get(ackResult.room.code);
    assert.ok(room, "Room must be registered in server rooms Map");
    assert.equal(room.hostId, hostSocket.id);
    assert.equal(room.started, false);
    assert.equal(room.difficulty, "normal");
    assert.equal(room.players.size, 1);

    const hostPlayer = room.players.get(hostSocket.id);
    assert.equal(hostPlayer.name, "HostMaster", "Name must be trimmed");
    assert.equal(hostPlayer.role, "host");
    assert.equal(hostPlayer.ready, false, "Host initial readiness must be false");
  });

  await t.test("2. Room joining: assigns guest role, rejects joining non-existent room", () => {
    const hostSocket = simulateSocketConnection(`host_${socketIdCounter++}`);
    let createAck;
    hostSocket.emit("room:create", { name: "AlphaHost" }, (ack) => {
      createAck = ack;
    });
    const code = createAck.room.code;

    const guestSocket = simulateSocketConnection(`guest_${socketIdCounter++}`);
    let joinAck;
    guestSocket.emit("room:join", { code, name: "BetaGuest" }, (ack) => {
      joinAck = ack;
    });

    assert.equal(joinAck.success, true);
    assert.equal(joinAck.role, "guest");
    assert.equal(joinAck.playerId, guestSocket.id);

    const room = ctx.rooms.get(code);
    assert.equal(room.players.size, 2);
    const guestPlayer = room.players.get(guestSocket.id);
    assert.equal(guestPlayer.name, "BetaGuest");
    assert.equal(guestPlayer.role, "guest");
    assert.equal(guestPlayer.ready, false);

    // Test joining non-existent room
    const strangerSocket = simulateSocketConnection(`stranger_${socketIdCounter++}`);
    let failAck;
    strangerSocket.emit("room:join", { code: "NONEXIST", name: "Stranger" }, (ack) => {
      failAck = ack;
    });
    assert.equal(failAck.success, false);
    assert.equal(failAck.message, "Комната не найдена");
  });

  await t.test("3. Room capacity: rejects 3rd player from joining full room (max 2 players)", () => {
    const hostSocket = simulateSocketConnection(`host_${socketIdCounter++}`);
    let createAck;
    hostSocket.emit("room:create", { name: "Host3" }, (ack) => {
      createAck = ack;
    });
    const code = createAck.room.code;

    const guestSocket = simulateSocketConnection(`guest_${socketIdCounter++}`);
    guestSocket.emit("room:join", { code, name: "Guest3" });

    const thirdSocket = simulateSocketConnection(`third_${socketIdCounter++}`);
    let thirdAck;
    thirdSocket.emit("room:join", { code, name: "ThirdWheel" }, (ack) => {
      thirdAck = ack;
    });

    assert.equal(thirdAck.success, false);
    assert.equal(thirdAck.message, "Комната заполнена");

    const room = ctx.rooms.get(code);
    assert.equal(room.players.size, 2, "Room must retain exactly 2 players");
  });

  await t.test("4. Readiness toggling & 3s auto-start countdown lifecycle", async () => {
    const hostSocket = simulateSocketConnection(`host_${socketIdCounter++}`);
    let createAck;
    hostSocket.emit("room:create", { name: "HostReady" }, (ack) => {
      createAck = ack;
    });
    const code = createAck.room.code;
    const room = ctx.rooms.get(code);

    const guestSocket = simulateSocketConnection(`guest_${socketIdCounter++}`);
    guestSocket.emit("room:join", { code, name: "GuestReady" });

    // Host toggles ready = true
    let hostReadyAck;
    hostSocket.emit("room:ready", { ready: true }, (ack) => {
      hostReadyAck = ack;
    });
    assert.equal(hostReadyAck.success, true);
    assert.equal(hostReadyAck.ready, true);
    assert.equal(room.countdown, null, "Countdown should not start with only 1 player ready");

    // Guest toggles ready = true -> triggers countdown
    let guestReadyAck;
    guestSocket.emit("room:ready", { ready: true }, (ack) => {
      guestReadyAck = ack;
    });
    assert.equal(guestReadyAck.success, true);
    assert.equal(guestReadyAck.ready, true);
    assert.equal(room.countdown, 3, "Countdown should start at 3 seconds");
    assert.ok(room.countdownInterval !== null, "Countdown timer interval should be active");

    // Cancel countdown by guest toggling unready
    guestSocket.emit("room:ready", { ready: false });
    assert.equal(room.countdown, null, "Countdown should cancel when player unreadies");
    assert.equal(room.countdownInterval, null, "Countdown interval should be cleared");
  });

  await t.test("5. Disconnect handling: Host disconnect closes room; Guest disconnect cleans up guest", () => {
    // 5a. Guest leaves
    const host1 = simulateSocketConnection(`host_${socketIdCounter++}`);
    let c1;
    host1.emit("room:create", { name: "Host1" }, (ack) => { c1 = ack; });
    const guest1 = simulateSocketConnection(`guest_${socketIdCounter++}`);
    guest1.emit("room:join", { code: c1.room.code, name: "Guest1" });

    const room1 = ctx.rooms.get(c1.room.code);
    assert.equal(room1.players.size, 2);

    ctx.leaveRoom(guest1, "Guest disconnected");
    assert.equal(room1.players.size, 1);
    assert.ok(!room1.players.has(guest1.id));
    assert.ok(ctx.rooms.has(c1.room.code), "Room must still exist when guest leaves");

    // 5b. Host leaves
    ctx.leaveRoom(host1, "Host disconnected");
    assert.ok(!ctx.rooms.has(c1.room.code), "Room must be destroyed when host leaves");
  });

  await t.test("6. Input sanitization: names (length <= 18, fallback 'Игрок') and room codes (alphanumeric uppercase <= 6)", () => {
    // Name sanitization (server currently slices to 18 chars, falls back to "Игрок")
    assert.equal(ctx.sanitizeName("   "), "Игрок");
    assert.equal(ctx.sanitizeName(null), "Игрок");
    assert.equal(ctx.sanitizeName(""), "Игрок");
    assert.equal(ctx.sanitizeName("A".repeat(50)), "A".repeat(18), "Name must be truncated to 18 characters");
    assert.equal(ctx.sanitizeName("  ValidPlayer  "), "ValidPlayer");

    // Note: Empirical security observation: server does not strip HTML tags like <script>
    assert.equal(ctx.sanitizeName("<script>"), "<script>", "Server does not escape HTML brackets (Security gap)");

    // Code sanitization
    assert.equal(ctx.sanitizeCode("  ab-12_cd  "), "AB12CD");
    assert.equal(ctx.sanitizeCode("room#999!"), "ROOM99");
    assert.equal(ctx.sanitizeCode(""), "");
    assert.equal(ctx.sanitizeCode(null), "");
  });

  await t.test("7. Inactivity tracking & touchRoom timestamps", () => {
    const room = {
      code: "INACT1",
      lastActivity: 1000
    };

    const before = Date.now();
    ctx.touchRoom(room);
    assert.ok(room.lastActivity >= before, "touchRoom should update lastActivity to current timestamp");
  });
});
