// Generates public/contours.svg: map-style contour lines from a made-up moor,
// traced with marching squares. Re-run with: node scripts/make-contours.mjs
import { writeFileSync } from 'node:fs';

const W = 1600, H = 900, STEP = 11;
const peaks = [
  [1180, 250, 330, 1.0], [1420, 640, 260, 0.75], [820, 700, 300, 0.7],
  [300, 180, 280, 0.65], [120, 760, 240, 0.5], [760, 120, 170, 0.4], [1560, 120, 170, 0.45],
];
const height = (x, y) => {
  let h = 0.02 * Math.sin(x / 41 + y / 67) + 0.018 * Math.cos(y / 37 - x / 83) + 0.012 * Math.sin((x + y) / 23);
  for (const [px, py, r, a] of peaks) h += a * Math.exp(-((x - px) ** 2 + (y - py) ** 2) / (2 * r * r));
  return h;
};
const cols = Math.ceil(W / STEP) + 1, rows = Math.ceil(H / STEP) + 1;
const grid = Array.from({ length: rows }, (_, j) => Array.from({ length: cols }, (_, i) => height(i * STEP, j * STEP)));
const n = (v) => +v.toFixed(1);

function trace(level) {
  let d = '';
  for (let j = 0; j < rows - 1; j++) for (let i = 0; i < cols - 1; i++) {
    const c = [grid[j][i], grid[j][i + 1], grid[j + 1][i + 1], grid[j + 1][i]];
    const x = i * STEP, y = j * STEP, pts = [];
    const cross = (a, b, ax, ay, bx, by) => {
      if ((a < level) !== (b < level)) {
        const t = (level - a) / (b - a);
        pts.push([ax + (bx - ax) * t, ay + (by - ay) * t]);
      }
    };
    cross(c[0], c[1], x, y, x + STEP, y);
    cross(c[1], c[2], x + STEP, y, x + STEP, y + STEP);
    cross(c[3], c[2], x, y + STEP, x + STEP, y + STEP);
    cross(c[0], c[3], x, y, x, y + STEP);
    for (let k = 0; k + 1 < pts.length; k += 2) {
      d += `M${n(pts[k][0])} ${n(pts[k][1])}L${n(pts[k + 1][0])} ${n(pts[k + 1][1])}`;
    }
  }
  return d;
}

let body = '';
for (let index = 1; index <= 34; index++) {
  const major = index % 5 === 0;
  body += `<path d="${trace(index * 0.05)}" stroke-width="${major ? 2 : 1}" stroke-opacity="${major ? 0.34 : 0.2}"/>`;
}
writeFileSync(new URL('../public/contours.svg', import.meta.url),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" fill="none" stroke="#fff" stroke-linecap="round">${body}</svg>\n`);
