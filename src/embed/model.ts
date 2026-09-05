/**
 * Lazy loader for the local embedding model.
 *
 * `@huggingface/transformers` is an optional dependency: when it is missing, or no ONNX
 * runtime can start, or the model is not in the cache and downloads are not allowed,
 * `loadEmbedder` resolves to null and callers skip the semantic tier. The reason is
 * printed to stderr once per process.
 *
 * Two execution backends are tried, in order:
 *   1. `onnxruntime-node` — the native CPU runtime transformers.js picks by default.
 *   2. `onnxruntime-web` in WebAssembly — used when the native runtime has no prebuilt
 *      binary for this platform (or its session fails). transformers.js honours an ONNX
 *      runtime published on `globalThis[Symbol.for('onnxruntime')]`, so injecting the web
 *      build before the first import gives a genuine wasm path under Node. It is roughly
 *      5x slower but needs no native addon.
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { envFlag } from '../util/env.js';
import { pathToFileURL } from 'node:url';

export const MODEL_ID = 'Xenova/bge-small-en-v1.5';
export const MODEL_DIM = 384;
/** Files the node runtime needs; their presence in the cache means no network is required. */
const MODEL_FILES = ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx'];
/** Kept as a plain string so TypeScript does not resolve the (optional) package's types at build time. */
const PACKAGE: string = '@huggingface/transformers';
const HUB_HOST = 'https://huggingface.co/';
const NO_NETWORK_HOST = 'http://127.0.0.1:1/';
/** transformers.js uses whatever ONNX runtime is published here, in preference to its own. */
const ORT_SYMBOL = Symbol.for('onnxruntime');

export const BACKEND_NODE = 'onnxruntime-node';
export const BACKEND_WASM = 'onnxruntime-web (wasm)';

export interface Embedder {
  model: string;
  dim: number;
  /** Which ONNX execution backend answers inference calls. */
  backend: string;
  /** Embed texts (batched); each result is a unit-length vector of `dim` floats. */
  embed(texts: string[]): Promise<Float32Array[]>;
}

export interface LoadOptions {
  /** Allow fetching the model from the Hugging Face hub into the cache (default false: cache only). */
  allowDownload?: boolean;
  log?: (message: string) => void;
  /** Download progress for large files, 0..100. */
  progress?: (file: string, pct: number) => void;
}

interface FeatureTensor {
  data: Float32Array;
  dims: number[];
  dispose?: () => void;
}
interface FeaturePipeline {
  (texts: string[], opts: { pooling: string; normalize: boolean }): Promise<FeatureTensor>;
}
interface TransformersModule {
  env: { cacheDir: string; allowLocalModels: boolean; allowRemoteModels: boolean; remoteHost: string; useWasmCache?: boolean };
  pipeline(task: string, model: string, opts: Record<string, unknown>): Promise<FeaturePipeline>;
}
interface OrtWebModule {
  env: { wasm: { wasmPaths?: string; numThreads?: number; proxy?: boolean } };
}

export function modelCacheDir(): string {
  return envFlag('MODEL_DIR') || join(homedir(), '.cache', 'symbra', 'models');
}

/** True when every file the model needs is already on disk. */
export function modelCached(model = MODEL_ID): boolean {
  const dir = join(modelCacheDir(), model);
  return MODEL_FILES.every((f) => existsSync(join(dir, f)));
}

/** `SYMBRA_EMBED=0` switches the semantic tier off entirely (no model load, no fusion). */
export function embeddingsDisabled(): boolean {
  const v = envFlag('EMBED');
  return v === '0' || v === 'false' || v === 'off';
}

/** `SYMBRA_EMBED_BACKEND=wasm|node` pins the runtime (default: native first, wasm as fallback). */
function forcedBackend(): 'wasm' | 'node' | null {
  const v = (envFlag('EMBED_BACKEND') ?? '').toLowerCase();
  return v === 'wasm' || v === 'web' ? 'wasm' : v === 'node' || v === 'native' ? 'node' : null;
}

let embedder: Embedder | null = null;
let loading: Promise<Embedder | null> | null = null;
/** Set after a failed attempt so a later attempt with more rights (download allowed) can retry. */
let failed: { withDownload: boolean; reason: string } | null = null;
let noted = false;

/** Why the semantic tier is unavailable after the last load attempt, or null when it works / was never tried. */
export function embedUnavailableReason(): string | null {
  return failed?.reason ?? null;
}

function noteOnce(message: string, log?: (m: string) => void): void {
  if (log) log(message);
  else if (!noted) console.error(`[symbra] ${message}`);
  noted = true;
}

export function loadEmbedder(opts: LoadOptions = {}): Promise<Embedder | null> {
  if (embeddingsDisabled()) return Promise.resolve(null);
  if (embedder) return Promise.resolve(embedder);
  if (loading) return loading;
  const allowDownload = !!opts.allowDownload;
  // Retry a "model not cached" failure once downloads are allowed; never retry hard failures.
  if (failed && (failed.withDownload || !allowDownload)) return Promise.resolve(null);
  loading = attempt(allowDownload, opts).then(
    (e) => {
      embedder = e;
      loading = null;
      return e;
    },
    (err: unknown) => {
      loading = null;
      const msg = err instanceof Error ? err.message : String(err);
      failed = { withDownload: allowDownload, reason: `semantic search off: model failed to load (${msg.split('\n')[0]!.slice(0, 200)})` };
      noteOnce(failed.reason, opts.log);
      return null;
    },
  );
  return loading;
}

const req = createRequire(import.meta.url);

/** Resolve a module id from the installed transformers package first, then from here. */
function resolveFrom(id: string, anchor?: string): string {
  try {
    if (anchor) return req.resolve(id, { paths: [anchor] });
  } catch {
    /* fall through to a plain resolve */
  }
  return req.resolve(id);
}

/** Can the native runtime be loaded at all on this platform/architecture? */
function nativeRuntimeError(): string | null {
  try {
    req(resolveFrom('onnxruntime-node', packageDir()));
    return null;
  } catch (err) {
    return ((err as Error)?.message ?? String(err)).split('\n')[0]!;
  }
}

function packageDir(): string | undefined {
  try {
    return dirname(req.resolve(PACKAGE));
  } catch {
    return undefined;
  }
}

let wasmInstalled = false;

/**
 * Publish the WebAssembly ONNX runtime on `globalThis[Symbol.for('onnxruntime')]`, which
 * transformers.js picks up in preference to `onnxruntime-node`. Must happen before the
 * first import of the package. Returns false when the web runtime is not installed.
 */
async function installWasmRuntime(mod?: TransformersModule): Promise<boolean> {
  if (mod) mod.env.useWasmCache = false; // the blob-URL wasm factory cache cannot be imported under Node
  if (wasmInstalled) return true;
  let ortPath: string;
  try {
    ortPath = resolveFrom('onnxruntime-web', packageDir());
  } catch {
    return false;
  }
  const ort = (await import(pathToFileURL(ortPath).href)) as OrtWebModule & { default?: OrtWebModule };
  const runtime = ort.default ?? ort;
  // Load the .wasm/.mjs artefacts from the installed package rather than a CDN.
  runtime.env.wasm.wasmPaths = pathToFileURL(join(dirname(ortPath), '/')).href;
  (globalThis as Record<symbol, unknown>)[ORT_SYMBOL] = runtime;
  wasmInstalled = true;
  return true;
}

/** Import transformers.js. `bust` gives a fresh module instance so a re-import sees a new ORT. */
async function importTransformers(bust = false): Promise<TransformersModule> {
  if (!bust) return (await import(PACKAGE)) as TransformersModule;
  const url = `${pathToFileURL(req.resolve(PACKAGE)).href}?symbra-wasm=1`;
  const m = (await import(url)) as TransformersModule & { default?: TransformersModule };
  return m.env ? m : m.default!;
}

async function makePipeline(mod: TransformersModule, device: string, opts: LoadOptions): Promise<FeaturePipeline> {
  // transformers.js reports the same progress events for a cache read as for a download, so the
  // callback is only wired up when the model is actually missing from the cache.
  const downloading = !modelCached();
  return mod.pipeline('feature-extraction', MODEL_ID, {
    dtype: 'q8',
    device,
    progress_callback:
      downloading && opts.progress
        ? (ev: { status?: string; file?: string; progress?: number; total?: number }) => {
            if (ev.status === 'progress' && ev.file && (ev.total ?? 0) > 1_000_000) opts.progress!(ev.file, Math.round(ev.progress ?? 0));
          }
        : undefined,
  });
}

function configureEnv(mod: TransformersModule, allowDownload: boolean): void {
  mod.env.cacheDir = modelCacheDir();
  mod.env.allowLocalModels = false;
  // The file-system cache is consulted before any request, so a cached model never fetches.
  // Without download rights the hub host is replaced by a local blackhole: a cache miss then
  // fails immediately instead of reaching the network.
  mod.env.allowRemoteModels = true;
  mod.env.remoteHost = allowDownload ? HUB_HOST : NO_NETWORK_HOST;
}

async function attempt(allowDownload: boolean, opts: LoadOptions): Promise<Embedder | null> {
  if (!allowDownload && !modelCached()) {
    failed = { withDownload: false, reason: `semantic search off: model ${MODEL_ID} is not cached; run "symbra embed" once (downloads ~34 MB to ${modelCacheDir()})` };
    noteOnce(failed.reason, opts.log);
    return null;
  }

  const pkgDir = packageDir();
  if (!pkgDir) {
    const reason = 'semantic search off: optional dependency @huggingface/transformers is not installed (npm install @huggingface/transformers)';
    failed = { withDownload: true, reason };
    noteOnce(reason, opts.log);
    return null;
  }

  const pin = forcedBackend();
  // Decide the backend before the first import: transformers.js statically imports
  // onnxruntime-node, so once that import has failed the module is permanently rejected.
  let wasm = pin === 'wasm';
  let nativeError: string | null = null;
  if (pin !== 'node' && !wasm) {
    nativeError = nativeRuntimeError();
    wasm = nativeError !== null;
  }
  if (wasm && !(await installWasmRuntime())) {
    const reason = nativeError
      ? `semantic search off: onnxruntime-node failed to load (${nativeError.slice(0, 140)}) and onnxruntime-web is not installed`
      : 'semantic search off: SYMBRA_EMBED_BACKEND=wasm but onnxruntime-web is not installed';
    failed = { withDownload: true, reason };
    noteOnce(reason, opts.log);
    return null;
  }
  if (wasm && nativeError) opts.log?.(`onnxruntime-node unavailable (${nativeError.slice(0, 120)}); falling back to WebAssembly`);

  let mod: TransformersModule;
  try {
    mod = await importTransformers();
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    const msg = (e?.message ?? String(err)).split('\n')[0]!;
    const reason =
      e?.code === 'ERR_MODULE_NOT_FOUND' || /Cannot find (module|package)/.test(msg)
        ? 'semantic search off: optional dependency @huggingface/transformers is not installed (npm install @huggingface/transformers)'
        : `semantic search off: cannot load @huggingface/transformers (${msg.slice(0, 160)})`;
    failed = { withDownload: true, reason };
    noteOnce(reason, opts.log);
    return null;
  }
  configureEnv(mod, allowDownload);
  if (wasm) mod.env.useWasmCache = false;

  const t0 = Date.now();
  let backend = wasm ? BACKEND_WASM : BACKEND_NODE;
  let pipe: FeaturePipeline;
  try {
    // With an injected runtime transformers.js knows no device names, so 'auto' (an empty
    // execution-provider list) lets ORT web pick WebAssembly itself.
    pipe = await makePipeline(mod, wasm ? 'auto' : 'cpu', opts);
  } catch (err) {
    const msg = ((err as Error)?.message ?? String(err)).split('\n')[0]!;
    if (wasm || pin === 'node' || !(await installWasmRuntime(mod))) throw err;
    // The native session failed even though the module loaded (bad binary, unsupported EP…).
    // A fresh module instance is needed for the injected runtime to take effect.
    opts.log?.(`native ONNX session failed (${msg.slice(0, 120)}); retrying on WebAssembly`);
    const retryMod = await importTransformers(true);
    configureEnv(retryMod, allowDownload);
    retryMod.env.useWasmCache = false;
    pipe = await makePipeline(retryMod, 'auto', opts);
    backend = BACKEND_WASM;
  }
  opts.log?.(`model ${MODEL_ID} ready in ${Date.now() - t0}ms via ${backend}`);
  const dim = MODEL_DIM;
  return {
    model: MODEL_ID,
    dim,
    backend,
    async embed(texts: string[]): Promise<Float32Array[]> {
      if (!texts.length) return [];
      // CLS pooling + L2 normalisation is what BGE models are trained for.
      const out = await pipe(texts, { pooling: 'cls', normalize: true });
      const d = out.dims[out.dims.length - 1] ?? dim;
      const data = out.data;
      const rows: Float32Array[] = [];
      for (let i = 0; i < texts.length; i++) rows.push(Float32Array.from(data.subarray(i * d, (i + 1) * d)));
      out.dispose?.();
      return rows;
    },
  };
}
