import { describe, it, expect, afterEach } from 'vitest';
import { indexRepo } from '../../src/index/indexer.js';
import { Store } from '../../src/store/db.js';
import { detectSwiftTargets, parseSwiftPackage } from '../../src/index/project.js';
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

const manifest = [
  '// swift-tools-version: 5.9',
  'import PackageDescription',
  '',
  'let package = Package(name: "Demo",',
  '                      targets: [.target(name: "Demo",',
  '                                        path: "Sources/Demo"),',
  '                                .testTarget(name: "DemoTests",',
  '                                            dependencies: ["Demo"],',
  '                                            path: "Tests/DemoTests")])',
  '',
].join('\n');

const swiftRepo = {
  'Package.swift': manifest,
  // Two files of one target, in different directories and with no import between them.
  'Sources/Demo/Core/Session.swift': ['public class Session {', '    public func perform(_ url: String) -> String {', '        return url', '    }', '}', ''].join('\n'),
  'Sources/Demo/Features/Upload.swift': ['public func uploadFile(_ path: String) -> String {', '    let session = Session()', '    return session.perform(path)', '}', ''].join('\n'),
  // A test target that imports the module by name.
  'Tests/DemoTests/SessionTests.swift': ['import XCTest', 'import Demo', '', 'final class SessionTests: XCTestCase {', '    func testPerform() {', '        let session = Demo.Session()', '        _ = session.perform("/x")', '    }', '}', ''].join('\n'),
};

describe('swift target scope', () => {
  it('parses Package.swift targets and maps every file to its target', () => {
    const targets = parseSwiftPackage(manifest);
    expect(targets).toEqual([
      { name: 'Demo', path: 'Sources/Demo' },
      { name: 'DemoTests', path: 'Tests/DemoTests' },
    ]);
    const r = repo(swiftRepo);
    const files = new Set(Object.keys(swiftRepo));
    const map = detectSwiftTargets(r.root, files);
    expect(map.get('Sources/Demo/Core/Session.swift')).toBe('Demo');
    expect(map.get('Sources/Demo/Features/Upload.swift')).toBe('Demo');
    expect(map.get('Tests/DemoTests/SessionTests.swift')).toBe('DemoTests');
    // The manifest itself is not part of any target.
    expect(map.has('Package.swift')).toBe(false);
  });

  it('falls back to the Sources/<Target> layout without a manifest', () => {
    const r = repo({ 'Sources/Alpha/A.swift': 'public class A {}\n', 'Sources/Beta/B.swift': 'public class B {}\n', 'Example/Main.swift': 'public class M {}\n' });
    const map = detectSwiftTargets(r.root, new Set(['Sources/Alpha/A.swift', 'Sources/Beta/B.swift', 'Example/Main.swift']));
    expect(map.get('Sources/Alpha/A.swift')).toBe('Alpha');
    expect(map.get('Sources/Beta/B.swift')).toBe('Beta');
    expect(map.get('Example/Main.swift')).toBe('Example');
  });

  it('resolves across files of one target without an import, and binds `import <Target>`', async () => {
    const r = repo(swiftRepo);
    await indexRepo({ root: r.root, dbPath: r.dbPath, full: true });
    const store = new Store(r.dbPath);
    try {
      const sessionId = 'Sources/Demo/Core/Session.swift::Session';
      // Same target, different directory, no import: package scope.
      const fromUpload = store.edgesFrom('Sources/Demo/Features/Upload.swift::uploadFile');
      const toSession = fromUpload.find((e) => e.dst === sessionId);
      expect(toSession).toBeTruthy();
      expect(toSession!.resolver).toBe('scope');

      // `import Demo` in the test target resolves to a file of the target...
      const imports = store.edgesFrom('Tests/DemoTests/SessionTests.swift').filter((e) => e.kind === 'imports');
      expect(imports.map((e) => e.dst).some((d) => d.startsWith('Sources/Demo/'))).toBe(true);
      // ...and `Demo.Session` reaches the type through it.
      const fromTest = store.edgesFrom('Tests/DemoTests/SessionTests.swift::SessionTests.testPerform');
      expect(fromTest.map((e) => e.dst)).toContain(sessionId);
    } finally {
      store.close();
    }
  });
});
