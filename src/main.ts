import * as zarr from "zarrita";
import { VirtualCogStore, type Layout } from "./VirtualCogStore";

const DATASETS: Record<string, { label: string; url: string; layout: Layout }> = {
  sentinel: {
    label: "Sentinel-2 B04 over Tasmania (projected, EPSG:32755)",
    url: "https://sentinel-cogs.s3.us-west-2.amazonaws.com/sentinel-s2-l2a-cogs/55/G/CP/2022/11/S2B_55GCP_20221106_0_L2A/B04.tif",
    layout: "multiscales",
  },
  gebco: {
    label: "GEBCO 2026 global bathymetry (geographic, EPSG:4326, gridlook-ready)",
    url: "https://data.source.coop/ausantarctic/gebco/GEBCO_2026.tif",
    layout: "gridlook",
  },
};

const params = new URLSearchParams(location.search);
const requested = params.get("dataset") ?? "sentinel";
const key = requested in DATASETS ? requested : "sentinel";
const config = DATASETS[key];

const statusEl = document.getElementById("status")!;
const outputEl = document.getElementById("output")!;
const canvas = document.getElementById("preview") as HTMLCanvasElement;

function setStatus(text: string, cls: "ok" | "err" | "" = "") {
  statusEl.textContent = text;
  statusEl.className = "status " + cls;
}

/** Linear 2nd-98th percentile stretch to 0-255, with nodata shown as black. */
function renderPreview(
  data: ArrayLike<number>,
  width: number,
  height: number,
  nodata: number | null,
) {
  const step = Math.max(1, (data.length / 50000) | 0);
  const sample: number[] = [];
  for (let i = 0; i < data.length; i += step) {
    const v = data[i];
    if (nodata === null || v !== nodata) sample.push(v);
  }
  sample.sort((a, b) => a - b);
  const lo = sample[Math.floor(sample.length * 0.02)] ?? 0;
  const hi = sample[Math.floor(sample.length * 0.98)] ?? 1;
  const span = hi - lo || 1;

  canvas.width = width;
  canvas.height = height;
  canvas.style.maxWidth = "100%";
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(width, height);
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    const isNo = nodata !== null && v === nodata;
    const g = isNo ? 0 : Math.max(0, Math.min(255, Math.round(((v - lo) / span) * 255)));
    const o = i * 4;
    img.data[o] = img.data[o + 1] = img.data[o + 2] = g;
    img.data[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

function addDownloadButton(store: VirtualCogStore) {
  const json = store.toKerchunkJSON(0);
  const blob = new Blob([json], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `virtual_cog.${key}.kerchunk.json`;
  a.textContent = `Download kerchunk references (${(blob.size / 1024).toFixed(0)} KB)`;
  a.style.cssText = "display:inline-block;margin:0.5rem 0;";
  outputEl.after(a);
}

async function run() {
  try {
    setStatus(`Reading IFD headers & building virtual store for ${key}\u2026`);
    const store = new VirtualCogStore(config.url, { layout: config.layout });
    await store.init();

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
        })),
      };
    }

    const arr = await store.openArray(grp, previewPath);
    const summary = {
      dataset: config.label,
      url: config.url,
      crs: store.crs,
      totalReferences: refCount,
      kerchunkBytes: store.toKerchunkJSON(0).length,
      dimensions: arr.dimensionNames,
      ...extra,
    };
    outputEl.textContent = JSON.stringify(summary, null, 2);
    addDownloadButton(store);

    const chunk = await zarr.get(arr);
    renderPreview(
      chunk.data as unknown as ArrayLike<number>,
      chunk.shape[1] ?? chunk.shape[0],
      chunk.shape[0],
      typeof arr.fillValue === "number" ? arr.fillValue : null,
    );

    setStatus(
      `Success \u2014 ${refCount} references, rendered "${previewPath}" (${chunk.shape.join("\u00d7")}).`,
      "ok",
    );
  } catch (err) {
    console.error(err);
    setStatus("Error", "err");
    outputEl.textContent = String(err instanceof Error ? (err.stack ?? err.message) : err);
  }
}

run();
