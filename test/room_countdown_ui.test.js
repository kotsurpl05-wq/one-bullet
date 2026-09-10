const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("Room resume countdown is a number-only, non-modal overlay", () => {
  const html = fs.readFileSync(
    path.resolve(__dirname, "../public/index.html"),
    "utf8"
  );

  const start = html.indexOf("function renderRoomUnpauseUI");
  const end = html.indexOf("function renderRoomReconnectUI", start);
  const renderer = html.slice(start, end);
  const reconnectStart = end;
  const reconnectEnd = html.indexOf("if (reconnectState && reconnectState.syncing)", reconnectStart);
  const reconnectCountdown = html.slice(reconnectStart, reconnectEnd);

  assert.ok(renderer.includes('class="room-countdown-number"'));
  assert.ok(renderer.includes('overlay.classList.add("room-countdown-mode")'));
  assert.doesNotMatch(renderer, /Бой возобновится|Приготовьтесь|room-reconnect-screen/);
  assert.ok(reconnectCountdown.includes("renderRoomUnpauseUI(count)"));
  assert.doesNotMatch(reconnectCountdown, /НАПАРНИК ПОДКЛЮЧИЛСЯ|БОЙ НАЧНЁТСЯ|room-reconnect-screen/);

  assert.match(
    html,
    /#overlay\.room-countdown-mode\s*\{[\s\S]*?background:\s*transparent\s*!important;[\s\S]*?pointer-events:\s*none;/
  );
  assert.match(
    html,
    /#overlay\.room-countdown-mode #panel\s*\{[\s\S]*?background:\s*transparent\s*!important;[\s\S]*?border:\s*0\s*!important;/
  );
});
