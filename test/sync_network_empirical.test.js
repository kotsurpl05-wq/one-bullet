import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const indexHtmlPath = path.resolve(process.cwd(), "public/index.html");
const indexHtmlContent = fs.readFileSync(indexHtmlPath, "utf-8");

const networkJsPath = path.resolve(process.cwd(), "public/network.js");
const networkJsContent = fs.readFileSync(networkJsPath, "utf-8");

// Exact reconciliation algorithm from public/index.html
function reconcilePlayerPosition(player, dt) {
  if (
    Number.isFinite(player.serverX) &&
    Number.isFinite(player.serverY)
  ) {
    const desyncDist = Math.hypot(
      player.serverX - player.x,
      player.serverY - player.y
    );
    if (desyncDist > 30) {
      if (desyncDist > 200) {
        player.x = player.serverX;
        player.y = player.serverY;
      } else {
        const lerpFactor = Math.min(1, dt * 10.0);
        player.x +=
          (player.serverX - player.x) * lerpFactor;
        player.y +=
          (player.serverY - player.y) * lerpFactor;
      }
    }
  }
}

// Input timer logic matching public/index.html lines 8386-8397
const COOP_INPUT_INTERVAL = 1 / 60;

function simulateInputTimerStep(session, dt, onEmit) {
  session.inputTimer += dt;
  if (session.inputTimer >= COOP_INPUT_INTERVAL) {
    session.inputTimer = Math.max(
      0,
      session.inputTimer - COOP_INPUT_INTERVAL
    );
    if (onEmit) onEmit();
  }
}

// Comparison buggy version (= 0 instead of -= interval)
function simulateBuggyInputTimerStep(session, dt, onEmit) {
  session.inputTimer += dt;
  if (session.inputTimer >= COOP_INPUT_INTERVAL) {
    session.inputTimer = 0;
    if (onEmit) onEmit();
  }
}

// Helper to instantiate NetworkManager in sandboxed VM
function createNetworkInstance() {
  const emittedEvents = [];
  const volatileEmits = [];

  const mockSocket = {
    id: "socket-test-123",
    handlers: {},
    on(event, handler) {
      this.handlers[event] = handler;
    },
    emit(event, ...args) {
      emittedEvents.push({ event, args });
      return null;
    },
    volatile: {
      emit(event, ...args) {
        volatileEmits.push({ event, args });
      }
    }
  };

  const sandbox = {
    io: () => mockSocket,
    EventTarget: globalThis.EventTarget,
    CustomEvent: globalThis.CustomEvent,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    window: {},
    console
  };

  vm.createContext(sandbox);
  vm.runInContext(networkJsContent, sandbox);
  const net = sandbox.window.net;

  return { net, mockSocket, emittedEvents, volatileEmits, sandbox };
}

describe("Empirical Stress Suite: Client-Side Sync, Input, and Networking", () => {

  describe("1. Server Reconciliation Under Desync Magnitudes", () => {

    it("verifies index.html contains exact reconciliation lerp and snap thresholds (30px, 200px, dt * 10.0)", () => {
      assert.match(indexHtmlContent, /if\s*\(\s*desyncDist\s*>\s*30\s*\)/);
      assert.match(indexHtmlContent, /if\s*\(\s*desyncDist\s*>\s*200\s*\)/);
      assert.match(indexHtmlContent, /Math\.min\(\s*1\s*,\s*dt\s*\*\s*10\.0\s*\)/);
    });

    it("desync <= 30px (e.g. 0px, 10px, 25px, 30px): does NOT snap or lerp (zero correction)", () => {
      const magnitudes = [0, 10, 25, 30];
      const dt = 1 / 60;

      for (const mag of magnitudes) {
        const player = {
          x: 100,
          y: 200,
          serverX: 100 + mag,
          serverY: 200
        };

        const initialX = player.x;
        const initialY = player.y;

        reconcilePlayerPosition(player, dt);

        assert.equal(
          player.x,
          initialX,
          `Expected player.x to remain ${initialX} for desync magnitude ${mag}px, but got ${player.x}`
        );
        assert.equal(
          player.y,
          initialY,
          `Expected player.y to remain ${initialY} for desync magnitude ${mag}px, but got ${player.y}`
        );
      }
    });

    it("desync > 30px and <= 200px (e.g. 31px, 100px, 150px, 200px): lerps smoothly with factor dt * 10.0", () => {
      const testCases = [31, 100, 150, 200];
      const dt = 1 / 60;
      const lerpFactor = dt * 10.0;

      for (const mag of testCases) {
        const player = {
          x: 100,
          y: 200,
          serverX: 100 + mag,
          serverY: 200
        };

        const expectedNewX = player.x + (player.serverX - player.x) * lerpFactor;

        reconcilePlayerPosition(player, dt);

        assert.ok(
          Math.abs(player.x - expectedNewX) < 1e-6,
          `Expected player.x after 1 frame to be ${expectedNewX}, got ${player.x}`
        );
        assert.notEqual(player.x, player.serverX);
      }
    });

    it("desync > 200px (e.g. 200.01px, 350px, 1000px): snaps immediately to server position", () => {
      const testCases = [200.01, 350, 500, 1000, 5000];
      const dt = 1 / 60;

      for (const mag of testCases) {
        const player = {
          x: 100,
          y: 200,
          serverX: 100 + mag,
          serverY: 200 + mag
        };

        reconcilePlayerPosition(player, dt);

        assert.equal(
          player.x,
          player.serverX,
          `Expected player.x to immediately snap to ${player.serverX} for desync ${mag}px, got ${player.x}`
        );
        assert.equal(
          player.y,
          player.serverY,
          `Expected player.y to immediately snap to ${player.serverY} for desync ${mag}px, got ${player.y}`
        );
      }
    });

    it("convergence time stress test: 30px < desync <= 200px converges to deadzone (<=30px) within <= 500ms", () => {
      const initialDesyncs = [31, 60, 100, 150, 200];
      const frameRates = [30, 60, 120];

      for (const fps of frameRates) {
        const dt = 1 / fps;

        for (const initialDesync of initialDesyncs) {
          const player = {
            x: 0,
            y: 0,
            serverX: initialDesync,
            serverY: 0
          };

          let elapsedTime = 0;
          let frames = 0;
          const maxTime = 1.0;

          while (elapsedTime < maxTime) {
            const currentDesync = Math.hypot(player.serverX - player.x, player.serverY - player.y);
            if (currentDesync <= 30) {
              break;
            }
            reconcilePlayerPosition(player, dt);
            elapsedTime += dt;
            frames++;
          }

          const finalDesync = Math.hypot(player.serverX - player.x, player.serverY - player.y);

          // Convergence must complete in <= 500ms
          assert.ok(
            elapsedTime <= 0.50001,
            `Convergence took ${elapsedTime * 1000}ms at ${fps} FPS for initial desync ${initialDesync}px (expected <= 500ms)`
          );
          assert.ok(
            finalDesync <= 30.0,
            `Final desync was ${finalDesync}px, expected <= 30px`
          );
        }
      }
    });

    it("edge case stress test: non-finite server coordinates do not corrupt player position", () => {
      const nonFiniteCases = [
        { serverX: NaN, serverY: 200 },
        { serverX: 100, serverY: Infinity },
        { serverX: undefined, serverY: null },
        { serverX: -Infinity, serverY: -Infinity }
      ];

      for (const c of nonFiniteCases) {
        const player = {
          x: 150,
          y: 250,
          serverX: c.serverX,
          serverY: c.serverY
        };

        reconcilePlayerPosition(player, 1 / 60);

        assert.equal(player.x, 150);
        assert.equal(player.y, 250);
      }
    });

    it("edge case stress test: massive frame spike (dt = 2.0s) clamps lerpFactor to 1.0 without overshooting", () => {
      const player = {
        x: 100,
        y: 100,
        serverX: 250,
        serverY: 100
      };

      // dt = 2.0s -> dt * 6.0 = 12.0 -> min(1, 12.0) = 1.0
      reconcilePlayerPosition(player, 2.0);

      assert.equal(player.x, 250);
      assert.equal(player.y, 100);
    });
  });

  describe("2. InputTimer Accumulator Under Variable / Irregular Framerate", () => {

    it("verifies index.html uses subtraction (coopSession.inputTimer - COOP_INPUT_INTERVAL)", () => {
      assert.match(
        indexHtmlContent,
        /coopSession\.inputTimer\s*=\s*Math\.max\(\s*0\s*,\s*coopSession\.inputTimer\s*-\s*COOP_INPUT_INTERVAL\s*\)/
      );
    });

    it("verifies index.html gameLoop clamps dt to max 0.033s (protects against lag spike explosion)", () => {
      assert.match(
        indexHtmlContent,
        /const\s+dt\s*=\s*Math\.min\(\s*Math\.max\(\s*\(currentTime\s*-\s*lastTime\)\s*\/\s*1000,\s*0\s*\),\s*0\.033\s*\)/
      );
    });

    it("samples at steady 60 Hz under constant 60 FPS (600 packets in 10s)", () => {
      const session = { inputTimer: 0 };
      let packetCount = 0;
      const durationSeconds = 10;
      const dt = 1 / 60;
      const totalFrames = durationSeconds * 60;

      for (let f = 0; f < totalFrames; f++) {
        simulateInputTimerStep(session, dt, () => packetCount++);
      }

      assert.equal(packetCount, 600);
      assert.ok(session.inputTimer < 1e-9);
    });

    it("samples at steady 60 Hz under constant 120 FPS (600 packets in 10s)", () => {
      const session = { inputTimer: 0 };
      let packetCount = 0;
      const durationSeconds = 10;
      const dt = 1 / 120;
      const totalFrames = durationSeconds * 120;

      for (let f = 0; f < totalFrames; f++) {
        simulateInputTimerStep(session, dt, () => packetCount++);
      }

      assert.equal(packetCount, 600);
      assert.ok(session.inputTimer < 1e-9);
    });

    it("samples at steady 60 Hz rate under constant 144 FPS over 60s (3599-3600 packets, rate 59.98-60.0 Hz)", () => {
      const session = { inputTimer: 0 };
      let packetCount = 0;
      const durationSeconds = 60;
      const dt = 1 / 144;
      const totalFrames = durationSeconds * 144;

      for (let f = 0; f < totalFrames; f++) {
        simulateInputTimerStep(session, dt, () => packetCount++);
      }

      const rate = packetCount / durationSeconds;
      assert.ok(packetCount >= 3599 && packetCount <= 3600, `Expected 3599-3600 packets in 60s, got ${packetCount}`);
      assert.ok(Math.abs(rate - 60.0) < 0.05, `Expected 60 Hz rate, got ${rate} Hz`);
    });

    it("samples at 30 Hz under constant 30 FPS due to 1-packet-per-render-frame clamp", () => {
      const session = { inputTimer: 0 };
      let packetCount = 0;
      const durationSeconds = 10;
      const dt = 1 / 30;
      const totalFrames = durationSeconds * 30;

      for (let f = 0; f < totalFrames; f++) {
        simulateInputTimerStep(session, dt, () => packetCount++);
      }

      // At 30 FPS, exactly 300 packets in 10s
      assert.equal(packetCount, 300);
    });

    it("preserves sampling accuracy under micro-jitter around 60 FPS (55 - 65 FPS)", () => {
      const session = { inputTimer: 0 };
      let packetCount = 0;
      const durationSeconds = 60;
      let elapsedTime = 0;

      // Deterministic jitter pattern
      let toggle = false;
      while (elapsedTime < durationSeconds) {
        const frameDt = toggle ? 0.015 : 0.018333333333333334;
        toggle = !toggle;
        elapsedTime += frameDt;
        simulateInputTimerStep(session, frameDt, () => packetCount++);
      }

      const rate = packetCount / elapsedTime;
      assert.ok(
        Math.abs(rate - 60.0) < 0.05,
        `Expected ~60.0 Hz sampling rate, got ${rate.toFixed(3)} Hz (packetCount: ${packetCount})`
      );
    });

    it("empirically demonstrates superiority of subtraction vs reset-to-zero across 144 FPS and jitter", () => {
      // 1. At 144 FPS over 60 seconds:
      let fixed144 = { inputTimer: 0 }, fixed144Count = 0;
      let buggy144 = { inputTimer: 0 }, buggy144Count = 0;
      const dt144 = 1 / 144;

      for (let f = 0; f < 144 * 60; f++) {
        simulateInputTimerStep(fixed144, dt144, () => fixed144Count++);
        simulateBuggyInputTimerStep(buggy144, dt144, () => buggy144Count++);
      }

      // Buggy timer loses 20% of packets (2880 vs 3599)
      assert.equal(buggy144Count, 2880, "Buggy timer should drop to 48 Hz at 144 FPS");
      assert.equal(fixed144Count, 3599, "Fixed timer maintains 60 Hz at 144 FPS");

      // 2. Under jitter [15ms, 18.33ms]:
      let seed = 42;
      function random() {
        seed = (seed * 1664525 + 1013904223) % 4294967296;
        return seed / 4294967296;
      }

      let fixedJitter = { inputTimer: 0 }, fixedJitterCount = 0;
      let buggyJitter = { inputTimer: 0 }, buggyJitterCount = 0;

      for (let i = 0; i < 600; i++) {
        const jitterDt = 0.015 + random() * (0.018333333333333334 - 0.015);
        simulateInputTimerStep(fixedJitter, jitterDt, () => fixedJitterCount++);
        simulateBuggyInputTimerStep(buggyJitter, jitterDt, () => buggyJitterCount++);
      }

      assert.ok(fixedJitterCount >= 595 && fixedJitterCount <= 605);
      assert.ok(buggyJitterCount < fixedJitterCount - 20);
    });
  });

  describe("3. Network request() Timeout and Error Payload Behavior", () => {

    it("verifies network.js implements request timeout <= 10s (default 6000ms)", () => {
      assert.match(
        networkJsContent,
        /request\(\s*eventName\s*,\s*payload\s*=\s*\{\}\s*,\s*timeoutMs\s*=\s*6000\s*\)/
      );
    });

    it("resolves cleanly with { success: false, message: ... } on timeout when server drops request", async () => {
      const { net } = createNetworkInstance();

      const startTime = Date.now();
      const result = await net.request("test:event", { data: 1 }, 60);
      const elapsed = Date.now() - startTime;

      assert.ok(elapsed >= 50 && elapsed <= 250, `Elapsed time was ${elapsed}ms`);
      assert.equal(result.success, false);
      assert.equal(result.message, "Превышено время ожидания ответа сервера");
    });

    it("resolves cleanly with server response when server acknowledges within timeout", async () => {
      const { net, mockSocket } = createNetworkInstance();

      let ackCallback = null;
      mockSocket.emit = (event, payload, callback) => {
        ackCallback = callback;
      };

      const reqPromise = net.request("room:join", { code: "ABC", name: "Guest" }, 500);

      // Server responds after 10ms
      setTimeout(() => {
        if (ackCallback) {
          ackCallback({ success: true, room: { code: "ABC" }, playerId: "p2" });
        }
      }, 10);

      const result = await reqPromise;
      assert.equal(result.success, true);
      assert.equal(result.room.code, "ABC");
      assert.equal(result.playerId, "p2");
    });

    it("resolves with fallback { success: false, message: 'Сервер не ответил' } if server responds with null/falsy", async () => {
      const { net, mockSocket } = createNetworkInstance();

      mockSocket.emit = (event, payload, callback) => {
        setTimeout(() => callback(null), 10);
      };

      const result = await net.request("room:leave", {}, 500);
      assert.equal(result.success, false);
      assert.equal(result.message, "Сервер не ответил");
    });

    it("prevents duplicate resolution if server responds after timeout has already triggered", async () => {
      const { net, mockSocket } = createNetworkInstance();

      let lateCallback = null;
      mockSocket.emit = (event, payload, callback) => {
        lateCallback = callback;
      };

      const reqPromise = net.request("room:restart", {}, 40);

      const result = await reqPromise;
      assert.equal(result.success, false);
      assert.equal(result.message, "Превышено время ожидания ответа сервера");

      // Server attempts late reply after 60ms
      assert.doesNotThrow(() => {
        if (lateCallback) {
          lateCallback({ success: true });
        }
      });
    });

    it("stress test: handles 50 concurrent requests with mixed timeouts and fast responses", async () => {
      const { net, mockSocket } = createNetworkInstance();

      let counter = 0;
      mockSocket.emit = (event, payload, callback) => {
        const id = counter++;
        if (id % 2 === 0) {
          // Even requests respond in 15ms
          setTimeout(() => callback({ success: true, id }), 15);
        } else {
          // Odd requests drop packet (no response, will timeout at 40ms)
        }
      };

      const promises = [];
      for (let i = 0; i < 50; i++) {
        promises.push(net.request(`test:${i}`, { i }, 40));
      }

      const results = await Promise.all(promises);
      assert.equal(results.length, 50);

      for (let i = 0; i < 50; i++) {
        if (i % 2 === 0) {
          assert.equal(results[i].success, true);
          assert.equal(results[i].id, i);
        } else {
          assert.equal(results[i].success, false);
          assert.equal(results[i].message, "Превышено время ожидания ответа сервера");
        }
      }
    });
  });

  describe("4. Volatile Emit on sendInput", () => {

    it("verifies network.js uses this.socket.volatile.emit for sendInput", () => {
      assert.match(
        networkJsContent,
        /this\.socket\.volatile\.emit\(\s*["']net:input["']\s*,\s*input\s*\)/
      );
    });

    it("does NOT emit if isMultiplayer is false", () => {
      const { net, volatileEmits, emittedEvents } = createNetworkInstance();
      assert.equal(net.isMultiplayer, false);

      net.sendInput({ dx: 1, dy: -1, aimX: 300, aimY: 400 });

      assert.equal(volatileEmits.length, 0);
      assert.equal(emittedEvents.length, 0);
    });

    it("emits volatile 'net:input' with payload when isMultiplayer is true", () => {
      const { net, volatileEmits, emittedEvents } = createNetworkInstance();

      net.room = { code: "1234" };
      net.role = "host";
      assert.equal(net.isMultiplayer, true);

      const inputPayload = { dx: 0.707, dy: -0.707, aimX: 512, aimY: 384 };
      net.sendInput(inputPayload);

      assert.equal(volatileEmits.length, 1);
      assert.equal(volatileEmits[0].event, "net:input");
      assert.deepEqual(volatileEmits[0].args[0], inputPayload);
      assert.equal(emittedEvents.length, 0, "Regular socket.emit should NOT be called for sendInput");
    });
  });

});
