const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadServerInstance } = require("./helpers/server_loader.js");
const { createTestWorld } = require("./helpers/test_utils.js");

test("Expanded Bullet Skins (12 Skins) & Damage Vignette Screen Redness Suite", async (t) => {
  const inst = loadServerInstance();
  const { ctx, cleanup } = inst;

  t.after(() => {
    cleanup();
  });

  const EXPECTED_SKINS = [
    "neon", "fire", "quantum", "toxic", "cosmic",
    "plasma", "void", "inferno", "glitch", "prism", "holy", "ruby"
  ];

  const htmlPath = path.join(__dirname, "..", "public", "index.html");
  const indexHtml = fs.readFileSync(htmlPath, "utf8");

  await t.test("1. Server sanitizeSkin accepts all 12 bullet skins and sanitizes invalid ones", () => {
    for (const skin of EXPECTED_SKINS) {
      assert.equal(ctx.sanitizeSkin(skin), skin, `sanitizeSkin must accept '${skin}'`);
      assert.equal(ctx.sanitizeSkin(skin.toUpperCase()), skin, `sanitizeSkin must lowercase '${skin.toUpperCase()}'`);
    }

    assert.equal(ctx.sanitizeSkin("invalid_skin_xyz"), "neon", "Invalid skin must fallback to 'neon'");
    assert.equal(ctx.sanitizeSkin(null), "neon", "Null skin must fallback to 'neon'");
    assert.equal(ctx.sanitizeSkin(""), "neon", "Empty skin must fallback to 'neon'");
  });

  await t.test("2. Client index.html contains all 12 skins in BULLET_SKIN_CATALOG and settings", () => {
    for (const skin of EXPECTED_SKINS) {
      assert.ok(indexHtml.includes(`id: "${skin}"`), `BULLET_SKIN_CATALOG must define id: "${skin}"`);
      assert.ok(indexHtml.includes(`case "${skin}":`), `getSkinTrailColor must handle case "${skin}"`);
      assert.ok(indexHtml.includes(`skin === "${skin}"`) || skin === "neon", `drawBulletWithSkin must handle skin === "${skin}"`);
    }

    assert.ok(indexHtml.includes("catalog.map(s =>"), "Armory modal must map over the active skin catalog (bullet or player)");
  });

  await t.test("3. Server preserves custom bullet skins on player and bullet entities", () => {
    const { world, player1, player2 } = createTestWorld(ctx);
    player1.bulletSkin = "plasma";
    player2.bulletSkin = "ruby";

    // Shoot bullets
    const b1 = { id: "b1", ownerId: player1.id, x: 100, y: 100, vx: 500, vy: 0, state: "flying", r: 8, skin: player1.bulletSkin, age: 0.1, bouncesLeft: 3, colorIndex: 0 };
    const b2 = { id: "b2", ownerId: player2.id, x: 200, y: 200, vx: -500, vy: 0, state: "flying", r: 8, skin: player2.bulletSkin, age: 0.2, bouncesLeft: 2, colorIndex: 1 };
    world.bullets.set(b1.id, b1);
    world.bullets.set(b2.id, b2);

    assert.equal(b1.skin, "plasma", "Bullet 1 must have plasma skin");
    assert.equal(b2.skin, "ruby", "Bullet 2 must have ruby skin");

    const snapshot = ctx.createServerCoopSnapshot({ world, players: world.players });
    assert.ok(snapshot.bullets.some(b => b.id === "b1" && b.skin === "plasma"), "Snapshot must include b1 with plasma skin");
    assert.ok(snapshot.bullets.some(b => b.id === "b2" && b.skin === "ruby"), "Snapshot must include b2 with ruby skin");
  });

  await t.test("4. Client declares Damage Vignette variables, trigger function and renderers", () => {
    assert.ok(indexHtml.includes("let damageVignetteAlpha = 0;"), "Client must declare damageVignetteAlpha");
    assert.ok(indexHtml.includes("function triggerDamageVignette"), "Client must declare triggerDamageVignette");
    assert.ok(indexHtml.includes("function drawDamageVignette"), "Client must declare drawDamageVignette");
    assert.ok(indexHtml.includes("damageVignetteAlpha = 0;"), "resetVisualTime must reset damageVignetteAlpha");
    assert.ok(indexHtml.includes("damageVignetteAlpha - safeDt * 2.2"), "updateVisualTime must decay damageVignetteAlpha");
  });

  await t.test("5. Damage hooks in Solo and Co-op invoke triggerDamageVignette", () => {
    // Solo damagePlayer contains triggerDamageVignette
    assert.ok(indexHtml.includes("triggerDamageVignette(Math.min(1.0, 0.55 + (actualDamage / 100) * 0.35))"), "damagePlayer must trigger vignette");

    // Coop snapshot hurt contains triggerDamageVignette
    assert.ok(indexHtml.includes("triggerDamageVignette(Math.min(1.0, 0.55 + (dmg / 100) * 0.35))"), "Coop player hurt must trigger vignette");

    // Both draw() and drawCoopScene() invoke drawDamageVignette()
    const drawMatches = indexHtml.match(/drawDamageVignette\(\);/g) || [];
    assert.ok(drawMatches.length >= 2, `drawDamageVignette() must be called in both Solo and Coop scenes (found ${drawMatches.length})`);
  });

  await t.test("6. In-game Settings modal uses fullscreen cyber layout with opaque solid background", () => {
    assert.ok(indexHtml.includes("#overlay.fullscreen-menu-mode.ingame-settings-mode"), "CSS must declare #overlay.fullscreen-menu-mode.ingame-settings-mode");
    assert.ok(indexHtml.includes("overlay.classList.add(\"ingame-settings-mode\")"), "showSettingsMenu must add ingame-settings-mode when isPause is true");
    assert.ok(indexHtml.includes("overlay.classList.remove(\"ingame-settings-mode\")"), "showSettingsMenu exit must clean up ingame-settings-mode");
    assert.ok(indexHtml.includes("${backLabel}"), "showSettingsMenu must use dynamic backLabel");
    assert.ok(indexHtml.includes("${saveLabel}"), "showSettingsMenu must use dynamic saveLabel");
  });

  await t.test("7. Dedicated Armory/Skins menu with real-time live preview demonstration canvas", () => {
    assert.ok(indexHtml.includes("function showSkinsMenu"), "Client must define showSkinsMenu()");
    assert.ok(indexHtml.includes('data-main-action="skins"'), "Main menu must have Armory/Skins card");
    assert.ok(indexHtml.includes("skinPreviewCanvas"), "Skins menu must contain skinPreviewCanvas");
    assert.ok(indexHtml.includes("renderPreviewFrame"), "Skins menu must have renderPreviewFrame animation loop");
    assert.ok(indexHtml.includes("skins-preview-panel"), "Skins menu must have skins-preview-panel");

    // Pause menu does NOT contain skins action
    const pauseMenuChunk = indexHtml.substring(indexHtml.indexOf('id="pauseMenu"'), indexHtml.indexOf('id="pauseMenu"') + 1500);
    assert.ok(!pauseMenuChunk.includes('data-pause-action="skins"'), "Pause menu (ESC menu) must NOT contain skins action");
  });

  await t.test("8. Knowledge Base Bestiary & Upgrades Codex parity with live canvas preview", () => {
    // Check clean badge without inline border
    assert.ok(!indexHtml.includes('class="mode-card-badge" style="background: rgba(168, 85, 247'), "Armory badge should not have custom inline border");
    
    // Check Bestiary catalog & canvas
    assert.ok(indexHtml.includes("const BESTIARY_CATALOG ="), "Client must declare BESTIARY_CATALOG");
    assert.ok(indexHtml.includes("bestiaryCanvas"), "Guide modal must contain bestiaryCanvas");
    assert.ok(indexHtml.includes("renderBestiaryFrame"), "Guide modal must have renderBestiaryFrame animation loop");

    const EXPECTED_MOBS = ["normal", "runner", "tank", "charger", "splitter", "shooter", "incubator", "phantom", "magnetizer", "twin", "boss"];
    for (const mob of EXPECTED_MOBS) {
      assert.ok(indexHtml.includes(`id: "${mob}"`), `BESTIARY_CATALOG must define mob '${mob}'`);
    }

    // Check Upgrades Codex catalog
    assert.ok(indexHtml.includes("const UPGRADES_CODEX ="), "Client must declare UPGRADES_CODEX");
    assert.ok(indexHtml.includes('data-guide-tab="bestiary"'), "Guide modal must have Bestiary tab");
    assert.ok(indexHtml.includes('data-guide-tab="upgrades"'), "Guide modal must have Upgrades tab");
    assert.ok(indexHtml.includes('data-guide-tab="basics"'), "Guide modal must have Basics tab");

    // Check Incubator 5 spores & Boss 4 corner pylons in Bestiary
    assert.ok(indexHtml.includes("5 летающими по внешней орбите спорами"), "Incubator must describe 5 orbiting spores");
    assert.ok(indexHtml.includes("4 угловыми энергетическими пилонами арены"), "Boss must describe 4 corner arena pylons");
  });

  await t.test("9. Canvas context save/restore state balance in client renderer", () => {
    const saveMatches = (indexHtml.match(/ctx\.save\(\)/g) || []).length;
    const restoreMatches = (indexHtml.match(/ctx\.restore\(\)/g) || []).length;
    assert.equal(saveMatches, restoreMatches, `ctx.save() count (${saveMatches}) must equal ctx.restore() count (${restoreMatches}) to prevent viewport shifting / player disappearing`);

    // Specifically verify drawEnemyStatusEffects has balanced save/restore for targetMarked
    const statusEffectsFunc = indexHtml.substring(
      indexHtml.indexOf("function drawEnemyStatusEffects"),
      indexHtml.indexOf("function drawSplinterShards")
    );
    const sfSaves = (statusEffectsFunc.match(/ctx\.save\(\)/g) || []).length;
    const sfRestores = (statusEffectsFunc.match(/ctx\.restore\(\)/g) || []).length;
    assert.equal(sfSaves, sfRestores, `drawEnemyStatusEffects must have balanced save/restore (${sfSaves} === ${sfRestores})`);
  });
});
