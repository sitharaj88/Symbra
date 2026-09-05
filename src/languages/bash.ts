import type { Node } from 'web-tree-sitter';
import type { Import } from '../ir/types.js';
import type { DefSpec, LanguageSupport } from './types.js';
import { oneLine, precedingComments, cleanComment, named, kids } from '../parse/walk.js';

const COMMENTS = new Set(['comment']);
/** Builtins and ubiquitous external commands: never emitted as call references. */
const SHELL_BUILTINS = new Set([
  'echo', 'printf', 'cd', 'pwd', 'ls', 'cat', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'sed', 'awk', 'cut', 'sort', 'uniq', 'wc', 'tr', 'tee', 'xargs', 'find', 'curl', 'wget', 'set', 'unset', 'export', 'exit', 'return', 'local', 'declare', 'typeset', 'readonly', 'shift', 'test', '[', '[[', 'true', 'false', 'read', 'eval', 'exec', 'source', '.', 'trap', 'wait', 'kill', 'sleep', 'mkdir', 'rmdir', 'rm', 'cp', 'mv', 'ln', 'chmod', 'chown', 'touch', 'date', 'basename', 'dirname', 'realpath', 'readlink', 'which', 'command', 'type', 'hash', 'alias', 'unalias', 'break', 'continue', 'let', 'pushd', 'popd', 'dirs', 'jobs', 'bg', 'fg', 'umask', 'ulimit', 'getopts', 'times', 'builtin', 'caller', 'enable', 'help', 'logout', 'mapfile', 'readarray', 'shopt', 'suspend', 'compgen', 'complete', 'git', 'npm', 'npx', 'yarn', 'pnpm', 'node', 'python', 'python3', 'pip', 'pip3', 'docker', 'kubectl', 'make', 'cmake', 'go', 'cargo', 'rustc', 'gcc', 'clang', 'java', 'mvn', 'gradle', 'ruby', 'gem', 'bundle', 'perl', 'php', 'composer', 'ssh', 'scp', 'rsync', 'tar', 'gzip', 'gunzip', 'zip', 'unzip', 'jq', 'yq', 'sudo', 'su', 'env', 'nohup', 'time', 'seq', 'expr', 'bc', 'tput', 'stat', 'df', 'du', 'ps', 'top', 'nproc', 'uname', 'hostname', 'whoami', 'id', 'groups', 'install', 'mktemp', 'tempfile', 'diff', 'patch', 'cmp', 'md5sum', 'sha256sum', 'shasum', 'openssl', 'base64', 'od', 'xxd', 'hexdump', 'file', 'less', 'more', 'clear', 'reset', 'stty', 'tty', 'ping', 'nc', 'netstat', 'ss', 'ip', 'ifconfig', 'brew', 'apt', 'apt-get', 'yum', 'dnf', 'apk', 'pacman', 'systemctl', 'service', 'journalctl', 'crontab', 'at', 'watch', 'yes', 'no', 'true', 'false', 'if', 'then', 'else', 'fi', 'for', 'while', 'do', 'done', 'case', 'esac', 'function', 'select', 'until', 'in', 'exec', 'bash', 'sh', 'zsh', 'sleep',
]);
/** Common environment / shell variables: not project config keys. */
const SHELL_VARS = new Set(['HOME', 'PATH', 'PWD', 'OLDPWD', 'USER', 'SHELL', 'IFS', 'RANDOM', 'LINENO', 'BASH_SOURCE', 'HOSTNAME', 'TMPDIR', 'EDITOR', 'VISUAL', 'TERM', 'LANG', 'LC_ALL', 'LC_CTYPE', 'SECONDS', 'PS1', 'PS2', 'PS4', 'UID', 'EUID', 'PPID', 'BASH_VERSION', 'BASH_VERSINFO', 'FUNCNAME', 'OPTARG', 'OPTIND', 'OPTERR', 'REPLY', 'CDPATH', 'HISTFILE', 'HISTSIZE', 'DISPLAY', 'HOSTTYPE', 'OSTYPE', 'MACHTYPE', 'COLUMNS', 'LINES', 'SHLVL', 'DIRSTACK', 'PIPESTATUS', 'BASH_REMATCH', 'GROUPS', 'LOGNAME', 'MAIL', 'SHELLOPTS', 'BASHOPTS', 'BASH', 'BASH_LINENO', 'BASH_COMMAND', 'BASH_SUBSHELL', 'EPOCHSECONDS', 'EPOCHREALTIME', 'SRANDOM', 'ZSH_VERSION', 'ZSH_NAME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR', 'PAGER', 'LESS', 'TZ', 'DEBUG', 'VERBOSE', 'CI']);
/** Wrapper commands whose first argument is the real command. */
const WRAPPERS = new Set(['sudo', 'command', 'builtin', 'exec', 'time', 'nohup', 'env', 'nice', 'xargs', 'doas']);
/** Prefixes that scripts use to make `source` paths relative to the script's own directory. */
const SELF_DIR_PREFIX = /^(\$\(\s*dirname\s+"?\$\{?(0|BASH_SOURCE(\[0\])?)\}?"?\s*\)|\$\{BASH_SOURCE(\[0\])?%\/\*\}|\$\{?(SCRIPT_DIR|DIR|ROOT_DIR|BASE_DIR|SCRIPTDIR|HERE|__dir|THIS_DIR|PROJECT_ROOT|ROOT)\}?|\$\(\s*pwd\s*\)|\$\(cd[^)]*\))\/?/;

let assignedCache: { src: string; names: Set<string> } | null = null;
/** ALL-CAPS names assigned anywhere in the file (so `$X` reads of them are not config lookups). */
function assignedNames(src: string): Set<string> {
  if (assignedCache && assignedCache.src === src) return assignedCache.names;
  const names = new Set<string>();
  const re = /(?:^|[;\s(])(?:export\s+|readonly\s+|local\s+|declare\s+(?:-\w+\s+)*|typeset\s+(?:-\w+\s+)*)?([A-Z_][A-Z0-9_]*)(?:\[[^\]]*\])?\+?=/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) names.add(m[1]!);
  const re2 = /\b(?:for|read(?:\s+-\w+)*|getopts\s+\S+)\s+([A-Z_][A-Z0-9_]*)\b/g;
  while ((m = re2.exec(src))) names.add(m[1]!);
  assignedCache = { src, names };
  return names;
}

function unquote(n: Node): string {
  if (n.type === 'string' || n.type === 'raw_string') return n.text.slice(1, -1);
  return n.text;
}

function commandName(node: Node): Node | null {
  const nameNode = node.childForFieldName('name');
  const w = named(nameNode)[0];
  return w && w.type === 'word' ? w : null;
}

function argumentNodes(node: Node): Node[] {
  const out: Node[] = [];
  const cs = node.children;
  for (let i = 0; i < cs.length; i++) {
    const c = cs[i];
    if (c && node.fieldNameForChild(i) === 'argument') out.push(c);
  }
  return out;
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

export const bash: LanguageSupport = {
  id: 'bash',
  grammar: 'bash',
  extensions: ['.sh', '.bash', '.zsh'],
  classLike: new Set(),
  skip: new Set(['comment', 'raw_string', 'ansi_c_string']),

  isTestFile(path) {
    return /(^|\/)tests?\//.test(path) || /_test\.(sh|bash|zsh)$/.test(path) || /(^|\/)test_[^/]*\.(sh|bash|zsh)$/.test(path) || /\.test\.(sh|bash|zsh)$/.test(path);
  },

  doc(node) {
    return precedingComments(node, COMMENTS);
  },

  moduleDoc(root) {
    const parts: string[] = [];
    for (const c of named(root)) {
      if (c.type !== 'comment') break;
      if (c.text.startsWith('#!')) continue;
      parts.push(c.text);
    }
    return parts.length ? cleanComment(parts.join('\n')) : '';
  },

  definition(node, ctx): DefSpec | null {
    switch (node.type) {
      case 'function_definition': {
        const name = node.childForFieldName('name')?.text ?? '';
        if (!name) return null;
        const body = node.childForFieldName('body');
        const kind: DefSpec['kind'] = /^test[_A-Z]/.test(name) && bash.isTestFile!(ctx.path) ? 'test' : 'function';
        return { kind, name, body, signature: `${name}()`, doc: precedingComments(node, COMMENTS), exported: true };
      }
      case 'variable_assignment': {
        const holder = node.parent;
        if (!holder) return null;
        const isDecl = holder.type === 'declaration_command';
        const top = holder.type === 'program' || (isDecl && holder.parent?.type === 'program');
        if (!top) return null;
        const nameNode = node.childForFieldName('name');
        if (!nameNode || nameNode.type !== 'variable_name') return null;
        const name = nameNode.text;
        const decl = isDecl ? (kids(holder)[0]?.text ?? '') : '';
        if (decl === 'local') return null;
        const flags = isDecl ? named(holder).filter((c) => c.type === 'word' && c.text.startsWith('-')).map((c) => c.text) : [];
        const modifiers: string[] = [];
        if (decl === 'export' || flags.some((f) => /x/.test(f))) modifiers.push('export');
        if (decl === 'readonly' || flags.some((f) => /r/.test(f))) modifiers.push('readonly');
        if (flags.some((f) => /[aA]/.test(f))) modifiers.push('array');
        const value = node.childForFieldName('value')?.text ?? '';
        const kind: DefSpec['kind'] = modifiers.includes('readonly') || /^[A-Z][A-Z0-9_]*$/.test(name) ? 'constant' : 'variable';
        const docNode = isDecl ? holder : node;
        return { kind, name, signature: oneLine(`${decl ? decl + ' ' : ''}${flags.length ? flags.join(' ') + ' ' : ''}${name}=${value}`, 160), doc: precedingComments(docNode, COMMENTS), modifiers, exported: true, meta: modifiers.includes('export') ? { env: true } : undefined };
      }
    }
    return null;
  },

  imports(node): Import[] | null {
    if (node.type !== 'command') return null;
    const w = commandName(node);
    if (!w || (w.text !== 'source' && w.text !== '.')) return null;
    const arg = argumentNodes(node)[0];
    if (!arg) return [];
    let source = unquote(arg).trim();
    let kind: Import['kind'] = 'static';
    if (/[$`]/.test(source)) {
      kind = 'dynamic';
      source = source.replace(SELF_DIR_PREFIX, '');
    }
    if (!source || /[$`]/.test(source)) return [];
    return [{ source, names: [], namespace: true, alias: '', kind, line: node.startPosition.row + 1 }];
  },

  references(node, ctx) {
    switch (node.type) {
      case 'command': {
        let w = commandName(node);
        if (!w) return;
        const args = argumentNodes(node);
        let name = w.text;
        let arity = args.length;
        if (WRAPPERS.has(name)) {
          const first = args.find((a) => a.type === 'word' && !a.text.startsWith('-'));
          if (!first) return;
          w = first;
          name = first.text;
          arity = args.length - args.indexOf(first) - 1;
        }
        if (SHELL_BUILTINS.has(name) || name.includes('/') || name.startsWith('-') || name.startsWith('$')) return;
        ctx.emitRef({ kind: 'call', name, arity }, w);
        return;
      }
      case 'simple_expansion':
      case 'expansion': {
        const v = named(node)[0];
        if (v?.type === 'variable_name' && /^[A-Z][A-Z0-9_]+$/.test(v.text) && !SHELL_VARS.has(v.text) && !assignedNames(ctx.source).has(v.text)) {
          ctx.emitRef({ kind: 'config', name: v.text }, v);
        }
        return node.type === 'simple_expansion';
      }
    }
    return;
  },

  resolveModule(source, fromPath) {
    const fromDir = fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/')) : '';
    const out: string[] = [];
    const rel = source.replace(/^\.\//, '');
    out.push(joinPath(fromDir, rel));
    out.push(joinPath('', rel));
    if (!rel.includes('/')) out.push(`lib/${rel}`, `scripts/${rel}`, `bin/${rel}`);
    return [...new Set(out)];
  },
};
