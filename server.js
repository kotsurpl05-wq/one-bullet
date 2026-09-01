const crypto = require("crypto");
"use strict";

const path = require("path");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");

// Shared game modules
const { clamp, random, distance, distToSegmentSquared, distToSegment } = require("./shared/math");
const { PLAYER_SPEED, BULLET_SPEED, BULLET_RADIUS, BULLET_BOUNCES, WORLD_WIDTH, WORLD_HEIGHT, CRYSTAL_RADIUS } = require("./shared/constants");
const { getExperienceRequirement } = require("./shared/xp");
const { getEnemyExperience, getContactDamage } = require("./shared/enemy-xp");
const { createPlayerStats } = require("./shared/player-stats");
const { createEnemyBase } = require("./shared/enemy-factory");
const { UPGRADE_DEFS, applyUpgrade } = require("./shared/upgrades");
const { getMirageVisibility } = require("./shared/mirage");

const PORT = Number(process.env.PORT) || 3000;

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*" },
  transports: ["websocket", "polling"],
  maxHttpBufferSize: 1e6,
  pingInterval: 3000,
  pingTimeout: 8000,
  perMessageDeflate: false
});

app.get(["/healthz", "/health", "/ping"], (req, res) => {
  res.status(200).json({ status: "ok", uptime: process.uptime() });
});

if (typeof process !== "undefined" && typeof process.on === "function") {
  process.on("uncaughtException", err => {
    console.error("Uncaught exception:", err);
  });

  process.on("unhandledRejection", (reason, promise) => {
    console.error("Unhandled rejection at:", promise, "reason:", reason);
  });
}

app.use(
  express.static(
    path.join(__dirname, "public"),
    { maxAge: "1h", etag: true }
  )
);

const rooms = new Map();

function sanitizeSkin(value) {
  const allowed = [
    "neon", "fire", "quantum", "toxic", "cosmic",
    "plasma", "void", "inferno", "glitch", "prism", "holy", "ruby",
    "frost", "shadow", "gold", "circuit", "storm", "candy"
  ];
  const s = String(value || "").toLowerCase().trim();
  return allowed.includes(s) ? s : "neon";
}

function sanitizePlayerSkin(value) {
  const allowed = [
    "cyan", "crimson", "amber", "emerald", "violet",
    "gold", "ice", "toxic", "inferno", "obsidian", "holy"
  ];
  const s = String(value || "").toLowerCase().trim();
  return allowed.includes(s) ? s : "cyan";
}

function sanitizeName(value) {
  const name = String(value || "")
    .trim()
    .slice(0, 18);

  return name || "Игрок";
}

function sanitizeCode(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 5);
}

function generateReconnectToken() {
  return crypto.randomBytes(8).toString("hex");
}

function generateRoomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

  for (let attempt = 0; attempt < 100; attempt++) {
    let code = "";

    for (let i = 0; i < 5; i++) {
      code += alphabet[
        Math.floor(Math.random() * alphabet.length)
      ];
    }

    if (!rooms.has(code)) {
      return code;
    }
  }

  throw new Error("Не удалось создать код комнаты");
}

function getRoomForSocket(socket) {
  const code = socket.data.roomCode;

  if (!code) {
    return null;
  }

  return rooms.get(code) || null;
}

function getPublicRoomState(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    started: room.started,
    difficulty: room.difficulty || "normal",
    countdown: typeof room.countdown === "number" ? room.countdown : null,

    players: [...room.players.values()].map(
      player => ({
        id: player.id,
        name: player.name,
        role: player.role,
        bulletSkin: player.bulletSkin || "neon",
        playerSkin: player.playerSkin || "cyan",
        ready: Boolean(player.ready)
      })
    )
  };
}

function startRoomCountdown(room) {
  if (room.countdownInterval) return;
  room.countdown = 3;
  emitRoomState(room);

  room.countdownInterval = setInterval(() => {
    if (room.players.size !== 2 || ![...room.players.values()].every(p => p.ready)) {
      cancelRoomCountdown(room);
      return;
    }

    room.countdown -= 1;

    if (room.countdown <= 0) {
      cancelRoomCountdown(room);
      room.started = true;
      for (const p of room.players.values()) {
        p.ready = false;
      }
      room.world = createCoopWorld(room);

      io.to(room.code).emit("room:started", {
        difficulty: room.difficulty || "normal"
      });

      io.to(room.code).emit(
        "net:snapshot",
        createServerCoopSnapshot(room, { full: true })
      );

      emitRoomState(room);
    } else {
      emitRoomState(room);
    }
  }, 1000);
}

function cancelRoomCountdown(room) {
  if (room.countdownInterval) {
    clearInterval(room.countdownInterval);
    room.countdownInterval = null;
  }
  room.countdown = null;
  emitRoomState(room);
}

function touchRoom(room) {
  if (room) {
    room.lastActivity = Date.now();
  }
}

function emitRoomState(room) {
  io.to(room.code).emit(
    "room:state",
    getPublicRoomState(room)
  );
}

function closeRoom(room, reason) {
  cancelRoomCountdown(room);
  io.to(room.code).emit("room:closed", {
    reason
  });

  for (const playerId of room.players.keys()) {
    const memberSocket =
      io.sockets.sockets.get(playerId);

    if (memberSocket) {
      memberSocket.data.roomCode = null;
      memberSocket.data.role = null;
      memberSocket.leave(room.code);
    }
  }

  rooms.delete(room.code);
}

function handlePlayerDisconnectDuringMatch(socket, room) {
  const player = room.players.get(socket.id);
  if (player && !player.disconnected) {
    player.disconnected = true;
    player.disconnectTime = Date.now();

    room.world.reconnectState = {
      paused: true,
      disconnectedId: player.id,
      playerName: player.name,
      role: player.role,
      expiresAt: Date.now() + 120000
    };

    if (room.reconnectTimeout) {
      clearTimeout(room.reconnectTimeout);
    }

    room.reconnectTimeout = setTimeout(() => {
      if (!rooms.has(room.code)) return;
      if (room.world && room.world.reconnectState?.paused) {
        closeRoom(room, "Время ожидания напарника (2 мин) истекло");
      }
    }, 120000);

    socket.leave(room.code);
    socket.data.roomCode = null;
    socket.data.role = null;

    io.to(room.code).emit("net:snapshot", createServerCoopSnapshot(room));
    emitRoomState(room);
  }
}

function leaveRoom(socket, reason = "Игрок вышел") {
  const room = getRoomForSocket(socket);

  if (!room) {
    return;
  }

  // Если матч уже идёт и мир активен — НЕ разрушаем игру, а даём 120 секунд на реконнект!
  if (room.started && room.world && !room.world.gameOver) {
    handlePlayerDisconnectDuringMatch(socket, room);
    return;
  }

  const wasHost = room.hostId === socket.id;
  cancelRoomCountdown(room);
  room.players.delete(socket.id);

  socket.leave(room.code);
  socket.data.roomCode = null;
  socket.data.role = null;

  if (wasHost) {
    closeRoom(
      room,
      "Хозяин закрыл комнату"
    );
    return;
  }

  // Гость вышел из лобби до старта матча
  room.started = false;
  room.world = null;
  for (const p of room.players.values()) {
    p.ready = false;
  }

  io.to(room.hostId).emit("room:peer-left", {
    playerId: socket.id,
    reason: "Гость покинул комнату"
  });

  emitRoomState(room);
}

function sanitizeInput(input) {
  return {
    up: Boolean(input?.up),
    down: Boolean(input?.down),
    left: Boolean(input?.left),
    right: Boolean(input?.right),
    dash: Boolean(input?.dash),

    aimX: Number.isFinite(input?.aimX) ? Number(input.aimX) : 0,
    aimY: Number.isFinite(input?.aimY) ? Number(input.aimY) : 0,
    x: Number.isFinite(input?.x) ? Number(input.x) : null,
    y: Number.isFinite(input?.y) ? Number(input.y) : null
  };
}

const COOP_WORLD_WIDTH = WORLD_WIDTH;
const COOP_WORLD_HEIGHT = WORLD_HEIGHT;

const COOP_PLAYER_SPEED = PLAYER_SPEED;
const COOP_SIMULATION_RATE = 60;
const COOP_SNAPSHOT_RATE = 20;

const COOP_INPUT_TIMEOUT = 1200;

const COOP_SHOOT_MAX_POSITION_DRIFT = 45;
const COOP_REPAIR_HEAL_COOLDOWN = 1.75;
const ROOM_INACTIVITY_TIMEOUT_MS = 15 * 60 * 1000;
const ROOM_CLEANUP_INTERVAL_MS = 60 * 1000;

const COOP_BULLET_SPEED = BULLET_SPEED;
const COOP_BULLET_RADIUS = BULLET_RADIUS;
const COOP_BULLET_BOUNCES = BULLET_BOUNCES;
const COOP_BULLET_MAX_AGE = 6;
const COOP_BULLET_CATCH_DELAY = 0.24;

const COOP_ENEMY_COUNT_MULTIPLIER = 2.0;
const COOP_ENEMY_HP_MULTIPLIER = 1.0;
const COOP_BOSS_HP_MULTIPLIER = 1.1;

const COOP_WAVE_BREAK = 3.5;

const COOP_PLAYER_INVULNERABILITY = 0.22;
const COOP_ENEMY_CONTACT_COOLDOWN = 0.85;

const COOP_EXPERIENCE_MULTIPLIER = 1.7;

const COOP_CRYSTAL_RADIUS = CRYSTAL_RADIUS;
const COOP_CRYSTAL_ATTRACTION_RADIUS = 180;
const COOP_CRYSTAL_ATTRACTION_SPEED = 430;
const COOP_CRYSTAL_CLEAR_SPEED = 900;


const COOP_DIFFICULTY = {
  easy: {
    playerHp: 700,
    enemySpeed: 0.86,
    enemyCount: 0.9
  },

  normal: {
    playerHp: 500,
    enemySpeed: 1,
    enemyCount: 1
  },

  hard: {
    playerHp: 400,
    enemySpeed: 1.16,
    enemyCount: 1.15
  }
};



function getServerExperienceRequirement(level) {
  return getExperienceRequirement(level);
}



// new balance - unbalanced

//function getServerExperienceRequirement(level) {
//  const progression = Math.max(
//    0,
//    Math.min(level - 1, 10)
//  );
//
//  return (
//    12 +
//    progression * 6 +
//    Math.floor(
//      Math.max(0, level - 11) * 6
//    )
//  );
//}


// clamp, random, distance — imported from shared/math.js


function getServerAimDirection(player) {
  const dx = player.aimX - player.x;
  const dy = player.aimY - player.y;
  const dist = Math.hypot(dx, dy);

  if (dist < 0.001) {
    return { x: 1, y: 0 };
  }

  return {
    x: dx / dist,
    y: dy / dist
  };
}

function createServerBullet(
  world,
  owner,
  customX,
  customY,
  customVx,
  customVy
) {
  const player =
    typeof owner === "string"
      ? (world.players && world.players.get(owner)) || { id: owner, colorIndex: 0, x: 0, y: 0, r: 16, stats: {} }
      : owner || { id: "p1", colorIndex: 0, x: 0, y: 0, r: 16, stats: {} };

  const direction =
    getServerAimDirection(player);

  const bullet = {
    id:
      `${player.id}:${world.nextBulletId++}`,

    ownerId: player.id,
    colorIndex: player.colorIndex,
    skin: player.bulletSkin || "neon",

    x:
      customX !== undefined
        ? customX
        : player.x +
          direction.x *
            (
              player.r +
              COOP_BULLET_RADIUS +
              2
            ),

    y:
      customY !== undefined
        ? customY
        : player.y +
          direction.y *
            (
              player.r +
              COOP_BULLET_RADIUS +
              2
            ),

    vx: customVx !== undefined ? customVx : 0,
    vy: customVy !== undefined ? customVy : 0,

    r:
      player.stats?.bulletRadius ??
      COOP_BULLET_RADIUS,
    state: "held",
    age: 0,

    bouncesLeft:
      player.stats?.maxBounces ??
      COOP_BULLET_BOUNCES,

    hitsLeft:
      1 +
      (player.stats?.pierce || 0),

    hitEnemies: new Set(),
    hitCooldowns: new Map()
  };

  world.bullets.set(
    bullet.id,
    bullet
  );

  return bullet;
}

function ensureServerMagazine(world, player) {
  if (!world || !player) {
    return;
  }

  const desiredCount =
    player.stats?.magazineSize || 1;

  let existingBullets = [];
  for (
    const bullet of
    world.bullets.values()
  ) {
    if (bullet.ownerId === player.id) {
      existingBullets.push(bullet);
    }
  }

  while (
    existingBullets.length <
    desiredCount
  ) {
    const newBullet =
      createServerBullet(
        world,
        player
      );

    existingBullets.push(newBullet);
  }

  for (
    const bullet of
    existingBullets
  ) {
    if (
      Number.isFinite(
        player.stats?.bulletRadius
      )
    ) {
      bullet.r =
        player.stats.bulletRadius;
    }
  }
}

function dropServerBullet(bullet) {
  bullet.state = "ground";
  bullet.vx = 0;
  bullet.vy = 0;
  bullet.age = 0;
  bullet.x = Math.max(bullet.r || 8, Math.min(COOP_WORLD_WIDTH - (bullet.r || 8), bullet.x));
  bullet.y = Math.max(bullet.r || 8, Math.min(COOP_WORLD_HEIGHT - (bullet.r || 8), bullet.y));
}

function catchServerBullet(
  bullet,
  owner,
  world
) {
  bullet.hitEnemies.clear();
  bullet.state = "held";
  bullet.vx = 0;
  bullet.vy = 0;
  bullet.age = 0;

  const direction =
    getServerAimDirection(owner);

  bullet.x = Math.max(
    bullet.r,
    Math.min(
      COOP_WORLD_WIDTH - bullet.r,
      owner.x +
        direction.x *
          (
            owner.r +
            bullet.r +
            2
          )
    )
  );

  bullet.y = Math.max(
    bullet.r,
    Math.min(
      COOP_WORLD_HEIGHT - bullet.r,
      owner.y +
        direction.y *
          (
            owner.r +
            bullet.r +
            2
          )
    )
  );

  if (world && (owner?.stats?.catchBlast || 0) > 0) {
    const blastDmg = Math.max(1, Math.floor((owner.stats?.damage || 100) * (owner.stats?.catchBlastDamageRatio || 0.8)));
    for (const enemy of world.enemies.values()) {
      if (enemy && enemy.hasEnteredArena) {
        if (Math.hypot(owner.x - enemy.x, owner.y - enemy.y) <= owner.stats.catchBlast + enemy.r) {
          damageServerEnemy(world, enemy.id, blastDmg, owner);
        }
      }
    }
  }
}

function shootServerBullet(
  room,
  ownerId,
  aimX,
  aimY,
  clientShootX,
  clientShootY
) {
  if (!room?.world) {
    return false;
  }

  const owner =
    room.world.players.get(
      ownerId
    );

  if (!owner || !owner.alive) {
    return false;
  }

  if (Number.isFinite(clientShootX) && Number.isFinite(clientShootY)) {
    const dist = Math.hypot(clientShootX - owner.x, clientShootY - owner.y);
    if (dist <= COOP_SHOOT_MAX_POSITION_DRIFT) {
      owner.x = clamp(clientShootX, owner.r, COOP_WORLD_WIDTH - owner.r);
      owner.y = clamp(clientShootY, owner.r, COOP_WORLD_HEIGHT - owner.r);
    }
  }

  if (Number.isFinite(Number(aimX))) {
    owner.aimX = clamp(
      Number(aimX),
      0,
      COOP_WORLD_WIDTH
    );
  }

  if (Number.isFinite(Number(aimY))) {
    owner.aimY = clamp(
      Number(aimY),
      0,
      COOP_WORLD_HEIGHT
    );
  }

  if (
    room.world.upgradePaused ||
    room.world.manualPaused ||
    room.world.gameOver
  ) {
    return false;
  }

  const bullet = [
    ...room.world.bullets.values()
  ].find(currentBullet =>
    currentBullet.ownerId === ownerId &&
    currentBullet.state === "held"
  );

  if (!bullet) {
    return false;
  }

  const direction =
    getServerAimDirection(
      owner,
      owner.aimX,
      owner.aimY
    );

  bullet.state = "flying";
  bullet.age = 0;

  bullet.x = Math.max(
    bullet.r || 7,
    Math.min(
      COOP_WORLD_WIDTH - (bullet.r || 7),
      owner.x +
        direction.x *
          (
            owner.r +
            bullet.r +
            2
          )
    )
  );

  bullet.y = Math.max(
    bullet.r || 7,
    Math.min(
      COOP_WORLD_HEIGHT - (bullet.r || 7),
      owner.y +
        direction.y *
          (
            owner.r +
            bullet.r +
            2
          )
    )
  );

  const bulletSpeed =
    owner.stats?.bulletSpeed ??
    COOP_BULLET_SPEED;

  bullet.vx =
    direction.x *
    bulletSpeed;

  bullet.vy =
    direction.y *
    bulletSpeed;

  bullet.r =
    owner.stats?.bulletRadius ??
    COOP_BULLET_RADIUS;
      
  bullet.bouncesLeft =
    owner.stats?.maxBounces ??
    COOP_BULLET_BOUNCES;
      
  bullet.hitsLeft =
    1 +
    (owner.stats?.pierce || 0);

  bullet.hitEnemies.clear();

  return true;
}

// distToSegmentSquared, distToSegment — imported from shared/math.js

function refreshServerBulletContacts(
  world,
  bullet,
  dt = 0
) {
  if (!bullet.hitCooldowns) {
    bullet.hitCooldowns = new Map();
  }

  for (const [enemyId, cd] of bullet.hitCooldowns.entries()) {
    const updatedCd = cd - dt;
    const enemy = world.enemies.get(enemyId);
    if (!enemy || (Number.isFinite(enemy.hp) && enemy.hp <= 0)) {
      bullet.hitCooldowns.delete(enemyId);
      bullet.hitEnemies.delete(enemyId);
      continue;
    }

    const currentDist = Math.hypot(bullet.x - enemy.x, bullet.y - enemy.y);
    if (updatedCd <= 0 && currentDist > bullet.r + enemy.r + 15) {
      bullet.hitCooldowns.delete(enemyId);
      bullet.hitEnemies.delete(enemyId);
    } else {
      bullet.hitCooldowns.set(enemyId, updatedCd);
    }
  }

  for (const enemyId of [...bullet.hitEnemies]) {
    const enemy = world.enemies.get(enemyId);
    if (!enemy || (Number.isFinite(enemy.hp) && enemy.hp <= 0)) {
      bullet.hitEnemies.delete(enemyId);
      if (bullet.hitCooldowns) bullet.hitCooldowns.delete(enemyId);
      continue;
    }

    if (!bullet.hitCooldowns.has(enemyId)) {
      const currentDist = Math.hypot(bullet.x - enemy.x, bullet.y - enemy.y);
      if (currentDist > bullet.r + enemy.r + 15) {
        bullet.hitEnemies.delete(enemyId);
      }
    }
  }
}


const MIRAGE_CYCLE = 7.0;
const MIRAGE_HIDDEN = 6.0;

function applyServerSmartHoming(bullet, candidateEnemies, homingPower, dt) {
  if (homingPower <= 0 || !candidateEnemies || candidateEnemies.size === 0) return;
  if (bullet.state !== "flying") return;

  const bulletSpeed = Math.hypot(bullet.vx, bullet.vy) || 1;
  const dirX = bullet.vx / bulletSpeed;
  const dirY = bullet.vy / bulletSpeed;

  let bestEnemy = null;
  let bestScore = Infinity;
  const maxRange = 245 + homingPower * 28; // Сбалансированный радиус (-20%)

  for (const enemy of candidateEnemies) {
    if (!enemy || (Number.isFinite(enemy.hp) && enemy.hp <= 0)) continue;
    if (bullet.hitEnemies && bullet.hitEnemies.has(enemy.id)) continue;
    if (enemy.hasEnteredArena === false) continue;
    if (enemy.type === "mirage" && !enemy.mirageVisible) continue;

    const dx = enemy.x - bullet.x;
    const dy = enemy.y - bullet.y;
    const dist = Math.hypot(dx, dy);

    if (dist < 1 || dist > maxRange) continue;

    const toTargetX = dx / dist;
    const toTargetY = dy / dist;

    const dot = dirX * toTargetX + dirY * toTargetY;
    if (dot < 0.35) continue; // Направленный конус ~65 градусов

    const score = dist / (dot * dot * 2.4 + 0.1);
    if (score < bestScore) {
      bestScore = score;
      bestEnemy = enemy;
    }
  }

  if (bestEnemy) {
    const dx = bestEnemy.x - bullet.x;
    const dy = bestEnemy.y - bullet.y;
    const dist = Math.hypot(dx, dy) || 1;
    const targetAngle = Math.atan2(dy, dx);
    const currentAngle = Math.atan2(bullet.vy, bullet.vx);

    let angleDiff = targetAngle - currentAngle;
    while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
    while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;

    const maxTurnSpeed = 2.9 + homingPower * 1.4; // Аккуратная скорость доворота (-20%)
    const maxTurnThisFrame = maxTurnSpeed * dt;

    if (dist < 28 && Math.abs(angleDiff) < 0.35) {
      bullet.vx = (dx / dist) * bulletSpeed;
      bullet.vy = (dy / dist) * bulletSpeed;
    } else {
      const turn = Math.max(-maxTurnThisFrame, Math.min(maxTurnThisFrame, angleDiff));
      const newAngle = currentAngle + turn;
      bullet.vx = Math.cos(newAngle) * bulletSpeed;
      bullet.vy = Math.sin(newAngle) * bulletSpeed;
    }
  }
}

function updateServerBullet(
  room,
  bullet,
  dt
) {
  const world = room.world;

  if (!world) {
    return;
  }

  const owner =
    world.players.get(
      bullet.ownerId
    );

  /*
   * Если владелец отключился или был удалён,
   * удаляем и его патрон.
   */
  if (!owner) {
    world.bullets.delete(
      bullet.id
    );

    return;
  }

  /*
   * Удерживаемый патрон всегда находится
   * возле своего владельца.
   */
  if (bullet.state === "held") {
    const direction =
      getServerAimDirection(owner);

    bullet.x =
      owner.x +
      direction.x *
        (
          owner.r +
          bullet.r +
          2
        );

    bullet.y =
      owner.y +
      direction.y *
        (
          owner.r +
          bullet.r +
          2
        );

    bullet.vx = 0;
    bullet.vy = 0;
    bullet.age = 0;

    return;
  }

  /*
   * Лежащий патрон может подобрать
   * только его владелец.
   */
  if (bullet.state === "ground") {
    if (owner.alive && (owner.stats?.groundPullSpeed || 0) > 0) {
      const distToOwner = distance(bullet.x, bullet.y, owner.x, owner.y);
      const magnetCells = Math.min(40, 20 + (owner.stats?.magnetRangeBonusCells || 0));
      const MAGNET_MAX_DIST = magnetCells * 48; // базово 20 клеток (960px), до 40 клеток (1920px)

      let moveX = 0;
      let moveY = 0;

      if ((owner.stats?.groundPullSpeed || 0) > 0 && distToOwner > owner.r + bullet.r && distToOwner <= MAGNET_MAX_DIST) {
        const pullFactor = owner.stats.groundPullSpeed * dt;
        moveX += ((owner.x - bullet.x) / distToOwner) * pullFactor;
        moveY += ((owner.y - bullet.y) / distToOwner) * pullFactor;
      }

      /*
       * Магнетизатор: притягивает упавшие на землю пули в радиусе 400px с градиентом от 150 до 500.
       * Если у игрока есть бумеранг/магнит, силы суммируются векторно (борьба притяжений).
       */
      for (const enemy of world.enemies.values()) {
        if (enemy.type !== "magnetizer" || !enemy.hasEnteredArena || enemy.hp <= 0) continue;
        const distToMag = distance(bullet.x, bullet.y, enemy.x, enemy.y);
        if (distToMag < 400 && distToMag > enemy.r + bullet.r) {
          const magPull = (150 + (1 - distToMag / 400) * 350) * dt;
          moveX += ((enemy.x - bullet.x) / distToMag) * magPull;
          moveY += ((enemy.y - bullet.y) / distToMag) * magPull;
        }
      }

      bullet.x += moveX;
      bullet.y += moveY;

      /*
       * Эффект Бумеранга: возвращающаяся пуля
       * наносит урон врагам, находящимся рядом с ней.
       * Проверяем точку — текущую позицию пули,
       * как и в соло-режиме.
       */
      if (owner.stats?.boomerang && (owner.stats?.boomerangPercent || 0) > 0) {
        for (const enemy of world.enemies.values()) {
          if (!enemy.hasEnteredArena) continue;
          if (enemy.type === "phantom" && enemy.isPhased) continue;
          if (bullet.hitEnemies.has(enemy.id)) continue;

          const hitDist = bullet.r + enemy.r;
          const eDist = distance(
            enemy.x, enemy.y,
            bullet.x, bullet.y
          );

          if (eDist <= hitDist) {
            bullet.hitEnemies.add(enemy.id);
            const boomerangDmg = Math.max(1, Math.floor(
              (owner.stats?.damage || 100) * (owner.stats.boomerangPercent || 0.25)
            ));

            bullet.hitsLeft += 1;
            damageServerEnemy(
              world,
              enemy.id,
              boomerangDmg,
              owner
            );

            if (bullet.hitsLeft > 0) {
              bullet.hitsLeft -= 1;
            }
          }
        }
      }
    }
    if (!owner.alive) {
      return;
    }

    const pickupDistance =
      owner.r +
      bullet.r + 14;


    if (
      distance(
        bullet.x,
        bullet.y,
        owner.x,
        owner.y
      ) <= pickupDistance
    ) {
      catchServerBullet(
        bullet,
        owner,
        world
      );
    }

    return;
  }

  if (bullet.state !== "flying") {
    return;
  }

  /*
   * Самонаведение пули.
   */
  const homingPower = owner.stats?.homing || 0;
  if (homingPower > 0 && world.enemies.size > 0) {
    applyServerSmartHoming(bullet, world.enemies, homingPower, dt);
  }

  /*
   * Магнетизатор: искривляет траекторию пули
   * в радиусе 200px.
   */
  for (const enemy of world.enemies.values()) {
    if (enemy.type !== "magnetizer") continue;
    if (!enemy.hasEnteredArena) continue;

    const distToBullet = distance(
      bullet.x, bullet.y,
      enemy.x, enemy.y
    );

    if (distToBullet < 400 && distToBullet > 1) {
      const pullStrength = (1600 + (1 - distToBullet / 400) * 2400) * dt;
      const dx = enemy.x - bullet.x;
      const dy = enemy.y - bullet.y;

      bullet.vx += (dx / distToBullet) * pullStrength;
      bullet.vy += (dy / distToBullet) * pullStrength;
    }
  }

  /*
   * Полёт патрона с непрерывным определением коллизий (CCD).
   */
  const prevX = bullet.x;
  const prevY = bullet.y;

  bullet.age += dt;

  bullet.x +=
    bullet.vx * dt;

  bullet.y +=
    bullet.vy * dt;

  /*
   * Проверка столкновения со стенами.
   */
  let hitHorizontal = false;
  let hitVertical = false;

  if (bullet.x <= bullet.r) {
    bullet.x = bullet.r;
    hitHorizontal = true;
  } else if (
    bullet.x >=
    COOP_WORLD_WIDTH - bullet.r
  ) {
    bullet.x =
      COOP_WORLD_WIDTH - bullet.r;

    hitHorizontal = true;
  }

  if (bullet.y <= bullet.r) {
    bullet.y = bullet.r;
    hitVertical = true;
  } else if (
    bullet.y >=
    COOP_WORLD_HEIGHT - bullet.r
  ) {
    bullet.y =
      COOP_WORLD_HEIGHT - bullet.r;

    hitVertical = true;
  }

  if (hitHorizontal || hitVertical) {
    if (bullet.bouncesLeft > 0) {
      if (hitHorizontal) {
        bullet.vx *= -1;
      }

      if (hitVertical) {
        bullet.vy *= -1;
      }

      bullet.bouncesLeft -= 1;
      bullet.hitEnemies.clear();
      if (bullet.hitCooldowns) bullet.hitCooldowns.clear();

      /*
       * Осколочный Рикошет: при рикошете от стены
       * спавн 2 самонаводящихся осколков.
       */
      if (owner?.stats?.splinter && world.splinters) {
        const shardCount = Math.min(5, Math.max(2, (owner.stats.splinterCount !== undefined ? owner.stats.splinterCount : 2)));
        const shardDmg = Math.max(
          1,
          (owner.stats.damage || 100) * (owner.stats.splinterDamagePercent || 0.25)
        );

        for (let si = 0; si < shardCount; si++) {
          const angle = Math.random() * Math.PI * 2;
          const shardSpeed = 260;

          const splinterId = world.nextEnemyId++;
          world.splinters.set(
            splinterId,
            {
              id: splinterId,
              ownerId: owner.id,
              x: bullet.x,
              y: bullet.y,
              vx: Math.cos(angle) * shardSpeed,
              vy: Math.sin(angle) * shardSpeed,
              damage: shardDmg,
              life: 1.5,
              homing: true,
              r: 4.5
            }
          );
        }
      }
    } else {
      dropServerBullet(bullet);
      return;
    }
  }

  /*
   * Вот нужное место:
   * после обработки стен, но до проверки
   * возвращения патрона к владельцу.
   *
   * Разрешаем повторное попадание по врагу
   * после полного выхода патрона из его тела.
   */
  refreshServerBulletContacts(
    world,
    bullet,
    dt
  );

  /*
   * Проверяем попадания по врагам.
   *
   * Используем снимок списка, поскольку убийство
   * разделителя может изменить world.enemies.
   */
  const collisionCandidates = [
    ...world.enemies.values()
  ];

  for (
    const enemy of
    collisionCandidates
  ) {
    if (
      bullet.state !== "flying"
    ) {
      break;
    }

    /*
     * Враг мог быть уничтожен предыдущим
     * попаданием в этом же цикле.
     */
    if (
      !world.enemies.has(enemy.id)
    ) {
      continue;
    }

    /*
     * Враг ещё не вошёл на арену и пока
     * не участвует в бою.
     */
    if (!enemy.hasEnteredArena) {
      continue;
    }

    /*
     * Фантом в фазе неуязвимости —
     * пуля пролетает насквозь.
     */
    if (
      enemy.type === "phantom" &&
      enemy.isPhased
    ) {
      continue;
    }

    /*
     * Пока патрон находится внутри этого врага,
     * повторный урон запрещён.
     */
    if (
      bullet.hitEnemies.has(enemy.id)
    ) {
      continue;
    }

    const hitDistance =
      bullet.r + enemy.r;

    const segmentDistance = distToSegment(
      enemy.x,
      enemy.y,
      prevX,
      prevY,
      bullet.x,
      bullet.y
    );

    if (segmentDistance > hitDistance) {
      continue;
    }

    bullet.hitEnemies.add(
      enemy.id
    );
    if (!bullet.hitCooldowns) bullet.hitCooldowns = new Map();
    bullet.hitCooldowns.set(enemy.id, 0.35);

    bullet.hitsLeft -= 1;

    const baseDamage =
      owner.stats?.damage || 100;

    const critical =
      Math.random() <
      (owner.stats?.critChance || 0);

    const hitDamage =
      critical
        ? baseDamage * 2.0
        : baseDamage;

    const wasMarked = Boolean(enemy.targetMarked);

    const hitAngle = Math.atan2(
      bullet.y - enemy.y,
      bullet.x - enemy.x
    );

    damageServerEnemy(
      world,
      enemy.id,
      hitDamage,
      owner,
      hitAngle
    );

    /*
     * Метка Цели: помечаем врага на 4 секунды (+5% за уровень, до +40%).
     * Бонусный урон применяется только к СЛЕДУЮЩИМ атакам по уже помеченной цели.
     */
    if (
      (owner.stats?.markBonus || owner.stats?.targetMark) &&
      !wasMarked &&
      world.enemies.has(enemy.id) &&
      enemy.hp > 0
    ) {
      enemy.targetMarked = true;
      enemy.targetMarkTimer = 4.0;
      enemy.targetMarkBonus = owner.stats.markBonus || 0.40;
      enemy.markBonus = owner.stats.markBonus || 0.40;
    }

    /*
     * Ядовитая пуля: отравляет врага (тики раз в 1с).
     */
    if (owner.stats?.poison && world.enemies.has(enemy.id) && enemy.hp > 0) {
      enemy.poisonTimer = Math.max(enemy.poisonTimer || 0, owner.stats.poisonDuration || 2.0);
      enemy.poisonTickTimer = 1.0;
      enemy.poisonDamage = (owner.stats.damage || 100) * (owner.stats.poisonDamageRatio || 0.5);
      enemy.poisonOwnerId = owner.id;
    }

    /*
     * Пуля с паразитом: шанс поселить паразита при попадании.
     */
    const pChance = owner.stats?.parasite ? (owner.stats.parasiteChance || 0.25) : 0;
    if (
      pChance > 0 &&
      !enemy.parasiteInfested &&
      world.enemies.has(enemy.id) &&
      enemy.hp > 0
    ) {
      if (Math.random() <= pChance) {
        enemy.parasiteInfested = true;
        enemy.parasiteCount = owner.stats.parasiteCount || 1;
        enemy.parasiteDamage = (owner.stats.damage || 100) * (owner.stats.parasiteDamageRatio || 0.75);
        enemy.parasiteOwnerId = owner.id;
      }
    }

    /*
     * Кинетический Удар: оглушение 5% за уровень на 0.3с при попадании.
     */
    const stunChance = (owner.stats?.stunChance !== undefined)
      ? owner.stats.stunChance
      : (owner.stats?.stun ? Math.min(1.0, owner.stats.stun) : 0);

    if (
      stunChance > 0 &&
      Math.random() <= stunChance &&
      world.enemies.has(enemy.id) &&
      enemy.hp > 0
    ) {
      enemy.stunTimer = Math.max(
        enemy.stunTimer || 0,
        owner.stats?.stunDuration || 0.4
      );
    }

    /*
     * Взрыв от улучшения "Разрывной сердечник"
     */
    if ((owner.stats?.explosionRadius || 0) > 0) {
      const expRadius = owner.stats.explosionRadius;
      const expRatio = owner.stats?.explosionDamageRatio || 0.6;
      const expDmg = Math.max(1, Math.floor((owner.stats?.damage || 100) * expRatio));
      for (const nearby of world.enemies.values()) {
        if (!nearby || nearby.id === enemy.id || !nearby.hasEnteredArena) continue;
        if (distance(enemy.x, enemy.y, nearby.x, nearby.y) <= expRadius + nearby.r) {
          damageServerEnemy(world, nearby.id, expDmg, owner);
        }
      }
    }

    /*
     * Цепная молния от улучшения "Цепной конденсатор"
     */
    if ((owner.stats?.chainCount || 0) > 0) {
      const maxChains = owner.stats.chainCount;
      const chainRange = owner.stats.chainRange || 140;
      const chainRatio = owner.stats?.chainDamageRatio || 0.6;
      let chained = 0;
      let lastX = enemy.x;
      let lastY = enemy.y;
      const chainedSet = new Set([enemy.id]);

      while (chained < maxChains) {
        let nextTarget = null;
        let nextDist = chainRange;

        for (const candidate of world.enemies.values()) {
          if (!candidate || chainedSet.has(candidate.id) || !candidate.hasEnteredArena) continue;
          const d = distance(lastX, lastY, candidate.x, candidate.y);
          if (d < nextDist) {
            nextDist = d;
            nextTarget = candidate;
          }
        }

        if (!nextTarget) break;
        chainedSet.add(nextTarget.id);
        const chainDmg = Math.max(1, Math.floor((owner.stats?.damage || 100) * chainRatio));
        damageServerEnemy(world, nextTarget.id, chainDmg, owner);
        lastX = nextTarget.x;
        lastY = nextTarget.y;
        chained++;
      }
    }

    if (bullet.hitsLeft <= 0) {
      dropServerBullet(bullet);
      return;
    }
  }

  /*
   * Летящий патрон может быть пойман только
   * живым владельцем и только после задержки.
   */
  if (
    owner.alive &&
    bullet.age > COOP_BULLET_CATCH_DELAY &&
    distToSegment(
      owner.x,
      owner.y,
      prevX,
      prevY,
      bullet.x,
      bullet.y
    ) <= owner.r + bullet.r + 4
  ) {
    catchServerBullet(
      bullet,
      owner,
      world
    );

    return;
  }

  /*
   * Если патрон слишком долго находится
   * в полёте, он падает на землю.
   */
  if (
    bullet.age >=
    COOP_BULLET_MAX_AGE
  ) {
    dropServerBullet(bullet);
  }
}


function getPlayerSpawnPosition(
  index,
  totalPlayers
) {
  const centerX = COOP_WORLD_WIDTH / 2;
  const centerY = COOP_WORLD_HEIGHT / 2;

  if (totalPlayers <= 1) {
    return { x: centerX, y: centerY };
  }

  return {
    x: index === 0
      ? centerX - 70
      : centerX + 70,
    y: centerY
  };
}

function reviveServerPlayers(world) {
  let index = 0;

  for (
    const coopPlayer of
    world.players.values()
  ) {
    if (!coopPlayer.alive) {
      const position = getPlayerSpawnPosition(
        index,
        world.players.size
      );

      coopPlayer.alive = true;

      coopPlayer.hp = Math.max(
        1,
        Math.ceil(
          coopPlayer.maxHp / 2
        )
      );

      coopPlayer.x = position.x;
      coopPlayer.y = position.y;
      coopPlayer.invulnerability = 1;
      coopPlayer.reviveBeacon = null;

      for (
        const bullet of
        world.bullets.values()
      ) {
        if (
          bullet.ownerId ===
          coopPlayer.id
        ) {
          catchServerBullet(
            bullet,
            coopPlayer,
            world
          );
        }
      }
    }

    index += 1;
  }
}

function updateServerWave(world, dt) {
  if (world.gameOver) {
    return;
  }

  if (world.enemies.size === 0) {
    if (!world.wavePending) {
      world.wavePending = true;

      world.waveClearTimer =
        COOP_WAVE_BREAK;
    } else {
      world.waveClearTimer =
        Math.max(
          0,
          world.waveClearTimer - dt
        );

      if (
        world.waveClearTimer <= 0
      ) {
        world.wave += 1;
        world.wavePending = false;
        world.waveClearTimer = 0;

        reviveServerPlayers(world);
        spawnServerWave(world);
      }
    }
  } else if (world.wavePending) {
    world.wavePending = false;
    world.waveClearTimer = 0;
  }
}



function updateServerParasites(world, dt) {
  if (!world.parasites || world.parasites.size === 0) return;

  for (const [parasiteId, spore] of world.parasites.entries()) {
    let nearestEnemy = null;
    let nearestDist = 1200;
    for (const enemy of world.enemies.values()) {
      if (!enemy.hasEnteredArena || enemy.hp <= 0) continue;
      if (enemy.type === "phantom" && enemy.isPhased) continue;
      const d = distance(spore.x, spore.y, enemy.x, enemy.y);
      if (d < nearestDist) {
        nearestDist = d;
        nearestEnemy = enemy;
      }
    }

    if (nearestEnemy && nearestDist > 0) {
      const steer = 7.0 * dt;
      const targetVx = ((nearestEnemy.x - spore.x) / nearestDist) * 320;
      const targetVy = ((nearestEnemy.y - spore.y) / nearestDist) * 320;
      spore.vx += (targetVx - spore.vx) * steer;
      spore.vy += (targetVy - spore.vy) * steer;
    }

    spore.x += spore.vx * dt;
    spore.y += spore.vy * dt;

    // Паразиты исчезают ТОЛЬКО когда улетают за пределы арены
    if (
      spore.x < -80 ||
      spore.x > COOP_WORLD_WIDTH + 80 ||
      spore.y < -80 ||
      spore.y > COOP_WORLD_HEIGHT + 80
    ) {
      world.parasites.delete(parasiteId);
      continue;
    }

    for (const enemy of world.enemies.values()) {
      if (!enemy.hasEnteredArena || enemy.hp <= 0) continue;
      if (enemy.type === "phantom" && enemy.isPhased) continue;
      if (distance(spore.x, spore.y, enemy.x, enemy.y) <= (spore.r || 7) + enemy.r) {
        const owner = world.players.get(spore.ownerId) || null;
        damageServerEnemy(world, enemy.id, spore.damage, owner);
        world.parasites.delete(parasiteId);
        break;
      }
    }
  }
}

function updateServerSplinters(world, dt) {
  if (!world.splinters || world.splinters.size === 0) return;
  for (const [sId, splinter] of world.splinters) {
    splinter.life -= dt;
    if (splinter.life <= 0) {
      world.splinters.delete(sId);
      continue;
    }

    let nearestEnemy = null;
    let nearestDist = 600;
    for (const enemy of world.enemies.values()) {
      if (!enemy.hasEnteredArena || enemy.hp <= 0) continue;
      if (enemy.type === "phantom" && enemy.isPhased) continue;
      const d = distance(splinter.x, splinter.y, enemy.x, enemy.y);
      if (d < nearestDist) {
        nearestDist = d;
        nearestEnemy = enemy;
      }
    }

    if (nearestEnemy && nearestDist > 0) {
      const steer = 6.0 * dt;
      const targetVx = ((nearestEnemy.x - splinter.x) / nearestDist) * 280;
      const targetVy = ((nearestEnemy.y - splinter.y) / nearestDist) * 280;
      splinter.vx += (targetVx - splinter.vx) * steer;
      splinter.vy += (targetVy - splinter.vy) * steer;
    }

    splinter.x += splinter.vx * dt;
    splinter.y += splinter.vy * dt;

    for (const enemy of world.enemies.values()) {
      if (!enemy.hasEnteredArena || enemy.hp <= 0) continue;
      if (enemy.type === "phantom" && enemy.isPhased) continue;
      if (distance(splinter.x, splinter.y, enemy.x, enemy.y) <= splinter.r + enemy.r) {
        const owner = world.players.get(splinter.ownerId);
        damageServerEnemy(world, enemy.id, splinter.damage, owner);
        world.splinters.delete(sId);
        break;
      }
    }
  }
}

function updateServerCoopWorld(
  room,
  dt,
  currentTime
) {
  const world = room.world;

  if (!world) {
    return;
  }

  /*
   * Мир полностью останавливается, пока оба
   * игрока не выберут личные улучшения, либо идёт пауза/обратный отсчёт реконнекта.
   */
  if (world.upgradePaused || world.manualPaused) {
    return;
  }

  if (typeof world.unpauseCountdown === "number") {
    world.unpauseCountdown -= dt;
    world.unpauseCountdownSec = Math.max(1, Math.ceil(world.unpauseCountdown));
    if (world.unpauseCountdown <= 0) {
      world.unpauseCountdown = null;
      world.unpauseCountdownSec = null;
      for (const p of world.players.values()) {
        p.invulnerability = Math.max(p.invulnerability || 0, 1.5);
      }
    }
    return;
  }

  if (world.reconnectState) {
    if (world.reconnectState.paused) {
      return;
    }
    if (world.reconnectState.unfreezing) {
      world.reconnectState.countdown -= dt;
      world.reconnectState.countdownSec = Math.max(1, Math.ceil(world.reconnectState.countdown));
      if (world.reconnectState.countdown <= 0) {
        world.reconnectState = null;
        for (const p of world.players.values()) {
          p.invulnerability = Math.max(p.invulnerability || 0, 1.5);
        }
      }
      return;
    }
  }

  for (
    const coopPlayer of
    world.players.values()
  ) {
    coopPlayer.invulnerability =
      Math.max(
        0,
        coopPlayer.invulnerability - dt
      );

    coopPlayer.repairHealCooldown =
      Math.max(
        0,
        (coopPlayer.repairHealCooldown || 0) - dt
      );

    /*
     * Реактивная Броня: декремент кулдауна.
     */
    if (coopPlayer.reactiveArmorCooldown > 0) {
      coopPlayer.reactiveArmorCooldown = Math.max(
        0,
        coopPlayer.reactiveArmorCooldown - dt
      );
    }

    if (!coopPlayer.alive) {
      /*
       * Маяк воскрешения: живой партнёр в радиусе
       * накапливает прогресс. При 3.0с → воскрешение.
       */
      if (
        coopPlayer.reviveBeacon &&
        coopPlayer.reviveBeacon.active
      ) {
        const beacon = coopPlayer.reviveBeacon;
        let rescuerNearby = false;

        for (const otherPlayer of world.players.values()) {
          if (otherPlayer.id === coopPlayer.id) continue;
          if (!otherPlayer.alive) continue;

          const dist = distance(
            otherPlayer.x, otherPlayer.y,
            beacon.x, beacon.y
          );

          if (dist <= beacon.radius) {
            rescuerNearby = true;
            break;
          }
        }

        if (rescuerNearby) {
          beacon.progress += dt;

          if (beacon.progress >= beacon.requiredTime) {
            coopPlayer.alive = true;
            coopPlayer.hp = Math.max(
              1,
              Math.ceil(coopPlayer.maxHp * 0.3)
            );
            coopPlayer.invulnerability = 1.5;
            coopPlayer.x = beacon.x;
            coopPlayer.y = beacon.y;
            coopPlayer.reviveBeacon = null;

            for (const bullet of world.bullets.values()) {
              if (bullet.ownerId === coopPlayer.id) {
                bullet.state = "held";
                bullet.x = beacon.x;
                bullet.y = beacon.y;
                bullet.vx = 0;
                bullet.vy = 0;
                bullet.bounces = 0;
              }
            }
          }
        }
      }

      continue;
    }

    updateServerCoopPlayer(
      world,
      coopPlayer,
      dt,
      currentTime
    );
  }

  if (world.gameOver) {
    return;
  }

  updateServerEnemies(
    world,
    dt
  );

  updateServerEnemyProjectiles(
    world,
    dt
  );

  for (
    const bullet of
    world.bullets.values()
  ) {
    updateServerBullet(
      room,
      bullet,
      dt
    );
  }

  updateServerParasites(
    world,
    dt
  );

  updateServerSplinters(
    world,
    dt
  );

  updateServerMedkits(
    room,
    dt
  );

  updateServerExperienceCrystals(
    room,
    dt
  );

  updateServerWave(
    world,
    dt
  );
}

function createServerEnemy(
  world,
  type,
  x,
  y,
  spawnedInside = false
) {
  const base = createEnemyBase(type, world.wave);

  const hpMultiplier =
    type === "boss"
      ? COOP_BOSS_HP_MULTIPLIER
      : COOP_ENEMY_HP_MULTIPLIER;

  const hp = Math.max(
    1,
    Math.round(base.hp * hpMultiplier)
  );

  // Server-only: shooter gets random preferred distance and cooldown
  let shootCooldown = base.shootCooldown || 0;
  let radialCooldown = base.radialCooldown || 0;
  let preferredDistance = 0;
  let strafeDirection = Math.random() < 0.5 ? -1 : 1;

  if (type === "shooter") {
    preferredDistance = random(260, 360);
    shootCooldown = random(0.8, 1.8);
  }

  const enemy = {
    id: world.nextEnemyId++,
    type: base.type,
    x, y,
    r: base.r,
    speed: base.speed,
    hp,
    maxHp: hp,
    color: base.color,
    bossTier: base.bossTier,

    spawnEdge: null,
    spawnWarningX: x,
    spawnWarningY: y,
    spawnDelay: 0,
    hasEnteredArena: spawnedInside,

    contactCooldown: 0,
    isCharging: false,
    chargeState: "idle",
    chargeCooldown: 1.2,
    chargeTimer: 0,
    chargeDx: 0,
    chargeDy: 0,
    preferredDistance,
    shootCooldown,
    radialCooldown,
    strafeDirection,
    phase: 0,

    // Boss AI fields from shared (or defaults for non-boss):
    dashState: base.dashState || "none",
    dashCooldown: base.dashCooldown || 3.5,
    dashTimer: base.dashTimer || 0,
    dashDx: base.dashDx || 0,
    dashDy: base.dashDy || 0,

    sniperState: base.sniperState || "none",
    sniperCooldown: base.sniperCooldown || 4.5,
    sniperTimer: base.sniperTimer || 0,
    sniperTargetX: base.sniperTargetX || 0,
    sniperTargetY: base.sniperTargetY || 0,

    spiralActive: base.spiralActive || false,
    spiralCooldown: base.spiralCooldown || 6.0,
    spiralTimer: base.spiralTimer || 0,
    spiralTicks: base.spiralTicks || 0,
    spiralBaseAngle: base.spiralBaseAngle || 0,

    shieldActive: base.shieldActive || false,
    shieldTriggered: base.shieldTriggered || false,
    stunTimer: base.stunTimer || 0,

    // Type-specific fields:
    phaseTimer: type === "phantom" ? 0 : undefined,
    isPhased: type === "phantom" ? true : undefined,
    twinPartnerId: type === "twin" ? null : undefined,
    isEnraged: type === "twin" ? false : undefined,
    targetMarked: false,
    targetMarkTimer: 0,
    spawnTimer: type === "incubator" ? 4.5 : undefined,
    sporesCount: type === "incubator" ? 5 : undefined,
    turnRate: base.turnRate,
    facingAngle: base.turnRate ? (base.facingAngle || 0) : undefined,
    spawnTime: type === "mirage" ? Date.now() / 1000 : undefined,
    mirageVisible: type === "mirage" ? false : undefined
  };

  return enemy;
}

function randomServerSpawnPoint() {
  const side =
    Math.floor(Math.random() * 4);

  const margin = 110;
  const edgePadding = 70;

  if (side === 0) {
    const x = random(
      edgePadding,
      COOP_WORLD_WIDTH - edgePadding
    );

    return {
      x,
      y: -margin,
      side: "top",
      warningX: x,
      warningY: 0
    };
  }

  if (side === 1) {
    const y = random(
      edgePadding,
      COOP_WORLD_HEIGHT - edgePadding
    );

    return {
      x: COOP_WORLD_WIDTH + margin,
      y,
      side: "right",
      warningX: COOP_WORLD_WIDTH,
      warningY: y
    };
  }

  if (side === 2) {
    const x = random(
      edgePadding,
      COOP_WORLD_WIDTH - edgePadding
    );

    return {
      x,
      y: COOP_WORLD_HEIGHT + margin,
      side: "bottom",
      warningX: x,
      warningY: COOP_WORLD_HEIGHT
    };
  }

  const y = random(
    edgePadding,
    COOP_WORLD_HEIGHT - edgePadding
  );

  return {
    x: -margin,
    y,
    side: "left",
    warningX: 0,
    warningY: y
  };
}

function spawnServerEnemyFromEdge(
  world,
  type
) {
  const position =
    randomServerSpawnPoint();

  const enemy =
    createServerEnemy(
      world,
      type,
      position.x,
      position.y
    );

  enemy.spawnEdge =
    position.side;

  enemy.spawnWarningX =
    position.warningX;

  enemy.spawnWarningY =
    position.warningY;

  enemy.spawnDelay =
    random(0.7, 1);

  enemy.hasEnteredArena = false;

  world.enemies.set(
    enemy.id,
    enemy
  );

  return enemy;
}

function spawnServerWave(world) {
  const difficulty =
    COOP_DIFFICULTY[
      world.difficulty
    ] ||
    COOP_DIFFICULTY.normal;

  const isBossWave =
    world.wave % 5 === 0;

  if (isBossWave) {
    spawnServerEnemyFromEdge(
      world,
      "boss"
    );

    const bossTier = Math.max(
      1,
      Math.floor(world.wave / 5)
    );

    let escortPool = ["runner"];
    let escortCount = 2;

    if (bossTier === 2) {
      escortPool = ["tank", "shooter", "magnetizer", "phantom"];
      escortCount = 5;
    } else if (bossTier === 3) {
      escortPool = ["splitter", "charger", "shooter", "phantom", "magnetizer", "twin", "mirage"];
      escortCount = 6;
    } else if (bossTier >= 4) {
      escortPool = ["splitter", "charger", "tank", "runner", "shooter", "phantom", "magnetizer", "twin", "mirage", "sentinel"];
      escortCount = 6 + Math.min(bossTier, 4);
    }

    for (let i = 0; i < escortCount; i++) {
      const escortType = escortPool[i % escortPool.length];
      if (escortType === "twin") {
        const twinA = spawnServerEnemyFromEdge(world, "twin");
        const twinB = spawnServerEnemyFromEdge(world, "twin");
        if (twinA && twinB) {
          twinA.twinPartnerId = twinB.id;
          twinB.twinPartnerId = twinA.id;
        }
      } else {
        spawnServerEnemyFromEdge(world, escortType);
      }
    }

    return;
  }

  const enemyCount = Math.min(
    Math.round(
      (5 + world.wave * 2) *
      difficulty.enemyCount *
      COOP_ENEMY_COUNT_MULTIPLIER
    ),
    70
  );

  for (
    let i = 0;
    i < enemyCount;
    i++
  ) {
    const roll = Math.random();

    let type = "normal";

    if (
      world.wave >= 12 &&
      roll < 0.06
    ) {
      type = "twin";
    } else if (
      world.wave >= 10 &&
      roll < 0.10
    ) {
      type = "phantom";
    } else if (
      world.wave >= 8 &&
      roll < 0.15
    ) {
      type = "magnetizer";
    } else if (
      world.wave >= 9 &&
      roll < 0.18
    ) {
      type = "sentinel";
    } else if (
      world.wave >= 6 &&
      roll < 0.20
    ) {
      type = "incubator";
    } else if (
      world.wave >= 7 &&
      roll < 0.24
    ) {
      type = "mirage";
    } else if (
      world.wave >= 7 &&
      roll < 0.28
    ) {
      type = "splitter";
    } else if (
      world.wave >= 5 &&
      roll < 0.34
    ) {
      type = "shooter";
    } else if (
      world.wave >= 4 &&
      roll < 0.42
    ) {
      type = "charger";
    } else if (
      world.wave >= 3 &&
      roll < (world.wave === 3 ? 0.18 : 0.40)
    ) {
      type = "tank";
    } else if (
      world.wave >= 2 &&
      roll < 0.76
    ) {
      type = "runner";
    }

    /*
     * Связанные Близнецы спавнятся парами.
     */
    if (type === "twin") {
      const twinA = spawnServerEnemyFromEdge(world, "twin");
      const twinB = spawnServerEnemyFromEdge(world, "twin");
      if (twinA && twinB) {
        twinA.twinPartnerId = twinB.id;
        twinB.twinPartnerId = twinA.id;
      }
    } else {
      spawnServerEnemyFromEdge(
        world,
        type
      );
    }
  }
}

function createServerPlayerStats() {
  return {
    ...createPlayerStats(),
    // server-specific fields:
    magnetRangeBonusCells: 0,
    poison: false,
    poisonDamageRatio: 0.5,
    poisonDuration: 2.0,
    parasite: false,
    parasiteChance: 0.25,
    parasiteCount: 1,
    parasiteDamageRatio: 0.75
  };
}

const SERVER_UPGRADE_RARITIES = {
  common: {
    key: "common",
    label: "ОБЫЧНОЕ",
    power: 1
  },

  rare: {
    key: "rare",
    label: "РЕДКОЕ",
    power: 2
  },

  legendary: {
    key: "legendary",
    label: "ЛЕГЕНДАРНОЕ",
    power: 3
  }
};

const SERVER_UPGRADES = UPGRADE_DEFS;

function shuffleServerArray(array) {
  for (
    let index = array.length - 1;
    index > 0;
    index--
  ) {
    const target =
      Math.floor(
        Math.random() *
        (index + 1)
      );

    [
      array[index],
      array[target]
    ] = [
      array[target],
      array[index]
    ];
  }

  return array;
}

function rollServerUpgradeRarity(upgrade) {
  if (
    upgrade.fixedRarity &&
    SERVER_UPGRADE_RARITIES[
      upgrade.fixedRarity
    ]
  ) {
    return SERVER_UPGRADE_RARITIES[
      upgrade.fixedRarity
    ];
  }

  const roll = Math.random();

  if (roll < 0.08) {
    return SERVER_UPGRADE_RARITIES.legendary;
  }

  if (roll < 0.33) {
    return SERVER_UPGRADE_RARITIES.rare;
  }

  return SERVER_UPGRADE_RARITIES.common;
}

function createServerUpgradeOffers(player) {
  const available = SERVER_UPGRADES.filter(
    upgrade =>
      typeof upgrade.available !== "function" ||
      upgrade.available(player)
  );

  return shuffleServerArray(
    [...available]
  )
    .slice(0, 3)
    .map(upgrade => {
      const rarity =
        rollServerUpgradeRarity(upgrade);

      return {
        upgradeId: upgrade.id,
        title: upgrade.title,
        description:
          upgrade.description,

        rarityKey: rarity.key,
        rarityLabel: rarity.label,
        power: rarity.power,

        bonusText:
          upgrade.bonus(
            player,
            rarity.power
          )
      };
    });
}

function createCoopWorld(room) {
  const roomPlayers = [
    ...room.players.values()
  ].sort((first, second) => {
    if (first.role === "host") {
      return -1;
    }

    if (second.role === "host") {
      return 1;
    }

    return 0;
  });

  const difficulty =
    COOP_DIFFICULTY[
      room.difficulty
    ] ||
    COOP_DIFFICULTY.normal;

  const spawnPositions = [
    {
      x: COOP_WORLD_WIDTH / 2 - 70,
      y: COOP_WORLD_HEIGHT / 2
    },

    {
      x: COOP_WORLD_WIDTH / 2 + 70,
      y: COOP_WORLD_HEIGHT / 2
    }
  ];

  const world = {
    difficulty:
      room.difficulty || "normal",

    players: new Map(),
    bullets: new Map(),
    enemies: new Map(),
    enemyProjectiles: new Map(),
    splinters: new Map(),
    parasites: new Map(),
    experienceCrystals: new Map(),
    medkits: new Map(),
    nextMedkitId: 1,
    nextProjectileId: 1,

    nextBulletId: 1,
    nextEnemyId: 1,
    nextCrystalId: 1,
    nextUpgradeRoundId: 1,

    wave: 1,
    kills: 0,
    score: 0,

    level: 1,
    experience: 0,

    experienceToNext:
      getServerExperienceRequirement(1),

    pendingLevelUps: 0,
    upgradePaused: false,
    manualPaused: false,
    upgradeRound: null,

    wavePending: false,
    waveClearTimer: 0,

    gameOver: false,
    snapshotAccumulator: 0
  };

  roomPlayers.forEach(
    (roomPlayer, index) => {
      const position =
        spawnPositions[index] ||
        spawnPositions[0];

      const coopPlayer = {
        id: roomPlayer.id,
        name: roomPlayer.name,
        bulletSkin: roomPlayer.bulletSkin || "neon",
        playerSkin: roomPlayer.playerSkin || "cyan",
      
        x: position.x,
        y: position.y,
      
        aimX: COOP_WORLD_WIDTH / 2,
        aimY: COOP_WORLD_HEIGHT / 2,
      
        r: 18,
        colorIndex: index,
      
        hp: difficulty.playerHp,
        maxHp: difficulty.playerHp,
      
        alive: true,
        invulnerability: 0,
        repairHealCooldown: 0,
      
        stats: createServerPlayerStats(),
      
        selectedUpgrades: [],
      
        input: sanitizeInput({}),
        lastInputAt: Date.now()
      };

      world.players.set(
        coopPlayer.id,
        coopPlayer
      );
    }
  );

  for (
    const coopPlayer of
    world.players.values()
  ) {
    createServerBullet(
      world,
      coopPlayer
    );
  }

  spawnServerWave(world);

  return world;
}

function getNearestAliveServerPlayer(
  world,
  enemy
) {
  /*
   * Близнец в ярости: приоритет — убийца брата.
   */
  if (enemy.revengeTargetId) {
    const revengeTarget = world.players.get(enemy.revengeTargetId);
    if (revengeTarget && revengeTarget.alive) {
      return revengeTarget;
    }
    enemy.revengeTargetId = null;
  }

  let nearestPlayer = null;
  let nearestDistance = Infinity;

  for (
    const coopPlayer of
    world.players.values()
  ) {
    if (!coopPlayer.alive) {
      continue;
    }

    const currentDistance =
      distance(
        enemy.x,
        enemy.y,
        coopPlayer.x,
        coopPlayer.y
      );

    if (
      currentDistance <
      nearestDistance
    ) {
      nearestDistance =
        currentDistance;

      nearestPlayer =
        coopPlayer;
    }
  }

  return nearestPlayer;
}

function isServerEnemyInside(enemy) {
  return (
    enemy.x - enemy.r >= 0 &&
    enemy.x + enemy.r <=
      COOP_WORLD_WIDTH &&
    enemy.y - enemy.r >= 0 &&
    enemy.y + enemy.r <=
      COOP_WORLD_HEIGHT
  );
}

function getServerEnemyEntryTarget(enemy) {
  const inset = enemy.r + 8;

  if (enemy.spawnEdge === "top") {
    return { x: enemy.spawnWarningX, y: inset };
  }

  if (enemy.spawnEdge === "right") {
    return {
      x: COOP_WORLD_WIDTH - inset,
      y: enemy.spawnWarningY
    };
  }

  if (enemy.spawnEdge === "bottom") {
    return {
      x: enemy.spawnWarningX,
      y: COOP_WORLD_HEIGHT - inset
    };
  }

  return { x: inset, y: enemy.spawnWarningY };
}

function damageServerPlayer(
  world,
  coopPlayer,
  amount
) {
  if (
    coopPlayer._godMode ||
    !coopPlayer.alive ||
    coopPlayer.invulnerability > 0 ||
    world.gameOver
  ) {
    return false;
  }

  coopPlayer.hp = Math.max(
    0,
    coopPlayer.hp - amount * (1 - (coopPlayer.stats?.damageResistance || 0))
  );

  coopPlayer.invulnerability =
    COOP_PLAYER_INVULNERABILITY;

  /*
   * Реактивная Броня: взрыв, отбрасывающий врагов
   * в радиусе reactiveArmorRadius (базово 120px). Кулдаун 3 секунды.
   */
  if (
    coopPlayer.stats?.reactiveArmor &&
    (coopPlayer.reactiveArmorCooldown || 0) <= 0
  ) {
    coopPlayer.reactiveArmorCooldown = coopPlayer.stats?.reactiveArmorCooldownBase || 3.0;
    const armorRadius = coopPlayer.stats?.reactiveArmorRadius || 120;

    for (const enemy of world.enemies.values()) {
      if (!enemy.hasEnteredArena) continue;

      const dist = distance(
        coopPlayer.x, coopPlayer.y,
        enemy.x, enemy.y
      );

      if (dist <= armorRadius && dist > 0) {
        const pushForce = 180;
        const dx = enemy.x - coopPlayer.x;
        const dy = enemy.y - coopPlayer.y;

        enemy.x += (dx / dist) * pushForce;
        enemy.y += (dy / dist) * pushForce;
      }
    }
  }

  if (coopPlayer.hp <= 0) {
    /*
     * Воскрешение: если у игрока есть бонус и он ещё не использован,
     * вместо мгновенной смерти входим в состояние revive-prompt.
     * Клиент показывает QTE (5× пробел за 5 сек).
     */
    if (
      coopPlayer.stats?.resurrection &&
      !coopPlayer.stats?.resurrectionUsed &&
      !coopPlayer.revivePrompt
    ) {
      coopPlayer.hp = 0;
      coopPlayer.revivePrompt = {
        active: true,
        presses: 0,
        required: 5,
        timer: 5.0,
        startedAt: Date.now()
      };
      coopPlayer.invulnerability = 5.5;
      return true;
    }

    coopPlayer.alive = false;

    /*
     * Маяк воскрешения: появляется на месте гибели,
     * но только если есть живой партнёр (не в соло).
     */
    const remainingAlive = [
      ...world.players.values()
    ].filter(player => player.alive);

    if (remainingAlive.length > 0) {
      coopPlayer.reviveBeacon = {
        x: coopPlayer.x,
        y: coopPlayer.y,
        progress: 0,
        requiredTime: 3.0,
        radius: 70,
        active: true
      };
    }

    const alivePlayers = [
      ...world.players.values()
    ].filter(player => player.alive);

    if (alivePlayers.length === 0) {
      world.gameOver = true;
      for (const p of world.players.values()) {
        if (p.reviveBeacon) p.reviveBeacon = null;
      }
      const r = [...rooms.values()].find(rm => rm.world === world);
      if (r) {
        cancelRoomCountdown(r);
        for (const p of r.players.values()) {
          p.ready = false;
        }
        io.to(r.code).emit("net:snapshot", createServerCoopSnapshot(r));
        emitRoomState(r);
      }
    }
  }

  return true;
}

function getServerContactDamage(
  world,
  enemy
) {
  return getContactDamage(world.wave, enemy);
}

function getServerEnemyExperience(enemy) {
  return getEnemyExperience(enemy);
}

function createServerExperienceCrystal(
  world,
  x,
  y,
  value = 125
) {
  const angle =
    Math.random() * Math.PI * 2;

  const speed =
    random(45, 125);

  const crystal = {
    id: world.nextCrystalId++,

    x,
    y,

    vx:
      Math.cos(angle) * speed,

    vy:
      Math.sin(angle) * speed,

    value,
    r: COOP_CRYSTAL_RADIUS,
    age: 0
  };

  world.experienceCrystals.set(
    crystal.id,
    crystal
  );
}

function dropServerExperience(
  world,
  enemy
) {
  // Миньоны (от инкубатора) и осколки (от сплитера) не дропают опыт
  if (enemy.type === "shard" || enemy.type === "minion") {
    return;
  }

  const xp = getServerEnemyExperience(enemy);

  createServerExperienceCrystal(
    world,
    enemy.x + random(-6, 6),
    enemy.y + random(-6, 6),
    xp
  );
}

function registerServerRepairKill(player) {
  if (!player || !player.alive || (player.stats?.healEvery || 0) <= 0 || (player.repairHealCooldown || 0) > 0) {
    return;
  }

  player.stats.repairKillProgress = (player.stats.repairKillProgress || 0) + 1;

  if (player.stats.repairKillProgress >= player.stats.healEvery) {
    if (player.hp >= player.maxHp) {
      player.stats.repairKillProgress = Math.max(0, player.stats.healEvery - 1);
    } else {
      player.stats.repairKillProgress = 0;
      player.repairHealCooldown = COOP_REPAIR_HEAL_COOLDOWN;
      player.hp = Math.min(player.maxHp, player.hp + 100);
    }
  }
}

function killServerEnemy(
  world,
  enemy,
  killerPlayer
) {
  if (!world.enemies.has(enemy.id)) {
    return;
  }

  dropServerExperience(
    world,
    enemy
  );

  if (enemy.parasiteInfested && world.parasites) {
    const pCount = enemy.parasiteCount || 1;
    const pDamage = enemy.parasiteDamage || ((killerPlayer?.stats?.damage || 100) * (killerPlayer?.stats?.parasiteDamageRatio || 0.75));
    for (let pi = 0; pi < pCount; pi++) {
      const angle = Math.random() * Math.PI * 2;
      const sporeSpeed = 320;
      const parasiteId = world.nextEnemyId++;
      world.parasites.set(parasiteId, {
        id: parasiteId,
        ownerId: enemy.parasiteOwnerId || killerPlayer?.id || null,
        x: enemy.x,
        y: enemy.y,
        vx: Math.cos(angle) * sporeSpeed,
        vy: Math.sin(angle) * sporeSpeed,
        damage: pDamage,
        life: 2.0,
        r: 5
      });
    }
  }

  /*
   * При гибели миньона родительский инкубатор восстанавливает 1 спору на свою орбиту.
   */
  if (enemy.type === "minion" && enemy.parentId) {
    const parent = world.enemies.get(enemy.parentId);
    if (parent && parent.type === "incubator") {
      parent.sporesCount = Math.min(5, (parent.sporesCount ?? 0) + 1);
    }
  }

  world.enemies.delete(enemy.id);

  world.kills += 1;

  // 5% шанс выпадения аптечки (+100 HP) только из основных мобов (не из осколков сплиттера или личинок инкубатора)
  const isSubEnemy = enemy.type === "shard" || enemy.type === "minion";
  if (!isSubEnemy && Math.random() < 0.05 && world.medkits) {
    const medkitId = world.nextMedkitId++;
    world.medkits.set(medkitId, {
      id: medkitId,
      x: Math.round(enemy.x),
      y: Math.round(enemy.y),
      r: 12,
      heal: 100,
      life: 35.0
    });
  }

  if (killerPlayer) {
    registerServerRepairKill(killerPlayer);
  } else {
    for (const player of world.players.values()) {
      registerServerRepairKill(player);
    }
  }

  if (enemy.type === "boss") {
    for (const player of world.players.values()) {
      player.rerolls = (player.rerolls || 0) + 1;
    }
  }

  world.score +=
    enemy.type === "boss"
      ? 250 * world.wave
      : 10 * world.wave;

  if (enemy.type === "splitter") {
    for (
      let side = -1;
      side <= 1;
      side += 2
    ) {
      const shard =
        createServerEnemy(
          world,
          "shard",
          enemy.x + side * 15,
          enemy.y + random(-8, 8),
          true
        );

      world.enemies.set(
        shard.id,
        shard
      );
    }
  }

  /*
   * Угловые генераторы щита босса: при уничтожении последнего
   * щит босса спадает, босс оглушается на 2 секунды, а блокировка урона полностью снимается!
   */
  if ((enemy.type === "boss_drone" || enemy.type === "boss_pylon") && enemy.bossId) {
    const remainingPylons = [...world.enemies.values()].filter(
      e => (e.type === "boss_drone" || e.type === "boss_pylon") && e.bossId === enemy.bossId && e.hp > 0
    );
    if (remainingPylons.length === 0) {
      const boss = world.enemies.get(enemy.bossId);
      if (boss && boss.shieldActive) {
        boss.shieldActive = false;
        boss.stunTimer = 2.0;
        boss.dashState = "none";
        boss.sniperState = "none";
        boss.spiralActive = false;
      }
    }
  }

  /*
   * Связанные Близнецы: при гибели одного
   * партнёр впадает в ярость (+50% speed).
   */
  if (
    enemy.type === "twin" &&
    enemy.twinPartnerId != null
  ) {
    const partner = world.enemies.get(
      enemy.twinPartnerId
    );

    if (partner && !partner.isEnraged) {
      partner.isEnraged = true;
      partner.speed *= 1.5;
      partner.color = "#ff2244";
      partner.twinPartnerId = null;
      if (killerPlayer) {
        partner.revengeTargetId = killerPlayer.id;
      }
    }
  }
}

function damageServerEnemy(
  world,
  enemyId,
  amount,
  killerPlayer,
  hitAngle
) {
  const enemy =
    world.enemies.get(enemyId);

  if (!enemy) {
    return false;
  }

  /*
   * Фантом в фазе неуязвимости не получает урон.
   * Проверяем и флаг, и таймер — таймер авторитетнее,
   * если phaseTimer ещё не обновился в текущем тике.
   */
  if (enemy.type === "phantom") {
    const effectivelyPhased =
      enemy.isPhased === true &&
      (enemy.phaseTimer || 0) < 2.0;

    if (effectivelyPhased) {
      return false;
    }
  }

  if (enemy.type === "boss" && enemy.shieldActive) {
    amount = Math.max(1, Math.floor(amount * 0.2));
  }

  /*
   * Часовой: щит спереди блокирует 80% урона (сектор ~130°),
   * с боков и со спины урон проходит полностью.
   */
  if (enemy.type === "sentinel" && hitAngle !== undefined) {
    const FRONT_ARC_HALF = Math.PI / 2.77;
    const diff = Math.atan2(
      Math.sin(hitAngle - (enemy.facingAngle || 0)),
      Math.cos(hitAngle - (enemy.facingAngle || 0))
    );
    if (Math.abs(diff) <= FRONT_ARC_HALF) {
      amount = amount * 0.2;
    }
  }

  /*
   * Метка Цели: помеченный враг получает дополнительный урон (+5% за уровень, до +40%).
   */
  if (enemy.targetMarked) {
    const markBonus = enemy.targetMarkBonus || enemy.markBonus || (killerPlayer?.stats?.markBonus) || 0.40;
    amount = Number((amount * (1 + markBonus)).toFixed(2));
  }

  enemy.hp -= amount;

  if (killerPlayer) {
    killerPlayer.totalDamageDealt = (killerPlayer.totalDamageDealt || 0) + amount;
  }

  if (enemy.hp <= 0) {
    killServerEnemy(
      world,
      enemy,
      killerPlayer
    );

    return true;
  }

  return false;
}

function resolveServerEnemyOverlaps(
  world
) {
  const enemyList = [
    ...world.enemies.values()
  ];

  for (
    let i = 0;
    i < enemyList.length;
    i++
  ) {
    const first = enemyList[i];

    for (
      let j = i + 1;
      j < enemyList.length;
      j++
    ) {
      const second =
        enemyList[j];

      let dx =
        second.x - first.x;

      let dy =
        second.y - first.y;

      let currentDistance =
        Math.hypot(dx, dy);

      const minimumDistance =
        first.r + second.r + 3;

      if (
        currentDistance >=
        minimumDistance
      ) {
        continue;
      }

      if (currentDistance < 0.001) {
        const angle =
          Math.random() *
          Math.PI *
          2;

        dx = Math.cos(angle);
        dy = Math.sin(angle);
        currentDistance = 1;
      } else {
        dx /= currentDistance;
        dy /= currentDistance;
      }

      const overlap =
        minimumDistance -
        currentDistance;

      let firstWeight = 0.5;
      let secondWeight = 0.5;

      if (first.type === "boss") {
        firstWeight = 0.08;
        secondWeight = 0.92;
      } else if (
        second.type === "boss"
      ) {
        firstWeight = 0.92;
        secondWeight = 0.08;
      } else if (
        first.type === "tank"
      ) {
        firstWeight = 0.28;
        secondWeight = 0.72;
      } else if (
        second.type === "tank"
      ) {
        firstWeight = 0.72;
        secondWeight = 0.28;
      }

      first.x -=
        dx * overlap * firstWeight;

      first.y -=
        dy * overlap * firstWeight;

      second.x +=
        dx * overlap * secondWeight;

      second.y +=
        dy * overlap * secondWeight;
    }
  }
}

function createServerEnemyProjectile(
  world,
  x,
  y,
  angle,
  speed,
  radius = 5,
  color = "#67ff9a",
  damage = 100
) {
  const projectile = {
    id: world.nextProjectileId++,
    x,
    y,
    vx: Math.cos(angle) * speed,
    vy: Math.sin(angle) * speed,
    r: radius,
    color,
    damage
  };

  world.enemyProjectiles.set(projectile.id, projectile);
}

function shootServerEnemyProjectile(world, enemy, target) {
  const angle = Math.atan2(
    target.y - enemy.y,
    target.x - enemy.x
  );

  const projectileSpeed = 290 + world.wave * 5;

  createServerEnemyProjectile(
    world,
    enemy.x + Math.cos(angle) * (enemy.r + 7),
    enemy.y + Math.sin(angle) * (enemy.r + 7),
    angle,
    projectileSpeed,
    5,
    "#67ff9a",
    100
  );
}

function shootServerBossSpread(world, enemy, target, phase) {
  const baseAngle = Math.atan2(
    target.y - enemy.y,
    target.x - enemy.x
  );

  const progressionTier = Math.max(0, (enemy.bossTier || 1) - 1);
  const projectileCount = 3 + phase + Math.min(progressionTier, 3);
  const spread = 0.18;
  const speed = 235 + progressionTier * 22;

  for (let i = 0; i < projectileCount; i++) {
    const offset = (i - (projectileCount - 1) / 2) * spread;
    const angle = baseAngle + offset;

    createServerEnemyProjectile(
      world,
      enemy.x + Math.cos(angle) * (enemy.r + 8),
      enemy.y + Math.sin(angle) * (enemy.r + 8),
      angle,
      speed,
      7.5,
      "#ff4f91",
      100
    );
  }

  // На 2 и 3 фазе босс также стреляет во второго игрока
  if (phase >= 1) {
    const otherPlayer = [...world.players.values()].find(p => p.alive && p.id !== target.id);
    if (otherPlayer) {
      const otherAngle = Math.atan2(otherPlayer.y - enemy.y, otherPlayer.x - enemy.x);
      for (let i = 0; i < projectileCount; i++) {
        const offset = (i - (projectileCount - 1) / 2) * spread;
        const angle = otherAngle + offset;
        createServerEnemyProjectile(
          world,
          enemy.x + Math.cos(angle) * (enemy.r + 8),
          enemy.y + Math.sin(angle) * (enemy.r + 8),
          angle,
          speed,
          7.5,
          "#ff4f91",
          100
        );
      }
    }
  }
}

function shootServerBossRadial(world, enemy, phase) {
  const progressionTier = Math.max(0, (enemy.bossTier || 1) - 1);
  const projectileCount = 8 + phase * 2 + Math.min(progressionTier * 2, 6);
  const speed = 155 + phase * 20 + progressionTier * 18;
  const rotation = Date.now() * 0.001;

  for (let i = 0; i < projectileCount; i++) {
    const angle = rotation + (Math.PI * 2 * i) / projectileCount;

    createServerEnemyProjectile(
      world,
      enemy.x + Math.cos(angle) * (enemy.r + 5),
      enemy.y + Math.sin(angle) * (enemy.r + 5),
      angle,
      speed,
      7,
      "#ff9b45",
      100
    );
  }
}

function shootServerBossShockwave(world, enemy) {
  const count = 8;
  const speed = 190;
  for (let i = 0; i < count; i++) {
    const angle = (Math.PI * 2 * i) / count;
    createServerEnemyProjectile(
      world,
      enemy.x + Math.cos(angle) * (enemy.r + 6),
      enemy.y + Math.sin(angle) * (enemy.r + 6),
      angle,
      speed,
      6.5,
      "#ff496c",
      100
    );
  }
}

function shootServerBossSniperBolt(world, enemy, targetX, targetY) {
  const angle = Math.atan2(targetY - enemy.y, targetX - enemy.x);
  createServerEnemyProjectile(
    world,
    enemy.x + Math.cos(angle) * (enemy.r + 10),
    enemy.y + Math.sin(angle) * (enemy.r + 10),
    angle,
    900,
    9,
    "#ff1744",
    200
  );
}

function spawnServerBossDrones(world, boss) {
  boss.shieldActive = true;
  boss.shieldTriggered = true;

  const cornerMargin = 180;
  const corners = [
    { x: cornerMargin, y: cornerMargin },
    { x: COOP_WORLD_WIDTH - cornerMargin, y: cornerMargin },
    { x: cornerMargin, y: COOP_WORLD_HEIGHT - cornerMargin },
    { x: COOP_WORLD_WIDTH - cornerMargin, y: COOP_WORLD_HEIGHT - cornerMargin }
  ];

  for (let i = 0; i < corners.length; i++) {
    const drone = createServerEnemy(world, "boss_drone", corners[i].x, corners[i].y, true);
    drone.bossId = boss.id;
    drone.hp = 2500;
    drone.maxHp = 2500;
    drone.speed = 0;
    drone.r = 24;
    drone.color = "#00f2fe";
    drone.hasEnteredArena = true;
    drone.immobile = true;
    world.enemies.set(drone.id, drone);
  }
}

function updateServerEnemyProjectiles(world, dt) {
  for (const projectile of world.enemyProjectiles.values()) {
    projectile.x += projectile.vx * dt;
    projectile.y += projectile.vy * dt;

    if (
      projectile.x < -60 ||
      projectile.x > COOP_WORLD_WIDTH + 60 ||
      projectile.y < -60 ||
      projectile.y > COOP_WORLD_HEIGHT + 60
    ) {
      world.enemyProjectiles.delete(projectile.id);
      continue;
    }

    for (const player of world.players.values()) {
      if (!player.alive) continue;

      const currentDist = Math.hypot(
        projectile.x - player.x,
        projectile.y - player.y
      );

      if (currentDist <= projectile.r + player.r) {
        damageServerPlayer(world, player, projectile.damage || 1);
        world.enemyProjectiles.delete(projectile.id);
        break;
      }
    }
  }
}

function updateServerEnemies(
  world,
  dt
) {
  const difficulty =
    COOP_DIFFICULTY[
      world.difficulty
    ] ||
    COOP_DIFFICULTY.normal;

  for (
    const enemy of
    world.enemies.values()
  ) {
    if (!Number.isFinite(enemy.x) || !Number.isFinite(enemy.y)) {
      enemy.x = COOP_WORLD_WIDTH / 2;
      enemy.y = COOP_WORLD_HEIGHT / 2;
      enemy.hasEnteredArena = true;
    }

    enemy.contactCooldown =
      Math.max(
        0,
        enemy.contactCooldown - dt
      );

    enemy.isCharging = false;

    if (
      enemy.spawnEdge &&
      !enemy.hasEnteredArena
    ) {
      if (!Number.isFinite(enemy.spawnDelay)) {
        enemy.spawnDelay = 0;
      }

      enemy.spawnDelay =
        Math.max(
          0,
          enemy.spawnDelay - dt
        );

      if (enemy.spawnDelay > 0) {
        continue;
      }

      const entryTarget =
        getServerEnemyEntryTarget(enemy);

      const targetX = Number.isFinite(entryTarget.x) ? entryTarget.x : COOP_WORLD_WIDTH / 2;
      const targetY = Number.isFinite(entryTarget.y) ? entryTarget.y : COOP_WORLD_HEIGHT / 2;

      const entryDx = targetX - enemy.x;
      const entryDy = targetY - enemy.y;
      const entryDistance =
        Math.hypot(entryDx, entryDy) || 1;

      const entryStep =
        enemy.speed *
        difficulty.enemySpeed *
        1.25 *
        dt;

      enemy.x +=
        entryDx / entryDistance *
        Math.min(entryStep, entryDistance);

      enemy.y +=
        entryDy / entryDistance *
        Math.min(entryStep, entryDistance);

      enemy.outOfBoundsTimer = (enemy.outOfBoundsTimer || 0) + dt;

      if (isServerEnemyInside(enemy) || enemy.outOfBoundsTimer > 5.0) {
        enemy.hasEnteredArena = true;
      }

      continue;
    }

    /*
     * Таймер метки цели — декремент и сброс.
     */
    if (enemy.targetMarkTimer > 0) {
      enemy.targetMarkTimer = Math.max(
        0,
        enemy.targetMarkTimer - dt
      );

      if (enemy.targetMarkTimer <= 0) {
        enemy.targetMarked = false;
        enemy.targetMarkTimer = 0;
      }
    }

    /*
     * Фантом: цикл фазирования 5с (2с невидим, 3с уязвим).
     */
    if (enemy.type === "phantom") {
      enemy.phaseTimer = (enemy.phaseTimer || 0) + dt;

      if (enemy.phaseTimer >= 5.0) {
        enemy.phaseTimer -= 5.0;
      }

      enemy.isPhased = enemy.phaseTimer < 2.0;
    }

    /*
     * Яд: периодический урон раз в 1.0с.
     */
    if (enemy.poisonTimer > 0) {
      enemy.poisonTimer = Math.max(0, enemy.poisonTimer - dt);
      enemy.poisonTickTimer = (enemy.poisonTickTimer || 1.0) - dt;
      if (enemy.poisonTickTimer <= 0) {
        enemy.poisonTickTimer = 1.0;
        const pOwner = world.players.get(enemy.poisonOwnerId) || null;
        damageServerEnemy(world, enemy.id, enemy.poisonDamage || 50, pOwner);
        if (!world.enemies.has(enemy.id) || enemy.hp <= 0) {
          continue;
        }
      }
    }

    /*
     * Инкубатор: каждые 4.5 секунды порождает 1 личинку (minion), максимум 5 живых.
     */
    if (enemy.type === "incubator" && enemy.hasEnteredArena && enemy.hp > 0 && (enemy.stunTimer || 0) <= 0) {
      enemy.spawnTimer = (enemy.spawnTimer || 4.5) - dt;
      if (enemy.spawnTimer <= 0) {
        enemy.spawnTimer = 4.5;
        // Считаем живых миньонов этого инкубатора
        let livingMinions = 0;
        for (const e of world.enemies.values()) {
          if (e.type === "minion" && e.parentId === enemy.id && e.hp > 0) {
            livingMinions++;
          }
        }
        if (livingMinions < 5 && (enemy.sporesCount ?? 5) > 0) {
          enemy.sporesCount = Math.max(0, (enemy.sporesCount ?? 5) - 1);
          const angle = Math.random() * Math.PI * 2;
          const dist = 28 + Math.random() * 16;
          const mx = clamp(enemy.x + Math.cos(angle) * dist, 20, COOP_WORLD_WIDTH - 20);
          const my = clamp(enemy.y + Math.sin(angle) * dist, 20, COOP_WORLD_HEIGHT - 20);
          const minion = createServerEnemy(world, "minion", mx, my, true);
          minion.hasEnteredArena = true;
          minion.spawnDelay = 0;
          minion.parentId = enemy.id;
          world.enemies.set(minion.id, minion);
        }
      }
    }

    /*
     * Оглушение: пропускаем движение и атаки.
     */
    if (enemy.stunTimer > 0) {
      enemy.stunTimer = Math.max(
        0,
        enemy.stunTimer - dt
      );

      continue;
    }

    const target =
      getNearestAliveServerPlayer(
        world,
        enemy
      );

    if (!target) {
      continue;
    }

    let dx =
      target.x - enemy.x;

    let dy =
      target.y - enemy.y;

    const targetDistance =
      Math.hypot(dx, dy) || 1;

    dx /= targetDistance;
    dy /= targetDistance;

    if (enemy.turnRate) {
      const desiredAngle = Math.atan2(dy, dx);
      const currentFacing = enemy.facingAngle || 0;
      const angleDiff = Math.atan2(
        Math.sin(desiredAngle - currentFacing),
        Math.cos(desiredAngle - currentFacing)
      );
      const maxStep = enemy.turnRate * dt;
      enemy.facingAngle =
        currentFacing +
        clamp(angleDiff, -maxStep, maxStep);
    }

    if (enemy.type === "mirage") {
      const cyclePos = (Date.now() / 1000 - (enemy.spawnTime || 0)) % MIRAGE_CYCLE;
      enemy.mirageVisible = cyclePos >= MIRAGE_HIDDEN;
    }

    if (enemy.type === "boss_drone" || enemy.type === "boss_pylon") {
      const boss = world.enemies.get(enemy.bossId);
      if (boss && boss.hp > 0) {
        enemy.shootCooldown = (enemy.shootCooldown || 2.5) - dt;
        if (enemy.shootCooldown <= 0) {
          shootServerEnemyProjectile(world, enemy, target);
          enemy.shootCooldown = random(2.2, 3.5);
        }
      } else {
        damageServerEnemy(world, enemy.id, 9999);
      }
      continue;
    } else if (enemy.type === "boss") {
      const hpRatio = enemy.hp / (enemy.maxHp || 1);
      const phase = hpRatio < 0.33 ? 2 : hpRatio < 0.66 ? 1 : 0;
      enemy.phase = phase;

      if (!enemy.shieldTriggered && hpRatio <= 0.5 && (enemy.bossTier || 1) >= 2) {
        spawnServerBossDrones(world, enemy);
      }

      // Проверка снятия щита: если все 4 угловых генератора уничтожены, щит спадает и урон проходит на 100%!
      if (enemy.shieldActive) {
        const alivePylons = [...world.enemies.values()].filter(
          e => (e.type === "boss_drone" || e.type === "boss_pylon") && e.bossId === enemy.id && e.hp > 0
        );
        if (alivePylons.length === 0) {
          enemy.shieldActive = false;
          enemy.stunTimer = 2.0;
          enemy.dashState = "none";
          enemy.sniperState = "none";
          enemy.spiralActive = false;
        }
      }

      if (enemy.stunTimer > 0) {
        enemy.stunTimer -= dt;
        continue;
      }

      // 1. Dash
      if (phase >= 1 && enemy.hasEnteredArena) {
        if (enemy.dashState === "none") {
          enemy.dashCooldown -= dt;
          if (enemy.dashCooldown <= 0) {
            enemy.dashState = "telegraph";
            enemy.dashTimer = 0.7;
            enemy.dashDx = dx;
            enemy.dashDy = dy;
          }
        } else if (enemy.dashState === "telegraph") {
          enemy.dashTimer -= dt;
          if (enemy.dashTimer <= 0) {
            enemy.dashState = "dashing";
            enemy.dashTimer = 0.45;
          }
        } else if (enemy.dashState === "dashing") {
          enemy.dashTimer -= dt;
          enemy.x += enemy.dashDx * 430 * dt;
          enemy.y += enemy.dashDy * 430 * dt;
          enemy.x = clamp(enemy.x, enemy.r, COOP_WORLD_WIDTH - enemy.r);
          enemy.y = clamp(enemy.y, enemy.r, COOP_WORLD_HEIGHT - enemy.r);

          if (enemy.dashTimer <= 0) {
            enemy.dashState = "none";
            enemy.dashCooldown = random(6.5, 8.5);
            shootServerBossShockwave(world, enemy);
          }
          continue;
        }
      }

      // 2. Sniper Beam
      if ((enemy.bossTier || 1) >= 2 && enemy.hasEnteredArena && enemy.dashState === "none") {
        if (enemy.sniperState === "none") {
          enemy.sniperCooldown -= dt;
          if (enemy.sniperCooldown <= 0) {
            enemy.sniperState = "tracking";
            enemy.sniperTimer = 1.0;
            enemy.sniperTargetX = target.x;
            enemy.sniperTargetY = target.y;
          }
        } else if (enemy.sniperState === "tracking") {
          enemy.sniperTargetX = target.x;
          enemy.sniperTargetY = target.y;
          enemy.sniperTimer -= dt;
          if (enemy.sniperTimer <= 0) {
            enemy.sniperState = "locked";
            enemy.sniperTimer = 0.35;
          }
        } else if (enemy.sniperState === "locked") {
          enemy.sniperTimer -= dt;
          if (enemy.sniperTimer <= 0) {
            shootServerBossSniperBolt(world, enemy, enemy.sniperTargetX, enemy.sniperTargetY);
            enemy.sniperState = "none";
            enemy.sniperCooldown = random(4.0, 6.5);
          }
        }
      }

      // 3. Spiral Bullet Hell
      if (phase === 2 && enemy.hasEnteredArena) {
        if (!enemy.spiralActive) {
          enemy.spiralCooldown -= dt;
          if (enemy.spiralCooldown <= 0) {
            enemy.spiralActive = true;
            enemy.spiralTimer = 1.8;
            enemy.spiralTicks = 0;
            enemy.spiralBaseAngle = 0;
          }
        } else {
          enemy.spiralTimer -= dt;
          enemy.spiralBaseAngle += dt * 3.5;
          enemy.spiralTicks += dt;
          if (enemy.spiralTicks >= 0.14) {
            enemy.spiralTicks = 0;
            createServerEnemyProjectile(world, enemy.x + Math.cos(enemy.spiralBaseAngle) * (enemy.r + 6), enemy.y + Math.sin(enemy.spiralBaseAngle) * (enemy.r + 6), enemy.spiralBaseAngle, 175, 6, "#ff0077", 1);
            createServerEnemyProjectile(world, enemy.x + Math.cos(enemy.spiralBaseAngle + Math.PI) * (enemy.r + 6), enemy.y + Math.sin(enemy.spiralBaseAngle + Math.PI) * (enemy.r + 6), enemy.spiralBaseAngle + Math.PI, 175, 6, "#ff0077", 1);
          }
          if (enemy.spiralTimer <= 0) {
            enemy.spiralActive = false;
            enemy.spiralCooldown = random(6.0, 8.5);
          }
        }
      }

      const forwardMovement = targetDistance > 320 ? 0.95 : targetDistance < 220 ? -0.4 : 0.25;
      const strafeStrength = 0.5 + phase * 0.12;

      enemy.x +=
        (dx * forwardMovement - dy * (enemy.strafeDirection || 1) * strafeStrength) *
        enemy.speed *
        difficulty.enemySpeed *
        dt;

      enemy.y +=
        (dy * forwardMovement + dx * (enemy.strafeDirection || 1) * strafeStrength) *
        enemy.speed *
        difficulty.enemySpeed *
        dt;

      if (enemy.hasEnteredArena && (enemy.dashState || "none") === "none") {
        enemy.shootCooldown -= dt;
        enemy.radialCooldown -= dt;

        if (enemy.shootCooldown <= 0) {
          shootServerBossSpread(world, enemy, target, phase);
          enemy.shootCooldown = Math.max(0.85, 1.35 - phase * 0.16);
        }

        if (enemy.radialCooldown <= 0) {
          shootServerBossRadial(world, enemy, phase);
          enemy.radialCooldown = Math.max(2.6, 3.8 - phase * 0.4);
        }
      }
    } else if (enemy.type === "shooter") {
      let movement = 0;
      if (targetDistance > (enemy.preferredDistance || 300) + 35) {
        movement = 1;
      } else if (targetDistance < (enemy.preferredDistance || 300) - 35) {
        movement = -0.8;
      }

      const strafe = Math.sin(Date.now() * 0.0015 + enemy.id) * 0.45;

      enemy.x +=
        (dx * movement - dy * strafe) *
        enemy.speed *
        difficulty.enemySpeed *
        dt;

      enemy.y +=
        (dy * movement + dx * strafe) *
        enemy.speed *
        difficulty.enemySpeed *
        dt;

      if (enemy.hasEnteredArena) {
        enemy.shootCooldown -= dt;
        if (enemy.shootCooldown <= 0 && targetDistance < 650) {
          shootServerEnemyProjectile(world, enemy, target);
          enemy.shootCooldown = Math.max(0.5, 1.3 - world.wave * 0.02);
        }
      }
    } else if (enemy.type === "charger") {
      if (!enemy.chargeState) enemy.chargeState = "idle";
      if (enemy.chargeCooldown === undefined) enemy.chargeCooldown = 1.0;
      if (enemy.chargeTimer === undefined) enemy.chargeTimer = 0;
      if (enemy.coolingTimer === undefined) enemy.coolingTimer = 0;

      const dashDistance = 160;
      const dashDuration = 0.48;
      const dashSpeed = dashDistance / dashDuration;

      if (enemy.chargeCooldown > 0) {
        enemy.chargeCooldown -= dt;
      }

      if (enemy.chargeState === "windup") {
        enemy.chargeTimer -= dt;
        enemy.isCharging = false;
        if (enemy.chargeTimer <= 0) {
          enemy.chargeState = "dashing";
          enemy.chargeTimer = dashDuration;
          enemy.isCharging = true;
        }
      } else if (enemy.chargeState === "dashing") {
        enemy.chargeTimer -= dt;
        enemy.isCharging = true;
        enemy.x +=
          (enemy.chargeDx || dx) *
          dashSpeed *
          difficulty.enemySpeed *
          dt;
        enemy.y +=
          (enemy.chargeDy || dy) *
          dashSpeed *
          difficulty.enemySpeed *
          dt;
        if (enemy.chargeTimer <= 0) {
          enemy.chargeState = "cooling";
          enemy.coolingTimer = 1.0;
          enemy.isCharging = false;
          enemy.chargeCooldown = 1.8;
        }
      } else if (enemy.chargeState === "cooling") {
        enemy.coolingTimer -= dt;
        enemy.isCharging = false;
        if (enemy.coolingTimer <= 0) {
          enemy.chargeState = "idle";
        }
        enemy.x +=
          dx *
          enemy.speed *
          difficulty.enemySpeed *
          dt;
        enemy.y +=
          dy *
          enemy.speed *
          difficulty.enemySpeed *
          dt;
      } else {
        enemy.isCharging = false;
        if (enemy.chargeCooldown <= 0 && targetDistance <= dashDistance && enemy.hasEnteredArena) {
          enemy.chargeState = "windup";
          enemy.chargeTimer = 0.65;
          enemy.chargeDx = dx;
          enemy.chargeDy = dy;
        } else {
          enemy.x +=
            dx *
            enemy.speed *
            difficulty.enemySpeed *
            dt;
          enemy.y +=
            dy *
            enemy.speed *
            difficulty.enemySpeed *
            dt;
        }
      }
    } else {
      enemy.x +=
        dx *
        enemy.speed *
        difficulty.enemySpeed *
        dt;

      enemy.y +=
        dy *
        enemy.speed *
        difficulty.enemySpeed *
        dt;
    }

    enemy.x = clamp(
      enemy.x,
      enemy.r,
      COOP_WORLD_WIDTH - enemy.r
    );

    enemy.y = clamp(
      enemy.y,
      enemy.r,
      COOP_WORLD_HEIGHT - enemy.r
    );

    if (
      targetDistance <=
      target.r + enemy.r
    ) {
      const pushStrength =
        enemy.type === "boss"
          ? 25
          : enemy.type === "tank"
            ? 17
            : 12;

      enemy.x -=
        dx * pushStrength;

      enemy.y -=
        dy * pushStrength;

      if (
        enemy.contactCooldown <= 0
      ) {
        const damageApplied =
          damageServerPlayer(
            world,
            target,
            getServerContactDamage(
              world,
              enemy
            )
          );

        if (damageApplied) {
          enemy.contactCooldown =
            COOP_ENEMY_CONTACT_COOLDOWN;
        }
      }
    }
  }

  /*
   * Связанные Близнецы: лазерная нить наносит урон
   * игроку, пересекающему её.
   */
  const twinProcessed = new Set();
  for (const enemy of world.enemies.values()) {
    if (enemy.type !== "twin") continue;
    if (!enemy.hasEnteredArena) continue;
    if (enemy.twinPartnerId == null) continue;
    if (twinProcessed.has(enemy.id)) continue;

    const partner = world.enemies.get(enemy.twinPartnerId);
    if (!partner || !partner.hasEnteredArena) continue;
    twinProcessed.add(enemy.id);
    twinProcessed.add(partner.id);

    for (const player of world.players.values()) {
      if (!player.alive) continue;
      if (player.invulnerability > 0) continue;

      const dist = distToSegment(
        player.x, player.y,
        enemy.x, enemy.y,
        partner.x, partner.y
      );

      if (dist <= player.r + 3) {
        damageServerPlayer(world, player, 80 + world.wave * 12);
      }
    }
  }

  resolveServerEnemyOverlaps(world);
}

function updateServerCoopPlayer(
  world,
  coopPlayer,
  dt,
  currentTime
) {
  /*
   * Воскрешение QTE: отсчёт таймера. Если время вышло — смерть.
   */
  if (coopPlayer.revivePrompt?.active) {
    coopPlayer.revivePrompt.timer -= dt;
    if (coopPlayer.revivePrompt.timer <= 0) {
      coopPlayer.revivePrompt.active = false;
      coopPlayer.stats.resurrectionUsed = true;
      coopPlayer.invulnerability = 0;
      coopPlayer.alive = false;

      const alivePlayers = [
        ...world.players.values()
      ].filter(player => player.alive);

      if (alivePlayers.length > 0) {
        coopPlayer.reviveBeacon = {
          x: coopPlayer.x,
          y: coopPlayer.y,
          progress: 0,
          requiredTime: 3.0,
          radius: 70,
          active: true
        };
      }

      if (alivePlayers.length === 0) {
        world.gameOver = true;
        for (const p of world.players.values()) {
          if (p.reviveBeacon) p.reviveBeacon = null;
        }
      }
    }
    return;
  }

  let input = coopPlayer.input;

  /*
   * Если клиент перестал отправлять управление,
   * персонаж останавливается. Это защищает от
   * зажатой клавиши после сворачивания или обрыва.
   */
  if (
    currentTime - coopPlayer.lastInputAt >
    COOP_INPUT_TIMEOUT
  ) {
    input = sanitizeInput({});
  }

  coopPlayer.dashCooldown = Math.max(0, (coopPlayer.dashCooldown || 0) - dt);
  coopPlayer.dashTimer = Math.max(0, (coopPlayer.dashTimer || 0) - dt);

  if (input.dash && coopPlayer.stats?.dash && (coopPlayer.dashCooldown || 0) <= 0) {
    let ddx = 0;
    let ddy = 0;
    if (input.up) ddy -= 1;
    if (input.down) ddy += 1;
    if (input.left) ddx -= 1;
    if (input.right) ddx += 1;
    const dlen = Math.hypot(ddx, ddy);
    if (dlen > 0) {
      ddx /= dlen;
      ddy /= dlen;
    } else {
      const angle = Math.atan2((input.aimY || coopPlayer.y) - coopPlayer.y, (input.aimX || coopPlayer.x) - coopPlayer.x);
      ddx = Math.cos(angle);
      ddy = Math.sin(angle);
    }
    const dashSpeed = (coopPlayer.stats?.dashDistance || 120) / 0.18;
    coopPlayer.dashCooldown = coopPlayer.stats?.dashCooldownBase || 10.0;
    coopPlayer.dashTimer = 0.18;
    coopPlayer.dashVx = ddx * dashSpeed;
    coopPlayer.dashVy = ddy * dashSpeed;
    coopPlayer.invulnerability = Math.max(coopPlayer.invulnerability || 0, 0.18);
    coopPlayer.dashHitEnemies = new Set();
    input.dash = false;
  }

  if (Number.isFinite(input.x) && Number.isFinite(input.y)) {
    const drift = Math.hypot(input.x - coopPlayer.x, coopPlayer.y - input.y);
    if (drift < 300) {
      coopPlayer.x = input.x;
      coopPlayer.y = input.y;
    } else {
      const lerp = Math.min(1, dt * 12);
      coopPlayer.x += (input.x - coopPlayer.x) * lerp;
      coopPlayer.y += (input.y - coopPlayer.y) * lerp;
    }
  } else {
    if (coopPlayer.dashTimer > 0) {
      coopPlayer.x += (coopPlayer.dashVx || 0) * dt;
      coopPlayer.y += (coopPlayer.dashVy || 0) * dt;
    }

    let movementX = 0;
    let movementY = 0;

    if (input.up) movementY -= 1;
    if (input.down) movementY += 1;
    if (input.left) movementX -= 1;
    if (input.right) movementX += 1;

    const movementLength =
      Math.hypot(
        movementX,
        movementY
      );

    if (movementLength > 0) {
      movementX /= movementLength;
      movementY /= movementLength;

      const movementSpeed =
        coopPlayer.stats?.playerSpeed ??
        COOP_PLAYER_SPEED;

      coopPlayer.x +=
        movementX *
        movementSpeed *
        dt;

      coopPlayer.y +=
        movementY *
        movementSpeed *
        dt;
    }
  }

  coopPlayer.x = clamp(
    coopPlayer.x,
    coopPlayer.r,
    COOP_WORLD_WIDTH -
      coopPlayer.r
  );

  coopPlayer.y = clamp(
    coopPlayer.y,
    coopPlayer.r,
    COOP_WORLD_HEIGHT -
      coopPlayer.r
  );

  /*
   * Разящий рывок: урон 100% от damage всем
   * врагам на траектории рывка.
   * Проверка выполняется независимо от типа ввода,
   * так как в коопе клиент всегда шлёт координаты.
   */
  if (coopPlayer.dashTimer > 0 && coopPlayer.stats?.dashDamage) {
    const prevDashX = coopPlayer.x - (coopPlayer.dashVx || 0) * dt;
    const prevDashY = coopPlayer.y - (coopPlayer.dashVy || 0) * dt;
    if (!coopPlayer.dashHitEnemies) coopPlayer.dashHitEnemies = new Set();
    for (const enemy of world.enemies.values()) {
      if (!enemy.hasEnteredArena) continue;
      if (enemy.type === "phantom" && enemy.isPhased) continue;
      if (coopPlayer.dashHitEnemies.has(enemy.id)) continue;

      const segDist = distToSegment(
        enemy.x, enemy.y,
        prevDashX, prevDashY,
        coopPlayer.x, coopPlayer.y
      );

      if (segDist <= (coopPlayer.r + enemy.r) * 1.03) {
        coopPlayer.dashHitEnemies.add(enemy.id);
        damageServerEnemy(
          world,
          enemy.id,
          coopPlayer.stats?.damage || 100,
          coopPlayer
        );
      }
    }
  }

  coopPlayer.aimX = clamp(
    Number(input.aimX) ||
      COOP_WORLD_WIDTH / 2,
    0,
    COOP_WORLD_WIDTH
  );

  coopPlayer.aimY = clamp(
    Number(input.aimY) ||
      COOP_WORLD_HEIGHT / 2,
    0,
    COOP_WORLD_HEIGHT
  );
}

function applyServerUpgrade(
  worldOrPlayer,
  playerOrOffer,
  offerOrPower
) {
  let world = null;
  let player = null;
  let offer = null;

  if (worldOrPlayer && (worldOrPlayer.players || worldOrPlayer.enemies)) {
    world = worldOrPlayer;
    player = playerOrOffer;
    offer = typeof offerOrPower === "string" ? { upgradeId: offerOrPower, power: 1 } : offerOrPower;
  } else {
    player = worldOrPlayer;
    if (typeof playerOrOffer === "string") {
      offer = { upgradeId: playerOrOffer, power: typeof offerOrPower === "number" ? offerOrPower : 1 };
    } else {
      offer = playerOrOffer;
    }
  }

  if (!player || !offer) {
    return false;
  }

  const power = Math.max(
    1,
    Number(offer.power || offer.rarity?.power) || 1
  );

  const id = offer.upgradeId || offer.id;
  const applied = applyUpgrade(player, id, power);
  if (!applied) {
    return false;
  }

  if ((id === "caliber" || id === "second-bullet") && world) {
    ensureServerMagazine(world, player);
  }

  if (!player.selectedUpgrades) {
    player.selectedUpgrades = [];
  }

  player.selectedUpgrades.push({
    upgradeId: offer.upgradeId || offer.id,
    title: offer.title || offer.upgrade?.title || offer.upgradeId || offer.id,
    description: offer.description || offer.upgrade?.description || "",
    rarityKey: offer.rarityKey || offer.rarity?.key || "common",
    rarityLabel: offer.rarityLabel || offer.rarity?.label || "ОБЫЧНОЕ",
    power,
    bonusText: offer.bonusText || ""
  });

  player.statsDirty = true;
  player.upgradesDirty = true;
  return true;
}

function recalculateServerPlayerStats(world, player) {
  if (!player) return;
  const difficulty = (world && COOP_DIFFICULTY[world.difficulty]) || COOP_DIFFICULTY.normal;
  const baseHp = difficulty.playerHp || 500;
  player.stats = createServerPlayerStats();
  player.maxHp = baseHp;
  player.hp = Math.min(player.hp, player.maxHp);
  if (player.hp <= 0 && player.alive) player.hp = 100;

  if (world && world.bullets) {
    let count = 0;
    for (const [bId, bullet] of world.bullets) {
      if (bullet.ownerId === player.id) {
        count++;
        if (count > 1) {
          world.bullets.delete(bId);
        }
      }
    }
  }

  const currentUpgrades = player.selectedUpgrades ? [...player.selectedUpgrades] : [];
  player.selectedUpgrades = [];
  for (const up of currentUpgrades) {
    applyServerUpgrade(world, player, up);
  }
  player.statsDirty = true;
  player.upgradesDirty = true;
}

function removeServerUpgrade(world, player, upgradeId) {
  if (!player || !player.selectedUpgrades || player.selectedUpgrades.length === 0) return false;
  let removed = false;
  player.selectedUpgrades = player.selectedUpgrades.filter(u => {
    const match = (u.upgradeId === upgradeId || u.id === upgradeId);
    if (match) removed = true;
    return !match;
  });
  if (removed) {
    recalculateServerPlayerStats(world, player);
  }
  return removed;
}

function resetServerPlayerUpgrades(world, player) {
  if (!player) return false;
  player.selectedUpgrades = [];
  recalculateServerPlayerStats(world, player);
  return true;
}

function startServerUpgradeRound(room) {
  const world = room.world;

  if (
    !world ||
    world.gameOver ||
    world.pendingLevelUps <= 0
  ) {
    return;
  }

  const offerId =
    `${room.code}:${
      world.nextUpgradeRoundId++
    }:${Date.now()}`;

  const offersByPlayer =
    new Map();

  const waitingPlayers =
    new Set();

  for (
    const player of
    world.players.values()
  ) {
    const offers =
      createServerUpgradeOffers(
        player
      );

    offersByPlayer.set(
      player.id,
      offers
    );

    waitingPlayers.add(
      player.id
    );

    io.to(player.id).emit(
      "net:upgrade-offers",
      {
        offerId,
        playerLevel: world.level,
        pendingLevelUps:
          world.pendingLevelUps,
        offers,
        rerolls: typeof player.rerolls === "number" ? player.rerolls : 1
      }
    );
  }

  world.upgradePaused = true;

  world.upgradeRound = {
    offerId,
    offersByPlayer,
    waitingPlayers
  };
}

function finishServerUpgradeRound(room) {
  const world = room.world;

  if (!world?.upgradeRound) {
    return;
  }

  if (
    world.upgradeRound
      .waitingPlayers.size > 0
  ) {
    return;
  }

  world.upgradeRound = null;

  world.pendingLevelUps =
    Math.max(
      0,
      world.pendingLevelUps - 1
    );

  if (world.pendingLevelUps > 0) {
    startServerUpgradeRound(room);
    return;
  }

  world.upgradePaused = false;
}

function addServerExperience(
  room,
  amount
) {
  const world = room.world;

  if (!world || world.gameOver) {
    return;
  }

  world.experience += amount;

  while (
    world.experience >=
    world.experienceToNext
  ) {
    world.experience -=
      world.experienceToNext;

    world.level += 1;
    world.pendingLevelUps += 1;
    if (world.level % 2 === 0) {
      for (const p of world.players.values()) {
        p.rerolls = (p.rerolls || 0) + 1;
      }
    }

    world.experienceToNext =
      getServerExperienceRequirement(
        world.level
      );
  }

  if (
    world.pendingLevelUps > 0 &&
    !world.upgradePaused
  ) {
    startServerUpgradeRound(room);
  }
}

function getNearestCrystalPlayer(
  world,
  crystal
) {
  let nearestPlayer = null;
  let nearestDistance = Infinity;

  for (
    const player of
    world.players.values()
  ) {
    if (!player.alive) {
      continue;
    }

    const currentDistance =
      distance(
        crystal.x,
        crystal.y,
        player.x,
        player.y
      );

    if (
      currentDistance <
      nearestDistance
    ) {
      nearestDistance =
        currentDistance;

      nearestPlayer = player;
    }
  }

  return {
    player: nearestPlayer,
    distance: nearestDistance
  };
}

function updateServerMedkits(room, dt) {
  const world = room.world;
  if (!world || !world.medkits || world.medkits.size === 0) return;

  for (const [mId, medkit] of world.medkits.entries()) {
    medkit.life = (medkit.life || 35) - dt;
    if (medkit.life <= 0) {
      world.medkits.delete(mId);
      continue;
    }

    for (const player of world.players.values()) {
      if (!player.alive) continue;
      if (player.hp >= player.maxHp) continue;
      const dist = distance(player.x, player.y, medkit.x, medkit.y);
      if (dist <= player.r + (medkit.r || 12)) {
        player.hp = Math.min(player.maxHp, player.hp + (medkit.heal || 100));
        world.medkits.delete(mId);
        break;
      }
    }
  }
}

function updateServerExperienceCrystals(
  room,
  dt
) {
  const world = room.world;
  const waveIsClear =
    world.enemies.size === 0;

  for (
    const crystal of
    [...world.experienceCrystals.values()]
  ) {
    crystal.age += dt;

    crystal.x += crystal.vx * dt;
    crystal.y += crystal.vy * dt;

    const damping =
      Math.pow(0.035, dt);

    crystal.vx *= damping;
    crystal.vy *= damping;

    const nearest =
      getNearestCrystalPlayer(
        world,
        crystal
      );

    const target =
      nearest.player;

    if (!target) {
      continue;
    }

    const attractionRadius =
      COOP_CRYSTAL_ATTRACTION_RADIUS +
      (target.stats?.pickupRadius || 0) *
        0.5;

    const shouldAttract =
      crystal.age >= 0.15 &&
      (
        waveIsClear ||
        nearest.distance <=
          attractionRadius
      );

    if (
      shouldAttract &&
      nearest.distance > 0.001
    ) {
      let dx =
        target.x - crystal.x;

      let dy =
        target.y - crystal.y;

      const length =
        Math.hypot(dx, dy) || 1;

      dx /= length;
      dy /= length;

      const attractionSpeed =
        waveIsClear
          ? COOP_CRYSTAL_CLEAR_SPEED
          : COOP_CRYSTAL_ATTRACTION_SPEED;

      crystal.vx +=
        dx *
        attractionSpeed *
        10 *
        dt;

      crystal.vy +=
        dy *
        attractionSpeed *
        10 *
        dt;

      const speed =
        Math.hypot(
          crystal.vx,
          crystal.vy
        );

      if (speed > attractionSpeed) {
        crystal.vx =
          crystal.vx /
          speed *
          attractionSpeed;

        crystal.vy =
          crystal.vy /
          speed *
          attractionSpeed;
      }
    }

    if (
      distance(
        crystal.x,
        crystal.y,
        target.x,
        target.y
      ) <=
      crystal.r + target.r + 5
    ) {
      world.experienceCrystals.delete(
        crystal.id
      );

      addServerExperience(
        room,
        crystal.value
      );
    }
  }
}

/*
 * Собирает снапшот мира для рассылки клиентам.
 *
 * options.full — принудительно включает статические
 * поля сущностей (радиус/цвет/maxHp). Нужен всегда,
 * когда получатель строит состояние с нуля: старт
 * матча, переподключение, ручной net:request-snapshot.
 * Без этого флага статика отправляется один раз на
 * сущность, чтобы не гнать её 20 раз в секунду.
 */
function createServerCoopSnapshot(room, options) {
  const world = room.world;
  const fullSnapshot = Boolean(options && options.full);

  return {
    type: "coop-server-v4",
    serverTime: Date.now(),

    worldWidth: COOP_WORLD_WIDTH,
    worldHeight: COOP_WORLD_HEIGHT,

    wave: world.wave,
    kills: world.kills,
    score: world.score,

    level: world.level,
    experience: world.experience,

    experienceToNext:
      world.experienceToNext,

    pendingLevelUps:
      world.pendingLevelUps,

    upgradePaused:
      world.upgradePaused,

    manualPaused:
      world.manualPaused,

    unpauseCountdown:
      world.unpauseCountdown
        ? (world.unpauseCountdownSec || Math.ceil(world.unpauseCountdown))
        : null,

    reconnectState:
      world.reconnectState || null,

    upgradeWaitingPlayers:
      world.upgradeRound
        ? [
            ...world.upgradeRound
              .waitingPlayers
          ]
        : [],

    wavePending:
      world.wavePending,

    waveClearTimer:
      world.waveClearTimer,

    gameOver:
      world.gameOver,

    players: [
      ...world.players.values()
    ].map(coopPlayer => ({
      id: coopPlayer.id,
      name: coopPlayer.name,

      x: Math.round(coopPlayer.x * 100) / 100,
      y: Math.round(coopPlayer.y * 100) / 100,

      aimX: Math.round(coopPlayer.aimX),
      aimY: Math.round(coopPlayer.aimY),

      r: coopPlayer.r,
      colorIndex: coopPlayer.colorIndex,

      hp: coopPlayer.hp,
      maxHp: coopPlayer.maxHp,

      alive: coopPlayer.alive,
      bulletSkin: coopPlayer.bulletSkin || "neon",
      playerSkin: coopPlayer.playerSkin || "cyan",
      invulnerability: coopPlayer.invulnerability > 0 ? Number(coopPlayer.invulnerability.toFixed(2)) : 0,

      reviveBeacon: coopPlayer.reviveBeacon
        ? {
            x: Math.round(coopPlayer.reviveBeacon.x),
            y: Math.round(coopPlayer.reviveBeacon.y),
            progress: Number(coopPlayer.reviveBeacon.progress.toFixed(2)),
            requiredTime: coopPlayer.reviveBeacon.requiredTime,
            radius: coopPlayer.reviveBeacon.radius,
            active: coopPlayer.reviveBeacon.active
          }
        : undefined,

      revivePrompt: coopPlayer.revivePrompt?.active
        ? {
            active: true,
            presses: coopPlayer.revivePrompt.presses,
            required: coopPlayer.revivePrompt.required,
            timer: Number(coopPlayer.revivePrompt.timer.toFixed(2))
          }
        : undefined,

      stats: (fullSnapshot || coopPlayer.statsDirty) ? coopPlayer.stats : undefined,
      selectedUpgrades: (fullSnapshot || coopPlayer.upgradesDirty) ? coopPlayer.selectedUpgrades : undefined,
      totalDamageDealt: coopPlayer.totalDamageDealt || 0
    })),

    bullets: [
      ...world.bullets.values()
    ].map(bullet => ({
      id: bullet.id,
      ownerId: bullet.ownerId,
      skin: bullet.skin || (world.players.get(bullet.ownerId)?.bulletSkin) || "neon",

      x: Math.round(bullet.x * 10) / 10,
      y: Math.round(bullet.y * 10) / 10,

      vx: Math.round(bullet.vx),
      vy: Math.round(bullet.vy),

      r: bullet.r,
      state: bullet.state,
      age: Number((bullet.age || 0).toFixed(2)),

      bouncesLeft: bullet.bouncesLeft,
      colorIndex: bullet.colorIndex
    })),

    enemies: [
      ...world.enemies.values()
    ].map(enemy => {
      /*
       * Компактная сериализация врага.
       *
       * Враги — 90% трафика снапшота, поэтому здесь
       * отправляется только то, что клиент реально
       * читает в applyCoopSnapshot, и только когда
       * значение отличается от предполагаемого по
       * умолчанию. Клиент восстанавливает опущенные
       * поля из дефолтов, поэтому любое новое поле
       * обязано иметь дефолт на стороне клиента.
       */
      const serialized = {
        id: enemy.id,

        x: Math.round(enemy.x),
        y: Math.round(enemy.y),

        hp: enemy.hp
      };

      /*
       * Статика врага (тип/радиус/цвет/maxHp) не меняется
       * после спавна, поэтому отправляется только в
       * первом снапшоте — клиент кеширует значения.
       */
      if (fullSnapshot || !enemy.staticSent) {
        enemy.staticSent = true;
        serialized.type = enemy.type;
        serialized.r = enemy.r;
        serialized.maxHp = enemy.maxHp;
        serialized.color = enemy.color;
      }

      /*
       * Данные предупреждения о спавне нужны клиенту
       * только пока враг ещё не вошёл в арену.
       */
      if (!enemy.hasEnteredArena) {
        serialized.spawnEdge = enemy.spawnEdge;
        serialized.spawnWarningX = Math.round(enemy.spawnWarningX || 0);
        serialized.spawnWarningY = Math.round(enemy.spawnWarningY || 0);
        serialized.spawnDelay = Number((enemy.spawnDelay || 0).toFixed(2));
      } else {
        serialized.entered = 1;
      }

      if (enemy.isCharging) serialized.isCharging = 1;
      if (enemy.chargeState && enemy.chargeState !== "idle") {
        serialized.chargeState = enemy.chargeState;
        if (enemy.chargeState === "windup") {
          serialized.chargeProgress = Number(Math.max(0, Math.min(1, 1 - (enemy.chargeTimer / 0.65))).toFixed(2));
        } else if (enemy.chargeState === "cooling") {
          serialized.coolingProgress = Number(Math.max(0, Math.min(1, 1 - (enemy.coolingTimer / 1.0))).toFixed(2));
        }
      }
      if (enemy.chargeDx !== undefined && enemy.chargeState === "windup") {
        serialized.chargeDx = Number(enemy.chargeDx.toFixed(2));
        serialized.chargeDy = Number(enemy.chargeDy.toFixed(2));
      }
      if (enemy.stunTimer > 0) serialized.stunTimer = Number(enemy.stunTimer.toFixed(2));
      if (enemy.targetMarked) serialized.targetMarked = 1;
      if (enemy.poisonTimer > 0) serialized.poisoned = 1;
      if (enemy.parasiteInfested) serialized.parasiteInfested = 1;

      if (enemy.type === "phantom" && enemy.isPhased) {
        serialized.isPhased = 1;
      }

      if (enemy.type === "sentinel") {
        serialized.facingAngle = Math.round((enemy.facingAngle || 0) * 100) / 100;
      }

      if (enemy.type === "mirage") {
        serialized.mirageVisible = enemy.mirageVisible ? 1 : 0;
      }

      if (enemy.type === "twin") {
        if (enemy.twinPartnerId) serialized.twinPartnerId = enemy.twinPartnerId;
        if (enemy.isEnraged) serialized.isEnraged = 1;
        if (enemy.revengeTargetId) serialized.revengeTargetId = enemy.revengeTargetId;
      }

      if (enemy.type === "incubator") {
        serialized.sporesCount = enemy.sporesCount !== undefined ? enemy.sporesCount : 5;
      }

      if (enemy.type === "boss" && enemy.shieldActive) {
        serialized.shieldActive = 1;
      }

      if ((enemy.type === "boss_drone" || enemy.type === "boss_pylon") && enemy.bossId) {
        serialized.bossId = enemy.bossId;
      }

      return serialized;
    }),

    enemyProjectiles: [
      ...world.enemyProjectiles.values()
    ].map(projectile => ({
      id: projectile.id,
      x: Math.round(projectile.x),
      y: Math.round(projectile.y),
      vx: Math.round(projectile.vx),
      vy: Math.round(projectile.vy),
      r: projectile.r,
      color: projectile.color
    })),
    
    experienceCrystals: [
      ...world.experienceCrystals.values()
    ].map(crystal => ({
      id: crystal.id,
      x: Math.round(crystal.x),
      y: Math.round(crystal.y),
      vx: Math.round(crystal.vx),
      vy: Math.round(crystal.vy),
      value: crystal.value,
      r: crystal.r
    })),

    medkits: world.medkits ? [
      ...world.medkits.values()
    ].map(medkit => ({
      id: medkit.id,
      x: Math.round(medkit.x),
      y: Math.round(medkit.y),
      r: medkit.r || 12
    })) : [],

    parasites: world.parasites ? [
      ...world.parasites.values()
    ].map(spore => ({
      id: spore.id,
      x: Math.round(spore.x),
      y: Math.round(spore.y),
      vx: Math.round(spore.vx),
      vy: Math.round(spore.vy),
      r: spore.r || 7
    })) : [],

    splinters: world.splinters ? [
      ...world.splinters.values()
    ].map(shard => ({
      id: shard.id,
      x: Math.round(shard.x),
      y: Math.round(shard.y),
      vx: Math.round(shard.vx),
      vy: Math.round(shard.vy),
      r: shard.r || 4
    })) : []
  };
}

function sendAcknowledgement(
  acknowledge,
  payload
) {
  if (typeof acknowledge === "function") {
    acknowledge(payload);
  }
}


io.on("connection", socket => {
  socket.data.roomCode = null;
  socket.data.role = null;
  
  socket.on("net:request-snapshot", () => {
    const room =
      getRoomForSocket(socket);
  
    if (
      !room ||
      !room.started ||
      !room.world
    ) {
      return;
    }
    touchRoom(room);
  
    socket.emit(
      "net:snapshot",
      createServerCoopSnapshot(room, { full: true })
    );
  });

  socket.on("room:list", (payload, acknowledge) => {
    // Список открытых лобби, куда ещё можно зайти (не начата игра, есть свободное место).
    const openRooms = [];
    for (const room of rooms.values()) {
      if (room.started || room.players.size >= 2) continue;
      const host = room.players.get(room.hostId);
      openRooms.push({
        code: room.code,
        hostName: host?.name || "Игрок",
        difficulty: room.difficulty || "normal",
        playerCount: room.players.size,
        createdAt: room.createdAt
      });
    }
    openRooms.sort((a, b) => b.createdAt - a.createdAt);
    acknowledge?.({ success: true, rooms: openRooms });
  });

  socket.on(
    "room:create",
    (payload, acknowledge) => {
      try {
        leaveRoom(socket);

        const code = generateRoomCode();
        const name = sanitizeName(payload?.name);

        const room = {
          code,
          hostId: socket.id,
          difficulty: "normal",
          started: false,
          createdAt: Date.now(),
          lastActivity: Date.now(),
          players: new Map()
        };

        const reconnectToken = generateReconnectToken();

        const bulletSkin = sanitizeSkin(payload?.bulletSkin);
        const playerSkin = sanitizePlayerSkin(payload?.playerSkin);
        room.players.set(socket.id, {
          id: socket.id,
          name,
          bulletSkin,
          playerSkin,
          role: "host",
          ready: false,
          reconnectToken
        });

        rooms.set(code, room);

        socket.data.roomCode = code;
        socket.data.role = "host";
        socket.join(code);

        acknowledge?.({
          success: true,
          role: "host",
          playerId: socket.id,
          reconnectToken,
          room: getPublicRoomState(room)
        });

        emitRoomState(room);
      } catch (error) {
        acknowledge?.({
          success: false,
          message:
            error?.message ||
            "Не удалось создать комнату"
        });
      }
    }
  );

  socket.on(
    "room:join",
    (payload, acknowledge) => {
      const code = sanitizeCode(payload?.code);
      const room = rooms.get(code);

      if (!room) {
        acknowledge?.({
          success: false,
          message: "Комната не найдена"
        });

        return;
      }

      touchRoom(room);

      // Если матч уже идёт, проверяем возможность переподключения по токену или слоту
      if (room.started && room.world && !room.world.gameOver) {
        const token = String(payload?.token || payload?.reconnectToken || "").trim();
        const name = sanitizeName(payload?.name);

        let matchedPlayer = null;
        let oldPlayerId = null;

        // Поиск по токену переподключения
        if (token) {
          for (const [pId, p] of room.players.entries()) {
            if (p.reconnectToken && p.reconnectToken === token) {
              matchedPlayer = p;
              oldPlayerId = pId;
              break;
            }
          }
        }

        // Если токена нет, но в комнате есть отключившийся игрок (по имени или единственный)
        if (!matchedPlayer && (room.world.reconnectState?.paused || room.reconnectTimeout)) {
          for (const [pId, p] of room.players.entries()) {
            if (p.disconnected && (!name || p.name === name || room.players.size <= 2)) {
              matchedPlayer = p;
              oldPlayerId = pId;
              break;
            }
          }
        }

        if (matchedPlayer) {
          if (room.reconnectTimeout) {
            clearTimeout(room.reconnectTimeout);
            room.reconnectTimeout = null;
          }

          if (oldPlayerId !== socket.id) {
            room.players.delete(oldPlayerId);
            matchedPlayer.id = socket.id;
            room.players.set(socket.id, matchedPlayer);

            if (room.hostId === oldPlayerId) {
              room.hostId = socket.id;
            }

            const coopPlayer = room.world.players.get(oldPlayerId);
            if (coopPlayer) {
              room.world.players.delete(oldPlayerId);
              coopPlayer.id = socket.id;
              room.world.players.set(socket.id, coopPlayer);
            }

            for (const bullet of room.world.bullets.values()) {
              if (bullet.ownerId === oldPlayerId) {
                bullet.ownerId = socket.id;
              }
            }

            ensureServerMagazine(room.world, coopPlayer);

            if (room.world.upgradeRound) {
              if (room.world.upgradeRound.waitingPlayers.has(oldPlayerId)) {
                room.world.upgradeRound.waitingPlayers.delete(oldPlayerId);
                room.world.upgradeRound.waitingPlayers.add(socket.id);
              }
              if (room.world.upgradeRound.offersByPlayer.has(oldPlayerId)) {
                const offers = room.world.upgradeRound.offersByPlayer.get(oldPlayerId);
                room.world.upgradeRound.offersByPlayer.delete(oldPlayerId);
                room.world.upgradeRound.offersByPlayer.set(socket.id, offers);
              }
            }
          }

          matchedPlayer.disconnected = false;
          matchedPlayer.disconnectTime = null;

          socket.data.roomCode = code;
          socket.data.role = matchedPlayer.role;
          socket.join(code);

          room.world.reconnectState = {
            unfreezing: true,
            countdown: 3.0,
            countdownSec: 3,
            playerName: matchedPlayer.name,
            role: matchedPlayer.role
          };

          const snapshot = createServerCoopSnapshot(room, { full: true });

          acknowledge?.({
            success: true,
            role: matchedPlayer.role,
            playerId: socket.id,
            reconnectToken: matchedPlayer.reconnectToken,
            room: getPublicRoomState(room),
            snapshot
          });

          io.to(room.code).emit("net:snapshot", snapshot);
          emitRoomState(room);
          return;
        }

        acknowledge?.({
          success: false,
          message: "Забег уже идёт, свободных мест для переподключения нет"
        });

        return;
      }

      if (room.players.size >= 2) {
        acknowledge?.({
          success: false,
          message: "Комната заполнена"
        });

        return;
      }

      leaveRoom(socket);

      const name = sanitizeName(payload?.name);
      const bulletSkin = sanitizeSkin(payload?.bulletSkin);
      const playerSkin = sanitizePlayerSkin(payload?.playerSkin);

      const reconnectToken = generateReconnectToken();

      room.players.set(socket.id, {
        id: socket.id,
        name,
        role: "guest",
        ready: false,
        bulletSkin,
        playerSkin,
        reconnectToken
      });

      socket.data.roomCode = code;
      socket.data.role = "guest";
      socket.join(code);

      acknowledge?.({
        success: true,
        role: "guest",
        playerId: socket.id,
        reconnectToken,
        room: getPublicRoomState(room)
      });

      io.to(room.hostId).emit("room:peer-joined", {
        playerId: socket.id,
        name
      });

      emitRoomState(room);
    }
  );

  socket.on(
    "room:leave",
    (payload, acknowledge) => {
      leaveRoom(socket);
  
      if (typeof acknowledge === "function") {
        acknowledge({
          success: true
        });
      }
    }
  );

  socket.on("room:restart", (payload, acknowledge) => {
    const room = getRoomForSocket(socket);
    if (!room || !room.started || !room.world) {
      acknowledge?.({ success: false, message: "Комната не найдена или игра не запущена" });
      return;
    }
    touchRoom(room);

    // Инициируем голосование за рестарт
    if (!room.restartVotes) {
      room.restartVotes = new Set();
    }
    room.restartVotes.add(socket.id);

    // Уведомляем всех о голосе
    io.to(room.code).emit("net:game-event", {
      type: "restart-vote",
      voterId: socket.id,
      voterName: room.players.get(socket.id)?.name || "Игрок",
      votesCount: room.restartVotes.size,
      votesNeeded: room.players.size
    });

    // Если все проголосовали — рестарт
    if (room.restartVotes.size >= room.players.size) {
      room.restartVotes = null;
      room.world = createCoopWorld(room);

      io.to(room.code).emit("room:started", {
        difficulty: room.difficulty
      });

      io.to(room.code).emit(
        "net:snapshot",
        createServerCoopSnapshot(room, { full: true })
      );

      emitRoomState(room);
    }

    sendAcknowledgement(acknowledge, { success: true });
  });

  socket.on("room:return-to-lobby", (payload, acknowledge) => {
    const room = getRoomForSocket(socket);
    if (!room || room.hostId !== socket.id) {
      acknowledge?.({ success: false, message: "Только хозяин может вернуть комнату в лобби" });
      return;
    }
    touchRoom(room);

    cancelRoomCountdown(room);
    room.started = false;
    room.world = null;
    for (const p of room.players.values()) {
      p.ready = false;
    }

    io.to(room.code).emit("room:returned-to-lobby", {
      room: getPublicRoomState(room),
      returnedPlayerId: socket.id
    });

    emitRoomState(room);
    sendAcknowledgement(acknowledge, { success: true });
  });

  socket.on("room:ready", (payload, acknowledge) => {
    const room = getRoomForSocket(socket);
    if (!room || (room.started && (!room.world || !room.world.gameOver))) {
      acknowledge?.({ success: false, message: "Комната не найдена или игра уже начата" });
      return;
    }
    touchRoom(room);

    const player = room.players.get(socket.id);
    if (!player) {
      acknowledge?.({ success: false, message: "Игрок не найден" });
      return;
    }

    player.ready = Boolean(payload?.ready);
    if (payload?.bulletSkin) {
      player.bulletSkin = sanitizeSkin(payload.bulletSkin);
    }
    if (payload?.playerSkin) {
      player.playerSkin = sanitizePlayerSkin(payload.playerSkin);
    }

    if (room.players.size === 2 && [...room.players.values()].every(p => p.ready)) {
      startRoomCountdown(room);
    } else {
      cancelRoomCountdown(room);
    }

    emitRoomState(room);
    sendAcknowledgement(acknowledge, { success: true, ready: player.ready });
  });

  const ALLOWED_COOP_DIFFICULTIES = ["easy", "normal", "hard"];

  socket.on("room:set-difficulty", (payload, acknowledge) => {
    const room = getRoomForSocket(socket);
    if (!room || room.hostId !== socket.id) {
      acknowledge?.({ success: false, message: "Только хозяин может менять сложность" });
      return;
    }
    if (room.started) {
      acknowledge?.({ success: false, message: "Нельзя менять сложность во время игры" });
      return;
    }
    touchRoom(room);

    const diff = String(payload?.difficulty);
    if (!ALLOWED_COOP_DIFFICULTIES.includes(diff)) {
      acknowledge?.({ success: false, message: "Недопустимый уровень сложности" });
      return;
    }

    room.difficulty = diff;
    emitRoomState(room);
    sendAcknowledgement(acknowledge, { success: true });
  });

  socket.on(
    "room:start",
    (payload, acknowledge) => {
      const room = getRoomForSocket(socket);

      if (!room || room.hostId !== socket.id) {
        acknowledge?.({
          success: false,
          message: "Только хозяин может начать игру"
        });

        return;
      }
      touchRoom(room);

      if (room.players.size !== 2) {
        acknowledge?.({
          success: false,
          message: "Нужно дождаться второго игрока"
        });

        return;
      }

      cancelRoomCountdown(room);
      const diff = String(payload?.difficulty || room.difficulty || "normal");
      room.difficulty = ALLOWED_COOP_DIFFICULTIES.includes(diff) ? diff : "normal";
      room.started = true;
      for (const p of room.players.values()) p.ready = false;
      
      room.world =
        createCoopWorld(room);
      
      io.to(room.code).emit("room:started", {
        difficulty: room.difficulty
      });
      
      io.to(room.code).emit(
        "net:snapshot",
        createServerCoopSnapshot(room, { full: true })
      );

      emitRoomState(room);

      sendAcknowledgement(
        acknowledge,
        {
          success: true
        }
      );

    }
  );

  socket.on("net:input", input => {
    const room =
      getRoomForSocket(socket);
  
    if (
      !room ||
      !room.started ||
      !room.world
    ) {
      return;
    }
    touchRoom(room);
  
    const coopPlayer =
      room.world.players.get(
        socket.id
      );
  
    if (!coopPlayer) {
      return;
    }
  
    coopPlayer.input =
      sanitizeInput(input);
  
    coopPlayer.lastInputAt =
      Date.now();
  });

  socket.on("net:revive-press", () => {
    const room = getRoomForSocket(socket);
    if (!room || !room.started || !room.world) {
      return;
    }
    touchRoom(room);

    const coopPlayer = room.world.players.get(socket.id);
    if (!coopPlayer || !coopPlayer.revivePrompt?.active) {
      return;
    }

    const prompt = coopPlayer.revivePrompt;
    prompt.presses = Math.min(prompt.required, prompt.presses + 1);

    if (prompt.presses >= prompt.required) {
      /*
       * QTE пройден: воскрешение со 100 HP,
       * иммунитет отменён по требованию — сразу под удар.
       */
      prompt.active = false;
      coopPlayer.alive = true;
      coopPlayer.hp = Math.min(coopPlayer.maxHp, 100);
      coopPlayer.invulnerability = 0;
      coopPlayer.stats.resurrectionUsed = true;

      for (const bullet of room.world.bullets.values()) {
        if (bullet.ownerId === coopPlayer.id) {
          catchServerBullet(bullet, coopPlayer, room.world);
        }
      }
    }
  });

  socket.on("net:ping", (timestamp, ack) => {
    ack?.({ timestamp, serverTime: Date.now() });
  });

  socket.on("net:toggle-pause", () => {
    const room = getRoomForSocket(socket);
    if (!room || !room.started || !room.world || room.world.gameOver) {
      return;
    }
    touchRoom(room);
    if (room.world.manualPaused) {
      // Unpausing: trigger 3-second countdown before game continues
      room.world.manualPaused = false;
      room.world.unpauseCountdown = 3.0;
      room.world.unpauseCountdownSec = 3;
    } else {
      // Pausing
      room.world.manualPaused = true;
      room.world.unpauseCountdown = null;
      room.world.unpauseCountdownSec = null;
    }
  });

  socket.on("net:debug-command", payload => {
    const room = getRoomForSocket(socket);
    if (!room || !room.started || !room.world) {
      return;
    }
    touchRoom(room);

    const world = room.world;
    const player = world.players.get(socket.id);
    const action = payload?.action;
    const data = payload?.data || {};

    // Resolve target player(s) for player-specific commands
    let targetPlayers = [];
    if (data.target === "all") {
      targetPlayers = [...world.players.values()];
    } else if (data.target === "teammate") {
      targetPlayers = [...world.players.values()].filter(p => p.id !== socket.id);
      if (targetPlayers.length === 0 && player) targetPlayers = [player];
    } else if (typeof data.target === "string" && world.players.has(data.target)) {
      targetPlayers = [world.players.get(data.target)];
    } else {
      targetPlayers = player ? [player] : [];
    }

    switch (action) {
      case "set-wave": {
        const targetWave = Math.max(1, parseInt(data.wave, 10) || 1);
        world.wave = targetWave;
        world.enemies.clear();
        world.enemyProjectiles.clear();
        world.wavePending = false;
        world.waveClearTimer = 0;
        spawnServerWave(world);
        break;
      }

      case "skip-wave": {
        world.wave += 1;
        world.enemies.clear();
        world.enemyProjectiles.clear();
        world.wavePending = false;
        world.waveClearTimer = 0;
        spawnServerWave(world);
        break;
      }

      case "restart-wave": {
        world.enemies.clear();
        world.enemyProjectiles.clear();
        world.wavePending = false;
        world.waveClearTimer = 0;
        spawnServerWave(world);
        break;
      }

      case "prev-wave": {
        world.wave = Math.max(1, world.wave - 1);
        world.enemies.clear();
        world.enemyProjectiles.clear();
        world.wavePending = false;
        world.waveClearTimer = 0;
        spawnServerWave(world);
        break;
      }

      case "set-hp": {
        const amount = Math.max(1, parseInt(data.hp, 10) || 1);
        for (const tp of targetPlayers) {
          if (amount > tp.maxHp) tp.maxHp = amount;
          tp.hp = amount;
          tp.alive = true;
          if (tp.reviveBeacon) tp.reviveBeacon = null;
        }
        break;
      }

      case "god-mode": {
        for (const tp of targetPlayers) {
          tp._godMode = typeof data.enabled === "boolean" ? data.enabled : !tp._godMode;
          if (tp._godMode) {
            tp.alive = true;
            if (tp.reviveBeacon) tp.reviveBeacon = null;
          }
        }
        break;
      }

      case "revive-all": {
        for (const p of world.players.values()) {
          p.alive = true;
          p.hp = p.maxHp;
          p.invulnerability = 2.0;
          p.reviveBeacon = null;
          for (const b of world.bullets.values()) {
            if (b.ownerId === p.id) {
              b.state = "held";
              b.x = p.x;
              b.y = p.y;
              b.vx = 0;
              b.vy = 0;
              b.bounces = 0;
            }
          }
        }
        break;
      }

      case "trigger-upgrade": {
        startServerUpgradeRound(room);
        break;
      }

      case "give-upgrade": {
        if (data.upgradeId) {
          const power = Math.max(1, parseInt(data.power, 10) || 1);
          const count = Math.max(1, parseInt(data.count, 10) || 1);
          for (const tp of targetPlayers) {
            for (let i = 0; i < count; i++) {
              applyServerUpgrade(world, tp, {
                upgradeId: data.upgradeId,
                power
              });
            }
          }
        }
        break;
      }

      case "give-all-upgrades": {
        const allUpgradeIds = [
          "damage", "bounce", "pierce", "bullet-speed", "move-speed",
          "armor", "repair", "pickup", "magnet-range", "critical", "caliber",
          "second-bullet", "catch-blast", "emergency-repair", "explosive",
          "chain-lightning", "homing", "boomerang", "splinter", "stun",
          "reactive-armor", "target-mark", "poison", "poison-damage", "poison-duration",
          "parasite", "parasite-chance", "parasite-count", "parasite-damage"
        ];
        const power = Math.max(1, parseInt(data.power, 10) || 1);
        for (const tp of targetPlayers) {
          for (const uId of allUpgradeIds) {
            try {
              applyServerUpgrade(world, tp, { upgradeId: uId, power });
            } catch (e) {}
          }
        }
        break;
      }

      case "remove-upgrade": {
        if (data.upgradeId) {
          for (const tp of targetPlayers) {
            removeServerUpgrade(world, tp, data.upgradeId);
          }
        }
        break;
      }

      case "reset-upgrades": {
        for (const tp of targetPlayers) {
          resetServerPlayerUpgrades(world, tp);
        }
        break;
      }

      case "kill-all": {
        world.enemies.clear();
        world.enemyProjectiles.clear();
        break;
      }

      case "spawn-enemy": {
        const type = data.type || "normal";
        const count = Math.max(1, parseInt(data.count, 10) || 1);
        for (let i = 0; i < count; i++) {
          spawnServerEnemyFromEdge(world, type);
        }
        break;
      }

      case "set-level": {
        world.level = Math.max(1, parseInt(data.level, 10) || 1);
        world.experience = 0;
        world.experienceToNext = getServerExperienceRequirement(world.level);
        break;
      }

      case "add-level": {
        const count = Math.max(1, parseInt(data.count, 10) || 1);
        world.level += count;
        world.experience = 0;
        world.experienceToNext = getServerExperienceRequirement(world.level);
        break;
      }

      case "remove-level": {
        const count = Math.max(1, parseInt(data.count, 10) || 1);
        world.level = Math.max(1, world.level - count);
        world.experience = 0;
        world.experienceToNext = getServerExperienceRequirement(world.level);
        break;
      }

      case "add-exp": {
        const exp = Math.max(1, parseInt(data.amount, 10) || 10);
        addServerExperience(room, exp);
        break;
      }
    }

    io.to(room.code).emit(
      "net:snapshot",
      createServerCoopSnapshot(room)
    );
  });

  socket.on("net:set-skin", payload => {
    const room = getRoomForSocket(socket);
    const skin = sanitizeSkin(payload?.bulletSkin);
    if (room) {
      const p = room.players.get(socket.id);
      if (p) p.bulletSkin = skin;
      if (room.world) {
        const wp = room.world.players.get(socket.id);
        if (wp) wp.bulletSkin = skin;
        for (const b of room.world.bullets.values()) {
          if (b.ownerId === socket.id) b.skin = skin;
        }
      }
    }
  });

  socket.on("net:set-player-skin", payload => {
    const room = getRoomForSocket(socket);
    const skin = sanitizePlayerSkin(payload?.playerSkin);
    if (room) {
      const p = room.players.get(socket.id);
      if (p) p.playerSkin = skin;
      if (room.world) {
        const wp = room.world.players.get(socket.id);
        if (wp) wp.playerSkin = skin;
      }
    }
  });

  socket.on("net:shoot", payload => {
    const room =
      getRoomForSocket(socket);
  
    if (
      !room ||
      !room.started ||
      !room.world
    ) {
      return;
    }
    touchRoom(room);
  
    const aimX = Number.isFinite(Number(payload?.aimX))
      ? Number(payload.aimX)
      : Number(payload?.x);
    const aimY = Number.isFinite(Number(payload?.aimY))
      ? Number(payload.aimY)
      : Number(payload?.y);
    const shootX = Number.isFinite(Number(payload?.clientShootX))
      ? Number(payload.clientShootX)
      : Number.isFinite(Number(payload?.vx))
      ? Number(payload.vx)
      : undefined;
    const shootY = Number.isFinite(Number(payload?.clientShootY))
      ? Number(payload.clientShootY)
      : Number.isFinite(Number(payload?.vy))
      ? Number(payload.vy)
      : undefined;

    shootServerBullet(
      room,
      socket.id,
      aimX,
      aimY,
      shootX,
      shootY
    );
  });

  socket.on("net:reroll-offers", (payload, acknowledge) => {
    const room = getRoomForSocket(socket);
    const world = room?.world;
    const round = world?.upgradeRound;
    if (!room || !world || !round || payload?.offerId !== round.offerId || !round.waitingPlayers.has(socket.id)) {
      acknowledge?.({ success: false });
      return;
    }
    touchRoom(room);

    const player = world.players.get(socket.id);
    if (!player || (player.rerolls || 0) <= 0) {
      acknowledge?.({ success: false, message: "Нет доступных перебросов" });
      return;
    }

    player.rerolls -= 1;
    const newOffers = createServerUpgradeOffers(player);
    round.offersByPlayer.set(socket.id, newOffers);

    io.to(socket.id).emit("net:upgrade-offers", {
      offerId: round.offerId,
      playerLevel: world.level,
      pendingLevelUps: world.pendingLevelUps,
      offers: newOffers,
      rerolls: player.rerolls
    });

    sendAcknowledgement(acknowledge, { success: true, rerolls: player.rerolls });
  });

  socket.on(
    "net:upgrade-choice",
    payload => {
      const room =
        getRoomForSocket(socket);

      const world =
        room?.world;

      const round =
        world?.upgradeRound;

      if (
        !room ||
        !world ||
        !round ||
        payload?.offerId !==
          round.offerId ||
        !round.waitingPlayers.has(
          socket.id
        )
      ) {
        return;
      }
      touchRoom(room);

      const offers =
        round.offersByPlayer.get(
          socket.id
        );

      const index = Math.max(
        0,
        Math.min(
          2,
          Number(payload?.index) || 0
        )
      );

      const offer =
        offers?.[index];

      const player =
        world.players.get(
          socket.id
        );

      if (!offer || !player) {
        return;
      }

      const applied =
        applyServerUpgrade(
          world,
          player,
          offer
        );

      if (!applied) {
        return;
      }

      round.waitingPlayers.delete(
        socket.id
      );

      io.to(socket.id).emit(
        "net:game-event",
        {
          type:
            "upgrade-choice-accepted",

          offerId:
            round.offerId
        }
      );

      finishServerUpgradeRound(room);
    }
  );

  socket.on("net:game-event", payload => {
    const room = getRoomForSocket(socket);

    if (
      !room ||
      room.hostId !== socket.id
    ) {
      return;
    }
    touchRoom(room);

    socket
      .to(room.code)
      .emit("net:game-event", payload);
  });

  socket.on("room:reconnect", (payload, acknowledge) => {
    try {
      const code = sanitizeCode(payload?.code);
      const token = String(payload?.token || "").trim();
      const room = rooms.get(code);

      if (!room || !room.started || !room.world || room.world.gameOver) {
        acknowledge?.({
          success: false,
          message: "Активный забег не найден или уже завершён"
        });
        return;
      }

      touchRoom(room);

      let matchedPlayer = null;
      let oldPlayerId = null;

      for (const [pId, p] of room.players.entries()) {
        if (p.reconnectToken && p.reconnectToken === token) {
          matchedPlayer = p;
          oldPlayerId = pId;
          break;
        }
      }

      if (!matchedPlayer) {
        acknowledge?.({
          success: false,
          message: "Недействительный токен переподключения"
        });
        return;
      }

      if (room.reconnectTimeout) {
        clearTimeout(room.reconnectTimeout);
        room.reconnectTimeout = null;
      }

      if (oldPlayerId !== socket.id) {
        room.players.delete(oldPlayerId);
        matchedPlayer.id = socket.id;
        room.players.set(socket.id, matchedPlayer);

        if (room.hostId === oldPlayerId) {
          room.hostId = socket.id;
        }

        const coopPlayer = room.world.players.get(oldPlayerId);
        if (coopPlayer) {
          room.world.players.delete(oldPlayerId);
          coopPlayer.id = socket.id;
          room.world.players.set(socket.id, coopPlayer);
        }

        for (const bullet of room.world.bullets.values()) {
          if (bullet.ownerId === oldPlayerId) {
            bullet.ownerId = socket.id;
          }
        }

        ensureServerMagazine(room.world, coopPlayer);

        if (room.world.upgradeRound) {
          if (room.world.upgradeRound.waitingPlayers.has(oldPlayerId)) {
            room.world.upgradeRound.waitingPlayers.delete(oldPlayerId);
            room.world.upgradeRound.waitingPlayers.add(socket.id);
          }
          if (room.world.upgradeRound.offersByPlayer.has(oldPlayerId)) {
            const offers = room.world.upgradeRound.offersByPlayer.get(oldPlayerId);
            room.world.upgradeRound.offersByPlayer.delete(oldPlayerId);
            room.world.upgradeRound.offersByPlayer.set(socket.id, offers);
          }
        }
      }

      matchedPlayer.disconnected = false;
      matchedPlayer.disconnectTime = null;

      socket.data.roomCode = code;
      socket.data.role = matchedPlayer.role;
      socket.join(code);

      // Start smooth 3-second unfreeze countdown before resuming combat
      room.world.reconnectState = {
        unfreezing: true,
        countdown: 3.0,
        countdownSec: 3,
        playerName: matchedPlayer.name,
        role: matchedPlayer.role
      };

      const snapshot = createServerCoopSnapshot(room, { full: true });

      acknowledge?.({
        success: true,
        role: matchedPlayer.role,
        playerId: socket.id,
        reconnectToken: matchedPlayer.reconnectToken,
        room: getPublicRoomState(room),
        snapshot
      });

      io.to(room.code).emit("net:snapshot", snapshot);
      emitRoomState(room);
    } catch (err) {
      acknowledge?.({
        success: false,
        message: err?.message || "Ошибка переподключения"
      });
    }
  });

  socket.on("room:cancel-reconnect-wait", (payload, acknowledge) => {
    const room = getRoomForSocket(socket);
    if (!room) {
      acknowledge?.({ success: false });
      return;
    }
    if (room.reconnectTimeout) {
      clearTimeout(room.reconnectTimeout);
      room.reconnectTimeout = null;
    }
    closeRoom(room, "Ожидание напарника отменено игроком");
    acknowledge?.({ success: true });
  });

  socket.on("room:going-away", () => {
    const room = getRoomForSocket(socket);
    if (!room || !room.started || !room.world || room.world.gameOver) return;

    const player = room.players.get(socket.id);
    if (player && !player.disconnected) {
      player.disconnected = true;
      player.disconnectTime = Date.now();

      room.world.reconnectState = {
        paused: true,
        disconnectedId: player.id,
        playerName: player.name,
        role: player.role,
        expiresAt: Date.now() + 120000
      };

      if (room.reconnectTimeout) {
        clearTimeout(room.reconnectTimeout);
      }

      room.reconnectTimeout = setTimeout(() => {
        if (!rooms.has(room.code)) return;
        if (room.world && room.world.reconnectState?.paused) {
          closeRoom(room, "Время ожидания напарника (2 мин) истекло");
        }
      }, 120000);

      io.to(room.code).emit("net:snapshot", createServerCoopSnapshot(room));
      emitRoomState(room);
    }
  });

  socket.on("disconnect", () => {
    const room = getRoomForSocket(socket);
    if (!room) return;

    if (room.started && room.world && !room.world.gameOver) {
      const player = room.players.get(socket.id);
      if (player && !player.disconnected) {
        player.disconnected = true;
        player.disconnectTime = Date.now();

        room.world.reconnectState = {
          paused: true,
          disconnectedId: player.id,
          playerName: player.name,
          role: player.role,
          expiresAt: Date.now() + 120000
        };

        if (room.reconnectTimeout) {
          clearTimeout(room.reconnectTimeout);
        }

        room.reconnectTimeout = setTimeout(() => {
          if (!rooms.has(room.code)) return;
          if (room.world && room.world.reconnectState?.paused) {
            closeRoom(room, "Время ожидания напарника (2 мин) истекло");
          }
        }, 120000);

        socket.leave(room.code);
        socket.data.roomCode = null;
        socket.data.role = null;

        io.to(room.code).emit("net:snapshot", createServerCoopSnapshot(room));
        emitRoomState(room);
        return;
      }
    }

    leaveRoom(
      socket,
      "Игрок отключился"
    );
  });
});

/*
 * Самокорректирующийся планировщик тиков.
 *
 * setInterval в Node.js даёт систематический дрейф под нагрузкой event loop:
 * колбэки могут накапливаться и срабатывать пачками, из-за чего клиент видит
 * скачки джиттера (было: стабильно <10мс, затем скачки 30-80-110мс).
 *
 * Вместо фиксированного интервала считаем ожидаемое время следующего тика
 * от startTime и подстраиваем задержку setTimeout под фактически прошедшее
 * время. Если отставание слишком большое (событийный цикл был заблокирован
 * надолго), не пытаемся наверстать все пропущенные тики — просто
 * ресинхронизируемся, чтобы не создавать "лавину" догоняющих кадров.
 */
let lastCoopSimulationTime =
  Date.now();

const COOP_TICK_INTERVAL_NS =
  BigInt(Math.round(1e9 / COOP_SIMULATION_RATE));

let nextCoopTickExpected =
  process.hrtime.bigint();

function runCoopSimulationTick() {
  const currentTime = Date.now();

  const dt = Math.min(
    Math.max(
      (
        currentTime -
        lastCoopSimulationTime
      ) / 1000,
      0
    ),
    0.05
  );

  lastCoopSimulationTime =
    currentTime;

  for (const room of rooms.values()) {
    if (
      !room.started ||
      !room.world
    ) {
      continue;
    }

    updateServerCoopWorld(
      room,
      dt,
      currentTime
    );

    room.world.snapshotAccumulator +=
      dt;

    if (
      room.world.snapshotAccumulator >=
      1 / COOP_SNAPSHOT_RATE
    ) {
      room.world.snapshotAccumulator = Math.min(
        room.world.snapshotAccumulator - 1 / COOP_SNAPSHOT_RATE,
        0.1
      );

      const snapshot = createServerCoopSnapshot(room);
      io.to(room.code)
        .volatile
        .emit(
          "net:snapshot",
          snapshot
        );
      for (const p of room.world.players.values()) {
        p.statsDirty = false;
        p.upgradesDirty = false;
      }
    }
  }

  nextCoopTickExpected += COOP_TICK_INTERVAL_NS;
  const now = process.hrtime.bigint();
  let delayNs = nextCoopTickExpected - now;

  // Слишком большое отставание (лаг event loop, GC-пауза и т.д.) — ресинк без догонки.
  const maxLagNs = COOP_TICK_INTERVAL_NS * 4n;
  if (delayNs < -maxLagNs) {
    nextCoopTickExpected = now + COOP_TICK_INTERVAL_NS;
    delayNs = COOP_TICK_INTERVAL_NS;
  }

  const delayMs = Math.max(0, Number(delayNs) / 1e6);
  setTimeout(runCoopSimulationTick, delayMs);
}

setTimeout(runCoopSimulationTick, 1000 / COOP_SIMULATION_RATE);

setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    const isEmpty = !room.players || room.players.size === 0;
    // Комната считается "заброшенной" только если в ней вообще не осталось
    // реально подключённых игроков (все сокеты отключены). Раньше таймаут
    // неактивности срабатывал и для лобби, где игроки просто молча ждут
    // напарника — это и вызывало "вылет при айдл". Теперь простое бездействие
    // подключённых игроков никогда не закрывает комнату.
    const hasConnectedPlayer =
      !isEmpty &&
      [...room.players.values()].some(p => !p.disconnected);
    const lastActive = room.lastActivity || room.createdAt || now;
    const isStaleAbandoned =
      !isEmpty &&
      !hasConnectedPlayer &&
      now - lastActive > ROOM_INACTIVITY_TIMEOUT_MS;
    if (isEmpty || isStaleAbandoned) {
      cancelRoomCountdown(room);
      closeRoom(room, isEmpty ? "Комната пуста" : "Комната закрыта из-за неактивности");
    }
  }
}, 60000);

server.listen(PORT, "0.0.0.0", () => {
  console.log(
    `Один патрон запущен: http://localhost:${PORT}`
  );
});
