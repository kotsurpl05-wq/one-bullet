// shared/mirage.js — mirage enemy invisibility cycle, shared by server and client.
//
// Мираж прячется на 6 секунд (невидим и неуязвим для самонаведения),
// затем появляется ровно на 1 секунду, после чего снова прячется.

const MIRAGE_INVISIBLE_DURATION = 6;
const MIRAGE_VISIBLE_DURATION = 1;
const MIRAGE_CYCLE_DURATION = MIRAGE_INVISIBLE_DURATION + MIRAGE_VISIBLE_DURATION;

/**
 * @param {number} nowSeconds — текущее время (та же временная база, что и spawnTimeSeconds).
 * @param {number} spawnTimeSeconds — момент появления миража, задающий фазу цикла.
 * @returns {{ visible: boolean, alpha: number }}
 */
function getMirageVisibility(nowSeconds, spawnTimeSeconds) {
  const elapsed = nowSeconds - (spawnTimeSeconds || 0);
  const phase = ((elapsed % MIRAGE_CYCLE_DURATION) + MIRAGE_CYCLE_DURATION) % MIRAGE_CYCLE_DURATION;

  if (phase < MIRAGE_INVISIBLE_DURATION) {
    return { visible: false, alpha: 0 };
  }

  const visiblePhase = (phase - MIRAGE_INVISIBLE_DURATION) / MIRAGE_VISIBLE_DURATION;
  return { visible: true, alpha: Math.sin(visiblePhase * Math.PI) };
}

module.exports = {
  MIRAGE_INVISIBLE_DURATION,
  MIRAGE_VISIBLE_DURATION,
  MIRAGE_CYCLE_DURATION,
  getMirageVisibility
};
