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

async function edgesOf(r: TempRepo, src: string) {
  await indexRepo({ root: r.root, dbPath: r.dbPath, full: true });
  const store = new Store(r.dbPath);
  try {
    return store.edgesFrom(src);
  } finally {
    store.close();
  }
}

describe('resolver: implicit-self member calls', () => {
  it('Java: a bare call inside a method binds to an inherited method', async () => {
    const r = repo({
      'src/main/java/acme/Base.java': ['package acme;', '', 'public class Base {', '  protected void normalizeInput(String s) {', '    System.out.println(s);', '  }', '}', ''].join('\n'),
      'src/main/java/acme/Child.java': ['package acme;', '', 'public class Child extends Base {', '  public void run(String s) {', '    normalizeInput(s);', '  }', '}', ''].join('\n'),
    });
    const edges = await edgesOf(r, 'src/main/java/acme/Child.java::Child.run');
    const e = edges.find((x) => x.kind === 'calls' && x.dst === 'src/main/java/acme/Base.java::Base.normalizeInput');
    expect(e).toBeTruthy();
    expect(e!.resolver).toBe('receiver');
    expect(e!.confidence).toBeCloseTo(0.95);
  });

  it('Ruby: a bare `process_route` inside a class method binds to the sibling method', async () => {
    const r = repo({
      'lib/sinatra/base.rb': ['module Sinatra', '  class Base', '    def route!(base = settings, pass_block = nil)', '      process_route(pattern, conditions) do |*args|', '        route_eval { block[*args] }', '      end', '    end', '', '    def process_route(pattern, conditions, block = nil, values = [])', '      yield', '    end', '  end', 'end', ''].join('\n'),
    });
    const edges = await edgesOf(r, 'lib/sinatra/base.rb::Sinatra.Base.route!');
    const e = edges.find((x) => x.kind === 'calls' && x.dst === 'lib/sinatra/base.rb::Sinatra.Base.process_route');
    expect(e).toBeTruthy();
    expect(e!.resolver).toBe('receiver');
  });

  it('Python: a bare name inside a method still does NOT bind to a class member', async () => {
    const r = repo({
      'pkg/svc.py': ['class Service:', '    def render_page(self):', '        return 1', '', '    def run(self):', '        return render_page()', ''].join('\n'),
    });
    const edges = await edgesOf(r, 'pkg/svc.py::Service.run');
    expect(edges.map((x) => x.dst)).not.toContain('pkg/svc.py::Service.render_page');
  });
});
