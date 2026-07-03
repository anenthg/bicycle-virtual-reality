// GLB asset registry. Preloads Higgsfield-generated meshes from public/models/,
// normalizes each into the game's coordinate system (origin on the ground,
// facing +Z, scaled to a target height), and hands out cheap clones.
//
// Every asset is OPTIONAL: if a GLB is missing or fails to load, callers fall
// back to the procedural mesh they already had. This lets us drop GLBs in one
// at a time and have each "light up" without breaking the build.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

export type AssetId =
  | 'rider'
  | 'pine'
  | 'palm'
  | 'house'
  | 'rock'
  | 'bale'
  | 'scooter'
  | 'chicken'
  | 'umbrella'
  | 'lamp';

interface AssetSpec {
  /** File under public/models/. */
  file: string;
  /** Target height in world units after normalization. */
  height: number;
  /**
   * Extra yaw (radians) so the model faces down the road (+Z). Meshy models
   * usually come out facing the camera (−Z / +Z depending on the source view);
   * tuned per asset once we see it.
   */
  yaw?: number;
  /** If true, drop the origin to the mesh's base (feet on the ground). */
  groundAlign?: boolean;
}

// Height/orientation targets. Only assets with a GLB present are used; the rest
// stay procedural. Heights match the procedural versions they replace.
const SPECS: Record<AssetId, AssetSpec> = {
  rider: { file: 'rider.glb', height: 1.85, yaw: Math.PI, groundAlign: true },
  pine: { file: 'pine.glb', height: 3.2, groundAlign: true },
  palm: { file: 'palm.glb', height: 4.6, groundAlign: true },
  house: { file: 'house.glb', height: 3.6, groundAlign: true },
  rock: { file: 'rock.glb', height: 1.1, groundAlign: true },
  // Bale is a dynamic body driven by its collider CENTER, so center-align it.
  bale: { file: 'bale.glb', height: 1.12, groundAlign: false },
  scooter: { file: 'scooter.glb', height: 1.15, yaw: Math.PI, groundAlign: true },
  chicken: { file: 'chicken.glb', height: 0.7, yaw: Math.PI, groundAlign: true },
  umbrella: { file: 'umbrella.glb', height: 2.4, groundAlign: true },
  lamp: { file: 'lamp.glb', height: 3.1, groundAlign: true },
};

const BASE = import.meta.env.BASE_URL ?? '/';

class AssetRegistry {
  // Meshopt decoder lets us load the compressed GLBs produced by
  // scripts (gltf-transform ... --compress meshopt).
  private loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  private prototypes = new Map<AssetId, THREE.Object3D>();
  private loaded = false;

  /** True once preload() has run (successfully or not). */
  get ready(): boolean {
    return this.loaded;
  }

  has(id: AssetId): boolean {
    return this.prototypes.has(id);
  }

  /**
   * Try to load every known GLB. Missing files are fine — they just leave the
   * asset absent, and callers fall back to procedural. Resolves when all
   * attempts settle so the title screen can gate on it.
   */
  async preload(): Promise<void> {
    const ids = Object.keys(SPECS) as AssetId[];
    await Promise.all(ids.map((id) => this.tryLoad(id)));
    this.loaded = true;
  }

  /** A ready-to-place clone (SkinnedMesh-safe via SkeletonUtils not needed —
   *  these are static meshes). Returns null if the asset has no GLB. */
  create(id: AssetId): THREE.Object3D | null {
    const proto = this.prototypes.get(id);
    if (!proto) return null;
    const clone = proto.clone(true);
    // clone() SHARES geometry/material with the prototype and every sibling
    // clone. Tag it so disposal paths (obstacles.destroy) never dispose the
    // shared buffers out from under other live instances.
    clone.userData.isGlbAsset = true;
    clone.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.castShadow = true;
        o.receiveShadow = false;
      }
    });
    return clone;
  }

  private async tryLoad(id: AssetId): Promise<void> {
    const spec = SPECS[id];
    const url = `${BASE}models/${spec.file}`;
    try {
      const gltf = await this.loader.loadAsync(url);
      const proto = this.normalize(gltf.scene, spec);
      this.prototypes.set(id, proto);
    } catch {
      // No GLB (or bad file) — stay procedural. Quietly.
    }
  }

  /**
   * Wrap the loaded scene in a normalized pivot group:
   *   outer (yaw applied, origin = ground contact point, +Z = forward)
   *     └─ scene (offset + uniformly scaled to target height)
   * Returns the outer group as the clonable prototype.
   */
  private normalize(scene: THREE.Object3D, spec: AssetSpec): THREE.Object3D {
    scene.updateWorldMatrix(true, true);
    const box = new THREE.Box3().setFromObject(scene);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);

    const scale = spec.height / Math.max(size.y, 1e-3);

    // Offset so the scene is centered X/Z and its base (or center) sits at y=0,
    // THEN scale. Because offset is applied in the scene's own space and the
    // group scales the whole thing, pre-scale the offset by `scale`.
    scene.position.set(
      -center.x * scale,
      (spec.groundAlign ? -box.min.y : -center.y) * scale,
      -center.z * scale,
    );
    scene.scale.setScalar(scale);

    // Meshy PBR materials can read too metallic/shiny under our sun. Tame it so
    // they match the game's soft look, and make sure textures decode as sRGB.
    scene.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.castShadow = true;
        const fix = (mat: THREE.MeshStandardMaterial) => {
          if (mat.metalness !== undefined) mat.metalness = Math.min(mat.metalness, 0.1);
          mat.roughness = Math.max(mat.roughness ?? 1, 0.6);
          if (mat.map) mat.map.colorSpace = THREE.SRGBColorSpace;
          mat.needsUpdate = true;
        };
        const m = o.material as THREE.MeshStandardMaterial | THREE.MeshStandardMaterial[];
        if (Array.isArray(m)) m.forEach(fix);
        else if (m) fix(m);
      }
    });

    const outer = new THREE.Group();
    outer.rotation.y = spec.yaw ?? 0;
    outer.add(scene);
    return outer;
  }
}

export const assets = new AssetRegistry();
