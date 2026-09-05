import { describe, it, expect, afterEach } from 'vitest';
import { isPeripheralPath } from '../../src/analyze/peripheral.js';
import { indexRepo } from '../../src/index/indexer.js';
import { Store } from '../../src/store/db.js';
import { overview } from '../../src/query/overview.js';
import { makeRepo, type TempRepo } from './helpers.js';

const repos: TempRepo[] = [];
function repo(files: Record<string, string> = {}): TempRepo {
  const r = makeRepo(files);
  repos.push(r);
  return r;
}
afterEach(() => {
  while (repos.length) repos.pop()!.cleanup();
});

describe('isPeripheralPath', () => {
  it('flags Flutter platform scaffolding only at a Flutter/KMP root', () => {
    expect(isPeripheralPath('android/app/src/main/kotlin/com/x/MainActivity.kt', true)).toBe(true);
    expect(isPeripheralPath('ios/Runner/AppDelegate.swift', true)).toBe(true);
    expect(isPeripheralPath('lib/features/x.dart', true)).toBe(false);
  });

  it('flags migration snapshots regardless of repo shape', () => {
    expect(isPeripheralPath('migrations/20240101120000000/definition.sql', false)).toBe(true);
    expect(isPeripheralPath('migrations/20240101120000000/definition.sql', true)).toBe(true);
    expect(isPeripheralPath('db/migrate/001_create_users.rb', false)).toBe(true);
    expect(isPeripheralPath('src/foo.migration.ts', false)).toBe(true);
  });

  it('does not flag web/ as peripheral in a non-Flutter repo', () => {
    expect(isPeripheralPath('web/index.html', false)).toBe(false);
    // the same directory is peripheral scaffolding once the repo root is a Flutter/KMP project
    expect(isPeripheralPath('web/index.html', true)).toBe(true);
  });

  it('flags a generated platform Runner folder unconditionally', () => {
    expect(isPeripheralPath('windows/runner/main.cpp', false)).toBe(true);
    expect(isPeripheralPath('macos/Runner/AppDelegate.swift', false)).toBe(true);
  });

  it('leaves ordinary production code alone', () => {
    expect(isPeripheralPath('src/features/tasks/service.ts', false)).toBe(false);
    expect(isPeripheralPath('src/features/tasks/service.ts', true)).toBe(false);
  });

  it('does not flag a Java-style com.example/org.example package segment as a demo directory', () => {
    // At a Flutter root, this path is peripheral only because of the `android/` platform rule,
    // not because `example` looks like a demo/examples directory.
    expect(isPeripheralPath('android/app/src/main/java/com/example/lifehub/MainActivity.kt', true)).toBe(true);
    // The same path outside an android/ platform root, in a plain Gradle project, is not
    // peripheral at all: `com/example` must not be treated as a demo/examples directory.
    expect(isPeripheralPath('app/src/main/java/com/example/lifehub/MainActivity.kt', false)).toBe(false);
    expect(isPeripheralPath('org/example/lifehub/MainActivity.kt', false)).toBe(false);
    // A real examples/samples directory is still peripheral.
    expect(isPeripheralPath('examples/basic/main.py', false)).toBe(true);
  });
});

/** Build a chain of `count` functions in one file, each calling the next, so Louvain groups them
 *  into a single cohesive community. */
function chain(prefix: string, count: number): string {
  const lines: string[] = [];
  for (let i = 1; i <= count; i++) {
    const next = i < count ? `${prefix}${i + 1}()` : '';
    lines.push(`export function ${prefix}${i}() { ${next}; }`);
  }
  return lines.join('\n') + '\n';
}

describe('peripheral communities (index -> overview)', () => {
  it('flags a migrations community and lists it in the overview peripheral summary', async () => {
    const r = repo({
      'migrations/0001_init.ts': chain('migInit', 10),
      'migrations/0002_add_posts.ts': chain('migPosts', 10),
      'src/features/tasks.ts': `
export function loadTasks() { return renderTasks(); }
export function renderTasks() { return sortTasks(); }
export function sortTasks() { return filterTasks(); }
export function filterTasks() { return summarizeTasks(); }
export function summarizeTasks() { return exportTasks(); }
export function exportTasks() { return archiveTasks(); }
export function archiveTasks() { return restoreTasks(); }
export function restoreTasks() { return validateTasks(); }
export function validateTasks() { return notifyTasks(); }
export function notifyTasks() { return syncTasks(); }
export function syncTasks() { return true; }
`,
      'src/features/profile.ts': `
import { syncTasks } from './tasks.js';
export function loadProfile() { return renderProfile(); }
export function renderProfile() { return updateProfile(); }
export function updateProfile() { return saveProfile(); }
export function saveProfile() { syncTasks(); return true; }
`,
    });
    await indexRepo({ root: r.root, dbPath: r.dbPath });
    const store = new Store(r.dbPath);
    try {
      const labels = store.prep('SELECT community, label, size, peripheral FROM community_labels WHERE level = 0 ORDER BY size DESC').all() as { community: number; label: string; size: number; peripheral: number }[];
      expect(labels.length).toBeGreaterThan(0);

      // Every community whose members are dominated by migrations/ files must be flagged.
      const membersByCommunity = new Map<number, string[]>();
      for (const row of store.prep('SELECT c.community AS community, s.file AS file FROM communities c JOIN symbols s ON s.id = c.symbol WHERE c.level = 0').all() as { community: number; file: string }[]) {
        const arr = membersByCommunity.get(row.community) ?? [];
        arr.push(row.file);
        membersByCommunity.set(row.community, arr);
      }
      const migrationCommunities = labels.filter((l) => {
        const files = membersByCommunity.get(l.community) ?? [];
        return files.length > 0 && files.every((f) => f.startsWith('migrations/'));
      });
      expect(migrationCommunities.length).toBeGreaterThan(0);
      for (const c of migrationCommunities) expect(c.peripheral).toBe(1);

      // A community made of the real feature files must not be flagged.
      const featureCommunities = labels.filter((l) => {
        const files = membersByCommunity.get(l.community) ?? [];
        return files.some((f) => f.startsWith('src/features/'));
      });
      expect(featureCommunities.length).toBeGreaterThan(0);
      for (const c of featureCommunities) expect(c.peripheral).toBe(0);

      const ov = overview(store, r.root, { communities: 20 });
      expect(ov.text).toMatch(/Peripheral \(migrations, platform scaffolding, docs\):/);
      for (const c of migrationCommunities) expect(ov.text).toContain(`#${c.community}`);
      expect(ov.peripheralCommunities.map((c) => c.id).sort()).toEqual(migrationCommunities.map((c) => c.community).sort());
      // The flagged communities are summarized, not spelled out as full "## Subsystems" entries.
      for (const c of migrationCommunities) expect(ov.communities.some((x) => x.id === c.community)).toBe(false);
    } finally {
      store.close();
    }
  });
});
