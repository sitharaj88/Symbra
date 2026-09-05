import type { Node } from 'web-tree-sitter';
import type { Import } from '../ir/types.js';
import type { DefSpec, LanguageSupport, WalkContext } from './types.js';
import { oneLine, precedingComments, cleanComment, named, kids } from '../parse/walk.js';

const COMMENTS = new Set(['comment']);

/** Variables make defines itself, so `$(MAKE)` never looks like a project symbol. */
const BUILTIN_VARS = new Set([
  'MAKE', 'MAKEFLAGS', 'MAKEFILE_LIST', 'MAKECMDGOALS', 'MAKELEVEL', 'CURDIR', 'SHELL', '.SHELLFLAGS',
  'VPATH', 'SUFFIXES', 'DEFAULT_GOAL', 'RECIPEPREFIX', 'MAKE_VERSION', 'MAKE_HOST',
]);
/** Ambient environment, not project configuration. */
const AMBIENT_VARS = new Set(['HOME', 'PATH', 'PWD', 'USER', 'TMPDIR', 'TERM', 'LANG', 'SHELL', 'CI', 'OS']);

interface FileFacts {
  /** Targets listed as prerequisites of `.PHONY`. */
  phony: Set<string>;
  /** Variables assigned anywhere in this makefile. */
  assigned: Set<string>;
}

let factsCache: { source: string; facts: FileFacts } | null = null;

function factsOf(source: string): FileFacts {
  if (factsCache && factsCache.source === source) return factsCache.facts;
  const phony = new Set<string>();
  const assigned = new Set<string>();
  // `.PHONY: a b \` with backslash continuations.
  const phonyRe = /^\.PHONY\s*:\s*((?:[^\n\\]|\\\r?\n)*)/gm;
  let m: RegExpExecArray | null;
  while ((m = phonyRe.exec(source))) {
    for (const w of m[1]!.replace(/\\\r?\n/g, ' ').split(/\s+/)) if (w) phony.add(w);
  }
  const assignRe = /^\s*(?:export\s+|override\s+)?([A-Za-z_][\w.-]*)\s*(?::?::?|\+|\?|!)?=/gm;
  while ((m = assignRe.exec(source))) assigned.add(m[1]!);
  const defineRe = /^\s*define\s+([A-Za-z_][\w.-]*)/gm;
  while ((m = defineRe.exec(source))) assigned.add(m[1]!);
  const facts = { phony, assigned };
  factsCache = { source, facts };
  return facts;
}

/** Is this path a makefile by name rather than by extension? */
export function isMakefilePath(path: string): boolean {
  const base = path.slice(path.lastIndexOf('/') + 1);
  return /^(GNUmakefile|makefile|Makefile)(\.[\w.-]+)?$/.test(base);
}

function targetsNode(rule: Node): Node | null {
  return kids(rule).find((c) => c.type === 'targets') ?? null;
}

/**
 * Target names of a rule. Taken from the `targets` text rather than its word children so a
 * computed target (`$(BIN_DIR)/app`) keeps the variable reference that names it.
 */
function targetNames(rule: Node): string[] {
  const targets = targetsNode(rule);
  if (!targets) return [];
  return targets.text.replace(/\\\r?\n/g, ' ').trim().split(/\s+/).filter(Boolean);
}

function prereqNode(rule: Node): Node | null {
  return kids(rule).find((c) => c.type === 'prerequisites') ?? null;
}

function ruleSignature(rule: Node): string {
  const recipe = kids(rule).find((c) => c.type === 'recipe');
  const end = recipe ? recipe.startIndex : rule.endIndex;
  return oneLine(rule.text.slice(0, end - rule.startIndex).trim(), 160);
}

/** Variable name node of an assignment. */
function assignmentName(node: Node): Node | null {
  return node.childForFieldName('name') ?? kids(node).find((c) => c.type === 'word') ?? null;
}

function operatorOf(node: Node): string {
  for (const c of kids(node)) if (!c.isNamed && /=/.test(c.text)) return c.text;
  return '=';
}

/**
 * `$(MAKE) -C sub target` / `make target` inside a recipe: the targets being invoked.
 * Flags and `VAR=value` overrides are skipped; `-C dir` also consumes its argument.
 */
function subMakeTargets(text: string): string[] {
  const out: string[] = [];
  const re = /(?:\$[({]MAKE[)}]|\bmake\b)([^\n;|&]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const words = m[1]!.trim().split(/\s+/).filter(Boolean);
    for (let i = 0; i < words.length; i++) {
      const w = words[i]!;
      if (w === '-C' || w === '-f' || w === '--directory' || w === '--file') {
        i++;
        continue;
      }
      if (w.startsWith('-')) continue;
      if (w.includes('=')) continue;
      if (w.startsWith('$')) continue;
      out.push(w);
    }
  }
  return out;
}

export const make: LanguageSupport = {
  id: 'make',
  grammar: 'make',
  extensions: ['.mk', '.make', '.mak'],
  classLike: new Set(),
  skip: new Set(['comment']),

  /** `Makefile` / `GNUmakefile` carry no extension, so the registry needs a name check. */
  detect(path) {
    return isMakefilePath(path);
  },

  isTestFile() {
    return false;
  },

  doc(node) {
    return precedingComments(node, COMMENTS);
  },

  moduleDoc(root) {
    const parts: string[] = [];
    for (const c of named(root)) {
      if (c.type !== 'comment') break;
      parts.push(c.text);
    }
    return parts.length ? cleanComment(parts.join('\n')) : '';
  },

  definition(node, ctx): DefSpec | null {
    switch (node.type) {
      case 'rule': {
        const name = targetNames(node)[0];
        if (!name) return null;
        if (name.startsWith('.')) return null; // .PHONY, .SUFFIXES, … configure make itself
        const facts = factsOf(ctx.source);
        const prereqs = prereqNode(node);
        const meta: NonNullable<DefSpec['meta']> = { target: name };
        if (facts.phony.has(name)) meta.phony = true;
        if (name.includes('%')) meta.pattern = true;
        if (prereqs) meta.prerequisites = oneLine(prereqs.text, 120);
        return {
          kind: 'function',
          name,
          signature: ruleSignature(node),
          doc: precedingComments(node, COMMENTS),
          exported: true,
          meta,
        };
      }
      case 'variable_assignment':
      case 'shell_assignment': {
        const nameNode = assignmentName(node);
        if (!nameNode) return null;
        const name = nameNode.text;
        if (!name || !/^[A-Za-z_][\w.-]*$/.test(name)) return null;
        const op = node.type === 'shell_assignment' ? '!=' : operatorOf(node);
        const value = node.childForFieldName('value')?.text ?? '';
        const modifiers: string[] = [];
        if (node.parent?.type === 'export_directive') modifiers.push('export');
        if (op === ':=' || op === '::=') modifiers.push('simple');
        if (op === '?=') modifiers.push('conditional');
        if (op === '+=') modifiers.push('append');
        return {
          kind: 'variable',
          name,
          signature: oneLine(`${name} ${op} ${value}`, 160),
          doc: precedingComments(node.parent?.type === 'export_directive' ? node.parent : node, COMMENTS),
          modifiers,
          exported: true,
          meta: { variable: name },
        };
      }
      case 'define_directive': {
        const nameNode = node.childForFieldName('name') ?? kids(node).find((c) => c.type === 'word');
        if (!nameNode) return null;
        return {
          kind: 'variable',
          name: nameNode.text,
          signature: `define ${nameNode.text}`,
          doc: precedingComments(node, COMMENTS),
          modifiers: ['multiline'],
          exported: true,
          meta: { variable: nameNode.text, define: true },
        };
      }
    }
    return null;
  },

  imports(node): Import[] | null {
    if (node.type !== 'include_directive') return null;
    const list = node.childForFieldName('filenames') ?? kids(node).find((c) => c.type === 'list');
    const out: Import[] = [];
    for (const w of kids(list)) {
      if (w.type !== 'word') continue;
      out.push({ source: w.text, names: [], namespace: true, alias: '', kind: 'static', line: node.startPosition.row + 1 });
    }
    return out;
  },

  references(node, ctx) {
    switch (node.type) {
      case 'rule': {
        // Sibling targets of a multi-target rule get their own definitions at file scope.
        const names = targetNames(node);
        if (names[0]?.startsWith('.')) return;
        const facts = factsOf(ctx.source);
        for (let i = 1; i < names.length; i++) {
          const name = names[i]!;
          ctx.emitDef(
            {
              kind: 'function',
              name,
              signature: ruleSignature(node),
              doc: '',
              exported: true,
              meta: facts.phony.has(name) ? { target: name, phony: true } : { target: name },
              rangeNode: node,
            },
            node,
            -1,
          );
        }
        return;
      }
      case 'prerequisites': {
        // `.PHONY: a b` lists targets as prerequisites; those are declarations, not dependencies.
        if (node.parent && targetNames(node.parent)[0]?.startsWith('.')) return true;
        // Split the raw text so a computed prerequisite (`$(BIN_DIR)/app`) keeps the exact name
        // the matching rule was defined under. A bare `$(VAR)` is a variable read, not a target.
        for (const word of node.text.replace(/\\\r?\n/g, ' ').trim().split(/\s+/)) {
          if (!word || word.startsWith('-') || /^\$[({]\w+[)}]$/.test(word)) continue;
          ctx.emitRef({ kind: 'value', name: word }, node);
        }
        return; // keep descending so `$(VAR)` prerequisites still resolve
      }
      case 'variable_reference': {
        const w = kids(node).find((c) => c.type === 'word' || c.type === 'variable_reference');
        const name = w?.type === 'word' ? w.text : '';
        if (!name || BUILTIN_VARS.has(name)) return;
        const facts = factsOf(ctx.source);
        if (!facts.assigned.has(name) && /^[A-Z][A-Z0-9_]{1,}$/.test(name) && !AMBIENT_VARS.has(name)) {
          ctx.emitRef({ kind: 'config', name }, node);
        } else {
          ctx.emitRef({ kind: 'value', name }, node);
        }
        return;
      }
      case 'recipe_line': {
        for (const t of subMakeTargets(node.text)) ctx.emitRef({ kind: 'call', name: t }, node);
        return;
      }
    }
    return;
  },

  resolveModule(source, fromPath) {
    if (source.includes('$')) return [];
    const fromDir = fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/')) : '';
    const parts = (fromDir ? fromDir.split('/') : []).concat(source.split('/'));
    const stack: string[] = [];
    for (const p of parts) {
      if (p === '.' || p === '') continue;
      if (p === '..') stack.pop();
      else stack.push(p);
    }
    const joined = stack.join('/');
    return joined === source ? [joined] : [joined, source];
  },
};
