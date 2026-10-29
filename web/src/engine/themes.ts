import * as THREE from 'three/webgpu';
import type { Model } from './assets';

export type ThemeId = 'grass' | 'desert' | 'snow' | 'lava' | 'dark' | 'locked';

const TEXTURE_DIR = 'models/kenney-td/Textures/';
const PALETTES: Record<ThemeId, string | null> = {
  grass: null, // the kit's own colormap
  snow: null,
  desert: 'theme-desert.png',
  lava: 'theme-lava.png',
  dark: 'theme-dark.png',
  locked: 'theme-locked.png',
};

/** Background/fog tint that suits each theme. */
export const THEME_SKY: Record<ThemeId, number> = {
  grass: 0x9fc6e6,
  desert: 0xe8c99a,
  snow: 0xc9dcec,
  lava: 0x4a3030,
  dark: 0x2e2a45,
  locked: 0x9aa4ae,
};

/**
 * Re-themes Kenney models by swapping the palette texture on a clone of the
 * shared material (the whole kit samples one palette). The snow theme uses
 * the kit's dedicated `snow-*` models where they exist.
 */
export class Themes {
  private readonly materials = new Map<string, THREE.Material>();
  private readonly textures = new Map<ThemeId, THREE.Texture>();

  constructor(private readonly models: Map<string, Model>) {}

  /** Loads the palette textures; copies sampling settings from the kit's own texture. */
  async load(): Promise<void> {
    const base = this.baseMaterial().map!;
    const loader = new THREE.TextureLoader();
    await Promise.all(
      (Object.entries(PALETTES) as [ThemeId, string | null][]).map(async ([id, file]) => {
        if (!file) return;
        const tex = await loader.loadAsync(TEXTURE_DIR + file);
        tex.colorSpace = base.colorSpace;
        tex.flipY = base.flipY;
        tex.wrapS = base.wrapS;
        tex.wrapT = base.wrapT;
        tex.magFilter = base.magFilter;
        tex.minFilter = base.minFilter;
        tex.anisotropy = base.anisotropy;
        this.textures.set(id, tex);
      }),
    );
  }

  private baseMaterial(): THREE.MeshStandardMaterial {
    for (const model of this.models.values()) return model[0].material as THREE.MeshStandardMaterial;
    throw new Error('no models loaded');
  }

  private material(src: THREE.Material, theme: ThemeId): THREE.Material {
    const tex = this.textures.get(theme);
    if (!tex) return src;
    const key = `${src.uuid}:${theme}`;
    let m = this.materials.get(key);
    if (!m) {
      const clone = (src as THREE.MeshStandardMaterial).clone();
      clone.map = tex;
      this.materials.set(key, (m = clone));
    }
    return m;
  }

  /** The model `name` dressed for `theme` (e.g. `tile` → `snow-tile` for snow). */
  model(name: string, theme: ThemeId): Model {
    const variant = theme === 'snow' ? this.models.get(`snow-${name}`) : undefined;
    const model = variant ?? this.models.get(name);
    if (!model) throw new Error(`model not loaded: ${name}`);
    return model.map((part) => ({ ...part, material: this.material(part.material, theme) }));
  }

  /** Names that must be loaded for `names` to be available in every theme. */
  static withVariants(names: readonly string[], snowVariants: ReadonlySet<string>): string[] {
    return [...names, ...names.filter((n) => snowVariants.has(n)).map((n) => `snow-${n}`)];
  }
}

/** Kit models that ship a `snow-` variant. */
export const SNOW_VARIANTS: ReadonlySet<string> = new Set([
  'tile', 'tile-straight', 'tile-corner-square', 'tile-spawn', 'tile-end', 'tile-tree', 'tile-tree-double', 'tile-rock',
  'tile-hill', 'tile-crystal', 'detail-tree', 'detail-tree-large', 'detail-rocks', 'detail-crystal', 'tile-river-straight',
  'tile-river-corner', 'tile-river-bridge', 'wood-structure', 'detail-rocks-large', 'tile-tree-quad', 'detail-dirt',
]);
