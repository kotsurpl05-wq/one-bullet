// shared/enemy-factory.js — base enemy stats used by both server and client

function createEnemyBase(type, wave) {
  const level = wave - 1;

  switch (type) {
    case "runner":
      return { type, r: 10, speed: 105 + level * 3, hp: 100 + Math.floor(level / 7) * 100, color: "#ffca55" };

    case "tank":
      return { type, r: 21, speed: 39 + level * 1.5, hp: 300 + Math.floor(level / 3) * 100, color: "#b56dff" };

    case "charger":
      return { type, r: 13, speed: 63 + level * 2, hp: 200 + Math.floor(level / 6) * 100, color: "#ff814a" };

    case "splitter":
      return { type, r: 18, speed: 50 + level * 1.7, hp: 200 + Math.floor(level / 4) * 100, color: "#46b8ff" };

    case "shard":
      return { type, r: 8, speed: 125 + level * 2.5, hp: 100 + Math.floor(level / 9) * 100, color: "#79d7ff" };

    case "shooter":
      return { type, r: 14, speed: 48 + level * 1.3, hp: 200 + Math.floor(level / 6) * 100, color: "#50d890" };

    case "phantom":
      return { type, r: 12, speed: 75 + wave * 2, hp: 100 + Math.floor(wave / 8) * 100, color: "#88eedd" };

    case "magnetizer":
      return { type, r: 16, speed: 40 + wave * 1.2, hp: 500 + Math.floor(wave / 3) * 100, color: "#c084fc" };

    case "twin":
      return { type, r: 10, speed: 90 + wave * 2, hp: 200 + Math.floor(wave / 5) * 100, color: "#ff6b9d" };

    case "incubator":
      return { type, r: 22, speed: 32 + level * 1.0, hp: 600 + Math.floor(wave / 2) * 100, color: "#059669" };

    case "minion":
      return { type, r: 7, speed: 135 + level * 3.0, hp: 100, color: "#34d399" };

    case "boss_drone":
    case "boss_pylon":
      return { type: "boss_drone", r: 24, speed: 0, hp: 2500, color: "#00f2fe" };

    case "boss": {
      const bossTier = Math.max(1, Math.floor(wave / 5));
      const progressionTier = bossTier - 1;
      return {
        type, r: 46,
        speed: 38 + progressionTier * 2.2 * 1.3,
        hp: 4800 + bossTier * 2000 + bossTier * bossTier * 800,
        color: "#ff3f8f",
        bossTier,
        // Boss AI init (identical on server and client):
        shootCooldown: 1.4,
        radialCooldown: 3.6,
        dashState: "none", dashCooldown: 3.5, dashTimer: 0, dashDx: 0, dashDy: 0,
        sniperState: "none", sniperCooldown: 4.5, sniperTimer: 0, sniperTargetX: 0, sniperTargetY: 0,
        spiralActive: false, spiralCooldown: 6.0, spiralTimer: 0, spiralTicks: 0, spiralBaseAngle: 0,
        shieldActive: false, shieldTriggered: false, stunTimer: 0
      };
    }

    default: // normal
      return { type: "normal", r: 14, speed: 59 + level * 2.5, hp: 100 + Math.floor(level / 5) * 100, color: "#ff5577" };
  }
}

module.exports = { createEnemyBase };
