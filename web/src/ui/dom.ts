/** DOM helpers and Scrapworks UI components (styles in theme.css, sprite geometry in scrapworks.css). */

type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<Omit<HTMLElementTagNameMap[K], 'style'>> & { class?: string; style?: string } = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  const { class: cls, style, ...rest } = props;
  if (cls) el.className = cls;
  if (style) el.style.cssText = style;
  Object.assign(el, rest);
  for (const c of children) if (c) el.append(c);
  return el;
}

// --- Settings (persisted per browser) --------------------------------------

const SETTINGS_KEY = 'cap-td/settings/v1';
export const settings = { sound: true, volume: 0.6 };
try {
  Object.assign(settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}'));
} catch {
  // Blocked storage: keep defaults.
}
export function saveSettings(): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Ignore.
  }
}

const sounds = new Map<string, HTMLAudioElement>();

/** Plays a UI sound; respects the sound settings. Failures (autoplay policy) are ignored. */
export function sfx(name: 'click-a' | 'click-b' | 'switch-a' | 'switch-b' | 'tap-a' | 'tap-b', volume = 0.5): void {
  if (!settings.sound || settings.volume <= 0) return;
  let a = sounds.get(name);
  if (!a) {
    a = new Audio(`ui/kenney-ui/Sounds/${name}.ogg`);
    sounds.set(name, a);
  }
  a.volume = Math.min(1, volume * settings.volume * 1.6);
  a.currentTime = 0;
  void a.play().catch(() => {});
}

// --- Sprites ------------------------------------------------------------------

/**
 * An element drawn with Scrapworks sprite `id`, scaled by `k` (1 = the sprite's 1x size).
 * Pass `null` to leave the scale to CSS (responsive sizes).
 */
export function sprite<K extends keyof HTMLElementTagNameMap = 'span'>(
  id: string, k: number | null, opts: { tag?: K; class?: string } = {}, ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = h((opts.tag ?? 'span') as K, { class: `sw sw-${id} ${opts.class ?? ''}`.trim() } as never, ...children);
  if (k !== null) el.style.setProperty('--k', String(k));
  return el;
}

/** A sprite whose children go in its label-safe rect. */
export function framed<K extends keyof HTMLElementTagNameMap = 'div'>(
  id: string, k: number | null, opts: { tag?: K; class?: string } = {}, ...children: Child[]
): HTMLElementTagNameMap[K] & { safe: HTMLElement } {
  const safe = h('div', { class: 'safe' }, ...children);
  const el = sprite(id, k, { tag: (opts.tag ?? 'div') as K, class: opts.class }, safe) as HTMLElementTagNameMap[K] & { safe: HTMLElement };
  el.safe = safe;
  return el;
}

/** Scrapworks icons are 64×64 canvases; `px` is the canvas size on screen (omit to size from CSS). */
export const icon = (id: string, px?: number) => sprite(id, px === undefined ? null : px / 64, { class: 'icon' });

/** Kenney 3D model preview (for towers/abilities, so the UI matches the 3D models). */
export const preview = (model: string, cls = '') => h('img', { src: `models/kenney-td/Previews/${model}.png`, alt: '', class: cls });

export type ButtonFamily = 'red' | 'blue' | 'amber' | 'burgundy';
const FAMILY: Record<ButtonFamily, string> = {
  red: 'primary_red', blue: 'secondary_blue', amber: 'warning_amber', burgundy: 'danger_burgundy',
};

/** 9-slice plank button. `opts.size`: sm / md / lg; `opts.icon`: Scrapworks icon id shown before the label. */
export function button(
  label: Child, onClick: () => void,
  opts: { family?: ButtonFamily; size?: 'sm' | 'md' | 'lg'; icon?: string; class?: string } = {},
): HTMLButtonElement {
  const size = opts.size && opts.size !== 'md' ? opts.size : '';
  const b = h('button', {
    class: `btn swb-${FAMILY[opts.family ?? 'blue']} ${size} ${opts.class ?? ''}`.trim(),
    onclick: () => (sfx('click-a'), onClick()),
  }, opts.icon ? icon(opts.icon, 30) : null, label);
  return b;
}

/** Square icon button (64×64 plate). Its size comes from CSS (`--qk`); the icon scales with it. */
export function squareButton(
  content: string | Node, onClick: () => void,
  opts: { color?: 'blue' | 'red' | 'amber' | 'teal'; label?: string; class?: string } = {},
): HTMLButtonElement {
  const b = sprite(`square_${opts.color ?? 'blue'}`, null, { tag: 'button', class: `sq ${opts.class ?? ''}` });
  b.append(typeof content === 'string' ? icon(content) : content);
  if (opts.label) b.append(h('span', { class: 'sq-label' }, opts.label));
  b.addEventListener('click', () => (sfx('click-a'), onClick()));
  return b;
}

export function stars(count: number, of = 3, px = 22): HTMLElement {
  const wrap = h('span', { class: 'stars' });
  for (let i = 0; i < of; i++) wrap.append(icon(i < count ? 'star_gold' : 'star_dim', px));
  return wrap;
}

/** Amount with a currency icon: gold coins (in battle) or amber gems (crystals, the meta currency). */
export const amount = (value: Child, currency: 'coin' | 'gem', px = 22) =>
  h('span', { class: 'amount' }, icon(currency === 'coin' ? 'coin_gold' : 'gem_amber', px), value);

/** HUD counter: icon overlapping a cream plate with a value. */
export function counter(iconId: string, value: HTMLElement, color: 'brown' | 'red' = 'brown'): HTMLElement {
  return h('div', { class: 'counter' }, icon(iconId), framed(`hud_counter_${color}`, null, { class: 'plate' }, value));
}

/** Title banner (red or blue plank) with live text. */
export function titleBanner(text: string, color: 'red' | 'blue', k: number, fontPx: number, cls = ''): HTMLElement {
  const b = framed(`banner_title_${color}`, k, { class: `banner ${cls}`.trim() }, text);
  b.safe.style.fontSize = `${fontPx}px`;
  return b;
}

/** Wood-plank toast for hints. */
export function toast(text: string, k = 1.5): HTMLElement {
  return framed('wood_plank_horizontal', k, { class: 'toast' }, text);
}

/** Progress bar: 3-slice track with a clipped fill (wave / health / energy). */
export function progressBar(fill: 'wave' | 'health' | 'energy', k = 1): { el: HTMLElement; set: (frac: number) => void } {
  const fillWrap = h('div', { class: 'fill' }, sprite(`progress_fill_${fill}`, k));
  const el = sprite('progress_track', k, { tag: 'div', class: 'bar' }, fillWrap);
  const full = 224 * k;
  return {
    el,
    set(frac: number) {
      fillWrap.style.width = `${Math.round(Math.max(0, Math.min(1, frac)) * full)}px`;
    },
  };
}

/** Slider using the pack's track/fill/thumb; reports 0–1. `thumbPx` is the thumb canvas size on screen. */
export function slider(value: number, onChange: (v: number) => void, k = 0.9, thumbPx = 32 * k): HTMLElement {
  const thumb = sprite('slider_thumb', thumbPx / 32, { class: 'thumb' });
  const fillWrap = h('div', { class: 'fill' }, sprite('slider_fill', k));
  const el = sprite('slider_track', k, { tag: 'div', class: 'bar slider interactive' }, fillWrap, thumb);
  const full = 224 * k;
  const show = (v: number) => {
    fillWrap.style.width = `${Math.round(v * full)}px`;
    thumb.style.left = `${8 * k + v * full - thumbPx / 2}px`;
    thumb.style.top = `${12 * k - thumbPx / 2}px`;
  };
  const pick = (e: PointerEvent) => {
    // The rect is in screen pixels, which differ from layout pixels inside a zoomed recipe box.
    const r = el.getBoundingClientRect();
    const px = (e.clientX - r.left) * ((240 * k) / r.width);
    const v = Math.max(0, Math.min(1, (px - 8 * k) / full));
    show(v);
    onChange(v);
  };
  el.addEventListener('pointerdown', (e) => {
    el.setPointerCapture(e.pointerId);
    pick(e);
  });
  el.addEventListener('pointermove', (e) => {
    if (el.hasPointerCapture(e.pointerId)) pick(e);
  });
  show(value);
  return el;
}

/** On/off toggle using toggle_on / toggle_off. */
export function toggle(on: boolean, onChange: (on: boolean) => void, k = 0.8): HTMLButtonElement {
  const b = sprite(on ? 'toggle_on' : 'toggle_off', k, { tag: 'button', class: 'toggle' });
  b.setAttribute('aria-pressed', String(on));
  b.addEventListener('click', () => {
    on = !on;
    b.classList.replace(on ? 'sw-toggle_off' : 'sw-toggle_on', on ? 'sw-toggle_on' : 'sw-toggle_off');
    b.setAttribute('aria-pressed', String(on));
    sfx('switch-a');
    onChange(on);
  });
  return b;
}

/**
 * Red close tab hung on a panel's top-right corner, drawn into rect `r`. The pause
 * recipe uses a 50×55 tab with a 22 px cross at +14,+10; other sizes scale that.
 */
export function closeTab(onClick: () => void, r: Rect): HTMLButtonElement {
  const s = r[2] / 50;
  const b = at(h('button', { class: 'close-tab sw fit sw-close_tab_red' }, art('cross', [14 * s, 10 * s, 22 * s, 22 * s])), r);
  b.title = 'Close';
  b.addEventListener('click', () => (sfx('click-b'), onClick()));
  return b;
}

/** Hangs a 50×55 close tab on a sprite panel, `right`/`top` px from its corner. */
export function withCloseTab(panel: HTMLElement, onClose: () => void, pos: { right: number; top: number }): HTMLElement {
  const tab = closeTab(onClose, [0, pos.top, 50, 55]);
  tab.style.left = '';
  tab.style.right = `${pos.right}px`;
  panel.append(tab);
  return panel;
}

// --- Recipe layout -------------------------------------------------------------
//
// The pack's layout recipes give every element as a rectangle in px on a 960×600
// canvas. Screens built from a recipe use those rectangles as-is inside a box whose
// origin is the recipe's top-left corner; the whole box is zoomed to fit the viewport.

export type Rect = readonly [x: number, y: number, w: number, h: number];

/** Positions `el` absolutely at rect `r` inside its (positioned) parent. */
export function at<T extends HTMLElement>(el: T, [x, y, w, hgt]: Rect): T {
  el.classList.add('at');
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  el.style.width = `${w}px`;
  el.style.height = `${hgt}px`;
  return el;
}

/** Sprite drawn into a recipe rect, aspect kept and centred (as the pack's preview draws them). */
export const art = (id: string, r: Rect, cls = '') => at(h('span', { class: `sw fit sw-${id} ${cls}`.trim() }), r);

export type TextColor = 'cream' | 'ink' | 'gold' | 'locked';

/** A line of text in a recipe rect (Passion One; `body` uses the system UI font for running text). */
export function text(
  content: Child, r: Rect, px: number,
  opts: { color?: TextColor; align?: 'left' | 'center' | 'right'; body?: boolean; class?: string } = {},
): HTMLElement {
  const el = at(h('span', { class: `rtext c-${opts.color ?? 'cream'} ${opts.align ?? 'center'} ${opts.body ? 'body' : ''} ${opts.class ?? ''}`.trim() }, content), r);
  el.style.fontSize = `${px}px`;
  return el;
}

/** A plank button at a recipe rect; the art is 9-sliced, so it may be stretched to the rect. Children use button-local rects. */
export function rectButton(family: ButtonFamily, r: Rect, onClick: () => void, ...children: Child[]): HTMLButtonElement {
  const b = at(h('button', { class: `btn fixed swb-${FAMILY[family]}`, onclick: () => (sfx('click-a'), onClick()) }, ...children), r);
  b.style.setProperty('--k', String(r[3] / 88));
  return b;
}

/** A box for recipe layouts: `w`×`h` px, zoomed down (or up on big screens) to fit the viewport. */
export function recipeBox(w: number, hgt: number, cls = '', ...children: Child[]): HTMLElement {
  const box = h('div', { class: `recipe ${cls}`.trim() }, ...children);
  box.style.width = `${w}px`;
  box.style.height = `${hgt}px`;
  fitRecipe(box);
  return box;
}

function fitRecipe(box: HTMLElement): void {
  const grow = Math.min(1.35, Math.max(1, innerHeight / 760));
  box.style.zoom = String(Math.min(grow, (innerWidth - 12) / parseFloat(box.style.width), (innerHeight - 12) / parseFloat(box.style.height)));
}
addEventListener('resize', () => {
  document.querySelectorAll<HTMLElement>('.recipe').forEach(fitRecipe);
  document.querySelectorAll<HTMLElement>('.modal').forEach(fitModal);
});

/** Opens a modal over `root`; returns a close function. Clicking the backdrop closes it unless `dismissable` is false. */
export function modal(root: HTMLElement, content: HTMLElement, onClose?: () => void, dismissable = true): () => void {
  const backdrop = h('div', { class: 'backdrop' }, content);
  content.classList.add('modal');
  const close = () => {
    backdrop.remove();
    onClose?.();
  };
  backdrop.addEventListener('pointerdown', (e) => {
    if (dismissable && e.target === backdrop) close();
  });
  root.append(backdrop);
  fitModal(content);
  return close;
}

/** Zooms a modal down so it fits the viewport (recipe boxes fit themselves). */
function fitModal(el: HTMLElement): void {
  if (el.classList.contains('recipe')) return;
  el.style.zoom = '';
  const w = Math.max(el.offsetWidth, el.scrollWidth), hgt = Math.max(el.offsetHeight, el.scrollHeight);
  const z = Math.min(1, (innerWidth - 8) / w, (innerHeight - 8) / hgt);
  if (z < 1) el.style.zoom = String(z);
}

export function formatNumber(n: number): string {
  return Math.floor(n).toLocaleString('en-US');
}

/** Shrinks a recipe text's font until the text fits its rect (once the display font has loaded). */
export function fitText(el: HTMLElement): HTMLElement {
  void document.fonts.ready.then(() => {
    let px = parseFloat(el.style.fontSize);
    while (el.scrollWidth > el.clientWidth + 1 && px > 10) el.style.fontSize = `${--px}px`;
  });
  return el;
}
