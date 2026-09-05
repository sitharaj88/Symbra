import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export interface TempRepo {
  root: string;
  dbPath: string;
  write(rel: string, content: string): void;
  remove(rel: string): void;
  cleanup(): void;
}

/** A throwaway repository plus a database path outside it, for indexRepo({root, dbPath}). */
export function makeRepo(files: Record<string, string> = {}): TempRepo {
  const base = mkdtempSync(join(tmpdir(), 'symbra-core-'));
  const root = join(base, 'repo');
  mkdirSync(root, { recursive: true });
  const repo: TempRepo = {
    root,
    dbPath: join(base, 'db', 'index.db'),
    write(rel, content) {
      const abs = join(root, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    },
    remove(rel) {
      rmSync(join(root, rel), { force: true });
    },
    cleanup() {
      rmSync(base, { recursive: true, force: true });
    },
  };
  for (const [rel, content] of Object.entries(files)) repo.write(rel, content);
  return repo;
}
