// shared/math.js — pure math helpers used by both server and client

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function random(min, max) {
  return min + Math.random() * (max - min);
}

function distance(ax, ay, bx, by) {
  return Math.hypot(ax - bx, ay - by);
}

function distToSegmentSquared(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const l2 = dx * dx + dy * dy;
  if (l2 === 0) return (px - x1) * (px - x1) + (py - y1) * (py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  const projX = x1 + t * dx;
  const projY = y1 + t * dy;
  const ex = px - projX;
  const ey = py - projY;
  return ex * ex + ey * ey;
}

function distToSegment(px, py, x1, y1, x2, y2) {
  return Math.sqrt(distToSegmentSquared(px, py, x1, y1, x2, y2));
}

module.exports = { clamp, random, distance, distToSegmentSquared, distToSegment };
