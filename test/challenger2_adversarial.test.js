const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadServerInstance } = require("./helpers/server_loader.js");
const { createTestWorld } = require("./helpers/test_utils.js");

test("Challenger 2: Adversarial Verification of Card Drafting, Magnetic Field, and Multi-Wave XP Progression", async (t) => {
  let inst;
  let ctx;

  t.beforeEach(() => {
    inst = loadServerInstance();
    ctx = inst.ctx;
  });

  t.afterEach(() => {
    if (inst && typeof inst.cleanup === "function") {
      inst.cleanup();
    }
  });

  // =========================================================================
  // FOCUS AREA 1: "Магнитное поле" (Magnetic Field) Mechanics & Physics
  // =========================================================================

  // applyServerUpgrade(world, player, offer) takes exactly THREE arguments.
  // Passing power as a 4th argument is silently dropped and power defaults to 1,
  // so upgrades must always be applied with an explicit offer object.
  const applyUpgrade = (world, player, upgradeId, power) =>
    ctx.applyServerUpgrade(world, player, { upgradeId, power });

  await t.test("1.1 Dual Stats Application: pickupRadius (+35*p) and groundPullSpeed (+110*p) across powers", () => {
    const { world, player1 } = createTestWorld(ctx);

    // Initial baseline stats
    assert.equal(player1.stats.pickupRadius || 0, 0);
    assert.equal(player1.stats.groundPullSpeed || 0, 0);

    // Guard the invocation contract itself: power must actually reach the server.
    // A 4-argument call silently loses `power`, which is the bug this test had.
    assert.equal(
      ctx.applyServerUpgrade.length,
      3,
      "applyServerUpgrade takes (world, player, offer); power must ride inside the offer"
    );

    // Each application is additive: stats += 35 * power / 110 * power.
    // Power 1 (Common)
    applyUpgrade(world, player1, "pickup", 1);
    assert.equal(player1.stats.pickupRadius, 35, "Power 1 adds +35 (total 35)");
    assert.equal(player1.stats.groundPullSpeed, 110, "Power 1 adds +110 (total 110)");

    // Power 2 (Rare) adds +70 / +220 on top of the previous total
    applyUpgrade(world, player1, "pickup", 2);
    assert.equal(player1.stats.pickupRadius, 35 + 70, "Power 2 adds +70 (total 105)");
    assert.equal(player1.stats.groundPullSpeed, 110 + 220, "Power 2 adds +220 (total 330)");

    // Power 3 (Legendary) via the 'magnetic-field' alias adds +105 / +330
    applyUpgrade(world, player1, "magnetic-field", 3);
    assert.equal(player1.stats.pickupRadius, 105 + 105, "Power 3 adds +105 (total 210)");
    assert.equal(player1.stats.groundPullSpeed, 330 + 330, "Power 3 adds +330 (total 660)");

    // Every single application must contribute exactly 35*p / 110*p, so a
    // wrong implementation (flat bonus, overwrite, or ignored power) still fails.
    let expectedRadius = player1.stats.pickupRadius;
    let expectedPull = player1.stats.groundPullSpeed;
    for (let i = 1; i <= 20; i++) {
      const p = (i % 3) + 1;
      const radiusBefore = player1.stats.pickupRadius;
      const pullBefore = player1.stats.groundPullSpeed;

      applyUpgrade(world, player1, "pickup", p);

      expectedRadius += 35 * p;
      expectedPull += 110 * p;

      assert.equal(
        player1.stats.pickupRadius - radiusBefore,
        35 * p,
        `Stack ${i} (power ${p}) must add exactly +${35 * p} pickupRadius`
      );
      assert.equal(
        player1.stats.groundPullSpeed - pullBefore,
        110 * p,
        `Stack ${i} (power ${p}) must add exactly +${110 * p} groundPullSpeed`
      );
      assert.equal(player1.stats.pickupRadius, expectedRadius, `Stack ${i} radius mismatch`);
      assert.equal(player1.stats.groundPullSpeed, expectedPull, `Stack ${i} pullSpeed mismatch`);
    }
  });

  await t.test("1.2 Client-Server Definition & Bonus String Parity for 'Магнитное поле'", () => {
    const upgrade = ctx.SERVER_UPGRADES.find(u => u.id === "pickup" || u.id === "magnetic-field");
    assert.ok(upgrade, "Server must define 'pickup' upgrade");
    assert.equal(upgrade.title, "Магнитное поле");

    // Test bonus text output
    const dummyPlayer = { stats: { pickupRadius: 0, groundPullSpeed: 0 } };
    const bonusP1 = upgrade.bonus(dummyPlayer, 1);
    assert.ok(bonusP1.includes("+35"), `Bonus text must mention +35: ${bonusP1}`);
    assert.ok(bonusP1.includes("+110"), `Bonus text must mention +110: ${bonusP1}`);

    const bonusP2 = upgrade.bonus(dummyPlayer, 2);
    assert.ok(bonusP2.includes("+70"), `Bonus text must mention +70: ${bonusP2}`);
    assert.ok(bonusP2.includes("+220"), `Bonus text must mention +220: ${bonusP2}`);

    // Verify client HTML contains matching definition and logic
    const html = fs.readFileSync(path.resolve(process.cwd(), "public/index.html"), "utf8");
    assert.ok(html.includes('title: "Магнитное поле"'), "index.html must have title 'Магнитное поле'");
    assert.ok(html.includes("stats.pickupRadius = (stats.pickupRadius || 0) + 35 * power;"), "Client must add 35 * power to pickupRadius");
    assert.ok(html.includes("stats.groundPullSpeed = (stats.groundPullSpeed || 0) + 110 * power;"), "Client must add 110 * power to groundPullSpeed");
  });

  await t.test("1.3 Exclusivity Stress Test: 'Магнитное поле' is NEVER blocked by any build / stat combo", () => {
    const { world, player1 } = createTestWorld(ctx);
    const upgrade = ctx.SERVER_UPGRADES.find(u => u.id === "pickup");

    // Check availability across extreme / edge-case player builds
    const testBuilds = [
      { name: "Fresh player", stats: { pierce: 0, explosionRadius: 0, chainCount: 0, catchBlast: 0, critChance: 0, bulletRadius: 7, magazineSize: 1 } },
      { name: "Pierce build", stats: { pierce: 3, explosionRadius: 0, chainCount: 0, catchBlast: 0 } },
      { name: "AOE Explosive build", stats: { pierce: 0, explosionRadius: 80, chainCount: 4, catchBlast: 130 } },
      { name: "Max Crit build", stats: { critChance: 0.6 } },
      { name: "Max Magnet build", stats: { pickupRadius: 500, groundPullSpeed: 1500 } },
      { name: "Max Bullet Radius build", stats: { bulletRadius: 15 } },
      { name: "Second Bullet build", stats: { magazineSize: 2 } },
      { name: "Low HP", hp: 1, maxHp: 6, stats: {} },
      { name: "Full HP", hp: 6, maxHp: 6, stats: {} }
    ];

    for (const build of testBuilds) {
      player1.stats = { ...build.stats };
      if (build.hp) player1.hp = build.hp;
      if (build.maxHp) player1.maxHp = build.maxHp;

      if (typeof upgrade.available === "function") {
        assert.equal(upgrade.available(player1), true, `'Магнитное поле' should be available for build: ${build.name}`);
      }

      // Run 500 offer generation batches and verify 'pickup' appears with non-zero probability
      let appearances = 0;
      const iterations = 500;
      for (let i = 0; i < iterations; i++) {
        const offers = ctx.createServerUpgradeOffers(player1);
        if (offers.some(o => o.upgradeId === "pickup")) {
          appearances++;
        }
      }
      assert.ok(
        appearances > 0,
        `'Магнитное поле' must appear in upgrade offers for build: ${build.name} (got ${appearances}/${iterations})`
      );
    }
  });

  await t.test("1.4 Simultaneous Physics Verification: Ground pull movement + Pickup radius catch", () => {
    const { room, world, player1 } = createTestWorld(ctx);
    player1.x = 400;
    player1.y = 300;
    player1.r = 16;
    player1.alive = true;

    // updateServerBullet(room, bullet, dt) — room first, not the bullet.
    assert.equal(ctx.updateServerBullet.length, 3, "updateServerBullet takes (room, bullet, dt)");

    // Apply 2 stacks of magnet (power 1 each -> pickupRadius=70, groundPullSpeed=220)
    applyUpgrade(world, player1, "pickup", 1);
    applyUpgrade(world, player1, "pickup", 1);
    assert.equal(player1.stats.pickupRadius, 70);
    assert.equal(player1.stats.groundPullSpeed, 220);

    // Spawn a ground bullet far away: distance = 250px (dx = 250, dy = 0)
    // Pickup distance threshold = player.r (16) + bullet.r (7) + pickupRadius (70) = 93px
    const bullet = ctx.createServerBullet(world, player1, player1.x + 250, player1.y, 0, 0);
    bullet.state = "ground";
    bullet.r = 7;

    const initialDist = ctx.distance(bullet.x, bullet.y, player1.x, player1.y);
    assert.equal(initialDist, 250);
    assert.ok(initialDist > 93, "Bullet starts outside pickup distance");

    const heldCount = () =>
      [...world.bullets.values()].filter(
        b => b.ownerId === player1.id && b.state === "held"
      ).length;

    const heldBefore = heldCount();

    // Advance physics by 0.1s: pull moves 220 px/s * 0.1s = 22px towards the player
    ctx.updateServerBullet(room, bullet, 0.1);

    const distAfter1Tick = ctx.distance(bullet.x, bullet.y, player1.x, player1.y);
    assert.ok(
      Math.abs(distAfter1Tick - (250 - 22)) < 0.001,
      `Bullet should have moved 22px towards player: expected ${250 - 22}, got ${distAfter1Tick}`
    );
    assert.equal(bullet.state, "ground", "Bullet should still be on ground (dist 228 > 93)");
    assert.equal(heldCount(), heldBefore, "Nothing should be picked up while still out of range");

    // 228px - 93px = 135px left to travel at 220px/s -> ~0.61s, i.e. 7 ticks of 0.1s
    let ticks = 0;
    while (bullet.state === "ground" && ticks < 20) {
      ctx.updateServerBullet(room, bullet, 0.1);
      ticks++;
    }

    assert.ok(ticks >= 6 && ticks <= 8, `Expected catch in ~7 ticks (~0.7s), took ${ticks} ticks`);

    // catchServerBullet puts the bullet back in the player's hand ("held"),
    // which is the server's ready-to-shoot state.
    assert.equal(bullet.state, "held", "Bullet must return to 'held' upon reaching pickup radius");
    assert.equal(
      heldCount(),
      heldBefore + 1,
      "The caught bullet must add exactly one ready bullet"
    );
  });

  await t.test("1.5 Physics Boundary: Instant catch when bullet drops inside pickup radius", () => {
    const { room, world, player1 } = createTestWorld(ctx);
    player1.x = 500;
    player1.y = 500;
    player1.r = 16;
    player1.alive = true;
    player1.stats.pickupRadius = 100;
    player1.stats.groundPullSpeed = 200;

    // Bullet drops at dist = 50px (inside threshold: 16 + 7 + 100 = 123px)
    const bullet = ctx.createServerBullet(world, player1, player1.x + 50, player1.y, 0, 0);
    bullet.state = "ground";
    bullet.r = 7;

    ctx.updateServerBullet(room, bullet, 0.016);
    assert.equal(
      bullet.state,
      "held",
      "Bullet within pickup radius should be caught instantly on the 1st tick"
    );
  });

  await t.test("1.6 Physics Safety: Dead player cannot pull or pick up bullets", () => {
    const { room, world, player1 } = createTestWorld(ctx);
    player1.x = 500;
    player1.y = 500;
    player1.alive = false; // Dead player
    player1.stats.pickupRadius = 100;
    player1.stats.groundPullSpeed = 500;

    const bullet = ctx.createServerBullet(world, player1, player1.x + 50, player1.y, 0, 0);
    bullet.state = "ground";

    ctx.updateServerBullet(room, bullet, 0.5);

    assert.equal(bullet.state, "ground", "Dead player cannot pick up bullet");
    assert.equal(bullet.x, 550, "Dead player cannot pull bullet");

    // Revive player -> should now pull and pick up
    player1.alive = true;
    ctx.updateServerBullet(room, bullet, 0.016);
    assert.equal(bullet.state, "held", "Revived player should catch bullet inside pickup radius");
  });

  // =========================================================================
  // FOCUS AREA 2: `second-bullet` Mechanics & Boundaries
  // =========================================================================

  await t.test("2.1 Second Bullet fixedRarity is 'rare' in Server and Client", () => {
    const serverSecondBullet = ctx.SERVER_UPGRADES.find(u => u.id === "second-bullet");
    assert.ok(serverSecondBullet, "Server must define 'second-bullet'");
    assert.equal(serverSecondBullet.fixedRarity, "rare", "Server second-bullet must have fixedRarity: 'rare'");

    // Test rarity roller always resolves to rare (power 2)
    for (let i = 0; i < 1000; i++) {
      const rolled = ctx.rollServerUpgradeRarity(serverSecondBullet);
      assert.equal(rolled.key, "rare");
      assert.equal(rolled.power, 2);
      assert.equal(rolled.label, "РЕДКОЕ");
    }

    // Verify client HTML
    const html = fs.readFileSync(path.resolve(process.cwd(), "public/index.html"), "utf8");
    assert.ok(
      html.includes('title: "Запасной патрон"') && html.includes('fixedRarity: "rare"'),
      "Client index.html must define 'Запасной патрон' with fixedRarity: 'rare'"
    );
  });

  await t.test("2.2 Second Bullet availability condition and draft filtering boundaries", () => {
    const serverSecondBullet = ctx.SERVER_UPGRADES.find(u => u.id === "second-bullet");
    const { world, player1 } = createTestWorld(ctx);

    // magazineSize = 1 -> Available
    player1.stats.magazineSize = 1;
    assert.equal(serverSecondBullet.available(player1), true, "Should be available when magazineSize = 1");

    // magazineSize = 0 -> Available (fallback / edge case)
    player1.stats.magazineSize = 0;
    assert.equal(serverSecondBullet.available(player1), true, "Should be available when magazineSize = 0");

    // magazineSize = 2 -> NOT Available
    player1.stats.magazineSize = 2;
    assert.equal(serverSecondBullet.available(player1), false, "Must NOT be available when magazineSize = 2");

    // magazineSize = 3 -> NOT Available
    player1.stats.magazineSize = 3;
    assert.equal(serverSecondBullet.available(player1), false, "Must NOT be available when magazineSize = 3");

    // Monte Carlo draft simulation:
    // With magazineSize = 1, second-bullet MUST be draftable
    player1.stats.magazineSize = 1;
    let offeredCount = 0;
    const trials = 2000;
    for (let i = 0; i < trials; i++) {
      const offers = ctx.createServerUpgradeOffers(player1);
      if (offers.some(o => o.upgradeId === "second-bullet")) {
        offeredCount++;
      }
    }
    assert.ok(offeredCount > 0, `second-bullet should appear in offers when magSize=1 (got ${offeredCount}/${trials})`);

    // With magazineSize = 2, second-bullet must NEVER appear (0 out of 5000)
    player1.stats.magazineSize = 2;
    let forbiddenOffers = 0;
    for (let i = 0; i < 5000; i++) {
      const offers = ctx.createServerUpgradeOffers(player1);
      if (offers.some(o => o.upgradeId === "second-bullet")) {
        forbiddenOffers++;
      }
    }
    assert.equal(forbiddenOffers, 0, "second-bullet must NEVER appear in upgrade offers once magazineSize >= 2");
  });

  await t.test("2.3 Second Bullet state transition and magazine expansion", () => {
    const { room, world, player1 } = createTestWorld(ctx);
    player1.stats.magazineSize = 1;

    // The server has no `bulletsInChamber` counter: readiness is derived from
    // bullet entities whose state is "held". Count those instead.
    const heldCount = () =>
      [...world.bullets.values()].filter(
        b => b.ownerId === player1.id && b.state === "held"
      ).length;

    const ownedBullets = () =>
      [...world.bullets.values()].filter(b => b.ownerId === player1.id);

    assert.equal(ownedBullets().length, 1, "Initial bullet count should be 1");
    assert.equal(heldCount(), 1, "The starting bullet should be held and ready");

    // Apply second bullet upgrade
    applyUpgrade(world, player1, "second-bullet", 2);
    assert.equal(player1.stats.magazineSize, 2, "magazineSize should become 2");

    assert.equal(ownedBullets().length, 2, "World should now track 2 bullets for player 1");
    assert.equal(heldCount(), 2, "Player should have 2 bullets held and ready to shoot");

    // Shoot 1st bullet
    assert.equal(ctx.shootServerBullet(room, player1.id, 1, 0), true, "1st shot should succeed");
    assert.equal(heldCount(), 1, "After shooting the 1st bullet, 1 should remain held");

    // Shoot 2nd bullet
    assert.equal(ctx.shootServerBullet(room, player1.id, 0, 1), true, "2nd shot should succeed");
    assert.equal(heldCount(), 0, "After shooting the 2nd bullet, none should remain held");

    // Both bullets are flying independently
    assert.equal(
      ownedBullets().filter(b => b.state === "flying").length,
      2,
      "Both bullets should be flying independently"
    );

    // With an empty magazine a third shot must be refused.
    assert.equal(
      ctx.shootServerBullet(room, player1.id, 1, 1),
      false,
      "Shooting with no held bullet must be refused"
    );
  });

  // =========================================================================
  // FOCUS AREA 3: Multi-Wave XP Progression & Level-Up Simulations
  // =========================================================================

  await t.test("3.1 Mathematical Stress Test: Stepped XP formula (10 + prog*4 + floor(prog/5)*5)", () => {
    // Exact requirement verification up to level 500
    function formula(level) {
      const prog = Math.max(0, level - 1);
      return 10 + prog * 4 + Math.floor(prog / 5) * 5;
    }

    // Test specific key milestone levels
    const milestones = [
      { lvl: 0, expected: 10 },
      { lvl: 1, expected: 10 },
      { lvl: 2, expected: 14 },
      { lvl: 3, expected: 18 },
      { lvl: 4, expected: 22 },
      { lvl: 5, expected: 26 },
      { lvl: 6, expected: 35 }, // Step 1: prog=5 -> +5 step
      { lvl: 10, expected: 51 },
      { lvl: 11, expected: 60 }, // Step 2: prog=10 -> +5 step
      { lvl: 15, expected: 76 },
      { lvl: 16, expected: 85 }, // Step 3: prog=15 -> +5 step
      { lvl: 20, expected: 101 },
      { lvl: 21, expected: 110 }, // Step 4: prog=20 -> +5 step
      { lvl: 30, expected: 151 }, // prog=29 -> 10 + 116 + floor(29/5)*5 = 10+116+25
      { lvl: 31, expected: 160 }, // Step 7: prog=30 -> 10 + 120 + 30
      { lvl: 50, expected: 251 },
      { lvl: 100, expected: 501 }
    ];

    for (const m of milestones) {
      const serverVal = ctx.getServerExperienceRequirement(m.lvl);
      const expectedVal = formula(m.lvl);
      assert.equal(serverVal, m.expected, `Server XP requirement at level ${m.lvl} mismatch: got ${serverVal}, expected ${m.expected}`);
      assert.equal(serverVal, expectedVal);
    }

    // Monotonicity and positive requirement invariant across 1000 levels
    let prevReq = ctx.getServerExperienceRequirement(1);
    for (let lvl = 2; lvl <= 1000; lvl++) {
      const req = ctx.getServerExperienceRequirement(lvl);
      assert.ok(req > prevReq, `XP requirement must strictly increase: lvl ${lvl} (${req}) vs lvl ${lvl - 1} (${prevReq})`);
      assert.ok(Number.isInteger(req), `XP requirement at lvl ${lvl} must be an integer`);
      prevReq = req;
    }
  });

  await t.test("3.2 Multi-Wave In-Game Simulation (Waves 1-50): Full enemy kills, crystal collection, and level-ups", () => {
    const { room, world, player1, player2 } = createTestWorld(ctx);
    world.level = 1;
    world.experience = 0;
    world.experienceToNext = ctx.getServerExperienceRequirement(1);
    world.pendingLevelUps = 0;

    let totalCrystalsSpawned = 0;
    let totalXpGained = 0;

    for (let wave = 1; wave <= 50; wave++) {
      world.wave = wave;
      const isBossWave = wave % 5 === 0;
      const bossTier = Math.floor(wave / 5);

      // Simulate wave enemy composition
      const enemiesInWave = [];
      if (isBossWave) {
        enemiesInWave.push({ type: "boss", bossTier: bossTier });
        // Boss minions
        for (let i = 0; i < 4 + wave; i++) {
          enemiesInWave.push({ type: "tank" });
        }
      } else {
        const count = 5 + wave * 2;
        for (let i = 0; i < count; i++) {
          const rand = (i + wave) % 5;
          const types = ["normal", "runner", "tank", "charger", "shooter"];
          enemiesInWave.push({ type: types[rand] });
        }
      }

      // Kill each enemy and grant XP
      for (const enemy of enemiesInWave) {
        const xpAmount = ctx.getServerEnemyExperience(enemy);
        assert.ok(xpAmount >= 1, `Enemy XP must be at least 1 (got ${xpAmount} for ${enemy.type})`);
        
        if (enemy.type === "boss") {
          assert.equal(xpAmount, 8 + bossTier * 2, `Boss Tier ${bossTier} XP mismatch`);
        }

        totalCrystalsSpawned++;
        totalXpGained += xpAmount;

        // Apply XP via server system
        ctx.addServerExperience(room, xpAmount);

        // Verify Invariants after every single XP drop
        assert.ok(world.experience >= 0, "world.experience must never be negative");
        assert.ok(
          world.experience < world.experienceToNext,
          `world.experience (${world.experience}) must be strictly less than experienceToNext (${world.experienceToNext})`
        );
        assert.equal(
          world.experienceToNext,
          ctx.getServerExperienceRequirement(world.level),
          `experienceToNext must match formula at level ${world.level}`
        );
      }

      // Simulate leveling up: consuming pending upgrades
      while (world.pendingLevelUps > 0) {
        const offers = ctx.createServerUpgradeOffers(player1);
        assert.ok(offers.length > 0 && offers.length <= 3, "Offers should contain 1-3 upgrades");
        
        // Pick 1st offer
        const chosen = offers[0];
        ctx.applyServerUpgrade(world, player1, chosen.upgradeId, chosen.power);
        world.pendingLevelUps--;
      }

      assert.equal(world.pendingLevelUps, 0, `Wave ${wave}: all pending level ups should be consumed`);
    }

    assert.ok(world.level >= 20, `After 50 waves, level should be substantial (got ${world.level})`);
    assert.ok(totalXpGained > 1000, `Total XP gained should be substantial: ${totalXpGained}`);

    // Verify Rerolls on even levels
    // Player 1 rerolls = Math.floor(world.level / 2)
    const expectedRerolls = Math.floor(world.level / 2);
    assert.equal(player1.rerolls || 0, expectedRerolls, `Reroll count mismatch at level ${world.level}`);
    if (player2) {
      assert.equal(player2.rerolls || 0, expectedRerolls, `Player 2 reroll count mismatch`);
    }
  });

  await t.test("3.3 Adversarial Burst Stress Test: Single massive XP drops and multi-level jumps", () => {
    const { room, world, player1 } = createTestWorld(ctx);
    world.level = 1;
    world.experience = 0;
    world.experienceToNext = ctx.getServerExperienceRequirement(1); // 10

    // Burst 1: Add 50 XP in one drop (Reqs: lvl 1 -> 10, lvl 2 -> 14, lvl 3 -> 18, lvl 4 -> 22; Total 10+14+18 = 42 XP for lvl 4, 8 XP left)
    ctx.addServerExperience(room, 50);
    assert.equal(world.level, 4, "Should level up from 1 to 4 on 50 XP drop");
    assert.equal(world.experience, 8, "Remaining experience should be 8");
    assert.equal(world.experienceToNext, ctx.getServerExperienceRequirement(4)); // 22
    assert.equal(world.pendingLevelUps, 3, "Should have 3 pending level ups");

    // Burst 2: Add 1,000,000 XP in one call (Ultra mega stress)
    const startLevel = world.level;
    ctx.addServerExperience(room, 1000000);
    assert.ok(world.level > startLevel + 500, `World level should advance significantly (now ${world.level})`);
    assert.ok(world.experience >= 0, "Experience must remain non-negative");
    assert.ok(world.experience < world.experienceToNext, "Experience must be less than experienceToNext");
    assert.equal(world.experienceToNext, ctx.getServerExperienceRequirement(world.level));
  });

  await t.test("3.4 Boundary & Edge Case XP Amounts", () => {
    const { room, world } = createTestWorld(ctx);
    const initialLvl = world.level;
    const initialExp = world.experience;

    // Amount = 0
    ctx.addServerExperience(room, 0);
    assert.equal(world.level, initialLvl);
    assert.equal(world.experience, initialExp);

    // Negative amount edge case (should not crash or trigger negative level loops)
    // If world.gameOver is true, should ignore
    world.gameOver = true;
    ctx.addServerExperience(room, 100);
    assert.equal(world.level, initialLvl, "Should not add XP when world.gameOver is true");
  });

  await t.test("3.5 Client vs Server Step-by-Step XP Simulation Parity", () => {
    // Emulate client addExperience logic
    let clientLevel = 1;
    let clientExp = 0;
    let clientExpToNext = 10;
    let clientPendingLevelUps = 0;
    let clientRerolls = 0;

    function clientGetExpReq(lvl) {
      const prog = Math.max(0, lvl - 1);
      return 10 + prog * 4 + Math.floor(prog / 5) * 5;
    }

    function clientAddExperience(amount) {
      clientExp += amount;
      while (clientExp >= clientExpToNext) {
        clientExp -= clientExpToNext;
        clientLevel += 1;
        clientPendingLevelUps += 1;
        if (clientLevel % 2 === 0) {
          clientRerolls += 1;
        }
        clientExpToNext = clientGetExpReq(clientLevel);
      }
    }

    // Create server world
    const { room, world, player1 } = createTestWorld(ctx);
    world.level = 1;
    world.experience = 0;
    world.experienceToNext = ctx.getServerExperienceRequirement(1);
    world.pendingLevelUps = 0;
    player1.rerolls = 0;

    // Feed randomized XP drops (1 to 25 XP per drop) over 500 drops
    for (let drop = 1; drop <= 500; drop++) {
      const dropAmount = (drop * 7) % 25 + 1;

      // Update both
      ctx.addServerExperience(room, dropAmount);
      clientAddExperience(dropAmount);

      // Verify exact state parity on every drop
      assert.equal(world.level, clientLevel, `Drop ${drop}: Level parity mismatch`);
      assert.equal(world.experience, clientExp, `Drop ${drop}: Exp parity mismatch`);
      assert.equal(world.experienceToNext, clientExpToNext, `Drop ${drop}: ExpToNext parity mismatch`);
      assert.equal(world.pendingLevelUps, clientPendingLevelUps, `Drop ${drop}: PendingLevelUps parity mismatch`);
      assert.equal(player1.rerolls || 0, clientRerolls, `Drop ${drop}: Rerolls parity mismatch`);
    }
  });
});
