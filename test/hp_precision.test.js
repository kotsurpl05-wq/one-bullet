const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const html = fs.readFileSync(
  path.resolve(__dirname, "../public/index.html"),
  "utf8"
);

function extractSection(startMarker, endMarker) {
  const start = html.indexOf(startMarker);
  const end = html.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `${startMarker} must exist before ${endMarker}`);
  return html.slice(start, end).trim();
}

test("player HP is normalized to an integer after fractional boss damage", () => {
  const source = extractSection("function normalizeHealth", "function random");
  const context = vm.createContext({ Math, Number, Infinity });
  vm.runInContext(`${source}; this.normalizeHealth = normalizeHealth;`, context);

  assert.equal(context.normalizeHealth(345.00000000013212, 500), 345);
  assert.equal(context.normalizeHealth(499.6, 500), 500);
  assert.equal(context.normalizeHealth(-0.00000001, 500), 0);
  assert.equal(context.normalizeHealth(Number.NaN, 500), 0);

  const damagePlayer = extractSection("function damagePlayer", "const MAX_PARTICLES");
  assert.match(
    damagePlayer,
    /player\.hp\s*=\s*normalizeHealth\(\s*player\.hp\s*-\s*actualDamage,\s*player\.maxHp\s*\)/
  );
});
