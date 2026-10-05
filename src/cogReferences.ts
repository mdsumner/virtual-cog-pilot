// Turn a remote COG into a kerchunk-style reference set, on the fly, by reading
// only its IFD headers (via HTTP range requests). No pixel data is decoded here.
//
// The output `references` is a kerchunk v1 object:
//   { version: 1, refs: { "<key>": <value>, ... } }
// where metadata keys (".zgroup", "<level>/.zarray", ...) map to inline JSON
// strings and chunk keys ("<level>/<y>.<x>") map to [url, byteOffset, byteLength].
//
// That object is simultaneously (a) something zarrita's ReferenceStore can open
// and render, and (b) an artifact you can serialize to disk and later convert to
// kerchunk Parquet / VirtualiZarr / Icechunk.

import { fromUrl } from "geotiff";
import { TIFF_PREDICTOR_ID } from "./tiffPredictor";

export interface LevelInfo {
  level: number;
  width: number;
  height: number;
  tileWidth: number;
  tileHeight: number;
  compression: number;
  predictor: number;
  dtype: string;
  samplesPerPixel: number;
  referenceable: boolean;
  reason?: string;
  nTiles: number;
  nReferencedTiles: number;
}

export type RefEntry = string | [string, number, number];

export interface CogReferences {
  version: 1;
  refs: Record<string, RefEntry>;
}

export interface CrsInfo {
  epsg?: number;
  bbox?: number[];
  transform?: number[];
}

export interface BuildResult {
  references: CogReferences;
  levels: LevelInfo[];
  crs: CrsInfo;
}

/** Map TIFF (SampleFormat, BitsPerSample) to a numpy/zarr v2 dtype string. */
export function dtypeFor(sampleFormat: number, bits: number, littleEndian: boolean): string {
  const bytes = bits / 8;
  const bo = bytes === 1 ? "|" : littleEndian ? "<" : ">";
  if (sampleFormat === 3) return `${bo}f${bytes}`; // float
  if (sampleFormat === 2) return bytes === 1 ? "|i1" : `${bo}i${bytes}`; // signed int
  return bytes === 1 ? "|u1" : `${bo}u${bytes}`; // unsigned int (default)
}

/**
 * Map a TIFF compression code to a zarr v2 compressor spec.
 *  - null      => stored uncompressed (no compressor)
 *  - { id }    => a codec zarrita can decode
 *  - undefined => we can't map it to a byte-reference codec (fall out of scope)
 */
export function compressorFor(compression: number): { id: string } | null | undefined {
  switch (compression) {
    case 1:
      return null; // none
    case 8: // Adobe Deflate
    case 32946: // Deflate (PKZIP)
      return { id: "zlib" };
    case 50000: // ZSTD
      return { id: "zstd" };
    default:
      return undefined; // LZW, JPEG, WEBP, LERC, PackBits, ... not mapped yet
  }
}

export async function buildCogReferences(url: string): Promise<BuildResult> {
  const tiff = await fromUrl(url);
  const littleEndian = (tiff as any).littleEndian ?? true;
  const count = await tiff.getImageCount();

  const refs: Record<string, RefEntry> = {};
  const levels: LevelInfo[] = [];
  const datasets: { path: string }[] = [];
  let crs: CrsInfo = {};

  for (let level = 0; level < count; level++) {
    const img = (await tiff.getImage(level)) as any;
    const fd = img.getFileDirectory();

    const width = img.getWidth();
    const height = img.getHeight();
    const tw = img.getTileWidth();
    const th = img.getTileHeight();
    const samples = img.getSamplesPerPixel();
    const sampleFormat = img.getSampleFormat();
    const bits = img.getBitsPerSample();
    const dtype = dtypeFor(sampleFormat, bits, littleEndian);

    // geotiff v3 defers large tag arrays; resolve scalars + arrays with loadValue().
    const compression: number = await fd.loadValue("Compression");
    const predictor: number = (await fd.loadValue("Predictor")) ?? 1;
    const planar: number = (await fd.loadValue("PlanarConfiguration")) ?? 1;
    const nodata = img.getGDALNoData?.() ?? null;

    const tilesAcross = Math.ceil(width / tw);
    const tilesDown = Math.ceil(height / th);
    const nTiles = tilesAcross * tilesDown;

    // Decide whether this level can be served as pure byte references.
    const compressor = compressorFor(compression);
    let referenceable = true;
    let reason: string | undefined;
    if (!img.isTiled) {
      referenceable = false;
      reason = "striped (not tiled)";
    } else if (samples !== 1 && planar !== 2) {
      referenceable = false;
      reason = "multi-sample, pixel-interleaved (needs PlanarConfiguration=2)";
    } else if (compressor === undefined) {
      referenceable = false;
      reason = `unsupported compression code ${compression}`;
    } else if (predictor === 3) {
      referenceable = false;
      reason = "floating-point predictor (3) not supported";
    }

    let nReferencedTiles = 0;
    if (referenceable) {
      const tileOffsets = await fd.loadValue("TileOffsets");
      const tileByteCounts = await fd.loadValue("TileByteCounts");
      const filters = predictor === 2 ? [{ id: TIFF_PREDICTOR_ID }] : null;

      const zarray = {
        zarr_format: 2,
        shape: [height, width],
        chunks: [th, tw],
        dtype,
        compressor,
        fill_value: nodata,
        order: "C",
        filters,
      };
      refs[`${level}/.zarray`] = JSON.stringify(zarray);
      refs[`${level}/.zattrs`] = JSON.stringify({ _ARRAY_DIMENSIONS: ["y", "x"] });

      for (let ty = 0; ty < tilesDown; ty++) {
        for (let tx = 0; tx < tilesAcross; tx++) {
          const idx = ty * tilesAcross + tx;
          const offset = Number(tileOffsets[idx]);
          const length = Number(tileByteCounts[idx]);
          // Zero-length tiles are sparse/nodata; omit them so zarr uses fill_value.
          if (length > 0) {
            refs[`${level}/${ty}.${tx}`] = [url, offset, length];
            nReferencedTiles++;
          }
        }
      }
      datasets.push({ path: `${level}` });
    }

    // Capture spatial referencing once, from the full-resolution image.
    if (level === 0) {
      try {
        const bbox = img.getBoundingBox();
        const [ox, oy] = img.getOrigin();
        const [rx, ry] = img.getResolution();
        crs = { bbox, transform: [rx, 0, ox, 0, ry, oy] };
        const gk = img.getGeoKeys?.();
        const epsg = gk?.ProjectedCSTypeGeoKey ?? gk?.GeographicTypeGeoKey;
        if (epsg) crs.epsg = epsg;
      } catch {
        /* non-georeferenced TIFF; leave crs empty */
      }
    }

    levels.push({
      level,
      width,
      height,
      tileWidth: tw,
      tileHeight: th,
      compression,
      predictor,
      dtype,
      samplesPerPixel: samples,
      referenceable,
      reason,
      nTiles,
      nReferencedTiles,
    });
  }

  refs[".zgroup"] = JSON.stringify({ zarr_format: 2 });
  refs[".zattrs"] = JSON.stringify({
    multiscales: [{ version: "0.4", name: "virtual_cog", datasets }],
    crs,
  });

  return { references: { version: 1, refs }, levels, crs };
}
