const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("Co-op resume countdown is a number-only, non-modal overlay", () => {
  const html = fs.readFileSync(
    path.resolve(__dirname, "../public/index.html"),
    "utf8"
  );

  const start = html.indexOf("function renderCoopUnpauseUI");
  const end = html.indexOf("function renderCoopReconnectUI", start);
  const renderer = html.slice(start, end);
  const reconnectStart = end;
  const reconnectEnd = html.indexOf("if (reconnectState && reconnectState.syncing)", reconnectStart);
  const reconnectCountdown = html.slice(reconnectStart, reconnectEnd);

  assert.ok(renderer.includes('class="coop-countdown-number"'));
  assert.ok(renderer.includes('overlay.classList.add("coop-countdown-mode")'));
  assert.doesNotMatch(renderer, /Бой возобновится|Приготовьтесь|coop-reconnect-screen/);
  assert.ok(reconnectCountdown.includes("renderCoopUnpauseUI(count)"));
  assert.doesNotMatch(reconnectCountdown, /НАПАРНИК ПОДКЛЮЧИЛСЯ|БОЙ НАЧНЁТСЯ|coop-reconnect-screen/);

  assert.match(
    html,
    /#overlay\.coop-countdown-mode\s*\{[\s\S]*?background:\s*transparent\s*!important;[\s\S]*?pointer-events:\s*none;/
  );
  assert.match(
    html,
    /#overlay\.coop-countdown-mode #panel\s*\{[\s\S]*?background:\s*transparent\s*!important;[\s\S]*?border:\s*0\s*!important;/
  );
});
