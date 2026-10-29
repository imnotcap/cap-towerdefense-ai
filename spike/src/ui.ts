/** DOM UI themed with the Kenney UI Pack (styles live in index.html). */

const CLICK_SOUND = 'ui/kenney-ui/Sounds/click-a.ogg';

export function setLoadingProgress(done: number, total: number): void {
  const fill = document.querySelector<HTMLElement>('#loading .fill');
  if (fill) fill.style.width = `${Math.round((done / total) * 100)}%`;
}

export function setLoadingMessage(text: string): void {
  const msg = document.querySelector<HTMLElement>('#loading .msg');
  if (msg) msg.textContent = text;
}

export function hideLoading(): void {
  const el = document.getElementById('loading')!;
  el.classList.add('done');
  setTimeout(() => el.remove(), 500);
}

export type Tone = 'good' | 'warn' | 'bad' | '';

/** Stats panel: a title and label/value rows that can be updated cheaply. */
export class StatsPanel {
  private readonly values = new Map<string, HTMLElement>();

  constructor(root: HTMLElement, title: string, labels: string[]) {
    const h = document.createElement('h1');
    h.textContent = title;
    const divider = document.createElement('div');
    divider.className = 'divider';
    const dl = document.createElement('dl');
    for (const label of labels) {
      const dt = document.createElement('dt');
      dt.textContent = label;
      const dd = document.createElement('dd');
      dl.append(dt, dd);
      this.values.set(label, dd);
    }
    root.append(h, divider, dl);
  }

  set(label: string, value: string, tone: Tone = ''): void {
    const dd = this.values.get(label)!;
    if (dd.textContent !== value) dd.textContent = value;
    if (dd.className !== tone) dd.className = tone;
  }
}

/** A labelled row of radio-style buttons with a click sound. */
export function buttonRow<T>(root: HTMLElement, label: string, options: { value: T; text: string }[], onPick: (v: T) => void) {
  const click = new Audio(CLICK_SOUND);
  click.volume = 0.5;
  const span = document.createElement('span');
  span.className = 'label';
  span.textContent = label;
  const row = document.createElement('div');
  row.className = 'row';
  const buttons = options.map((o) => {
    const b = document.createElement('button');
    b.className = 'btn';
    b.textContent = o.text;
    b.onclick = () => {
      click.currentTime = 0;
      void click.play().catch(() => {});
      onPick(o.value);
    };
    row.appendChild(b);
    return b;
  });
  root.append(span, row);
  return {
    select(value: T) {
      buttons.forEach((b, i) => b.classList.toggle('active', options[i].value === value));
    },
  };
}
