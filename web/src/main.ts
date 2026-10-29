import './ui/theme.css';
import { App } from './engine/app';
import { loadModels } from './engine/assets';
import { SNOW_VARIANTS, Themes } from './engine/themes';
import type { Game } from './game';
import { STAGES, type StageDef } from './meta/catalog';
import { Profile } from './meta/profile';
import { attachBenchHud } from './stage/bench-hud';
import { GATE_MODELS } from './stage/gates';
import { MAP_MODELS } from './stage/map';
import { AMMO_FOR_WEAPON, WEAPON_TYPES } from './stage/sim';
import { ENEMY_MODELS, STAGE_EXTRA_MODELS, StageScreen } from './stage/stage-screen';
import { TOWER_MODELS } from './stage/towers';
import { hideLoading, setLoadingMessage, setLoadingProgress } from './ui/dom';
import { WORLD_MODELS, WorldScreen } from './world/world-screen';

const params = new URLSearchParams(location.search);

async function main() {
  const app = await App.create({ forceWebGL: params.has('webgl'), shadows: !params.has('noshadow') });

  const names = new Set([
    ...MAP_MODELS, ...GATE_MODELS, ...ENEMY_MODELS, ...TOWER_MODELS, ...WEAPON_TYPES, ...AMMO_FOR_WEAPON,
    ...STAGE_EXTRA_MODELS, ...WORLD_MODELS,
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

  // Console/test access: window.__game.app.screen…, window.__stages
  if (params.has('debug')) Object.assign(window, { __game: game, __stages: STAGES });

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
