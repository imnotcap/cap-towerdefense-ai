import * as THREE from 'three/webgpu';
import type { Model } from './assets';
import { StaticBatcher } from './static-batch';

export const MAP_W = 22;
export const MAP_H = 16;

/** Path corners in grid coordinates, spawn → base. */
const PATH_CORNERS: [number, number][] = [
  [0, 3], [5, 3], [5, 11], [10, 11], [10, 4], [16, 4], [16, 12], [21, 12],
];

export interface GameMap {
  /** Ordered path cells from spawn to base. */
  pathCells: [number, number][];
  /** World-space waypoints (cell centres) with cumulative distances. */
  waypoints: Float32Array; // x,z pairs
  cumulative: Float32Array;
  length: number;
  towerPads: [number, number][];
  isPath: Uint8Array;
}

/** Grid cell (cx, cy) → world centre. Map is centred on the origin. */
export function cellToWorld(cx: number, cy: number): [number, number] {
  return [cx - MAP_W / 2 + 0.5, cy - MAP_H / 2 + 0.5];
}

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildMap(): GameMap {
  const pathCells: [number, number][] = [];
  for (let i = 0; i < PATH_CORNERS.length - 1; i++) {
    const [ax, ay] = PATH_CORNERS[i];
    const [bx, by] = PATH_CORNERS[i + 1];
    const steps = Math.abs(bx - ax) + Math.abs(by - ay);
    const dx = Math.sign(bx - ax);
    const dy = Math.sign(by - ay);
    for (let s = 0; s < steps; s++) pathCells.push([ax + dx * s, ay + dy * s]);
  }
  pathCells.push(PATH_CORNERS[PATH_CORNERS.length - 1]);

  const isPath = new Uint8Array(MAP_W * MAP_H);
  for (const [x, y] of pathCells) isPath[y * MAP_W + x] = 1;

  const waypoints = new Float32Array(PATH_CORNERS.length * 2);
  const cumulative = new Float32Array(PATH_CORNERS.length);
  PATH_CORNERS.forEach(([x, y], i) => {
    const [wx, wz] = cellToWorld(x, y);
    waypoints[i * 2] = wx;
    waypoints[i * 2 + 1] = wz;
    if (i > 0) {
      cumulative[i] = cumulative[i - 1] + Math.hypot(wx - waypoints[i * 2 - 2], wz - waypoints[i * 2 - 1]);
    }
  });

  // Tower pads: every third free cell that touches the path orthogonally.
  const towerPads: [number, number][] = [];
  let k = 0;
  for (let y = 0; y < MAP_H; y++) {
    for (let x = 1; x < MAP_W - 1; x++) {
      if (isPath[y * MAP_W + x]) continue;
      const touches =
        (x > 0 && isPath[y * MAP_W + x - 1]) || (x < MAP_W - 1 && isPath[y * MAP_W + x + 1]) ||
        (y > 0 && isPath[(y - 1) * MAP_W + x]) || (y < MAP_H - 1 && isPath[(y + 1) * MAP_W + x]);
      if (touches && k++ % 3 === 0) towerPads.push([x, y]);
    }
  }

  return { pathCells, waypoints, cumulative, length: cumulative[cumulative.length - 1], towerPads, isPath };
}

/** Path tile choice + yaw for a cell, from its neighbours along the path. */
function pathTile(map: GameMap, i: number): { model: string; yaw: number } {
  const cur = map.pathCells[i];
  const prev = map.pathCells[i - 1];
  const next = map.pathCells[i + 1];
  // Kenney tiles: straight/spawn roads run along local Z, the end tile opens towards +Z,
  // and the corner opens towards +X and +Z.
  const dirYaw = (a: [number, number], b: [number, number]) => Math.atan2(b[0] - a[0], b[1] - a[1]);
  if (!prev) return { model: 'tile-spawn', yaw: dirYaw(cur, next) };
  if (!next) return { model: 'tile-end', yaw: dirYaw(cur, prev) };
  const din = [cur[0] - prev[0], cur[1] - prev[1]];
  const dout = [next[0] - cur[0], next[1] - cur[1]];
  if (din[0] === dout[0] && din[1] === dout[1]) return { model: 'tile-straight', yaw: dirYaw(prev, cur) };
  return { model: 'tile-corner-square', yaw: cornerYaw([-din[0], -din[1]], dout) };
}

/** Finds the quarter turn that rotates the corner's +X/+Z openings onto directions a and b. */
function cornerYaw(a: number[], b: number[]): number {
  for (let k = 0; k < 4; k++) {
    const yaw = (k * Math.PI) / 2;
    const zx = Math.round(Math.sin(yaw)), zz = Math.round(Math.cos(yaw)); // local +Z in world
    const xx = Math.round(Math.cos(yaw)), xz = Math.round(-Math.sin(yaw)); // local +X in world
    const hasA = (zx === a[0] && zz === a[1]) || (xx === a[0] && xz === a[1]);
    const hasB = (zx === b[0] && zz === b[1]) || (xx === b[0] && xz === b[1]);
    if (hasA && hasB) return yaw;
  }
  return 0;
}

export const GROUND_TILES = ['tile', 'tile-tree', 'tile-tree-double', 'tile-rock', 'tile-hill', 'tile-crystal'] as const;
export const PATH_TILES = ['tile-spawn', 'tile-end', 'tile-straight', 'tile-corner-square'] as const;
export const DECOR = ['detail-tree', 'detail-tree-large', 'detail-rocks', 'detail-crystal'] as const;

/** Tiles whose top is flat: they only receive shadows, so they stay out of the shadow pass. */
const FLAT_TILES = new Set<string>(['tile', ...PATH_TILES]);

/** Adds all terrain tiles and decoration to the batcher. */
export function buildTerrain(map: GameMap, models: Map<string, Model>, batcher: StaticBatcher): void {
  const rand = mulberry32(7);
  const placements = new Map<string, { x: number; z: number; yaw: number }[]>();
  const place = (model: string, x: number, z: number, yaw: number) => {
    let list = placements.get(model);
    if (!list) placements.set(model, (list = []));
    list.push({ x, z, yaw });
  };

  map.pathCells.forEach((_, i) => {
    const { model, yaw } = pathTile(map, i);
    const [x, z] = cellToWorld(...map.pathCells[i]);
    place(model, x, z, yaw);
  });

  const padSet = new Set(map.towerPads.map(([x, y]) => y * MAP_W + x));
  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x < MAP_W; x++) {
      const idx = y * MAP_W + x;
      if (map.isPath[idx]) continue;
      const [wx, wz] = cellToWorld(x, y);
      const yaw = Math.floor(rand() * 4) * (Math.PI / 2);
      if (padSet.has(idx)) {
        place('tile', wx, wz, 0);
        continue;
      }
      const r = rand();
      const nearPath = map.isPath[idx - 1] || map.isPath[idx + 1] || map.isPath[idx - MAP_W] || map.isPath[idx + MAP_W];
      const model = nearPath || r < 0.72 ? 'tile' : GROUND_TILES[1 + Math.floor(rand() * (GROUND_TILES.length - 1))];
      place(model, wx, wz, yaw);
      if (model === 'tile' && !nearPath && rand() < 0.25) {
        const d = DECOR[Math.floor(rand() * DECOR.length)];
        place(d, wx + (rand() - 0.5) * 0.5, wz + (rand() - 0.5) * 0.5, rand() * Math.PI * 2);
      }
    }
  }

  for (const [name, list] of placements) {
    const model = models.get(name)!;
    for (const p of list) batcher.add(model, p.x, 0, p.z, p.yaw, !FLAT_TILES.has(name));
  }
}

const TILE_TOP = 0.2;
const EPS = 1e-3;

/**
 * Culls faces of the tile grid the camera can never see: anything facing down
 * (the camera stays above the map) and tile side walls that sit on a shared
 * cell boundary inside the map, where the neighbouring tile covers them.
 */
export function cullHiddenTerrainFaces(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, n: THREE.Vector3): boolean {
  if (n.y < -0.5) return true;
  if (Math.max(a.y, b.y, c.y) > TILE_TOP + EPS) return false;
  const onInnerBoundary = (u: number, v: number, w: number, half: number) => {
    if (Math.abs(u - v) > EPS || Math.abs(u - w) > EPS) return false;
    const g = u + half; // grid coordinate of the plane
    return Math.abs(g - Math.round(g)) < EPS && Math.round(g) > 0 && Math.round(g) < half * 2;
  };
  if (Math.abs(n.x) > 0.9 && onInnerBoundary(a.x, b.x, c.x, MAP_W / 2)) return true;
  if (Math.abs(n.z) > 0.9 && onInnerBoundary(a.z, b.z, c.z, MAP_H / 2)) return true;
  return false;
}

/** Samples a point `d` along the path, offset sideways by `lane`. Returns heading yaw. */
export function samplePath(map: GameMap, d: number, lane: number, out: { x: number; z: number; yaw: number }): void {
  const cum = map.cumulative;
  const wp = map.waypoints;
  let seg = 0;
  while (seg < cum.length - 2 && d > cum[seg + 1]) seg++;
  const ax = wp[seg * 2], az = wp[seg * 2 + 1];
  const bx = wp[seg * 2 + 2], bz = wp[seg * 2 + 3];
  const len = cum[seg + 1] - cum[seg];
  const t = Math.min(1, Math.max(0, (d - cum[seg]) / len));
  const dx = (bx - ax) / len, dz = (bz - az) / len;
  out.x = ax + (bx - ax) * t - dz * lane;
  out.z = az + (bz - az) * t + dx * lane;
  out.yaw = Math.atan2(dx, dz);
}
