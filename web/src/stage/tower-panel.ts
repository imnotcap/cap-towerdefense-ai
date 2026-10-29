import { button, formatNumber, h } from '../ui/dom';
import type { StageScreen } from './stage-screen';
import { MAX_TOWER_LEVEL, TARGETING, TOWER_KINDS, type Targeting, type TowerKind } from './towers';

const PREVIEW = 'models/kenney-td/Previews/';

/**
 * Popover pinned above a build pad: the build menu for an empty pad, or the
 * tower's stats, targeting, upgrade and sell actions. Prices re-check
 * affordability every frame as gold comes in.
 */
export class TowerPanel {
  readonly el = h('div', { class: 'tower-pop panel white interactive' });
  private renderedKey = '';
  /** Buttons whose enabled state depends on gold, with the price they need. */
  private priced: { btn: HTMLButtonElement; cost: () => number | null }[] = [];

  constructor(private readonly screen: StageScreen, readonly pad: number, private readonly close: () => void) {
    this.refresh();
  }

  private get sim() {
    return this.screen.sim;
  }

  /** Re-renders when the pad's tower changes; otherwise just updates affordability. */
  refresh(): void {
    const key = `${this.sim.tKind[this.pad]}:${this.sim.tLevel[this.pad]}:${this.sim.tTargeting[this.pad]}`;
    if (key !== this.renderedKey) {
      this.renderedKey = key;
      this.priced = [];
      this.el.replaceChildren(...(this.sim.tKind[this.pad] < 0 ? this.buildMenu() : this.towerInfo()));
    }
    for (const { btn, cost } of this.priced) {
      const c = cost();
      btn.disabled = c === null || c > this.sim.gold;
    }
  }

  /** Keeps the popover above the pad, inside the viewport. */
  place(): void {
    const s = this.sim;
    const p = this.screen.project(s.tX[this.pad], this.screen.towerTop(this.pad) + 0.6, s.tZ[this.pad]);
    const w = this.el.offsetWidth, hgt = this.el.offsetHeight;
    const x = Math.min(innerWidth - w - 8, Math.max(8, p.x - w / 2));
    let y = p.y - hgt - 8;
    if (y < 64) y = this.screen.project(s.tX[this.pad], 0, s.tZ[this.pad]).y + 24; // no room above: show below the pad
    y = Math.min(innerHeight - hgt - 8, Math.max(8, y));
    this.el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }

  handleKey(key: string): void {
    const kind = this.sim.tKind[this.pad];
    if (kind < 0 && ['1', '2', '3'].includes(key)) this.build((Number(key) - 1) as TowerKind);
    else if (kind >= 0 && key.toLowerCase() === 'u') this.upgrade();
    else if (kind >= 0 && key.toLowerCase() === 's') this.sell();
  }

  private header(title: string, icon?: string): HTMLElement {
    return h('div', { class: 'pop-head' },
      icon ? h('img', { src: icon, alt: '' }) : null,
      h('span', { class: 'title' }, title),
      h('button', { class: 'pop-close', title: 'Close (Esc)', onclick: () => this.close() }, '×'));
  }

  private buildMenu(): HTMLElement[] {
    const options = TOWER_KINDS.map((t, i) => {
      const kind = i as TowerKind;
      const cost = () => this.sim.buildCost(kind);
      const btn = h('button', {
        class: 'build-option',
        onclick: () => this.build(kind),
        onmouseenter: () => (this.screen.previewKind = kind),
        onmouseleave: () => (this.screen.previewKind = null),
      },
      h('img', { src: `${PREVIEW}${t.weapon}.png`, alt: '' }),
      h('span', { class: 'name' }, t.name, h('kbd', {}, String(i + 1))),
      h('span', { class: 'blurb' }, t.blurb),
      h('span', { class: 'price' }, h('span', { class: 'coin' }), formatNumber(cost())));
      this.priced.push({ btn, cost });
      return btn;
    });
    return [this.header('Build tower'), h('div', { class: 'build-options' }, ...options)];
  }

  private towerInfo(): HTMLElement[] {
    const { sim, pad } = this;
    const kind = sim.tKind[pad] as TowerKind;
    const level = sim.tLevel[pad];
    const t = TOWER_KINDS[kind];
    const now = sim.statsFor(kind, level);
    const next = level < MAX_TOWER_LEVEL ? sim.statsFor(kind, level + 1) : null;

    const pips = h('span', { class: 'pips' });
    for (let i = 0; i < MAX_TOWER_LEVEL; i++) pips.append(h('span', { class: `pip${i < level ? ' on' : ''}` }));
    const row = (label: string, cur: number, nxt: number | undefined, fmt: (v: number) => string) =>
      [h('dt', {}, label), h('dd', {}, fmt(cur), nxt !== undefined ? h('span', { class: 'next' }, ` → ${fmt(nxt)}`) : null)];

    const targeting = h('div', { class: 'segmented' }, ...TARGETING.map((m, i) =>
      button(m.label, () => {
        sim.setTargeting(pad, i as Targeting);
        this.refresh();
      }, `small${sim.tTargeting[pad] === i ? ' active' : ''}`)));
    targeting.querySelectorAll('button').forEach((b, i) => (b.title = TARGETING[i].hint));

    const upgradeCost = () => sim.upgradeCost(pad);
    const upgrade = next
      ? button(h('span', { style: 'display: contents' }, 'Upgrade ', h('span', { class: 'coin' }), formatNumber(upgradeCost()!)), () => this.upgrade(), 'small yellow')
      : h('button', { class: 'btn small grey', disabled: true }, 'Fully upgraded');
    if (next) {
      this.priced.push({ btn: upgrade, cost: upgradeCost });
      upgrade.title = 'Upgrade (U)';
      upgrade.addEventListener('mouseenter', () => (this.screen.previewKind = kind));
      upgrade.addEventListener('mouseleave', () => (this.screen.previewKind = null));
    }
    const sell = button(h('span', { style: 'display: contents' }, 'Sell +', formatNumber(sim.sellValue(pad))), () => this.sell(), 'small red');
    sell.title = 'Sell (S)';

    return [
      this.header(`${t.name}`, `${PREVIEW}${t.weapon}.png`),
      h('div', { class: 'pop-level' }, h('span', { class: 'label' }, `Level ${level}`), pips),
      h('dl', { class: 'pop-stats' },
        ...row('Damage', now.damage, next?.damage, (v) => formatNumber(v)),
        ...row('Range', now.range, next?.range, (v) => v.toFixed(1)),
        ...row('Fire rate', 1 / now.cooldown, next ? 1 / next.cooldown : undefined, (v) => `${v.toFixed(1)}/s`),
        ...(now.splash > 0 ? [h('dt', {}, 'Splash'), h('dd', {}, now.splash.toFixed(1))] : [])),
      h('div', { class: 'label' }, 'Targeting'),
      targeting,
      h('div', { class: 'pop-actions' }, upgrade, sell),
    ];
  }

  private build(kind: TowerKind): void {
    if (!this.sim.build(this.pad, kind)) return;
    this.screen.previewKind = null;
    this.screen.towerChanged('built');
    this.refresh();
  }

  private upgrade(): void {
    if (!this.sim.upgrade(this.pad)) return;
    this.screen.towerChanged('upgraded');
    this.refresh();
  }

  private sell(): void {
    if (!this.sim.sell(this.pad)) return;
    this.screen.towerChanged('sold');
    this.close();
  }
}
