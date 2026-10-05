// Headless check that the GeoZarr (gridlook) path produces a dataset gridlook
// would recognise as a regular lat/lon grid, and that coordinates + data decode.
//
// Run: npm run test:gridlook   (or: npx tsx scripts/test-gridlook.ts [url])

import * as zarr from "zarrita";
import { VirtualCogStore } from "../src/VirtualCogStore.ts";

const URL_ =
  process.argv[2] ?? "https://data.source.coop/ausantarctic/gebco/GEBCO_2026.tif";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error("ASSERT FAILED: " + msg);
}

const store = new VirtualCogStore(URL_, { layout: "gridlook" });
await store.init();

console.log(
  `variable="${store.dataVariable}" level=${store.geo?.level} ` +
    `shape=${store.geo?.height}x${store.geo?.width} dtype=${store.geo?.dtype} ` +
    `pred=${store.geo?.predictor} comp=${store.geo?.compression}`,
);
console.log(`crs: ${JSON.stringify(store.crs)}`);
console.log(`references: ${Object.keys(store.toKerchunk().refs).length}, kerchunk bytes: ${store.toKerchunkJSON(0).length}`);

const grp = await zarr.open.v2(store.store, { kind: "group" });
const arr = await store.openArray(grp, store.dataVariable!);
console.log(`\n${store.dataVariable} dimensionNames:`, arr.dimensionNames);
assert(
  JSON.stringify(arr.dimensionNames) === JSON.stringify(["lat", "lon"]),
  'data variable must have dimensionNames ["lat","lon"] for gridlook REGULAR detection',
);

const lat = await store.openArray(grp, "lat");
const lon = await store.openArray(grp, "lon");
const latData = await zarr.get(lat);
const lonData = await zarr.get(lon);
const la = latData.data as Float64Array;
const lo = lonData.data as Float64Array;
console.log(`lat: ${la[0].toFixed(3)} .. ${la[la.length - 1].toFixed(3)} (n=${la.length})`);
console.log(`lon: ${lo[0].toFixed(3)} .. ${lo[lo.length - 1].toFixed(3)} (n=${lo.length})`);
assert(la[0] > 80 && la[la.length - 1] < -80, "latitude should span ~ +90 .. -90");
assert(lo[0] < -170 && lo[lo.length - 1] > 170, "longitude should span ~ -180 .. 180");

// Decode a data window (exercises zlib + tiff_predictor on Int16).
const win = await zarr.get(arr, [zarr.slice(0, 4), zarr.slice(0, 4)]);
const vals = Array.from(win.data as ArrayLike<number>);
console.log("\nsample data window (top-left 4x4):", vals);
assert(
  vals.some((v) => v !== store.geo?.crs && Number.isFinite(v)),
  "data window should decode to finite values",
);

console.log("\n\u2705 GeoZarr path is gridlook-ready: regular lat/lon dims, coords, and decodable data.");
