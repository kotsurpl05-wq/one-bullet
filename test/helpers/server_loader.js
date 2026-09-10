const fs = require("fs");
const path = require("path");
const vm = require("vm");
const http = require("http");
const EventEmitter = require("events");

function createMockSocket(id, data = {}) {
  const socket = new EventEmitter();
  socket.id = id;
  socket.data = { ...data };
  socket.rooms = new Set([id]);
  socket.join = (roomCode) => {
    socket.rooms.add(roomCode);
  };
  socket.leave = (roomCode) => {
    socket.rooms.delete(roomCode);
  };
  socket.emitted = [];
  socket.emit = (event, ...args) => {
    socket.emitted.push({ event, args });
    return EventEmitter.prototype.emit.call(socket, event, ...args);
  };
  socket.volatile = {
    emit: (event, ...args) => {
      socket.emitted.push({ event, args, volatile: true });
      return true;
    }
  };
  return socket;
}

function loadServerInstance() {
  const serverPath = path.resolve(__dirname, "../../server.js");
  let code = fs.readFileSync(serverPath, "utf8");

  // Expose top-level lexical variables on global context
  code += `
  ;if (typeof rooms !== 'undefined') this.rooms = rooms;
  if (typeof io !== 'undefined') this.io = io;
  if (typeof server !== 'undefined') this.server = server;
  if (typeof app !== 'undefined') this.app = app;
  if (typeof ROOM_SHOOT_MAX_POSITION_DRIFT !== 'undefined') this.ROOM_SHOOT_MAX_POSITION_DRIFT = ROOM_SHOOT_MAX_POSITION_DRIFT;
  if (typeof ROOM_REPAIR_HEAL_COOLDOWN !== 'undefined') this.ROOM_REPAIR_HEAL_COOLDOWN = ROOM_REPAIR_HEAL_COOLDOWN;
  if (typeof ROOM_WORLD_WIDTH !== 'undefined') this.ROOM_WORLD_WIDTH = ROOM_WORLD_WIDTH;
  if (typeof ROOM_WORLD_HEIGHT !== 'undefined') this.ROOM_WORLD_HEIGHT = ROOM_WORLD_HEIGHT;
  if (typeof ROOM_INACTIVITY_TIMEOUT_MS !== 'undefined') this.ROOM_INACTIVITY_TIMEOUT_MS = ROOM_INACTIVITY_TIMEOUT_MS;
  if (typeof ROOM_ENEMY_HP_MULTIPLIER !== 'undefined') this.ROOM_ENEMY_HP_MULTIPLIER = ROOM_ENEMY_HP_MULTIPLIER;
  if (typeof ROOM_BOSS_HP_MULTIPLIER !== 'undefined') this.ROOM_BOSS_HP_MULTIPLIER = ROOM_BOSS_HP_MULTIPLIER;
  if (typeof ROOM_BULLET_SPEED !== 'undefined') this.ROOM_BULLET_SPEED = ROOM_BULLET_SPEED;
  if (typeof ROOM_BULLET_RADIUS !== 'undefined') this.ROOM_BULLET_RADIUS = ROOM_BULLET_RADIUS;
  if (typeof ROOM_BULLET_BOUNCES !== 'undefined') this.ROOM_BULLET_BOUNCES = ROOM_BULLET_BOUNCES;
  if (typeof ROOM_CRYSTAL_RADIUS !== 'undefined') this.ROOM_CRYSTAL_RADIUS = ROOM_CRYSTAL_RADIUS;
  if (typeof createRoomWorld !== 'undefined') this.createRoomWorld = createRoomWorld;
  if (typeof createServerRoomPlayer !== 'undefined') this.createServerRoomPlayer = createServerRoomPlayer;
  if (typeof createServerBullet !== 'undefined') this.createServerBullet = createServerBullet;
  if (typeof createServerEnemy !== 'undefined') this.createServerEnemy = createServerEnemy;
  if (typeof damageServerEnemy !== 'undefined') this.damageServerEnemy = damageServerEnemy;
  if (typeof killServerEnemy !== 'undefined') this.killServerEnemy = killServerEnemy;
  if (typeof catchServerBullet !== 'undefined') this.catchServerBullet = catchServerBullet;
  if (typeof dropServerBullet !== 'undefined') this.dropServerBullet = dropServerBullet;
  if (typeof shootServerBullet !== 'undefined') this.shootServerBullet = shootServerBullet;
  if (typeof updateServerBullet !== 'undefined') this.updateServerBullet = updateServerBullet;
  if (typeof updateServerRoomWorld !== 'undefined') this.updateServerRoomWorld = updateServerRoomWorld;
  if (typeof applyServerUpgrade !== 'undefined') this.applyServerUpgrade = applyServerUpgrade;
  if (typeof sanitizeName !== 'undefined') this.sanitizeName = sanitizeName;
  if (typeof sanitizeCode !== 'undefined') this.sanitizeCode = sanitizeCode;
  if (typeof generateRoomCode !== 'undefined') this.generateRoomCode = generateRoomCode;
  if (typeof startRoomCountdown !== 'undefined') this.startRoomCountdown = startRoomCountdown;
  if (typeof canStartRoom !== 'undefined') this.canStartRoom = canStartRoom;
  if (typeof cancelRoomCountdown !== 'undefined') this.cancelRoomCountdown = cancelRoomCountdown;
  if (typeof touchRoom !== 'undefined') this.touchRoom = touchRoom;
  if (typeof closeRoom !== 'undefined') this.closeRoom = closeRoom;
  if (typeof leaveRoom !== 'undefined') this.leaveRoom = leaveRoom;
  if (typeof getRoomForSocket !== 'undefined') this.getRoomForSocket = getRoomForSocket;
  if (typeof getPublicRoomState !== 'undefined') this.getPublicRoomState = getPublicRoomState;
  if (typeof shootServerBossRadial !== 'undefined') this.shootServerBossRadial = shootServerBossRadial;
  if (typeof shootServerBossShockwave !== 'undefined') this.shootServerBossShockwave = shootServerBossShockwave;
  if (typeof shootServerBossSniperBolt !== 'undefined') this.shootServerBossSniperBolt = shootServerBossSniperBolt;
  if (typeof spawnServerBossDrones !== 'undefined') this.spawnServerBossDrones = spawnServerBossDrones;
  if (typeof refreshServerBulletContacts !== 'undefined') this.refreshServerBulletContacts = refreshServerBulletContacts;
  if (typeof getServerExperienceRequirement !== 'undefined') this.getServerExperienceRequirement = getServerExperienceRequirement;
  if (typeof getServerEnemyExperience !== 'undefined') this.getServerEnemyExperience = getServerEnemyExperience;
  if (typeof addServerExperience !== 'undefined') this.addServerExperience = addServerExperience;
  if (typeof SERVER_UPGRADES !== 'undefined') this.SERVER_UPGRADES = SERVER_UPGRADES;
  if (typeof SERVER_UPGRADE_RARITIES !== 'undefined') this.SERVER_UPGRADE_RARITIES = SERVER_UPGRADE_RARITIES;
  if (typeof rollServerUpgradeRarity !== 'undefined') this.rollServerUpgradeRarity = rollServerUpgradeRarity;
  if (typeof createServerUpgradeOffers !== 'undefined') this.createServerUpgradeOffers = createServerUpgradeOffers;
  if (typeof reviveServerPlayers !== 'undefined') this.reviveServerPlayers = reviveServerPlayers;
  if (typeof getPlayerSpawnPosition !== 'undefined') this.getPlayerSpawnPosition = getPlayerSpawnPosition;
  if (typeof getServerPlayerSpawnPosition !== 'undefined') this.getServerPlayerSpawnPosition = getServerPlayerSpawnPosition;
  if (typeof damageServerPlayer !== 'undefined') this.damageServerPlayer = damageServerPlayer;
  if (typeof createServerRoomSnapshot !== 'undefined') this.createServerRoomSnapshot = createServerRoomSnapshot;
  if (typeof advanceFullSnapshotClock !== 'undefined') this.advanceFullSnapshotClock = advanceFullSnapshotClock;
  if (typeof ROOM_FULL_SNAPSHOT_INTERVAL !== 'undefined') this.ROOM_FULL_SNAPSHOT_INTERVAL = ROOM_FULL_SNAPSHOT_INTERVAL;
  if (typeof updateServerWave !== 'undefined') this.updateServerWave = updateServerWave;
  if (typeof spawnServerWave !== 'undefined') this.spawnServerWave = spawnServerWave;
  if (typeof ROOM_EXPERIENCE_MULTIPLIER !== 'undefined') this.ROOM_EXPERIENCE_MULTIPLIER = ROOM_EXPERIENCE_MULTIPLIER;
  if (typeof startServerUpgradeRound !== 'undefined') this.startServerUpgradeRound = startServerUpgradeRound;
  if (typeof submitServerUpgradeChoice !== 'undefined') this.submitServerUpgradeChoice = submitServerUpgradeChoice;
  if (typeof reviveServerPlayers !== 'undefined') this.reviveServerPlayers = reviveServerPlayers;
  if (typeof SERVER_UPGRADES !== 'undefined') this.SERVER_UPGRADES = SERVER_UPGRADES;
  if (typeof SERVER_UPGRADE_RARITIES !== 'undefined') this.SERVER_UPGRADE_RARITIES = SERVER_UPGRADE_RARITIES;
  if (typeof ROOM_DIFFICULTY !== 'undefined') this.ROOM_DIFFICULTY = ROOM_DIFFICULTY;
  if (typeof getPlayerSpawnPosition !== 'undefined') this.getPlayerSpawnPosition = getPlayerSpawnPosition;
  if (typeof createRoomSnapshot !== 'undefined') this.createRoomSnapshot = createRoomSnapshot;
  if (typeof broadcastRoomSnapshot !== 'undefined') this.broadcastRoomSnapshot = broadcastRoomSnapshot;
  if (typeof updateServerEnemies !== 'undefined') this.updateServerEnemies = updateServerEnemies;
  if (typeof updateServerEnemyProjectiles !== 'undefined') this.updateServerEnemyProjectiles = updateServerEnemyProjectiles;
  if (typeof updateServerWave !== 'undefined') this.updateServerWave = updateServerWave;
  if (typeof spawnServerEnemyFromEdge !== 'undefined') this.spawnServerEnemyFromEdge = spawnServerEnemyFromEdge;
  if (typeof distance !== 'undefined') this.distance = distance;
  if (typeof distToSegment !== 'undefined') this.distToSegment = distToSegment;
  if (typeof clamp !== 'undefined') this.clamp = clamp;
  if (typeof random !== 'undefined') this.random = random;
  if (typeof ROOM_PLAYER_SPEED !== 'undefined') this.ROOM_PLAYER_SPEED = ROOM_PLAYER_SPEED;
  if (typeof ensureServerMagazine !== 'undefined') this.ensureServerMagazine = ensureServerMagazine;
  if (typeof spawnServerZonePattern !== 'undefined') this.spawnServerZonePattern = spawnServerZonePattern;
  if (typeof updateServerBossTurretAttacks !== 'undefined') this.updateServerBossTurretAttacks = updateServerBossTurretAttacks;
  `;

  const intervals = [];
  const timeouts = [];

  const realHttp = require("http");

  const projectRoot = path.resolve(__dirname, "../..");

  const context = {
    require: (mod) => {
      if (mod === "http") {
        return {
          ...realHttp,
          createServer: (app) => {
            const s = realHttp.createServer(app);
            s.listen = (port, host, cb) => {
              if (typeof host === "function") host();
              if (typeof cb === "function") cb();
              return s;
            };
            return s;
          }
        };
      }
      if (mod.startsWith("./") || mod.startsWith("../")) {
        return require(path.resolve(projectRoot, mod));
      }
      return require(mod);
    },
    process: {
      ...process,
      env: { ...process.env, PORT: "0" }
    },
    Math: Object.create(Math),
    getPlayerSpawnPosition: (index, totalPlayers) => {
      const centerX = 1280 / 2;
      const centerY = 720 / 2;
      if (totalPlayers <= 1) return { x: centerX, y: centerY };
      return {
        x: index === 0 ? centerX - 70 : centerX + 70,
        y: centerY
      };
    },
    console: {
      ...console,
      log: () => {}
    },
    setTimeout: (fn, ms) => {
      const id = setTimeout(fn, ms);
      timeouts.push(id);
      return id;
    },
    clearTimeout: (id) => {
      clearTimeout(id);
    },
    setInterval: (fn, ms) => {
      const id = setInterval(fn, ms);
      intervals.push(id);
      return id;
    },
    clearInterval: (id) => {
      clearInterval(id);
    },
    __dirname: path.resolve(__dirname, "../.."),
    __filename: serverPath,
    module: { exports: {} },
    exports: {}
  };

  vm.createContext(context);
  vm.runInContext(code, context);

  // Auto-expose shared modules on context (with guard — don't overwrite server-defined names)
  const sharedModules = [
    require("../../shared/math"),
    require("../../shared/constants"),
    require("../../shared/xp"),
    require("../../shared/enemy-xp"),
    require("../../shared/player-stats"),
    require("../../shared/enemy-factory"),
    require("../../shared/upgrades"),
    require("../../shared/room-balance")
  ];
  for (const mod of sharedModules) {
    for (const [key, value] of Object.entries(mod)) {
      if (!(key in context)) { context[key] = value; }
    }
  }

  function cleanup() {
    for (const id of intervals) clearInterval(id);
    for (const id of timeouts) clearTimeout(id);
    if (context.server && typeof context.server.close === "function") {
      context.server.close();
    }
    if (context.io && typeof context.io.close === "function") {
      context.io.close();
    }
  }

  function simulateSocketConnection(socketId, initialData = {}) {
    const socket = createMockSocket(socketId, initialData);
    context.io.sockets.sockets.set(socketId, socket);
    // Find connection listener and invoke
    const listeners = context.io.listeners("connection");
    for (const listener of listeners) {
      listener(socket);
    }
    return socket;
  }

  return {
    ctx: context,
    cleanup,
    createMockSocket,
    simulateSocketConnection
  };
}

module.exports = {
  loadServerInstance,
  createMockSocket
};
