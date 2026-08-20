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
  if (typeof COOP_SHOOT_MAX_POSITION_DRIFT !== 'undefined') this.COOP_SHOOT_MAX_POSITION_DRIFT = COOP_SHOOT_MAX_POSITION_DRIFT;
  if (typeof COOP_REPAIR_HEAL_COOLDOWN !== 'undefined') this.COOP_REPAIR_HEAL_COOLDOWN = COOP_REPAIR_HEAL_COOLDOWN;
  if (typeof COOP_WORLD_WIDTH !== 'undefined') this.COOP_WORLD_WIDTH = COOP_WORLD_WIDTH;
  if (typeof COOP_WORLD_HEIGHT !== 'undefined') this.COOP_WORLD_HEIGHT = COOP_WORLD_HEIGHT;
  if (typeof ROOM_INACTIVITY_TIMEOUT_MS !== 'undefined') this.ROOM_INACTIVITY_TIMEOUT_MS = ROOM_INACTIVITY_TIMEOUT_MS;
  if (typeof COOP_ENEMY_HP_MULTIPLIER !== 'undefined') this.COOP_ENEMY_HP_MULTIPLIER = COOP_ENEMY_HP_MULTIPLIER;
  if (typeof COOP_BOSS_HP_MULTIPLIER !== 'undefined') this.COOP_BOSS_HP_MULTIPLIER = COOP_BOSS_HP_MULTIPLIER;
  if (typeof COOP_BULLET_SPEED !== 'undefined') this.COOP_BULLET_SPEED = COOP_BULLET_SPEED;
  if (typeof COOP_BULLET_RADIUS !== 'undefined') this.COOP_BULLET_RADIUS = COOP_BULLET_RADIUS;
  if (typeof COOP_BULLET_BOUNCES !== 'undefined') this.COOP_BULLET_BOUNCES = COOP_BULLET_BOUNCES;
  if (typeof COOP_CRYSTAL_RADIUS !== 'undefined') this.COOP_CRYSTAL_RADIUS = COOP_CRYSTAL_RADIUS;
  if (typeof createCoopWorld !== 'undefined') this.createCoopWorld = createCoopWorld;
  if (typeof createServerCoopPlayer !== 'undefined') this.createServerCoopPlayer = createServerCoopPlayer;
  if (typeof createServerBullet !== 'undefined') this.createServerBullet = createServerBullet;
  if (typeof createServerEnemy !== 'undefined') this.createServerEnemy = createServerEnemy;
  if (typeof damageServerEnemy !== 'undefined') this.damageServerEnemy = damageServerEnemy;
  if (typeof killServerEnemy !== 'undefined') this.killServerEnemy = killServerEnemy;
  if (typeof catchServerBullet !== 'undefined') this.catchServerBullet = catchServerBullet;
  if (typeof dropServerBullet !== 'undefined') this.dropServerBullet = dropServerBullet;
  if (typeof shootServerBullet !== 'undefined') this.shootServerBullet = shootServerBullet;
  if (typeof updateServerBullet !== 'undefined') this.updateServerBullet = updateServerBullet;
  if (typeof updateServerCoopWorld !== 'undefined') this.updateServerCoopWorld = updateServerCoopWorld;
  if (typeof applyServerUpgrade !== 'undefined') this.applyServerUpgrade = applyServerUpgrade;
  if (typeof sanitizeName !== 'undefined') this.sanitizeName = sanitizeName;
  if (typeof sanitizeCode !== 'undefined') this.sanitizeCode = sanitizeCode;
  if (typeof generateRoomCode !== 'undefined') this.generateRoomCode = generateRoomCode;
  if (typeof startRoomCountdown !== 'undefined') this.startRoomCountdown = startRoomCountdown;
  if (typeof cancelRoomCountdown !== 'undefined') this.cancelRoomCountdown = cancelRoomCountdown;
  if (typeof touchRoom !== 'undefined') this.touchRoom = touchRoom;
  if (typeof closeRoom !== 'undefined') this.closeRoom = closeRoom;
  if (typeof leaveRoom !== 'undefined') this.leaveRoom = leaveRoom;
  if (typeof getRoomForSocket !== 'undefined') this.getRoomForSocket = getRoomForSocket;
  if (typeof getPublicRoomState !== 'undefined') this.getPublicRoomState = getPublicRoomState;
  if (typeof shootServerBossSpread !== 'undefined') this.shootServerBossSpread = shootServerBossSpread;
  if (typeof shootServerBossRadial !== 'undefined') this.shootServerBossRadial = shootServerBossRadial;
  if (typeof shootServerBossShockwave !== 'undefined') this.shootServerBossShockwave = shootServerBossShockwave;
  if (typeof shootServerBossSniperBolt !== 'undefined') this.shootServerBossSniperBolt = shootServerBossSniperBolt;
  if (typeof spawnServerBossDrones !== 'undefined') this.spawnServerBossDrones = spawnServerBossDrones;
  `;

  const intervals = [];
  const timeouts = [];

  const realHttp = require("http");

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
      return require(mod);
    },
    process: {
      ...process,
      env: { ...process.env, PORT: "0" }
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
