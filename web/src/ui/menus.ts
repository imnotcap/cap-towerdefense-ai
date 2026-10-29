import {
  art, at, button, closeTab, framed, h, modal, recipeBox, rectButton, saveSettings, settings, slider, text, toggle,
  type ButtonFamily, type Rect,
} from './dom';

/** A plank button in one of the paper menu's two button slots. */
export interface MenuAction {
  label: string;
  family: ButtonFamily;
  icon?: string;
  onClick: () => void;
}

// The pause recipe ("Pause & settings"), offset so its top-left element sits at 0,0.
const OX = 244, OY = 52;
const R = (x: number, y: number, w: number, hgt: number): Rect => [x - OX, y - OY, w, hgt];
/** Button slots under the paper, with the icon and label rects inside each button. */
const SLOTS = [
  { rect: R(359, 428, 242, 88), icon: [38, 26, 29, 29] as Rect, label: [73, 24, 127, 37] as Rect, px: 29 },
  { rect: R(359, 511, 242, 79), icon: [38, 24, 29, 29] as Rect, label: [74, 23, 125, 35] as Rect, px: 30 },
];

/**
 * The pause / settings menu, laid out from the pack's pause recipe: a taped paper
 * on a gear and cable, audio toggle, volume slider, and up to two plank buttons
 * hung underneath. Returns a function that closes it.
 */
export function paperMenu(root: HTMLElement, title: string, actions: MenuAction[], onClose?: () => void): () => void {
  const speaker = art(settings.sound ? 'speaker_on_ink' : 'speaker_off_ink', R(385, 211, 33, 33));
  const audio = at(toggle(settings.sound, (on) => {
    settings.sound = on;
    saveSettings();
    speaker.classList.replace(on ? 'sw-speaker_off_ink' : 'sw-speaker_on_ink', on ? 'sw-speaker_on_ink' : 'sw-speaker_off_ink');
  }, 64 / 96), R(521, 211, 64, 32));
  audio.title = 'Sound on/off';
  const percent = text(`${Math.round(settings.volume * 100)}%`, R(521, 263, 64, 33), 24, { color: 'ink', align: 'right' });
  const volume = at(slider(settings.volume, (v) => {
    settings.volume = v;
    percent.textContent = `${Math.round(v * 100)}%`;
    saveSettings();
  }, 0.8, 30), R(389, 324, 192, 20));

  let close = () => {};
  const box = recipeBox(387, 538, 'paper-menu',
    art('gear_large_brown', R(244, 276, 190, 190), 'decor'),
    art('cable_loop_brown', R(340, 374, 280, 140), 'decor'),
    art('panel_pause_paper', R(330, 52, 300, 364)),
    closeTab(() => close(), R(581, 64, 50, 55)),
    text(title, R(384, 127, 200, 54), 44, { color: 'ink' }),
    speaker, text('AUDIO', R(429, 211, 82, 33), 24, { color: 'ink', align: 'left' }), audio,
    text('VOLUME', R(385, 263, 126, 33), 24, { color: 'ink', align: 'left' }), percent,
    volume,
    ...actions.slice(0, 2).map((a, i) => {
      const slot = SLOTS[i];
      // Without an icon the label centres across the plank; long labels drop a size.
      const labelRect: Rect = a.icon ? slot.label : [24, slot.label[1], 194, slot.label[3]];
      const px = a.label.length > 9 ? 24 : slot.px;
      return rectButton(a.family, slot.rect, a.onClick, a.icon ? art(a.icon, slot.icon) : null, text(a.label, labelRect, px));
    }));
  close = modal(root, box, onClose);
  return close;
}

/** Yes/no question on dialog paper; `onYes` runs if accepted. */
export function confirmDialog(root: HTMLElement, title: string, body: string, yes: string, onYes: () => void): void {
  const close = modal(root, h('div', {},
    framed('panel_dialog_paper', 1, {}, h('div', { class: 'paper-text' }, h('h2', { style: 'font-size: 30px' }, title), h('p', {}, body))),
    h('div', { class: 'actions' },
      button('CANCEL', () => close(), { family: 'blue', size: 'sm' }),
      button(yes, () => {
        close();
        onYes();
      }, { family: 'burgundy', size: 'sm' }))));
}

/** The settings menu (title screen and world map): audio, plus resetting all progress. */
export function settingsMenu(root: HTMLElement, resetProgress: () => void): () => void {
  return paperMenu(root, 'SETTINGS', [{
    label: 'RESET PROGRESS', family: 'burgundy',
    onClick: () => confirmDialog(root, 'RESET PROGRESS?', 'All crystals, stars and upgrades will be lost.', 'RESET', resetProgress),
  }]);
}
