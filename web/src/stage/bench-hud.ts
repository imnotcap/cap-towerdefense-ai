import type { App } from '../engine/app';
import { button, h } from '../ui/dom';
import type { StageScreen } from './stage-screen';

const PRESETS = [250, 1000, 2500, 5000, 10000];
type Tone = 'good' | 'warn' | 'bad' | '';

/**
 * Perf panel + enemy-count presets for `?bench`. Also publishes `window.__bench`
 * after a warm-up so `bench/run.mjs` can collect results headlessly.
 */
export function attachBenchHud(app: App, stage: StageScreen, ui: HTMLElement, opts: { record: boolean; durationMs: number }) {
  const labels = ['Backend', 'FPS', 'CPU / frame', 'Sim / tick', 'Enemies', 'Towers', 'Shots', 'Draw calls', 'Triangles', 'Static tris'];
  const values = new Map<string, HTMLElement>();
  const dl = h('dl');
  for (const label of labels) {
    const dd = h('dd');
    dl.append(h('dt', {}, label), dd);
    values.set(label, dd);
  }
  const set = (label: string, value: string, tone: Tone = '') => {
    const dd = values.get(label)!;
    if (dd.textContent !== value) dd.textContent = value;
    if (dd.className !== tone) dd.className = tone;
  };
  ui.append(h('div', { class: 'stats panel' }, h('h1', {}, 'Phase 0 · Perf'), h('div', { class: 'divider' }), dl));

  const { perf, sim } = stage;
  set('Backend', app.backend, app.backend === 'WebGPU' ? 'good' : 'warn');
  set('Towers', String(sim.towerCount));
  set('Static tris', `${(perf.staticTris / 1000).toFixed(1)}k (−${Math.round((1 - perf.staticTris / perf.staticTrisBefore) * 100)}%) in ${perf.staticMeshes} meshes`);

  const row = h('div', { class: 'row' });
  const buttons = PRESETS.map((n) => {
    const b = button(n.toLocaleString('en-US'), () => select(n));
    row.append(b);
    return b;
  });
  const select = (n: number) => {
    sim.setEnemyCount(n);
    stage.setEnemyShadows();
    buttons.forEach((b, i) => b.classList.toggle('active', PRESETS[i] === n));
  };
  select(sim.n);
  ui.append(h('div', { class: 'bench-controls panel interactive' }, h('span', { class: 'label' }, 'Enemies'), row));

  let frames = 0;
  let windowStart = performance.now();
  const start = performance.now();
  const frameTimes: number[] = [];
  app.onFrame = (frameMs) => {
    const now = performance.now();
    frames++;
    if (opts.record && now - start > 2000) frameTimes.push(frameMs);
    const info = app.renderer.info.render;
    if (now - windowStart > 500) {
      const fps = (frames * 1000) / (now - windowStart);
      frames = 0;
      windowStart = now;
      const tone = (v: number, good: number, ok: number): Tone => (v <= good ? 'good' : v <= ok ? 'warn' : 'bad');
      set('FPS', fps.toFixed(0), tone(-fps, -55, -30));
      set('CPU / frame', `${perf.cpuMs.toFixed(2)} ms`, tone(perf.cpuMs, 8, 16));
      set('Sim / tick', `${perf.simMs.toFixed(2)} ms`, tone(perf.simMs, 2, 5));
      set('Enemies', sim.n.toLocaleString('en-US'));
      set('Shots', String(sim.pCount));
      set('Draw calls', String(info.drawCalls));
      set('Triangles', `${(info.triangles / 1e6).toFixed(2)}M`);
    }
    if (opts.record && frameTimes.length > 0 && now - start > 2000 + opts.durationMs) {
      app.onFrame = null;
      const sorted = [...frameTimes].sort((a, b) => a - b);
      const avg = frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length;
      (window as unknown as { __bench: unknown }).__bench = {
        backend: app.backend,
        enemies: sim.n,
        frames: frameTimes.length,
        avgFrameMs: avg,
        p95FrameMs: sorted[Math.floor(sorted.length * 0.95)],
        fps: 1000 / avg,
        cpuMs: perf.cpuMs,
        simMs: perf.simMs,
        drawCalls: info.drawCalls,
        triangles: info.triangles,
      };
    }
  };
}
