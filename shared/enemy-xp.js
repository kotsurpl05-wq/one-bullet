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

/*
 * Общий множитель урона врагов по волнам: +2% за волну сверх первой,
 * потолок x2.0 (достигается к волне 51) — чтобы противники со временем
 * били ощутимо больнее, но не превращали поздние волны в мгновенную смерть.
 * Используется и для контактного урона, и для урона вражеских снарядов
 * (соло и кооп), чтобы рост сложности не сводился только к HP и спавну.
 */
function getEnemyDamageMultiplier(wave) {
  const level = Math.max(0, (wave || 1) - 1);
  return Math.min(2.0, 1 + level * 0.02);
}

function getContactDamage(wave, enemy) {
  const mult = getEnemyDamageMultiplier(wave);
  if (enemy.type === "boss") return Math.round((wave >= 15 ? 227 : 118) * mult);

  let base;
  switch (enemy.type) {
    case "runner":     base = 61; break;
    case "tank":        base = 233; break;
    case "charger":     base = enemy.isCharging ? 214 : 92; break;
    case "splitter":    base = 104; break;
    case "shard":       base = 58; break;
    case "shooter":     base = 79; break;
    case "phantom":     base = 96; break;
    case "magnetizer":  base = 111; break;
    case "twin":        base = 73; break;
    case "incubator":   base = 158; break;
    case "minion":      base = 52; break;
    case "sentinel":    base = 142; break;
    case "mirage":      base = 65; break;
    default:            base = 92;
  }
  return Math.round(base * mult);
}

module.exports = { getEnemyExperience, getContactDamage, getEnemyDamageMultiplier };
