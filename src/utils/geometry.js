// Pure geometry / unit helpers. No app state, no DOM (per CLAUDE.md src/utils rules).

/** True only for a real, finite JS number (rejects NaN, Infinity, non-numbers). */
export function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Throw a TypeError unless `value` is a finite number (isFiniteNumber). The
 * message names who is checking and which field:
 * "<owner>: <field> must be a finite number, got <value>".
 */
export function assertFiniteNumber(owner, field, value) {
  if (!isFiniteNumber(value)) {
    throw new TypeError(`${owner}: ${field} must be a finite number, got ${value}`);
  }
}

/**
 * Snap a continuous value to the nearest multiple of `step`.
 * A non-positive step returns the value unchanged (snapping disabled).
 * Coordinates stay continuous floats — this is a placement aid only (FR-3).
 */
export function snap(value, step) {
  if (!(step > 0)) return value;
  return Math.round(value / step) * step;
}

/** Snap a point to a square grid of the given cell size. Returns a new {x, y}. */
export function snapPoint(x, y, step) {
  return { x: snap(x, step), y: snap(y, step) };
}

/** Round to `decimals` decimal places, for display (2 -> centimeters). */
export function roundTo(v, decimals = 2) {
  const k = 10 ** decimals;
  return Math.round(v * k) / k;
}

/** Clamp `v` into the inclusive range [min, max]. */
export function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

/** The point of segment [(ax,ay), (bx,by)] closest to (px, py). Returns a new {x, y}. */
export function closestPointOnSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  const t = lenSq > 0 ? clamp(((px - ax) * dx + (py - ay) * dy) / lenSq, 0, 1) : 0;
  return { x: ax + t * dx, y: ay + t * dy };
}

/** Shortest distance from point (px, py) to the segment [(ax,ay), (bx,by)]. */
export function distanceToSegment(px, py, ax, ay, bx, by) {
  const c = closestPointOnSegment(px, py, ax, ay, bx, by);
  return Math.hypot(px - c.x, py - c.y);
}

/**
 * The point where segments (a1,a2) and (b1,b2) cross, if it lies within
 * both segments (endpoints inclusive). Returns null for parallel/collinear
 * segments (degenerate - not resolved here) or segments that don't meet
 * within both of their extents.
 */
export function segmentsIntersect(a1, a2, b1, b2) {
  const d1x = a2.x - a1.x;
  const d1y = a2.y - a1.y;
  const d2x = b2.x - b1.x;
  const d2y = b2.y - b1.y;
  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < 1e-9) return null;

  const t = ((b1.x - a1.x) * d2y - (b1.y - a1.y) * d2x) / denom;
  const u = ((b1.x - a1.x) * d1y - (b1.y - a1.y) * d1x) / denom;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;

  return { x: a1.x + t * d1x, y: a1.y + t * d1y };
}

/**
 * The 4 corners of a rectangle of size `width` x `depth`, centered on
 * (cx, cy) and rotated `rotationDeg` degrees about that center. `width`
 * runs along the rotated local x axis. Corners are in winding order.
 */
export function rotatedRectCorners(cx, cy, width, depth, rotationDeg) {
  const rad = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const hw = width / 2;
  const hd = depth / 2;
  return [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]].map(([lx, ly]) => ({
    x: cx + lx * cos - ly * sin,
    y: cy + lx * sin + ly * cos,
  }));
}

/**
 * Shortest distance from point (px, py) to a rotated rectangle (same
 * parameters as rotatedRectCorners) - 0 anywhere inside it.
 */
export function distanceToRotatedRect(px, py, cx, cy, width, depth, rotationDeg) {
  const rad = (rotationDeg * Math.PI) / 180;
  const dx = px - cx;
  const dy = py - cy;
  // Rotate the point into the rectangle's local (axis-aligned) frame.
  const lx = dx * Math.cos(rad) + dy * Math.sin(rad);
  const ly = -dx * Math.sin(rad) + dy * Math.cos(rad);
  const ox = Math.max(Math.abs(lx) - width / 2, 0);
  const oy = Math.max(Math.abs(ly) - depth / 2, 0);
  return Math.hypot(ox, oy);
}

/**
 * True if two convex polygons (arrays of {x, y} corners, e.g. from
 * rotatedRectCorners) overlap with positive area - separating axis test.
 * Polygons that only touch along an edge or at a corner do not overlap.
 */
export function convexPolygonsOverlap(a, b) {
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const p1 = poly[i];
      const p2 = poly[(i + 1) % poly.length];
      const nx = p2.y - p1.y;
      const ny = p1.x - p2.x;
      const [minA, maxA] = projectOnto(a, nx, ny);
      const [minB, maxB] = projectOnto(b, nx, ny);
      if (maxA <= minB + 1e-9 || maxB <= minA + 1e-9) return false;
    }
  }
  return true;
}

function projectOnto(poly, nx, ny) {
  let min = Infinity;
  let max = -Infinity;
  for (const p of poly) {
    const d = p.x * nx + p.y * ny;
    if (d < min) min = d;
    if (d > max) max = d;
  }
  return [min, max];
}

/**
 * Shortest distance from segment [a, b] to an axis-aligned rectangle
 * `{ x, y, width, height }` (x, y = min corner) - 0 when the segment touches
 * or enters it.
 */
export function distanceSegmentToRect(a, b, rect) {
  const inside = (p) => p.x >= rect.x && p.x <= rect.x + rect.width
    && p.y >= rect.y && p.y <= rect.y + rect.height;
  if (inside(a) || inside(b)) return 0;
  const corners = [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.width, y: rect.y },
    { x: rect.x + rect.width, y: rect.y + rect.height },
    { x: rect.x, y: rect.y + rect.height },
  ];
  let best = Infinity;
  for (let i = 0; i < 4; i++) {
    const c0 = corners[i];
    const c1 = corners[(i + 1) % 4];
    if (segmentsIntersect(a, b, c0, c1)) return 0;
    best = Math.min(
      best,
      distanceToSegment(a.x, a.y, c0.x, c0.y, c1.x, c1.y),
      distanceToSegment(b.x, b.y, c0.x, c0.y, c1.x, c1.y),
      distanceToSegment(c0.x, c0.y, a.x, a.y, b.x, b.y),
    );
  }
  return best;
}
