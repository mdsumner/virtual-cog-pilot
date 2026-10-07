import * as zarr from "zarrita";
import { VirtualCogStore, type Layout } from "./VirtualCogStore";

interface Source {
  label: string;
  url: string;
  layout: Layout;
}

const DATASETS: Record<string, Source> = {
  sentinel: {
    label: "Sentinel-2 L2A B04, 55GEN 2026-03-04 (Hobart, EPSG:32755)",
    url: "https://e84-earth-search-sentinel-data.s3.us-west-2.amazonaws.com/sentinel-2-c1-l2a/55/G/EN/2026/3/S2B_T55GEN_20260304T000219_L2A/B04.tif",
    layout: "multiscales",
  },
  "sentinel-west": {
    label: "Sentinel-2 L2A B04, 55GCP 2022-11-06 (west coast, mostly ocean, EPSG:32755)",
    url: "https://sentinel-cogs.s3.us-west-2.amazonaws.com/sentinel-s2-l2a-cogs/55/G/CP/2022/11/S2B_55GCP_20221106_0_L2A/B04.tif",
    layout: "multiscales",
  },
  gebco: {
    label: "GEBCO 2026 global bathymetry (geographic, EPSG:4326, gridlook-ready)",
    url: "https://data.source.coop/ausantarctic/gebco/GEBCO_2026.tif",
    layout: "gridlook",
  },
};

/** Resolve what to open: ?url= (ad hoc) wins over ?dataset= (preset). */
function resolveSource(params: URLSearchParams): { key: string; source: Source } {
  const url = params.get("url");
  if (url) {
    const layout: Layout = params.get("layout") === "gridlook" ? "gridlook" : "multiscales";
    const base = url.split(/[?#]/)[0].split("/").pop() || "cog";
    const key = base.replace(/\.tiff?$/i, "").replace(/[^A-Za-z0-9._-]+/g, "_");
    return { key, source: { label: url, url, layout } };
  }
  const requested = params.get("dataset") ?? "sentinel";
  const key = requested in DATASETS ? requested : "sentinel";
  return { key, source: DATASETS[key] };
}

const params = new URLSearchParams(location.search);
const { key, source: config } = resolveSource(params);

const statusEl = document.getElementById("status")!;
const outputEl = document.getElementById("output")!;
const downloadsEl = document.getElementById("downloads")!;
const canvas = document.getElementById("preview") as HTMLCanvasElement;
const form = document.getElementById("cog-form") as HTMLFormElement;
const urlInput = document.getElementById("url") as HTMLInputElement;
const layoutSelect = document.getElementById("layout") as HTMLSelectElement;
const loInput = document.getElementById("lo") as HTMLInputElement;
const hiInput = document.getElementById("hi") as HTMLInputElement;
const zeroInput = document.getElementById("zero") as HTMLInputElement;
const rangeEl = document.getElementById("range")!;

// Reflect the current source in the form so it can be tweaked and resubmitted.
urlInput.value = config.url;
layoutSelect.value = config.layout;

form.addEventListener("submit", (ev) => {
  ev.preventDefault();
  const next = new URLSearchParams();
  next.set("url", urlInput.value.trim());
  if (layoutSelect.value !== "multiscales") next.set("layout", layoutSelect.value);
  // Navigate so the result is a shareable permalink.
  location.search = next.toString();
});

function setStatus(text: string, cls: "ok" | "err" | "" = "") {
  statusEl.textContent = text;
  statusEl.className = "status " + cls;
}

// ---- preview ---------------------------------------------------------------

interface Raster {
  data: ArrayLike<number>;
  width: number;
  height: number;
  nodata: number | null;
}
let current: Raster | null = null;

/** Sorted sample of valid values, recomputed only when the nodata rule changes. */
let sampleCache: { key: string; values: Float64Array } | null = null;

function validSample(r: Raster, zeroIsNodata: boolean): Float64Array {
  const cacheKey = `${zeroIsNodata}`;
  if (sampleCache?.key === cacheKey) return sampleCache.values;
  const step = Math.max(1, Math.floor(r.data.length / 200000));
  const out: number[] = [];
  for (let i = 0; i < r.data.length; i += step) {
    const v = r.data[i];
    if (!isValid(v, r.nodata, zeroIsNodata)) continue;
    out.push(v);
  }
  const values = Float64Array.from(out).sort();
  sampleCache = { key: cacheKey, values };
  return values;
}

function isValid(v: number, nodata: number | null, zeroIsNodata: boolean): boolean {
  if (Number.isNaN(v)) return false;
  if (nodata !== null && v === nodata) return false;
  if (zeroIsNodata && v === 0) return false;
  return true;
}

function quantile(sorted: Float64Array, p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[i];
}

/** Linear percentile stretch to 0-255; nodata (and optionally 0) shown as black. */
function renderPreview() {
  const r = current;
  if (!r) return;
  const zeroIsNodata = zeroInput.checked;
  let loP = Number(loInput.value);
  let hiP = Number(hiInput.value);
  if (!(hiP > loP)) [loP, hiP] = [0, 100];

  const sorted = validSample(r, zeroIsNodata);
  const lo = quantile(sorted, loP);
  const hi = quantile(sorted, hiP);
  const span = hi - lo || 1;
  const fmt = (x: number) => (Number.isInteger(x) ? String(x) : x.toPrecision(5));
  rangeEl.textContent =
    sorted.length === 0
      ? "no valid values in preview"
      : `stretch ${fmt(lo)} to ${fmt(hi)} (valid range ${fmt(sorted[0])} to ${fmt(sorted[sorted.length - 1])})`;

  canvas.width = r.width;
  canvas.height = r.height;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(r.width, r.height);
  const px = img.data;
  for (let i = 0; i < r.data.length; i++) {
    const v = r.data[i];
    const g = isValid(v, r.nodata, zeroIsNodata)
      ? Math.max(0, Math.min(255, Math.round(((v - lo) / span) * 255)))
      : 0;
    const o = i * 4;
    px[o] = px[o + 1] = px[o + 2] = g;
    px[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

loInput.addEventListener("input", renderPreview);
hiInput.addEventListener("input", renderPreview);
zeroInput.addEventListener("change", renderPreview);

// ---- downloads ---------------------------------------------------------------

function addDownloadButton(store: VirtualCogStore) {
  const json = store.toKerchunkJSON(0);
  const blob = new Blob([json], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${key}.kerchunk.json`;
  a.textContent = `Download kerchunk references (${(blob.size / 1024).toFixed(0)} KB)`;
  a.style.cssText = "display:inline-block;margin:0.5rem 0;";
  downloadsEl.replaceChildren(a);
}

// ---- main --------------------------------------------------------------------

async function run() {
  try {
    setStatus(`Reading IFD headers and building virtual store for ${key}...`);
    const t0 = performance.now();
    const store = new VirtualCogStore(config.url, { layout: config.layout });
    await store.init();
    const tRefs = performance.now() - t0;

    const refCount = Object.keys(store.toKerchunk().refs).length;
    const grp = await zarr.open.v2(store.store, { kind: "group" });

    let previewPath: string;
    let extra: Record<string, unknown>;
    if (store.layout === "gridlook") {
      previewPath = store.dataVariable!;
      extra = {
        gridlookReady: true,
        dataVariable: store.dataVariable,
        level: store.geo?.level,
        shape: [store.geo?.height, store.geo?.width],
        lonRange: store.geo?.lonRange,
        latRange: store.geo?.latRange,
      };
    } else {
      const rl = store.referenceableLevels;
      if (rl.length === 0) {
        throw new Error(
          "No referenceable levels:\n" +
            store.levels.map((l) => `  level ${l.level}: ${l.reason ?? "?"}`).join("\n"),
        );
      }
      previewPath = String(rl[rl.length - 1].level);
      extra = {
        gridlookReady: false,
        note: "projected grid; render here, or feed to gridlook as curvilinear via proj4",
        levels: store.levels.map((l) => ({
          level: l.level,
          shape: [l.height, l.width],
          dtype: l.dtype,
          predictor: l.predictor,
          tiles: `${l.nReferencedTiles}/${l.nTiles}`,
          ...(l.reason ? { notReferenceable: l.reason } : {}),
        })),
      };
    }

    const arr = await store.openArray(grp, previewPath);
    const summary = {
      dataset: config.label,
      url: config.url,
      layout: store.layout,
      crs: store.crs,
      totalReferences: refCount,
      kerchunkBytes: store.toKerchunkJSON(0).length,
      headerScanMs: Math.round(tRefs),
      dimensions: arr.dimensionNames,
      fillValue: arr.fillValue,
      ...extra,
    };
    outputEl.textContent = JSON.stringify(summary, null, 2);
    addDownloadButton(store);

    const t1 = performance.now();
    const chunk = await zarr.get(arr);
    const tRead = performance.now() - t1;
    current = {
      data: chunk.data as unknown as ArrayLike<number>,
      width: chunk.shape[1] ?? chunk.shape[0],
      height: chunk.shape[0],
      nodata: typeof arr.fillValue === "number" ? arr.fillValue : null,
    };
    // A declared nodata makes the 0 rule redundant; leave the box for the user to flip.
    if (current.nodata !== null && current.nodata !== 0) zeroInput.checked = false;
    sampleCache = null;
    renderPreview();

    setStatus(
      `Success - ${refCount} references in ${Math.round(tRefs)} ms, ` +
        `rendered "${previewPath}" (${chunk.shape.join("x")}) in ${Math.round(tRead)} ms.`,
      "ok",
    );
  } catch (err) {
    console.error(err);
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    const hint = /fetch/i.test(msg)
      ? "\n\nIf this is a fetch failure, the host may not allow cross-origin (CORS) range requests."
      : "";
    setStatus("Error", "err");
    outputEl.textContent = msg + hint;
  }
}

run();
