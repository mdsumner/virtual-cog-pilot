// Open a hosted kerchunk JSON through zarrita's ReferenceStore, mirroring the
// exact load path gridlook would use (ReferenceStore.fromUrl -> consolidated
// metadata -> zarr.open.v2 -> decode). Proves the hosted references are usable.
//
// Needs the TIFF predictor filter registered (gridlook would need the same).
//
// Run: npx tsx scripts/open-reference.ts <url-to-kerchunk.json>

import * as zarr from "zarrita";
import ReferenceStore from "@zarrita/storage/ref";
import { registerTiffPredictor } from "../src/tiffPredictor.ts";

const URL_ = process.argv[2] ?? "http://localhost:8111/gebco.kerchunk.json";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error("ASSERT FAILED: " + msg);
}

registerTiffPredictor();

console.log(`fetching references: ${URL_}`);
const refStore = (await ReferenceStore.fromUrl(URL_)) as any;

// Mirror gridlook: wrap with consolidated metadata if available.
let store: any = refStore;
const withConsolidated = (zarr as any).withConsolidatedMetadata;
if (typeof withConsolidated === "function") {
  try {
    store = await withConsolidated(refStore, { format: "v2" });
    console.log("using consolidated metadata (.zmetadata)");
  } catch (e) {
    console.log("consolidated metadata unavailable, plain open:", (e as Error).message);
  }
}

const grp = await zarr.open.v2(store, { kind: "group" });
console.log("group attrs:", JSON.stringify(grp.attrs));

const arr = await zarr.open.v2(zarr.root(store).resolve("elevation"), { kind: "array" });
console.log(`elevation: dims=${JSON.stringify(arr.dimensionNames)} shape=${JSON.stringify(arr.shape)} dtype=${arr.dtype}`);
assert(
  JSON.stringify(arr.dimensionNames) === JSON.stringify(["lat", "lon"]),
  'elevation must expose dimensionNames ["lat","lon"]',
);

const lat = await zarr.open.v2(zarr.root(store).resolve("lat"), { kind: "array" });
const lon = await zarr.open.v2(zarr.root(store).resolve("lon"), { kind: "array" });
const la = (await zarr.get(lat)).data as Float64Array;
const lo = (await zarr.get(lon)).data as Float64Array;
console.log(`lat: ${la[0].toFixed(3)} .. ${la[la.length - 1].toFixed(3)} (n=${la.length})`);
console.log(`lon: ${lo[0].toFixed(3)} .. ${lo[lo.length - 1].toFixed(3)} (n=${lo.length})`);

// Decode a data window (zlib + tiff_predictor) fetched over HTTP via range refs.
const win = await zarr.get(arr, [zarr.slice(0, 4), zarr.slice(0, 4)]);
console.log("elevation[0:4,0:4]:", Array.from(win.data as ArrayLike<number>));

console.log("\n\u2705 hosted kerchunk JSON opens via zarrita ReferenceStore (gridlook's load path).");
