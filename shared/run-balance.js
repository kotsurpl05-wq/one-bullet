"use strict";

/*
 * Единый источник множителей забега. Число игроков фиксируется сервером
 * при старте комнаты, поэтому состав лобби не может изменить уже идущий бой.
 */
const RUN_BALANCE_BY_PLAYER_COUNT = Object.freeze({
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

function normalizeRunPlayerCount(value) {
  const count = Number.isFinite(Number(value))
    ? Math.trunc(Number(value))
    : 1;
  return count >= 2 ? 2 : 1;
}

function getRunBalance(playerCount) {
  return RUN_BALANCE_BY_PLAYER_COUNT[normalizeRunPlayerCount(playerCount)];
}

function getEnemyHpMultiplier(type, playerCount) {
  const balance = getRunBalance(playerCount);
  if (PRIMARY_BOSS_TYPES.has(type)) return balance.bossHpMultiplier;
  if (BOSS_UNIT_TYPES.has(type)) return balance.bossUnitHpMultiplier;
  return balance.enemyHpMultiplier;
}

function scaleEnemyHp(baseHp, type, playerCount) {
  return Math.max(1, Math.round(Number(baseHp || 0) * getEnemyHpMultiplier(type, playerCount)));
}

function scaleEnemyCount(baseCount, playerCount, maximum) {
  const balance = getRunBalance(playerCount);
  const cap = Number.isFinite(maximum) ? maximum : balance.maxWaveEnemies;
  return Math.max(0, Math.min(Math.round(Number(baseCount || 0) * balance.enemyCountMultiplier), cap));
}

function scaleExperience(baseExperience, playerCount) {
  const balance = getRunBalance(playerCount);
  return Math.max(0, Math.round(Number(baseExperience || 0) * balance.experienceMultiplier));
}

module.exports = {
  RUN_BALANCE_BY_PLAYER_COUNT,
  normalizeRunPlayerCount,
  getRunBalance,
  getEnemyHpMultiplier,
  scaleEnemyHp,
  scaleEnemyCount,
  scaleExperience
};
