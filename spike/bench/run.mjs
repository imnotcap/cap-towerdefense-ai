// Serves dist/ and runs the spike in headless Chromium at several enemy counts.
// Usage: npm run build && npm run bench -- [--webgl] [--shots] [--counts=1000,5000]
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const root = fileURLToPath(new URL('../dist/', import.meta.url));
const args = process.argv.slice(2);
const counts = (args.find((a) => a.startsWith('--counts='))?.slice(9) ?? '250,1000,2500,5000,10000').split(',').map(Number);
const extra = args.includes('--webgl') ? '&webgl' : '';
const types = { '.html': 'text/html', '.js': 'text/javascript', '.glb': 'model/gltf-binary', '.png': 'image/png', '.css': 'text/css' };

const server = createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, '') || 'index.html';
  try {
    const body = await readFile(join(root, path));
    res.writeHead(200, { 'content-type': types[extname(path)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
}).listen(0);
const port = server.address().port;

const browser = await chromium.launch({
  args: extra ? ['--use-angle=swiftshader'] : ['--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.error('pageerror:', e.message));
page.on('console', (m) => m.type() === 'error' && console.error('console:', m.text()));

const rows = [];
for (const n of counts) {
  await page.goto(`http://localhost:${port}/?bench&n=${n}${extra}`);
  await page.waitForFunction(() => window.__bench, null, { timeout: 120000 });
  const r = await page.evaluate(() => window.__bench);
  if (args.includes('--shots')) await page.screenshot({ path: `bench/shot-${n}.png` });
  rows.push(r);
  console.log(JSON.stringify(r));
}
console.table(rows.map((r) => ({
  backend: r.backend, enemies: r.enemies, fps: r.fps.toFixed(1), avgMs: r.avgFrameMs.toFixed(2), p95Ms: r.p95FrameMs.toFixed(2),
  cpuMs: r.cpuMs.toFixed(2), simMs: r.simMs.toFixed(2), draws: r.drawCalls, tris: r.triangles,
})));
await browser.close();
server.close();
