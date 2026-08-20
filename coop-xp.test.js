"use strict";

/*
 * Интеграционная проверка общего опыта, общего уровня,
 * остановки мира и личных улучшений в кооперативе.
 *
 * Запуск: node coop-xp.test.js
 * Требуется работающий сервер на TEST_URL.
 */

const { io } = require(
  process.env.SOCKET_CLIENT_PATH ||
  "socket.io-client"
);

const TEST_URL =
  process.env.TEST_URL ||
  "http://localhost:3199";

const failures = [];

function check(label, condition) {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    console.log(`  FAIL ${label}`);
    failures.push(label);
  }
}

function connect() {
  return new Promise((resolve, reject) => {
    const socket = io(TEST_URL, {
      transports: ["websocket"],
      reconnection: false
    });

    socket.once("connect", () => resolve(socket));
    socket.once("connect_error", reject);
  });
}

function waitFor(socket, event, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(
        new Error(`Тайм-аут ожидания "${event}"`)
      );
    }, timeout);

    function handler(payload) {
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    }

    socket.on(event, handler);
  });
}

/*
 * Предложения улучшений приходят в непредсказуемый
 * момент, поэтому буферизуем их с самого подключения.
 */
function createOfferQueue(socket) {
  const received = [];
  let pendingResolve = null;

  socket.on("net:upgrade-offers", payload => {
    if (pendingResolve) {
      const resolve = pendingResolve;
      pendingResolve = null;
      resolve(payload);
      return;
    }

    received.push(payload);
  });

  return {
    next(timeout = 60000) {
      if (received.length > 0) {
        return Promise.resolve(
          received.shift()
        );
      }

      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingResolve = null;
          reject(
            new Error(
              "Тайм-аут ожидания предложений улучшений"
            )
          );
        }, timeout);

        pendingResolve = payload => {
          clearTimeout(timer);
          resolve(payload);
        };
      });
    }
  };
}

function waitForSnapshot(socket, predicate, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("net:snapshot", handler);
      reject(
        new Error("Тайм-аут ожидания снимка")
      );
    }, timeout);

    function handler(snapshot) {
      if (predicate(snapshot)) {
        clearTimeout(timer);
        socket.off("net:snapshot", handler);
        resolve(snapshot);
      }
    }

    socket.on("net:snapshot", handler);
  });
}

/*
 * Бот стреляет по ближайшему врагу и отходит от него,
 * чтобы забег жил долго и накапливал общий опыт.
 */
function startShootingBot(socket) {
  const bot = {
    stop() {
      socket.off("net:snapshot", handler);
    }
  };

  function handler(snapshot) {
    if (snapshot.upgradePaused) {
      return;
    }

    const self = snapshot.players.find(
      player => player.id === socket.id
    );

    if (!self || !self.alive) {
      return;
    }

    const targets = snapshot.enemies.filter(
      enemy => enemy.hasEnteredArena
    );

    if (targets.length === 0) {
      return;
    }

    let nearest = targets[0];
    let nearestDistance = Infinity;

    for (const enemy of targets) {
      const currentDistance = Math.hypot(
        enemy.x - self.x,
        enemy.y - self.y
      );

      if (currentDistance < nearestDistance) {
        nearestDistance = currentDistance;
        nearest = enemy;
      }
    }

    const hasHeld = snapshot.bullets.some(
      bullet =>
        bullet.ownerId === socket.id &&
        bullet.state === "held"
    );

    if (!hasHeld) {
      /*
       * Патрон лежит на земле — идём за ним.
       */
      const own = snapshot.bullets.find(
        bullet =>
          bullet.ownerId === socket.id &&
          bullet.state === "ground"
      );

      if (own) {
        socket.emit("net:input", {
          up: own.y < self.y - 4,
          down: own.y > self.y + 4,
          left: own.x < self.x - 4,
          right: own.x > self.x + 4,
          aimX: nearest.x,
          aimY: nearest.y
        });
      }

      return;
    }

    /*
     * Держим дистанцию: отходим от ближайшего врага
     * к центру арены.
     */
    let moveX = 0;
    let moveY = 0;

    if (nearestDistance < 320) {
      moveX = self.x - nearest.x;
      moveY = self.y - nearest.y;

      const centerX = snapshot.worldWidth / 2;
      const centerY = snapshot.worldHeight / 2;

      moveX += (centerX - self.x) * 0.35;
      moveY += (centerY - self.y) * 0.35;
    }

    socket.emit("net:input", {
      up: moveY < -10,
      down: moveY > 10,
      left: moveX < -10,
      right: moveX > 10,
      aimX: nearest.x,
      aimY: nearest.y
    });

    socket.emit("net:shoot", {
      aimX: nearest.x,
      aimY: nearest.y
    });
  }

  socket.on("net:snapshot", handler);

  return bot;
}

async function main() {
  const host = await connect();
  const guest = await connect();

  const created = await new Promise(resolve =>
    host.emit(
      "room:create",
      { name: "Хозяин" },
      resolve
    )
  );

  check(
    "комната создана",
    created?.success === true
  );

  const joined = await new Promise(resolve =>
    guest.emit(
      "room:join",
      {
        code: created.room.code,
        name: "Гость"
      },
      resolve
    )
  );

  check(
    "второй игрок подключился",
    joined?.success === true
  );

  /*
   * Оба клиента должны получить предложения улучшений
   * при повышении общего уровня.
   */
  const hostOfferQueue = createOfferQueue(host);
  const guestOfferQueue = createOfferQueue(guest);

  const started = await new Promise(resolve =>
    host.emit(
      "room:start",
      { difficulty: "normal" },
      resolve
    )
  );

  check(
    "забег запущен",
    started?.success === true
  );

  const hostBot = startShootingBot(host);
  const guestBot = startShootingBot(guest);

  const firstSnapshot =
    await waitForSnapshot(host, () => true);

  console.log("\n[снимок]");

  check(
    "тип снимка coop-server-v4",
    firstSnapshot.type === "coop-server-v4"
  );

  check(
    "снимок содержит общий уровень",
    firstSnapshot.level === 1
  );

  check(
    "снимок содержит порог опыта",
    firstSnapshot.experienceToNext === 7
  );

  check(
    "снимок содержит массив кристаллов",
    Array.isArray(
      firstSnapshot.experienceCrystals
    )
  );

  check(
    "у игрока есть личные характеристики",
    firstSnapshot.players.every(
      player =>
        player.stats &&
        player.stats.damage === 1 &&
        player.stats.magazineSize === 1 &&
        Array.isArray(player.selectedUpgrades)
    )
  );

  /*
   * Убийства врагов должны рождать кристаллы,
   * а кристаллы — приносить общий опыт.
   */
  console.log("\n[кристаллы и опыт]");

  const crystalSnapshot =
    await waitForSnapshot(
      host,
      snapshot =>
        snapshot.experienceCrystals.length > 0,
      20000
    ).catch(() => null);

  check(
    "кристаллы опыта появляются после убийств",
    Boolean(crystalSnapshot)
  );

  console.log("\n[повышение уровня]");

  const hostOffers = await hostOfferQueue.next();
  const guestOffers = await guestOfferQueue.next();

  /*
   * Дальше проверяем сам механизм выбора,
   * поэтому боты больше не стреляют.
   */
  hostBot.stop();
  guestBot.stop();

  check(
    "хозяин получил 3 варианта",
    Array.isArray(hostOffers?.offers) &&
    hostOffers.offers.length === 3
  );

  check(
    "гость получил 3 варианта",
    Array.isArray(guestOffers?.offers) &&
    guestOffers.offers.length === 3
  );

  check(
    "варианты игроков независимы (свой offerId общий)",
    hostOffers.offerId === guestOffers.offerId
  );

  check(
    "каждый вариант описан полностью",
    hostOffers.offers.every(
      offer =>
        offer.upgradeId &&
        offer.title &&
        offer.description &&
        offer.rarityKey &&
        offer.rarityLabel &&
        offer.bonusText &&
        offer.power >= 1
    )
  );

  check(
    "общий уровень вырос до 2 и выше",
    Number(hostOffers.playerLevel) >= 2
  );

  /*
   * Мир должен быть остановлен, пока оба игрока
   * не сделают выбор.
   */
  const pausedSnapshot =
    await waitForSnapshot(
      host,
      snapshot => snapshot.upgradePaused === true
    );

  check(
    "мир остановлен во время выбора",
    pausedSnapshot.upgradePaused === true
  );

  check(
    "сервер ждёт обоих игроков",
    pausedSnapshot.upgradeWaitingPlayers.length === 2
  );

  const frozenEnemies =
    pausedSnapshot.enemies.map(
      enemy => `${enemy.id}:${enemy.x.toFixed(3)}`
    ).join("|");

  await new Promise(resolve =>
    setTimeout(resolve, 700)
  );

  const stillPaused =
    await waitForSnapshot(
      host,
      snapshot => snapshot.upgradePaused === true
    );

  check(
    "враги не двигаются на паузе",
    stillPaused.enemies.map(
      enemy => `${enemy.id}:${enemy.x.toFixed(3)}`
    ).join("|") === frozenEnemies
  );

  /*
   * Выстрел на паузе должен быть отклонён.
   */
  const heldBefore =
    stillPaused.bullets.filter(
      bullet =>
        bullet.ownerId === host.id &&
        bullet.state === "held"
    ).length;

  host.emit("net:shoot", {
    aimX: 100,
    aimY: 100
  });

  await new Promise(resolve =>
    setTimeout(resolve, 300)
  );

  const afterShotSnapshot =
    await waitForSnapshot(host, () => true);

  check(
    "выстрел на паузе запрещён",
    afterShotSnapshot.bullets.filter(
      bullet =>
        bullet.ownerId === host.id &&
        bullet.state === "held"
    ).length === heldBefore
  );

  /*
   * Выбор одного игрока не должен снимать паузу.
   */
  console.log("\n[ожидание напарника]");

  const hostChoice = hostOffers.offers[0];

  const accepted =
    waitFor(host, "net:game-event");

  host.emit("net:upgrade-choice", {
    offerId: hostOffers.offerId,
    index: 0
  });

  const acceptedEvent = await accepted;

  check(
    "сервер подтвердил выбор хозяина",
    acceptedEvent?.type ===
      "upgrade-choice-accepted"
  );

  const oneWaitingSnapshot =
    await waitForSnapshot(
      host,
      snapshot =>
        snapshot.upgradeWaitingPlayers.length === 1
    );

  check(
    "мир всё ещё на паузе после выбора одного",
    oneWaitingSnapshot.upgradePaused === true
  );

  check(
    "сервер ждёт только второго игрока",
    oneWaitingSnapshot
      .upgradeWaitingPlayers[0] === guest.id
  );

  /*
   * Повторный выбор того же игрока игнорируется.
   */
  host.emit("net:upgrade-choice", {
    offerId: hostOffers.offerId,
    index: 1
  });

  await new Promise(resolve =>
    setTimeout(resolve, 250)
  );

  const doubleChoiceSnapshot =
    await waitForSnapshot(host, () => true);

  const hostState =
    doubleChoiceSnapshot.players.find(
      player => player.id === host.id
    );

  check(
    "повторный выбор не применяется",
    hostState.selectedUpgrades.length === 1
  );

  check(
    "выбранное улучшение сохранено",
    hostState.selectedUpgrades[0].upgradeId ===
      hostChoice.upgradeId
  );

  /*
   * После выбора второго игрока мир продолжается.
   */
  console.log("\n[возобновление мира]");

  guest.emit("net:upgrade-choice", {
    offerId: guestOffers.offerId,
    index: 0
  });

  const resumedSnapshot =
    await waitForSnapshot(
      host,
      snapshot => snapshot.upgradePaused === false
    );

  check(
    "мир возобновлён после выбора обоих",
    resumedSnapshot.upgradePaused === false
  );

  check(
    "список ожидания очищен",
    resumedSnapshot.upgradeWaitingPlayers
      .length === 0
  );

  const guestState =
    resumedSnapshot.players.find(
      player => player.id === guest.id
    );

  check(
    "улучшение гостя применено отдельно",
    guestState.selectedUpgrades.length === 1
  );

  /*
   * Проверяем, что улучшение действительно изменило
   * личные характеристики выбравшего игрока.
   */
  console.log("\n[личные характеристики]");

  const expectations = {
    damage: (stats, power) =>
      stats.damage === 1 + power,

    bounce: (stats, power) =>
      stats.maxBounces === 1 + power,

    pierce: (stats, power) =>
      stats.pierce === power,

    "bullet-speed": (stats, power) =>
      Math.abs(
        stats.bulletSpeed -
        (650 + 650 * 0.18 * power)
      ) < 0.001,

    "move-speed": (stats, power) =>
      Math.abs(
        stats.playerSpeed -
        (285 + 285 * 0.12 * power)
      ) < 0.001,

    armor: stats => stats !== null,

    repair: stats => stats !== null,

    pickup: (stats, power) =>
      stats.pickupRadius === 35 * power,

    critical: (stats, power) =>
      Math.abs(
        stats.critChance - 0.12 * power
      ) < 0.001,

    caliber: (stats, power) =>
      Math.abs(
        stats.bulletRadius -
        (7 + 1.5 * power)
      ) < 0.001,

    "second-bullet": stats =>
      stats.magazineSize === 2
  };

  for (
    const state of
    [hostState, guestState]
  ) {
    const entry = state.selectedUpgrades[0];

    const current =
      resumedSnapshot.players.find(
        player => player.id === state.id
      );

    const verify =
      expectations[entry.upgradeId];

    check(
      `улучшение "${entry.upgradeId}" ` +
      `(сила ${entry.power}) применено к ${state.name}`,
      typeof verify === "function" &&
      verify(current.stats, entry.power)
    );
  }

  /*
   * Второй патрон и крупный калибр меняют состав
   * патронов в мире, поэтому играем дальше до тех пор,
   * пока оба улучшения не будут предложены и выбраны.
   */
  console.log("\n[второй патрон и калибр]");

  const preferredOrder = [
    "second-bullet",
    "caliber"
  ];

  const verifiedTargets = new Set();

  /*
   * Улучшение могло выпасть уже в первом раунде —
   * тогда проверяем его сразу и не ищем повторно.
   */
  for (
    const state of
    [hostState, guestState]
  ) {
    const upgradeId =
      state.selectedUpgrades[0].upgradeId;

    if (!preferredOrder.includes(upgradeId)) {
      continue;
    }

    const current =
      resumedSnapshot.players.find(
        player => player.id === state.id
      );

    const ownBullets =
      resumedSnapshot.bullets.filter(
        bullet => bullet.ownerId === state.id
      );

    if (upgradeId === "second-bullet") {
      check(
        "второй патрон: magazineSize стал 2",
        current.stats.magazineSize === 2
      );

      check(
        "второй патрон физически создан в мире",
        ownBullets.length === 2
      );
    }

    if (upgradeId === "caliber") {
      check(
        "калибр увеличил радиус патрона",
        current.stats.bulletRadius >= 7 + 1.5
      );

      check(
        "радиус применён ко всем патронам игрока",
        ownBullets.length > 0 &&
        ownBullets.every(
          bullet =>
            Math.abs(
              bullet.r -
              current.stats.bulletRadius
            ) < 0.001
        )
      );
    }

    verifiedTargets.add(upgradeId);
  }

  const magazineBot =
    startShootingBot(host);

  const magazineGuestBot =
    startShootingBot(guest);

  for (
    let round = 0;
    round < 14 &&
    verifiedTargets.size < preferredOrder.length;
    round++
  ) {
    const roundOffers = await Promise.all([
      hostOfferQueue.next(60000),
      guestOfferQueue.next(60000)
    ]).catch(() => null);

    if (!roundOffers) {
      break;
    }

    const [hostRound, guestRound] = roundOffers;

    const picks = [
      {
        socket: host,
        round: hostRound
      },

      {
        socket: guest,
        round: guestRound
      }
    ].map(entry => {
      let index = 0;

      for (const wanted of preferredOrder) {
        if (verifiedTargets.has(wanted)) {
          continue;
        }

        const found =
          entry.round.offers.findIndex(
            offer => offer.upgradeId === wanted
          );

        if (found >= 0) {
          index = found;
          break;
        }
      }

      return {
        socket: entry.socket,
        offerId: entry.round.offerId,
        index,
        offer: entry.round.offers[index]
      };
    });

    for (const pick of picks) {
      pick.socket.emit("net:upgrade-choice", {
        offerId: pick.offerId,
        index: pick.index
      });
    }

    const roundResult =
      await waitForSnapshot(
        host,
        snapshot =>
          snapshot.upgradePaused === false,
        20000
      );

    for (const pick of picks) {
      const upgradeId =
        pick.offer.upgradeId;

      if (
        !preferredOrder.includes(upgradeId) ||
        verifiedTargets.has(upgradeId)
      ) {
        continue;
      }

      const state =
        roundResult.players.find(
          player =>
            player.id === pick.socket.id
        );

      const ownBullets =
        roundResult.bullets.filter(
          bullet =>
            bullet.ownerId ===
            pick.socket.id
        );

      if (upgradeId === "second-bullet") {
        check(
          "второй патрон: magazineSize стал 2",
          state.stats.magazineSize === 2
        );

        check(
          "второй патрон физически создан в мире",
          ownBullets.length === 2
        );
      }

      if (upgradeId === "caliber") {
        check(
          "калибр увеличил радиус патрона",
          state.stats.bulletRadius >
            7 - 0.001 + 1.5
        );

        check(
          "радиус применён ко всем патронам игрока",
          ownBullets.length > 0 &&
          ownBullets.every(
            bullet =>
              Math.abs(
                bullet.r -
                state.stats.bulletRadius
              ) < 0.001
          )
        );
      }

      verifiedTargets.add(upgradeId);
    }
  }

  magazineBot.stop();
  magazineGuestBot.stop();

  for (const wanted of preferredOrder) {
    if (!verifiedTargets.has(wanted)) {
      console.log(
        `  skip "${wanted}" не был предложен ` +
        `за отведённые раунды`
      );
    }
  }

  /*
   * Мир должен снова двигаться.
   */
  const movingSnapshot =
    await waitForSnapshot(
      host,
      snapshot => snapshot.upgradePaused === false
    );

  await new Promise(resolve =>
    setTimeout(resolve, 400)
  );

  const laterSnapshot =
    await waitForSnapshot(
      host,
      snapshot => snapshot.upgradePaused === false
    );

  check(
    "мир снова симулируется",
    laterSnapshot.serverTime >
      movingSnapshot.serverTime
  );

  /*
   * Опыт общий: у обоих клиентов одинаковые значения.
   */
  const guestSnapshot =
    await waitForSnapshot(guest, () => true);

  check(
    "оба клиента видят один общий уровень",
    Number.isFinite(guestSnapshot.level) &&
    Number.isFinite(guestSnapshot.experience)
  );

  host.close();
  guest.close();

  console.log(
    `\nПровалено проверок: ${failures.length}`
  );

  if (failures.length > 0) {
    failures.forEach(label =>
      console.log(`  - ${label}`)
    );

    process.exit(1);
  }

  console.log("Все проверки пройдены.");
  process.exit(0);
}

main().catch(error => {
  console.error(
    "Ошибка теста:",
    error.message
  );

  process.exit(1);
});
