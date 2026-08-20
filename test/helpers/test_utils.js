function createTestRoom(ctx, { code = "TEST01", hostId = "p1", guestId = "p2", difficulty = "normal" } = {}) {
  const room = {
    code,
    hostId,
    difficulty,
    started: false,
    players: new Map([
      [hostId, { id: hostId, name: "Alice", role: "host", ready: true }],
      ...(guestId ? [[guestId, { id: guestId, name: "Bob", role: "guest", ready: true }]] : [])
    ]),
    createdAt: Date.now(),
    lastActivity: Date.now(),
    world: null,
    countdown: null,
    countdownInterval: null
  };
  return room;
}

function createTestWorld(ctx, options = {}) {
  const room = createTestRoom(ctx, options);
  const world = ctx.createCoopWorld(room);
  room.world = world;
  world.enemies.clear(); // Clear initial wave for controlled tests
  world.experienceCrystals.clear();
  return {
    room,
    world,
    player1: world.players.get(options.hostId || "p1"),
    player2: options.guestId !== null ? world.players.get(options.guestId || "p2") : null
  };
}

module.exports = {
  createTestRoom,
  createTestWorld
};
