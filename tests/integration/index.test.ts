import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { indexRepo } from '../../src/index/indexer.js';
import { Store } from '../../src/store/db.js';
import { search, findSymbols } from '../../src/query/search.js';
import { callersOf, impact, shortestPath, testsFor } from '../../src/query/graph.js';
import { explore } from '../../src/query/explore.js';
import { overview } from '../../src/query/overview.js';

const root = fileURLToPath(new URL('../fixtures/repo', import.meta.url));
let dbDir: string;
let store: Store;

beforeAll(async () => {
  dbDir = mkdtempSync(join(tmpdir(), 'symbra-test-'));
  const stats = await indexRepo({ root, dbPath: join(dbDir, 'index.db') });
  expect(stats.files).toBe(6); // empty __init__.py files are skipped
  store = new Store(join(dbDir, 'index.db'));
});
afterAll(() => {
  store.close();
  rmSync(dbDir, { recursive: true, force: true });
});

describe('end-to-end index', () => {
  it('resolves relative and package imports across files', () => {
    const svc = store.getSymbol('src/services/user_service.py::UserService.greet')!;
    expect(svc).toBeTruthy();
    const callees = store.edgesFrom(svc.id).map((e) => `${e.kind}:${e.dst}:${e.resolver}`);
    expect(callees).toContain('calls:src/models/user.py::User:import'); // via __init__ re-export
    expect(callees).toContain('calls:src/services/store.py::Store.save:receiver'); // self.store typed Store
    expect(callees).toContain('calls:src/models/user.py::User.display:receiver'); // user = User(name)
  });
  it('links inheritance and super calls', () => {
    const admin = store.getSymbol('src/models/user.py::Admin')!;
    expect(store.edgesFrom(admin.id).some((e) => e.kind === 'extends' && e.dst === 'src/models/user.py::User')).toBe(true);
    const disp = store.getSymbol('src/models/user.py::Admin.display')!;
    expect(store.edgesFrom(disp.id).some((e) => e.kind === 'calls' && e.dst === 'src/models/user.py::User.display')).toBe(true);
  });
  it('records config reads and test coverage', () => {
    const tok = store.getSymbol('env::API_TOKEN');
    expect(tok?.kind).toBe('config_key');
    const greet = store.getSymbol('src/services/user_service.py::UserService.greet')!;
    expect(testsFor(store, greet.id).map((t) => t.name)).toEqual(['test_greet']);
  });
  it('links docs to code', () => {
    const disp = store.getSymbol('src/models/user.py::User.display')!;
    const fromDocs = callersOf(store, disp.id, ['references']).filter((c) => c.symbol.file === 'README.md');
    expect(fromDocs.length).toBe(1);
    expect(store.edgesFrom('README.md').some((e) => e.kind === 'imports' && e.dst === 'src/services/store.py')).toBe(true);
  });
  it('search, impact, path and explore work', () => {
    expect(findSymbols(store, 'UserService')[0]?.file).toBe('src/services/user_service.py');
    expect(search(store, 'greet users')[0]?.symbol.name).toBe('greet');
    const r = impact(store, ['src/services/store.py::Store.save']);
    expect(r.affected.map((a) => a.symbol.fqn)).toContain('UserService.greet');
    expect(r.tests.map((t) => t.name)).toContain('test_greet');
    const p = shortestPath(store, 'src/services/user_service.py::UserService', 'src/models/user.py::User')!;
    expect(p.length).toBe(3);
    const pack = explore(store, 'how does greeting work', { root, budget: 1500 });
    expect(pack.text).toContain('UserService.greet');
    expect(pack.tokens).toBeLessThan(1800);
    expect(overview(store, root).text).toContain('## Hubs');
  });
});
