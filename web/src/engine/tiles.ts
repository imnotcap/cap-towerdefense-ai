import type * as THREE from 'three/webgpu';
import type { FaceCull } from './static-batch';

/** Grid helpers shared by stage maps and the world map (Kenney tiles are 1×1 units). */

export type Cell = [number, number];

export function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Expands axis-aligned corner points into every cell along the polyline. */
export function rasterizePath(corners: readonly Cell[]): Cell[] {
  const cells: Cell[] = [];
  for (let i = 0; i < corners.length - 1; i++) {
    const [ax, ay] = corners[i];
    const [bx, by] = corners[i + 1];
    const steps = Math.abs(bx - ax) + Math.abs(by - ay);
    const dx = Math.sign(bx - ax);
    const dy = Math.sign(by - ay);
    for (let s = 0; s < steps; s++) cells.push([ax + dx * s, ay + dy * s]);
  }
  cells.push(corners[corners.length - 1]);
  return cells;
}

export const PATH_TILES = ['tile-spawn', 'tile-end', 'tile-straight', 'tile-corner-square'] as const;

/**
 * Path tile choice + yaw for cell `i` of an ordered path. Kenney tiles:
 * straight/spawn roads run along local Z, the end tile opens towards +Z, and
 * the corner opens towards +X and +Z. `ends` picks spawn/end tiles for the
 * first/last cell (otherwise they are drawn as straights).
 */
export function pathTile(cells: readonly Cell[], i: number, ends = true): { model: string; yaw: number } {
  const cur = cells[i];
  const prev = cells[i - 1];
  const next = cells[i + 1];
  const dirYaw = (a: Cell, b: Cell) => Math.atan2(b[0] - a[0], b[1] - a[1]);
  if (!prev) return { model: ends ? 'tile-spawn' : 'tile-straight', yaw: dirYaw(cur, next) };
  if (!next) return ends ? { model: 'tile-end', yaw: dirYaw(cur, prev) } : { model: 'tile-straight', yaw: dirYaw(prev, cur) };
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

const TILE_TOP = 0.2;
const EPS = 1e-3;

/**
 * Culls faces of a w×h tile grid centred on the origin that the camera can
 * never see: anything facing down (the camera stays above the map) and tile
 * side walls on a shared cell boundary, where the neighbouring tile covers them.
 * `hasTile` says whether a cell is occupied (irregular islands have open edges).
 */
export function tileGridCuller(w: number, h: number, hasTile: (cx: number, cy: number) => boolean = () => true): FaceCull {
  // A wall at grid line g between columns g-1 and g is hidden only if both sides have tiles.
  const shared = (g: number, other: number, alongX: boolean) =>
    alongX ? hasTile(g - 1, other) && hasTile(g, other) : hasTile(other, g - 1) && hasTile(other, g);
  const onLine = (u: number, v: number, wv: number, half: number) => {
    if (Math.abs(u - v) > EPS || Math.abs(u - wv) > EPS) return null;
    const g = u + half;
    const r = Math.round(g);
    return Math.abs(g - r) < EPS && r > 0 && r < half * 2 ? r : null;
  };
  return (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, n: THREE.Vector3) => {
    if (n.y < -0.5) return true;
    if (Math.max(a.y, b.y, c.y) > TILE_TOP + EPS) return false;
    if (Math.abs(n.x) > 0.9) {
      const g = onLine(a.x, b.x, c.x, w / 2);
      if (g !== null) return shared(g, Math.floor((a.z + b.z + c.z) / 3 + h / 2), true);
    }
    if (Math.abs(n.z) > 0.9) {
      const g = onLine(a.z, b.z, c.z, h / 2);
      if (g !== null) return shared(g, Math.floor((a.x + b.x + c.x) / 3 + w / 2), false);
    }
    return false;
  };
}
