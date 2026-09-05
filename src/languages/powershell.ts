import type { Node } from 'web-tree-sitter';
import type { Import } from '../ir/types.js';
import type { DefSpec, LanguageSupport, WalkContext } from './types.js';
import { oneLine, simpleTypeName, named, kids } from '../parse/walk.js';

/**
 * PowerShell (.ps1 / .psm1 / .psd1).
 *
 * The grammar wraps every expression in the full precedence ladder
 * (`logical_expression > bitwise_expression > … > unary_expression`), so almost everything here
 * starts by unwrapping that chain down to the node that carries meaning.
 *
 * Two PowerShell-specific things the graph cares about: a script's dependencies are `Import-Module`
 * and dot-sourcing (`. .\Common.ps1`), which is a plain command, not a keyword; and its
 * documentation is comment-based help (`<# .SYNOPSIS … #>`) written *inside* the function braces
 * rather than in front of them.
 */

const COMMENTS = new Set(['comment']);
/** Precedence-ladder wrappers with a single child: they carry no meaning of their own. */
const EXPR_WRAPPERS = new Set([
  'pipeline', 'pipeline_chain', 'logical_expression', 'bitwise_expression', 'comparison_expression',
  'additive_expression', 'multiplicative_expression', 'format_expression', 'range_expression',
  'array_literal_expression', 'unary_expression', 'left_assignment_expression', 'argument_expression',
  'logical_argument_expression', 'bitwise_argument_expression', 'comparison_argument_expression',
  'additive_argument_expression', 'multiplicative_argument_expression', 'format_argument_expression',
  'range_argument_expression', 'expression_with_unary_operator', 'post_increment_expression',
]);
/** Pester blocks. `Describe`/`Context` group; `It` is the test itself. */
const PESTER_SUITES = new Set(['Describe', 'Context']);
const PESTER_TESTS = new Set(['It', 'Specify']);
/** Types that never point at a symbol defined in the repo. */
const BUILTIN_TYPES = new Set(['string', 'int', 'long', 'bool', 'boolean', 'double', 'decimal', 'float', 'char', 'byte', 'void', 'object', 'array', 'hashtable', 'switch', 'scriptblock', 'psobject', 'pscustomobject', 'datetime', 'guid', 'timespan', 'regex', 'xml', 'type', 'CmdletBinding', 'Parameter', 'ValidateSet', 'ValidateNotNull', 'ValidateNotNullOrEmpty', 'OutputType', 'Alias', 'AllowNull', 'SupportsWildcards']);
/**
 * Shipped cmdlets and language functions. A call to one of these is never an edge into the repo,
 * and PowerShell scripts are mostly made of them, so filtering matters more here than elsewhere.
 */
const BUILTIN_CMDLETS = new Set([
  'Write-Host', 'Write-Output', 'Write-Error', 'Write-Warning', 'Write-Verbose', 'Write-Debug', 'Write-Information', 'Write-Progress',
  'Get-ChildItem', 'Get-Item', 'Get-ItemProperty', 'Set-ItemProperty', 'Get-Content', 'Set-Content', 'Add-Content', 'Clear-Content',
  'Get-Location', 'Set-Location', 'Push-Location', 'Pop-Location', 'New-Item', 'Remove-Item', 'Copy-Item', 'Move-Item', 'Rename-Item', 'Test-Path', 'Resolve-Path', 'Split-Path', 'Join-Path', 'Convert-Path',
  'Get-Command', 'Get-Help', 'Get-Member', 'Get-Module', 'Import-Module', 'Export-ModuleMember', 'Remove-Module', 'New-Module', 'Install-Module', 'Find-Module',
  'Get-Process', 'Start-Process', 'Stop-Process', 'Wait-Process', 'Get-Service', 'Start-Service', 'Stop-Service', 'Restart-Service',
  'Select-Object', 'Where-Object', 'ForEach-Object', 'Sort-Object', 'Group-Object', 'Measure-Object', 'Compare-Object', 'Tee-Object', 'New-Object',
  'ConvertTo-Json', 'ConvertFrom-Json', 'ConvertTo-Csv', 'ConvertFrom-Csv', 'Import-Csv', 'Export-Csv', 'ConvertTo-Xml', 'ConvertTo-Html', 'ConvertFrom-StringData',
  'Out-File', 'Out-String', 'Out-Null', 'Out-Host', 'Out-GridView', 'Format-List', 'Format-Table', 'Format-Wide', 'Format-Custom',
  'New-Variable', 'Get-Variable', 'Set-Variable', 'Remove-Variable', 'Clear-Variable',
  'Invoke-Command', 'Invoke-Expression', 'Invoke-WebRequest', 'Invoke-RestMethod', 'Invoke-Item', 'Start-Sleep', 'Start-Job', 'Receive-Job', 'Wait-Job',
  'New-TemporaryFile', 'Test-Connection', 'Get-Date', 'Set-Date', 'Get-Random', 'Get-Credential', 'Read-Host',
  'Set-StrictMode', 'Set-PSDebug', 'Add-Type', 'Update-Help', 'Get-History', 'Select-String', 'Set-Alias', 'New-Alias', 'Get-Alias',
  'Should', 'Mock', 'Assert-MockCalled', 'BeforeAll', 'AfterAll', 'BeforeEach', 'AfterEach',
  'exit', 'return', 'throw', 'break', 'continue', 'param', 'echo', 'cd', 'ls', 'rm', 'cp', 'mv', 'cat', 'pwd', 'where', 'select', 'sort', 'foreach',
]);
/** `$PSScriptRoot`-style roots that stand for "the directory of this script". */
const SCRIPT_ROOT = /\$(PSScriptRoot|PWD|pwd|PSCommandPath|MyInvocation[^\\/]*)/g;

/** Strip a scope prefix: `script:Format-User` -> `Format-User`. */
function stripScope(name: string): { name: string; scope: string } {
  const m = /^(global|script|local|private|using|env):(.+)$/i.exec(name);
  return m ? { name: m[2]!, scope: m[1]!.toLowerCase() } : { name, scope: '' };
}

/** Descend through single-child precedence wrappers to the node that means something. */
function unwrap(n: Node | null | undefined): Node | null {
  let cur: Node | null = n ?? null;
  for (let i = 0; cur && i < 24; i++) {
    if (!EXPR_WRAPPERS.has(cur.type)) return cur;
    const only = named(cur);
    if (only.length !== 1) return cur;
    cur = only[0]!;
  }
  return cur;
}

function unquote(s: string): string {
  return s.replace(/^@?['"]/, '').replace(/['"]$/, '');
}

/** The literal text of a string node, or null when it is not a plain string. */
function stringValue(n: Node | null | undefined): string | null {
  const node = unwrap(n);
  if (!node) return null;
  if (node.type !== 'string_literal') return null;
  return unquote(node.text);
}

/** `[System.IO.FileInfo]` -> `FileInfo`; `[string]` -> undefined (not a repo symbol). */
function typeLiteralName(n: Node | null | undefined): string | undefined {
  if (!n) return undefined;
  const spec = n.type === 'type_literal' ? named(n).find((c) => c.type === 'type_spec') : n.type === 'type_spec' ? n : null;
  const raw = (spec ?? n).text.replace(/^\[|\]$/g, '');
  const name = simpleTypeName(raw);
  return name && !BUILTIN_TYPES.has(name) ? name : undefined;
}

/**
 * Comment-based help: `<# .SYNOPSIS … #>`. The synopsis is the summary line; when there is none,
 * the description is, and a plain `#` comment is taken as written.
 */
function cleanHelp(raw: string): string {
  let s = raw.trim();
  if (s.startsWith('<#')) s = s.slice(2);
  if (s.endsWith('#>')) s = s.slice(0, -2);
  const lines = s.split('\n').map((l) => l.replace(/^\s*#\s?/, '').trimEnd());
  const section = (key: string): string | null => {
    const start = lines.findIndex((l) => l.trim().toUpperCase() === `.${key}`);
    if (start < 0) return null;
    const body: string[] = [];
    for (let i = start + 1; i < lines.length; i++) {
      if (/^\s*\.[A-Z]+\s*$/.test(lines[i]!)) break;
      body.push(lines[i]!.trim());
    }
    return body.join('\n').trim() || null;
  };
  const picked = section('SYNOPSIS') ?? section('DESCRIPTION');
  if (picked) return picked;
  return lines.map((l) => l.trim()).join('\n').trim();
}

/**
 * Documentation for a definition: the comment-based help block inside its braces (the PowerShell
 * convention) or, failing that, the comments immediately in front of it.
 */
function docFor(node: Node): string {
  const inner = kids(node).find((c) => c.type === 'comment');
  if (inner && inner.startPosition.row <= node.startPosition.row + 2) return cleanHelp(inner.text);
  const parts: string[] = [];
  let prev = node.previousSibling;
  let lastStart = node.startPosition.row;
  while (prev && COMMENTS.has(prev.type)) {
    if (lastStart - prev.endPosition.row > 1) break;
    parts.unshift(prev.text);
    lastStart = prev.startPosition.row;
    prev = prev.previousSibling;
  }
  return parts.length ? cleanHelp(parts.join('\n')) : '';
}

/** Named elements of a `command`, unwrapped and with `-Switch` parameters kept as written. */
function commandElements(node: Node): Node[] {
  const holder = node.childForFieldName('command_elements') ?? named(node).find((c) => c.type === 'command_elements');
  return named(holder)
    .filter((c) => c.type !== 'command_argument_sep')
    .map((c) => unwrap(c))
    .filter((c): c is Node => c !== null);
}

function commandName(node: Node): string {
  const n = node.childForFieldName('command_name') ?? named(node).find((c) => c.type === 'command_name' || c.type === 'command_name_expr');
  return n?.type === 'command_name' ? n.text : '';
}

/** `.\lib\Common.ps1` / `"$PSScriptRoot\Common.ps1"` -> `lib/Common.ps1`. */
function scriptPath(raw: string): string {
  return unquote(raw.trim())
    .replace(SCRIPT_ROOT, '')
    .replace(/\\/g, '/')
    .replace(/^[./]+/, '')
    .trim();
}

/** Per-file scratch state, keyed on the walk context so nothing leaks between files. */
interface FileState {
  /** Classes seen in this file, so `[Repo]::new()` can be typed. */
  classes: Set<string>;
}
const states = new WeakMap<WalkContext, FileState>();
function state(ctx: WalkContext): FileState {
  let s = states.get(ctx);
  if (!s) {
    s = { classes: new Set() };
    states.set(ctx, s);
  }
  return s;
}

/** Base type names of `class Repo : BaseRepo, IThing {`. */
function classBases(node: Node): NonNullable<DefSpec['supertypes']> {
  const names = named(node).filter((c) => c.type === 'simple_name' || c.type === 'type_name');
  return names.slice(1).map((n) => ({ name: simpleTypeName(n.text), kind: 'extends' as const }));
}

function paramSignature(node: Node): string {
  const block = kids(node)
    .flatMap((c) => (c.type === 'script_block' ? named(c) : []))
    .find((c) => c.type === 'param_block');
  const list = named(block).find((c) => c.type === 'parameter_list');
  if (!list) return '()';
  const parts = named(list)
    .filter((c) => c.type === 'script_parameter')
    .map((p) => {
      const v = named(p).find((c) => c.type === 'variable');
      const t = named(p)
        .flatMap((a) => (a.type === 'attribute_list' ? named(a) : []))
        .flatMap((a) => (a.type === 'attribute' ? named(a) : [a]))
        .find((c) => c.type === 'type_literal' || c.type === 'type_spec');
      return `${t ? `${t.text} ` : ''}${v?.text ?? ''}`.trim();
    });
  return `(${parts.join(', ')})`;
}

export const powershell: LanguageSupport = {
  id: 'powershell',
  grammar: 'powershell',
  extensions: ['.ps1', '.psm1', '.psd1'],
  classLike: new Set(['class_statement', 'enum_statement']),
  skip: new Set(['comment', 'verbatim_here_string_characters', 'expandable_here_string_literal']),

  isTestFile(path) {
    return /\.Tests?\.ps1$/i.test(path) || /(^|\/)(tests?)\//i.test(path);
  },

  doc(node) {
    return docFor(node);
  },

  moduleDoc(root) {
    const first = kids(root).find((c) => c.type === 'comment');
    return first && first.startPosition.row <= 2 && first.text.startsWith('<#') ? cleanHelp(first.text) : '';
  },

  definition(node, ctx): DefSpec | null {
    switch (node.type) {
      case 'function_statement': {
        const raw = kids(node).find((c) => c.type === 'function_name')?.text ?? '';
        if (!raw) return null;
        const { name, scope } = stripScope(raw);
        const keyword = kids(node)[0]?.text.toLowerCase() ?? 'function';
        const modifiers = scope ? [scope] : [];
        if (keyword === 'filter' || keyword === 'workflow') modifiers.push(keyword);
        const body = named(node).find((c) => c.type === 'script_block');
        return {
          kind: ctx.inClass ? 'method' : 'function',
          name,
          body,
          signature: oneLine(`function ${name}${paramSignature(node)}`),
          doc: docFor(node),
          modifiers,
          exported: scope !== 'private' && scope !== 'script',
        };
      }
      case 'class_statement': {
        const name = named(node).find((c) => c.type === 'simple_name')?.text ?? '';
        if (!name) return null;
        state(ctx).classes.add(name);
        const supertypes = classBases(node);
        return { kind: 'class', name, signature: oneLine(`class ${name}${supertypes.length ? ` : ${supertypes.map((s) => s.name).join(', ')}` : ''}`), doc: docFor(node), exported: true, supertypes };
      }
      case 'enum_statement': {
        const name = named(node).find((c) => c.type === 'simple_name')?.text ?? '';
        if (!name) return null;
        return { kind: 'enum', name, signature: oneLine(`enum ${name}`), doc: docFor(node), exported: true };
      }
      case 'enum_member': {
        const name = named(node)[0]?.text ?? '';
        if (!name) return null;
        return { kind: 'enum_member', name, signature: oneLine(node.text, 80), exported: true };
      }
      case 'class_property_definition': {
        const v = named(node).find((c) => c.type === 'variable');
        if (!v) return null;
        const attrs = named(node).filter((c) => c.type === 'class_attribute').map((c) => c.text);
        return { kind: 'field', name: v.text.replace(/^\$/, ''), signature: oneLine(node.text, 120), doc: docFor(node), modifiers: attrs, exported: !attrs.includes('hidden'), declaredType: typeLiteralName(named(node).find((c) => c.type === 'type_literal')) };
      }
      case 'class_method_definition': {
        const nameNode = named(node).find((c) => c.type === 'simple_name');
        if (!nameNode) return null;
        const name = nameNode.text;
        const attrs = named(node).filter((c) => c.type === 'class_attribute').map((c) => c.text);
        const body = named(node).find((c) => c.type === 'script_block');
        const owner = ctx.scopeDef;
        const isCtor = owner?.name === name;
        return {
          kind: isCtor ? 'constructor' : 'method',
          name,
          body,
          signature: oneLine(node.text.slice(0, (body ?? node).startIndex - node.startIndex).replace(/\{\s*$/, '')),
          doc: docFor(node),
          modifiers: attrs,
          exported: !attrs.includes('hidden'),
          declaredType: typeLiteralName(named(node).find((c) => c.type === 'type_literal')),
        };
      }
      case 'command': {
        // Pester: `Describe 'name' { … }` / `It 'does a thing' { … }`.
        const cmd = commandName(node);
        const isSuite = PESTER_SUITES.has(cmd);
        if (!isSuite && !PESTER_TESTS.has(cmd)) return null;
        const elements = commandElements(node);
        const label = stringValue(elements[0]);
        if (!label) return null;
        const body = elements.find((c) => c.type === 'script_block_expression');
        if (!body) return null;
        return { kind: 'test', name: label, body, signature: oneLine(`${cmd} '${label}'`), doc: docFor(node), exported: true, meta: { framework: 'pester', block: cmd } };
      }
      case 'hash_entry': {
        // `.psd1` module manifests are a single hashtable of settings.
        if (!ctx.path.toLowerCase().endsWith('.psd1')) return null;
        const key = named(node).find((c) => c.type === 'key_expression');
        const name = key?.text.replace(/^['"]|['"]$/g, '') ?? '';
        if (!name) return null;
        return { kind: 'config_key', name, signature: oneLine(node.text, 120), doc: docFor(node), exported: true };
      }
    }
    return null;
  },

  imports(node): Import[] | null {
    if (node.type !== 'command') return null;
    const line = node.startPosition.row + 1;
    const cmd = commandName(node);
    // `. .\Common.ps1` and `. "$PSScriptRoot\Common.ps1"`: dot-sourcing runs another script here.
    const op = kids(node).find((c) => c.type === 'command_invokation_operator');
    if (op?.text === '.') {
      const target = node.childForFieldName('command_name') ?? named(node).find((c) => c.type === 'command_name_expr' || c.type === 'command_name');
      const source = scriptPath(target?.text ?? '');
      if (!source || source.includes('$')) return [];
      return [{ source, names: [], namespace: true, alias: source.replace(/^.*\//, '').replace(/\.[^.]+$/, ''), kind: 'static', line }];
    }
    if (/^Import-Module$/i.test(cmd) || /^Using-Module$/i.test(cmd)) {
      const value = commandElements(node).find((c) => c.type !== 'command_parameter');
      const raw = stringValue(value) ?? value?.text ?? '';
      const source = /[\\/]|\.psm?1$/.test(raw) ? scriptPath(raw) : raw.trim();
      if (!source) return [];
      return [{ source, names: [], namespace: true, alias: source.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, ''), kind: 'static', line }];
    }
    if (cmd === 'using') {
      // `using module Foo` / `using namespace System.IO`
      const els = commandElements(node);
      const what = els[0]?.text ?? '';
      const source = els[1]?.text ?? '';
      if (what !== 'module' || !source) return [];
      return [{ source, names: [], namespace: true, alias: source.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, ''), kind: 'static', line }];
    }
    return null;
  },

  references(node, ctx) {
    switch (node.type) {
      case 'variable': {
        // `$env:API_TOKEN` reads configuration.
        const m = /^\$env:([A-Za-z_][A-Za-z0-9_]*)$/i.exec(node.text);
        if (m) ctx.emitRef({ kind: 'config', name: m[1]! }, node);
        return;
      }
      case 'command': {
        const cmd = commandName(node);
        if (!cmd) return;
        const elements = commandElements(node);
        // `New-Object Repo` constructs; the cmdlet itself is noise.
        if (/^New-Object$/i.test(cmd)) {
          const first = elements.find((c) => c.type !== 'command_parameter');
          const type = stringValue(first) ?? first?.text ?? '';
          const name = simpleTypeName(type);
          if (name && !BUILTIN_TYPES.has(name)) ctx.emitRef({ kind: 'new', name }, first ?? node);
          return;
        }
        if (/^(Get|Set)-Item$/i.test(cmd) || /^(Test|Get)-EnvironmentVariable$/i.test(cmd)) return;
        if (BUILTIN_CMDLETS.has(cmd) || PESTER_SUITES.has(cmd) || PESTER_TESTS.has(cmd)) return;
        const arity = elements.filter((c) => c.type !== 'command_parameter').length;
        ctx.emitRef({ kind: 'call', name: stripScope(cmd).name, arity }, node);
        return;
      }
      case 'invokation_expression': {
        // `$repo.Find($id)` and `[Repo]::new()`
        const target = named(node)[0];
        const member = named(node).find((c) => c.type === 'member_name');
        if (!member) return;
        const name = member.text;
        const args = named(node).find((c) => c.type === 'argument_list');
        const arity = named(named(args).find((c) => c.type === 'argument_expression_list')).length;
        if (target?.type === 'type_literal') {
          const type = typeLiteralName(target);
          if (!type) return;
          if (name === 'new') ctx.emitRef({ kind: 'new', name: type, arity }, node);
          else if (/^Environment$/i.test(simpleTypeName(target.text)) && /GetEnvironmentVariable/i.test(name)) {
            const key = stringValue(named(named(args).find((c) => c.type === 'argument_expression_list'))[0]);
            if (key) ctx.emitRef({ kind: 'config', name: key }, node);
          } else ctx.emitRef({ kind: 'call', name, qualifier: type, arity }, member);
          return;
        }
        const qualifier = target?.type === 'variable' ? target.text.replace(/^\$/, '') : (target?.text ?? '');
        ctx.emitRef({ kind: 'call', name, qualifier, arity }, member);
        return;
      }
      case 'member_access': {
        const target = named(node)[0];
        const member = named(node).find((c) => c.type === 'member_name');
        if (!member) return;
        const qualifier = target?.type === 'variable' ? target.text.replace(/^\$/, '') : (target?.text ?? '');
        ctx.emitRef({ kind: 'value', name: member.text, qualifier }, member);
        return;
      }
      case 'script_parameter':
      case 'class_method_parameter': {
        const v = named(node).find((c) => c.type === 'variable');
        if (!v) return;
        const t = named(node)
          .flatMap((a) => (a.type === 'attribute_list' ? named(a) : [a]))
          .flatMap((a) => (a.type === 'attribute' ? named(a) : [a]))
          .find((c) => c.type === 'type_literal' || c.type === 'type_spec');
        const type = typeLiteralName(t);
        if (type) ctx.emitLocalType({ name: v.text.replace(/^\$/, ''), type, via: 'annotation' });
        return;
      }
      case 'assignment_expression': {
        const left = unwrap(node.childForFieldName('left') ?? named(node)[0]);
        const value = unwrap(node.childForFieldName('value'));
        if (!left) return;
        const name = (left.type === 'variable' ? left.text : left.text).replace(/^\$/, '');
        if (!name || /[\s[\]]/.test(name)) return;
        if (value?.type === 'invokation_expression') {
          const target = named(value)[0];
          const member = named(value).find((c) => c.type === 'member_name');
          if (target?.type === 'type_literal' && member?.text === 'new') {
            const type = typeLiteralName(target);
            if (type) ctx.emitLocalType({ name, type, via: 'new' });
          }
          return;
        }
        if (value?.type === 'command' && /^New-Object$/i.test(commandName(value))) {
          const first = commandElements(value).find((c) => c.type !== 'command_parameter');
          const type = simpleTypeName(stringValue(first) ?? first?.text ?? '');
          if (type && !BUILTIN_TYPES.has(type)) ctx.emitLocalType({ name, type, via: 'new' });
        }
        return;
      }
      case 'type_literal': {
        const type = typeLiteralName(node);
        // Attribute positions (`[CmdletBinding()]`, `[Parameter(Mandatory)]`) are filtered by
        // BUILTIN_TYPES; anything else named in brackets is a real type reference.
        if (type) ctx.emitRef({ kind: 'type', name: type }, node);
        return true;
      }
    }
    return;
  },

  resolveModule(source, fromPath, _imp, _project) {
    const fromDir = fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/')) : '';
    const clean = scriptPath(source);
    if (!clean) return [];
    const out: string[] = [];
    const push = (p: string) => {
      const n = normalizePath(p);
      if (n && !out.includes(n)) out.push(n);
    };
    const withExts = (base: string) => (/\.(ps1|psm1|psd1)$/i.test(base) ? [base] : [`${base}.psm1`, `${base}.ps1`, `${base}/${base.slice(base.lastIndexOf('/') + 1)}.psm1`]);
    for (const base of withExts(clean)) {
      push(fromDir ? `${fromDir}/${base}` : base);
      push(base);
    }
    return out;
  },
};

function normalizePath(p: string): string {
  const stack: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') stack.pop();
    else stack.push(seg);
  }
  return stack.join('/');
}
