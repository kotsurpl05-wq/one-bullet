// shared/enemy-xp.js — enemy experience and contact damage values

function getEnemyExperience(enemy) {
  if (enemy.type === "boss") {
    const bossTier = Math.max(1, enemy.bossTier || 1);
    return 1050 + bossTier * 275;
  }

  switch (enemy.type) {
    case "tank":       return 275;
    case "charger":    return 240;
    case "splitter":   return 310;
    case "shooter":    return 255;
    case "incubator":  return 475;
    case "phantom":    return 185;
    case "magnetizer": return 195;
    case "twin":       return 165;
    case "runner":     return 115;
    default:           return 125;
  }
}

function getContactDamage(wave, enemy) {
  if (enemy.type === "tank") return 200;
  if (enemy.type === "charger" && enemy.isCharging) return 200;
  if (enemy.type === "boss") return wave >= 15 ? 200 : 100;
  return 100;
}

module.exports = { getEnemyExperience, getContactDamage };
