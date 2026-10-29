import { SHOP_TABS, UPGRADES, type ShopTab, type UpgradeDef } from '../meta/catalog';
import type { Profile } from '../meta/profile';
import { amount, button, closeTab, counter, formatNumber, framed, h, icon, modal, scrollArea, sfx, sprite, titleBanner } from '../ui/dom';

let lastTab: ShopTab = 'towers';

/**
 * The Armory: spend crystals on permanent tower, commander and ability upgrades.
 *
 * Wide screens use the red shop panel, designed at 1.8× (864×648) and zoomed to
 * fit: the banner and crystals sit in its transparent top margin, the tabs on the
 * frame's top band, and the upgrades fill its burgundy interior. The Towers tab
 * shows one column per tower so it needs no scrolling. Phones get the tall dark
 * tooltip panel with a single scrolling column instead.
 */
export function openShop(root: HTMLElement, profile: Profile): void {
  const phone = innerWidth < 720;
  const balance = h('span');
  const tabs = h('div', { class: 'shop-tabs' });
  const list = scrollArea('shop-list');
  const panel = phone
    ? sprite('panel_tooltip_brown', 380 / 220, { tag: 'div', class: 'shop-panel' }, list.el)
    : sprite('panel_shop_red', 1.8, { tag: 'div', class: 'shop-panel' }, list.el);

  const render = () => {
    balance.textContent = formatNumber(profile.crystals);
    tabs.replaceChildren(...SHOP_TABS.map((t) =>
      button(t.label.toUpperCase(), () => {
        lastTab = t.id;
        list.body.scrollTop = 0;
        render();
      }, { family: t.id === lastTab ? 'amber' : 'blue', size: 'sm' })));
    const scroll = list.body.scrollTop;
    const items = UPGRADES.filter((u) => u.tab === lastTab);
    if (lastTab === 'towers') {
      // One column per tower: its card art and name, then its three upgrades.
      const groups = [...new Set(items.map((u) => u.group))];
      list.body.replaceChildren(h('div', { class: 'shop-grid cols-3' }, ...groups.map((g) => {
        const ups = items.filter((u) => u.group === g);
        return h('div', { class: 'shop-group' },
          h('div', { class: 'group-head' }, h('img', { src: ups[0].icon, alt: '' }), h('span', {}, g.toUpperCase())),
          ...ups.map((u) => row(u, false)));
      })));
    } else if (lastTab === 'abilities') {
      list.body.replaceChildren(h('div', { class: 'shop-grid cols-2' }, ...items.map(feature)));
    } else {
      list.body.replaceChildren(h('div', { class: 'shop-grid cols-2' }, ...items.map((u) => row(u, true))));
    }
    list.body.scrollTop = scroll;
    list.refresh();
  };

  /** Level stars, the current → next effect, and the buy button (or MAXED) for an upgrade. */
  const parts = (u: UpgradeDef, starPx: number) => {
    const level = profile.level(u.id);
    const cost = profile.nextCost(u);
    const pips = h('span', { class: 'pips' });
    for (let i = 0; i < u.maxLevel; i++) pips.append(icon(i < level ? 'star_gold' : 'star_dim', starPx));
    pips.title = `Level ${level} of ${u.maxLevel}`;

    const effect = h('div', { class: 'effect' });
    if (cost === null) effect.append(h('span', { class: 'now' }, u.effect(level)));
    else if (level === 0) effect.append(h('span', { class: 'next' }, u.effect(1)));
    else {
      // "+10% crystals" → "+20% crystals" reads as "+10% → +20% crystals".
      const [now, next] = [u.effect(level), u.effect(level + 1)];
      const nowWords = now.split(' '), nextWords = next.split(' ');
      let shared = 0;
      while (shared < nowWords.length - 1 && nowWords.at(-1 - shared) === nextWords.at(-1 - shared)) shared++;
      effect.append(h('span', { class: 'now' }, nowWords.slice(0, nowWords.length - shared).join(' ')), ' → ', h('span', { class: 'next' }, next));
    }

    let buy: HTMLElement;
    if (cost === null) {
      buy = h('span', { class: 'maxed' }, icon('check', 26), 'MAXED');
    } else {
      const b = button(amount(formatNumber(cost), 'gem', 24), () => {
        if (profile.buy(u)) {
          sfx('switch-a');
          render();
        }
      }, { family: 'amber', size: 'sm', class: 'slim buy' });
      b.disabled = cost > profile.crystals;
      b.title = cost > profile.crystals ? `Needs ${formatNumber(cost - profile.crystals)} more crystals` : level === 0 ? 'Unlock' : 'Upgrade';
      buy = b;
    }
    return { level, pips, effect, buy };
  };

  /** One upgrade as an inset row: (icon), name, effect, level stars, and the buy button. */
  const row = (u: UpgradeDef, withIcon: boolean): HTMLElement => {
    const { pips, effect, buy } = parts(u, 15);
    return h('div', { class: `upg${withIcon ? ' with-icon' : ''}` },
      withIcon ? framed('card_item_empty', null, { class: 'frame' }, h('img', { src: u.icon, alt: '' })) : null,
      h('div', { class: 'info' }, h('div', { class: 'name' }, u.name.toUpperCase()), effect, pips),
      buy);
  };

  /** An ability as a large card: big icon, what it does, and its unlock or power level. */
  const feature = (u: UpgradeDef): HTMLElement => {
    const { level, pips, effect, buy } = parts(u, 20);
    return h('div', { class: 'upg feature' },
      framed('card_item_empty', null, { class: 'frame' }, h('img', { src: u.icon, alt: '' })),
      h('div', { class: 'name' }, u.name.toUpperCase()),
      h('div', { class: 'blurb' }, u.blurb ?? ''),
      h('div', { class: 'state' }, level === 0 ? 'LOCKED' : `POWER ${level - 1} / ${u.maxLevel - 1}`),
      effect, pips, buy);
  };

  render();
  let close = () => {};
  const content = h('div', { class: `shop-modal ${phone ? 'tall' : 'wide'}` },
    panel,
    h('div', { class: 'shop-head' }, titleBanner('ARMORY', 'red', 0.6, 40), counter('gem_amber', balance)),
    tabs,
    h('div', { class: 'note' }, 'Upgrades are permanent and apply to every battle.'));
  // Wide: on the panel's top-right corner block. Tall: on the dark panel's corner.
  const tab = closeTab(() => close(), phone ? [320, 20, 50, 55] : [772, 118, 50, 55]);
  panel.append(tab);
  close = modal(root, content);
  list.refresh();
}
