// shared/index.js — single entry point for client bundle (esbuild)
// Server uses require("./shared/...") directly; client gets GameShared global.

const math = require("./math");
const constants = require("./constants");
const xp = require("./xp");
const enemyXp = require("./enemy-xp");
const playerStats = require("./player-stats");
const enemyFactory = require("./enemy-factory");
const upgrades = require("./upgrades");
const mirage = require("./mirage");

module.exports = {
  ...math,
  ...constants,
  ...xp,
  ...enemyXp,
  ...playerStats,
  ...enemyFactory,
  ...upgrades,
  ...mirage
};
