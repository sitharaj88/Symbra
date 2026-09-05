import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFile } from '../../src/index/extract.js';
import { registerLanguage } from '../../src/languages/registry.js';
import { groovy } from '../../src/languages/groovy.js';

registerLanguage(groovy);
const src = readFileSync(new URL('../fixtures/groovy/sample.groovy', import.meta.url), 'utf8');
const gradle = readFileSync(new URL('../fixtures/groovy/build.gradle', import.meta.url), 'utf8');
const spec = readFileSync(new URL('../fixtures/groovy/UserRepoSpec.groovy', import.meta.url), 'utf8');
const PATH = 'src/main/groovy/com/example/repo/sample.groovy';
const SPEC_PATH = 'src/test/groovy/com/example/repo/UserRepoSpec.groovy';

describe('groovy extractor', () => {
  it('extracts classes, members, docs and signatures', async () => {
    const ir = (await extractFile(PATH, src))!;
    const by = Object.fromEntries(ir.definitions.map((d) => [d.fqn, d]));

    expect(by['BaseRepo'].kind).toBe('class');
    expect(by['BaseRepo'].doc).toBe('A base repository.');
    expect(by['BaseRepo'].modifiers).toContain('abstract');
    expect(by['UserRepo'].supertypes).toEqual([
      { name: 'BaseRepo', kind: 'extends' },
      { name: 'Repo', kind: 'implements' },
    ]);
    expect(by['UserRepo'].meta?.annotations).toBe('CompileStatic');
    expect(by['UserRepo.UserRepo'].kind).toBe('constructor');
    expect(by['UserRepo.session']).toMatchObject({ kind: 'field', declaredType: 'Session' });
    expect(by['UserRepo.session'].doc).toBe('The backing session.');
    expect(by['UserRepo.MAX_RETRIES'].kind).toBe('constant');
    expect(by['UserRepo.find']).toMatchObject({ kind: 'method', declaredType: 'User' });
    expect(by['UserRepo.find'].doc).toBe('Find a user by id.');
    expect(by['UserRepo.normalize'].exported).toBe(false);
    expect(by['Repo'].kind).toBe('interface');
    expect(by['Status'].kind).toBe('enum');
    expect(ir.definitions.filter((d) => d.kind === 'enum_member').map((d) => d.name)).toEqual(['ACTIVE', 'INACTIVE']);
    expect(by['topLevel'].kind).toBe('function');
    // `def handler = { … }` is a callable, not a variable
    expect(by['handler']).toMatchObject({ kind: 'function', meta: { closure: true } });
  });

  it('extracts imports and resolves them against the JVM source roots', async () => {
    const ir = (await extractFile(PATH, src))!;
    expect(ir.imports.map((i) => i.source)).toEqual(['groovy.transform.CompileStatic', 'com.example.model.User']);
    const cands = groovy.resolveModule('com.example.model.User', PATH, ir.imports[1]!, { hasFile: () => true, jvmRoots: ['src/main/groovy'] });
    expect(cands).toContain('src/main/groovy/com/example/model/User.groovy');
  });

  it('extracts calls, constructor calls, receiver facts and config reads', async () => {
    const ir = (await extractFile(PATH, src))!;
    const calls = ir.references.filter((r) => r.kind === 'call' || r.kind === 'new');
    expect(calls.some((c) => c.kind === 'call' && c.name === 'get' && c.qualifier === 'local' && c.arity === 1)).toBe(true);
    expect(calls.some((c) => c.kind === 'call' && c.name === 'normalize' && c.qualifier === '')).toBe(true);
    expect(calls.some((c) => c.kind === 'new' && c.name === 'User')).toBe(true);
    expect(calls.some((c) => c.name === 'println')).toBe(false);
    expect(ir.localTypes.some((t) => t.name === 'local' && t.type === 'Session' && t.via === 'annotation')).toBe(true);
    expect(ir.localTypes.some((t) => t.name === 'u' && t.type === 'User')).toBe(true);
    expect(ir.localTypes.some((t) => t.name === 'cached' && t.type === 'User' && t.via === 'new')).toBe(true);
    expect(ir.references.some((r) => r.kind === 'decorator' && r.name === 'CompileStatic')).toBe(true);
    expect(ir.references.some((r) => r.kind === 'config' && r.name === 'API_TOKEN')).toBe(true);
  });

  it('recovers Spock specifications and their feature methods', async () => {
    const ir = (await extractFile(SPEC_PATH, spec))!;
    expect(ir.definitions[0]).toMatchObject({ kind: 'class', name: 'UserRepoSpec', supertypes: [{ name: 'Specification', kind: 'extends' }] });
    const feature = ir.definitions.find((d) => d.kind === 'test')!;
    expect(feature.name).toBe('finds a user by id');
    expect(feature.fqn).toBe('UserRepoSpec.finds a user by id');
    expect(feature.meta?.framework).toBe('spock');
  });
});

describe('gradle build scripts', () => {
  const GPATH = 'build.gradle';

  it('reads dependencies and plugins as imports', async () => {
    const ir = (await extractFile(GPATH, gradle))!;
    expect(ir.imports.map((i) => i.source)).toEqual([
      'java',
      'org.springframework.boot',
      'groovy',
      'com.google.guava:guava:31.1-jre',
      ':core',
      ':shared',
      'junit:junit',
    ]);
    expect(ir.imports.every((i) => i.kind === 'dynamic')).toBe(true);
    expect(ir.imports.find((i) => i.source === ':core')!.line).toBe(10);
  });

  it('resolves project dependencies to the subproject build script', async () => {
    const ir = (await extractFile(GPATH, gradle))!;
    const proj = ir.imports.find((i) => i.source === ':core')!;
    expect(groovy.resolveModule(':core', GPATH, proj, { hasFile: () => true })).toEqual([
      'core/build.gradle',
      'core/build.gradle.kts',
      'core/settings.gradle',
    ]);
    // external coordinates and plugin ids have no file
    expect(groovy.resolveModule('com.google.guava:guava:31.1-jre', GPATH, proj, { hasFile: () => true })).toEqual([]);
    expect(groovy.resolveModule('org.springframework.boot', GPATH, proj, { hasFile: () => true })).toEqual([]);
  });

  it('extracts task definitions and their dependsOn references', async () => {
    const ir = (await extractFile(GPATH, gradle))!;
    const tasks = ir.definitions.filter((d) => d.meta?.task);
    expect(tasks.map((t) => t.name)).toEqual(['buildDocs', 'publishDocs']);
    expect(tasks[0].kind).toBe('function');
    const values = ir.references.filter((r) => r.kind === 'value');
    expect(values.some((r) => r.name === 'compileJava')).toBe(true);
    expect(values.some((r) => r.name === 'buildDocs')).toBe(true);
  });
});
