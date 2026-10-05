// VirtualCogStore: a zarrita-compatible (Readable) store that virtualizes a
// remote COG as a Zarr store on the fly, with two layouts:
//
//   "multiscales" (default) - overviews mapped to /0, /1, ... (good for the raw
//                             projected grid; see buildCogReferences).
//   "gridlook"              - a single CF/GeoZarr variable with synthesized
//                             lat/lon coordinates, aimed at rendering a
//                             geographic (EPSG:4326) COG in gridlook.
//
//   const store = new VirtualCogStore(url, { layout: "gridlook" });
//   await store.init();
//   const grp = await zarr.open.v2(store.store, { kind: "group" });
//   const arr = await store.openArray(grp, store.dataVariable ?? "0");
//   const kerchunk = store.toKerchunkJSON();  // reusable reference artifact
//
// Internally it builds a kerchunk reference set and wraps zarrita's built-in
// ReferenceStore, which turns chunk keys into HTTP Range requests against the
// original COG. Registering the TIFF predictor filter is handled for you.

import * as zarr from "zarrita";
import ReferenceStore from "@zarrita/storage/ref";
import type { AbsolutePath, GetOptions, RangeQuery } from "@zarrita/storage";
import { registerTiffPredictor } from "./tiffPredictor";
import {
  buildCogReferences,
  type CogReferences,
  type CrsInfo,
  type LevelInfo,
} from "./cogReferences";
import { buildGeoZarrReferences, type GeoZarrResult } from "./geozarr";

export type Layout = "multiscales" | "gridlook";

export interface VirtualCogOptions {
  layout?: Layout;
  /** GeoZarr layout: pick a specific overview level (default: auto by maxWidth). */
  level?: number;
  /** GeoZarr layout: largest overview width to use when auto-selecting a level. */
  maxWidth?: number;
  /** GeoZarr layout: name of the data variable (default "elevation"). */
  variableName?: string;
}

export class VirtualCogStore {
  readonly url: string;
  readonly layout: Layout;
  private readonly options: VirtualCogOptions;

  references?: CogReferences;
  crs: CrsInfo = {};
  /** multiscales layout: per-level info. */
  levels: LevelInfo[] = [];
  /** gridlook layout: the data variable name and geo summary. */
  dataVariable?: string;
  geo?: GeoZarrResult;

  #store?: ReferenceStore;

  constructor(url: string, options: VirtualCogOptions = {}) {
    this.url = url;
    this.options = options;
    this.layout = options.layout ?? "multiscales";
    registerTiffPredictor();
  }

  /** Read the COG's IFD headers and synthesize the virtual Zarr reference set. */
  async init(): Promise<this> {
    if (this.layout === "gridlook") {
      const geo = await buildGeoZarrReferences(this.url, {
        level: this.options.level,
        maxWidth: this.options.maxWidth,
        variableName: this.options.variableName,
      });
      this.references = geo.references;
      this.crs = geo.crs;
      this.dataVariable = geo.variableName;
      this.geo = geo;
      this.levels = [];
    } else {
      const built = await buildCogReferences(this.url);
      this.references = built.references;
      this.crs = built.crs;
      this.levels = built.levels;
    }
    this.#store = ReferenceStore.fromSpec(
      this.references as unknown as Record<string, unknown>,
    ) as ReferenceStore;
    return this;
  }

  /** The underlying zarrita Readable store (pass this to `zarr.open.v2`). */
  get store(): ReferenceStore {
    if (!this.#store) throw new Error("VirtualCogStore: call init() first");
    return this.#store;
  }

  // --- Readable store interface (delegates to the ReferenceStore) ---
  get(key: AbsolutePath, opts?: GetOptions): Promise<Uint8Array | undefined> {
    return this.store.get(key, opts);
  }
  getRange(
    key: AbsolutePath,
    range: RangeQuery,
    opts?: GetOptions,
  ): Promise<Uint8Array | undefined> {
    return this.store.getRange(key, range, opts);
  }

  /** Overview levels that were successfully virtualized (coarsest last). */
  get referenceableLevels(): LevelInfo[] {
    return this.levels.filter((l) => l.referenceable);
  }

  /** Open a variable / multiscales level as a zarrita array. */
  async openArray(group: zarr.Group<ReferenceStore>, path: string) {
    return zarr.open.v2(group.resolve(path), { kind: "array" });
  }

  /** The virtual store as a kerchunk v1 reference object. */
  toKerchunk(): CogReferences {
    if (!this.references) throw new Error("VirtualCogStore: call init() first");
    return this.references;
  }

  /** The kerchunk reference object serialized to JSON (the reusable artifact). */
  toKerchunkJSON(space: number = 0): string {
    return JSON.stringify(this.toKerchunk(), null, space);
  }
}
