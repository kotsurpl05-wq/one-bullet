const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Characterization tests for the REAL client upgrades[] array (public/index.html).
// No existing suite exercises this code (all upgrade tests target server.js's
// applyServerUpgrade/SERVER_UPGRADES only). This suite boots the real inline
// client script in a vm sandbox and calls the real available()/applyWithPower()
// closures directly, so a Phase 5 rewrite (thin wrappers into shared/upgrades.js)
// can be verified to produce byte-identical stats/player mutations.

const indexHtmlPath = path.resolve(__dirname, "../public/index.html");
const indexHtmlContent = fs.readFileSync(indexHtmlPath, "utf-8");

const clientScript = [
  ...indexHtmlContent.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)
]
  .map(block => block[1])
  .join("\n;\n");

assert.ok(
  clientScript.length > 100000,
  "Failed to extract the inline client script from public/index.html"
);

const noop = () => {};

function mockStyle() {
  return new Proxy(
    { setProperty: noop, removeProperty: noop, getPropertyValue: () => "" },
    {
      get(target, prop) {
        return prop in target ? target[prop] : "";
      },
      set(target, prop, value) {
        target[prop] = value;
        return true;
      }
    }
  );
}

function mockElement() {
  return {
    style: mockStyle(),
    classList: { add: noop, remove: noop, contains: () => false, toggle: noop },
    textContent: "",
    innerHTML: "",
    value: "",
    checked: false,
    children: [],
    dataset: {},
    offsetWidth: 100,
    offsetHeight: 100,
    appendChild: noop,
    removeChild: noop,
    insertBefore: noop,
    remove: noop,
    addEventListener: noop,
    removeEventListener: noop,
    setAttribute: noop,
    getAttribute: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    cloneNode: () => mockElement(),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 720 }),
    focus: noop,
    blur: noop
  };
}

function mockAudioContextFactory() {
  const param = {
    value: 1,
    setValueAtTime: noop,
    exponentialRampToValueAtTime: noop,
    linearRampToValueAtTime: noop,
    cancelScheduledValues: noop,
    setTargetAtTime: noop
  };

  return function MockAudioContext() {
    return {
      createGain: () => ({ gain: param, connect: noop, disconnect: noop }),
      createOscillator: () => ({
        type: "sine",
        frequency: param,
        detune: param,
        connect: noop,
        disconnect: noop,
        start: noop,
        stop: noop
      }),
      createBiquadFilter: () => ({
        type: "lowpass",
        frequency: param,
        Q: param,
        gain: param,
        connect: noop,
        disconnect: noop
      }),
      createBufferSource: () => ({
        buffer: null,
        playbackRate: param,
        connect: noop,
        disconnect: noop,
        start: noop,
        stop: noop,
        loop: false
      }),
      createBuffer: () => ({
        getChannelData: () => new Float32Array(2048),
        length: 2048
      }),
      createDynamicsCompressor: () => ({
        connect: noop,
        disconnect: noop,
        threshold: param,
        knee: param,
        ratio: param,
        attack: param,
        release: param
      }),
      createStereoPanner: () => ({ pan: param, connect: noop, disconnect: noop }),
      createWaveShaper: () => ({ curve: null, connect: noop, disconnect: noop }),
      createConvolver: () => ({ buffer: null, connect: noop, disconnect: noop }),
      createDelay: () => ({ delayTime: param, connect: noop, disconnect: noop }),
      destination: {},
      currentTime: 0,
      sampleRate: 44100,
      state: "running",
      resume: async () => {},
      close: async () => {}
    };
  };
}

function createClientSandbox() {
  const canvasState = {
    fillStyle: "#000000",
    strokeStyle: "#000000",
    font: "10px sans-serif",
    globalAlpha: 1,
    lineWidth: 1,
    textAlign: "start",
    textBaseline: "alphabetic"
  };

  const recorder = {
    fillText: noop,
    strokeText: noop,
    arc: noop,
    measureText: (text) => ({ width: String(text).length * 8 }),
    createLinearGradient: () => ({ addColorStop: noop }),
    createRadialGradient: () => ({ addColorStop: noop }),
    createPattern: () => null,
    getImageData: () => ({ data: new Uint8Array(4) }),
    setLineDash: noop,
    canvas: null
  };

  const mockCtx = new Proxy(recorder, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop in canvasState) return canvasState[prop];
      return noop;
    },
    set(target, prop, value) {
      canvasState[prop] = value;
      return true;
    },
    has() {
      return true;
    }
  });

  const mockCanvas = {
    getContext: () => mockCtx,
    width: 1280,
    height: 720,
    style: mockStyle(),
    addEventListener: noop,
    removeEventListener: noop,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 720 })
  };
  recorder.canvas = mockCanvas;

  const canvasSelectors = new Set(["#game", "game"]);
  const mockDocument = {
    getElementById: (id) =>
      canvasSelectors.has(String(id)) ? mockCanvas : mockElement(),
    querySelector: (sel) =>
      canvasSelectors.has(String(sel)) ? mockCanvas : mockElement(),
    querySelectorAll: () => [],
    createElement: () => mockElement(),
    body: mockElement(),
    documentElement: mockElement(),
    addEventListener: noop,
    removeEventListener: noop,
    hidden: false,
    visibilityState: "visible"
  };

  const MockAudioContext = mockAudioContextFactory();

  const sandbox = {
    console: { ...console, log: noop, warn: noop, error: noop },
    Math,
    Date,
    JSON,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Set,
    Map,
    WeakMap,
    WeakSet,
    Promise,
    Error,
    TypeError,
    RangeError,
    RegExp,
    Symbol,
    Proxy,
    Reflect,
    isNaN,
    isFinite,
    parseInt,
    parseFloat,
    encodeURIComponent,
    decodeURIComponent,
    Infinity,
    NaN,
    undefined,
    Float32Array,
    Uint8Array,
    Uint8ClampedArray,
    Int32Array,
    ArrayBuffer,
    setTimeout: () => 0,
    clearTimeout: noop,
    setInterval: () => 0,
    clearInterval: noop,
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: noop,
    performance: { now: () => 0 },
    document: mockDocument,
    navigator: { userAgent: "NodeTest", maxTouchPoints: 0, vibrate: noop, language: "ru" },
    location: { href: "http://localhost/", protocol: "http:", host: "localhost", search: "", hash: "" },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop, clear: noop },
    sessionStorage: { getItem: () => null, setItem: noop, removeItem: noop, clear: noop },
    AudioContext: MockAudioContext,
    webkitAudioContext: MockAudioContext,
    io: () => ({ on: noop, emit: noop, off: noop, id: "sock", connected: true, disconnect: noop }),
    alert: noop,
    prompt: () => null,
    confirm: () => false,
    fetch: async () => ({ ok: true, json: async () => ({}), text: async () => "" }),
    Image: function MockImage() {
      return mockElement();
    },
    matchMedia: () => ({
      matches: false,
      addEventListener: noop,
      removeEventListener: noop,
      addListener: noop
    }),
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    innerWidth: 1280,
    innerHeight: 720,
    devicePixelRatio: 1,
    addEventListener: noop,
    removeEventListener: noop,
    CustomEvent: function MockCustomEvent() {},
    Event: function MockEvent() {},
    structuredClone: (value) => JSON.parse(JSON.stringify(value)),
    net: {
      addEventListener: noop,
      createRoom: noop,
      joinRoom: noop,
      lastSnapshot: null,
      leaveRoom: noop,
      requestSnapshot: noop,
      returnToLobby: noop,
      sendInput: noop,
      sendReady: noop,
      sendReroll: noop,
      sendShoot: noop,
      sendTogglePause: noop,
      sendUpgradeChoice: noop,
      setDifficulty: noop
    },
    GameShared: require("../shared/index")
  };

  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  sandbox.top = sandbox;
  sandbox.parent = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(clientScript, sandbox, { filename: "public/index.html (inline)" });

  const evaluate = (source) =>
    vm.runInContext(`(function(){${source}})()`, sandbox);

  const readBinding = (name) =>
    vm.runInContext(`typeof ${name} === "undefined" ? undefined : ${name}`, sandbox);

  /** Resets to a clean run (resetEntities()) and returns the real upgrades[] array. */
  const freshUpgrades = () => {
    evaluate(`resetEntities();`);
    return readBinding("upgrades");
  };

  const getStats = () => readBinding("stats");
  const getPlayer = () => readBinding("player");

  return { evaluate, readBinding, freshUpgrades, getStats, getPlayer };
}

// Boot once — the client is ~300KB and evaluation is the expensive part.
const client = createClientSandbox();

function findUpgrade(upgrades, id) {
  const u = upgrades.find(u => u.id === id);
  assert.ok(u, `upgrade "${id}" not found in client upgrades[] array`);
  return u;
}

test("resetEntities() links player.stats to the same object as the module-level stats", () => {
  client.evaluate(`resetEntities();`);
  const stats = client.getStats();
  const player = client.getPlayer();
  assert.equal(player.stats, stats, "player.stats must be the same reference as stats");
});

test("upgrades[] has exactly 50 entries with unique ids", () => {
  const upgrades = client.freshUpgrades();
  assert.equal(upgrades.length, 50);
  const ids = upgrades.map(u => u.id);
  assert.equal(new Set(ids).size, 50, "duplicate upgrade ids found");
});

test("damage: plain stat mutation, +100 per power", () => {
  const upgrades = client.freshUpgrades();
  const damage = findUpgrade(upgrades, "damage");
  const before = client.getStats().damage;
  damage.applyWithPower(2);
  assert.equal(client.getStats().damage, before + 200);
});

test("armor: mutates player.hp/maxHp directly (not stats)", () => {
  const upgrades = client.freshUpgrades();
  const armor = findUpgrade(upgrades, "armor");
  const player = client.getPlayer();
  const beforeHp = player.hp;
  const beforeMax = player.maxHp;
  armor.applyWithPower(1);
  assert.equal(player.hp, beforeHp + 100);
  assert.equal(player.maxHp, beforeMax + 100);
});

test("repair: available() only when hp < maxHp; heals to full", () => {
  const upgrades = client.freshUpgrades();
  const repair = findUpgrade(upgrades, "repair");
  const player = client.getPlayer();
  assert.equal(repair.available(), false, "full-hp player should not be offered repair");
  player.hp = player.maxHp - 50;
  assert.equal(repair.available(), true);
  repair.applyWithPower(1);
  assert.equal(player.hp, player.maxHp);
});

test("caliber: clamps bulletRadius to 21 and resizes existing bullets", () => {
  const upgrades = client.freshUpgrades();
  const caliber = findUpgrade(upgrades, "caliber");
  client.evaluate(`bullets.length = 0; bullets.push({r: 7}, {r: 7});`);
  caliber.applyWithPower(10);
  const stats = client.getStats();
  assert.equal(stats.bulletRadius, 21, "bulletRadius must clamp at 21");
  const bulletRadii = [...client.readBinding("bullets")].map(b => b.r);
  assert.deepEqual(bulletRadii, [21, 21], "existing bullets must be resized to the new radius");
});

test("second-bullet: sets magazineSize=2 and calls ensureMagazine()", () => {
  const upgrades = client.freshUpgrades();
  const secondBullet = findUpgrade(upgrades, "second-bullet");
  assert.equal(secondBullet.available(), true);
  secondBullet.applyWithPower(1);
  assert.equal(client.getStats().magazineSize, 2);
  assert.equal(secondBullet.available(), false, "should become unavailable once magazineSize is 2");
});

test("pierce is exclusive with explosive/chain-lightning/catch-blast (one-directional gate)", () => {
  const upgrades = client.freshUpgrades();
  const pierce = findUpgrade(upgrades, "pierce");
  const explosive = findUpgrade(upgrades, "explosive");
  const chain = findUpgrade(upgrades, "chain-lightning");
  const catchBlast = findUpgrade(upgrades, "catch-blast");

  assert.equal(pierce.available(), true);
  assert.equal(explosive.available(), true);

  explosive.applyWithPower(1);
  assert.equal(pierce.available(), false, "pierce must be locked out once explosive is taken");
  // explosive/chain/catch-blast only gate against pierce and their own already-taken
  // state, NOT against each other — taking explosive does not lock out chain/catch-blast.
  assert.equal(chain.available(), true);
  assert.equal(catchBlast.available(), true);
});

test("bullet-speed: caps at BASE_BULLET_SPEED * 2.5", () => {
  const upgrades = client.freshUpgrades();
  const bulletSpeed = findUpgrade(upgrades, "bullet-speed");
  const base = client.readBinding("BASE_BULLET_SPEED");
  bulletSpeed.applyWithPower(20);
  assert.equal(client.getStats().bulletSpeed, base * 2.5);
  assert.equal(bulletSpeed.available(), false);
});

test("critical: caps critChance at 0.60", () => {
  const upgrades = client.freshUpgrades();
  const critical = findUpgrade(upgrades, "critical");
  critical.applyWithPower(20);
  assert.equal(client.getStats().critChance, 0.60);
  assert.equal(critical.available(), false);
});

test("catch-blast family: base unlock then damage-ratio/radius scaling with caps", () => {
  const upgrades = client.freshUpgrades();
  const catchBlast = findUpgrade(upgrades, "catch-blast");
  const catchBlastDamage = findUpgrade(upgrades, "catch-blast-damage");
  const catchBlastRadius = findUpgrade(upgrades, "catch-blast-radius");

  catchBlast.applyWithPower(1);
  assert.equal(client.getStats().catchBlast, 65);
  assert.equal(client.getStats().catchBlastDamageRatio, 0.8);

  catchBlastDamage.applyWithPower(20);
  assert.equal(client.getStats().catchBlastDamageRatio, 2.5, "damage ratio must cap at 2.5");

  catchBlastRadius.applyWithPower(20);
  assert.equal(client.getStats().catchBlast, 220, "radius must cap at 220");
});

test("getUpgradeBonusText returns non-empty text for all 49 ids", () => {
  const upgrades = client.freshUpgrades();
  const getUpgradeBonusText = client.readBinding("getUpgradeBonusText");
  for (const upgrade of upgrades) {
    const text = getUpgradeBonusText(upgrade, 1);
    assert.ok(
      typeof text === "string" && text.length > 0,
      `bonusText missing for "${upgrade.id}"`
    );
  }
});

test("dash family: base unlock, then distance/cooldown scaling with caps", () => {
  const upgrades = client.freshUpgrades();
  const dash = findUpgrade(upgrades, "dash");
  const dashDistance = findUpgrade(upgrades, "dash-distance");
  const dashCooldown = findUpgrade(upgrades, "dash-cooldown");
  const dashDamage = findUpgrade(upgrades, "dash-damage");

  assert.equal(dash.available(), true);
  dash.applyWithPower(1);
  assert.equal(client.getStats().dash, true);
  assert.equal(dash.available(), false);

  dashDistance.applyWithPower(20);
  assert.equal(client.getStats().dashDistance, 320, "distance must cap at 320");

  dashCooldown.applyWithPower(20);
  assert.equal(client.getStats().dashCooldownBase, 2.0, "cooldown must floor at 2.0");

  assert.equal(dashDamage.available(), true);
  dashDamage.applyWithPower(1);
  assert.equal(client.getStats().dashDamage, true);
});
