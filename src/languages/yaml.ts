import type { Node } from 'web-tree-sitter';
import type { Import } from '../ir/types.js';
import type { DefSpec, LanguageSupport, WalkContext } from './types.js';
import { oneLine, cleanComment, named } from '../parse/walk.js';

/**
 * YAML is indexed only for the shapes whose keys carry meaning: CI workflows, docker-compose,
 * Kubernetes manifests and OpenAPI. Arbitrary YAML has no symbols worth graphing — indexing every
 * key would drown the store in `config_key` noise — so an unrecognised file yields an empty IR.
 */
type Shape = 'gha' | 'gitlab' | 'compose' | 'k8s' | 'openapi' | 'none';

const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);
/** GitLab CI top-level keys that configure the pipeline instead of declaring a job. */
const GITLAB_RESERVED = new Set([
  'stages', 'variables', 'include', 'default', 'workflow', 'image', 'services', 'before_script',
  'after_script', 'cache', 'types', 'pages:deploy',
]);
/** Keys that make a top-level GitLab mapping a job rather than an anchor blob. */
const GITLAB_JOB_KEYS = ['script', 'stage', 'extends', 'trigger', 'run'];
/** Shell/CI variables that are ambient, not project configuration. */
const AMBIENT_VARS = new Set([
  'HOME', 'PATH', 'PWD', 'USER', 'SHELL', 'TERM', 'LANG', 'TMPDIR', 'CI', 'GITHUB_TOKEN',
  'GITHUB_WORKSPACE', 'GITHUB_SHA', 'GITHUB_REF', 'GITHUB_ENV', 'GITHUB_OUTPUT', 'GITHUB_PATH',
  'GITHUB_REPOSITORY', 'GITHUB_ACTOR', 'GITHUB_EVENT_NAME', 'RUNNER_OS', 'RUNNER_TEMP',
  'CI_COMMIT_SHA', 'CI_COMMIT_REF_NAME', 'CI_PROJECT_DIR', 'CI_JOB_ID', 'CI_PIPELINE_ID',
]);

let shapeCache: { path: string; source: string; shape: Shape } | null = null;

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function detectShape(path: string, source: string): Shape {
  const base = basename(path);
  if (/(^|\/)\.github\/workflows\//.test(path) && /^on\s*:/m.test(source)) return 'gha';
  if (/^\.gitlab-ci\.ya?ml$/.test(base) || /\.gitlab-ci\.ya?ml$/.test(path)) return 'gitlab';
  if (/^(docker-)?compose([.-][\w.-]+)?\.ya?ml$/.test(base) && /^services\s*:/m.test(source)) return 'compose';
  if (/^(openapi|swagger)\s*:/m.test(source)) return 'openapi';
  if (/^apiVersion\s*:/m.test(source) && /^kind\s*:/m.test(source)) return 'k8s';
  if (/^jobs\s*:/m.test(source) && /^\s+(runs-on|uses)\s*:/m.test(source)) return 'gha';
  if (/^services\s*:/m.test(source) && /^\s{2,}(image|build)\s*:/m.test(source)) return 'compose';
  if (/^stages\s*:/m.test(source) && /^\s+script\s*:/m.test(source)) return 'gitlab';
  return 'none';
}

function shapeOf(ctx: WalkContext): Shape {
  if (shapeCache && shapeCache.path === ctx.path && shapeCache.source === ctx.source) return shapeCache.shape;
  const shape = detectShape(ctx.path, ctx.source);
  shapeCache = { path: ctx.path, source: ctx.source, shape };
  return shape;
}

// --- YAML value helpers -------------------------------------------------------------------------

/** Unwrap `flow_node`/`block_node` to the interesting child, skipping anchors and tags. */
function inner(n: Node | null | undefined): Node | null {
  if (!n) return null;
  if (n.type !== 'flow_node' && n.type !== 'block_node') return n;
  const cs = named(n).filter((c) => c.type !== 'anchor' && c.type !== 'tag');
  return cs[cs.length - 1] ?? null;
}

function unindent(s: string): string {
  const lines = s.split('\n');
  let min = Infinity;
  for (const l of lines) {
    if (!l.trim()) continue;
    min = Math.min(min, l.length - l.trimStart().length);
  }
  if (!isFinite(min) || min === 0) return lines.join('\n').trim();
  return lines.map((l) => l.slice(min)).join('\n').trim();
}

/** The plain text of a scalar node, quotes and block indicators removed. */
function scalarText(n: Node | null | undefined): string {
  const v = inner(n);
  if (!v) return '';
  switch (v.type) {
    case 'double_quote_scalar':
    case 'single_quote_scalar': {
      const t = v.text;
      return t.length >= 2 ? t.slice(1, -1) : t;
    }
    case 'block_scalar': {
      const t = v.text;
      const nl = t.indexOf('\n');
      return nl < 0 ? '' : unindent(t.slice(nl + 1));
    }
    case 'plain_scalar':
      return v.text.trim();
    default:
      return v.text.trim();
  }
}

/** True for a leaf value (any scalar), false for mappings and sequences. */
function isScalar(n: Node | null | undefined): boolean {
  const v = inner(n);
  return !!v && !['block_mapping', 'flow_mapping', 'block_sequence', 'flow_sequence'].includes(v.type);
}

function isMapping(n: Node | null | undefined): boolean {
  const v = inner(n);
  return !!v && (v.type === 'block_mapping' || v.type === 'flow_mapping');
}

/** The key/value pairs of a mapping value node. */
function mapPairs(n: Node | null | undefined): Node[] {
  const v = inner(n);
  if (!v) return [];
  if (v.type === 'block_mapping' || v.type === 'flow_mapping') {
    return named(v).filter((c) => c.type === 'block_mapping_pair' || c.type === 'flow_pair');
  }
  return [];
}

function pairKey(pair: Node): string {
  return scalarText(pair.childForFieldName('key'));
}

function pairValue(pair: Node): Node | null {
  return pair.childForFieldName('value');
}

function mapGet(n: Node | null | undefined, key: string): Node | null {
  for (const p of mapPairs(n)) if (pairKey(p) === key) return pairValue(p);
  return null;
}

/** Items of a sequence value node; a lone scalar counts as a one-element sequence. */
function seqItems(n: Node | null | undefined): Node[] {
  const v = inner(n);
  if (!v) return [];
  if (v.type === 'block_sequence') {
    const out: Node[] = [];
    for (const it of named(v)) {
      if (it.type !== 'block_sequence_item') continue;
      const val = named(it)[0];
      if (val) out.push(val);
    }
    return out;
  }
  if (v.type === 'flow_sequence') return named(v).filter((c) => c.type === 'flow_node' || c.type === 'flow_pair');
  return n ? [n] : [];
}

/** Keys from the document root down to and including this pair. */
function keyPath(pair: Node): string[] {
  const out: string[] = [];
  for (let cur: Node | null = pair; cur; cur = cur.parent) {
    if (cur.type === 'block_mapping_pair' || cur.type === 'flow_pair') out.unshift(pairKey(cur));
  }
  return out;
}

function documentRoot(doc: Node): Node | null {
  return named(doc).find((c) => c.type === 'block_node' || c.type === 'flow_node') ?? null;
}

/**
 * Comment lines immediately above a node. Read from the source text rather than the tree: YAML
 * attaches a comment to whatever block precedes it, so a comment introducing a key is often a
 * trailing child of the *previous* mapping rather than a sibling of the key it documents.
 */
function commentDoc(node: Node, source: string): string {
  const lines = source.split('\n');
  const parts: string[] = [];
  for (let i = node.startPosition.row - 1; i >= 0; i--) {
    const line = lines[i] ?? '';
    if (!line.trim().startsWith('#')) break;
    parts.unshift(line.trim());
  }
  return parts.length ? cleanComment(parts.join('\n')) : '';
}

// --- reference helpers --------------------------------------------------------------------------

/** `${{ secrets.X }}`, `${{ env.X }}`, `${{ vars.X }}` -> X. */
function expressionConfigKeys(text: string): string[] {
  const out: string[] = [];
  const re = /\$\{\{\s*(secrets|env|vars)\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push(m[2]!);
  return out;
}

/** `$FOO` / `${FOO}` shell reads inside a script, minus the ambient ones. */
function shellConfigKeys(text: string): string[] {
  const out: string[] = [];
  const re = /\$\{?([A-Z][A-Z0-9_]{2,})\}?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const name = m[1]!;
    if (!AMBIENT_VARS.has(name)) out.push(name);
  }
  return out;
}

/** Emit config references for an `environment:`/`env:` block (mapping or `KEY=value` list). */
function emitEnvKeys(value: Node | null, ctx: WalkContext): void {
  for (const p of mapPairs(value)) {
    const k = pairKey(p);
    if (k) ctx.emitRef({ kind: 'config', name: k }, p);
  }
  if (!isMapping(value)) {
    for (const item of seqItems(value)) {
      const t = scalarText(item);
      const name = t.split(/[=:]/)[0]?.trim();
      if (name && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) ctx.emitRef({ kind: 'config', name }, item);
    }
  }
}

function emitObjectRef(name: string, kind: string, node: Node, ctx: WalkContext): void {
  if (name) ctx.emitRef({ kind: 'value', name: `${kind}/${name}` }, node);
}

// --- definitions --------------------------------------------------------------------------------

function k8sDefinition(doc: Node): DefSpec | null {
  const root = documentRoot(doc);
  if (!isMapping(root)) return null;
  const kind = scalarText(mapGet(root, 'kind'));
  const meta0 = mapGet(root, 'metadata');
  const name = scalarText(mapGet(meta0, 'name'));
  if (!kind || !name) return null;
  const apiVersion = scalarText(mapGet(root, 'apiVersion'));
  const ns = scalarText(mapGet(meta0, 'namespace'));
  const meta: NonNullable<DefSpec['meta']> = { k8sKind: kind, k8sName: name };
  if (apiVersion) meta.apiVersion = apiVersion;
  if (ns) meta.namespace = ns;
  return {
    kind: 'struct',
    name: `${kind}/${name}`,
    signature: `${apiVersion ? apiVersion + ' ' : ''}${kind} ${name}`,
    doc: '',
    exported: true,
    meta,
  };
}

function pairDefinition(node: Node, shape: Shape, source: string): DefSpec | null {
  const kp = keyPath(node);
  const value = pairValue(node);
  const key = kp[kp.length - 1] ?? '';
  if (!key) return null;
  const doc = commentDoc(node, source);

  if (shape === 'gha') {
    if (kp.length === 2 && kp[0] === 'jobs') {
      const meta: NonNullable<DefSpec['meta']> = { job: key, ci: 'github-actions' };
      const runsOn = mapGet(value, 'runs-on');
      if (runsOn) meta.runsOn = oneLine(scalarText(runsOn), 80);
      const uses = mapGet(value, 'uses');
      if (uses) meta.uses = scalarText(uses);
      const needs = mapGet(value, 'needs');
      if (needs) meta.needs = seqItems(needs).map((n) => scalarText(n)).join(',');
      const ifCond = mapGet(value, 'if');
      if (ifCond) meta.if = oneLine(scalarText(ifCond), 80);
      const name = scalarText(mapGet(value, 'name'));
      return { kind: 'function', name: `job:${key}`, signature: name ? `job ${key}: ${name}` : `job ${key}`, doc, exported: true, meta };
    }
    return null;
  }

  if (shape === 'gitlab') {
    if (kp.length !== 1) return null;
    if (GITLAB_RESERVED.has(key) || key.startsWith('.')) return null;
    if (!isMapping(value)) return null;
    if (!GITLAB_JOB_KEYS.some((k) => mapGet(value, k))) return null;
    const meta: NonNullable<DefSpec['meta']> = { job: key, ci: 'gitlab' };
    const stage = scalarText(mapGet(value, 'stage'));
    if (stage) meta.stage = stage;
    const image = scalarText(mapGet(value, 'image')) || scalarText(mapGet(mapGet(value, 'image'), 'name'));
    if (image) meta.image = image;
    return { kind: 'function', name: `job:${key}`, signature: `job ${key}`, doc, exported: true, meta };
  }

  if (shape === 'compose') {
    if (kp.length === 2 && kp[0] === 'services') {
      const meta: NonNullable<DefSpec['meta']> = { service: key };
      const image = scalarText(mapGet(value, 'image'));
      if (image) meta.image = image;
      const build = mapGet(value, 'build');
      if (build) meta.build = oneLine(scalarText(build) || build.text, 80);
      return { kind: 'struct', name: key, signature: `service ${key}${image ? ` (${image})` : ''}`, doc, exported: true, meta };
    }
    return null;
  }

  if (shape === 'openapi') {
    // paths./users/{id}.get
    if (kp.length === 3 && kp[0] === 'paths' && HTTP_METHODS.has(key.toLowerCase())) {
      const path = kp[1]!;
      const method = key.toUpperCase();
      const meta: NonNullable<DefSpec['meta']> = { httpMethod: method, path };
      const opId = scalarText(mapGet(value, 'operationId'));
      if (opId) meta.operationId = opId;
      const summary = scalarText(mapGet(value, 'summary'));
      const tags = seqItems(mapGet(value, 'tags')).map((t) => scalarText(t)).filter(Boolean);
      if (tags.length) meta.tags = tags.join(',');
      return {
        kind: 'route',
        name: `${method} ${path}`,
        signature: `${method} ${path}`,
        doc: summary || doc,
        exported: true,
        meta,
      };
    }
    // components.schemas.Pet  |  definitions.Pet (Swagger 2)
    const isSchema =
      (kp.length === 3 && kp[0] === 'components' && kp[1] === 'schemas') || (kp.length === 2 && kp[0] === 'definitions');
    if (isSchema) {
      const desc = scalarText(mapGet(value, 'description'));
      const type = scalarText(mapGet(value, 'type'));
      return {
        kind: 'struct',
        name: key,
        signature: `schema ${key}${type ? `: ${type}` : ''}`,
        doc: desc || doc,
        exported: true,
        meta: { schema: key },
      };
    }
    // …schemas.Pet.properties.name
    const propsAt = kp.lastIndexOf('properties');
    const underSchema = kp[0] === 'components' ? kp[1] === 'schemas' && kp.length === 5 : kp[0] === 'definitions' && kp.length === 4;
    if (propsAt === kp.length - 2 && underSchema) {
      const type = scalarText(mapGet(value, 'type'));
      const ref = scalarText(mapGet(value, '$ref'));
      const declaredType = type || (ref ? ref.slice(ref.lastIndexOf('/') + 1) : undefined);
      const desc = scalarText(mapGet(value, 'description'));
      return {
        kind: 'field',
        name: key,
        signature: `${key}${declaredType ? `: ${declaredType}` : ''}`,
        doc: desc || doc,
        exported: true,
        declaredType,
      };
    }
    return null;
  }

  return null;
}

// --- references ---------------------------------------------------------------------------------

function ghaReferences(node: Node, kp: string[], ctx: WalkContext): void {
  const key = kp[kp.length - 1] ?? '';
  const value = pairValue(node);
  switch (key) {
    case 'needs': {
      for (const item of seqItems(value)) {
        const n = scalarText(item);
        if (n) ctx.emitRef({ kind: 'value', name: `job:${n}` }, item);
      }
      return;
    }
    case 'uses': {
      const src = scalarText(value);
      if (src) {
        ctx.emitImport({ source: src, names: [], namespace: true, alias: '', kind: 'static', line: node.startPosition.row + 1 });
      }
      return;
    }
    case 'env':
    case 'with': {
      if (key === 'env') emitEnvKeys(value, ctx);
      return;
    }
    case 'run': {
      const script = scalarText(value);
      for (const name of shellConfigKeys(script)) ctx.emitRef({ kind: 'config', name }, node);
      return;
    }
  }
}

function composeReferences(node: Node, kp: string[], ctx: WalkContext): void {
  const key = kp[kp.length - 1] ?? '';
  const value = pairValue(node);
  if (kp[0] !== 'services' || kp.length < 3) return;
  switch (key) {
    case 'depends_on': {
      // list form, or mapping form (`depends_on: {db: {condition: …}}`)
      for (const item of seqItems(value)) {
        const n = scalarText(item);
        if (n) ctx.emitRef({ kind: 'value', name: n }, item);
      }
      for (const p of mapPairs(value)) {
        const n = pairKey(p);
        if (n) ctx.emitRef({ kind: 'value', name: n }, p);
      }
      return;
    }
    case 'links':
    case 'volumes_from': {
      for (const item of seqItems(value)) {
        const n = scalarText(item).split(':')[0]!.trim();
        if (n) ctx.emitRef({ kind: 'value', name: n }, item);
      }
      return;
    }
    case 'environment':
      emitEnvKeys(value, ctx);
      return;
    case 'env_file': {
      for (const item of seqItems(value)) {
        const src = scalarText(item) || scalarText(mapGet(item, 'path'));
        if (src) ctx.emitImport({ source: src, names: [], namespace: true, alias: '', kind: 'static', line: item.startPosition.row + 1 });
      }
      return;
    }
    case 'extends': {
      const svc = scalarText(mapGet(value, 'service'));
      if (svc) ctx.emitRef({ kind: 'value', name: svc }, node);
      return;
    }
  }
}

function k8sReferences(node: Node, kp: string[], ctx: WalkContext): void {
  const key = kp[kp.length - 1] ?? '';
  const value = pairValue(node);
  switch (key) {
    case 'name': {
      // `env: [{name: FOO, value: bar}]` — the container env var is a config key.
      // Sequence items carry no key, so the parent key sits directly before `name` in the path.
      if (kp[kp.length - 2] === 'env') {
        const n = scalarText(value);
        if (n) ctx.emitRef({ kind: 'config', name: n }, node);
      }
      return;
    }
    case 'secretKeyRef':
    case 'secretRef':
      emitObjectRef(scalarText(mapGet(value, 'name')), 'Secret', node, ctx);
      return;
    case 'configMapKeyRef':
    case 'configMapRef':
      emitObjectRef(scalarText(mapGet(value, 'name')), 'ConfigMap', node, ctx);
      return;
    case 'secretName':
      emitObjectRef(scalarText(value), 'Secret', node, ctx);
      return;
    case 'serviceAccountName':
      emitObjectRef(scalarText(value), 'ServiceAccount', node, ctx);
      return;
    case 'claimName':
      emitObjectRef(scalarText(value), 'PersistentVolumeClaim', node, ctx);
      return;
    case 'configMap': {
      const n = scalarText(mapGet(value, 'name'));
      if (n) emitObjectRef(n, 'ConfigMap', node, ctx);
      return;
    }
    case 'secret': {
      const n = scalarText(mapGet(value, 'secretName')) || scalarText(mapGet(value, 'name'));
      if (n) emitObjectRef(n, 'Secret', node, ctx);
      return;
    }
    case 'image': {
      const img = scalarText(value);
      if (img) ctx.emitRef({ kind: 'mention', name: img.split('/').pop()!.split(':')[0]! }, node);
      return;
    }
  }
}

function openapiReferences(node: Node, kp: string[], ctx: WalkContext): void {
  if ((kp[kp.length - 1] ?? '') !== '$ref') return;
  const target = scalarText(pairValue(node));
  if (!target.startsWith('#/')) {
    ctx.emitImport({ source: target.split('#')[0]!, names: [], namespace: true, alias: '', kind: 'static', line: node.startPosition.row + 1 });
    return;
  }
  const name = target.slice(target.lastIndexOf('/') + 1);
  if (name) ctx.emitRef({ kind: 'type', name }, node);
}

// --- LanguageSupport ----------------------------------------------------------------------------

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

export const yaml: LanguageSupport = {
  id: 'yaml',
  grammar: 'yaml',
  extensions: ['.yml', '.yaml'],
  classLike: new Set(),
  skip: new Set(['comment']),

  isTestFile() {
    return false;
  },

  doc(node, ctx) {
    return commentDoc(node, ctx.source);
  },

  moduleDoc(_root, ctx) {
    const parts: string[] = [];
    for (const line of ctx.source.split('\n')) {
      const t = line.trim();
      if (t.startsWith('#')) parts.push(t);
      else if (!t) continue;
      else break;
    }
    return parts.length ? cleanComment(parts.join('\n')) : '';
  },

  definition(node, ctx): DefSpec | null {
    const shape = shapeOf(ctx);
    if (shape === 'none') return null;
    if (node.type === 'document') return shape === 'k8s' ? k8sDefinition(node) : null;
    if (node.type !== 'block_mapping_pair' && node.type !== 'flow_pair') return null;
    return pairDefinition(node, shape, ctx.source);
  },

  imports(): Import[] | null {
    return null;
  },

  references(node, ctx) {
    const shape = shapeOf(ctx);
    if (shape === 'none') return true; // unknown YAML: index nothing
    if (node.type !== 'block_mapping_pair' && node.type !== 'flow_pair') return;
    const kp = keyPath(node);
    // `${{ secrets.X }}` can appear in any value of a workflow.
    if (shape === 'gha') {
      const raw = pairValue(node);
      if (raw && isScalar(raw)) {
        for (const name of expressionConfigKeys(raw.text)) ctx.emitRef({ kind: 'config', name }, node);
      }
      ghaReferences(node, kp, ctx);
      return;
    }
    if (shape === 'compose') return composeReferences(node, kp, ctx);
    if (shape === 'k8s') return k8sReferences(node, kp, ctx);
    if (shape === 'openapi') return openapiReferences(node, kp, ctx);
    if (shape === 'gitlab') {
      const key = kp[kp.length - 1] ?? '';
      const value = pairValue(node);
      if (key === 'needs' || key === 'extends' || key === 'dependencies') {
        for (const item of seqItems(value)) {
          const n = scalarText(item) || scalarText(mapGet(item, 'job'));
          if (n) ctx.emitRef({ kind: 'value', name: `job:${n.replace(/^\./, '')}` }, item);
        }
      } else if (key === 'variables') {
        emitEnvKeys(value, ctx);
      } else if (key === 'script' || key === 'before_script' || key === 'after_script') {
        for (const item of seqItems(value)) {
          for (const name of shellConfigKeys(scalarText(item))) ctx.emitRef({ kind: 'config', name }, item);
        }
      } else if (key === 'local' && kp.includes('include')) {
        const src = scalarText(value);
        if (src) ctx.emitImport({ source: src, names: [], namespace: true, alias: '', kind: 'static', line: node.startPosition.row + 1 });
      }
    }
    return;
  },

  resolveModule(source, fromPath) {
    if (!source || /^[a-z]+:\/\//.test(source)) return [];
    // `owner/repo@ref` actions and registry images live outside the repo.
    if (!/^[./]/.test(source)) return [];
    const fromDir = fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/')) : '';
    // A GitHub Actions `uses: ./x` is repo-root relative; a compose `env_file: ./x` is relative to
    // the file. Offer both — the resolver keeps whichever candidate exists.
    const bases = source.startsWith('/') ? [joinPath('', source)] : [joinPath('', source), joinPath(fromDir, source)];
    const out: string[] = [];
    for (const p of bases) {
      if (!p) continue;
      if (/\.\w+$/.test(p)) out.push(p);
      else out.push(`${p}/action.yml`, `${p}/action.yaml`, p);
    }
    return [...new Set(out)];
  },
};
