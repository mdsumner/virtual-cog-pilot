// Headless integration test for the full virtualization + zarrita pipeline.
// Runs the real code paths (geotiff IFD parse -> kerchunk refs -> ReferenceStore
// -> zarr.open.v2 -> zlib + tiff_predictor decode) in Node, no browser needed.
//
// Run: npm run test:store   (or: npx tsx scripts/test-store.ts [url])

import * as zarr from "zarrita";
import { VirtualCogStore } from "../src/VirtualCogStore.ts";

const URL_ =
  process.argv[2] ??
  "https://sentinel-cogs.s3.us-west-2.amazonaws.com/sentinel-s2-l2a-cogs/55/G/CP/2022/11/S2B_55GCP_20221106_0_L2A/B04.tif";

// Known-good first-row values from scripts/validate.mjs (geotiff's own decode).
const EXPECTED_HEAD = [212, 228, 249, 292, 348, 412, 438, 496];

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error("ASSERT FAILED: " + msg);
}

const store = new VirtualCogStore(URL_);
await store.init();

console.log("levels:");
for (const l of store.levels) {
  console.log(
    `  [${l.level}] ${l.width}x${l.height} chunk ${l.tileWidth}x${l.tileHeight} ` +
      `${l.dtype} comp=${l.compression} pred=${l.predictor} ` +
      `ref=${l.referenceable} tiles=${l.nReferencedTiles}/${l.nTiles}` +
      (l.reason ? ` (${l.reason})` : ""),
  );
}
const refs = store.toKerchunk().refs;
console.log(`\ncrs: ${JSON.stringify(store.crs)}`);
console.log(`total references: ${Object.keys(refs).length}`);
console.log(`kerchunk JSON bytes: ${store.toKerchunkJSON(0).length}`);

// Open the group and the full-resolution array through zarrita.
const grp = await zarr.open.v2(store.store, { kind: "group" });
const arr0 = await store.openArray(grp, "0");
console.log(`\narray '0' shape=${JSON.stringify(arr0.shape)} dtype=${arr0.dtype}`);

// Read the first 8 values of the first row -> exercises zlib + tiff_predictor.
const strip = await zarr.get(arr0, [zarr.slice(0, 1), zarr.slice(0, 8)]);
const head = Array.from(strip.data as ArrayLike<number>).slice(0, 8);
console.log("decoded head :", head);
console.log("expected head:", EXPECTED_HEAD);
assert(
  head.every((v, i) => v === EXPECTED_HEAD[i]),
  "decoded values via zarrita (zlib + tiff_predictor) must match geotiff's decode",
);

// Render-path smoke test: read the coarsest overview in full.
const coarse = store.referenceableLevels.at(-1)!;
const arrC = await store.openArray(grp, String(coarse.level));
const whole = await zarr.get(arrC);
console.log(
  `\ncoarsest level ${coarse.level}: read shape=${JSON.stringify(whole.shape)}, ` +
    `${whole.data.length} values`,
);

console.log("\n\u2705 full pipeline OK: refs -> ReferenceStore -> zarrita decode matches ground truth.");
