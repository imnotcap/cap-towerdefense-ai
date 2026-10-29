// Writes assets/ui/towers/<kind>.png (card art) from bench/previews/index.html.
// Usage: node bench/previews/render.mjs   (starts its own Vite dev server)
import { createServer } from 'vite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// Playwright comes from the environment (it is not a project dependency).
const { chromium } = createRequire(import.meta.url)('playwright');
const root = fileURLToPath(new URL('../..', import.meta.url));
const out = fileURLToPath(new URL('../../../assets/ui/towers/', import.meta.url));
mkdirSync(out, { recursive: true });
const server = await createServer({ root, server: { port: 0 }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({ args: ['--use-angle=swiftshader'] });
const page = await browser.newPage({ viewport: { width: 384, height: 384 } });
page.on('pageerror', (e) => console.error(e));
page.on('console', (m) => m.type() === 'error' && console.error(m.text()));
await page.goto(new URL('bench/previews/', server.resolvedUrls.local[0]).href);
await page.waitForFunction(() => window.ready, null, { timeout: 120000 });
const kinds = await page.evaluate(() => window.kinds);
for (let i = 0; i < kinds.length; i++) {
  await page.evaluate((i) => window.show(i), i);
  const shot = await page.locator('canvas').screenshot({ omitBackground: true });
  // Crop to the tower plus a small margin, square, so it fills the card's art slot.
  const png = await page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const { data } = g.getImageData(0, 0, c.width, c.height);
    let x0 = c.width, y0 = c.height, x1 = 0, y1 = 0;
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) if (data[(y * c.width + x) * 4 + 3] > 8) {
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
    const side = Math.max(x1 - x0, y1 - y0) + 8;
    const out = document.createElement('canvas');
    out.width = out.height = 192;
    out.getContext('2d').drawImage(c, (x0 + x1 - side) / 2, (y0 + y1 - side) / 2, side, side, 0, 0, 192, 192);
    return out.toDataURL('image/png').split(',')[1];
  }, shot.toString('base64'));
  writeFileSync(`${out}${kinds[i]}.png`, Buffer.from(png, 'base64'));
  console.log(`wrote ${out}${kinds[i]}.png`);
}
await browser.close();
await server.close();
