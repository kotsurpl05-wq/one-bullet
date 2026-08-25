/*
 * Сквозная проверка кооп-сессии по настоящему WebSocket.
 *
 * Поднимает сервер, соединяет двух игроков через
 * клиентский bundle socket.io, стартует матч и
 * измеряет реальный сетевой трафик снапшотов.
 *
 * Запуск: node test/live_coop_smoke.js
 * (не *.test.js — не входит в `npm test`, требует свободный порт)
 */

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { WebSocket } = require("ws");

const PORT = Number(process.env.SMOKE_PORT) || 3222;
const URL = `http://127.0.0.1:${PORT}`;

function loadSocketIoClient() {
  const bundlePath = path.join(
    __dirname,
    "..",
    "node_modules",
    "socket.io",
    "client-dist",
    "socket.io.js"
  );

  const source = fs.readFileSync(bundlePath, "utf8");

  // Bundle рассчитан на браузер: даём ему минимальный shim.
  const sandbox = {
    WebSocket,
    XMLHttpRequest: undefined,
    document: undefined,
    navigator: { userAgent: "node" },
    location: { protocol: "http:", hostname: "127.0.0.1", port: String(PORT) },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    console
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: "socket.io.js" });

  if (typeof sandbox.io !== "function") {
    throw new Error("socket.io client bundle did not expose io()");
  }

  return sandbox.io;
}

function connect(io, label) {
  return new Promise((resolve, reject) => {
    const socket = io(URL, {
      transports: ["websocket"],
      forceNew: true,
      reconnection: false
    });

    const timer = setTimeout(
      () => reject(new Error(`${label}: connect timeout`)),
      8000
    );

    socket.on("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });

    socket.on("connect_error", err => {
      clearTimeout(timer);
      reject(new Error(`${label}: ${err.message}`));
    });
  });
}

function emitAck(socket, event, payload, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label}: ack timeout`)),
      8000
    );

    socket.emit(event, payload, response => {
      clearTimeout(timer);
      resolve(response);
    });
  });
}

async function main() {
  process.env.PORT = String(PORT);
  require("../server.js");
  await new Promise(r => setTimeout(r, 800));

  const io = loadSocketIoClient();

  const host = await connect(io, "host");
  const created = await emitAck(host, "room:create", { name: "Host" }, "room:create");

  if (!created?.success) {
    throw new Error(`room:create failed: ${JSON.stringify(created)}`);
  }

  const code = created.room.code;
  console.log("room created        :", code);

  const guest = await connect(io, "guest");
  const joined = await emitAck(guest, "room:join", { code, name: "Guest" }, "room:join");

  if (!joined?.success) {
    throw new Error(`room:join failed: ${JSON.stringify(joined)}`);
  }
  console.log("guest joined as     :", joined.role);

  const stats = { count: 0, bytes: 0, first: null, last: null };

  guest.on("net:snapshot", snapshot => {
    stats.count++;
    stats.bytes += Buffer.byteLength(JSON.stringify(snapshot));
    if (!stats.first) stats.first = snapshot;
    stats.last = snapshot;
  });

  await emitAck(host, "room:ready", { ready: true }, "host ready");
  await emitAck(guest, "room:ready", { ready: true }, "guest ready");
  console.log("both ready, waiting for countdown + wave...");

  await new Promise(r => setTimeout(r, 10000));

  console.log("");
  console.log("snapshots received  :", stats.count);

  if (!stats.count) {
    throw new Error("no snapshots received — match never started");
  }

  const avg = Math.round(stats.bytes / stats.count);
  console.log("avg raw bytes/snap  :", avg);

  const firstEnemy = stats.first.enemies?.[0];
  const lastEnemy = stats.last.enemies?.[0];

  console.log("first snap enemy    :", JSON.stringify(firstEnemy));
  console.log("last  snap enemy    :", JSON.stringify(lastEnemy));

  const checks = [];

  checks.push([
    "first snapshot carries static fields",
    Boolean(firstEnemy && "color" in firstEnemy && "type" in firstEnemy)
  ]);

  const lateEnemies = stats.last.enemies || [];
  const anyStaticRepeated = lateEnemies.some(
    e => "color" in e || "maxHp" in e
  );
  checks.push([
    "later snapshots drop static fields",
    lateEnemies.length > 0 && !anyStaticRepeated
  ]);

  const deadFields = [
    "dashState", "dashTimer", "sniperState",
    "sniperTargetX", "sniperTargetY", "shieldActive", "phase"
  ];
  const anyDead = lateEnemies.some(e => deadFields.some(f => f in e));
  checks.push(["no client-ignored fields on the wire", !anyDead]);

  checks.push([
    "players synchronized",
    Array.isArray(stats.last.players) && stats.last.players.length === 2
  ]);

  console.log("");
  let failed = 0;
  for (const [label, ok] of checks) {
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
    if (!ok) failed++;
  }

  host.disconnect();
  guest.disconnect();

  console.log("");
  if (failed) {
    console.log(`${failed} check(s) failed`);
    process.exit(1);
  }
  console.log("all checks passed");
  process.exit(0);
}

main().catch(err => {
  console.error("SMOKE FAILED:", err.message);
  process.exit(1);
});
