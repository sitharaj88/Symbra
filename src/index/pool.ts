import { Worker } from 'node:worker_threads';
import { cpus } from 'node:os';
import { existsSync } from 'node:fs';
import type { FileIR } from '../ir/types.js';
import { extractFile } from './extract.js';

interface Pending {
  /** Index of the worker this job was handed to, so a dying worker only fails its own jobs. */
  worker: number;
  path: string;
  content: string;
  resolve: (ir: FileIR | null) => void;
  reject: (e: Error) => void;
}

/**
 * Parallel extraction over worker threads. Falls back to in-process extraction when workers
 * cannot be started (e.g. running from TypeScript sources without a build) and when every
 * worker has died. A worker that errors or exits is dropped from the rotation and the jobs it
 * still owed are re-run in this process, so a crash costs one file's latency, not a hang.
 */
export class ExtractPool {
  private workers: Worker[] = [];
  private dead: boolean[] = [];
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private inflight: number[] = [];
  private closing = false;
  readonly size: number;

  constructor(size?: number) {
    const workerUrl = new URL('./worker.js', import.meta.url);
    const available = existsSync(workerUrl) && workerUrl.pathname.endsWith('.js');
    this.size = available ? Math.max(1, Math.min(size ?? Math.max(1, cpus().length - 1), 8)) : 0;
    for (let i = 0; i < this.size; i++) {
      const w = new Worker(workerUrl);
      w.on('message', (m: { id: number; ir?: FileIR | null; error?: string }) => {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        this.inflight[p.worker] = Math.max(0, (this.inflight[p.worker] ?? 1) - 1);
        if (m.error) p.reject(new Error(m.error));
        else p.resolve(m.ir ?? null);
      });
      w.on('error', (e) => this.killWorker(i, e));
      // A worker that exits without an 'error' (OOM, explicit exit) would otherwise leave its
      // jobs pending forever and keep receiving new ones.
      w.on('exit', () => this.killWorker(i, new Error(`extract worker ${i} exited`)));
      this.workers.push(w);
      this.dead.push(false);
      this.inflight.push(0);
    }
  }

  /** Number of workers still able to take a job. */
  get liveWorkers(): number {
    let n = 0;
    for (let i = 0; i < this.size; i++) if (!this.dead[i]) n++;
    return n;
  }

  private killWorker(i: number, err: Error) {
    const wasLive = !this.dead[i];
    this.dead[i] = true;
    this.inflight[i] = 0;
    const orphans: Pending[] = [];
    for (const [id, p] of this.pending) {
      if (p.worker !== i) continue;
      this.pending.delete(id);
      orphans.push(p);
    }
    if (wasLive && !this.closing && orphans.length) console.error(`[symbra] extract worker ${i} died (${err.message}); re-running ${orphans.length} file(s) in-process`);
    for (const p of orphans) extractFile(p.path, p.content).then(p.resolve, p.reject);
  }

  /** Least-loaded live worker, or -1 when none is left. */
  private pickWorker(): number {
    let best = -1;
    for (let i = 0; i < this.size; i++) {
      if (this.dead[i]) continue;
      if (best < 0 || this.inflight[i]! < this.inflight[best]!) best = i;
    }
    return best;
  }

  extract(path: string, content: string): Promise<FileIR | null> {
    if (!this.size) return extractFile(path, content);
    const best = this.pickWorker();
    if (best < 0) return extractFile(path, content);
    const id = this.nextId++;
    this.inflight[best] = this.inflight[best]! + 1;
    return new Promise<FileIR | null>((resolve, reject) => {
      this.pending.set(id, { worker: best, path, content, resolve, reject });
      try {
        this.workers[best]!.postMessage({ id, path, content });
      } catch (err) {
        this.pending.delete(id);
        this.killWorker(best, err as Error);
        extractFile(path, content).then(resolve, reject);
      }
    });
  }

  async close(): Promise<void> {
    this.closing = true;
    await Promise.all(this.workers.map((w) => w.terminate()));
    this.workers = [];
  }
}
