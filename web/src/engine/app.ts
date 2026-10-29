import * as THREE from 'three/webgpu';

/** A full-screen game state (world map, stage…) with its own scene, camera and DOM overlay. */
export interface Screen {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  /** `ui` is an empty overlay element owned by the screen until `exit`. */
  enter(ui: HTMLElement): void;
  exit(): void;
  update(dt: number, time: number): void;
  resize(width: number, height: number): void;
}

/** Owns the renderer and frame loop, and swaps screens with a short fade. */
export class App {
  private current: Screen | null = null;
  private last = performance.now();
  private readonly ui = document.getElementById('ui')!;
  private readonly fade = document.getElementById('fade')!;
  /** Called after each rendered frame (perf HUD, bench). */
  onFrame: ((frameMs: number) => void) | null = null;

  private constructor(readonly renderer: THREE.WebGPURenderer, readonly backend: 'WebGPU' | 'WebGL2') {}

  static async create(opts: { forceWebGL: boolean; shadows: boolean }): Promise<App> {
    const renderer = new THREE.WebGPURenderer({ antialias: true, forceWebGL: opts.forceWebGL });
    await renderer.init();
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setSize(innerWidth, innerHeight);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.shadowMap.enabled = opts.shadows;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    document.body.prepend(renderer.domElement);
    const backend = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'WebGPU' : 'WebGL2';
    const app = new App(renderer, backend);
    addEventListener('resize', () => {
      renderer.setSize(innerWidth, innerHeight);
      app.current?.resize(innerWidth, innerHeight);
    });
    renderer.setAnimationLoop(() => app.frame());
    return app;
  }

  get screen(): Screen | null {
    return this.current;
  }

  get canvas(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  /** Switches screens. With `fade`, the old screen stays up until the fade covers it. */
  async show(next: Screen, fade = true): Promise<void> {
    if (fade && this.current) {
      this.fade.classList.add('on');
      await new Promise((r) => setTimeout(r, 260));
    }
    this.current?.exit();
    this.ui.replaceChildren();
    this.current = next;
    next.resize(innerWidth, innerHeight);
    next.enter(this.ui);
    this.last = performance.now();
    this.fade.classList.remove('on');
  }

  private frame(): void {
    const now = performance.now();
    const frameMs = now - this.last;
    this.last = now;
    const screen = this.current;
    if (!screen) return;
    screen.update(Math.min(0.25, frameMs / 1000), now / 1000);
    this.renderer.render(screen.scene, screen.camera);
    this.onFrame?.(frameMs);
  }
}
