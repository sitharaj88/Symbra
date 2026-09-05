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

/**
 * A Kotlin Multiplatform layout: source sets and modules split one package over several
 * directories, and file names have nothing to do with the classes they declare.
 */
const files = {
  // `Models.kt` declares `Assignment` — the file name is not the class name.
  'common/src/commonMain/kotlin/com/x/model/Models.kt': ['package com.x.model', '', 'data class Assignment(val name: String, val craft: String)', '', 'data class IssPosition(val latitude: Double, val longitude: Double)', ''].join('\n'),
  // Same package, a different source set: no import needed to see `Assignment`.
  'common/src/androidMain/kotlin/com/x/model/Platform.kt': ['package com.x.model', '', 'fun defaultAssignment(): Assignment {', '    return Assignment("nobody", "none")', '}', ''].join('\n'),
  // Top-level function, imported by name from another module.
  'common/src/commonMain/kotlin/com/x/util/Format.kt': ['package com.x.util', '', 'fun formatName(a: String): String {', '    return a.trim()', '}', ''].join('\n'),
  // Another module, another source set, importing across both.
  'androidApp/src/main/java/com/x/ui/Screen.kt': ['package com.x.ui', '', 'import com.x.model.Assignment', 'import com.x.util.formatName', '', 'class Screen {', '    fun show(): String {', '        val a = Assignment("Bob", "ISS")', '        return formatName(a.name)', '    }', '}', ''].join('\n'),
  // Wildcard import of a whole package.
  'androidApp/src/main/java/com/x/ui/Widget.kt': ['package com.x.ui', '', 'import com.x.model.*', '', 'class Widget {', '    fun position(): IssPosition {', '        return IssPosition(0.0, 0.0)', '    }', '}', ''].join('\n'),
  // Java in the same repo: static import of a member of a Kotlin-free Java class.
  'backend/src/main/java/com/x/support/Ids.java': ['package com.x.support;', '', 'public final class Ids {', '    public static int nextId() {', '        return 1;', '    }', '}', ''].join('\n'),
  'backend/src/main/java/com/x/api/Handler.java': ['package com.x.api;', '', 'import static com.x.support.Ids.nextId;', '', 'public class Handler {', '    public int handle() {', '        return nextId();', '    }', '}', ''].join('\n'),
};

const ASSIGNMENT = 'common/src/commonMain/kotlin/com/x/model/Models.kt::Assignment';

describe('jvm package index', () => {
  it('resolves an import to a class whose file has a different name', async () => {
    const r = repo(files);
    await indexRepo({ root: r.root, dbPath: r.dbPath, full: true });
    const store = new Store(r.dbPath);
    try {
      // module -> module `imports` edge, even though `com/x/model/Assignment.kt` does not exist.
      const imports = store.edgesFrom('androidApp/src/main/java/com/x/ui/Screen.kt').filter((e) => e.kind === 'imports');
      expect(imports.map((e) => e.dst)).toContain('common/src/commonMain/kotlin/com/x/model/Models.kt');
      expect(imports.map((e) => e.dst)).toContain('common/src/commonMain/kotlin/com/x/util/Format.kt');

      const show = store.edgesFrom('androidApp/src/main/java/com/x/ui/Screen.kt::Screen.show');
      const toAssignment = show.find((e) => e.dst === ASSIGNMENT);
      expect(toAssignment).toBeTruthy();
      expect(toAssignment!.resolver).toBe('import');
      expect(toAssignment!.confidence).toBe(1);

      // Kotlin top-level function imported by name.
      const toFormat = show.find((e) => e.dst === 'common/src/commonMain/kotlin/com/x/util/Format.kt::formatName');
      expect(toFormat).toBeTruthy();
      expect(toFormat!.resolver).toBe('import');
    } finally {
      store.close();
    }
  });

  it('shares a package across source sets without an import', async () => {
    const r = repo(files);
    await indexRepo({ root: r.root, dbPath: r.dbPath, full: true });
    const store = new Store(r.dbPath);
    try {
      const edges = store.edgesFrom('common/src/androidMain/kotlin/com/x/model/Platform.kt::defaultAssignment');
      const toAssignment = edges.find((e) => e.dst === ASSIGNMENT);
      expect(toAssignment).toBeTruthy();
      expect(toAssignment!.resolver).toBe('scope');
    } finally {
      store.close();
    }
  });

  it('binds a wildcard import to every member of the package', async () => {
    const r = repo(files);
    await indexRepo({ root: r.root, dbPath: r.dbPath, full: true });
    const store = new Store(r.dbPath);
    try {
      const imports = store.edgesFrom('androidApp/src/main/java/com/x/ui/Widget.kt').filter((e) => e.kind === 'imports');
      expect(imports.map((e) => e.dst)).toContain('common/src/commonMain/kotlin/com/x/model/Models.kt');

      const edges = store.edgesFrom('androidApp/src/main/java/com/x/ui/Widget.kt::Widget.position');
      const toPos = edges.find((e) => e.dst === 'common/src/commonMain/kotlin/com/x/model/Models.kt::IssPosition');
      expect(toPos).toBeTruthy();
      expect(toPos!.resolver).toBe('import');
    } finally {
      store.close();
    }
  });

  it('resolves a Java static import through the package index', async () => {
    const r = repo(files);
    await indexRepo({ root: r.root, dbPath: r.dbPath, full: true });
    const store = new Store(r.dbPath);
    try {
      const edges = store.edgesFrom('backend/src/main/java/com/x/api/Handler.java::Handler.handle');
      const toNext = edges.find((e) => e.dst === 'backend/src/main/java/com/x/support/Ids.java::Ids.nextId');
      expect(toNext).toBeTruthy();
      expect(toNext!.resolver).toBe('import');
    } finally {
      store.close();
    }
  });
});
