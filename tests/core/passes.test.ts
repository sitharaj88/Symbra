import { describe, it, expect, afterEach } from 'vitest';
import { indexRepo } from '../../src/index/indexer.js';
import { Store } from '../../src/store/db.js';
import { callersOf, impact, shortestPath } from '../../src/query/graph.js';
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

describe('passes edges: callables passed as values', () => {
  it('JS: `app.get("/x", handler)` passes the handler; callers/impact/path see it', async () => {
    const r = repo({
      'src/handlers.js': ['function listUsersHandler(req, res) {', '  res.send([]);', '}', 'module.exports = { listUsersHandler };', ''].join('\n'),
      'src/routes.js': ['const { listUsersHandler } = require("./handlers");', '', 'function registerRoutes(app) {', '  app.get("/users", listUsersHandler);', '}', 'module.exports = registerRoutes;', ''].join('\n'),
    });
    await indexRepo({ root: r.root, dbPath: r.dbPath, full: true });
    const store = new Store(r.dbPath);
    try {
      const target = 'src/handlers.js::listUsersHandler';
      const e = store.edgesFrom('src/routes.js::registerRoutes').find((x) => x.dst === target);
      expect(e?.kind).toBe('passes');
      expect(callersOf(store, target, ['calls', 'references', 'passes']).map((c) => c.symbol.id)).toContain('src/routes.js::registerRoutes');
      expect(impact(store, [target]).affected.map((a) => a.symbol.id)).toContain('src/routes.js::registerRoutes');
      const path = shortestPath(store, 'src/routes.js::registerRoutes', target, { directed: true });
      expect(path?.map((h) => h.symbol.id)).toEqual(['src/routes.js::registerRoutes', target]);
      expect(path?.[1]?.via?.kind).toBe('passes');
    } finally {
      store.close();
    }
  });

  it('C: a function-pointer table entry passes the function', async () => {
    const r = repo({
      'src/errors.c': ['#include <stdio.h>', '', 'static void report_error(const char *m) {', '  fputs(m, stderr);', '}', '', 'struct handler { const char *name; void (*fn)(const char *); };', '', 'static struct handler handlers[] = {', '  { "err", report_error },', '};', '', 'void dispatch_all(void) {', '  handlers[0].fn("x");', '}', ''].join('\n'),
    });
    await indexRepo({ root: r.root, dbPath: r.dbPath, full: true });
    const store = new Store(r.dbPath);
    try {
      const rows = store.prep("SELECT src, kind FROM edges WHERE dst = ? AND kind = 'passes'").all('src/errors.c::report_error') as { src: string; kind: string }[];
      expect(rows.length).toBeGreaterThan(0);
    } finally {
      store.close();
    }
  });

  it('Python: a function passed as a call argument passes; a plain data value still references', async () => {
    const r = repo({
      'pkg/util.py': ['def parse_line(s):', '    return s', '', 'DEFAULT_SEP = ","', ''].join('\n'),
      'pkg/main.py': ['from .util import parse_line, DEFAULT_SEP', '', 'def run(lines):', '    return list(map(parse_line, lines)) + split_all(DEFAULT_SEP)', ''].join('\n'),
    });
    await indexRepo({ root: r.root, dbPath: r.dbPath, full: true });
    const store = new Store(r.dbPath);
    try {
      const edges = store.edgesFrom('pkg/main.py::run');
      expect(edges.find((x) => x.dst === 'pkg/util.py::parse_line')?.kind).toBe('passes');
      expect(edges.find((x) => x.dst === 'pkg/util.py::DEFAULT_SEP')?.kind).toBe('references');
    } finally {
      store.close();
    }
  });
});
