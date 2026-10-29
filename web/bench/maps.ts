// Renders every campaign map into one PNG contact sheet for review, and prints map stats.
// Usage: npm run bench:maps [-- out.png]
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { STAGES } from '../src/meta/catalog';
import { MAP_H, MAP_W, buildMap } from '../src/stage/map';

const CELL = 9;
const GAP = 14;
const COLS = 5;
const mapW = MAP_W * CELL, mapH = MAP_H * CELL;
const W = COLS * (mapW + GAP) + GAP;
const H = Math.ceil(STAGES.length / COLS) * (mapH + GAP) + GAP;
const px = new Uint8Array(W * H * 3).fill(250);

const GROUND: Record<string, [number, number, number]> = {
  grass: [126, 200, 140], desert: [232, 214, 170], snow: [235, 240, 246], lava: [70, 62, 60], dark: [92, 74, 120],
};
const rect = (x: number, y: number, w: number, h: number, c: [number, number, number]) => {
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) px.set(c, (yy * W + xx) * 3);
};

const rows: Record<string, unknown>[] = [];
STAGES.forEach((stage, i) => {
  const t0 = performance.now();
  const map = buildMap(stage.seed, stage.area.theme);
  const ms = performance.now() - t0;
  const ox = GAP + (i % COLS) * (mapW + GAP), oy = GAP + Math.floor(i / COLS) * (mapH + GAP);
  const g = GROUND[stage.area.theme];
  rect(ox, oy, mapW, mapH, g);
  const dim = (c: [number, number, number], f: number): [number, number, number] => [c[0] * f, c[1] * f, c[2] * f];
  for (const cell of map.ground) {
    if (cell.tile !== 'tile' || cell.prop) rect(ox + cell.cell[0] * CELL + 1, oy + cell.cell[1] * CELL + 1, CELL - 2, CELL - 2, dim(g, cell.tile !== 'tile' ? 0.55 : 0.72));
    if (cell.landmark) rect(ox + cell.cell[0] * CELL, oy + cell.cell[1] * CELL, CELL, CELL, [150, 60, 170]);
  }
  for (const [x, y] of map.river) rect(ox + x * CELL, oy + y * CELL, CELL, CELL, [70, 150, 230]);
  map.pathCells.forEach(([x, y], k) => {
    const bridge = map.riverAt[y * MAP_W + x] === 2;
    const c: [number, number, number] = bridge ? [120, 110, 100] : k === 0 ? [40, 180, 60] : k === map.pathCells.length - 1 ? [220, 50, 50] : [200, 130, 80];
    rect(ox + x * CELL + 1, oy + y * CELL + 1, CELL - 2, CELL - 2, c);
  });
  rows.push({
    stage: `${i + 1} ${stage.name}`, theme: stage.area.theme, road: map.pathCells.length, bends: map.waypoints.length / 2 - 2,
    river: map.river.length > 0 ? `${map.river.filter(([x, y]) => map.riverAt[y * MAP_W + x] === 2).length} bridge(s)` : '-',
    landmarks: map.ground.filter((c) => c.landmark).length, open: map.towerPads.length, ms: ms.toFixed(1),
  });
});
console.table(rows);

// Minimal PNG encoder (RGB, no filtering).
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf: Buffer) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type: string, data: Buffer) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
const raw = Buffer.alloc((W * 3 + 1) * H);
for (let y = 0; y < H; y++) Buffer.from(px.buffer, y * W * 3, W * 3).copy(raw, y * (W * 3 + 1) + 1);
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;
ihdr[9] = 2;
const out = process.argv[2] ?? 'bench/maps.png';
writeFileSync(out, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
console.log(`wrote ${out}`);
