// Tiny download helper: node scripts/fetch-asset.mjs <url> <outPath>
// Used to pull Higgsfield-generated images (for review) and GLB meshes
// (into public/models/) without shelling out to curl.
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const [, , url, out] = process.argv;
if (!url || !out) {
  console.error('usage: node scripts/fetch-asset.mjs <url> <outPath>');
  process.exit(1);
}
const res = await fetch(url);
if (!res.ok) {
  console.error(`fetch failed: ${res.status} ${res.statusText}`);
  process.exit(1);
}
const buf = Buffer.from(await res.arrayBuffer());
await mkdir(dirname(out), { recursive: true });
await writeFile(out, buf);
console.log(`saved ${buf.length} bytes -> ${out}`);
