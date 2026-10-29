import { amount, art, at, closeTab, formatNumber, framed, h, icon, rectButton, sfx, text } from '../ui/dom';
import type { StageScreen } from './stage-screen';
import { MAX_TOWER_LEVEL, TARGETING, TOWER_KINDS, type Targeting, type TowerKind } from './towers';

/**
 * Info panel for a built tower, docked on the right as in the pack's tower-HUD
 * recipe: the dark tooltip with name, blurb, stats and the sell plate, with the
 * upgrade button and targeting plate hung underneath. Affordability is re-checked
 * every frame as gold comes in.
 */
export class TowerPanel {
  readonly el = h('div', { class: 'tower-info interactive' });
  private renderedKey = '';
  private upgradeBtn: HTMLButtonElement | null = null;

  constructor(private readonly screen: StageScreen, readonly pad: number, private readonly close: () => void) {
    this.refresh();
  }

  private get sim() {
    return this.screen.sim;
  }

  /** Re-renders when the tower changes; otherwise just updates affordability. */
  refresh(): void {
    const { sim, pad } = this;
    const key = `${sim.tKind[pad]}:${sim.tLevel[pad]}:${sim.tTargeting[pad]}`;
    if (key !== this.renderedKey) {
      this.renderedKey = key;
      this.render();
    }
    const cost = sim.upgradeCost(pad);
    if (this.upgradeBtn) this.upgradeBtn.disabled = cost === null || cost > sim.gold;
  }

  handleKey(key: string): void {
    if (key.toLowerCase() === 'u') this.upgrade();
    else if (key.toLowerCase() === 's') this.sell();
  }

  private render(): void {
    const { sim, pad } = this;
    const kind = sim.tKind[pad] as TowerKind;
    if (kind < 0) {
      this.close();
      return;
    }
    const level = sim.tLevel[pad];
    const t = TOWER_KINDS[kind];
    const now = sim.statsFor(kind, level);
    const next = level < MAX_TOWER_LEVEL ? sim.statsFor(kind, level + 1) : null;

    const levelStars = h('span', { class: 'stars' });
    for (let i = 0; i < MAX_TOWER_LEVEL; i++) levelStars.append(icon(i < level ? 'star_gold' : 'star_dim', 18));
    const stat = (row: number, label: string, cur: number, nxt: number | undefined, fmt: (v: number) => string) =>
      at(h('div', { class: 'stat' }, h('span', {}, label),
        h('span', {}, fmt(cur), nxt !== undefined ? h('span', { class: 'next' }, ` → ${fmt(nxt)}`) : null)), [27, 132 + row * 22, 154, 20]);

    // Upgrade button and targeting plate hang under the panel.
    const cost = sim.upgradeCost(pad);
    this.upgradeBtn = rectButton('amber', [0, 266, 204, 75], () => this.upgrade(),
      cost === null
        ? text('MAXED', [24, 18, 156, 37], 30)
        : text(h('span', { class: 'amount' }, icon('arrow_up', 30), amount(formatNumber(cost), 'coin', 26)), [20, 18, 164, 37], 30));
    this.upgradeBtn.title = cost === null ? 'Fully upgraded' : 'Upgrade (U)';
    if (cost !== null) {
      this.upgradeBtn.addEventListener('mouseenter', () => (this.screen.previewKind = kind));
      this.upgradeBtn.addEventListener('mouseleave', () => (this.screen.previewKind = null));
    }
    this.upgradeBtn.disabled = cost === null || cost > sim.gold;

    const mode = sim.tTargeting[pad];
    const target = at(framed('dropdown_plate', 204 / 240, { tag: 'button', class: 'target' }, `TARGET: ${TARGETING[mode].label.toUpperCase()}`),
      [0, 339, 204, 54]);
    target.title = `${TARGETING[mode].hint} — click to change`;
    target.addEventListener('click', () => {
      sfx('click-a');
      sim.setTargeting(pad, ((mode + 1) % TARGETING.length) as Targeting);
      this.refresh();
    });

    const sell = at(h('button', { class: 'sell-plate sw fit sw-price_plate_burgundy' },
      text('SELL', [12, 8, 55, 26], 23), art('coin_gold', [76, 9, 21, 23]), text(formatNumber(sim.sellValue(pad)), [100, 8, 44, 26], 23, { align: 'left' })),
    [25, 204, 157, 43]);
    sell.title = 'Sell (S)';
    sell.addEventListener('click', () => this.sell());

    this.el.replaceChildren(
      art('panel_tooltip_brown', [0, 0, 204, 260]),
      closeTab(() => this.close(), [162, 2, 40, 44]),
      text(h('span', { class: 'name' }, t.name.toUpperCase(), levelStars), [18, 37, 169, 33], 23),
      text(t.blurb, [23, 77, 159, 40], 14, { body: true }),
      stat(0, 'DAMAGE', now.damage, next?.damage, (v) => formatNumber(v)),
      stat(1, 'RANGE', now.range, next?.range, (v) => v.toFixed(1)),
      stat(2, 'RATE', 1 / now.cooldown, next ? 1 / next.cooldown : undefined, (v) => `${v.toFixed(1)}/S`),
      sell, this.upgradeBtn, target);
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
