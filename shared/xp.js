// shared/xp.js — experience curve

function getExperienceRequirement(level) {
  const progression = Math.max(0, level - 1);
  return 775 + progression * 335 + Math.floor(progression / 5) * 410;
}

module.exports = { getExperienceRequirement };
