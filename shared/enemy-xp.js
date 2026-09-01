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
    case "mirage":     return 140;
    case "sentinel":   return 265;
    default:           return 125;
  }
}

function getContactDamage(wave, enemy) {
  if (enemy.type === "boss") return wave >= 15 ? 227 : 118;

  switch (enemy.type) {
    case "runner":     return 61;
    case "tank":        return 233;
    case "charger":     return enemy.isCharging ? 214 : 92;
    case "splitter":    return 104;
    case "shard":       return 58;
    case "shooter":     return 79;
    case "phantom":     return 96;
    case "magnetizer":  return 111;
    case "twin":        return 73;
    case "incubator":   return 158;
    case "minion":      return 52;
    case "sentinel":    return 142;
    case "mirage":      return 65;
    default:            return 92;
  }
}

module.exports = { getEnemyExperience, getContactDamage };
