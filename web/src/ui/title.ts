import { art, fitText, h, progressBar, recipeBox, rectButton, text, type Rect } from './dom';

// The pack's title-screen recipe, offset so its top-left element sits at 0,0.
const OX = 210, OY = 46;
const R = (x: number, y: number, w: number, hgt: number): Rect => [x - OX, y - OY, w, hgt];

/**
 * Title screen, laid out from the pack's title recipe: the name on a red banner
 * over gears and cables. It doubles as the loading screen: a progress bar shows
 * where the buttons go until the game is ready.
 */
export class TitleScreen {
  readonly el = document.getElementById('loading')!;
  private readonly bar = progressBar('wave', 1.25);
  private readonly msg = text('Loading models…', R(290, 296, 380, 30), 20, { class: 'msg' });
  private readonly box: HTMLElement;

  constructor() {
    // The recipe's EXIT plank (and the cable it hangs on) is left out: a browser tab has nothing to exit to.
    this.box = recipeBox(518, 424, 'title-box',
      art('gear_large_brown', R(210, 188, 220, 220), 'decor gear'),
      art('gear_large_brown', R(537, 167, 190, 190), 'decor gear ccw'),
      art('gear_small_brown', R(608, 337, 108, 108), 'decor gear fast'),
      art('cable_loop_brown', R(300, 289, 360, 180), 'decor'),
      art('banner_title_red', R(232, 46, 496, 140)),
      // Kept between the banner's bolts (the recipe's rect is sized for a shorter name).
      fitText(text('CAP TOWER DEFENSE', R(312, 85, 336, 62), 57)),
      h('div', { class: 'loading-bar at', style: `left: ${R(330, 258, 0, 0)[0]}px; top: ${R(330, 258, 0, 0)[1]}px` }, this.bar.el),
      this.msg);
    this.el.replaceChildren(this.box);
  }

  setProgress(done: number, total: number): void {
    this.bar.set(done / total);
  }

  setMessage(message: string): void {
    this.msg.textContent = message;
  }

  /** Swaps the progress bar for PLAY! and SETTINGS. */
  ready(onPlay: () => void, onSettings: () => void): void {
    this.box.querySelector('.loading-bar')?.remove();
    this.msg.remove();
    const play = rectButton('red', R(310, 220, 340, 124), () => {
      this.el.classList.add('done');
      setTimeout(() => this.el.remove(), 450);
      onPlay();
    }, text('PLAY!', [83, 35, 174, 53], 53));
    play.classList.add('play');
    this.box.append(play,
      rectButton('blue', R(360, 351, 240, 88), onSettings, text('SETTINGS', [38, 23, 165, 39], 32)));
  }

  /** Skips the title (bench mode). */
  hide(): void {
    this.el.remove();
  }
}
