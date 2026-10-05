// A zarrita array-to-array codec that reverses TIFF horizontal differencing
// (Predictor = 2). zarr's built-in Delta filter differences over the whole
// flattened chunk, which is NOT the same as TIFF's per-row predictor, so we
// need our own. It plugs into zarrita's v2 codec pipeline as a filter.
//
// Decode order in zarrita v2: compressor (zlib) -> bytes -> filters (reverse).
// So by the time decode() runs here, `chunk.data` is the already-inflated,
// correctly-typed array; we just undo the per-row differencing in place.
//
// Register it under `numcodecs.<id>` because zarrita maps a v2 filter
// `{ id: "tiff_predictor" }` to the registry name `numcodecs.tiff_predictor`.

import { registry } from "zarrita";

export const TIFF_PREDICTOR_ID = "tiff_predictor";

interface Chunk {
  // Typed array (Int16Array, Uint16Array, ...). BigInt arrays also work.
  data: { length: number; slice(): any; [i: number]: number | bigint };
  shape: number[];
  stride: number[];
}

export class TiffPredictorCodec {
  kind = "array_to_array" as const;

  static fromConfig(_config: unknown, _meta: unknown): TiffPredictorCodec {
    return new TiffPredictorCodec();
  }

  // Undo horizontal differencing: each value is the running sum along its row.
  decode(chunk: Chunk): Chunk {
    const { data, shape, stride } = chunk;
    const width = shape[shape.length - 1];
    const out = data.slice();
    for (let row = 0; row < out.length; row += width) {
      for (let c = 1; c < width; c++) {
        // Integer wrap-around is handled by the typed array itself.
        (out as any)[row + c] += (out as any)[row + c - 1];
      }
    }
    return { data: out, shape, stride };
  }

  // Apply horizontal differencing (inverse of decode). Provided for symmetry;
  // the read-only pilot never calls it.
  encode(chunk: Chunk): Chunk {
    const { data, shape, stride } = chunk;
    const width = shape[shape.length - 1];
    const out = data.slice();
    for (let row = 0; row < out.length; row += width) {
      for (let c = width - 1; c >= 1; c--) {
        (out as any)[row + c] -= (out as any)[row + c - 1];
      }
    }
    return { data: out, shape, stride };
  }
}

let registered = false;

/** Register the TIFF predictor filter with zarrita's codec registry (idempotent). */
export function registerTiffPredictor(): void {
  if (registered) return;
  registry.set(`numcodecs.${TIFF_PREDICTOR_ID}`, () => TiffPredictorCodec as any);
  registered = true;
}
