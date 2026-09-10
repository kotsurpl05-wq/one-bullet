const test = require("node:test");
const assert = require("node:assert/strict");
const { loadServerInstance } = require("./helpers/server_loader.js");
const {
  getRoomBalance,
  scaleEnemyHp,
  scaleEnemyCount,
  scaleExperience
} = require("../shared/room-balance");
const { createEnemyBase } = require("../shared/enemy-factory");

function emitAck(socket, event, payload = {}) {
  let response;
  socket.emit(event, payload, ack => { response = ack; });
  return response;
}

test("Unified 1-2 player room mode", async t => {
  const inst = loadServerInstance();
  const { ctx, cleanup, simulateSocketConnection } = inst;
  t.after(cleanup);

  await t.test("common balance math is deterministic for one and two players", () => {
    assert.deepEqual(
      JSON.parse(JSON.stringify(getRoomBalance(1))),
      {
        playerCount: 1,
        enemyCountMultiplier: 1,
        enemyHpMultiplier: 1,
        bossHpMultiplier: 0.5,
        bossUnitHpMultiplier: 0.5,
        experienceMultiplier: 1.5,
        maxWaveEnemies: 44
      }
    );
    assert.equal(getRoomBalance(2).enemyCountMultiplier, 2);
    assert.equal(getRoomBalance(2).bossHpMultiplier, 1.1);
    assert.equal(getRoomBalance(2).experienceMultiplier, 1.7);
    assert.equal(scaleEnemyHp(100, "boss", 1), 50);
    assert.equal(scaleEnemyHp(100, "boss_pylon", 1), 50);
    assert.equal(scaleEnemyHp(100, "boss_pylon", 2), 100);
    assert.equal(scaleEnemyCount(10, 1), 10);
    assert.equal(scaleEnemyCount(10, 2), 20);
    assert.equal(scaleExperience(125, 1), 188);
    assert.equal(scaleExperience(125, 2), 213);
  });

  await t.test("a host can launch a one-player room through the same ready countdown", async () => {
    const host = simulateSocketConnection("unified_solo_host");
    const created = emitAck(host, "room:create", { name: "SoloHost" });
    const room = ctx.rooms.get(created.room.code);

    const ready = emitAck(host, "room:ready", { ready: true });
    assert.equal(ready.success, true);
    assert.equal(room.countdown, 3);
    assert.equal(ctx.canStartRoom(room), true);

    await new Promise(resolve => setTimeout(resolve, 3150));

    assert.equal(room.started, true);
    assert.equal(room.world.players.size, 1);
    assert.equal(room.world.playerCount, 1);
    assert.equal(room.world.balance.playerCount, 1);
    assert.equal(room.world.players.get(created.playerId).name, "SoloHost");

    room.world.wave = 5;
    const bossBase = createEnemyBase("boss", room.world.wave);
    const pylonBase = createEnemyBase("boss_pylon", room.world.wave);
    const boss = ctx.createServerEnemy(room.world, "boss", 400, 300, true);
    const pylon = ctx.createServerEnemy(room.world, "boss_pylon", 450, 300, true);
    assert.equal(boss.maxHp, scaleEnemyHp(bossBase.hp, "boss", 1));
    assert.equal(pylon.maxHp, scaleEnemyHp(pylonBase.hp, "boss_pylon", 1));

    room.world.enemies.clear();
    room.world.enemies.set(boss.id, boss);
    ctx.spawnServerBossDrones(room.world, boss);
    const shieldPylons = [...room.world.enemies.values()].filter(enemy => enemy.type === "boss_drone");
    assert.equal(shieldPylons.length, 4);
    const droneBase = createEnemyBase("boss_drone", room.world.wave);
    assert.ok(shieldPylons.every(enemy => enemy.maxHp === scaleEnemyHp(droneBase.hp, "boss_drone", 1)));

    room.world.enemies.clear();
    room.world.wave = 1;
    ctx.spawnServerWave(room.world);
    assert.equal(room.world.enemies.size, 7);

    room.world.enemies.clear();
    room.world.experienceCrystals.clear();
    const normal = ctx.createServerEnemy(room.world, "normal", 300, 300, true);
    room.world.enemies.set(normal.id, normal);
    ctx.killServerEnemy(room.world, normal, room.world.players.get(created.playerId));
    assert.equal([...room.world.experienceCrystals.values()][0].value, scaleExperience(125, 1));
  });

  await t.test("joining during a solo countdown cancels it until the full party is ready", () => {
    const host = simulateSocketConnection("countdown_host");
    const created = emitAck(host, "room:create", { name: "Host" });
    const room = ctx.rooms.get(created.room.code);
    emitAck(host, "room:ready", { ready: true });
    assert.equal(room.countdown, 3);

    const guest = simulateSocketConnection("countdown_guest");
    const joined = emitAck(guest, "room:join", { code: room.code, name: "Guest" });
    assert.equal(joined.success, true);
    assert.equal(room.countdown, null);
    assert.equal(room.countdownInterval, null);
    assert.equal(ctx.canStartRoom(room), false);

    emitAck(guest, "room:ready", { ready: true });
    assert.equal(room.countdown, 3);
    ctx.cancelRoomCountdown(room);
  });

  await t.test("two-player room freezes the two-player profile when it starts", () => {
    const host = simulateSocketConnection("unified_duo_host");
    const created = emitAck(host, "room:create", { name: "Host" });
    const guest = simulateSocketConnection("unified_duo_guest");
    emitAck(guest, "room:join", { code: created.room.code, name: "Guest" });

    const started = emitAck(host, "room:start", { difficulty: "normal" });
    const room = ctx.rooms.get(created.room.code);
    assert.equal(started.success, true);
    assert.equal(room.world.players.size, 2);
    assert.equal(room.world.playerCount, 2);
    assert.equal(room.world.balance.enemyCountMultiplier, 2);
    assert.equal(room.world.balance.bossHpMultiplier, 1.1);

    room.world.wave = 5;
    const base = createEnemyBase("boss", room.world.wave);
    const boss = ctx.createServerEnemy(room.world, "boss", 400, 300, true);
    assert.equal(boss.maxHp, scaleEnemyHp(base.hp, "boss", 2));

    room.world.enemies.clear();
    room.world.wave = 1;
    ctx.spawnServerWave(room.world);
    assert.equal(room.world.enemies.size, 14);

    room.world.enemies.clear();
    room.world.experienceCrystals.clear();
    const normal = ctx.createServerEnemy(room.world, "normal", 300, 300, true);
    room.world.enemies.set(normal.id, normal);
    ctx.killServerEnemy(room.world, normal, room.world.players.get(created.playerId));
    assert.equal([...room.world.experienceCrystals.values()][0].value, scaleExperience(125, 2));
  });
});
