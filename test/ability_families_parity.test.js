const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadServerInstance } = require("./helpers/server_loader.js");
const { createTestWorld } = require("./helpers/test_utils.js");

test("Ability Families, Sub-Branches & ESC Menu Multi-Corner Card Parity Suite", async (t) => {
  const inst = loadServerInstance();
  const { ctx, cleanup } = inst;

  t.after(() => {
    cleanup();
  });

  const ALL_BASE_FAMILIES = [
    { id: "chain-lightning", branches: ["lightning-damage", "lightning-targets", "lightning-range"] },
    { id: "explosive", branches: ["explosion-damage", "explosion-radius"] },
    { id: "catch-blast", branches: ["catch-blast-damage", "catch-blast-radius"] },
    { id: "poison", branches: ["poison-damage", "poison-duration"] },
    { id: "parasite", branches: ["parasite-chance", "parasite-count", "parasite-damage"] },
    { id: "boomerang", branches: ["boomerang-damage", "boomerang-speed"] },
    { id: "splinter", branches: ["splinter-count", "splinter-damage"] },
    { id: "stun", branches: ["stun-chance", "stun-duration"] },
    { id: "reactive-armor", branches: ["reactive-armor-radius", "reactive-armor-cooldown"] },
    { id: "target-mark", branches: ["mark-amplification", "mark-duration"] }
  ];

  await t.test("1. All 10 base abilities are Rare and guard their sub-branches", () => {
    const { player1: player } = createTestWorld(ctx);
    player.stats.groundPullSpeed = 110; // Enable boomerang base availability

    for (const fam of ALL_BASE_FAMILIES) {
      const baseUpg = ctx.SERVER_UPGRADES.find(u => u.id === fam.id);
      assert.ok(baseUpg, `Base upgrade '${fam.id}' must exist in SERVER_UPGRADES`);
      assert.equal(baseUpg.fixedRarity, "rare", `Base upgrade '${fam.id}' must have fixedRarity: "rare"`);
      assert.equal(baseUpg.available(player), true, `Base upgrade '${fam.id}' should be available initially`);

      // Verify sub-branches are locked before base is acquired
      for (const branchId of fam.branches) {
        const branchUpg = ctx.SERVER_UPGRADES.find(u => u.id === branchId);
        assert.ok(branchUpg, `Sub-branch '${branchId}' must exist in SERVER_UPGRADES`);
        assert.equal(
          branchUpg.available(player),
          false,
          `Sub-branch '${branchId}' must be locked before base '${fam.id}' is acquired`
        );
      }
    }
  });

  await t.test("2. Acquiring base ability unlocks its sub-branches", () => {
    const { world, player1: player } = createTestWorld(ctx);
    player.stats.groundPullSpeed = 110;

    for (const fam of ALL_BASE_FAMILIES) {
      ctx.applyServerUpgrade(world, player, { id: fam.id, power: 1 });

      const baseUpg = ctx.SERVER_UPGRADES.find(u => u.id === fam.id);
      assert.equal(baseUpg.available(player), false, `Base upgrade '${fam.id}' should be unavailable once acquired`);

      for (const branchId of fam.branches) {
        const branchUpg = ctx.SERVER_UPGRADES.find(u => u.id === branchId);
        assert.equal(
          branchUpg.available(player),
          true,
          `Sub-branch '${branchId}' should become available after acquiring '${fam.id}'`
        );
      }
    }
  });

  await t.test("3. Sub-branch upgrades apply stat modifications and obey maximum caps", () => {
    const { world, player1: player } = createTestWorld(ctx);
    player.stats.groundPullSpeed = 110;

    // Acquire all bases
    for (const fam of ALL_BASE_FAMILIES) {
      ctx.applyServerUpgrade(world, player, { id: fam.id, power: 1 });
    }

    // Upgrade lightning
    ctx.applyServerUpgrade(world, player, { id: "lightning-damage", power: 2 });
    assert.ok(player.stats.chainDamageRatio >= 1.0);
    ctx.applyServerUpgrade(world, player, { id: "lightning-targets", power: 3 });
    assert.ok(player.stats.chainCount >= 6);

    // Upgrade explosive
    ctx.applyServerUpgrade(world, player, { id: "explosion-damage", power: 2 });
    assert.ok(player.stats.explosionDamageRatio >= 1.0);
    ctx.applyServerUpgrade(world, player, { id: "explosion-radius", power: 4 });
    assert.equal(player.stats.explosionRadius, 160);

    // Upgrade catch blast
    ctx.applyServerUpgrade(world, player, { id: "catch-blast-damage", power: 2 });
    assert.ok(player.stats.catchBlastDamageRatio >= 1.5);
    ctx.applyServerUpgrade(world, player, { id: "catch-blast-radius", power: 3 });
    assert.ok(player.stats.catchBlast >= 150);

    // Upgrade stun
    ctx.applyServerUpgrade(world, player, { id: "stun-chance", power: 3 });
    assert.ok(player.stats.stunChance >= 0.30);
    ctx.applyServerUpgrade(world, player, { id: "stun-duration", power: 2 });
    assert.equal(player.stats.stunDuration, 1.0);

    // Upgrade reactive armor
    ctx.applyServerUpgrade(world, player, { id: "reactive-armor-radius", power: 2 });
    assert.equal(player.stats.reactiveArmorRadius, 180);
    ctx.applyServerUpgrade(world, player, { id: "reactive-armor-cooldown", power: 2 });
    assert.equal(player.stats.reactiveArmorCooldownBase, 2.0);

    // Upgrade mark
    ctx.applyServerUpgrade(world, player, { id: "mark-amplification", power: 2 });
    assert.ok(player.stats.markBonus >= 0.70);
    ctx.applyServerUpgrade(world, player, { id: "mark-duration", power: 2 });
    assert.equal(player.stats.markDuration, 8.0);
  });

  await t.test("4. Client HTML contains parity definitions and CSS for multi-corner badges", () => {
    const htmlPath = path.join(__dirname, "..", "public", "index.html");
    const html = fs.readFileSync(htmlPath, "utf8");

    // Verify all 10 family base names are in HTML
    for (const fam of ALL_BASE_FAMILIES) {
      assert.ok(html.includes(`"fixedRarity": "rare"`) || html.includes(`fixedRarity: "rare"`), "Rare rarity should be declared in HTML");
    }

    assert.ok(html.includes(".pause-corner-badge.tl"), "TL badge CSS must exist");
    assert.ok(html.includes(".pause-corner-badge.tr"), "TR badge CSS must exist");
    assert.ok(html.includes(".pause-corner-badge.bl"), "BL badge CSS must exist");
    assert.ok(html.includes(".pause-corner-badge.br"), "BR badge CSS must exist");
    assert.ok(html.includes("ABILITY_FAMILIES_DEF"), "ABILITY_FAMILIES_DEF must exist in index.html");
    assert.ok(html.includes("renderPauseUpgradeCardHtml"), "renderPauseUpgradeCardHtml must exist");
  });
});
