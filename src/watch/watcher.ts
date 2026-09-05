import { watch, type FSWatcher } from 'node:fs';
import { sep } from 'node:path';
import { indexRepo, type IndexStats } from '../index/indexer.js';
import { languageForPath } from '../languages/registry.js';
import { buildRootIgnore } from '../index/scan.js';

/** Hard ceiling on how long a burst of edits may postpone the flush. */
const MAX_DEBOUNCE_MS = 2000;

/**
 * Watch a repository with the OS file watcher and re-index changed files after a short debounce.
 * Only paths with a supported language are considered; ignored directories never trigger.
 */
export function watchRepo(root: string, onIndexed: (stats: IndexStats) => void, debounceMs = 400): FSWatcher | null {
  // The same ignore rules the scanner uses, so generated output under a repo-specific
  // .gitignore entry does not wake the indexer on every build.
  const ig = buildRootIgnore(root);
  const pending = new Set<string>();
  let timer: NodeJS.Timeout | null = null;
  let running = false;
  let rerun = false;
  /** When the current debounce window opened, so a continuous writer cannot postpone it forever. */
  let firstEventAt = 0;

  async function flush() {
    timer = null;
    firstEventAt = 0;
    if (running) {
      rerun = true;
      return;
    }
    running = true;
    const only = [...pending];
    pending.clear();
    try {
      const stats = await indexRepo({ root, only });
      onIndexed(stats);
    } catch (err) {
      console.error(`[symbra] watch reindex failed: ${(err as Error).message}`);
    } finally {
      running = false;
      if (rerun) {
        rerun = false;
        void flush();
      }
    }
  }

  let w: FSWatcher;
  try {
    w = watch(root, { recursive: true, persistent: false }, (_event, filename) => {
      if (!filename) return;
      const rel = typeof filename === 'string' ? filename : String(filename);
      const posix = sep === '/' ? rel : rel.split(sep).join('/');
      if (!posix || posix.startsWith('..')) return;
      if (ig.ignores(posix)) return;
      if (!languageForPath(posix)) return;
      pending.add(posix);
      const now = Date.now();
      if (!firstEventAt) firstEventAt = now;
      // Cap the wait: a process writing continuously would otherwise reset the timer forever.
      const wait = Math.max(0, Math.min(debounceMs, firstEventAt + MAX_DEBOUNCE_MS - now));
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void flush(), wait);
    });
  } catch (err) {
    console.error(`[symbra] file watching unavailable: ${(err as Error).message}`);
    return null;
  }
  return w;
}
