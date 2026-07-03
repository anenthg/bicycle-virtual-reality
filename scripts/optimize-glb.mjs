// Compress a Higgsfield/Meshy GLB for the web via gltf-transform:
//   node scripts/optimize-glb.mjs <in.glb> <out.glb> [textureSize=1024]
//
// Resizes/re-encodes textures to WebP and applies Meshopt geometry
// compression. Typical result: ~12 MB -> ~0.7-1.5 MB. The asset loader wires
// MeshoptDecoder so the output loads directly in Three.js.
import { spawnSync } from 'node:child_process';

const [, , inPath, outPath, sizeArg] = process.argv;
if (!inPath || !outPath) {
  console.error('usage: node scripts/optimize-glb.mjs <in.glb> <out.glb> [textureSize]');
  process.exit(1);
}
const texSize = String(sizeArg ?? 1024);

const r = spawnSync(
  'npx',
  ['gltf-transform', 'optimize', inPath, outPath,
    '--texture-size', texSize, '--texture-compress', 'webp', '--compress', 'meshopt'],
  { stdio: 'inherit', shell: true },
);
process.exit(r.status ?? 0);
