import type { Node } from 'web-tree-sitter';
import type { Import } from '../ir/types.js';
import type { DefSpec, LanguageSupport, WalkContext } from './types.js';
import { oneLine, simpleTypeName, precedingComments, named, kids } from '../parse/walk.js';
import { jvmResolveModule } from './java.js';

/**
 * Groovy and Gradle.
 *
 * Plain Groovy is Java with closures, and the grammar reflects that: `class_declaration`,
 * `method_declaration`, `field_declaration` and friends behave as in the Java extractor.
 *
 * Gradle build scripts are the other half of the job, and there the grammar is much weaker: Groovy
 * command expressions (`api project(':core')`, `dependsOn tasks.named('x')`, `task foo(type: Copy)`)
 * parse into a `juxt_function_call` plus loose siblings or an ERROR. Rather than reassemble those
 * fragments, the two blocks whose contents are pure data — `dependencies { }` and `plugins { }` —
 * are read from their own source text, which is both shorter and far more robust than the tree.
 * Everything outside those blocks is still handled structurally.
 */

const COMMENTS = new Set(['line_comment', 'block_comment']);
const TYPE_LIKE = new Set(['class_declaration', 'interface_declaration', 'enum_declaration', 'annotation_type_declaration', 'record_declaration']);
/** `def` is Groovy's "no declared type": never a real type reference. */
const NON_TYPES = new Set(['def', 'var', 'void', 'int', 'long', 'short', 'byte', 'char', 'float', 'double', 'boolean', 'String', 'Object']);
/** Groovy/GDK globals: calls to these never bind to a symbol in the repo. */
const BUILTIN_CALLS = new Set(['println', 'print', 'printf', 'sleep', 'assert', 'require', 'sprintf', 'use', 'with', 'each', 'collect', 'find', 'findAll', 'inject', 'toString', 'getClass']);
/** Superclasses that turn every method of a class into a test. */
const TEST_SUPERS = /Specification$|GroovyTestCase$|TestCase$|Spock$/;
/** Gradle blocks read from source text instead of from the tree (see the module comment). */
const TEXT_BLOCKS = new Set(['dependencies', 'plugins', 'buildscript']);
/** `tasks.<x>(…)` calls that declare a task. */
const TASK_FACTORIES = new Set(['register', 'create', 'maybeCreate']);

export function isGradleFile(path: string): boolean {
  const base = path.slice(path.lastIndexOf('/') + 1);
  return base.endsWith('.gradle') || base === 'build.gradle' || base === 'settings.gradle';
}

/** Per-file scratch state, keyed on the walk context so nothing leaks between files. */
interface FileState {
  /** Classes whose members are all tests (Spock specifications and JUnit 3 style cases). */
  testClasses: Set<string>;
}
const states = new WeakMap<WalkContext, FileState>();
function state(ctx: WalkContext): FileState {
  let s = states.get(ctx);
  if (!s) {
    s = { testClasses: new Set() };
    states.set(ctx, s);
  }
  return s;
}

function unquote(s: string): string {
  return s.replace(/^(['"]{3}|['"])/, '').replace(/(['"]{3}|['"])$/, '');
}

/** The literal text of a string / GString node, or null when it is not a literal. */
function stringValue(n: Node | null | undefined): string | null {
  if (!n) return null;
  if (n.type === 'character_literal') return unquote(n.text);
  if (n.type === 'string_literal') {
    if (n.text.includes('$')) return null; // interpolated: not a constant
    const frag = named(n).find((c) => c.type === 'string_fragment' || c.type === 'multiline_string_fragment');
    return frag ? frag.text : unquote(n.text);
  }
  return null;
}

function modifiersOf(node: Node): { mods: string[]; annotations: string[] } {
  const mods: string[] = [];
  const annotations: string[] = [];
  const holder = named(node).find((c) => c.type === 'modifiers');
  for (const c of kids(holder)) {
    if (c.type === 'marker_annotation' || c.type === 'annotation') {
      annotations.push(simpleTypeName(c.childForFieldName('name')?.text ?? c.text.replace(/^@/, '')));
      continue;
    }
    const t = c.text.trim();
    if (t && !t.startsWith('@')) mods.push(t);
  }
  return { mods, annotations };
}

/** Declaration text up to the start of its body, collapsed to one line. */
function headText(node: Node, body: Node | null | undefined): string {
  const t = body ? node.text.slice(0, body.startIndex - node.startIndex) : node.text;
  return oneLine(t.replace(/[;{]\s*$/, ''));
}

function supertypesOf(node: Node): NonNullable<DefSpec['supertypes']> {
  const out: NonNullable<DefSpec['supertypes']> = [];
  const sup = node.childForFieldName('superclass') ?? named(node).find((c) => c.type === 'superclass');
  if (sup) for (const c of named(sup)) out.push({ name: simpleTypeName(c.text), kind: 'extends' });
  const ifaces = node.childForFieldName('interfaces') ?? named(node).find((c) => c.type === 'super_interfaces');
  for (const list of [ifaces, named(node).find((c) => c.type === 'extends_interfaces')]) {
    const types = named(list).find((c) => c.type === 'type_list');
    for (const c of named(types)) out.push({ name: simpleTypeName(c.text), kind: node.type === 'interface_declaration' ? 'extends' : 'implements' });
  }
  return out;
}

/** The name a Gradle `task foo` / `tasks.register('foo')` declares, if this node is one. */
function taskName(node: Node): { name: string; body: Node | null } | null {
  if (node.type === 'juxt_function_call') {
    if (node.childForFieldName('name')?.text !== 'task') return null;
    const first = named(node.childForFieldName('args'))[0];
    const name = first?.type === 'identifier' ? first.text : stringValue(first);
    if (!name) return null;
    // `task foo { … }` puts the closure in a following sibling statement, not in this node.
    let sib = node.nextSibling;
    if (sib?.type === 'ERROR') sib = sib.nextSibling; // `task foo(type: Copy)` does not parse
    const body = sib?.type === 'expression_statement' ? (named(sib)[0]?.type === 'closure' ? named(sib)[0]! : null) : sib?.type === 'closure' ? sib : null;
    return { name, body };
  }
  if (node.type === 'method_invocation') {
    if (node.childForFieldName('object')?.text !== 'tasks') return null;
    if (!TASK_FACTORIES.has(node.childForFieldName('name')?.text ?? '')) return null;
    const first = named(node.childForFieldName('arguments'))[0];
    const name = stringValue(first);
    if (!name) return null;
    return { name, body: node.childForFieldName('body') };
  }
  return null;
}

/** Line number of `index` inside `text`, which starts on `startLine`. */
function lineAt(text: string, index: number, startLine: number): number {
  let n = startLine;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === '\n') n++;
  return n;
}

/**
 * Read a `dependencies { }` block's declarations from source text. The Groovy grammar mangles
 * command expressions, so the tree under the block is unusable; the lines themselves are not.
 */
function dependencyImports(block: Node): Import[] {
  const text = block.text;
  const startLine = block.startPosition.row + 1;
  const out: Import[] = [];
  const push = (source: string, index: number) => {
    if (!source || out.some((i) => i.source === source)) return;
    out.push({ source, names: [], namespace: false, alias: '', kind: 'dynamic', line: lineAt(text, index, startLine) });
  };
  let offset = 0;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\/\/.*$/, '').trim();
    const at = offset;
    offset += raw.length + 1;
    if (!line || line.startsWith('*') || line.startsWith('/*')) continue;
    // `implementation project(':core')` / `api(project(':core'))`
    const proj = /^\w+[\s(]+project\s*\(\s*(?:path\s*:\s*)?['"]([^'"]+)['"]/.exec(line);
    if (proj) {
      push(proj[1]!, at);
      continue;
    }
    // `testImplementation group: 'junit', name: 'junit', version: '4.13'`
    const named_ = /^\w+[\s(]+group\s*:\s*['"]([^'"]+)['"]\s*,\s*name\s*:\s*['"]([^'"]+)['"]/.exec(line);
    if (named_) {
      push(`${named_[1]}:${named_[2]}`, at);
      continue;
    }
    // `implementation 'com.google.guava:guava:31.1-jre'` / `api("g:a:v")`
    const gav = /^\w+[\s(]+['"]([^'"\s]+:[^'"\s]+)['"]/.exec(line);
    if (gav) push(gav[1]!, at);
  }
  return out;
}

/** Read plugin ids out of a `plugins { }` block. */
function pluginImports(block: Node): Import[] {
  const text = block.text;
  const startLine = block.startPosition.row + 1;
  const out: Import[] = [];
  const re = /\bid\s*[\s(]\s*['"]([^'"]+)['"]/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (out.some((i) => i.source === m![1])) continue;
    out.push({ source: m[1]!, names: [], namespace: false, alias: '', kind: 'dynamic', line: lineAt(text, m.index, startLine) });
  }
  return out;
}

function emitTypeRef(t: Node, ctx: WalkContext): void {
  const name = simpleTypeName(t.text);
  if (!name || NON_TYPES.has(name) || !/^[A-Za-z_]/.test(name)) return;
  ctx.emitRef({ kind: 'type', name }, t);
}

function ctorType(value: Node | null | undefined): string | undefined {
  if (value?.type !== 'object_creation_expression') return undefined;
  const t = value.childForFieldName('type');
  return t ? simpleTypeName(t.text) : undefined;
}

/** Spock feature methods parse as `constructor_declaration` named `def` plus an ERROR string. */
function spockFeatureName(node: Node): string | null {
  if (node.type !== 'constructor_declaration') return null;
  if (node.childForFieldName('name')?.text !== 'def') return null;
  const params = node.childForFieldName('parameters');
  if (!params) return null;
  const head = node.text.slice(0, params.startIndex - node.startIndex);
  const m = /^\s*def\s*(['"])([\s\S]*?)\1/.exec(head);
  return m ? m[2]!.trim() : null;
}

export const groovy: LanguageSupport = {
  id: 'groovy',
  grammar: 'groovy',
  extensions: ['.groovy', '.gradle', '.gvy'],
  classLike: new Set([...TYPE_LIKE]),
  skip: new Set(['line_comment', 'block_comment']),

  isTestFile(path) {
    return /(^|\/)(test|tests)\//.test(path) || /(Test|Tests|Spec|Spock)\.groovy$/.test(path);
  },

  doc(node) {
    return precedingComments(node, COMMENTS);
  },

  definition(node, ctx): DefSpec | null {
    switch (node.type) {
      case 'ERROR': {
        // A Spock specification (`class X extends Specification { def "does a thing"() { … } }`)
        // does not parse: the grammar leaves the whole class as an ERROR holding loose children.
        // Recover the class here and its feature methods in the `string_literal` case below, so a
        // spec file still yields a class with its tests instead of nothing at all.
        const ks = kids(node);
        if (ks[0]?.type !== 'class' || ks[1]?.type !== 'identifier') return null;
        const name = ks[1].text;
        const supertypes = supertypesOf(node);
        if (supertypes.some((t) => TEST_SUPERS.test(t.name))) state(ctx).testClasses.add(name);
        return { kind: 'class', name, signature: oneLine(`class ${name}${supertypes.length ? ` extends ${supertypes[0]!.name}` : ''}`), doc: precedingComments(node, COMMENTS), exported: true, supertypes };
      }
      case 'string_literal': {
        // The loose half of the recovery above: `def "does a thing"(` inside the ERROR node.
        const prev = node.previousSibling;
        if (prev?.type !== 'identifier' || prev.text !== 'def') return null;
        const name = stringValue(node);
        if (!name) return null;
        let sib: Node | null = node.nextSibling;
        for (let i = 0; sib && sib.type !== 'closure' && i < 4; i++) sib = sib.nextSibling;
        const body = sib?.type === 'closure' ? sib : null;
        return { kind: 'test', name, body, signature: oneLine(`def "${name}"()`), doc: precedingComments(prev, COMMENTS), exported: true, meta: { framework: 'spock' }, rangeNode: body ?? node };
      }
      case 'class_declaration':
      case 'interface_declaration':
      case 'enum_declaration':
      case 'record_declaration':
      case 'annotation_type_declaration': {
        const name = node.childForFieldName('name')?.text ?? '';
        if (!name) return null;
        const body = node.childForFieldName('body');
        const { mods, annotations } = modifiersOf(node);
        const supertypes = supertypesOf(node);
        if (supertypes.some((s) => TEST_SUPERS.test(s.name))) state(ctx).testClasses.add(name);
        const kind: DefSpec['kind'] =
          node.type === 'interface_declaration' || node.type === 'annotation_type_declaration' ? 'interface' : node.type === 'enum_declaration' ? 'enum' : node.type === 'record_declaration' ? 'struct' : 'class';
        return { kind, name, body, signature: headText(node, body), doc: precedingComments(node, COMMENTS), modifiers: mods, exported: !mods.includes('private'), supertypes, meta: annotations.length ? { annotations: annotations.join(',') } : undefined };
      }
      case 'method_declaration': {
        const name = node.childForFieldName('name')?.text ?? '';
        if (!name) return null;
        const body = node.childForFieldName('body');
        const { mods, annotations } = modifiersOf(node);
        const owner = ctx.scopeDef;
        const isTest = annotations.includes('Test') || (owner ? state(ctx).testClasses.has(owner.name) : false);
        const kind: DefSpec['kind'] = isTest ? 'test' : ctx.inClass ? 'method' : 'function';
        const ret = node.childForFieldName('type');
        return { kind, name, body, signature: headText(node, body), doc: precedingComments(node, COMMENTS), modifiers: mods, exported: !mods.includes('private'), declaredType: ret && !NON_TYPES.has(ret.text) ? simpleTypeName(ret.text) : undefined, meta: annotations.length ? { annotations: annotations.join(',') } : undefined };
      }
      case 'constructor_declaration':
      case 'compact_constructor_declaration': {
        // Spock writes feature methods as `def "does a thing"() { … }`, which the grammar reads as
        // a constructor named `def` followed by an unparsed string.
        const feature = spockFeatureName(node);
        if (feature) {
          const body = node.childForFieldName('body');
          return { kind: 'test', name: feature, body, signature: oneLine(`def "${feature}"()`), doc: precedingComments(node, COMMENTS), exported: true, meta: { framework: 'spock' } };
        }
        const name = node.childForFieldName('name')?.text ?? '';
        if (!name) return null;
        const body = node.childForFieldName('body');
        const { mods } = modifiersOf(node);
        return { kind: 'constructor', name, body, signature: headText(node, body), doc: precedingComments(node, COMMENTS), modifiers: mods, exported: !mods.includes('private') };
      }
      case 'function_definition': {
        const name = node.childForFieldName('name')?.text ?? '';
        if (!name) return null;
        const body = node.childForFieldName('body');
        return { kind: ctx.inClass ? 'method' : 'function', name, body, signature: headText(node, body), doc: precedingComments(node, COMMENTS), exported: true };
      }
      case 'field_declaration':
      case 'constant_declaration': {
        const decl = node.childForFieldName('declarator');
        const name = decl?.childForFieldName('name')?.text ?? '';
        if (!name) return null;
        const { mods } = modifiersOf(node);
        const t = node.childForFieldName('type');
        const value = decl?.childForFieldName('value');
        const declaredType = t && !NON_TYPES.has(t.text) ? simpleTypeName(t.text) : ctorType(value);
        const kind: DefSpec['kind'] = mods.includes('static') && mods.includes('final') ? 'constant' : 'field';
        return { kind, name, signature: oneLine(node.text.replace(/;\s*$/, ''), 160), doc: precedingComments(node, COMMENTS), modifiers: mods, exported: !mods.includes('private'), declaredType };
      }
      case 'enum_constant': {
        const name = node.childForFieldName('name')?.text ?? '';
        if (!name) return null;
        return { kind: 'enum_member', name, signature: oneLine(node.text, 80), doc: precedingComments(node, COMMENTS), exported: true };
      }
      case 'local_variable_declaration': {
        // Only top-level bindings are definitions; the rest are locals (see `references`).
        if (node.parent?.type !== 'program') return null;
        const decl = node.childForFieldName('declarator');
        const name = decl?.childForFieldName('name')?.text ?? '';
        if (!name) return null;
        const value = decl?.childForFieldName('value');
        const t = node.childForFieldName('type');
        // `def handler = { … }` is a callable, not a value.
        if (value?.type === 'closure') return { kind: 'function', name, body: value, signature: oneLine(`def ${name} = { … }`), doc: precedingComments(node, COMMENTS), exported: true, meta: { closure: true } };
        return { kind: /^[A-Z][A-Z0-9_]+$/.test(name) ? 'constant' : 'variable', name, signature: oneLine(node.text, 160), doc: precedingComments(node, COMMENTS), exported: true, declaredType: t && !NON_TYPES.has(t.text) ? simpleTypeName(t.text) : ctorType(value) };
      }
      case 'juxt_function_call':
      case 'method_invocation': {
        if (!isGradleFile(ctx.path)) return null;
        const task = taskName(node);
        if (!task) return null;
        return { kind: 'function', name: task.name, body: task.body, signature: oneLine(`task ${task.name}`), doc: precedingComments(node.parent?.type === 'expression_statement' ? node.parent : node, COMMENTS), exported: true, meta: { task: true } };
      }
    }
    return null;
  },

  imports(node, ctx): Import[] | null {
    const line = node.startPosition.row + 1;
    if (node.type === 'import_declaration') {
      const path = named(node).find((c) => c.type === 'scoped_identifier' || c.type === 'identifier');
      const source = path?.text ?? '';
      if (!source) return [];
      const wildcard = node.text.trimEnd().endsWith('*');
      const last = source.slice(source.lastIndexOf('.') + 1);
      return [{ source, names: wildcard ? [] : [{ name: last, alias: last }], namespace: wildcard, alias: wildcard ? '' : last, kind: 'static', line }];
    }
    if (node.type === 'method_invocation' || node.type === 'juxt_function_call') {
      const name = node.childForFieldName('name')?.text ?? '';
      const body = node.childForFieldName('body');
      // `dependencies { … }` / `plugins { … }`: read the block's own text; returning imports stops
      // the walker descending into a subtree the grammar cannot represent anyway.
      if (body?.type === 'closure' && TEXT_BLOCKS.has(name) && isGradleFile(ctx.path)) {
        if (name === 'plugins') return pluginImports(body);
        if (name === 'dependencies') return dependencyImports(body);
        return null; // buildscript: descend so its nested `dependencies` block is seen
      }
      // `apply plugin: 'kotlin'`
      if (name === 'apply' && isGradleFile(ctx.path)) {
        const m = /\bplugin\s*:\s*['"]([^'"]+)['"]/.exec(node.text);
        if (m) return [{ source: m[1]!, names: [], namespace: false, alias: '', kind: 'dynamic', line }];
      }
      // settings.gradle: `include ':app', ':core'`
      if (name === 'include' && isGradleFile(ctx.path)) {
        const args = named(node.childForFieldName('args') ?? node.childForFieldName('arguments'));
        const out: Import[] = [];
        for (const a of args) {
          const v = stringValue(a);
          if (v?.startsWith(':')) out.push({ source: v, names: [], namespace: false, alias: '', kind: 'dynamic', line });
        }
        if (out.length) return out;
      }
    }
    return null;
  },

  references(node, ctx) {
    switch (node.type) {
      case 'method_invocation': {
        const obj = node.childForFieldName('object');
        const nameNode = node.childForFieldName('name');
        if (!nameNode) return;
        const name = nameNode.text;
        const args = node.childForFieldName('arguments') ?? node.childForFieldName('args');
        const arity = named(args).length;
        const qualifier = obj?.text ?? '';
        if (qualifier === 'System' && (name === 'getenv' || name === 'getProperty')) {
          const key = stringValue(named(args)[0]);
          if (key) ctx.emitRef({ kind: 'config', name: key }, nameNode);
          return;
        }
        if (name === 'project') {
          const p = stringValue(named(args)[0]);
          if (p?.startsWith(':')) ctx.emitRef({ kind: 'value', name: p }, nameNode);
          return;
        }
        if (name === 'dependsOn' || name === 'mustRunAfter' || name === 'shouldRunAfter' || name === 'finalizedBy') {
          for (const a of named(args)) {
            const v = stringValue(a);
            if (v) ctx.emitRef({ kind: 'value', name: v }, a);
          }
          return;
        }
        if (BUILTIN_CALLS.has(name) && !qualifier) return;
        ctx.emitRef({ kind: 'call', name, qualifier, arity }, nameNode);
        return;
      }
      case 'juxt_function_call': {
        const nameNode = node.childForFieldName('name');
        if (!nameNode) return;
        const name = nameNode.text;
        const args = node.childForFieldName('args');
        // `dependsOn 'compileJava'` / `dependsOn tasks.named('build')`
        if (name === 'dependsOn' || name === 'mustRunAfter' || name === 'shouldRunAfter' || name === 'finalizedBy') {
          for (const a of named(args)) {
            const v = stringValue(a);
            if (v) ctx.emitRef({ kind: 'value', name: v }, a);
          }
          const m = /\bnamed\s*\(\s*['"]([^'"]+)['"]/.exec(node.parent?.text ?? node.text);
          if (m) ctx.emitRef({ kind: 'value', name: m[1]! }, node);
          return;
        }
        if (BUILTIN_CALLS.has(name)) return true;
        ctx.emitRef({ kind: 'call', name, arity: named(args).length }, nameNode);
        return;
      }
      case 'object_creation_expression': {
        const t = node.childForFieldName('type');
        if (t) ctx.emitRef({ kind: 'new', name: simpleTypeName(t.text), arity: named(node.childForFieldName('arguments')).length }, t);
        return;
      }
      case 'formal_parameter':
      case 'spread_parameter':
      case 'catch_formal_parameter': {
        const nameNode = node.childForFieldName('name');
        const t = node.childForFieldName('type');
        if (nameNode && t && !NON_TYPES.has(t.text)) {
          ctx.emitLocalType({ name: nameNode.text, type: simpleTypeName(t.text), via: 'annotation' });
          emitTypeRef(t, ctx);
        }
        return true;
      }
      case 'local_variable_declaration': {
        if (node.parent?.type === 'program') return; // already a definition
        const t = node.childForFieldName('type');
        for (const d of named(node).filter((c) => c.type === 'variable_declarator')) {
          const name = d.childForFieldName('name')?.text;
          if (!name) continue;
          if (t && !NON_TYPES.has(t.text)) ctx.emitLocalType({ name, type: simpleTypeName(t.text), via: 'annotation' });
          else {
            const ctor = ctorType(d.childForFieldName('value'));
            if (ctor) ctx.emitLocalType({ name, type: ctor, via: 'new' });
          }
        }
        return;
      }
      case 'field_declaration': {
        const t = node.childForFieldName('type');
        const name = node.childForFieldName('declarator')?.childForFieldName('name')?.text;
        if (name && t && !NON_TYPES.has(t.text)) ctx.emitLocalType({ name, type: simpleTypeName(t.text), via: 'field' });
        return;
      }
      case 'assignment_expression': {
        const left = node.childForFieldName('left');
        const ctor = ctorType(node.childForFieldName('right'));
        if (left && ctor) ctx.emitLocalType({ name: left.text.replace(/\s+/g, ''), type: ctor, via: 'new' });
        return;
      }
      case 'marker_annotation':
      case 'annotation': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) ctx.emitRef({ kind: 'decorator', name: simpleTypeName(nameNode.text) }, nameNode);
        return true;
      }
      case 'superclass':
      case 'super_interfaces':
      case 'extends_interfaces':
        return true; // already recorded as supertypes
      case 'type_identifier':
      case 'scoped_type_identifier': {
        emitTypeRef(node, ctx);
        return true;
      }
    }
    return;
  },

  resolveModule(source, fromPath, imp, project) {
    // `implementation project(':core')` / `include ':app'` -> that subproject's build script.
    if (source.startsWith(':')) {
      const dir = source.replace(/^:/, '').replace(/:/g, '/');
      return [`${dir}/build.gradle`, `${dir}/build.gradle.kts`, `${dir}/settings.gradle`];
    }
    // Gradle plugin ids and `group:artifact` coordinates are external by construction.
    if (imp.kind === 'dynamic' || source.includes(':')) return [];
    return jvmResolveModule(source, fromPath, imp, project, '.groovy');
  },
};
