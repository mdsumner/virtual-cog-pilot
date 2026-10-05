// Build a GeoZarr / CF-style reference set from a *geographic* (EPSG:4326) COG,
// aimed at being opened directly by gridlook as a "regular" lat/lon grid.
//
// gridlook classifies a dataset as a regular grid when the data variable's
// dimension names are latitude/longitude-like and 1D `lat`/`lon` coordinate
// variables exist (see its coordinateVariables.ts / gridTypeDetector.ts). The
// COG itself has no coordinate arrays, so we synthesize them from the affine
// transform and inline them as base64 chunks in the kerchunk reference set.
//
// The pixel tiles remain pure byte references into the original .tif (same
// zlib + tiff_predictor path as the multiscales store), so this is still a
// zero-copy virtualization; only the small coordinate arrays are materialized.

import { fromUrl } from "geotiff";
import { TIFF_PREDICTOR_ID } from "./tiffPredictor";
import {
  compressorFor,
  dtypeFor,
  type CogReferences,
  type CrsInfo,
  type RefEntry,
} from "./cogReferences";

export interface GeoZarrResult {
  references: CogReferences;
  variableName: string;
  level: number;
  width: number;
  height: number;
  tileWidth: number;
  tileHeight: number;
  dtype: string;
  compression: number;
  predictor: number;
  crs: CrsInfo;
  lonRange: [number, number];
  latRange: [number, number];
}

export interface GeoZarrOptions {
  level?: number;
  maxWidth?: number;
  variableName?: string;
  standardName?: string;
  units?: string;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Encode a Float64Array as a kerchunk inline base64 chunk value. */
function inlineFloat64(values: Float64Array): string {
  return "base64:" + bytesToBase64(new Uint8Array(values.buffer, values.byteOffset, values.byteLength));
}

export async function buildGeoZarrReferences(
  url: string,
  opts: GeoZarrOptions = {},
): Promise<GeoZarrResult> {
  const variableName = opts.variableName ?? "elevation";
  const maxWidth = opts.maxWidth ?? 4096;

  const tiff = await fromUrl(url);
  const littleEndian = (tiff as any).littleEndian ?? true;
  const count = await tiff.getImageCount();

  // Choose a level: the finest overview whose width fits the budget (keeps the
  // inline coordinate arrays and chunk count light for a browser pilot).
  let level = opts.level;
  if (level === undefined) {
    level = count - 1;
    for (let i = 0; i < count; i++) {
      const im = (await tiff.getImage(i)) as any;
      if (im.getWidth() <= maxWidth) {
        level = i;
        break;
      }
    }
  }

  const img = (await tiff.getImage(level)) as any;
  const fd = img.getFileDirectory();
  const width = img.getWidth();
  const height = img.getHeight();
  const tw = img.getTileWidth();
  const th = img.getTileHeight();
  const samples = img.getSamplesPerPixel();
  const dtype = dtypeFor(img.getSampleFormat(), img.getBitsPerSample(), littleEndian);
  const compression: number = await fd.loadValue("Compression");
  const predictor: number = (await fd.loadValue("Predictor")) ?? 1;
  const nodata = img.getGDALNoData?.() ?? null;
  const compressor = compressorFor(compression);

  if (!img.isTiled) throw new Error("GeoZarr path requires a tiled COG.");
  if (samples !== 1) throw new Error("GeoZarr path currently supports single-band COGs.");
  if (compressor === undefined) throw new Error(`Unsupported compression code ${compression}.`);
  if (predictor === 3) throw new Error("Floating-point predictor (3) not supported.");

  // Overview IFDs usually lack geotransform tags; take the extent and geokeys
  // from the full-resolution image and scale the resolution to this level.
  const img0 = level === 0 ? img : ((await tiff.getImage(0)) as any);
  let bbox: number[];
  try {
    bbox = img0.getBoundingBox();
  } catch {
    throw new Error("COG lacks georeferencing (no affine transform).");
  }
  const [minX, minY, maxX, maxY] = bbox;
  const resX = (maxX - minX) / width;
  const resY = (maxY - minY) / height;

  // Cell-centre coordinates (origin is the upper-left corner; lat descends).
  const lon = new Float64Array(width);
  for (let j = 0; j < width; j++) lon[j] = minX + (j + 0.5) * resX;
  const lat = new Float64Array(height);
  for (let i = 0; i < height; i++) lat[i] = maxY - (i + 0.5) * resY;

  const refs: Record<string, RefEntry> = {};

  // --- data variable (byte references into the COG) ---
  const filters = predictor === 2 ? [{ id: TIFF_PREDICTOR_ID }] : null;
  refs[`${variableName}/.zarray`] = JSON.stringify({
    zarr_format: 2,
    shape: [height, width],
    chunks: [th, tw],
    dtype,
    compressor,
    fill_value: nodata,
    order: "C",
    filters,
  });
  refs[`${variableName}/.zattrs`] = JSON.stringify({
    _ARRAY_DIMENSIONS: ["lat", "lon"],
    coordinates: "lat lon",
    grid_mapping: "crs",
    long_name: "Elevation relative to sea level",
    standard_name: opts.standardName ?? "height_above_mean_sea_level",
    units: opts.units ?? "m",
  });

  const tileOffsets = await fd.loadValue("TileOffsets");
  const tileByteCounts = await fd.loadValue("TileByteCounts");
  const tilesAcross = Math.ceil(width / tw);
  const tilesDown = Math.ceil(height / th);
  for (let ty = 0; ty < tilesDown; ty++) {
    for (let tx = 0; tx < tilesAcross; tx++) {
      const idx = ty * tilesAcross + tx;
      const offset = Number(tileOffsets[idx]);
      const length = Number(tileByteCounts[idx]);
      if (length > 0) refs[`${variableName}/${ty}.${tx}`] = [url, offset, length];
    }
  }

  // --- coordinate variables (synthesized, inlined) ---
  refs["lat/.zarray"] = JSON.stringify({
    zarr_format: 2,
    shape: [height],
    chunks: [height],
    dtype: "<f8",
    compressor: null,
    fill_value: null,
    order: "C",
    filters: null,
  });
  refs["lat/.zattrs"] = JSON.stringify({
    _ARRAY_DIMENSIONS: ["lat"],
    standard_name: "latitude",
    long_name: "latitude",
    units: "degrees_north",
    axis: "Y",
  });
  refs["lat/0"] = inlineFloat64(lat);

  refs["lon/.zarray"] = JSON.stringify({
    zarr_format: 2,
    shape: [width],
    chunks: [width],
    dtype: "<f8",
    compressor: null,
    fill_value: null,
    order: "C",
    filters: null,
  });
  refs["lon/.zattrs"] = JSON.stringify({
    _ARRAY_DIMENSIONS: ["lon"],
    standard_name: "longitude",
    long_name: "longitude",
    units: "degrees_east",
    axis: "X",
  });
  refs["lon/0"] = inlineFloat64(lon);

  // --- CRS variable (scalar) so gridlook can read grid_mapping_name ---
  const gk = img0.getGeoKeys?.() ?? {};
  const epsg = gk.ProjectedCSTypeGeoKey ?? gk.GeographicTypeGeoKey;
  refs["crs/.zarray"] = JSON.stringify({
    zarr_format: 2,
    shape: [],
    chunks: [],
    dtype: "<i4",
    compressor: null,
    fill_value: 0,
    order: "C",
    filters: null,
  });
  refs["crs/.zattrs"] = JSON.stringify({
    _ARRAY_DIMENSIONS: [],
    grid_mapping_name: "latitude_longitude",
    ...(epsg ? { epsg_code: `EPSG:${epsg}` } : {}),
    semi_major_axis: 6378137,
    inverse_flattening: 298.257223563,
  });
  refs["crs/0"] = "base64:" + bytesToBase64(new Uint8Array(new Int32Array([epsg ?? 0]).buffer));

  // --- group metadata ---
  refs[".zgroup"] = JSON.stringify({ zarr_format: 2 });
  refs[".zattrs"] = JSON.stringify({
    title: "Virtual COG (GeoZarr)",
    Conventions: "CF-1.8",
    source_cog: url,
  });

  // Consolidated metadata (helps gridlook avoid many 404 probes).
  const metadata: Record<string, unknown> = {};
  for (const key of Object.keys(refs)) {
    if (key.endsWith(".zarray") || key.endsWith(".zattrs") || key.endsWith(".zgroup")) {
      metadata[key] = JSON.parse(refs[key] as string);
    }
  }
  refs[".zmetadata"] = JSON.stringify({ zarr_consolidated_format: 1, metadata });

  const crs: CrsInfo = {
    bbox: [minX, minY, maxX, maxY],
    transform: [resX, 0, minX, 0, -resY, maxY],
    ...(epsg ? { epsg } : {}),
  };

  return {
    references: { version: 1, refs },
    variableName,
    level,
    width,
    height,
    tileWidth: tw,
    tileHeight: th,
    dtype,
    compression,
    predictor,
    crs,
    lonRange: [lon[0], lon[lon.length - 1]],
    latRange: [lat[0], lat[lat.length - 1]],
  };
}
