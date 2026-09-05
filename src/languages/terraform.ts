import type { Node } from 'web-tree-sitter';
import type { Import } from '../ir/types.js';
import type { DefSpec, LanguageSupport, WalkContext } from './types.js';
import { oneLine, precedingComments, cleanComment, named, kids } from '../parse/walk.js';

const COMMENTS = new Set(['comment']);

/** HCL type-constructor keywords: `type = list(string)` must not look like a value reference. */
const TYPE_KEYWORDS = new Set([
  'string', 'number', 'bool', 'any', 'list', 'map', 'set', 'object', 'tuple', 'optional', 'null',
]);
/** Expression roots that never denote a user-declared symbol. */
const PSEUDO_ROOTS = new Set(['count', 'each', 'self', 'path', 'terraform', 'null', 'true', 'false']);

/** Files whose top-level attributes are values, not declarations. */
function isVarsFile(path: string): boolean {
  return /\.tfvars(\.json)?$/.test(path) || /\.auto\.tfvars$/.test(path);
}

/** Unquote a `string_lit` label: `"aws_s3_bucket"` -> `aws_s3_bucket`. */
function labelText(n: Node | null | undefined): string {
  if (!n) return '';
  const t = n.text;
  return t.length >= 2 && (t[0] === '"' || t[0] === "'") ? t.slice(1, -1) : t;
}

/** `block` -> the keyword that opens it (`resource`, `variable`, ...). */
function blockType(node: Node): string {
  const first = kids(node).find((c) => c.type === 'identifier');
  return first?.text ?? '';
}

/** `block` -> its quoted labels, in order. */
function blockLabels(node: Node): string[] {
  return kids(node)
    .filter((c) => c.type === 'string_lit')
    .map((c) => labelText(c));
}

function blockBody(node: Node): Node | null {
  return kids(node).find((c) => c.type === 'body') ?? null;
}

/** Direct `attribute` children of a block's body, by key. */
function attr(block: Node, key: string): Node | null {
  const body = blockBody(block);
  if (!body) return null;
  for (const c of named(body)) {
    if (c.type !== 'attribute') continue;
    const id = kids(c).find((k) => k.type === 'identifier');
    if (id?.text === key) return c;
  }
  return null;
}

/** The value node of an `attribute` (its `expression` child). */
function attrValue(a: Node | null): Node | null {
  if (!a) return null;
  return kids(a).find((c) => c.type === 'expression') ?? null;
}

function attrText(block: Node, key: string): string {
  const v = attrValue(attr(block, key));
  return v ? v.text.trim() : '';
}

/** A string-valued attribute with its quotes removed. */
function attrString(block: Node, key: string): string {
  const t = attrText(block, key);
  return t.length >= 2 && t[0] === '"' && t[t.length - 1] === '"' ? t.slice(1, -1) : t;
}

function headerSignature(node: Node): string {
  const start = kids(node).find((c) => c.type === 'block_start');
  const end = start ? start.startIndex : node.endIndex;
  return oneLine(node.text.slice(0, end - node.startIndex).trim(), 160);
}

/** Documentation for a block: its `description` attribute wins over preceding comments. */
function blockDoc(node: Node): string {
  const desc = attrString(node, 'description');
  if (desc && !desc.includes('${')) return desc;
  return precedingComments(node, COMMENTS);
}

/**
 * Map an HCL traversal (`aws_s3_bucket.this.arn`, `var.env`, `module.vpc.id`) onto the name of the
 * symbol it points at, so the resolver can match it against the definition we emitted for that
 * block. Returns null for expressions that reference nothing indexable.
 */
function traversalTarget(parts: string[]): string | null {
  const root = parts[0];
  if (!root) return null;
  if (PSEUDO_ROOTS.has(root)) return null;
  if (root === 'var' || root === 'local') return parts.length >= 2 ? `${root}.${parts[1]}` : null;
  if (root === 'module') return parts.length >= 2 ? `module.${parts[1]}` : null;
  if (root === 'data') return parts.length >= 3 ? `data.${parts[1]}.${parts[2]}` : null;
  if (parts.length < 2) return null;
  if (TYPE_KEYWORDS.has(root)) return null;
  if (!/^[a-z][a-z0-9_]*$/.test(root)) return null;
  return `${root}.${parts[1]}`;
}

/**
 * Read a traversal starting at an `expression` node: `variable_expr` followed by `get_attr` /
 * `index` siblings. Returns the dotted segments, or an empty array when the expression is not a
 * traversal.
 */
function traversalOf(expr: Node): string[] {
  const cs = kids(expr);
  const head = cs[0];
  if (!head || head.type !== 'variable_expr') return [];
  const parts = [head.text.trim()];
  for (let i = 1; i < cs.length; i++) {
    const c = cs[i]!;
    if (c.type === 'get_attr') {
      const id = kids(c).find((k) => k.type === 'identifier');
      parts.push(id?.text ?? '');
    } else if (c.type === 'index' || c.type === 'new_index') {
      continue; // `foo[0].bar` keeps walking the same traversal
    } else break;
  }
  return parts.filter(Boolean);
}

/** True when this expression sits under `type = ...` and should not produce value references. */
function inTypeAttribute(node: Node): boolean {
  for (let cur: Node | null = node; cur; cur = cur.parent) {
    if (cur.type === 'attribute') {
      const id = kids(cur).find((k) => k.type === 'identifier');
      return id?.text === 'type';
    }
    if (cur.type === 'block' || cur.type === 'config_file') return false;
  }
  return false;
}

function joinPath(dir: string, rel: string): string {
  const parts = (dir ? dir.split('/') : []).concat(rel.split('/'));
  const stack: string[] = [];
  for (const p of parts) {
    if (p === '.' || p === '') continue;
    if (p === '..') stack.pop();
    else stack.push(p);
  }
  return stack.join('/');
}

function definitionFor(node: Node, ctx: WalkContext): DefSpec | null {
  if (node.type === 'block') {
    const type = blockType(node);
    const labels = blockLabels(node);
    const signature = headerSignature(node);
    const doc = blockDoc(node);
    const common = { signature, doc, exported: true as const };
    switch (type) {
      case 'resource': {
        if (labels.length < 2) return null;
        const [rtype, rname] = labels as [string, string];
        return { ...common, kind: 'struct', name: `${rtype}.${rname}`, body: blockBody(node), meta: { block: 'resource', type: rtype, resource: rname } };
      }
      case 'data': {
        if (labels.length < 2) return null;
        const [dtype, dname] = labels as [string, string];
        return { ...common, kind: 'struct', name: `data.${dtype}.${dname}`, body: blockBody(node), meta: { block: 'data', type: dtype, resource: dname } };
      }
      case 'module': {
        if (!labels[0]) return null;
        const source = attrString(node, 'source');
        return { ...common, kind: 'namespace', name: `module.${labels[0]}`, body: blockBody(node), meta: source ? { block: 'module', source } : { block: 'module' } };
      }
      case 'variable': {
        if (!labels[0]) return null;
        const declaredType = attrText(node, 'type') || undefined;
        const def = attrText(node, 'default');
        const meta: NonNullable<DefSpec['meta']> = { block: 'variable' };
        if (def) meta.default = oneLine(def, 80);
        else meta.required = true;
        return { ...common, kind: 'variable', name: `var.${labels[0]}`, body: blockBody(node), declaredType, meta };
      }
      case 'output': {
        if (!labels[0]) return null;
        const meta: NonNullable<DefSpec['meta']> = { block: 'output' };
        if (attrText(node, 'sensitive') === 'true') meta.sensitive = true;
        return { ...common, kind: 'constant', name: labels[0], body: blockBody(node), meta };
      }
      case 'provider': {
        if (!labels[0]) return null;
        const alias = attrString(node, 'alias');
        return { ...common, kind: 'namespace', name: `provider.${labels[0]}`, body: blockBody(node), meta: alias ? { block: 'provider', alias } : { block: 'provider' } };
      }
      case 'terraform':
        return { ...common, kind: 'namespace', name: 'terraform', body: blockBody(node), meta: { block: 'terraform' } };
      default: {
        // Any other labelled top-level block (Packer `source`/`build`, Nomad `job`, Consul
        // services): index it under `<keyword>.<labels>` so the file's objects are addressable.
        const holder = node.parent?.type === 'body' ? node.parent.parent : null;
        if (!holder || holder.type !== 'config_file') return null;
        if (!type || !labels.length) return null;
        return { ...common, kind: 'struct', name: `${type}.${labels.join('.')}`, body: blockBody(node), meta: { block: type } };
      }
    }
  }

  if (node.type === 'attribute') {
    const id = kids(node).find((c) => c.type === 'identifier');
    if (!id) return null;
    const holder = node.parent?.type === 'body' ? node.parent.parent : null;
    const value = attrValue(node);
    const signature = oneLine(node.text, 160);
    const doc = precedingComments(node, COMMENTS);
    if (!holder) return null;
    if (holder.type === 'config_file') {
      // Top level of a .tfvars file: every attribute is an input value.
      if (!isVarsFile(ctx.path)) return null;
      return { kind: 'constant', name: id.text, signature, doc, exported: true, meta: { block: 'tfvars' } };
    }
    if (holder.type !== 'block') return null;
    const owner = blockType(holder);
    if (owner === 'locals') {
      return { kind: 'constant', name: `local.${id.text}`, signature, doc, exported: true, meta: { block: 'locals' } };
    }
    if (owner === 'required_providers') {
      const text = value?.text ?? '';
      const meta: NonNullable<DefSpec['meta']> = { block: 'required_provider' };
      const src = text.match(/source\s*=\s*"([^"]+)"/);
      const ver = text.match(/version\s*=\s*"([^"]+)"/);
      if (src) meta.source = src[1]!;
      if (ver) meta.version = ver[1]!;
      return { kind: 'constant', name: `required_providers.${id.text}`, signature, doc, exported: true, meta };
    }
    return null;
  }

  return null;
}

function referencesFor(node: Node, ctx: WalkContext): boolean | void {
  if (node.type === 'block') {
    if (blockType(node) === 'module') {
      const source = attrString(node, 'source');
      if (source) {
        const a = attr(node, 'source')!;
        ctx.emitImport({
          source,
          names: [],
          namespace: true,
          alias: blockLabels(node)[0] ?? '',
          kind: 'static',
          line: a.startPosition.row + 1,
        });
      }
    }
    return;
  }
  if (node.type === 'expression') {
    const parts = traversalOf(node);
    if (parts.length) {
      if (!inTypeAttribute(node)) {
        const target = traversalTarget(parts);
        if (target) ctx.emitRef({ kind: 'value', name: target }, node);
      }
      return true; // the traversal is fully consumed; nothing below it is a separate reference
    }
    return;
  }
  return;
}

function moduleDocOf(root: Node): string {
  const parts: string[] = [];
  for (const c of kids(root)) {
    if (c.type === 'comment') {
      parts.push(c.text);
      continue;
    }
    if (c.type === 'body') {
      for (const b of kids(c)) {
        if (b.type !== 'comment') break;
        parts.push(b.text);
      }
    }
    break;
  }
  return parts.length ? cleanComment(parts.join('\n')) : '';
}

function resolveLocalModule(source: string, fromPath: string): string[] {
  if (!/^\.{1,2}\//.test(source)) return []; // registry / git / http sources live outside the repo
  const fromDir = fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/')) : '';
  const dir = joinPath(fromDir, source);
  const base = dir ? `${dir}/` : '';
  return [`${base}main.tf`, `${base}variables.tf`, `${base}outputs.tf`, `${base}versions.tf`, `${base}providers.tf`];
}

const base = {
  classLike: new Set<string>(),
  skip: new Set(['comment']),
  doc(node: Node): string {
    return node.type === 'block' ? blockDoc(node) : precedingComments(node, COMMENTS);
  },
  moduleDoc(root: Node): string {
    return moduleDocOf(root);
  },
  definition: definitionFor,
  imports(): Import[] | null {
    return null;
  },
  references: referencesFor,
  resolveModule(source: string, fromPath: string): string[] {
    return resolveLocalModule(source, fromPath);
  },
};

export const terraform: LanguageSupport = {
  ...base,
  id: 'terraform',
  grammar: 'terraform',
  extensions: ['.tf', '.tfvars'],
};

/** Plain HCL (Packer, Consul, Nomad, Waypoint, `.terraform.lock.hcl`). Same shapes, other grammar. */
export const hcl: LanguageSupport = {
  ...base,
  id: 'hcl',
  grammar: 'hcl',
  extensions: ['.hcl'],
};
