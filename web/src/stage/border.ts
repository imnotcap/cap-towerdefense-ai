import * as THREE from 'three/webgpu';
import type { StaticBatcher } from '../engine/static-batch';
import type { ThemeId, Themes } from '../engine/themes';
import { mulberry32, valueNoise } from '../engine/tiles';
import { MAP_H, MAP_W, cellToWorld, type GameMap } from './map';

/** How far the mountain ring extends past the play area, in tiles. */
export const BORDER = 18;
const GROUND_Y = 0.2;

/** Rock and peak colours per theme; the foot of the slopes uses the theme's own ground colour. */
const SLOPES: Record<ThemeId, { rock: number; peak: number; snowLine: number }> = {
  grass: { rock: 0x8c919c, peak: 0xf3f6fb, snowLine: 6 },
  desert: { rock: 0xc4875a, peak: 0xe6c08a, snowLine: 7 },
  snow: { rock: 0x9ba7ba, peak: 0xffffff, snowLine: 3 },
  lava: { rock: 0x5a4a45, peak: 0x7a3422, snowLine: 6 },
  dark: { rock: 0x4b4064, peak: 0x8466b0, snowLine: 6 },
  locked: { rock: 0x8c919c, peak: 0xf3f6fb, snowLine: 6 },
};

const PROPS: Record<ThemeId, string[]> = {
  grass: ['detail-tree', 'detail-tree-large', 'detail-tree', 'detail-rocks'],
  desert: ['detail-rocks', 'detail-rocks-large', 'detail-dirt'],
  snow: ['detail-tree', 'detail-tree-large', 'detail-rocks'],
  lava: ['detail-rocks-large', 'detail-rocks', 'detail-crystal'],
  dark: ['detail-crystal', 'detail-tree-large', 'detail-rocks'],
  locked: [],
};

const smoothstep = (a: number, b: number, v: number) => {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * Mountains ringing the play area so the map fills the screen instead of
 * floating in empty space. Valleys open where the road and any river enter and leave.
 */
export function buildBorder(map: GameMap, themes: Themes, theme: ThemeId, seed: number, batcher: StaticBatcher): THREE.Mesh {
  const noise = valueNoise(seed);
  const halfW = MAP_W / 2, halfH = MAP_H / 2;

  // Road and river ends: where they leave the map, and which way is "out".
  const exits = (cells: readonly [number, number][], kind: 'road' | 'river') => cells.length < 2 ? [] : [
    [cells[0], cells[1]],
    [cells[cells.length - 1], cells[cells.length - 2]],
  ].map(([end, inner]) => {
    const [x, z] = cellToWorld(...end);
    return { x, z, dx: end[0] - inner[0], dz: end[1] - inner[1], kind };
  });
  const passes = [...exits(map.pathCells, 'road'), ...exits(map.river, 'river')];

  // The road and river carry on out of the map as real tiles along a flat-floored valley,
  // so they join the mountains seamlessly. The heightfield leaves those cells to the tiles.
  const corridor = new Set<string>();
  for (const p of passes) {
    const yaw = Math.atan2(p.dx, p.dz);
    for (let k = 1; k <= BORDER; k++) {
      const x = p.x + p.dx * k, z = p.z + p.dz * k;
      corridor.add(`${Math.floor(x)},${Math.floor(z)}`);
      const name = p.kind === 'road' ? 'tile-straight' : 'tile-river-straight';
      batcher.add(themes.model(name, theme), x, 0, z, yaw, false);
    }
  }

  /** 0 in the valley a road/river leaves through, 1 well away from it. */
  const passFactor = (x: number, z: number): number => {
    let open = 1;
    for (const p of passes) {
      const t = (x - p.x) * p.dx + (z - p.z) * p.dz;
      if (t < 0) continue;
      const perp = Math.abs((x - p.x) * p.dz - (z - p.z) * p.dx);
      open = Math.min(open, smoothstep(1.5, 4.5, perp));
    }
    return open;
  };

  /** Distance outside the play rectangle (0 inside). */
  const outside = (x: number, z: number) => Math.hypot(Math.max(0, Math.abs(x) - halfW), Math.max(0, Math.abs(z) - halfH));

  // Exactly tile height at the map edge (and along the corridors), rising into peaks further out.
  const height = (x: number, z: number): number => {
    const d = outside(x, z);
    if (d <= 0) return GROUND_Y;
    const n = noise(x + 100, z + 100);
    let h = GROUND_Y + Math.max(0, d - 1.2) ** 1.25 * (0.45 + n * 0.9);
    h += Math.max(0, d - 4) * n * 0.6; // ridges further out
    return GROUND_Y + (Math.min(h, 14) - GROUND_Y) * passFactor(x, z);
  };

  // Grid aligned to the tile edges so the ring meets the tiles exactly.
  const w = MAP_W + BORDER * 2, hgt = MAP_H + BORDER * 2;
  const x0 = -w / 2, z0 = -hgt / 2;
  const positions: number[] = [];
  const colors: number[] = [];
  const ground = themes.surfaceColor('tile', theme);
  const slope = SLOPES[theme];
  const rock = new THREE.Color(slope.rock);
  const peak = new THREE.Color(slope.peak);
  const c = new THREE.Color();
  for (let iz = 0; iz < hgt; iz++) {
    for (let ix = 0; ix < w; ix++) {
      const xa = x0 + ix, za = z0 + iz;
      // Tiles cover the map itself and the road/river corridors.
      if (outside(xa + 0.5, za + 0.5) === 0 || corridor.has(`${xa},${za}`)) continue;
      const v = (dx: number, dz: number) => [xa + dx, height(xa + dx, za + dz), za + dz];
      const a = v(0, 0), b = v(1, 0), cc = v(0, 1), d = v(1, 1);
      // Alternate the split so the facets don't all lean the same way.
      const tris = (ix + iz) % 2 === 0 ? [[a, cc, b], [b, cc, d]] : [[a, cc, d], [a, d, b]];
      for (const tri of tris) {
        const cy = (tri[0][1] + tri[1][1] + tri[2][1]) / 3;
        const cx = (tri[0][0] + tri[1][0] + tri[2][0]) / 3, cz = (tri[0][2] + tri[1][2] + tri[2][2]) / 3;
        c.copy(ground).lerp(rock, smoothstep(GROUND_Y + 0.25, 2.2, cy));
        c.lerp(peak, smoothstep(slope.snowLine, slope.snowLine + 1.5, cy + noise(cx * 3, cz * 3) * 1.5));
        for (const p of tri) {
          positions.push(p[0], p[1], p[2]);
          colors.push(c.r, c.g, c.b);
        }
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  // Same surface response as the kit's tiles so the ground reads as one continuous field.
  const kit = themes.model('tile', theme)[0].material as THREE.MeshStandardMaterial;
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: kit.roughness, metalness: kit.metalness });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  // Trees and rocks on the foothills.
  const props = PROPS[theme];
  const rand = mulberry32(seed + 1);
  if (props.length) {
    for (let i = 0; i < 900; i++) {
      const x = (rand() - 0.5) * (MAP_W + 12), z = (rand() - 0.5) * (MAP_H + 12);
      const d = outside(x, z);
      if (d < 0.4 || d > 5 || passFactor(x, z) < 0.9) continue;
      const name = props[Math.floor(rand() * props.length)];
      batcher.add(themes.model(name, theme), x, height(x, z) - 0.05, z, rand() * Math.PI * 2, true);
    }
  }
  return mesh;
}
