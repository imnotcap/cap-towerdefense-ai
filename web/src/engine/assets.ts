import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const MODEL_DIR = 'models/kenney-td/';

/** One drawable piece of a model: geometry baked into model space. */
export interface ModelPart {
  name: string;
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  /** Parts named barrel/arrow can be offset (recoil) at runtime. */
  movable: boolean;
}

export type Model = ModelPart[];

const MOVABLE_NODES = new Set(['barrel', 'arrow']);

/**
 * Loads GLB files and flattens each into baked parts. Materials are shared by
 * name across files (the whole Kenney kit uses one "colormap" material), so
 * every model ends up drawing with the same material and texture.
 */
export async function loadModels(
  names: readonly string[],
  onProgress?: (done: number, total: number) => void,
): Promise<Map<string, Model>> {
  THREE.Cache.enabled = true;
  const loader = new GLTFLoader();
  const shared = new Map<string, THREE.Material>();
  const out = new Map<string, Model>();
  let done = 0;

  await Promise.all(
    names.map(async (name) => {
      const gltf = await loader.loadAsync(`${MODEL_DIR}${name}.glb`);
      const root = gltf.scene;
      root.updateMatrixWorld(true);
      const parts: ModelPart[] = [];
      root.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (!mesh.isMesh) return;
        const geometry = mesh.geometry.clone();
        geometry.applyMatrix4(mesh.matrixWorld);
        const src = mesh.material as THREE.MeshStandardMaterial;
        let material = shared.get(src.name);
        if (!material) {
          material = src;
          if (src.map) {
            src.map.anisotropy = 4;
          }
          shared.set(src.name, material);
        }
        // Kenney nests the barrel as a child node; the parent node is named after the model.
        const nodeName = mesh.name || mesh.parent?.name || '';
        parts.push({ name: nodeName, geometry, material, movable: MOVABLE_NODES.has(nodeName) });
      });
      out.set(name, parts);
      onProgress?.(++done, names.length);
    }),
  );
  return out;
}

const heights = new WeakMap<THREE.BufferGeometry, number>();

/** Top of a model above its origin (for stacking tower parts). */
export function modelHeight(model: Model): number {
  let top = 0;
  for (const p of model) {
    let h = heights.get(p.geometry);
    if (h === undefined) {
      p.geometry.computeBoundingBox();
      h = p.geometry.boundingBox!.max.y;
      heights.set(p.geometry, h);
    }
    top = Math.max(top, h);
  }
  return top;
}
