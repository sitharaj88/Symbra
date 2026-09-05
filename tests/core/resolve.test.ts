import { describe, it, expect, afterEach } from 'vitest';
import { indexRepo } from '../../src/index/indexer.js';
import { Store } from '../../src/store/db.js';
import { makeRepo, type TempRepo } from './helpers.js';

const repos: TempRepo[] = [];
function repo(files: Record<string, string>): TempRepo {
  const r = makeRepo(files);
  repos.push(r);
  return r;
}
afterEach(() => {
  while (repos.length) repos.pop()!.cleanup();
});

describe('resolver: corpus-wide Container.name tier', () => {
  it('does not bind a local receiver’s unknown member to a same-named member elsewhere', async () => {
    const r = repo({
      // An unrelated object-literal API that happens to expose a member called `get`.
      'lib/unrelated.js': ['const bag = {', '  get(x) {', '    return x;', '  },', '};', 'module.exports = bag;', ''].join('\n'),
      // `bag` here is a local holding an external framework object: its `get` is not ours.
      'src/server.js': ['const framework = require("framework");', '', 'const bag = framework();', '', 'function boot() {', '  return bag.get("/x");', '}', '', 'module.exports = boot;', ''].join('\n'),
    });
    await indexRepo({ root: r.root, dbPath: r.dbPath, full: true });
    const store = new Store(r.dbPath);
    try {
      const edges = store.edgesFrom('src/server.js::boot');
      expect(edges.map((e) => e.dst)).not.toContain('lib/unrelated.js::bag.get');
    } finally {
      store.close();
    }
  });

  it('still resolves a qualifier it knows nothing about, at reduced confidence for a lowercase container', async () => {
    const r = repo({
      'lib/thing.js': ['const helperBag = {', '  computeTotal(x) {', '    return x;', '  },', '};', 'module.exports = helperBag;', ''].join('\n'),
      // `helperBag` is never declared or imported here, so the corpus-wide tier is all we have.
      'docs/notes.md': ['# Notes', '', 'See `helperBag.computeTotal` for the maths.', ''].join('\n'),
      'src/other.js': ['function callIt() {', '  return helperBag.computeTotal(1);', '}', 'module.exports = callIt;', ''].join('\n'),
    });
    await indexRepo({ root: r.root, dbPath: r.dbPath, full: true });
    const store = new Store(r.dbPath);
    try {
      const edge = store.edgesFrom('src/other.js::callIt').find((e) => e.dst === 'lib/thing.js::helperBag.computeTotal');
      expect(edge).toBeTruthy();
      // A lowercase container tail is a variable, not a type: heuristic evidence, not unique.
      expect(edge!.resolver).toBe('heuristic');
      expect(edge!.confidence).toBeCloseTo(0.6);
    } finally {
      store.close();
    }
  });
});

describe('resolver: last-resort tier for a common member name with a singleton corpus pool', () => {
  it('binds `$route->run($request)` when exactly one class in the corpus declares `run`, even though `run` is a common name', async () => {
    const r = repo({
      // The only `run` method anywhere in the corpus.
      'src/Route.php': ['<?php', 'class Route {', '  public function run($request) {', '    return $request;', '  }', '}', ''].join('\n'),
      // `$route`'s type is never annotated or constructed here, so no receiver-type tier applies:
      // it comes back from an unannotated call and is only known by the corpus-wide last resort.
      'src/App.php': [
        '<?php',
        'class App {',
        '  public function handle($request) {',
        '    $route = $this->resolveRoute($request);',
        '    return $route->run($request);',
        '  }',
        '}',
        '',
      ].join('\n'),
    });
    await indexRepo({ root: r.root, dbPath: r.dbPath, full: true });
    const store = new Store(r.dbPath);
    try {
      const edge = store.edgesFrom('src/App.php::App.handle').find((e) => e.dst === 'src/Route.php::Route.run');
      expect(edge).toBeTruthy();
      expect(edge!.resolver).toBe('heuristic');
      expect(edge!.confidence).toBeGreaterThanOrEqual(0.5);
    } finally {
      store.close();
    }
  });

  it('does NOT bind a common name to a candidate when more than one class in the corpus declares it', async () => {
    const r = repo({
      'src/RouteA.php': ['<?php', 'class RouteA {', '  public function run($request) {', '    return $request;', '  }', '}', ''].join('\n'),
      'src/RouteB.php': ['<?php', 'class RouteB {', '  public function run($request) {', '    return $request;', '  }', '}', ''].join('\n'),
      'src/App.php': [
        '<?php',
        'class App {',
        '  public function handle($request) {',
        '    $route = $this->resolveRoute($request);',
        '    return $route->run($request);',
        '  }',
        '}',
        '',
      ].join('\n'),
    });
    await indexRepo({ root: r.root, dbPath: r.dbPath, full: true });
    const store = new Store(r.dbPath);
    try {
      const edges = store.edgesFrom('src/App.php::App.handle').filter((e) => e.dst.endsWith('::Route.run') || e.dst.endsWith('.run'));
      expect(edges.map((e) => e.dst)).not.toContain('src/RouteA.php::RouteA.run');
      expect(edges.map((e) => e.dst)).not.toContain('src/RouteB.php::RouteB.run');
    } finally {
      store.close();
    }
  });
});
