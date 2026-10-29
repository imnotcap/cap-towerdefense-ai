# Cap Tower Defense – web app

TypeScript + three.js (`WebGPURenderer`, which uses WebGPU and falls back to WebGL2).
It started as the Phase 0 performance spike and now holds the campaign: a 3D world
map, the Armory shop and playable stages.

```bash
cd web
npm install
npm run dev          # http://localhost:5173
```

**Play it online:** https://imnotcap.github.io/cap-towerdefense-ai/ (GitHub Pages). Every
push to `main` or `claude/hopeful-darwin-dj148x` rebuilds the site
(`.github/workflows/pages.yml` publishes `web/dist` to the `gh-pages` branch).

URL options: `?webgl` forces the WebGL2 backend, `?noshadow` turns shadows off,
`?debug` exposes `window.__game` (profile, current screen, sim), `?notitle` skips the
title screen, and `?bench&n=5000` opens the perf stress test.

## Screens

**Title.** Doubles as the loading screen: the name on a red banner over turning gears,
with a progress bar that becomes PLAY! and SETTINGS once the game has loaded.

**World map (main screen).** A diorama island holding five themed regions:
Greenhollow, Sunscar Dunes, Frostpeak, Emberforge and Umbral Spire.

- One road runs through all five regions, with five stages along each stretch.
- Each region's last stage has a keep beside it. The road ends at the spire in the
  middle of the island, where a UFO patrol circles.
- Tiles are themed by the nearest stage, so the regions get natural borders. Themes
  come from palette swaps of the kit's single colormap (`tools/gen-palettes.py`)
  plus the kit's own `snow-*` models.
- Locked regions are greyscale and sit under drifting cloud banks. High clouds cast
  moving shadows, and the water rolls.
- Controls: drag to pan, right-drag to rotate, scroll to zoom. Clicking an area
  banner flies the camera there. Stage markers show stars earned, and the next
  unplayed stage bounces.
- A stage card shows waves, enemy toughness, your lives, the reward, and an
  Easy / Normal / Hard choice before you start the battle.

**Armory (shop).** Crystals earned in battle buy permanent upgrades:

| Tab | Upgrades |
|---|---|
| Towers | Cannon, Ballista and Turret each have Damage (+12%/lvl), Range (+6%/lvl) and Fire rate (+7%/lvl), 5 levels each |
| Commander | Fortified Base (+2 lives), Bounty Hunter (+10% crystals), Sharpshooter (+4% double-damage chance), War Chest (+30 starting gold), Engineering (−4% build/upgrade cost), Salvage Crew (+8% sell refund), Quick Hands (−8% ability cooldown) |
| Abilities | Meteor Strike (tap the map for area damage) and Deep Freeze (slows every enemy): unlock, then 3 power levels |

**Stage (battle).** Every stage has its own generated map (`src/stage/map.ts`), and each
area has its own style:

| Area | Roads | Landscape | Water | Landmarks |
|---|---|---|---|---|
| Greenhollow | long, gentle (4–7 bends) | copses, scattered rocks | streams with bridges | timber watchtowers |
| Sunscar Dunes | zig-zags (5–8 bends) | dune fields, rock outcrops | dry | sand-buried tower ruins |
| Frostpeak | switchbacks (7–11 bends) | pine forests, ice crystals | frozen streams | timber watchtowers |
| Emberforge | tight (7–11 bends) | basalt fields, fire crystals | lava rivers | ruined forges |
| Umbral Spire | most convoluted (9–13 bends) | crystal groves, dead woods | void streams | crystal spires |

The generator validates every map:
- Roads keep a clear tile between passes, don't hug the edge and don't make 1-tile jogs.
- Rivers meet the road only at right angles on straight stretches, where a bridge goes.
- Tiles beside the road are always buildable.

`npm run bench:maps` renders all 25 maps into one PNG for review.

The play area is ringed by mountains themed to the area. The road and any river run on
as real tiles through valleys in the mountains, so the map has no visible edge. Saucers
come out of a portal and head for your keep, which shakes when they get through. On
phones the camera starts closer. Drag (one finger) pans, right-drag (two fingers)
rotates, and the wheel (pinch) zooms.

- **Battle feedback:** health bars show over damaged saucers, and bosses always show
  one. The last wave of every stage ends with a boss (two on an area's final stage):
  huge health, costs 5 lives, pays 150 gold. A warning plank names the saucer that's
  coming, and the tab on the left of the card tray shows the next wave's size (a boss
  icon when one is in it).
- **Build anywhere open:** towers go on any tile that isn't road or covered by
  trees, rocks or crystals. Tiles next to the road are always open.
- **Placing mode:** pick Cannon (100), Ballista (80) or Turret (65) in the build
  bar, or press 1, 2 or 3. A see-through ghost tower and its range circle follow the
  pointer, green where it can go and red where it can't, and brackets mark open
  tiles near the pointer. Click to build; Shift keeps placing, Esc cancels. On touch, the first
  tap shows the ghost and range, and a second tap on the same tile builds.
- **Upgrade:** tap a tower for its info panel (docked on the right). It shows current
  → next damage, range and fire rate. Towers go up to level 3, and each level changes the tower's model
  stack. Hotkey: U.
- **Sell:** gives back 70% of everything spent on the tower (more with Salvage
  Crew). Hotkey: S.
- **Targeting:** First, Last, Strong (most health) or Close, set per tower.
- **Economy:** gold comes from kills (4–14 by enemy type), a bonus once a wave
  finishes spawning, and calling the next wave early (+2 gold per second skipped).
  Waves also start on their own after a 12 s pause. Space calls the wave.
- **Also on screen:** a 1×/2× speed toggle, the pause menu (audio, restart, exit; P or
  Esc), the Meteor (tap the map) and Freeze abilities if you own them, and a results
  screen with stars and crystals.
- Enemies get 10% more health with each wave. Starting gold and enemy health both
  scale along the campaign.

Progress (crystals, best stars per stage, upgrade levels) is saved in
`localStorage`. If storage is blocked, the game still runs with an in-memory profile.

## Code layout

```
src/
  main.ts              boot: renderer, asset load, screen routing
  game.ts              shared services passed to screens
  engine/              app/screen loop, GLB loading, instancing, static batching, tile helpers, themes
  meta/                catalog (areas, stages, shop items) and profile (save + upgrade modifiers)
  world/               world map screen, layout generator, shop modal
  stage/               stage screen, tower info panel, tower rules, map builder, fixed-step simulation, bench HUD
  ui/                  theme.css + generated scrapworks.css, DOM/recipe helpers, title screen, paper menus
```

## UI

The UI uses the **Scrapworks UI** pack with **Passion One Bold** for all display text.

- `python3 tools/import-scrapworks.py <dir with 1x/ 2x/> <manifest.json>` copies the
  pack's PNGs to `assets/ui/scrapworks/` unchanged and writes `src/ui/scrapworks.css`:
  one class per sprite holding its manifest size, label-safe rect, slice insets and an
  `image-set()` of the 1x/2x files. It also makes the gold/dim stars and dark-brown
  (`_ink`) versions of the cream icons for use on paper.
- Elements are sized by `--k` (1 = the 1x size). Plank buttons are 9-sliced with the
  manifest insets; paper and wood panels scale uniformly.
- The title screen, the pause/settings menu and the battle HUD follow the pack's
  layout recipes: `at()`, `art()`, `text()` and `rectButton()` in `src/ui/dom.ts` place
  elements at the recipes' pixel rects. Modal recipes zoom to fit the viewport; the
  HUD scales with `--hz` / `--tz` (smaller on phones, larger on big screens).
- Tower card art and the ability icons are rendered from the game's own 3D models:
  `npm run bench:previews` writes `assets/ui/art/<name>.png`.
- The Armory uses the red shop panel on wide screens (one column per tower, so the
  Towers tab needs no scrolling) and the tall dark panel with one scrolling column on
  phones. Scroll areas use the pack's scrollbar track and thumb (`scrollArea()`).

## Performance notes (Phase 0)

- **GPU instancing** is used for everything dynamic (enemies, weapons, projectiles,
  particles, clouds), so each model part costs one draw call regardless of count.
- **Static batching** bakes all scenery into one mesh per (material, shadow mode),
  with hidden-face culling at bake time. A stage costs 16 draw calls with the map
  empty, and static triangles are −32%. The world map rebuilds its terrain only when
  the set of unlocked areas changes.
- The simulation is a **fixed 60 Hz, zero-allocation, struct-of-arrays** loop. A
  spatial hash serves tower targeting, and enemies in wave mode use a free list.

CPU benchmark (`npm run bench:sim`, Node 22, 4-core cloud VM):

| Enemies | Sim ms/tick | Matrix sync ms | % of a 60 fps frame |
|---:|---:|---:|---:|
| 1,000 | 0.16 | 0.04 | 1.2% |
| 5,000 | 0.66 | 0.16 | 4.9% |
| 10,000 | 1.48 | 0.36 | 11.0% |

Balance check: `npm run bench:balance` has a simple bot play sample stages with a
given share of the shop bought. Right now each area is beatable with the upgrades a
player can afford by then, and the finale is a deliberate wall: the bot (which never
uses abilities) wins it with the full shop.

GPU frame rates still need real hardware; the cloud VM only has software
rendering. To measure on a machine with a GPU, first build:

```bash
npm run build
```

Then run the browser bench on the WebGPU backend:

```bash
npm run bench -- --shots
```

Or on the WebGL2 fallback:

```bash
npm run bench -- --shots --webgl
```

Known GPU risk: each UFO is ~500 triangles. Enemy LODs or impostors and blob
shadows are needed before large hordes on low-end devices.

## Assets

- `assets/models/kenney-td/`: Kenney Tower Defense Kit, CC0 (models, preview icons, palettes)
- `assets/ui/kenney-ui/`: Kenney UI Pack, CC0 (only its click/switch sounds are used now)
- `assets/ui/scrapworks/`: Scrapworks UI pack (see its `LICENSE-NOTE.txt`)
- `assets/ui/fonts/`: Passion One Bold, SIL Open Font License (`PassionOne-OFL.txt`)
- `assets/ui/art/`: tower card art and ability icons rendered from the Kenney models

Theme palettes are generated with `python3 tools/gen-palettes.py`.
