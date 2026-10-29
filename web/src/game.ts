import type { App } from './engine/app';
import type { Model } from './engine/assets';
import type { Themes } from './engine/themes';
import type { Difficulty, StageDef } from './meta/catalog';
import type { Profile } from './meta/profile';

/** Shared services every screen gets. */
export interface Game {
  app: App;
  models: Map<string, Model>;
  themes: Themes;
  profile: Profile;
  /** Navigation; implemented in main.ts so screens don't import each other. */
  goToWorld(focus?: StageDef): void;
  goToStage(stage: StageDef, difficulty: Difficulty): void;
}
