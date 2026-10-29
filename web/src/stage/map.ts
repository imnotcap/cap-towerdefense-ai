import { modelHeight } from '../engine/assets';
import type { StaticBatcher } from '../engine/static-batch';
import type { ThemeId, Themes } from '../engine/themes';
import { type Cell, PATH_TILES, mulberry32, pathTile, valueNoise } from '../engine/tiles';

export const MAP_W = 22;
export const MAP_H = 16;

/**
 * How an area's battle maps are generated. Each stage gets its own seed, so
 * every map is unique, while the style keeps an area recognisable.
 */
export interface MapStyle {
  /** Interior waypoints the road winds through; more = more bends. */
  waypoints: [number, number];
  /** Road length in cells. Longer roads give towers more time. */
  length: [number, number];
  /** Bends in the finished road. */
  bends: [number, number];
  /** Chance that a stage in this area has a river crossing the road. */
  river: number;
  /** Two noise-clustered scenery layers plus a sprinkle of loose props. */
  clusters: { tiles: string[]; props: string[]; threshold: number }[];
  sparse: { props: string[]; chance: number };
  /** Set pieces stacked bottom-to-top (ruins, watchtowers, spires), placed in open ground away from the road. */
  landmarks: { stacks: string[][]; count: [number, number] };
}

export const MAP_STYLES: Record<ThemeId, MapStyle> = {
  // Meadows and copses; long, gentle roads; a stream with a bridge or two.
  grass: {
    waypoints: [2, 3], length: [58, 76], bends: [4, 7], river: 0.8,
    clusters: [
      { tiles: ['tile-tree', 'tile-tree-double', 'tile-tree-quad'], props: ['detail-tree', 'detail-tree-large'], threshold: 0.6 },
      { tiles: ['tile-rock'], props: ['detail-rocks'], threshold: 0.8 },
    ],
    sparse: { props: ['detail-tree'], chance: 0.03 },
    landmarks: { stacks: [['wood-structure-high'], ['wood-structure']], count: [1, 2] },
  },
  // Dune fields and rock outcrops; long straights and zig-zags; dry.
  desert: {
    waypoints: [3, 4], length: [55, 70], bends: [5, 8], river: 0,
    clusters: [
      { tiles: ['tile-hill'], props: ['detail-dirt-large', 'detail-dirt'], threshold: 0.58 },
      { tiles: ['tile-rock'], props: ['detail-rocks-large', 'detail-rocks'], threshold: 0.74 },
    ],
    sparse: { props: ['detail-rocks'], chance: 0.025 },
    // Sand-buried ruins of old towers.
    landmarks: { stacks: [['tower-square-bottom-c', 'tower-square-build-c'], ['tower-square-build-a'], ['tower-round-bottom-c', 'tower-round-build-b']], count: [2, 3] },
  },
  // Pine forests and ice; switchbacks; frozen streams.
  snow: {
    waypoints: [4, 5], length: [56, 72], bends: [7, 11], river: 0.6,
    clusters: [
      { tiles: ['tile-tree', 'tile-tree-double', 'tile-tree-quad'], props: ['detail-tree-large'], threshold: 0.54 },
      { tiles: ['tile-crystal'], props: ['detail-crystal'], threshold: 0.8 },
    ],
    sparse: { props: ['detail-tree'], chance: 0.04 },
    landmarks: { stacks: [['wood-structure-high'], ['wood-structure']], count: [1, 2] },
  },
  // Basalt fields and fire crystals; tight roads; rivers of lava.
  lava: {
    waypoints: [4, 5], length: [50, 64], bends: [7, 11], river: 0.7,
    clusters: [
      { tiles: ['tile-rock', 'tile-hill'], props: ['detail-rocks-large'], threshold: 0.57 },
      { tiles: ['tile-crystal'], props: ['detail-crystal', 'detail-crystal-large'], threshold: 0.72 },
    ],
    sparse: { props: ['detail-rocks'], chance: 0.03 },
    // Ruined forges.
    landmarks: { stacks: [['tower-round-bottom-b', 'tower-round-build-d'], ['tower-round-build-a']], count: [1, 3] },
  },
  // Crystal groves and dead woods; the most convoluted roads; void rivers.
  dark: {
    waypoints: [5, 6], length: [52, 68], bends: [9, 13], river: 0.5,
    clusters: [
      { tiles: ['tile-crystal'], props: ['detail-crystal-large', 'detail-crystal'], threshold: 0.55 },
      { tiles: ['tile-tree-double'], props: ['detail-tree-large'], threshold: 0.72 },
    ],
    sparse: { props: ['detail-crystal'], chance: 0.04 },
    // Crystal spires.
    landmarks: { stacks: [['tower-round-bottom-c', 'tower-round-crystals'], ['tower-round-crystals']], count: [2, 3] },
  },
  locked: {
    waypoints: [2, 3], length: [50, 80], bends: [3, 9], river: 0, clusters: [], sparse: { props: [], chance: 0 },
    landmarks: { stacks: [], count: [0, 0] },
  },
};

/** What sits on one open (non-road, non-river) cell. Cells with scenery can't be built on. */
export interface GroundCell {
  cell: Cell;
  tile: string;
  yaw: number;
  prop?: { name: string; x: number; z: number; yaw: number };
  /** A landmark stack standing on this cell. */
  landmark?: string[];
}

export interface GameMap {
  /** Ordered road cells from spawn to base. */
  pathCells: Cell[];
  /** World-space waypoints (road corners) with cumulative distances. */
  waypoints: Float32Array; // x,z pairs
  cumulative: Float32Array;
  length: number;
  /** Ordered river cells, edge to edge (empty when the map has no river). */
  river: Cell[];
  ground: GroundCell[];
  /** Buildable cells: open ground without trees, rocks or crystals. */
  towerPads: Cell[];
  /** Pad index per grid cell, or -1. */
  padAt: Int16Array;
  isPath: Uint8Array;
  /** 1 = river, 2 = bridge (road over river). */
  riverAt: Uint8Array;
}

/** Grid cell (cx, cy) → world centre. Map is centred on the origin. */
export function cellToWorld(cx: number, cy: number): [number, number] {
  return [cx - MAP_W / 2 + 0.5, cy - MAP_H / 2 + 0.5];
}

const idx = (x: number, y: number) => y * MAP_W + x;
const cheb = (a: Cell, b: Cell) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));

/** Turns in an ordered cell list: the start, every corner, and the end. */
export function cornersOf(cells: readonly Cell[]): Cell[] {
  const out: Cell[] = [cells[0]];
  for (let i = 1; i < cells.length - 1; i++) {
    const [px, py] = cells[i - 1], [x, y] = cells[i], [nx, ny] = cells[i + 1];
    if (x - px !== nx - x || y - py !== ny - y) out.push(cells[i]);
  }
  out.push(cells[cells.length - 1]);
  return out;
}

// Map edges: 0 left, 1 right, 2 top, 3 bottom.
const INWARD: Cell[] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const ENTRY_EXIT: [number, number][] = [[0, 1], [0, 1], [0, 1], [2, 3], [0, 3], [2, 1], [0, 2], [3, 1]];

function edgeCell(side: number, rand: () => number): Cell {
  const along = (n: number) => 2 + Math.floor(rand() * (n - 4));
  if (side === 0) return [0, along(MAP_H)];
  if (side === 1) return [MAP_W - 1, along(MAP_H)];
  if (side === 2) return [along(MAP_W), 0];
  return [along(MAP_W), MAP_H - 1];
}

/** L-shaped route from a to b (exclusive of a), horizontal or vertical leg first. */
function route(a: Cell, b: Cell, horizontalFirst: boolean, out: Cell[]): void {
  let [x, y] = a;
  const stepX = () => { while (x !== b[0]) { x += Math.sign(b[0] - x); out.push([x, y]); } };
  const stepY = () => { while (y !== b[1]) { y += Math.sign(b[1] - y); out.push([x, y]); } };
  if (horizontalFirst) { stepX(); stepY(); } else { stepY(); stepX(); }
}

/**
 * Generates a road that enters on one edge and leaves on another, winding
 * through random waypoints. Rejects roads that touch themselves (keeping a
 * clear tile between passes), hug the map edge, or make one-tile jogs.
 */
function generateRoad(rand: () => number, style: MapStyle): Cell[] | null {
  const [entrySide, exitSide] = ENTRY_EXIT[Math.floor(rand() * ENTRY_EXIT.length)];
  const [from, to] = rand() < 0.5 ? [entrySide, exitSide] : [exitSide, entrySide];
  const start = edgeCell(from, rand), end = edgeCell(to, rand);
  const first: Cell = [start[0] + INWARD[from][0], start[1] + INWARD[from][1]];
  const last: Cell = [end[0] + INWARD[to][0], end[1] + INWARD[to][1]];
  const k = style.waypoints[0] + Math.floor(rand() * (style.waypoints[1] - style.waypoints[0] + 1));
  const points: Cell[] = [first];
  for (let i = 0; i < k; i++) points.push([2 + Math.floor(rand() * (MAP_W - 4)), 2 + Math.floor(rand() * (MAP_H - 4))]);
  points.push(last);

  const cells: Cell[] = [start, first];
  for (let i = 0; i < points.length - 1; i++) {
    // Leave the entry straight inward, and arrive at the exit straight outward.
    let horizontal = rand() < 0.5;
    if (i === 0) horizontal = from < 2;
    if (i === points.length - 2) horizontal = to >= 2;
    route(points[i], points[i + 1], horizontal, cells);
  }
  cells.push(end);

  if (cells.length < style.length[0] || cells.length > style.length[1]) return null;
  const seen = new Set<number>();
  for (let i = 0; i < cells.length; i++) {
    const [x, y] = cells[i];
    if (seen.has(idx(x, y))) return null;
    seen.add(idx(x, y));
    const onEdge = x === 0 || y === 0 || x === MAP_W - 1 || y === MAP_H - 1;
    if (onEdge && i !== 0 && i !== cells.length - 1) return null;
  }
  for (let i = 0; i < cells.length; i++) {
    for (let j = i + 3; j < cells.length; j++) if (cheb(cells[i], cells[j]) < 2) return null;
  }
  const corners = cornersOf(cells);
  const bends = corners.length - 2;
  if (bends < style.bends[0] || bends > style.bends[1]) return null;
  for (let i = 1; i < corners.length - 2; i++) if (cheb(corners[i], corners[i + 1]) < 2) return null;
  return cells;
}

/**
 * A river from one edge to the opposite one. It may only meet the road at
 * right angles on straight stretches (where a bridge goes), and otherwise
 * keeps a clear tile from it.
 */
function generateRiver(rand: () => number, road: Cell[], isPath: Uint8Array): Cell[] | null {
  const vertical = rand() < 0.5;
  const len = vertical ? MAP_H : MAP_W;
  const across = vertical ? MAP_W : MAP_H;
  let offset = 3 + Math.floor(rand() * (across - 6));
  // Lateral shifts at random points along the main axis.
  const shifts = new Map<number, number>();
  const nShifts = Math.floor(rand() * 3);
  for (let s = 0; s < nShifts; s++) shifts.set(3 + Math.floor(rand() * (len - 6)), (rand() < 0.5 ? -1 : 1) * (2 + Math.floor(rand() * 3)));
  const cells: Cell[] = [];
  const push = (along: number, off: number) => cells.push(vertical ? [off, along] : [along, off]);
  for (let a = 0; a < len; a++) {
    push(a, offset);
    const shift = shifts.get(a);
    if (shift) {
      const target = Math.min(across - 3, Math.max(2, offset + shift));
      while (offset !== target) {
        offset += Math.sign(target - offset);
        push(a, offset);
      }
    }
  }

  const roadIndex = new Map(road.map(([x, y], i) => [idx(x, y), i]));
  const crossings: number[] = [];
  cells.forEach(([x, y], i) => {
    if (isPath[idx(x, y)]) crossings.push(i);
  });
  if (crossings.length < 1 || crossings.length > 2) return null;
  for (const ci of crossings) {
    const ri = roadIndex.get(idx(...cells[ci]))!;
    if (ri < 3 || ri > road.length - 4) return null; // keep the entry and exit clear
    const rp = road[ri - 1], rn = road[ri + 1];
    const cp = cells[ci - 1], cn = cells[ci + 1];
    if (!cp || !cn) return null;
    const roadAlongX = rp[1] === rn[1] && rp[0] !== rn[0];
    const roadAlongY = rp[0] === rn[0] && rp[1] !== rn[1];
    const riverAlongX = cp[1] === cn[1];
    const riverAlongY = cp[0] === cn[0];
    // Bridge needs a straight road over a straight river, crossing at right angles.
    if (!((roadAlongX && riverAlongY) || (roadAlongY && riverAlongX))) return null;
  }
  // Away from the crossings, the river keeps a clear tile from the road.
  for (let i = 0; i < cells.length; i++) {
    if (crossings.some((c) => Math.abs(c - i) <= 1)) continue;
    for (const r of road) if (cheb(cells[i], r) < 2) return null;
  }
  return cells;
}

/** Builds the battle map for a stage: road, optional river, clustered scenery and the buildable cells. */
export function buildMap(seed: number, theme: ThemeId = 'grass'): GameMap {
  const style = MAP_STYLES[theme];
  const rand = mulberry32(seed);
  let road: Cell[] | null = null;
  for (let attempt = 0; attempt < 20000 && !road; attempt++) road = generateRoad(rand, style);
  if (!road) throw new Error(`no road found for seed ${seed}`);

  const isPath = new Uint8Array(MAP_W * MAP_H);
  for (const [x, y] of road) isPath[idx(x, y)] = 1;

  const riverAt = new Uint8Array(MAP_W * MAP_H);
  let river: Cell[] = [];
  if (rand() < style.river) {
    for (let attempt = 0; attempt < 4000 && river.length === 0; attempt++) river = generateRiver(rand, road, isPath) ?? [];
  }
  for (const [x, y] of river) riverAt[idx(x, y)] = isPath[idx(x, y)] ? 2 : 1;

  const corners = cornersOf(road);
  const waypoints = new Float32Array(corners.length * 2);
  const cumulative = new Float32Array(corners.length);
  corners.forEach(([x, y], i) => {
    const [wx, wz] = cellToWorld(x, y);
    waypoints[i * 2] = wx;
    waypoints[i * 2 + 1] = wz;
    if (i > 0) cumulative[i] = cumulative[i - 1] + Math.hypot(wx - waypoints[i * 2 - 2], wz - waypoints[i * 2 - 1]);
  });

  // Scenery grows in noise-driven clusters (copses, dune fields, crystal groves) rather than
  // uniform speckle. Cells beside the road stay open so every stretch can be defended.
  const noises = style.clusters.map((_, i) => valueNoise(seed * 7 + i * 101));
  const ground: GroundCell[] = [];
  const towerPads: Cell[] = [];
  const padAt = new Int16Array(MAP_W * MAP_H).fill(-1);
  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x < MAP_W; x++) {
      const i = idx(x, y);
      if (isPath[i] || riverAt[i]) continue;
      const [wx, wz] = cellToWorld(x, y);
      const g: GroundCell = { cell: [x, y], tile: 'tile', yaw: Math.floor(rand() * 4) * (Math.PI / 2) };
      const nearRoad = (x > 0 && isPath[i - 1]) || (x < MAP_W - 1 && isPath[i + 1]) || (y > 0 && isPath[i - MAP_W]) || (y < MAP_H - 1 && isPath[i + MAP_W]);
      if (!nearRoad) {
        const cluster = style.clusters.find((c, k) => noises[k](x, y) > c.threshold);
        const pick = <T,>(list: T[]) => list[Math.floor(rand() * list.length)];
        if (cluster) {
          if (rand() < 0.65) g.tile = pick(cluster.tiles);
          else g.prop = { name: pick(cluster.props), x: wx, z: wz, yaw: rand() * Math.PI * 2 };
        } else if (rand() < style.sparse.chance) {
          g.prop = { name: pick(style.sparse.props), x: wx, z: wz, yaw: rand() * Math.PI * 2 };
        }
        if (g.prop) {
          g.prop.x += (rand() - 0.5) * 0.4;
          g.prop.z += (rand() - 0.5) * 0.4;
        }
      }
      ground.push(g);
    }
  }

  // Landmarks go on open cells at least two tiles from the road, spread apart.
  const [minL, maxL] = style.landmarks.count;
  const wanted = minL + Math.floor(rand() * (maxL - minL + 1));
  const placed: Cell[] = [];
  const candidates = ground.filter((g) => g.tile === 'tile' && !g.prop && road!.every((r) => cheb(r, g.cell) >= 3)
    && river.every((r) => cheb(r, g.cell) >= 2));
  for (let n = 0; n < 60 && placed.length < wanted && candidates.length; n++) {
    const g = candidates[Math.floor(rand() * candidates.length)];
    if (placed.some((p) => cheb(p, g.cell) < 5)) continue;
    g.landmark = style.landmarks.stacks[Math.floor(rand() * style.landmarks.stacks.length)];
    placed.push(g.cell);
  }

  for (const g of ground) {
    if (g.tile === 'tile' && !g.prop && !g.landmark) {
      padAt[idx(...g.cell)] = towerPads.length;
      towerPads.push(g.cell);
    }
  }

  return {
    pathCells: road, waypoints, cumulative, length: cumulative[cumulative.length - 1],
    river, ground, towerPads, padAt, isPath, riverAt,
  };
}

export { PATH_TILES };
export const RIVER_TILES = ['tile-river-straight', 'tile-river-corner', 'tile-river-bridge'] as const;

/** Every model a battle map can use (for preloading). */
export const MAP_MODELS = [...new Set([
  'tile', ...PATH_TILES, ...RIVER_TILES,
  ...Object.values(MAP_STYLES).flatMap((s) => [
    ...s.clusters.flatMap((c) => [...c.tiles, ...c.props]), ...s.sparse.props, ...s.landmarks.stacks.flat(),
  ]),
])];

/** Tiles whose top is flat: they only receive shadows, so they stay out of the shadow pass. */
const FLAT_TILES = new Set<string>(['tile', ...PATH_TILES, 'tile-river-straight']);

/** Adds the road, river and scenery to the batcher, dressed in `theme`. */
export function buildTerrain(map: GameMap, themes: Themes, theme: ThemeId, batcher: StaticBatcher): void {
  const place = (name: string, x: number, z: number, yaw: number, y = 0) =>
    batcher.add(themes.model(name, theme), x, y, z, yaw, !FLAT_TILES.has(name));

  map.pathCells.forEach((cell, i) => {
    const { model, yaw } = pathTile(map.pathCells, i);
    // The bridge deck runs along the road; the river passes underneath.
    const bridge = map.riverAt[idx(...cell)] === 2;
    place(bridge ? 'tile-river-bridge' : model, ...cellToWorld(...cell), yaw);
  });
  map.river.forEach((cell, i) => {
    if (map.riverAt[idx(...cell)] === 2) return;
    const { model, yaw } = pathTile(map.river, i, false);
    place(model === 'tile-corner-square' ? 'tile-river-corner' : 'tile-river-straight', ...cellToWorld(...cell), yaw);
  });
  for (const g of map.ground) {
    place(g.tile, ...cellToWorld(...g.cell), g.yaw);
    if (g.prop) place(g.prop.name, g.prop.x, g.prop.z, g.prop.yaw);
    if (g.landmark) {
      let y = 0.2;
      for (const name of g.landmark) {
        place(name, ...cellToWorld(...g.cell), g.yaw, y);
        y += modelHeight(themes.model(name, theme));
      }
    }
  }
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
