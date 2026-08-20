"use strict";

const path = require("path");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");

const PORT = Number(process.env.PORT) || 3000;

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*" },
  transports: ["websocket", "polling"],
  maxHttpBufferSize: 1e6,
  pingInterval: 10000,
  pingTimeout: 15000,
  perMessageDeflate: {
    threshold: 512
  }
});

app.get("/healthz", (req, res) => {
  res.status(200).send("OK");
});

app.use(
  express.static(
    path.join(__dirname, "public"),
    { maxAge: "1h", etag: true }
  )
);

const rooms = new Map();

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
    .slice(0, 6);
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
        createServerCoopSnapshot(room)
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

function emitRoomState(room) {
  io.to(room.code).emit(
    "room:state",
    getPublicRoomState(room)
  );
}

function closeRoom(room, reason) {
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

function leaveRoom(socket, reason = "Игрок вышел") {
  const room = getRoomForSocket(socket);

  if (!room) {
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

  // Гость вышел: комната остаётся у хоста, сбрасываем статус готовности и мир
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

    aimX: Number.isFinite(input?.aimX) ? Number(input.aimX) : 0,
    aimY: Number.isFinite(input?.aimY) ? Number(input.aimY) : 0,
    x: Number.isFinite(input?.x) ? Number(input.x) : null,
    y: Number.isFinite(input?.y) ? Number(input.y) : null
  };
}

const COOP_WORLD_WIDTH = 2560;
const COOP_WORLD_HEIGHT = 1374;

const COOP_PLAYER_SPEED = 285;
const COOP_SIMULATION_RATE = 60;
const COOP_SNAPSHOT_RATE = 20;

const COOP_INPUT_TIMEOUT = 500;

const COOP_BULLET_SPEED = 650;
const COOP_BULLET_RADIUS = 7;
const COOP_BULLET_BOUNCES = 1;
const COOP_BULLET_MAX_AGE = 6;
const COOP_BULLET_CATCH_DELAY = 0.24;

const COOP_ENEMY_COUNT_MULTIPLIER = 1.55;
const COOP_ENEMY_HP_MULTIPLIER = 1.35;
const COOP_BOSS_HP_MULTIPLIER = 2.4;

const COOP_WAVE_BREAK = 3.5;

const COOP_PLAYER_INVULNERABILITY = 0.22;
const COOP_ENEMY_CONTACT_COOLDOWN = 0.85;

const COOP_EXPERIENCE_MULTIPLIER = 1.45;

const COOP_CRYSTAL_RADIUS = 5;
const COOP_CRYSTAL_ATTRACTION_RADIUS = 180;
const COOP_CRYSTAL_ATTRACTION_SPEED = 430;
const COOP_CRYSTAL_CLEAR_SPEED = 900;


const COOP_DIFFICULTY = {
  easy: {
    playerHp: 7,
    enemySpeed: 0.86,
    enemyCount: 0.9
  },

  normal: {
    playerHp: 5,
    enemySpeed: 1,
    enemyCount: 1
  },

  hard: {
    playerHp: 4,
    enemySpeed: 1.16,
    enemyCount: 1.15
  }
};

function getServerExperienceRequirement(level) {
  const progression = Math.max(
    0,
    level - 1
  );

  const baseRequirement =
    5 +
    progression * 1.1 +
    progression * progression * 0.12;

  return Math.max(
    1,
    Math.floor(
      baseRequirement *
      COOP_EXPERIENCE_MULTIPLIER
    )
  );
}


function clamp(value, min, max) {
  return Math.max(
    min,
    Math.min(max, value)
  );
}

function random(min, max) {
  return (
    min +
    Math.random() * (max - min)
  );
}

function distance(
  ax,
  ay,
  bx,
  by
) {
  return Math.hypot(
    ax - bx,
    ay - by
  );
}


function getServerAimDirection(
  coopPlayer,
  aimX = coopPlayer.aimX,
  aimY = coopPlayer.aimY
) {
  let dx =
    Number(aimX) - coopPlayer.x;

  let dy =
    Number(aimY) - coopPlayer.y;

  const length =
    Math.hypot(dx, dy);

  if (
    !Number.isFinite(length) ||
    length < 0.001
  ) {
    return {
      x: 1,
      y: 0
    };
  }

  dx /= length;
  dy /= length;

  return {
    x: dx,
    y: dy
  };
}

function createServerBullet(
  world,
  owner
) {
  const direction =
    getServerAimDirection(owner);

  const bullet = {
    id:
      `${owner.id}:${world.nextBulletId++}`,

    ownerId: owner.id,
    colorIndex: owner.colorIndex,

    x:
      owner.x +
      direction.x *
        (
          owner.r +
          COOP_BULLET_RADIUS +
          2
        ),

    y:
      owner.y +
      direction.y *
        (
          owner.r +
          COOP_BULLET_RADIUS +
          2
        ),

    vx: 0,
    vy: 0,

    r:
      owner.stats?.bulletRadius ??
      COOP_BULLET_RADIUS,
    state: "held",
    age: 0,

    bouncesLeft:
      owner.stats?.maxBounces ??
      COOP_BULLET_BOUNCES,

    hitsLeft:
      1 +
      (owner.stats?.pierce || 0),

    hitEnemies: new Set()
  };

  world.bullets.set(
    bullet.id,
    bullet
  );

  return bullet;
}

function ensureServerMagazine(
  world,
  player
) {
  const currentCount = [
    ...world.bullets.values()
  ].filter(
    bullet =>
      bullet.ownerId === player.id
  ).length;

  const requiredCount =
    player.stats.magazineSize;

  for (
    let count = currentCount;
    count < requiredCount;
    count++
  ) {
    createServerBullet(
      world,
      player
    );
  }

  for (
    const bullet of
    world.bullets.values()
  ) {
    if (
      bullet.ownerId === player.id
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
}

function catchServerBullet(
  bullet,
  owner
) {
  bullet.hitEnemies.clear();
  bullet.state = "held";
  bullet.vx = 0;
  bullet.vy = 0;
  bullet.age = 0;

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
    if (dist < 180) {
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

function distToSegmentSquared(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const l2 = dx * dx + dy * dy;
  if (l2 === 0) return (px - x1) * (px - x1) + (py - y1) * (py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  const projX = x1 + t * dx;
  const projY = y1 + t * dy;
  const ex = px - projX;
  const ey = py - projY;
  return ex * ex + ey * ey;
}

function distToSegment(px, py, x1, y1, x2, y2) {
  return Math.sqrt(distToSegmentSquared(px, py, x1, y1, x2, y2));
}

function refreshServerBulletContacts(
  world,
  bullet
) {
  // Only remove destroyed/dead enemies so the bullet never turns back into or re-damages an already pierced living enemy during the same flight
  for (const enemyId of [...bullet.hitEnemies]) {
    const enemy = world.enemies.get(enemyId);
    if (!enemy || (Number.isFinite(enemy.hp) && enemy.hp <= 0)) {
      bullet.hitEnemies.delete(enemyId);
    }
  }
}


function applyServerSmartHoming(bullet, candidateEnemies, homingPower, dt) {
  if (homingPower <= 0 || !candidateEnemies || candidateEnemies.length === 0) return;
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
      if (distToOwner > owner.r + bullet.r) {
        const pullFactor = owner.stats.groundPullSpeed * dt;
        bullet.x += ((owner.x - bullet.x) / distToOwner) * pullFactor;
        bullet.y += ((owner.y - bullet.y) / distToOwner) * pullFactor;
      }
    }
    if (!owner.alive) {
      return;
    }

    const pickupDistance =
      owner.r +
      bullet.r +
      (owner.stats?.pickupRadius || 0);


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
    applyServerSmartHoming(bullet, [...world.enemies.values()], homingPower, dt);
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
    bullet
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

    bullet.hitsLeft -= 1;

    const baseDamage =
      owner.stats?.damage || 1;

    const critical =
      Math.random() <
      (owner.stats?.critChance || 0);

    const hitDamage =
      critical
        ? baseDamage * 2
        : baseDamage;

    damageServerEnemy(
      world,
      enemy.id,
      hitDamage
    );

    /*
     * Взрыв от улучшения "Разрывной сердечник"
     */
    if ((owner.stats?.explosionRadius || 0) > 0) {
      const expRadius = owner.stats.explosionRadius;
      const expDmg = Math.max(1, Math.floor((owner.stats?.damage || 1) * 0.5));
      for (const nearby of world.enemies.values()) {
        if (!nearby || nearby.id === enemy.id || !nearby.hasEnteredArena) continue;
        if (distance(enemy.x, enemy.y, nearby.x, nearby.y) <= expRadius + nearby.r) {
          damageServerEnemy(world, nearby.id, expDmg);
        }
      }
    }

    /*
     * Цепная молния от улучшения "Цепной конденсатор"
     */
    if ((owner.stats?.chainCount || 0) > 0) {
      const maxChains = owner.stats.chainCount;
      const chainRange = owner.stats.chainRange || 140;
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
        damageServerEnemy(world, nextTarget.id, 1);
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
      owner
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


function reviveServerPlayers(world) {
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

  let index = 0;

  for (
    const coopPlayer of
    world.players.values()
  ) {
    if (!coopPlayer.alive) {
      const position =
        spawnPositions[index] ||
        spawnPositions[0];

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
            coopPlayer
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
   * игрока не выберут личные улучшения.
   */
  if (world.upgradePaused || world.manualPaused) {
    return;
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

    if (!coopPlayer.alive) {
      continue;
    }

    updateServerCoopPlayer(
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
  const level = world.wave - 1;

  let radius = 14;
  let speed = 59 + level * 2.5;
  let baseHp = 1 + Math.floor(level / 5);
  let color = "#ff5577";

  if (type === "runner") {
    radius = 10;
    speed = 105 + level * 3;
    baseHp = 1 + Math.floor(level / 7);
    color = "#ffca55";
  }

  if (type === "tank") {
    radius = 21;
    speed = 39 + level * 1.5;
    baseHp = 3 + Math.floor(level / 3);
    color = "#b56dff";
  }

  if (type === "charger") {
    radius = 13;
    speed = 63 + level * 2;
    baseHp = 2 + Math.floor(level / 6);
    color = "#ff814a";
  }

  if (type === "splitter") {
    radius = 18;
    speed = 50 + level * 1.7;
    baseHp = 2 + Math.floor(level / 4);
    color = "#46b8ff";
  }

  if (type === "shard") {
    radius = 8;
    speed = 125 + level * 2.5;
    baseHp = 1 + Math.floor(level / 9);
    color = "#79d7ff";
  }

  if (type === "boss") {
    const bossTier = Math.max(
      1,
      Math.floor(world.wave / 5)
    );

    const progressionTier =
      bossTier - 1;

    radius = 46;

    speed =
      38 +
      progressionTier * 2.2 * 1.3;

    baseHp =
      48 +
      progressionTier * 20 * 1.3;

    color = "#ff3f8f";
  }

  const hpMultiplier =
    type === "boss"
      ? COOP_BOSS_HP_MULTIPLIER
      : COOP_ENEMY_HP_MULTIPLIER;

  const hp = Math.max(
    1,
    Math.round(baseHp * hpMultiplier)
  );

  let shootCooldown = 0;
  let radialCooldown = 0;
  let preferredDistance = 0;
  let strafeDirection = Math.random() < 0.5 ? -1 : 1;

  if (type === "boss") {
    shootCooldown = 1.4;
    radialCooldown = 3.6;
  } else if (type === "shooter") {
    preferredDistance = random(260, 360);
    shootCooldown = random(0.8, 1.8);
  }

  return {
    id: world.nextEnemyId++,
    type,

    x,
    y,

    r: radius,
    speed,
    hp,
    maxHp: hp,
    color,

    spawnEdge: null,
    spawnWarningX: x,
    spawnWarningY: y,
    spawnDelay: 0,
    hasEnteredArena: spawnedInside,

    contactCooldown: 0,
    isCharging: false,
    shootCooldown,
    radialCooldown,
    preferredDistance,
    strafeDirection,
    phase: 0
  };
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

    const escortCount = Math.min(
      1 + Math.floor(bossTier / 2),
      4
    );

    for (
      let i = 0;
      i < escortCount;
      i++
    ) {
      const escortType =
        Math.random() < 0.5
          ? "runner"
          : "normal";

      spawnServerEnemyFromEdge(
        world,
        escortType
      );
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
      world.wave >= 7 &&
      roll < 0.1
    ) {
      type = "splitter";
    } else if (
      world.wave >= 4 &&
      roll < 0.27
    ) {
      type = "charger";
    } else if (
      world.wave >= 3 &&
      roll < 0.43
    ) {
      type = "tank";
    } else if (
      world.wave >= 2 &&
      roll < 0.66
    ) {
      type = "runner";
    }

    spawnServerEnemyFromEdge(
      world,
      type
    );
  }
}

function createServerPlayerStats() {
  return {
    playerSpeed: COOP_PLAYER_SPEED,

    bulletSpeed: COOP_BULLET_SPEED,
    bulletRadius: COOP_BULLET_RADIUS,

    damage: 1,
    critChance: 0,

    maxBounces: COOP_BULLET_BOUNCES,
    pierce: 0,

    pickupRadius: 0,
    magazineSize: 1
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

const SERVER_UPGRADES = [
  {
    id: "damage",
    title: "Тяжёлая пуля",
    description:
      "Увеличивает урон ваших патронов.",
    bonus(player, power) {
      return `+${power} к урону`;
    }
  },

  {
    id: "bounce",
    title: "Дополнительный рикошет",
    description:
      "Ваши патроны могут дополнительно отскакивать от стен.",
    bonus(player, power) {
      return `+${power} к количеству рикошетов`;
    }
  },

  {
    id: "pierce",
    title: "Пробитие",
    description:
      "Ваши патроны пробивают дополнительные цели.",
    available(player) {
      const hasAoe = (player.stats?.explosionRadius || 0) > 0 ||
                     (player.stats?.chainCount || 0) > 0 ||
                     (player.stats?.catchBlast || 0) > 0;
      return !hasAoe;
    },
    bonus(player, power) {
      return `+${power} к количеству пробиваемых целей`;
    }
  },

  {
    id: "bullet-speed",
    title: "Разогнанный ствол",
    description:
      "Увеличивает скорость ваших патронов.",
    bonus(player, power) {
      return `+${18 * power}% к скорости патрона`;
    }
  },

  {
    id: "move-speed",
    title: "Лёгкие ботинки",
    description:
      "Увеличивает скорость передвижения.",
    bonus(player, power) {
      return `+${12 * power}% к скорости движения`;
    }
  },

  {
    id: "armor",
    title: "Усиленная броня",
    description:
      "Повышает максимальное и текущее здоровье.",
    bonus(player, power) {
      return (
        `+${power} к максимальному здоровью ` +
        `и +${power} к текущему`
      );
    }
  },

  {
    id: "repair",
    title: "Ремонтный комплект",
    description:
      "Полностью восстанавливает здоровье.",
    fixedRarity: "common",
    available(player) {
      return player.hp < player.maxHp;
    },
    bonus(player) {
      return (
        `+${Math.max(
          0,
          player.maxHp - player.hp
        )} здоровья`
      );
    }
  },

  {
    id: "pickup",
    title: "Магнитный захват",
    description:
      "Увеличивает расстояние подбора ваших патронов.",
    available(player) {
      return (player.stats?.groundPullSpeed || 0) <= 0;
    },
    bonus(player, power) {
      const pixels = 35 * power;
      const cells = (
        pixels / 48
      ).toFixed(2);

      return (
        `+${pixels} ед. ` +
        `(${cells} клетки) к радиусу подбора`
      );
    }
  },

  {
    id: "critical",
    title: "Критический механизм",
    description:
      "Повышает шанс нанести двойной урон.",
    available(player) {
      return player.stats.critChance < 0.6;
    },
    bonus(player, power) {
      const current =
        player.stats.critChance;

      const result = Math.min(
        0.6,
        current + 0.12 * power
      );

      const actual =
        Math.max(
          0,
          result - current
        );

      return (
        `+${Math.round(actual * 100)}% ` +
        `к шансу крита, итог: ` +
        `${Math.round(result * 100)}%`
      );
    }
  },

  {
    id: "caliber",
    title: "Крупный калибр",
    description:
      "Увеличивает размер ваших патронов.",
    available(player) {
      return player.stats.bulletRadius < 15;
    },
    bonus(player, power) {
      const result = Math.min(
        15,
        player.stats.bulletRadius +
          1.5 * power
      );

      return (
        `+${(
          result -
          player.stats.bulletRadius
        ).toFixed(1)} к радиусу патрона, ` +
        `итог: ${result.toFixed(1)}`
      );
    }
  },

  {
    id: "second-bullet",
    title: "Запасной патрон",
    description:
      "Добавляет второй независимый патрон.",
    fixedRarity: "common",
    available(player) {
      return player.stats.magazineSize < 2;
    },
    bonus() {
      return "+1 независимый патрон";
    }
  },

  {
    id: "catch-blast",
    title: "Импульсный захват",
    description: "Пойманная пуля наносит урон ближайшим врагам.",
    available(player) {
      return (player.stats?.pierce || 0) <= 0;
    },
    bonus(player, power) {
      const result = (player.stats.catchBlast || 0) + 65 * power;
      return `+${65 * power} к радиусу волны (итог: ${result} px)`;
    }
  },

  {
    id: "emergency-repair",
    title: "Аварийный ремонт",
    description: "Убийства периодически восстанавливают 1 здоровье.",
    bonus(player, power) {
      const current = player.stats.healEvery || 0;
      let nextVal = 16;
      if (current === 0) {
        nextVal = power >= 3 ? 10 : power >= 2 ? 13 : 16;
      } else {
        nextVal = Math.max(4, current - (power >= 3 ? 4 : power >= 2 ? 3 : 2));
      }
      return `Лечение каждые ${nextVal} убийств`;
    }
  },

  {
    id: "explosive",
    title: "Разрывной сердечник",
    description: "Попадание создаёт взрыв, повреждающий соседних врагов.",
    available(player) {
      return (player.stats?.pierce || 0) <= 0;
    },
    bonus(player, power) {
      const result = (player.stats.explosionRadius || 0) + 40 * power;
      return `+${40 * power} к радиусу взрыва (итог: ${result} px)`;
    }
  },

  {
    id: "chain-lightning",
    title: "Цепной конденсатор",
    description: "Попадание выпускает разряд в ближайшего противника.",
    available(player) {
      return (player.stats?.pierce || 0) <= 0;
    },
    bonus(player, power) {
      const count = (player.stats.chainCount || 0) + power;
      return `+${power} цепных целей (итог: ${count})`;
    }
  },

  {
    id: "homing",
    title: "Умная пуля",
    description: "Пуля корректирует траекторию к ближайшей цели.",
    bonus(player, power) {
      const current = (player.stats.homing || 0) + power;
      return `+${power} к силе наведения (итог: ${current})`;
    }
  },

  {
    id: "recall-magnet",
    title: "Возвратный магнит",
    description: "Лежащие патроны начинают лететь к игроку.",
    available(player) {
      return (player.stats?.pickupRadius || 0) <= 0;
    },
    bonus(player, power) {
      const result = (player.stats.groundPullSpeed || 0) + 110 * power;
      return `+${110 * power} к скорости притяжения (итог: ${result} px/с)`;
    }
  },
];

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
    experienceCrystals: new Map(),
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
      
        stats: {
          playerSpeed:
            COOP_PLAYER_SPEED,
        
          bulletSpeed:
            COOP_BULLET_SPEED,
        
          bulletRadius:
            COOP_BULLET_RADIUS,
        
          damage: 1,
          maxBounces:
            COOP_BULLET_BOUNCES,
        
          pierce: 0,
          pickupRadius: 0,
          critChance: 0,
          magazineSize: 1
        },
      
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
    !coopPlayer.alive ||
    coopPlayer.invulnerability > 0 ||
    world.gameOver
  ) {
    return false;
  }

  coopPlayer.hp = Math.max(
    0,
    coopPlayer.hp - amount
  );

  coopPlayer.invulnerability =
    COOP_PLAYER_INVULNERABILITY;

  if (coopPlayer.hp <= 0) {
    coopPlayer.alive = false;

    const alivePlayers = [
      ...world.players.values()
    ].filter(player => player.alive);

    if (alivePlayers.length === 0) {
      world.gameOver = true;
      const r = [...rooms.values()].find(rm => rm.world === world);
      if (r) {
        cancelRoomCountdown(r);
        for (const p of r.players.values()) {
          p.ready = false;
        }
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
  if (enemy.type === "tank") {
    return 2;
  }

  if (
    enemy.type === "charger" &&
    enemy.isCharging
  ) {
    return 2;
  }

  if (enemy.type === "boss") {
    return world.wave >= 15
      ? 2
      : 1;
  }

  return 1;
}

function getServerEnemyExperience(enemy) {
  if (enemy.type === "boss") {
    return 10;
  }

  if (
    enemy.type === "tank" ||
    enemy.type === "charger" ||
    enemy.type === "splitter"
  ) {
    return 2;
  }

  return 1;
}

function createServerExperienceCrystal(
  world,
  x,
  y,
  value = 1
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
  const amount =
    getServerEnemyExperience(enemy);

  for (
    let index = 0;
    index < amount;
    index++
  ) {
    createServerExperienceCrystal(
      world,
      enemy.x + random(-6, 6),
      enemy.y + random(-6, 6),
      1
    );
  }
}

function killServerEnemy(
  world,
  enemy
) {
  if (!world.enemies.has(enemy.id)) {
    return;
  }

  dropServerExperience(
    world,
    enemy
  );

  world.enemies.delete(enemy.id);

  world.kills += 1;

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
}

function damageServerEnemy(
  world,
  enemyId,
  amount
) {
  const enemy =
    world.enemies.get(enemyId);

  if (!enemy) {
    return false;
  }

  enemy.hp -= amount;

  if (enemy.hp <= 0) {
    killServerEnemy(
      world,
      enemy
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
  damage = 1
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

  const projectileSpeed = 225 + world.wave * 4;

  createServerEnemyProjectile(
    world,
    enemy.x + Math.cos(angle) * (enemy.r + 7),
    enemy.y + Math.sin(angle) * (enemy.r + 7),
    angle,
    projectileSpeed,
    5,
    "#67ff9a",
    1
  );
}

function shootServerBossSpread(world, enemy, target, phase) {
  const baseAngle = Math.atan2(
    target.y - enemy.y,
    target.x - enemy.x
  );

  const projectileCount = 3 + phase;
  const spread = 0.19;
  const progressionWaves = Math.max(0, world.wave - 5);
  const speed = 225 + progressionWaves * 3 * 1.3;

  for (let i = 0; i < projectileCount; i++) {
    const offset = (i - (projectileCount - 1) / 2) * spread;
    const angle = baseAngle + offset;

    createServerEnemyProjectile(
      world,
      enemy.x + Math.cos(angle) * (enemy.r + 8),
      enemy.y + Math.sin(angle) * (enemy.r + 8),
      angle,
      speed,
      7,
      "#ff4f91",
      1
    );
  }

  // На 2 и 3 фазе босс также стреляет в другого живого игрока
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
          7,
          "#ff4f91",
          1
        );
      }
    }
  }
}

function shootServerBossRadial(world, enemy, phase) {
  const projectileCount = 8 + phase * 2;
  const progressionWaves = Math.max(0, world.wave - 5);
  const speed = 145 + phase * 20 + progressionWaves * 2 * 1.3;
  const rotation = Date.now() * 0.0009;

  for (let i = 0; i < projectileCount; i++) {
    const angle = rotation + Math.PI * 2 * i / projectileCount;

    createServerEnemyProjectile(
      world,
      enemy.x + Math.cos(angle) * (enemy.r + 5),
      enemy.y + Math.sin(angle) * (enemy.r + 5),
      angle,
      speed,
      6.5,
      "#ff9b45",
      1
    );
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

      const entryDx = entryTarget.x - enemy.x;
      const entryDy = entryTarget.y - enemy.y;
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

      if (isServerEnemyInside(enemy)) {
        enemy.hasEnteredArena = true;
      }

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

    if (enemy.type === "boss") {
      const hpRatio = enemy.hp / (enemy.maxHp || 1);
      const phase = hpRatio < 0.33 ? 2 : hpRatio < 0.66 ? 1 : 0;
      enemy.phase = phase;

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

      if (enemy.hasEnteredArena) {
        enemy.shootCooldown -= dt;
        enemy.radialCooldown -= dt;

        if (enemy.shootCooldown <= 0) {
          shootServerBossSpread(world, enemy, target, phase);
          enemy.shootCooldown = Math.max(0.9, 1.4 - phase * 0.16);
        }

        if (enemy.radialCooldown <= 0) {
          shootServerBossRadial(world, enemy, phase);
          enemy.radialCooldown = Math.max(2.8, 4.0 - phase * 0.4);
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
          enemy.shootCooldown = Math.max(0.7, 1.7 - world.wave * 0.025);
        }
      }
    } else {
      let speedMultiplier = 1;

      if (
        enemy.type === "charger" &&
        targetDistance < 240
      ) {
        speedMultiplier = 2.35;
        enemy.isCharging = true;
      }

      enemy.x +=
        dx *
        enemy.speed *
        difficulty.enemySpeed *
        speedMultiplier *
        dt;

      enemy.y +=
        dy *
        enemy.speed *
        difficulty.enemySpeed *
        speedMultiplier *
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

  resolveServerEnemyOverlaps(world);
}

function updateServerCoopPlayer(
  coopPlayer,
  dt,
  currentTime
) {
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
  world,
  player,
  offer
) {
  const power = Math.max(
    1,
    Number(offer.power) || 1
  );

  switch (offer.upgradeId) {
    case "damage":
      player.stats.damage += power;
      break;

    case "bounce":
      player.stats.maxBounces += power;
      break;

    case "pierce":
      player.stats.pierce += power;
      break;

    case "bullet-speed":
      player.stats.bulletSpeed +=
        COOP_BULLET_SPEED *
        0.18 *
        power;
      break;

    case "move-speed":
      player.stats.playerSpeed +=
        COOP_PLAYER_SPEED *
        0.12 *
        power;
      break;

    case "armor":
      player.maxHp += power;
      player.hp += power;
      break;

    case "repair":
      player.hp = player.maxHp;
      break;

    case "pickup":
      player.stats.pickupRadius +=
        35 * power;
      break;

    case "critical":
      player.stats.critChance =
        Math.min(
          0.6,
          player.stats.critChance +
            0.12 * power
        );
      break;

    case "caliber":
      player.stats.bulletRadius =
        Math.min(
          15,
          player.stats.bulletRadius +
            1.5 * power
        );

      ensureServerMagazine(
        world,
        player
      );
      break;

    case "second-bullet":
      player.stats.magazineSize = 2;

      ensureServerMagazine(
        world,
        player
      );
      break;

    case "homing":
      player.stats.homing = (player.stats.homing || 0) + power;
      break;

    case "catch-blast":
      player.stats.catchBlast = (player.stats.catchBlast || 0) + 65 * power;
      break;

    case "emergency-repair": {
      const current = player.stats.healEvery || 0;
      if (current === 0) {
        player.stats.healEvery = power >= 3 ? 10 : power >= 2 ? 13 : 16;
      } else {
        player.stats.healEvery = Math.max(4, current - (power >= 3 ? 4 : power >= 2 ? 3 : 2));
      }
      player.stats.repairKillProgress = Math.min(
        player.stats.repairKillProgress || 0,
        Math.max(0, player.stats.healEvery - 1)
      );
      break;
    }

    case "explosive":
      player.stats.explosionRadius = (player.stats.explosionRadius || 0) + 40 * power;
      break;

    case "chain-lightning":
      player.stats.chainCount = (player.stats.chainCount || 0) + power;
      player.stats.chainRange = (player.stats.chainRange || 140) + 15 * power;
      break;

    case "recall-magnet":
      player.stats.groundPullSpeed = (player.stats.groundPullSpeed || 0) + 110 * power;
      break;

    default:
      return false;
  }

  player.selectedUpgrades.push({
    upgradeId: offer.upgradeId,
    title: offer.title || offer.upgrade?.title || offer.upgradeId,
    description: offer.description || offer.upgrade?.description || "",
    rarityKey: offer.rarityKey || offer.rarity?.key || "common",
    rarityLabel: offer.rarityLabel || offer.rarity?.label || "ОБЫЧНОЕ",
    power,
    bonusText: offer.bonusText || ""
  });

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
    for (const p of world.players.values()) {
      p.rerolls = (p.rerolls || 0) + 1;
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

function createServerCoopSnapshot(room) {
  const world = room.world;

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

      x: Math.round(coopPlayer.x * 10) / 10,
      y: Math.round(coopPlayer.y * 10) / 10,

      aimX: Math.round(coopPlayer.aimX),
      aimY: Math.round(coopPlayer.aimY),

      r: coopPlayer.r,
      colorIndex: coopPlayer.colorIndex,

      hp: coopPlayer.hp,
      maxHp: coopPlayer.maxHp,

      alive: coopPlayer.alive,
      invulnerability: coopPlayer.invulnerability > 0 ? Number(coopPlayer.invulnerability.toFixed(2)) : 0,

      stats: coopPlayer.stats,
      selectedUpgrades: coopPlayer.selectedUpgrades
    })),

    bullets: [
      ...world.bullets.values()
    ].map(bullet => ({
      id: bullet.id,
      ownerId: bullet.ownerId,

      x: Math.round(bullet.x * 10) / 10,
      y: Math.round(bullet.y * 10) / 10,

      vx: Math.round(bullet.vx),
      vy: Math.round(bullet.vy),

      r: bullet.r,
      state: bullet.state,
      age: Number(bullet.age.toFixed(2)),

      bouncesLeft: bullet.bouncesLeft,
      colorIndex: bullet.colorIndex
    })),

    enemies: [
      ...world.enemies.values()
    ].map(enemy => ({
      id: enemy.id,
      type: enemy.type,

      x: Math.round(enemy.x),
      y: Math.round(enemy.y),

      r: enemy.r,
      hp: enemy.hp,
      maxHp: enemy.maxHp,

      color: enemy.color,

      spawnEdge:
        enemy.spawnEdge,

      spawnWarningX:
        Math.round(enemy.spawnWarningX || 0),

      spawnWarningY:
        Math.round(enemy.spawnWarningY || 0),

      spawnDelay:
        enemy.spawnDelay,

      hasEnteredArena:
        enemy.hasEnteredArena,

      isCharging:
        enemy.isCharging
    })),

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
    }))
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
  
    socket.emit(
      "net:snapshot",
      createServerCoopSnapshot(room)
    );
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
          started: false,
          createdAt: Date.now(),
          players: new Map()
        };

        room.players.set(socket.id, {
          id: socket.id,
          name,
          role: "host",
          ready: true
        });

        rooms.set(code, room);

        socket.data.roomCode = code;
        socket.data.role = "host";
        socket.join(code);

        acknowledge?.({
          success: true,
          role: "host",
          playerId: socket.id,
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

      if (room.started) {
        acknowledge?.({
          success: false,
          message: "Забег уже начался"
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

      room.players.set(socket.id, {
        id: socket.id,
        name,
        role: "guest",
        ready: false
      });

      socket.data.roomCode = code;
      socket.data.role = "guest";
      socket.join(code);

      acknowledge?.({
        success: true,
        role: "guest",
        playerId: socket.id,
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
    if (!room) {
      acknowledge?.({ success: false, message: "Комната не найдена" });
      return;
    }

    room.started = true;
    room.world = createCoopWorld(room);

    io.to(room.code).emit("room:started", {
      difficulty: room.difficulty
    });

    io.to(room.code).emit(
      "net:snapshot",
      createServerCoopSnapshot(room)
    );

    emitRoomState(room);
    sendAcknowledgement(acknowledge, { success: true });
  });

  socket.on("room:return-to-lobby", (payload, acknowledge) => {
    const room = getRoomForSocket(socket);
    if (!room) {
      acknowledge?.({ success: false, message: "Комната не найдена" });
      return;
    }

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
    if (!room || room.started) {
      acknowledge?.({ success: false, message: "Комната не найдена или игра уже начата" });
      return;
    }

    const player = room.players.get(socket.id);
    if (!player) {
      acknowledge?.({ success: false, message: "Игрок не найден" });
      return;
    }

    player.ready = Boolean(payload?.ready);

    if (room.players.size === 2 && [...room.players.values()].every(p => p.ready)) {
      startRoomCountdown(room);
    } else {
      cancelRoomCountdown(room);
    }

    emitRoomState(room);
    sendAcknowledgement(acknowledge, { success: true, ready: player.ready });
  });

  socket.on("room:set-difficulty", (payload, acknowledge) => {
    const room = getRoomForSocket(socket);
    if (!room || room.hostId !== socket.id) {
      acknowledge?.({ success: false });
      return;
    }
    if (payload?.difficulty) {
      room.difficulty = String(payload.difficulty);
      emitRoomState(room);
    }
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

      if (room.players.size !== 2) {
        acknowledge?.({
          success: false,
          message: "Нужно дождаться второго игрока"
        });

        return;
      }

      room.started = true;
      
      room.difficulty =
        String(
          payload?.difficulty ||
          "normal"
        );
      
      room.world =
        createCoopWorld(room);
      
      io.to(room.code).emit("room:started", {
        difficulty: room.difficulty
      });
      
      io.to(room.code).emit(
        "net:snapshot",
        createServerCoopSnapshot(room)
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

  socket.on("net:toggle-pause", () => {
    const room = getRoomForSocket(socket);
    if (!room || !room.started || !room.world || room.world.gameOver) {
      return;
    }
    room.world.manualPaused = !room.world.manualPaused;
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
  
    shootServerBullet(
      room,
      socket.id,
      Number(payload?.aimX),
      Number(payload?.aimY),
      Number(payload?.x),
      Number(payload?.y)
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

    socket
      .to(room.code)
      .emit("net:game-event", payload);
  });

  socket.on("disconnect", () => {
    leaveRoom(
      socket,
      "Игрок отключился"
    );
  });
});

let lastCoopSimulationTime =
  Date.now();

setInterval(() => {
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
      room.world.snapshotAccumulator = 0;

      io.to(room.code)
        .emit(
          "net:snapshot",
          createServerCoopSnapshot(room)
        );
    }
  }
}, 1000 / COOP_SIMULATION_RATE);

server.listen(PORT, "0.0.0.0", () => {
  console.log(
    `Один патрон запущен: http://localhost:${PORT}`
  );
});
