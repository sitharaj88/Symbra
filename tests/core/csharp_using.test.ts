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

const files = {
  // File-scoped namespace.
  'src/Acme.Data/UserRepo.cs': ['namespace Acme.Data;', '', 'public class UserRepo', '{', '    public string Find(int id) => "u";', '}', ''].join('\n'),
  // Same namespace, another file, no `using` at all.
  'src/Acme.Data/Cache.cs': ['namespace Acme.Data;', '', 'public class Cache', '{', '    public UserRepo Get()', '    {', '        return new UserRepo();', '    }', '}', ''].join('\n'),
  'src/Acme.Data/Ids.cs': ['namespace Acme.Data;', '', 'public static class Ids', '{', '    public static int NextId() => 1;', '}', ''].join('\n'),
  // Block namespace in another namespace, reaching Acme.Data through a `using`.
  'src/Acme.App/Service.cs': ['using Acme.Data;', '', 'namespace Acme.App', '{', '    public class Service', '    {', '        public string Run()', '        {', '            var repo = new UserRepo();', '            return repo.Find(1);', '        }', '    }', '}', ''].join('\n'),
  // Alias and static usings.
  'src/Acme.App/Aliased.cs': ['using Repo = Acme.Data.UserRepo;', 'using static Acme.Data.Ids;', '', 'namespace Acme.App;', '', 'public class Aliased', '{', '    public string Go()', '    {', '        var r = new Repo();', '        return r.Find(NextId());', '    }', '}', ''].join('\n'),
  // A `global using` declared once, used by a file that imports nothing.
  'src/GlobalUsings.cs': ['global using Acme.Data;', ''].join('\n'),
  'src/Acme.Web/Consumer.cs': ['namespace Acme.Web;', '', 'public class Consumer', '{', '    public string Load()', '    {', '        var repo = new UserRepo();', '        return repo.Find(2);', '    }', '}', ''].join('\n'),
};

const REPO = 'src/Acme.Data/UserRepo.cs::Acme.Data.UserRepo';

describe('csharp using directives', () => {
  it('binds `using X.Y` to the namespace files and their symbols', async () => {
    const r = repo(files);
    await indexRepo({ root: r.root, dbPath: r.dbPath, full: true });
    const store = new Store(r.dbPath);
    try {
      // `using Acme.Data;` becomes module -> module imports edges.
      const imports = store.edgesFrom('src/Acme.App/Service.cs').filter((e) => e.kind === 'imports');
      expect(imports.map((e) => e.dst)).toContain('src/Acme.Data/UserRepo.cs');
      expect(imports.map((e) => e.dst)).toContain('src/Acme.Data/Cache.cs');

      // `new UserRepo()` binds at the import tier, not by corpus-wide uniqueness.
      const run = store.edgesFrom('src/Acme.App/Service.cs::Acme.App.Service.Run');
      const toRepo = run.find((e) => e.dst === REPO);
      expect(toRepo).toBeTruthy();
      expect(toRepo!.resolver).toBe('import');
      expect(toRepo!.confidence).toBe(1);
      expect(run.map((e) => e.dst)).toContain('src/Acme.Data/UserRepo.cs::Acme.Data.UserRepo.Find');
    } finally {
      store.close();
    }
  });

  it('resolves same-namespace siblings that declare no using', async () => {
    const r = repo(files);
    await indexRepo({ root: r.root, dbPath: r.dbPath, full: true });
    const store = new Store(r.dbPath);
    try {
      const get = store.edgesFrom('src/Acme.Data/Cache.cs::Acme.Data.Cache.Get');
      const toRepo = get.find((e) => e.dst === REPO);
      expect(toRepo).toBeTruthy();
      expect(toRepo!.resolver).toBe('import');
    } finally {
      store.close();
    }
  });

  it('handles alias, static and global usings', async () => {
    const r = repo(files);
    await indexRepo({ root: r.root, dbPath: r.dbPath, full: true });
    const store = new Store(r.dbPath);
    try {
      // `using Repo = Acme.Data.UserRepo;` and `using static Acme.Data.Ids;`
      const go = store.edgesFrom('src/Acme.App/Aliased.cs::Acme.App.Aliased.Go');
      expect(go.map((e) => e.dst)).toContain(REPO);
      expect(go.map((e) => e.dst)).toContain('src/Acme.Data/Ids.cs::Acme.Data.Ids.NextId');

      // `global using Acme.Data;` from src/GlobalUsings.cs reaches a file that imports nothing.
      const load = store.edgesFrom('src/Acme.Web/Consumer.cs::Acme.Web.Consumer.Load');
      const toRepo = load.find((e) => e.dst === REPO);
      expect(toRepo).toBeTruthy();
      expect(toRepo!.resolver).toBe('import');
    } finally {
      store.close();
    }
  });
});
