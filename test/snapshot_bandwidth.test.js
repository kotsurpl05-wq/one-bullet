const test = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("node:zlib");
const fs = require("node:fs");
const path = require("node:path");
const { loadServerInstance } = require("./helpers/server_loader.js");
const { createTestWorld } = require("./helpers/test_utils.js");

/*
 * Снапшот врагов — ~90% исходящего трафика кооп-режима.
 * При 20 Гц и двух игроках лишние 400 байт на врага
 * превращаются в сотни мегабайт в час и выжигают
 * бесплатные лимиты хостинга. Эти тесты фиксируют
 * компактный формат, чтобы регрессия протокола падала
 * здесь, а не на счётчике трафика.
 */

function deflatedSize(value) {
  return zlib.deflateSync(Buffer.from(JSON.stringify(value))).length;
}

function buildSteadyStateWorld(ctx) {
  const { room, world } = createTestWorld(ctx);
  world.wave = 12;
  ctx.spawnServerWave(world);

  // Штатное состояние боя: враги уже вошли в арену.
  for (const enemy of world.enemies.values()) {
    enemy.hasEnteredArena = true;
    enemy.spawnDelay = 0;
  }

  return { room, world };
}

test("Co-op snapshot bandwidth contract", async t => {
  const { ctx, cleanup } = loadServerInstance();

  try {
    await t.test("Steady-state enemy carries only mutable state", () => {
      const { room, world } = buildSteadyStateWorld(ctx);

      // Первый снапшот расходует статику, второй — штатный.
      ctx.createServerCoopSnapshot(room);
      const steady = ctx.createServerCoopSnapshot(room);

      const enemy = steady.enemies[0];
      assert.ok(enemy, "Snapshot must contain enemies");

      const keys = Object.keys(enemy).sort();
      const allowed = new Set([
        "id", "x", "y", "hp", "entered",
        "isCharging", "stunTimer", "targetMarked",
        "poisoned", "parasiteInfested",
        "isPhased", "twinPartnerId", "isEnraged",
        "chargeState", "chargeDx", "chargeDy",
        "chargeProgress", "coolingProgress",
        "sporesCount", "bossId"
      ]);

      for (const key of keys) {
        assert.ok(
          allowed.has(key),
          `Steady-state enemy must not carry "${key}" — it is static or unused by the client`
        );
      }

      for (const staticKey of ["r", "maxHp", "color", "type"]) {
        assert.ok(
          !(staticKey in enemy),
          `Static field "${staticKey}" must not repeat in steady-state snapshots`
        );
      }

      for (const spawnKey of ["spawnEdge", "spawnWarningX", "spawnWarningY", "spawnDelay"]) {
        assert.ok(
          !(spawnKey in enemy),
          `Spawn-warning field "${spawnKey}" must be omitted once the enemy entered the arena`
        );
      }
    });

    await t.test("Fields the client never reads are absent entirely", () => {
      const { room } = buildSteadyStateWorld(ctx);
      const snapshot = ctx.createServerCoopSnapshot(room, { full: true });

      // Эти поля не читаются в applyCoopSnapshot.
      const deadFields = [
        "dashState", "dashTimer",
        "sniperState", "sniperTargetX", "sniperTargetY",
        "shieldActive", "phase"
      ];

      for (const enemy of snapshot.enemies) {
        for (const field of deadFields) {
          assert.ok(
            !(field in enemy),
            `Enemy must not serialize "${field}" — the client ignores it`
          );
        }
      }
    });

    await t.test("First snapshot of an enemy carries the static fields", () => {
      const { room } = buildSteadyStateWorld(ctx);
      const first = ctx.createServerCoopSnapshot(room);

      const enemy = first.enemies[0];
      for (const staticKey of ["type", "r", "maxHp", "color"]) {
        assert.ok(
          staticKey in enemy,
          `First snapshot must include static field "${staticKey}" so the client can cache it`
        );
      }
    });

    await t.test("full:true resends static fields for clients rebuilding from scratch", () => {
      const { room } = buildSteadyStateWorld(ctx);

      // Статика израсходована обычной рассылкой.
      ctx.createServerCoopSnapshot(room);
      const delta = ctx.createServerCoopSnapshot(room);
      assert.ok(
        !("color" in delta.enemies[0]),
        "Delta snapshot should have dropped static fields"
      );

      // Переподключившийся игрок обязан получить их снова.
      const full = ctx.createServerCoopSnapshot(room, { full: true });
      for (const staticKey of ["type", "r", "maxHp", "color"]) {
        assert.ok(
          staticKey in full.enemies[0],
          `full:true must resend "${staticKey}" for reconnecting clients`
        );
      }
    });

    await t.test("Pre-arena enemies still carry spawn-warning data", () => {
      const { room, world } = createTestWorld(ctx);
      world.wave = 12;
      ctx.spawnServerWave(world);

      const waiting = [...world.enemies.values()].find(e => !e.hasEnteredArena);
      assert.ok(waiting, "Wave should contain enemies still outside the arena");

      const snapshot = ctx.createServerCoopSnapshot(room, { full: true });
      const serialized = snapshot.enemies.find(e => e.id === waiting.id);

      assert.ok(serialized, "Waiting enemy must be serialized");
      assert.ok(
        "spawnEdge" in serialized,
        "Pre-arena enemy needs spawnEdge so the client can draw the warning"
      );
      assert.ok(
        Number.isFinite(serialized.spawnWarningX),
        "Pre-arena enemy needs spawnWarningX"
      );
      assert.ok(
        !("entered" in serialized),
        "Pre-arena enemy must not be flagged as entered"
      );
    });

    await t.test("Steady-state snapshot stays under the bandwidth budget", () => {
      const { room, world } = buildSteadyStateWorld(ctx);
      ctx.createServerCoopSnapshot(room);
      const steady = ctx.createServerCoopSnapshot(room);

      const size = deflatedSize(steady);
      const enemyCount = world.enemies.size;

      /*
       * Бюджет: 1600 B на сжатый снапшот при ~48 врагах.
       * До оптимизации было ~2400 B, что давало 330 МБ/ч
       * на двоих. Порог с запасом, но ловит возврат
       * статики или мёртвых полей в горячий путь.
       */
      assert.ok(
        size < 1600,
        `Steady-state snapshot is ${size} B with ${enemyCount} enemies — budget is 1600 B`
      );

      const bytesPerSecond = size * 20;
      const megabytesPerHourTwoPlayers = bytesPerSecond * 2 * 3600 / 1024 / 1024;

      assert.ok(
        megabytesPerHourTwoPlayers < 220,
        `Projected ${megabytesPerHourTwoPlayers.toFixed(0)} MB/h for 2 players — budget is 220 MB/h`
      );
    });

    await t.test("Client restores omitted static fields instead of overwriting cache", () => {
      const html = fs.readFileSync(
        path.resolve(process.cwd(), "public/index.html"),
        "utf8"
      );

      // Статика должна иметь фолбэк на кешированное значение.
      assert.ok(
        /coopEnemy\.color\s*=\s*\n?\s*snapshotEnemy\.color\s*\|\|\s*\n?\s*coopEnemy\.color/.test(html),
        "Client must fall back to the cached color when the field is omitted"
      );
      assert.ok(
        /coopEnemy\.type\s*=\s*\n?\s*snapshotEnemy\.type\s*\|\|\s*\n?\s*coopEnemy\.type/.test(html),
        "Client must fall back to the cached type when the field is omitted"
      );

      // spawnEdge нельзя безусловно сбрасывать в null.
      assert.ok(
        !/coopEnemy\.spawnEdge\s*=\s*\n?\s*snapshotEnemy\.spawnEdge\s*\|\|\s*\n?\s*null/.test(html),
        "Client must not reset spawnEdge to null when the field is omitted"
      );

      // Вход в арену передаётся флагом entered.
      assert.ok(
        /snapshotEnemy\.entered/.test(html),
        "Client must read the compact 'entered' flag"
      );
    });
  } finally {
    cleanup();
  }
});
