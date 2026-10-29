import './ui/theme.css';
import { App } from './engine/app';
import { loadModels } from './engine/assets';
import { SNOW_VARIANTS, Themes } from './engine/themes';
import type { Game } from './game';
import type { StageDef } from './meta/catalog';
import { Profile } from './meta/profile';
import { attachBenchHud } from './stage/bench-hud';
import { DECOR, GROUND_TILES, PATH_TILES } from './stage/map';
import { AMMO_FOR_WEAPON, WEAPON_TYPES } from './stage/sim';
import { ENEMY_MODELS, StageScreen, TOWER_STACK } from './stage/stage-screen';
import { hideLoading, setLoadingMessage, setLoadingProgress } from './ui/dom';
import { WORLD_MODELS, WorldScreen } from './world/world-screen';

const params = new URLSearchParams(location.search);

async function main() {
  const app = await App.create({ forceWebGL: params.has('webgl'), shadows: !params.has('noshadow') });

  const names = new Set([
    ...GROUND_TILES, ...PATH_TILES, ...DECOR, ...ENEMY_MODELS, ...TOWER_STACK, ...WEAPON_TYPES, ...AMMO_FOR_WEAPON,
    'weapon-ammo-boulder', ...WORLD_MODELS,
  ]);
  const models = await loadModels(Themes.withVariants([...names], SNOW_VARIANTS), setLoadingProgress);
  const themes = new Themes(models);
  await themes.load();
  setLoadingMessage('Building the world…');

  const profile = new Profile();
  let world: WorldScreen | null = null;
  const game: Game = {
    app,
    models,
    themes,
    profile,
    goToWorld(focus?: StageDef) {
      world ??= new WorldScreen(game);
      world.focusOn(focus ?? null);
      void app.show(world);
    },
    goToStage(stage, difficulty) {
      void app.show(new StageScreen(game, { kind: 'campaign', stage, difficulty }));
    },
  };

  // Console/test access: window.__game.app.screen…
  if (params.has('debug')) (window as unknown as { __game: Game }).__game = game;

  if (params.has('bench')) {
    // Endless stress test with the perf panel; used by bench/run.mjs.
    const stage = new StageScreen(game, { kind: 'bench', enemies: Number(params.get('n') ?? 1000) });
    await app.show(stage, false);
    attachBenchHud(app, stage, document.getElementById('ui')!, { record: params.has('record'), durationMs: Number(params.get('dur') ?? 5000) });
  } else {
    game.goToWorld();
  }
  hideLoading();
}

main().catch((err) => {
  setLoadingMessage(`Failed to start: ${err}`);
  console.error(err);
});
