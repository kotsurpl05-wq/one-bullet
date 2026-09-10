"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("room lobby displays the effective run profile", () => {
  const html = fs.readFileSync(
    path.resolve(__dirname, "../public/index.html"),
    "utf8"
  );
  const lobbyStart = html.indexOf("function renderRoomLobby()");
  const lobbyEnd = html.indexOf("let roomSelectedUpgradeIndex", lobbyStart);
  const lobby = html.slice(lobbyStart, lobbyEnd);

  assert.ok(lobbyStart >= 0 && lobbyEnd > lobbyStart);
  assert.match(lobby, /GameShared\.getRoomBalance\(roomPlayerCount\)/);
  assert.match(lobby, /roomBalance\.experienceMultiplier/);
  assert.match(lobby, /roomBalance\.bossHpMultiplier/);
  assert.match(lobby, /roomBalance\.bossUnitHpMultiplier/);
  assert.match(lobby, /roomBalance\.maxWaveEnemies/);
  assert.match(lobby, /roomBalance\.enemyCountMultiplier \* roomDifficulty\.enemyCount/);

  for (const label of [
    "Параметры забега",
    "Игроки",
    "Здоровье игрока",
    "Количество врагов",
    "Скорость врагов",
    "HP обычных врагов",
    "HP босса",
    "HP пилонов",
    "Получаемый опыт",
    "Предел врагов",
    "Множитель очков"
  ]) {
    assert.match(lobby, new RegExp(label));
  }
});
