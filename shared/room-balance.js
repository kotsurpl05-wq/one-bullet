"use strict";

/*
 * Единый источник множителей забега. Число игроков фиксируется сервером
 * при старте комнаты, поэтому состав лобби не может изменить уже идущий бой.
 */
const ROOM_BALANCE_BY_PLAYER_COUNT = Object.freeze({
  1: Object.freeze({
    playerCount: 1,
    enemyCountMultiplier: 1,
    enemyHpMultiplier: 1,
    bossHpMultiplier: 0.5,
    bossUnitHpMultiplier: 0.5,
    experienceMultiplier: 1.5,
    maxWaveEnemies: 44
  }),
  2: Object.freeze({
    playerCount: 2,
    enemyCountMultiplier: 2,
    enemyHpMultiplier: 1,
    bossHpMultiplier: 1.1,
    bossUnitHpMultiplier: 1,
    experienceMultiplier: 1.7,
    maxWaveEnemies: 70
  })
});

const PRIMARY_BOSS_TYPES = new Set(["boss", "mini_boss"]);
const BOSS_UNIT_TYPES = new Set([
  ...PRIMARY_BOSS_TYPES,
  "boss_drone",
  "boss_pylon"
]);

function normalizeRoomPlayerCount(value) {
  const count = Number.isFinite(Number(value))
    ? Math.trunc(Number(value))
    : 1;
  return count >= 2 ? 2 : 1;
}

function getRoomBalance(playerCount) {
  return ROOM_BALANCE_BY_PLAYER_COUNT[normalizeRoomPlayerCount(playerCount)];
}

function getEnemyHpMultiplier(type, playerCount) {
  const balance = getRoomBalance(playerCount);
  if (PRIMARY_BOSS_TYPES.has(type)) return balance.bossHpMultiplier;
  if (BOSS_UNIT_TYPES.has(type)) return balance.bossUnitHpMultiplier;
  return balance.enemyHpMultiplier;
}

function scaleEnemyHp(baseHp, type, playerCount) {
  return Math.max(1, Math.round(Number(baseHp || 0) * getEnemyHpMultiplier(type, playerCount)));
}

function scaleEnemyCount(baseCount, playerCount, maximum) {
  const balance = getRoomBalance(playerCount);
  const cap = Number.isFinite(maximum) ? maximum : balance.maxWaveEnemies;
  return Math.max(0, Math.min(Math.round(Number(baseCount || 0) * balance.enemyCountMultiplier), cap));
}

function scaleExperience(baseExperience, playerCount) {
  const balance = getRoomBalance(playerCount);
  return Math.max(0, Math.round(Number(baseExperience || 0) * balance.experienceMultiplier));
}

module.exports = {
  ROOM_BALANCE_BY_PLAYER_COUNT,
  normalizeRoomPlayerCount,
  getRoomBalance,
  getEnemyHpMultiplier,
  scaleEnemyHp,
  scaleEnemyCount,
  scaleExperience
};
