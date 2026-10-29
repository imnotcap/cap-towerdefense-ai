import { SHOP_TABS, UPGRADES, type ShopTab, type UpgradeDef } from '../meta/catalog';
import type { Profile } from '../meta/profile';
import { amount, button, counter, formatNumber, framed, h, icon, modal, sfx, titleBanner, withCloseTab } from '../ui/dom';

let lastTab: ShopTab = 'towers';

/** The Armory: spend crystals on permanent tower, commander and ability upgrades. */
export function openShop(root: HTMLElement, profile: Profile): void {
  const balance = h('span');
  const tabs = h('div', { class: 'tabs' });
  const grid = h('div', { class: 'grid scroll' });
  const phone = matchMedia('(max-width: 640px)').matches;
  const panel = framed('panel_shop_red', phone ? 0.8 : 1.5, { class: 'shop' }, grid);

  const render = () => {
    balance.textContent = formatNumber(profile.crystals);
    tabs.replaceChildren(...SHOP_TABS.map((t) =>
      button(t.label.toUpperCase(), () => ((lastTab = t.id), render()), { family: t.id === lastTab ? 'amber' : 'blue', size: 'sm' })));
    const scroll = grid.scrollTop;
    const items: HTMLElement[] = [];
    let group = '';
    for (const u of UPGRADES.filter((u) => u.tab === lastTab)) {
      if (u.group !== group && u.tab === 'towers') items.push(h('div', { class: 'group-title' }, u.group.toUpperCase()));
      group = u.group;
      items.push(item(u));
    }
    grid.replaceChildren(...items);
    grid.scrollTop = scroll;
  };

  const item = (u: UpgradeDef): HTMLElement => {
    const level = profile.level(u.id);
    const cost = profile.nextCost(u);
    const pips = h('span', { class: 'stars' });
    for (let i = 0; i < u.maxLevel; i++) pips.append(icon(i < level ? 'radio_on' : 'radio_off', 17));

    const effect = h('div', { class: 'effect' });
    if (level > 0) effect.append(u.effect(level));
    if (cost !== null) {
      if (level > 0) effect.append(' → ');
      effect.append(h('span', { class: 'next' }, u.effect(level + 1)));
    }

    const buy = cost === null
      ? button('MAXED', () => {}, { family: 'amber', size: 'sm', class: 'slim' })
      : button(amount(formatNumber(cost), 'gem', 26), () => {
        if (profile.buy(u)) {
          sfx('switch-a');
          render();
        }
      }, { family: 'amber', size: 'sm', class: 'slim' });
    buy.disabled = cost === null || cost > profile.crystals;

    const frame = framed('card_item_empty', null, { class: 'frame' }, h('img', { src: u.icon, alt: '' }));
    const name = h('div', { class: 'name' }, u.name.toUpperCase());
    // Phones get one compact line per upgrade so more of them fit in the panel.
    return phone
      ? h('div', { class: 'item' }, frame, h('div', { class: 'info' }, name, effect, pips), buy)
      : h('div', { class: 'item' }, frame, h('div', { class: 'info' }, name, effect, h('div', { class: 'row' }, pips, buy)));
  };

  render();
  const close = modal(root, h('div', { class: 'shop-modal' },
    h('div', { class: 'shop-head' }, titleBanner('ARMORY', 'red', phone ? 0.5 : 0.62, phone ? 30 : 38), counter('gem_amber', balance)),
    tabs,
    withCloseTab(panel, () => close(), { right: phone ? 6 : 14, top: phone ? 44 : 84 }),
    h('div', { class: 'note cream' }, 'Upgrades are permanent and apply to every battle.')));
}
