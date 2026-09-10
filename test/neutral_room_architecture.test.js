"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("active gameplay uses one neutral room architecture", async (t) => {
  const server = read("server.js");
  const client = read("public/index.html");
  const transport = read("public/network.js");
  const sharedIndex = read("shared/index.js");

  await t.test("server API and snapshots use room terminology", () => {
    assert.match(server, /function createRoomWorld\(room\)/);
    assert.match(server, /function updateServerRoomWorld\(/);
    assert.match(server, /function createServerRoomSnapshot\(room, options\)/);
    assert.match(server, /type: "room-server-v1"/);
    assert.doesNotMatch(server, /\bCOOP_|createCoopWorld|createServerCoopSnapshot|updateServerCoopWorld/);
  });

  await t.test("client has room entry points and no local game launcher", () => {
    assert.match(client, /const roomSession = \{/);
    assert.match(client, /function startRoomMovementSession\(\)/);
    assert.match(client, /function applyRoomSnapshot\(snapshot\)/);
    assert.match(client, /snapshot\.type !== "room-server-v1"/);
    assert.doesNotMatch(client, /function showSoloMenu\(|function startTraining\(|function restartGame\(/);
    assert.doesNotMatch(client, /\bCOOP_|\bSOLO_|createCoopWorld|coopSession/);
  });

  await t.test("transport accepts only the canonical net event family", () => {
    assert.match(transport, /"net:upgrade-offers"/);
    assert.match(transport, /"net:game-event"/);
    assert.doesNotMatch(transport, /"room:(?:upgrade|game-event)/);
  });

  await t.test("room balance has one shared entry point", () => {
    assert.match(sharedIndex, /require\("\.\/room-balance"\)/);
    assert.ok(fs.existsSync(path.join(root, "shared/room-balance.js")));
    assert.equal(fs.existsSync(path.join(root, "shared/run-balance.js")), false);
  });
});
