import { SHOP_TABS, UPGRADES, type ShopTab, type UpgradeDef } from '../meta/catalog';
import type { Profile } from '../meta/profile';
import { button, crystal, formatNumber, h, modal, sfx } from '../ui/dom';

let lastTab: ShopTab = 'towers';

/** The Armory: spend crystals on permanent tower, commander and ability upgrades. */
export function openShop(root: HTMLElement, profile: Profile): void {
  const balance = h('span', { class: 'title', style: 'font-size: 18px' });
  const tabs = h('div', { class: 'tabs' });
  const body = h('div');

  const render = () => {
    balance.replaceChildren(formatNumber(profile.crystals), ' ', crystal());
    tabs.replaceChildren(...SHOP_TABS.map((t) =>
      button(t.label, () => ((lastTab = t.id), render()), `small${t.id === lastTab ? ' active' : ''}`)));

    const groups = new Map<string, UpgradeDef[]>();
    for (const u of UPGRADES.filter((u) => u.tab === lastTab)) {
      if (!groups.has(u.group)) groups.set(u.group, []);
      groups.get(u.group)!.push(u);
    }
    body.replaceChildren(...[...groups].map(([name, items]) =>
      h('section', { class: 'group' }, h('h3', {}, name), h('div', { class: 'cards' }, ...items.map(card)))));
  };

  const card = (u: UpgradeDef): HTMLElement => {
    const level = profile.level(u.id);
    const cost = profile.nextCost(u);
    const affordable = cost !== null && cost <= profile.crystals;
    const pips = h('div', { class: 'pips' });
    for (let i = 0; i < u.maxLevel; i++) pips.append(h('span', { class: `pip${i < level ? ' on' : ''}` }));

    const effect = h('div', { class: 'effect' });
    if (level > 0) effect.append(u.effect(level));
    if (cost !== null) {
      if (level > 0) effect.append(' → ');
      effect.append(h('span', { class: 'next' }, u.effect(level + 1)));
    }

    const buy = cost === null
      ? h('button', { class: 'btn small grey', disabled: true }, 'Complete')
      : button(h('span', { style: 'display: contents' }, formatNumber(cost), crystal()), () => {
        if (profile.buy(u)) {
          sfx('switch-a');
          render();
        }
      }, `small ${affordable ? 'green' : 'grey'}`);
    if (cost !== null && !affordable) buy.disabled = true;

    return h('div', { class: 'card panel white' },
      h('img', { src: u.icon, alt: '' }),
      h('div', { class: 'name' }, u.name),
      effect,
      pips,
      buy);
  };

  render();
  const close = modal(root, h('div', { class: 'shop' },
    h('header', {}, h('h2', {}, 'Armory'), balance),
    h('p', { class: 'sub' }, 'Upgrades are permanent and apply to every battle.'),
    tabs,
    body,
    h('div', { class: 'actions' },
      button('Reset progress', () => {
        if (confirm('Reset all crystals, stars and upgrades?')) {
          profile.reset();
          render();
        }
      }, 'small red'),
      button('Done', () => close(), 'grey'))));
}
