// Emit a GEBCO GeoZarr kerchunk reference set to a JSON file so it can be hosted
// (e.g. on GitHub Pages) and opened by a zarrita ReferenceStore.
//
// Run: npm run emit:kerchunk   (writes public/gebco.kerchunk.json)
//      npx tsx scripts/emit-kerchunk.ts <cog-url> <out.json> <maxWidth>

import { writeFileSync } from "node:fs";
import { buildGeoZarrReferences } from "../src/geozarr.ts";

const URL_ =
  process.argv[2] ?? "https://data.source.coop/ausantarctic/gebco/GEBCO_2026.tif";
const OUT = process.argv[3] ?? "public/gebco.kerchunk.json";
const MAX_WIDTH = Number(process.argv[4] ?? 8192);

const result = await buildGeoZarrReferences(URL_, { maxWidth: MAX_WIDTH });
const json = JSON.stringify(result.references);
writeFileSync(OUT, json);

console.log(
  `wrote ${OUT}\n  variable=${result.variableName} level=${result.level} ` +
    `${result.height}x${result.width} dtype=${result.dtype} ` +
    `pred=${result.predictor} comp=${result.compression}\n  ` +
    `references=${Object.keys(result.references.refs).length} bytes=${json.length} ` +
    `lon=[${result.lonRange[0].toFixed(2)}, ${result.lonRange[1].toFixed(2)}] ` +
    `lat=[${result.latRange[0].toFixed(2)}, ${result.latRange[1].toFixed(2)}]`,
);
