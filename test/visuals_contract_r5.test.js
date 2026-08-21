const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const indexHtmlPath = path.resolve(__dirname, "../public/index.html");
const indexHtmlContent = fs.readFileSync(indexHtmlPath, "utf-8");

// Only inline <script> blocks carry the client; /socket.io/... and /network.js are external.
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

/**
 * Boots the REAL client (public/index.html inline script) inside a vm sandbox with
 * mocked Canvas/DOM/Audio, and returns handles to drive the REAL client functions
 * and read the REAL client state.
 *
 * `draws` records every 2D-context text/arc call so render-side behaviour
 * (damage number colour/font, ring expansion) can be observed without a browser.
 */
function createClientVisualSandbox() {
  const draws = [];
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
    fillText: (text, x, y) =>
      draws.push({
        op: "fillText",
        text: String(text),
        x,
        y,
        fillStyle: canvasState.fillStyle,
        font: canvasState.font,
        globalAlpha: canvasState.globalAlpha
      }),
    strokeText: (text, x, y) =>
      draws.push({
        op: "strokeText",
        text: String(text),
        x,
        y,
        strokeStyle: canvasState.strokeStyle,
        font: canvasState.font,
        globalAlpha: canvasState.globalAlpha
      }),
    arc: (x, y, r) =>
      draws.push({
        op: "arc",
        x,
        y,
        r,
        strokeStyle: canvasState.strokeStyle,
        fillStyle: canvasState.fillStyle,
        globalAlpha: canvasState.globalAlpha,
        lineWidth: canvasState.lineWidth
      }),
    measureText: (text) => ({ width: String(text).length * 8 }),
    createLinearGradient: () => ({ addColorStop: noop }),
    createRadialGradient: () => ({ addColorStop: noop }),
    createPattern: () => null,
    getImageData: () => ({ data: new Uint8Array(4) }),
    setLineDash: noop,
    canvas: null
  };

  // Unknown ctx methods become no-ops; unknown props read back from canvasState.
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
    // public/network.js is a separate <script src>, so the coop client's
    // transport has to be stubbed for updateCoopClient() to be drivable.
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
    __draws: draws
  };

  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  sandbox.top = sandbox;
  sandbox.parent = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(clientScript, sandbox, { filename: "public/index.html (inline)" });

  /**
   * Evaluates `source` against the live client scope.
   * Wrapped in an IIFE so each snippet gets a fresh lexical scope but still
   * reads/writes the client's real top-level bindings.
   */
  const evaluate = (source) =>
    vm.runInContext(`(function(){${source}})()`, sandbox);

  /** Reads a client top-level binding by name; returns undefined if not declared. */
  const readBinding = (name) => {
    try {
      return vm.runInContext(
        `typeof ${name} === "undefined" ? undefined : ${name}`,
        sandbox
      );
    } catch {
      return undefined;
    }
  };

  /** True when the client declares a top-level binding of the given name. */
  const hasBinding = (name) => {
    try {
      return vm.runInContext(`typeof ${name}`, sandbox) !== "undefined";
    } catch {
      return false;
    }
  };

  /**
   * Puts the client into a clean, deterministic solo-combat state.
   *
   * This only establishes PRECONDITIONS (zeroing timers/buffers the previous
   * test armed). Assertions always read state the client itself wrote.
   */
  const resetCombat = (overrides = {}) => {
    evaluate(`
      gameState = "playing";
      coopSession.active = false;
      enemies.length = 0;
      bullets.length = 0;
      particles.length = 0;
      experienceCrystals.length = 0;
      coopParticles.length = 0;
      screenShake = 0;
      stats.homing = 0;
      stats.explosionRadius = 0;
      stats.chainCount = 0;
      stats.catchBlast = 0;
      stats.pickupRadius = 0;
      stats.groundPullSpeed = 0;
      stats.critChance = ${Number(overrides.critChance) || 0};
      stats.damage = ${Number(overrides.damage) || 4};
      player.x = ${Number(overrides.playerX) || 200};
      player.y = ${Number(overrides.playerY) || 360};
      player.hp = 6;
      player.maxHp = 6;
      player.invulnerability = 0;
      __draws.length = 0;
    `);

    // Clear any R5 visual timers/buffers a previous test armed, so each test
    // starts from a known-cold state rather than inheriting a freeze or slow-mo.
    for (const name of [...HIT_STOP_NAMES, ...SLOW_MO_NAMES]) {
      if (hasBinding(name)) evaluate(`${name} = 0;`);
    }
    for (const name of DAMAGE_NUMBER_NAMES) {
      if (hasBinding(name)) evaluate(`${name}.length = 0;`);
    }
    if (hasBinding("slowMoFactor")) evaluate(`slowMoFactor = 1;`);
  };

  return { sandbox, draws, evaluate, readBinding, hasBinding, resetCombat };
}

// Boot once — the client is ~300KB and evaluation is the expensive part.
const client = createClientVisualSandbox();

/** Finds the first client binding that exists from a list of candidate names. */
function findBinding(candidates) {
  return candidates.find(name => client.hasBinding(name));
}

// Candidate names for R5 state, so tests assert on BEHAVIOUR and stay
// agnostic to the exact identifier the implementation chooses.
const HIT_STOP_NAMES = [
  "hitStopTimer",
  "hitStop",
  "hitStopTime",
  "hitStopDuration",
  "hitstopTimer",
  "freezeTimer"
];

const DAMAGE_NUMBER_NAMES = [
  "damageNumbers",
  "floatingNumbers",
  "damageTexts",
  "damagePopups",
  "floatingDamageNumbers"
];

const SLOW_MO_NAMES = [
  "slowMoTimer",
  "slowMotionTimer",
  "bossSlowMoTimer",
  "timeScaleTimer",
  "celebrationTimer"
];

/**
 * Measures how far a flying bullet advances on each of `frames` successive
 * gameLoop() calls, returning the per-frame delta-x list.
 *
 * This is the load-bearing probe for hit stop and slow-mo: a frozen simulation
 * yields a 0 delta while held; a slowed one yields a reduced delta.
 */
function measureSimulationDeltas(frames, { setup = "", dtMs = 16, startTime = 1000 } = {}) {
  return client.evaluate(`
    gameState = "playing";
    coopSession.active = false;
    stats.homing = 0;
    bullets.length = 0;
    const probeBullet = {
      state: "flying",
      x: 300, y: 360,
      vx: 400, vy: 0,
      r: 7, age: 0,
      bouncesLeft: 99999,
      hitsLeft: 1,
      hitEnemies: new Set(),
      hitCooldowns: new Map()
    };
    bullets.push(probeBullet);
    ${setup}
    lastTime = ${startTime};
    const positions = [probeBullet.x];
    for (let frame = 1; frame <= ${frames}; frame++) {
      gameLoop(${startTime} + frame * ${dtMs});
      positions.push(probeBullet.x);
    }
    return positions
      .slice(1)
      .map((value, index) => Number((value - positions[index]).toFixed(5)));
  `);
}

test("R5 Visual Juice & Client Structural Contract Verification Suite", async (t) => {

  // =========================================================================
  // TIER 1: REAL-CLIENT BEHAVIOURAL CONTRACTS
  // Every assertion drives a real function from public/index.html and reads
  // real client state. The test never declares the state it asserts on.
  // =========================================================================

  await t.test("Tier 1.1: Hit Stop freezes the real simulation on crit and boss kill", async (t1) => {
    await t1.test("Baseline: gameLoop advances the real simulation every frame", () => {
      client.resetCombat();
      const deltas = measureSimulationDeltas(5);

      assert.equal(deltas.length, 5);
      for (const delta of deltas) {
        assert.ok(delta > 0, `Simulation must advance every frame, got ${delta}`);
      }
      assert.equal(
        client.readBinding("lastGameError"),
        "",
        "gameLoop must run without throwing"
      );
    });

    await t1.test("Client declares a hit-stop timer AND it is armed by a crit", () => {
      const binding = findBinding(HIT_STOP_NAMES);
      assert.ok(
        binding,
        `No hit-stop timer declared in the client. Looked for: ${HIT_STOP_NAMES.join(", ")}`
      );

      // A declared-but-unwired timer is not a feature. Drive a real crit and
      // require the real timer to actually become positive.
      client.resetCombat({ critChance: 1, damage: 4 });
      const armed = client.evaluate(`
        enemies.length = 0;
        const target = createEnemy("tank", 640, 360);
        target.hp = 99999;
        target.hasEnteredArena = true;
        enemies.push(target);
        applyBulletHit(0);
        return ${binding};
      `);

      assert.ok(
        typeof armed === "number" && armed > 0,
        `A crit must arm ${binding} (> 0), got ${JSON.stringify(armed)}`
      );
      assert.ok(
        armed <= 0.1,
        `${binding} should be a ~40ms hold, not ${armed}s`
      );
    });

    await t1.test("A critical hit freezes the simulation ~40ms, then it resumes", () => {
      client.resetCombat({ critChance: 1, damage: 4 });

      // Real crit path: critChance === 1 forces the crit branch of applyBulletHit.
      const deltas = measureSimulationDeltas(6, {
        setup: `
          enemies.length = 0;
          const target = createEnemy("tank", 640, 360);
          target.hp = 99999;
          target.hasEnteredArena = true;
          enemies.push(target);
          applyBulletHit(0);
        `
      });

      const frozenFrames = deltas.filter(delta => delta === 0).length;

      assert.ok(
        frozenFrames >= 2,
        `A crit must freeze the simulation ~40ms (>=2 frames at 16ms). ` +
          `Per-frame deltas: [${deltas.join(", ")}]`
      );
      assert.ok(
        deltas[deltas.length - 1] > 0,
        `Simulation must resume after the hit stop expires. Deltas: [${deltas.join(", ")}]`
      );
    });

    await t1.test("A boss kill freezes the simulation ~40ms", () => {
      client.resetCombat();

      const deltas = measureSimulationDeltas(6, {
        setup: `
          enemies.length = 0;
          experienceCrystals.length = 0;
          const boss = createEnemy("boss", 640, 360);
          boss.hp = 1;
          boss.hasEnteredArena = true;
          enemies.push(boss);
          killEnemy(0);
        `
      });

      assert.ok(
        deltas.some(delta => delta === 0),
        `A boss kill must freeze the simulation. Per-frame deltas: [${deltas.join(", ")}]`
      );
    });

    await t1.test("A normal (non-crit) hit does NOT freeze the simulation", () => {
      client.resetCombat({ critChance: 0, damage: 4 });

      const deltas = measureSimulationDeltas(4, {
        setup: `
          enemies.length = 0;
          const target = createEnemy("tank", 640, 360);
          target.hp = 99999;
          target.hasEnteredArena = true;
          enemies.push(target);
          applyBulletHit(0);
        `
      });

      for (const delta of deltas) {
        assert.ok(
          delta > 0,
          `Non-crit hits must not stop the simulation. Deltas: [${deltas.join(", ")}]`
        );
      }
    });

    await t1.test("Hit stop is clamped, not additive, under stacked crits", () => {
      client.resetCombat({ critChance: 1, damage: 1 });

      const deltas = measureSimulationDeltas(20, {
        setup: `
          enemies.length = 0;
          const target = createEnemy("tank", 640, 360);
          target.hp = 999999;
          target.hasEnteredArena = true;
          enemies.push(target);
          for (let i = 0; i < 50; i++) applyBulletHit(0);
        `
      });

      const frozenFrames = deltas.filter(delta => delta === 0).length;
      assert.ok(
        frozenFrames <= 8,
        `Hit stop must be clamped: ${frozenFrames} frozen frames of ${deltas.length} ` +
          `after 50 stacked crits. Deltas: [${deltas.join(", ")}]`
      );
      assert.ok(
        deltas.some(delta => delta > 0),
        "Simulation must eventually resume after stacked crits"
      );
    });
  });

  // =========================================================================
  // TIER 1.2: BULLET TRAILS
  // =========================================================================

  await t.test("Tier 1.2: Flying bullets emit fading trail particles in the real particles array", async (t1) => {
    await t1.test("Sanity: the real particles array and updateParticles decay work", () => {
      const result = client.evaluate(`
        particles.length = 0;
        createParticles(100, 100, "#abcdef", 4, 100);
        const spawned = particles.length;
        const lifeBefore = particles[0].life;
        updateParticles(0.01);
        const lifeAfter = particles[0].life;
        updateParticles(10);
        return { spawned, decayed: lifeAfter < lifeBefore, cleared: particles.length };
      `);

      assert.equal(result.spawned, 4, "createParticles must push into the real particles array");
      assert.ok(result.decayed, "updateParticles must decay particle life");
      assert.equal(result.cleared, 0, "Expired particles must be removed");
    });

    await t1.test("A flying bullet leaves flagged trail particles along its real path", () => {
      client.resetCombat();
      const result = client.evaluate(`
        particles.length = 0;
        enemies.length = 0;
        bullets.length = 0;
        stats.homing = 0;
        const bullet = {
          state: "flying",
          x: 200, y: 360,
          vx: 600, vy: 0,
          r: 7, age: 0,
          bouncesLeft: 99999,
          hitsLeft: 1,
          hitEnemies: new Set(),
          hitCooldowns: new Map()
        };
        bullets.push(bullet);
        for (let frame = 0; frame < 10; frame++) updateBullets(0.016);
        return {
          particleCount: particles.length,
          bulletX: bullet.x,
          entries: particles.map(p => ({ ...p })),
          trailFlagged: particles.filter(p => p.isTrail === true).length
        };
      `);

      assert.ok(
        result.particleCount > 0,
        `A flying bullet must emit trail particles; the real particles array is empty ` +
          `after 10 frames of updateBullets (bullet travelled 200 -> ${result.bulletX})`
      );

      // The isTrail flag is not bookkeeping: drawParticles branches on it to
      // halve the alpha, which is what makes a trail read as a fading trail
      // rather than a cluster of ordinary impact particles.
      assert.ok(
        result.trailFlagged > 0,
        `Trail particles must be flagged isTrail === true so the renderer can fade ` +
          `them. Emitted particles: ${JSON.stringify(result.entries)}`
      );

      // Trails mark the path the bullet already covered, so they must sit behind it.
      const trails = result.entries.filter(entry => entry.isTrail === true);
      assert.ok(
        trails.some(entry => entry.x < result.bulletX),
        `Trail particles must be left behind the bullet (bulletX=${result.bulletX}, ` +
          `trail xs=[${trails.map(entry => entry.x).join(", ")}])`
      );
    });

    await t1.test("The isTrail flag actually makes the renderer fade trails", () => {
      client.resetCombat();
      const result = client.evaluate(`
        // Two particles identical except for isTrail, at distinct positions so
        // their draw calls can be told apart in the recording.
        particles.length = 0;
        enemies.length = 0;
        bullets.length = 0;
        gameState = "playing";

        const base = {
          vx: 0, vy: 0,
          life: 0.18, maxLife: 0.18,
          size: 4,
          color: "#7ee7ff"
        };
        particles.push({ ...base, x: 300, y: 200, isTrail: true });
        particles.push({ ...base, x: 700, y: 200, isTrail: false });

        __draws.length = 0;
        draw();

        const at = (x) => __draws.filter(
          d => d.op === "arc" && Math.abs(d.x - x) < 2 && Math.abs(d.y - 200) < 2
        );
        return {
          trailAlpha: Math.max(...at(300).map(d => d.globalAlpha), -1),
          plainAlpha: Math.max(...at(700).map(d => d.globalAlpha), -1)
        };
      `);

      assert.ok(
        result.trailAlpha >= 0 && result.plainAlpha >= 0,
        `Both particles must be drawn (trailAlpha=${result.trailAlpha}, ` +
          `plainAlpha=${result.plainAlpha})`
      );
      assert.ok(
        result.trailAlpha < result.plainAlpha,
        `A particle flagged isTrail must render more transparent than an otherwise ` +
          `identical unflagged particle (trail=${result.trailAlpha}, ` +
          `plain=${result.plainAlpha}). Without this the trail does not read as fading.`
      );
    });

    await t1.test("Held and ground bullets emit NO trail", () => {
      client.resetCombat();
      const result = client.evaluate(`
        const counts = {};
        for (const state of ["held", "ground"]) {
          particles.length = 0;
          enemies.length = 0;
          bullets.length = 0;
          stats.homing = 0;
          stats.pickupRadius = 0;
          stats.groundPullSpeed = 0;
          bullets.push({
            state,
            x: 900, y: 360,
            vx: 0, vy: 0,
            r: 7, age: 0,
            bouncesLeft: 5,
            hitsLeft: 1,
            hitEnemies: new Set(),
            hitCooldowns: new Map()
          });
          for (let frame = 0; frame < 10; frame++) updateBullets(0.016);
          counts[state] = particles.length;
        }
        return counts;
      `);

      assert.equal(result.held, 0, "A held bullet must not emit trail particles");
      assert.equal(result.ground, 0, "A ground bullet must not emit trail particles");
    });

    await t1.test("Trail particles fade out and do not accumulate without bound", () => {
      client.resetCombat();
      const result = client.evaluate(`
        particles.length = 0;
        enemies.length = 0;
        bullets.length = 0;
        experienceCrystals.length = 0;
        stats.homing = 0;
        bullets.push({
          state: "flying",
          x: 200, y: 360,
          vx: 500, vy: 0,
          r: 7, age: 0,
          bouncesLeft: 999999,
          hitsLeft: 1,
          hitEnemies: new Set(),
          hitCooldowns: new Map()
        });
        lastTime = 0;
        let peak = 0;
        for (let frame = 1; frame <= 600; frame++) {
          gameLoop(frame * 16);
          peak = Math.max(peak, particles.length);
        }
        return { peak, final: particles.length, err: lastGameError };
      `);

      assert.equal(result.err, "", "600 frames of gameLoop must not throw");
      assert.ok(
        result.peak > 0,
        "Sustained flight must produce trail particles over 600 real frames"
      );
      assert.ok(
        result.peak < 2000,
        `Trail particles must expire rather than accumulate; peak was ${result.peak}`
      );
    });

    await t1.test("Coop trails are coloured from the bullet OWNER, not a constant", () => {
      // Drives the real coop client with two in-flight bullets owned by
      // different players, then checks the trail colours the client chose.
      const result = client.evaluate(`
        coopSession.active = true;
        coopSession.manualPaused = false;
        coopSession.upgradePaused = false;
        coopSession.bullets.clear();
        coopSession.players.clear();
        coopParticles.length = 0;

        for (const index of [0, 1]) {
          coopSession.bullets.set("b" + index, {
            id: "b" + index,
            ownerId: "p" + index,
            colorIndex: index,
            state: "flying",
            displayX: 200 + index * 400, displayY: 100 + index * 200,
            targetX: 260 + index * 400, targetY: 100 + index * 200,
            x: 200 + index * 400, y: 100 + index * 200,
            vx: 400, vy: 0,
            r: 7, trailTimer: 0
          });
        }

        for (let frame = 0; frame < 12; frame++) updateCoopClient(0.016);

        const trails = coopParticles.filter(p => p.isTrail === true);
        const byOwner = {};
        for (const index of [0, 1]) {
          const bullet = coopSession.bullets.get("b" + index);
          // Trails for this owner: nearest to that bullet's lane (distinct y).
          byOwner["p" + index] = [
            ...new Set(
              trails
                .filter(p => Math.abs(p.y - bullet.displayY) < 60)
                .map(p => String(p.color).toLowerCase())
            )
          ];
        }

        coopSession.active = false;
        return {
          trailCount: trails.length,
          distinctColors: [...new Set(trails.map(p => String(p.color).toLowerCase()))],
          byOwner,
          ownerColors: coopPlayerColors.map(c => String(c.body).toLowerCase())
        };
      `);

      assert.ok(
        result.trailCount > 0,
        "Flying coop bullets must emit flagged trail particles via updateCoopClient"
      );

      assert.equal(
        result.ownerColors.length,
        2,
        "Two distinct owner colours must exist so trails can be coloured per owner"
      );
      assert.notEqual(result.ownerColors[0], result.ownerColors[1]);

      // The load-bearing assertion: two owners must yield two different trail
      // colours. A trail hardcoded to any single literal collapses this to 1.
      assert.equal(
        result.distinctColors.length,
        2,
        `Trails from two different owners must use two different colours, got ` +
          `[${result.distinctColors.join(", ")}]. A hardcoded trail colour fails here.`
      );

      // And each owner's trail must be that owner's colour specifically.
      assert.deepEqual(
        [...result.byOwner.p0],
        [result.ownerColors[0]],
        `Player 0's trail must use player 0's colour (${result.ownerColors[0]}), ` +
          `got [${result.byOwner.p0.join(", ")}]`
      );
      assert.deepEqual(
        [...result.byOwner.p1],
        [result.ownerColors[1]],
        `Player 1's trail must use player 1's colour (${result.ownerColors[1]}), ` +
          `got [${result.byOwner.p1.join(", ")}]`
      );
    });

    await t1.test("Coop particle pipeline spawns, flags and expires correctly", () => {
      const result = client.evaluate(`
        coopParticles.length = 0;
        createCoopParticles(10, 20, coopPlayerColors[1].body, 5, 100);
        createCoopRing(30, 40, 26, coopPlayerColors[0].body);
        const spawned = coopParticles.length;
        const rings = coopParticles.filter(p => p.ring).length;
        updateCoopParticles(10);
        return { spawned, rings, cleared: coopParticles.length };
      `);

      assert.equal(result.spawned, 6, "Coop particle + ring pipeline must populate coopParticles");
      assert.equal(result.rings, 1);
      assert.equal(result.cleared, 0, "Coop particles must expire");
    });
  });

  // =========================================================================
  // TIER 1.3: FLOATING DAMAGE NUMBERS
  // =========================================================================

  await t.test("Tier 1.3: Floating damage numbers spawn from real hits and render", async (t1) => {
    await t1.test("Client declares a damage-numbers collection", () => {
      const binding = findBinding(DAMAGE_NUMBER_NAMES);
      assert.ok(
        binding,
        `No floating damage-number collection declared in the client. ` +
          `Looked for: ${DAMAGE_NUMBER_NAMES.join(", ")}`
      );
      assert.ok(
        Array.isArray(client.readBinding(binding)),
        `${binding} must be an array`
      );
    });

    await t1.test("A real normal hit pushes exactly one damage number", () => {
      const binding = findBinding(DAMAGE_NUMBER_NAMES);
      assert.ok(binding, "Damage-number collection must exist before it can be populated");

      client.resetCombat({ critChance: 0, damage: 4 });
      const result = client.evaluate(`
        ${binding}.length = 0;
        enemies.length = 0;
        const target = createEnemy("tank", 640, 360);
        target.hp = 99999;
        target.hasEnteredArena = true;
        enemies.push(target);
        applyBulletHit(0);
        return { count: ${binding}.length, entries: ${binding}.map(n => ({ ...n })) };
      `);

      assert.ok(
        result.count > 0,
        `A real hit via applyBulletHit must push into ${binding}, got ${result.count} entries`
      );
    });

    await t1.test("Crit damage numbers are red and larger; normal ones are yellow", () => {
      const binding = findBinding(DAMAGE_NUMBER_NAMES);
      assert.ok(binding, "Damage-number collection must exist");

      const sample = (critChance) => {
        client.resetCombat({ critChance, damage: 4 });
        return client.evaluate(`
          ${binding}.length = 0;
          enemies.length = 0;
          const target = createEnemy("tank", 640, 360);
          target.hp = 99999;
          target.hasEnteredArena = true;
          enemies.push(target);
          applyBulletHit(0);
          return ${binding}.map(n => ({ ...n }));
        `);
      };

      const normals = sample(0);
      const crits = sample(1);

      assert.ok(normals.length > 0, "Normal hit must produce a damage number");
      assert.ok(crits.length > 0, "Crit hit must produce a damage number");

      const normal = normals[0];
      const crit = crits[0];

      // Colour: crit must be visually distinct (reddish) from normal (yellowish).
      assert.notEqual(
        String(normal.color).toLowerCase(),
        String(crit.color).toLowerCase(),
        `Crit and normal damage numbers must differ in colour ` +
          `(normal=${normal.color}, crit=${crit.color})`
      );

      const parseChannels = (hex) => {
        const match = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
        assert.ok(match, `Damage number colour must be a 6-digit hex, got ${hex}`);
        const int = parseInt(match[1], 16);
        return { r: (int >> 16) & 255, g: (int >> 8) & 255, b: int & 255 };
      };

      const normalRgb = parseChannels(normal.color);
      const critRgb = parseChannels(crit.color);

      // Yellow => red and green both high. Red => red high, green comparatively low.
      assert.ok(
        normalRgb.r > 150 && normalRgb.g > 150 && normalRgb.g >= normalRgb.b,
        `Normal damage numbers must be yellow, got ${normal.color}`
      );
      assert.ok(
        critRgb.r > 150 && critRgb.g < normalRgb.g,
        `Crit damage numbers must be red (less green than the yellow normal), got ${crit.color}`
      );

      // Font size: crits must be strictly larger.
      const sizeOf = (entry) => {
        if (Number.isFinite(entry.fontSize)) return entry.fontSize;
        if (Number.isFinite(entry.size)) return entry.size;
        const fromFont = /(\d+(?:\.\d+)?)px/.exec(String(entry.font || ""));
        return fromFont ? Number(fromFont[1]) : NaN;
      };

      const normalSize = sizeOf(normal);
      const critSize = sizeOf(crit);

      assert.ok(
        Number.isFinite(normalSize) && Number.isFinite(critSize),
        `Damage numbers must carry a numeric font size ` +
          `(normal=${JSON.stringify(normal)}, crit=${JSON.stringify(crit)})`
      );
      assert.ok(
        critSize > normalSize,
        `Crit font size must exceed normal (${critSize} vs ${normalSize})`
      );
    });

    await t1.test("Damage numbers drift upward and expire via the real update path", () => {
      const binding = findBinding(DAMAGE_NUMBER_NAMES);
      assert.ok(binding, "Damage-number collection must exist");

      client.resetCombat({ critChance: 0, damage: 4 });
      const result = client.evaluate(`
        ${binding}.length = 0;
        enemies.length = 0;
        bullets.length = 0;
        experienceCrystals.length = 0;
        const target = createEnemy("tank", 640, 360);
        target.hp = 99999;
        target.hasEnteredArena = true;
        enemies.push(target);
        applyBulletHit(0);
        if (${binding}.length === 0) return { spawned: 0 };

        const startY = ${binding}[0].y;
        lastTime = 0;
        gameLoop(16);
        gameLoop(32);
        const midY = ${binding}.length > 0 ? ${binding}[0].y : null;

        for (let frame = 3; frame <= 200; frame++) gameLoop(frame * 16);
        return {
          spawned: 1,
          startY,
          midY,
          remaining: ${binding}.length,
          err: lastGameError
        };
      `);

      assert.equal(result.spawned, 1, "A real hit must spawn a damage number to track");
      assert.equal(result.err, "", "gameLoop must not throw while updating damage numbers");
      assert.ok(
        result.midY !== null && result.midY < result.startY,
        `Damage numbers must drift upward (y decreasing): ${result.startY} -> ${result.midY}`
      );
      assert.equal(
        result.remaining,
        0,
        `Damage numbers must expire; ${result.remaining} still alive after ~3.2s`
      );
    });

    await t1.test("Damage numbers are actually rendered as text by draw()", () => {
      const binding = findBinding(DAMAGE_NUMBER_NAMES);
      assert.ok(binding, "Damage-number collection must exist");

      client.resetCombat({ critChance: 1, damage: 7 });
      const result = client.evaluate(`
        ${binding}.length = 0;
        particles.length = 0;
        enemies.length = 0;
        const target = createEnemy("tank", 640, 360);
        target.hp = 99999;
        target.hasEnteredArena = true;
        enemies.push(target);
        applyBulletHit(0);
        const pending = ${binding}.map(n => ({ ...n }));
        __draws.length = 0;
        draw();
        return {
          pending,
          texts: __draws
            .filter(d => d.op === "fillText" || d.op === "strokeText")
            .map(d => ({ text: d.text, font: d.font }))
        };
      `);

      assert.ok(result.pending.length > 0, "A crit must queue a damage number");

      // The rendered text must include the damage value the client stored.
      const expected = result.pending
        .map(entry => String(entry.text ?? entry.value ?? entry.amount ?? "").trim())
        .filter(Boolean);

      assert.ok(
        expected.length > 0,
        `Damage number entries must carry the text to draw: ${JSON.stringify(result.pending)}`
      );
      assert.ok(
        result.texts.some(drawn => expected.includes(String(drawn.text).trim())),
        `draw() must render the damage number text. Expected one of ` +
          `[${expected.join(", ")}], drawn: [${result.texts.map(d => d.text).join(", ")}]`
      );
    });
  });

  // =========================================================================
  // TIER 1.4: INTERCEPT CATCH WAVE
  // =========================================================================

  await t.test("Tier 1.4: Catching a bullet emits an expanding ring", async (t1) => {
    await t1.test("catchBullet pushes a real ring particle at the player position", () => {
      client.resetCombat();
      const result = client.evaluate(`
        particles.length = 0;
        enemies.length = 0;
        player.x = 500;
        player.y = 500;
        stats.catchBlast = 0;
        const bullet = {
          state: "flying",
          x: 505, y: 500,
          vx: 300, vy: 0,
          r: 7, age: 1,
          hitEnemies: new Set()
        };
        catchBullet(bullet);
        return {
          state: bullet.state,
          rings: particles.filter(p => p.ring).map(p => ({ ...p }))
        };
      `);

      assert.equal(result.state, "held", "catchBullet must transition the bullet to held");
      assert.ok(
        result.rings.length >= 1,
        "Catching a bullet must emit at least one ring particle"
      );

      const ring = result.rings[0];
      assert.equal(ring.x, 500, "Catch ring must originate at the player x");
      assert.equal(ring.y, 500, "Catch ring must originate at the player y");
      assert.ok(ring.size > 0, "Catch ring must have a positive radius");
      assert.ok(ring.life > 0, "Catch ring must have a positive lifetime");
    });

    await t1.test("The catch ring fires even with NO catch-blast upgrade", () => {
      client.resetCombat();
      const result = client.evaluate(`
        particles.length = 0;
        enemies.length = 0;
        stats.catchBlast = 0;
        player.x = 400; player.y = 300;
        catchBullet({
          state: "flying", x: 405, y: 300, vx: 200, vy: 0,
          r: 7, age: 1, hitEnemies: new Set()
        });
        const rings = particles.filter(p => p.ring);
        return {
          ringCount: rings.length,
          // The dedicated intercept wave must be distinguishable from the
          // generic impact ring the client already drew before R5.
          waveCount: rings.filter(p => p.catchWave || p.isCatchWave || p.wave).length
        };
      `);

      assert.ok(
        result.ringCount >= 1,
        "Per R5.4 the catch wave must appear even without catch-blast"
      );
      assert.ok(
        result.waveCount >= 1,
        `Catching a bullet must emit a dedicated intercept wave (a ring flagged as a ` +
          `catch wave), not only the pre-existing generic impact ring. ` +
          `rings=${result.ringCount}, flagged waves=${result.waveCount}`
      );
    });

    await t1.test("The catch ring visibly expands and fades through the real render path", () => {
      client.resetCombat();
      const result = client.evaluate(`
        particles.length = 0;
        enemies.length = 0;
        bullets.length = 0;
        player.x = 640; player.y = 360;
        stats.catchBlast = 0;
        catchBullet({
          state: "flying", x: 645, y: 360, vx: 200, vy: 0,
          r: 7, age: 1, hitEnemies: new Set()
        });

        const samples = [];
        for (let step = 0; step < 4; step++) {
          __draws.length = 0;
          draw();
          const arcs = __draws.filter(
            d => d.op === "arc" && Math.abs(d.x - 640) < 2 && Math.abs(d.y - 360) < 2
          );
          samples.push({
            radii: arcs.map(a => a.r),
            alphas: arcs.map(a => a.globalAlpha)
          });
          updateParticles(0.08);
        }
        // Run past the ring lifetime to confirm cleanup.
        updateParticles(2);
        return { samples, remainingRings: particles.filter(p => p.ring).length };
      `);

      const radii = result.samples
        .map(sample => Math.max(...sample.radii, 0))
        .filter(radius => radius > 0);

      assert.ok(
        radii.length >= 2,
        `The catch ring must be drawn as an arc across frames, got ${JSON.stringify(result.samples)}`
      );
      assert.ok(
        radii[radii.length - 1] > radii[0],
        `The catch ring must expand over its lifetime: [${radii.join(", ")}]`
      );

      const alphas = result.samples
        .map(sample => Math.max(...sample.alphas, 0))
        .filter(alpha => alpha > 0);

      assert.ok(
        alphas[alphas.length - 1] < alphas[0],
        `The catch ring must fade out: [${alphas.join(", ")}]`
      );
      assert.equal(result.remainingRings, 0, "The catch ring must be cleaned up when expired");
    });

    await t1.test("Catch-blast damage still applies alongside the ring", () => {
      client.resetCombat();
      const result = client.evaluate(`
        particles.length = 0;
        enemies.length = 0;
        experienceCrystals.length = 0;
        player.x = 400; player.y = 300;
        stats.catchBlast = 75;

        const near = createEnemy("tank", 440, 300);
        near.hp = 10; near.hasEnteredArena = true;
        const far = createEnemy("tank", 900, 300);
        far.hp = 10; far.hasEnteredArena = true;
        enemies.push(near, far);

        catchBullet({
          state: "flying", x: 405, y: 300, vx: 200, vy: 0,
          r: 7, age: 1, hitEnemies: new Set()
        });

        return {
          nearHp: near.hp,
          farHp: far.hp,
          rings: particles.filter(p => p.ring).length
        };
      `);

      assert.ok(result.nearHp < 10, "An enemy inside the blast radius must take damage");
      assert.equal(result.farHp, 10, "An enemy outside the blast radius must be untouched");
      assert.ok(result.rings >= 1, "The catch ring must fire alongside the blast");
    });
  });

  // =========================================================================
  // TIER 1.5: BOSS KILL CELEBRATION
  // =========================================================================

  await t.test("Tier 1.5: Boss kill triggers slow-mo plus a large particle explosion", async (t1) => {
    await t1.test("A boss kill bursts far more particles than a normal kill", () => {
      const burstFor = (type) => {
        client.resetCombat();
        return client.evaluate(`
          particles.length = 0;
          enemies.length = 0;
          experienceCrystals.length = 0;
          screenShake = 0;
          const victim = createEnemy("${type}", 640, 360);
          victim.hp = 1;
          victim.hasEnteredArena = true;
          enemies.push(victim);
          killEnemy(0);
          return {
            burst: particles.filter(p => !p.ring).length,
            rings: particles.filter(p => p.ring).length,
            shake: screenShake
          };
        `);
      };

      const boss = burstFor("boss");
      const normal = burstFor("normal");

      assert.ok(
        boss.burst > normal.burst * 2,
        `A boss kill must produce a dramatically bigger explosion than a normal kill ` +
          `(boss=${boss.burst}, normal=${normal.burst})`
      );
      assert.ok(
        boss.burst >= 60,
        `Per R5.5 a boss kill needs a large explosion (>=60 particles), got ${boss.burst}`
      );
      assert.ok(boss.rings >= 1, "A boss kill must emit at least one shockwave ring");
      assert.ok(
        boss.shake > normal.shake,
        `A boss kill must shake harder (boss=${boss.shake}, normal=${normal.shake})`
      );
    });

    await t1.test("Client declares a slow-mo timer AND a boss kill arms it", () => {
      const binding = findBinding(SLOW_MO_NAMES);
      assert.ok(
        binding,
        `No slow-mo timer declared in the client. Looked for: ${SLOW_MO_NAMES.join(", ")}`
      );

      client.resetCombat();
      const armed = client.evaluate(`
        enemies.length = 0;
        experienceCrystals.length = 0;
        const boss = createEnemy("boss", 640, 360);
        boss.hp = 1;
        boss.hasEnteredArena = true;
        enemies.push(boss);
        killEnemy(0);
        return ${binding};
      `);

      assert.ok(
        typeof armed === "number" && armed > 0,
        `A boss kill must arm ${binding} (> 0), got ${JSON.stringify(armed)}`
      );
      assert.ok(
        Math.abs(armed - 0.3) < 0.12,
        `Per R5.5 the slow-mo hold should be ~0.3s, got ${armed}s`
      );
    });

    await t1.test("The simulation actually runs slower after a boss kill, then recovers", () => {
      client.resetCombat();
      const baseline = measureSimulationDeltas(3);
      const normalDelta = baseline[baseline.length - 1];

      assert.ok(normalDelta > 0, "Baseline simulation speed must be positive");

      client.resetCombat();
      // Frames are sampled well past any ~40ms hit stop so this measures slow-mo,
      // not the freeze: 25 frames at 16ms spans 400ms.
      const deltas = measureSimulationDeltas(25, {
        setup: `
          enemies.length = 0;
          experienceCrystals.length = 0;
          const boss = createEnemy("boss", 640, 360);
          boss.hp = 1;
          boss.hasEnteredArena = true;
          enemies.push(boss);
          killEnemy(0);
        `
      });

      const slowed = deltas.filter(delta => delta > 0 && delta < normalDelta * 0.75);
      assert.ok(
        slowed.length >= 3,
        `A boss kill must slow the simulation for ~0.3s (expected several frames ` +
          `below ${(normalDelta * 0.75).toFixed(3)}). Deltas: [${deltas.join(", ")}]`
      );

      const tail = deltas[deltas.length - 1];
      assert.ok(
        Math.abs(tail - normalDelta) < normalDelta * 0.2,
        `Speed must return to normal (~${normalDelta}) after the slow-mo window, got ${tail}`
      );
    });

    await t1.test("A normal enemy kill does NOT trigger slow-mo", () => {
      const binding = findBinding(SLOW_MO_NAMES);
      assert.ok(binding, "Slow-mo timer must exist");

      client.resetCombat();
      const armed = client.evaluate(`
        enemies.length = 0;
        experienceCrystals.length = 0;
        const victim = createEnemy("normal", 640, 360);
        victim.hp = 1;
        victim.hasEnteredArena = true;
        enemies.push(victim);
        killEnemy(0);
        return ${binding};
      `);

      assert.equal(
        armed,
        0,
        `Only boss kills may trigger slow-mo; a normal kill set ${binding} to ${armed}`
      );
    });
  });

  // =========================================================================
  // TIER 2: BOUNDARY & ADVERSARIAL EDGE CONDITIONS (against the real client)
  // =========================================================================

  await t.test("Tier 2: Boundary & edge conditions on the real client", async (t2) => {
    await t2.test("gameLoop clamps huge frame gaps to 0.033s and ignores backwards time", () => {
      client.resetCombat();
      const result = client.evaluate(`
        gameState = "playing";
        coopSession.active = false;
        enemies.length = 0;
        bullets.length = 0;
        particles.length = 0;
        stats.homing = 0;
        const bullet = {
          state: "flying",
          x: 300, y: 360,
          vx: 1000, vy: 0,
          r: 7, age: 0,
          bouncesLeft: 99999,
          hitsLeft: 1,
          hitEnemies: new Set(),
          hitCooldowns: new Map()
        };
        bullets.push(bullet);

        lastTime = 0;
        const start = bullet.x;
        gameLoop(5000);                       // 5-second stall
        const jumpDelta = bullet.x - start;

        const beforeBackwards = bullet.x;
        lastTime = 10000;
        gameLoop(9000);                       // clock went backwards
        const backwardsDelta = bullet.x - beforeBackwards;

        return { jumpDelta, backwardsDelta, err: lastGameError };
      `);

      assert.equal(result.err, "", "Extreme frame deltas must not throw");
      assert.ok(
        result.jumpDelta <= 1000 * 0.033 + 1e-6,
        `A 5s stall must be clamped to <= 0.033s of motion (33px at 1000px/s), ` +
          `got ${result.jumpDelta}`
      );
      assert.equal(
        result.backwardsDelta,
        0,
        `Backwards time must produce zero motion, got ${result.backwardsDelta}`
      );
    });

    await t2.test("NaN frame timestamps do not corrupt real entity positions", () => {
      client.resetCombat();
      const result = client.evaluate(`
        gameState = "playing";
        coopSession.active = false;
        enemies.length = 0;
        bullets.length = 0;
        particles.length = 0;
        stats.homing = 0;
        const bullet = {
          state: "flying",
          x: 300, y: 360,
          vx: 400, vy: 0,
          r: 7, age: 0,
          bouncesLeft: 99999,
          hitsLeft: 1,
          hitEnemies: new Set(),
          hitCooldowns: new Map()
        };
        bullets.push(bullet);
        lastTime = 1000;
        gameLoop(NaN);
        return {
          x: bullet.x,
          y: bullet.y,
          finite: Number.isFinite(bullet.x) && Number.isFinite(bullet.y),
          err: lastGameError
        };
      `);

      assert.ok(
        result.finite,
        `A NaN timestamp must not poison entity coordinates ` +
          `(x=${result.x}, y=${result.y}). gameLoop should guard its dt.`
      );
    });

    await t2.test("Extreme damage values produce a renderable damage number", () => {
      const binding = findBinding(DAMAGE_NUMBER_NAMES);
      assert.ok(binding, "Damage-number collection must exist");

      client.resetCombat({ critChance: 0, damage: 1 });
      const result = client.evaluate(`
        const observed = [];
        for (const dmg of [0.25, 1, 9999.8]) {
          ${binding}.length = 0;
          enemies.length = 0;
          stats.damage = dmg;
          const target = createEnemy("tank", 640, 360);
          target.hp = 1e9;
          target.hasEnteredArena = true;
          enemies.push(target);
          applyBulletHit(0);
          observed.push(${binding}.map(n => ({ ...n })));
        }
        return observed;
      `);

      for (const [index, entries] of result.entries()) {
        assert.ok(entries.length > 0, `Damage case ${index} must produce a damage number`);
        const text = String(entries[0].text ?? entries[0].value ?? entries[0].amount ?? "");
        assert.ok(
          text.length > 0 && !/NaN|undefined|Infinity/.test(text),
          `Damage number text must be clean, got "${text}"`
        );
      }
    });

    await t2.test("The real particles array stays bounded under sustained combat", () => {
      client.resetCombat({ critChance: 1, damage: 1 });
      const result = client.evaluate(`
        particles.length = 0;
        enemies.length = 0;
        bullets.length = 0;
        experienceCrystals.length = 0;
        stats.homing = 0;

        const target = createEnemy("tank", 640, 360);
        target.hp = 1e9;
        target.hasEnteredArena = true;
        enemies.push(target);

        bullets.push({
          state: "flying",
          x: 200, y: 360,
          vx: 500, vy: 0,
          r: 7, age: 0,
          bouncesLeft: 999999,
          hitsLeft: 1,
          hitEnemies: new Set(),
          hitCooldowns: new Map()
        });

        lastTime = 0;
        let peak = 0;
        for (let frame = 1; frame <= 900; frame++) {
          if (frame % 5 === 0) applyBulletHit(0);
          gameLoop(frame * 16);
          peak = Math.max(peak, particles.length);
        }
        return { peak, final: particles.length, err: lastGameError };
      `);

      assert.equal(result.err, "", "900 frames of combat must not throw");
      assert.ok(
        result.peak < 5000,
        `Particles must expire rather than grow without bound; peak was ${result.peak}`
      );
    });

    await t2.test("Visual state does not leak across run boundaries", () => {
      const hitStop = findBinding(HIT_STOP_NAMES);
      const slowMo = findBinding(SLOW_MO_NAMES);
      const damage = findBinding(DAMAGE_NUMBER_NAMES);

      assert.ok(hitStop && slowMo && damage, "R5 visual state bindings must exist");

      // Starting a new run and returning to the menu are the real boundaries a
      // frozen/slowed frame must not survive, otherwise the next run (or the
      // menu's background scene) would start mid-freeze.
      for (const boundary of ["restartGame", "showMainMenu"]) {
        assert.equal(
          typeof client.readBinding(boundary),
          "function",
          `Client must expose ${boundary} as a run boundary`
        );

        client.resetCombat();
        const result = client.evaluate(`
          enemies.length = 0;
          experienceCrystals.length = 0;
          const boss = createEnemy("boss", 640, 360);
          boss.hp = 1;
          boss.hasEnteredArena = true;
          enemies.push(boss);
          killEnemy(0);

          const armed = { hitStop: ${hitStop}, slowMo: ${slowMo} };
          ${boundary}();
          return {
            armed,
            after: {
              hitStop: ${hitStop},
              slowMo: ${slowMo},
              damageNumbers: ${damage}.length,
              particles: particles.length
            }
          };
        `);

        assert.ok(
          result.armed.hitStop > 0 && result.armed.slowMo > 0,
          `A boss kill must arm the visual timers before ${boundary} clears them`
        );
        assert.equal(
          result.after.hitStop,
          0,
          `${boundary} must clear the hit-stop timer`
        );
        assert.equal(
          result.after.slowMo,
          0,
          `${boundary} must clear the slow-mo timer`
        );
        assert.equal(
          result.after.damageNumbers,
          0,
          `${boundary} must clear pending damage numbers`
        );
        assert.equal(
          result.after.particles,
          0,
          `${boundary} must clear particles`
        );
      }
    });
  });

  // =========================================================================
  // TIER 3: CROSS-FEATURE INTEGRATION ON THE REAL CLIENT
  // =========================================================================

  await t.test("Tier 3: Cross-feature integration", async (t3) => {
    await t3.test("Solo and coop both expose complete particle pipelines", () => {
      for (const name of [
        "createParticles",
        "createRing",
        "updateParticles",
        "createCoopParticles",
        "createCoopRing",
        "updateCoopParticles"
      ]) {
        assert.equal(
          typeof client.readBinding(name),
          "function",
          `Client must expose ${name}`
        );
      }
    });

    await t3.test("Damage numbers report the real damage the client computed", () => {
      const binding = findBinding(DAMAGE_NUMBER_NAMES);
      assert.ok(binding, "Damage-number collection must exist");

      client.resetCombat({ critChance: 1, damage: 4 });
      const result = client.evaluate(`
        ${binding}.length = 0;
        enemies.length = 0;
        const target = createEnemy("tank", 640, 360);
        target.hp = 1e9;
        target.hasEnteredArena = true;
        enemies.push(target);
        const hpBefore = target.hp;
        applyBulletHit(0);
        return {
          dealt: hpBefore - target.hp,
          entries: ${binding}.map(n => ({ ...n }))
        };
      `);

      assert.ok(result.entries.length > 0, "A crit must produce a damage number");

      const shown = Number(
        String(result.entries[0].text ?? result.entries[0].value ?? result.entries[0].amount)
      );

      assert.ok(
        Number.isFinite(shown),
        `Damage number must carry a numeric value, got ${JSON.stringify(result.entries[0])}`
      );
      assert.equal(
        shown,
        Math.round(result.dealt),
        `The displayed damage (${shown}) must match the damage actually dealt ` +
          `(${result.dealt}) — a 2.5x crit on 4 base damage`
      );
    });

    await t3.test("Crit visuals and the crit damage multiplier agree (2.5x)", () => {
      const dealtFor = (critChance) => {
        client.resetCombat({ critChance, damage: 4 });
        return client.evaluate(`
          enemies.length = 0;
          particles.length = 0;
          const target = createEnemy("tank", 640, 360);
          target.hp = 1e9;
          target.hasEnteredArena = true;
          enemies.push(target);
          const before = target.hp;
          applyBulletHit(0);
          return {
            dealt: before - target.hp,
            particles: particles.filter(p => !p.ring).length
          };
        `);
      };

      const normal = dealtFor(0);
      const crit = dealtFor(1);

      assert.equal(
        crit.dealt / normal.dealt,
        2.5,
        `Crit multiplier must be 2.5x (normal=${normal.dealt}, crit=${crit.dealt})`
      );
      assert.ok(
        crit.particles > normal.particles,
        `Crits must be visually louder than normal hits ` +
          `(crit=${crit.particles}, normal=${normal.particles} particles)`
      );
    });
  });

  // =========================================================================
  // TIER 4: FULL PIPELINE — one continuous run through the real gameLoop
  // =========================================================================

  await t.test("Tier 4: Full visual pipeline over a real boss fight", () => {
    const hitStop = findBinding(HIT_STOP_NAMES);
    const slowMo = findBinding(SLOW_MO_NAMES);
    const damage = findBinding(DAMAGE_NUMBER_NAMES);

    assert.ok(
      hitStop && slowMo && damage,
      `All R5 bindings must exist (hitStop=${hitStop}, slowMo=${slowMo}, damageNumbers=${damage})`
    );

    client.resetCombat({ critChance: 1, damage: 4 });

    const result = client.evaluate(`
      particles.length = 0;
      enemies.length = 0;
      bullets.length = 0;
      experienceCrystals.length = 0;
      ${damage}.length = 0;
      screenShake = 0;
      stats.homing = 0;

      // A boss that dies to exactly one 2.5x crit (4 * 2.5 = 10).
      const boss = createEnemy("boss", 640, 360);
      boss.hp = 10;
      boss.hasEnteredArena = true;
      enemies.push(boss);

      // A flying bullet whose motion is our simulation clock.
      const bullet = {
        state: "flying",
        x: 200, y: 100,
        vx: 400, vy: 0,
        r: 7, age: 0,
        bouncesLeft: 999999,
        hitsLeft: 1,
        hitEnemies: new Set(),
        hitCooldowns: new Map()
      };
      bullets.push(bullet);

      // 1. Trails: fly for a few frames before the hit.
      lastTime = 0;
      for (let frame = 1; frame <= 4; frame++) gameLoop(frame * 16);
      const trailParticles = particles.filter(p => !p.ring).length;

      // 2. Crit that kills the boss -> damage number, hit stop, celebration, slow-mo.
      applyBulletHit(0);

      const afterHit = {
        bossDead: enemies.length === 0,
        damageNumbers: ${damage}.map(n => ({ ...n })),
        hitStop: ${hitStop},
        slowMo: ${slowMo},
        burst: particles.filter(p => !p.ring).length,
        rings: particles.filter(p => p.ring).length,
        shake: screenShake
      };

      // 3. Freeze then slow-mo then recovery, measured on real bullet motion.
      const positions = [bullet.x];
      for (let frame = 5; frame <= 40; frame++) {
        gameLoop(frame * 16);
        positions.push(bullet.x);
      }
      const deltas = positions
        .slice(1)
        .map((v, i) => Number((v - positions[i]).toFixed(5)));

      // 4. Catch the bullet -> catch wave ring.
      particles.length = 0;
      player.x = 300; player.y = 300;
      stats.catchBlast = 0;
      bullet.state = "flying";
      catchBullet(bullet);
      const catchRings = particles.filter(
        p => p.ring && (p.catchWave || p.isCatchWave || p.wave)
      ).length;

      return { trailParticles, afterHit, deltas, catchRings, err: lastGameError };
    `);

    assert.equal(result.err, "", "The full pipeline must run without throwing");

    // Trails
    assert.ok(
      result.trailParticles > 0,
      "Stage 1: a flying bullet must lay down trail particles"
    );

    // Damage number
    assert.ok(
      result.afterHit.damageNumbers.length > 0,
      "Stage 2: the killing crit must spawn a floating damage number"
    );

    // Boss died and celebrated
    assert.ok(result.afterHit.bossDead, "Stage 2: the boss must die to the 2.5x crit");
    assert.ok(
      result.afterHit.burst >= 60,
      `Stage 2: the boss kill needs a large explosion, got ${result.afterHit.burst} particles`
    );
    assert.ok(
      result.afterHit.rings >= 1,
      "Stage 2: the boss kill must emit a shockwave ring"
    );

    // Hit stop and slow-mo both armed
    assert.ok(
      result.afterHit.hitStop > 0,
      `Stage 2: the boss-killing crit must arm hit stop, got ${result.afterHit.hitStop}`
    );
    assert.ok(
      result.afterHit.slowMo > 0,
      `Stage 2: the boss kill must arm slow-mo, got ${result.afterHit.slowMo}`
    );

    // Freeze -> slow -> normal, observed on real motion
    const frozen = result.deltas.filter(delta => delta === 0).length;
    assert.ok(
      frozen >= 2,
      `Stage 3: the simulation must freeze for the hit stop. Deltas: [${result.deltas.join(", ")}]`
    );

    const normalSpeed = result.deltas[result.deltas.length - 1];
    assert.ok(normalSpeed > 0, "Stage 3: the simulation must recover to full speed");

    const slowedFrames = result.deltas.filter(
      delta => delta > 0 && delta < normalSpeed * 0.75
    ).length;
    assert.ok(
      slowedFrames >= 3,
      `Stage 3: slow-mo must visibly reduce simulation speed after the freeze. ` +
        `Deltas: [${result.deltas.join(", ")}]`
    );

    // Catch wave
    assert.ok(
      result.catchRings >= 1,
      "Stage 4: catching the bullet must emit the intercept catch wave"
    );
  });
});



