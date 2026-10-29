# Phase 0 – Performance spike (TypeScript + three.js)

A stress-test of the core rendering and simulation loop. It uses the Kenney Tower
Defense Kit models and the Kenney UI Pack theme.

The plan called for a Rust + Bevy → WASM spike. That build environment had no access
to crates.io or the wasm32 target, so this spike uses TypeScript + three.js with
`WebGPURenderer`. That renderer uses WebGPU where the browser supports it and falls
back to WebGL2. The numbers below are the baseline the Rust build has to beat.

## Run

```bash
cd spike
npm install
npm run dev          # http://localhost:5173
```

URL options: `?n=5000` sets the starting enemy count, `?webgl` forces the WebGL2
backend, and `?noshadow` turns shadows off.

## What it does

- A 22×16 tile map is built from Kenney tiles. Path tiles (straight, corner, spawn,
  end) are oriented automatically from the path, and the scenery is placed from a
  seeded random generator.
- There are 27 towers (cannon, ballista, turret). Each turret turns toward its
  target, its barrel recoils when it fires, and the projectiles are homing. The
  cannon does splash damage.
- 250–10,000 UFO enemies loop the path. They hover and spin, which is procedural
  animation because the kit ships no skeletal clips. When a projectile kills one,
  it gives a particle burst.
- The simulation runs at a fixed 60 Hz and is decoupled from the render rate. It is
  zero-allocation and stores data as struct-of-arrays. A spatial hash grid, rebuilt
  every tick with a counting sort, is used for tower targeting.

## Optimizations

| Technique | Effect |
|---|---|
| **GPU instancing** for every dynamic object (enemies, weapons, projectiles, particles) | 1 draw call per model part, regardless of count |
| **Static batching**: terrain, decor and tower stacks are baked into one mesh per (material, shadow mode) | Empty map: **47 → 16 draw calls** (including the shadow pass) |
| **Hidden-face culling** at bake time: tile bottoms and side walls shared between adjacent tiles | Static triangles **−32%** (≈68k → 46k) |
| **Flat tiles don't cast shadows** | Ground skips the shadow pass entirely |
| **Shared material**: the whole kit uses one `colormap` texture | One shader/texture for all scenery |
| **Enemy shadows off above 2,500 enemies** | Each UFO is ~500 tris; the shadow pass doubled that |
| Matrices are written straight into the instance buffers (yaw + uniform scale), with partial buffer uploads | Matrix sync for 10k enemies ≈ 0.3 ms |
| Camera auto-fit (binary search on corner projection) | The whole map is framed on any aspect ratio, phone portrait included |

## Results

CPU cost of the simulation (`npm run bench:sim`, Node 22, 4-core cloud VM):

| Enemies | Sim ms/tick | Matrix sync ms | % of a 60 fps frame |
|---:|---:|---:|---:|
| 1,000 | 0.15 | 0.03 | 1.1% |
| 2,500 | 0.33 | 0.08 | 2.4% |
| 5,000 | 0.73 | 0.17 | 5.4% |
| 10,000 | 1.41 | 0.33 | 10.5% |
| 20,000 | 2.74 | 0.69 | 20.6% |

**Not yet measured: GPU frame rates.** The cloud VM has no GPU. Chromium's software
WebGL is too erratic to measure, with frames swinging between 15 ms and 1.8 s on the
same scene. Software WebGPU (SwiftShader Vulkan) fails outright. The WebGPU backend
has therefore not been seen running yet, and needs a check on real hardware.

To get the real numbers on a machine with a GPU:

```bash
npm run build
npm run bench -- --shots                 # WebGPU
npm run bench -- --shots --webgl         # WebGL2 fallback
```

The bench runs the built game in headless Chromium at 250–10,000 enemies. It reports
average and p95 frame time, CPU time, draw calls and triangles. Bundle size is
**245 kB gzip** for the JS, plus about 0.6 MB of models for a stage.

## Findings for the plan

1. The simulation is not the bottleneck: 10k enemies cost about 1.7 ms of CPU per
   tick in plain TypeScript. The cost to watch is **GPU vertex load**. 1,000 enemies
   is about 1.1M triangles per frame including shadows. Before content production we
   need enemy LODs (a 100–150-tri far LOD) or impostors, and blob shadows instead of
   shadow-mapped enemies.
2. Instancing and static batching keep draw calls flat at roughly 16–30 no matter
   how many enemies there are.
3. The Kenney kit is stylised low-poly, not semi-realistic, and has no skeletal
   animation. It works for prototyping. Semi-realistic art would need skinned models
   (GPU skinning, instanced animation textures). That's a budget question for
   Phase 2.
4. The Rust/WASM decision still needs a GPU-backed comparison. With the simulation
   at about 10% of the frame budget at 10k enemies, Rust's main win would be
   headroom and determinism, not raw necessity.
