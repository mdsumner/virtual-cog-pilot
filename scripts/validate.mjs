// Numeric proof-of-concept for the "true byte-reference" virtualization path.
//
// It does NOT use zarrita. It independently reproduces one COG tile by:
//   1. reading the IFD with geotiff.js (headers only, via range requests),
//   2. looking up that tile's [offset, byteCount] from TileOffsets/TileByteCounts,
//   3. range-fetching the raw compressed bytes,
//   4. inflating (DEFLATE) and undoing the horizontal predictor,
// then comparing the result to geotiff.js's own fully-decoded tile.
//
// If they match, the (url, offset, length) + {compressor, filter} reference set
// is sufficient to serve this COG as Zarr -- i.e. it is a valid kerchunk ref.
//
// Run: npm run validate            (uses the default Tasmania scene)
//      node scripts/validate.mjs <cog-url> [level] [tileY] [tileX]

import { fromUrl } from "geotiff";
import zlib from "node:zlib";

const URL_ =
  process.argv[2] ??
  "https://sentinel-cogs.s3.us-west-2.amazonaws.com/sentinel-s2-l2a-cogs/55/G/CP/2022/11/S2B_55GCP_20221106_0_L2A/B04.tif";
const LEVEL = Number(process.argv[3] ?? 0);
const TILE_Y = Number(process.argv[4] ?? 0);
const TILE_X = Number(process.argv[5] ?? 0);

function inflateMaybe(buf) {
  // TIFF "Adobe Deflate" (8) and "Deflate" (32946) are zlib-wrapped streams.
  try {
    return zlib.inflateSync(buf);
  } catch {
    return zlib.inflateRawSync(buf);
  }
}

// Map (SampleFormat, BitsPerSample) -> typed array constructor + zarr dtype string.
function dtypeFor(sampleFormat, bitsPerSample, littleEndian) {
  const bytes = bitsPerSample / 8;
  const bo = bytes === 1 ? "|" : littleEndian ? "<" : ">";
  if (sampleFormat === 3) {
    if (bytes === 4) return { Ctor: Float32Array, zarr: `${bo}f4` };
    if (bytes === 8) return { Ctor: Float64Array, zarr: `${bo}f8` };
  } else if (sampleFormat === 2) {
    if (bytes === 1) return { Ctor: Int8Array, zarr: `|i1` };
    if (bytes === 2) return { Ctor: Int16Array, zarr: `${bo}i2` };
    if (bytes === 4) return { Ctor: Int32Array, zarr: `${bo}i4` };
  } else {
    if (bytes === 1) return { Ctor: Uint8Array, zarr: `|u1` };
    if (bytes === 2) return { Ctor: Uint16Array, zarr: `${bo}u2` };
    if (bytes === 4) return { Ctor: Uint32Array, zarr: `${bo}u4` };
  }
  throw new Error(`unsupported dtype: sampleFormat=${sampleFormat} bits=${bitsPerSample}`);
}

// Undo TIFF horizontal differencing (Predictor=2) in place, per row, per sample.
// Integer wrap-around is handled automatically by the typed array.
function unpredictHorizontal(values, width, height, samples) {
  for (let s = 0; s < samples; s++) {
    for (let r = 0; r < height; r++) {
      const base = r * width * samples + s;
      for (let c = 1; c < width; c++) {
        values[base + c * samples] += values[base + (c - 1) * samples];
      }
    }
  }
}

const tiff = await fromUrl(URL_);
const count = await tiff.getImageCount();
const img = await tiff.getImage(LEVEL);
const fd = img.getFileDirectory(); // geotiff v3 ImageFileDirectory
const samples = img.getSamplesPerPixel();
const { Ctor, zarr } = dtypeFor(img.getSampleFormat(), img.getBitsPerSample(), tiff.littleEndian);

// geotiff v3 defers large tag arrays; resolve them with loadValue().
const compression = await fd.loadValue("Compression");
const predictor = (await fd.loadValue("Predictor")) ?? 1;
const planar = (await fd.loadValue("PlanarConfiguration")) ?? 1;
const tileOffsets = await fd.loadValue("TileOffsets");
const tileByteCounts = await fd.loadValue("TileByteCounts");

console.log("IFD[" + LEVEL + "]:", JSON.stringify({
  url: URL_,
  littleEndian: tiff.littleEndian,
  imageCount: count,
  width: img.getWidth(),
  height: img.getHeight(),
  tileWidth: img.getTileWidth(),
  tileHeight: img.getTileHeight(),
  compression,
  predictor,
  planarConfiguration: planar,
  samplesPerPixel: samples,
  sampleFormat: img.getSampleFormat(),
  bitsPerSample: img.getBitsPerSample(),
  zarrDtype: zarr,
  nodata: img.getGDALNoData?.(),
  nTiles: tileOffsets?.length,
}, null, 2));

const tw = img.getTileWidth();
const th = img.getTileHeight();
const tilesAcross = Math.ceil(img.getWidth() / tw);
const tileIndex = TILE_Y * tilesAcross + TILE_X;
const offset = Number(tileOffsets[tileIndex]);
const byteCount = Number(tileByteCounts[tileIndex]);
console.log(`\ntile[${TILE_Y}.${TILE_X}] reference => [offset=${offset}, length=${byteCount}]`);

// --- byte-reference path: range request -> inflate -> unpredict ---
const resp = await fetch(URL_, { headers: { Range: `bytes=${offset}-${offset + byteCount - 1}` } });
console.log("range request status:", resp.status, "(expect 206)");
const compressed = new Uint8Array(await resp.arrayBuffer());
const rawBytes = compression === 1 ? compressed : inflateMaybe(compressed);
const mine = new Ctor(rawBytes.buffer, rawBytes.byteOffset, Math.floor(rawBytes.byteLength / Ctor.BYTES_PER_ELEMENT));
if (predictor === 2) unpredictHorizontal(mine, tw, th, samples);

// --- reference decode via geotiff.js (applies deflate + predictor internally) ---
const ref = (await img.readRasters({ window: [TILE_X * tw, TILE_Y * th, TILE_X * tw + tw, TILE_Y * th + th], samples: [0], interleave: false }))[0];

// --- compare ---
let mismatches = 0, firstBad = -1;
const nCompare = Math.min(mine.length, ref.length);
for (let i = 0; i < nCompare; i++) {
  if (mine[i] !== ref[i]) { mismatches++; if (firstBad < 0) firstBad = i; }
}
console.log(`\ncompared ${nCompare} values; mismatches = ${mismatches}`);
console.log("mine[0..8] :", Array.from(mine.slice(0, 8)));
console.log("ref  [0..8]:", Array.from(ref.slice(0, 8)));
if (mismatches === 0) {
  console.log("\n\u2705 byte-reference path reproduces geotiff's decode exactly.");
} else {
  console.log(`\n\u274c first mismatch at index ${firstBad}: mine=${mine[firstBad]} ref=${ref[firstBad]}`);
}
