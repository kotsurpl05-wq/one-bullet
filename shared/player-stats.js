// shared/player-stats.js — base player stats (intersection of server and client)

const { PLAYER_SPEED, BULLET_SPEED, BULLET_RADIUS, BULLET_BOUNCES } = require("./constants");

function createPlayerStats() {
  return {
    playerSpeed: PLAYER_SPEED,
    bulletSpeed: BULLET_SPEED,
    bulletRadius: BULLET_RADIUS,
    damage: 100,
    critChance: 0,
    maxBounces: BULLET_BOUNCES,
    pierce: 0,
    groundPullSpeed: 0,
    pickupRadius: 0,
    magazineSize: 1,
    dash: false,
    dashDistance: 0,
    dashCooldownBase: 0,
    dashDamage: false
  };
}

module.exports = { createPlayerStats };
