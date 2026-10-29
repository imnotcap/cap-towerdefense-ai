# Cap Tower Defense – Project Plan

A browser tower-defense game. A 3D world map lets the player travel between
themed areas, each holding several stages. Stages are played from a top-down
(slightly tilted) camera with semi-realistic models and animation.

## 1. Tech stack (performance first)

| Layer | Choice | Why |
|---|---|---|
| Language | **Rust** → WebAssembly | Near-native speed, no GC pauses, predictable frame times |
| Engine | **Bevy** (ECS, trimmed features) on **wgpu** | Data-oriented ECS suits hundreds of enemies/projectiles; wgpu uses **WebGPU** with automatic **WebGL2 fallback** |
| Shell | One static `index.html` + tiny JS loader | Loading bar, fullscreen, resize, audio unlock; all game logic stays in Rust |
| Build | `cargo` + `trunk` (or `wasm-bindgen`), `wasm-opt -O3`, LTO, `opt-level="s"` for size | Small, fast bundle; brotli on the host |
| Assets | **glTF/GLB**, **KTX2/Basis** textures, **meshopt**-compressed meshes | Small downloads, GPU-ready textures |
| Hosting | Any static host/CDN (Cloudflare Pages, GitHub Pages) | No backend needed for v1 |
| Saves | `localStorage`/IndexedDB via `web-sys` | Progress, stars, settings |

Fallback if bundle size matters more than engine features: custom `wgpu` + `hecs`
(smaller wasm, more work). Decide after the Phase 0 size/perf spike.

Performance rules: GPU instancing for enemies/projectiles/props, one shadow-casting
directional light with cascaded-lite shadow map, baked lighting + light probes for the map,
GPU skinning, LOD + frustum culling, object pools (no per-frame allocation), fixed 60 Hz
simulation tick decoupled from render, flow-field pathfinding computed on map change only,
spatial hash grid for tower targeting. Budget: 60 fps on integrated GPU/mid phone,
<10 MB gzip initial load, stage assets streamed on demand.

## 2. Game structure

```
Boot → Main Menu → World Map (3D) → Stage Select → Loadout → Stage (top-view) → Results → World Map
```

### World map (main screen)
- Stylised 3D diorama/globe of the realm, orbit/pan/zoom camera with smooth easing.
- Each **area** is a distinct region with its own look; locked areas shrouded in fog.
- Roads/paths between areas; animated markers (flags, smoke, water, wildlife).
- Click/tap an area → camera fly-to → stage nodes appear (stars earned, difficulty skulls).
- Day/night and weather ambience per region.

### Areas (initial set of 5, ~5 stages each = 25 stages)
| Area | Theme | Special mechanics | Difficulty |
|---|---|---|---|
| Greenhollow | Forest/farmland | Tutorial, basic enemies | ★ |
| Sunscar Dunes | Desert, ruins | Sandstorms reduce range; burrowing enemies | ★★ |
| Frostpeak | Snow, ice lakes | Ice slows towers' fire rate; frozen shortcut paths | ★★★ |
| Emberforge | Volcano, lava | Lava hazards; fire-immune enemies | ★★★★ |
| Umbral Spire | Dark/arcane city | Teleporting enemies, multi-lane paths | ★★★★★ |

### Stage gameplay
- Grid/buildable pads over authored paths; branching paths and multiple spawn points.
- Waves defined in data (RON/JSON): enemy type, count, spawn interval, lane.
- Economy: gold per kill, interest between waves, sell/upgrade refunds.
- Towers (8 at launch): Archer, Cannon (splash), Frost, Tesla (chain), Mortar (long range),
  Barracks (blockers), Poison, Support/Buff. Each has 3 upgrade tiers + 1 branch choice.
- Enemies (12+): grunt, runner, tank, flyer, shielded, healer, splitter, burrower, boss per area.
- Damage types vs armor/resist; status effects (slow, burn, poison, stun).
- Player abilities: meteor, freeze, reinforcements (cooldown-based).
- Difficulty: Easy / Normal / Hard per stage; star rating by lives left. Endless mode unlocked later.

## 3. Visuals & animation
- **Camera:** top-down, ~60–70° tilt, subtle parallax; pinch/scroll zoom, edge pan.
- **Models:** semi-realistic PBR, low-poly budget (towers ≤5k tris, enemies ≤3k, props instanced).
  Authored in Blender → GLB with skeletal animations (idle/walk/attack/death).
- **Animation:** GPU-skinned enemy walk/attack/death, tower recoil and rotating turrets,
  projectile trails, hit flashes, upgrade/construct "build-up" animation, boss intros.
- **Effects:** GPU particles (fire, ice, smoke, sparks), decals for craters, water shader,
  foliage wind sway (vertex shader), volumetric-fake fog, bloom + tonemapping, SSAO-lite (optional on high).
- **UI:** in-engine HUD (bevy_ui) – wave bar, gold, lives, tower radial menu, damage numbers.
- **Quality presets:** Low / Medium / High, auto-picked from a short first-run benchmark.
- **Audio:** spatial SFX, per-area music, mixer with mute persisted.

## 4. Architecture (Rust crates / modules)

```
cap-towerdefense-ai/
├─ Cargo.toml                (workspace)
├─ index.html, web/          (shell, loader, styles)
├─ crates/
│  ├─ td_core/               pure game logic, no rendering (unit-testable, deterministic)
│  │   ├─ grid, pathing (flow field), waves, combat, economy, status effects
│  ├─ td_render/             materials, shaders (WGSL), instancing, particles, post-fx
│  ├─ td_world/              world-map scene, camera, area/stage data
│  ├─ td_game/               stage scene, input, HUD, state machine
│  └─ td_app/                Bevy app entry, plugins, wasm bindings
├─ assets/
│  ├─ models/ textures/ audio/ shaders/
│  └─ data/  areas.ron  stages/*.ron  towers.ron  enemies.ron
└─ tools/                    asset pipeline (gltf-transform, toktx), stage validator
```

Key design points: data-driven content (new stage = new RON file), game-state machine
(`Boot, Menu, WorldMap, Stage, Results`), deterministic fixed-step sim (enables replays and
tests), rendering reads sim state only.

## 5. Milestones

| Phase | Deliverable | Exit criteria |
|---|---|---|
| 0. Spike (1 wk) | Rust+Bevy→WASM page with instanced animated mesh, 1k enemies | 60 fps on mid laptop; gz size measured; stack confirmed |
| 1. Core sim (2 wk) | `td_core`: grid, flow-field, waves, 3 towers, tests; debug top-view | Headless sim test clears a sample wave set |
| 2. Stage vertical slice (3 wk) | Greenhollow stage 1 fully playable with PBR models, animations, HUD, SFX | Fun, stable 60 fps, <10 MB initial |
| 3. World map (2 wk) | 3D map, area fly-to, stage select, save/progress, fog-locked areas | Navigate all 5 areas (placeholder stages) |
| 4. Content (6 wk) | 5 areas × 5 stages, 8 towers, 12 enemies, 5 bosses, abilities | All stages beatable on each difficulty; balance pass |
| 5. Polish (3 wk) | Particles, post-fx, quality presets, audio, tutorial, settings, touch controls | Lighthouse/perf budgets met; playtests |
| 6. Release | CI build, brotli, CDN deploy, analytics-free telemetry opt-in, PWA offline | Public URL |

## 6. Testing & quality
- `td_core` unit + property tests (pathing never blocked, wave determinism).
- Stage validator tool: every path connected, pads reachable, waves reference existing enemies.
- Headless "bot" playthrough in CI to catch balance regressions.
- Perf CI: frame-time and wasm-size budgets fail the build when exceeded.
- Browser matrix: Chrome/Edge (WebGPU), Firefox/Safari (WebGL2 fallback), mobile Chrome/Safari.

## 7. Risks
| Risk | Mitigation |
|---|---|
| Bevy wasm size/load time | Disable unused features, `wasm-opt`, brotli, lazy-load stage assets; fallback to custom wgpu+hecs |
| Safari/Firefox WebGPU gaps | wgpu WebGL2 backend, restricted shader features on Low |
| Art workload (semi-realistic models) | Shared kit-bash props, palette-swapped enemies per area, CC0 asset starting point |
| Mobile thermals | Quality presets, 30 fps cap option, fewer shadows/particles |

## 8. Open questions
1. Asset source: buy/CC0 packs vs. custom Blender work?
2. Mobile as a first-class target, or desktop-first with touch later?
3. Any backend (leaderboards, cloud saves) in v1, or fully offline?
