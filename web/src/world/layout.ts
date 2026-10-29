import { type Cell, mulberry32, rasterizePath } from '../engine/tiles';
import { AREAS, STAGES_PER_AREA } from '../meta/catalog';

export const WORLD_W = 46;
export const WORLD_H = 32;

/**
 * Road corners per area, in campaign order. Each area's stretch starts where
 * the previous one ended; the campaign ends at the spire in the island centre.
 */
const AREA_ROADS: readonly (readonly Cell[])[] = [
  [[2, 28], [11, 28], [11, 23], [18, 23]], // Greenhollow, bottom-left
  [[18, 23], [18, 28], [29, 28], [29, 23], [41, 23]], // Sunscar Dunes, bottom-right
  [[41, 23], [41, 16], [33, 16], [33, 9], [42, 9], [42, 3]], // Frostpeak, right
  [[42, 3], [26, 3], [26, 9], [14, 9], [14, 3], [3, 3], [3, 15]], // Emberforge, top-left
  [[3, 15], [11, 15], [11, 19], [24, 19], [24, 13]], // Umbral Spire, centre
];

export interface WorldLayout {
  road: Cell[];
  /** Area index per road cell. */
  roadArea: number[];
  /** Stage nodes in campaign order (cells on the road). */
  nodes: Cell[];
  /** Area index per grid cell, or -1 for water. */
  land: Int8Array;
  /** Distance (in cells) from each land cell to the road; 0 on the road. */
  roadDist: Uint8Array;
}

export function cellToWorld(cx: number, cy: number): [number, number] {
  return [cx - WORLD_W / 2 + 0.5, cy - WORLD_H / 2 + 0.5];
}

/** Cells along a polyline at fractions of its length. */
function pointsAlong(cells: Cell[], count: number): Cell[] {
  const out: Cell[] = [];
  for (let k = 0; k < count; k++) {
    const idx = Math.round(((k + 0.5) / count) * (cells.length - 1));
    out.push(cells[idx]);
  }
  return out;
}

export function buildWorldLayout(seed = 3): WorldLayout {
  const rand = mulberry32(seed);
  const road: Cell[] = [];
  const roadArea: number[] = [];
  const nodes: Cell[] = [];
  AREA_ROADS.forEach((corners, a) => {
    const cells = rasterizePath(corners);
    // Skip the shared joint so it is not emitted twice.
    const own = a === 0 ? cells : cells.slice(1);
    road.push(...own);
    roadArea.push(...own.map(() => a));
    // The final area ends at the spire: put its last stage on the end of the road.
    const points = pointsAlong(cells.slice(a === 0 ? 1 : 2), STAGES_PER_AREA);
    if (a === AREAS.length - 1) points[STAGES_PER_AREA - 1] = cells[cells.length - 1];
    nodes.push(...points);
  });

  // Distance to road (BFS, 4-neighbour).
  const size = WORLD_W * WORLD_H;
  const roadDist = new Uint8Array(size).fill(255);
  let frontier: number[] = road.map(([x, y]) => y * WORLD_W + x);
  for (const i of frontier) roadDist[i] = 0;
  for (let d = 1; frontier.length > 0 && d < 255; d++) {
    const next: number[] = [];
    for (const i of frontier) {
      const x = i % WORLD_W, y = (i / WORLD_W) | 0;
      for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
        if (nx < 0 || ny < 0 || nx >= WORLD_W || ny >= WORLD_H) continue;
        const j = ny * WORLD_W + nx;
        if (roadDist[j] !== 255) continue;
        roadDist[j] = d;
        next.push(j);
      }
    }
    frontier = next;
  }

  // Land: everything near the road, with a ragged coastline from smoothed noise.
  const noise = new Float32Array(size).map(() => rand());
  const smooth = (x: number, y: number) => {
    let s = 0, n = 0;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= WORLD_W || yy >= WORLD_H) continue;
        s += noise[yy * WORLD_W + xx];
        n++;
      }
    }
    return s / n;
  };
  const land = new Int8Array(size).fill(-1);
  for (let y = 0; y < WORLD_H; y++) {
    for (let x = 0; x < WORLD_W; x++) {
      const i = y * WORLD_W + x;
      const edge = Math.min(x, y, WORLD_W - 1 - x, WORLD_H - 1 - y);
      const reach = 2.5 + (smooth(x, y) - 0.5) * 9;
      if (roadDist[i] > reach || (edge === 0 && roadDist[i] > 0)) continue;
      // Area of the nearest stage node gives regions natural borders.
      let best = 0, bestD = Infinity;
      nodes.forEach(([nx, ny], k) => {
        const d = (nx - x) ** 2 + (ny - y) ** 2;
        if (d < bestD) {
          bestD = d;
          best = Math.floor(k / STAGES_PER_AREA);
        }
      });
      land[i] = best;
    }
  }
  // Road cells always belong to their own stretch.
  road.forEach(([x, y], k) => (land[y * WORLD_W + x] = roadArea[k]));

  return { road, roadArea, nodes, land, roadDist };
}
