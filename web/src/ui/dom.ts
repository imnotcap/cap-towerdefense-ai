/** Tiny DOM helpers for the themed UI (styles in theme.css). */

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

const sounds = new Map<string, HTMLAudioElement>();

/** Plays a UI sound from the Kenney UI Pack; failures (autoplay policy) are ignored. */
export function sfx(name: 'click-a' | 'click-b' | 'switch-a' | 'switch-b' | 'tap-a' | 'tap-b', volume = 0.5): void {
  let a = sounds.get(name);
  if (!a) {
    a = new Audio(`ui/kenney-ui/Sounds/${name}.ogg`);
    sounds.set(name, a);
  }
  a.volume = volume;
  a.currentTime = 0;
  void a.play().catch(() => {});
}

export function button(label: string | Node, onClick: () => void, cls = ''): HTMLButtonElement {
  return h('button', { class: `btn ${cls}`.trim(), onclick: () => (sfx('click-a'), onClick()) }, label);
}

export function stars(count: number, of = 3): HTMLElement {
  const wrap = h('span', { class: 'stars' });
  for (let i = 0; i < of; i++) wrap.append(h('span', { class: `star-icon${i < count ? '' : ' empty'}` }));
  return wrap;
}

export const crystal = () => h('span', { class: 'crystal' });

/** Opens a modal over `root`; returns a close function. Clicking the backdrop closes it unless `dismissable` is false. */
export function modal(root: HTMLElement, content: HTMLElement, onClose?: () => void, dismissable = true): () => void {
  const backdrop = h('div', { class: 'backdrop' }, content);
  content.classList.add('modal', 'panel');
  const close = () => {
    backdrop.remove();
    onClose?.();
  };
  backdrop.addEventListener('pointerdown', (e) => {
    if (dismissable && e.target === backdrop) close();
  });
  root.append(backdrop);
  return close;
}

export function setLoadingProgress(done: number, total: number): void {
  const fill = document.querySelector<HTMLElement>('#loading .fill');
  if (fill) fill.style.width = `${Math.round((done / total) * 100)}%`;
}

export function setLoadingMessage(text: string): void {
  const msg = document.querySelector<HTMLElement>('#loading .msg');
  if (msg) msg.textContent = text;
}

export function hideLoading(): void {
  const el = document.getElementById('loading');
  if (!el) return;
  el.classList.add('done');
  setTimeout(() => el.remove(), 500);
}

export function formatNumber(n: number): string {
  return Math.floor(n).toLocaleString('en-US');
}
