import type { Edge, EdgeKind, ReferenceKind, SymbolKind } from '../ir/types.js';
import type { Store, SymbolRow } from '../store/db.js';
import { moduleId } from '../store/db.js';
import type { LanguageSupport, ModuleResolutionContext } from '../languages/types.js';
import { languageById } from '../languages/registry.js';
import { SWIFT_TARGET_PREFIX } from '../languages/swift.js';

const CLASS_KINDS: ReadonlySet<SymbolKind> = new Set(['class', 'interface', 'struct', 'enum', 'trait', 'namespace']);
const CALLABLE_KINDS: ReadonlySet<SymbolKind> = new Set(['function', 'method', 'constructor', 'class', 'struct', 'macro']);
/** Kinds a `value` reference can pass as a callback: the reference then becomes a `passes` edge. */
const PASSABLE_KINDS: ReadonlySet<SymbolKind> = new Set(['function', 'method', 'constructor']);
/**
 * Languages where a bare `helper()` inside a method reaches the enclosing class's members (own or
 * inherited) without a receiver. Python and JavaScript need `self.` / `this.`, Go has no implicit
 * receiver at all, so those stay out.
 */
const IMPLICIT_SELF_LANGS = new Set(['java', 'kotlin', 'scala', 'csharp', 'swift', 'ruby', 'cpp', 'dart', 'objc', 'groovy', 'powershell']);
const SELF_NAMES = new Set(['self', 'this', 'cls', 'super', 'parent', 'Self', 'static']);
/**
 * Languages where every file of a package shares one scope. The package is the directory, except
 * in Swift where it is the SwiftPM/Xcode target (see `scopeFiles`).
 */
const PACKAGE_DIR_LANGS = new Set(['go', 'java', 'kotlin', 'scala', 'swift']);
/** Languages whose files declare a `package` that is a real, corpus-wide scope. */
const JVM_PKG_LANGS = new Set(['java', 'kotlin', 'scala', 'groovy']);
/** How many extra files one C# `using X.Y;` may add as `imports` edges. */
const NS_EDGE_CAP = 24;
/** How many symbols one name imported from a C# namespace may bind to. */
const NS_IDS_CAP = 8;

/** Names too common to bind by corpus-wide uniqueness. */
const COMMON_MEMBER_NAMES = new Set([
  'get', 'set', 'add', 'run', 'start', 'stop', 'close', 'open', 'read', 'write', 'send', 'init', 'main', 'new', 'create', 'update', 'delete', 'remove', 'find', 'push', 'pop', 'map', 'filter', 'reduce', 'forEach', 'join', 'split', 'length', 'size', 'toString', 'valueOf', 'then', 'catch', 'finally', 'call', 'apply', 'bind', 'keys', 'values', 'items', 'append', 'extend', 'insert', 'index', 'count', 'sort', 'reverse', 'copy', 'clear', 'format', 'strip', 'lower', 'upper', 'replace', 'encode', 'decode', 'json', 'text', 'status', 'data', 'name', 'type', 'value', 'id', 'key', 'next', 'done', 'error', 'log', 'info', 'warn', 'debug', 'emit', 'on', 'off', 'once', 'has', 'is', 'to', 'from', 'of', 'in', 'at', 'end', 'begin', 'load', 'save', 'render', 'handle', 'process', 'parse', 'build', 'test', 'setup', 'teardown', 'match', 'search', 'exec', 'trim', 'slice', 'splice', 'concat', 'includes', 'indexOf', 'assign', 'freeze', 'entries', 'resolve', 'reject', 'all', 'race', 'any', 'path', 'format', 'html', 'before', 'after', 'options', 'config', 'params', 'query', 'body', 'headers', 'url', 'method', 'route', 'router', 'handler', 'middleware', 'request', 'response', 'result', 'results', 'item', 'items', 'list', 'node', 'tree', 'root', 'parent', 'child', 'children', 'source', 'target', 'state', 'store', 'model', 'view', 'controller', 'service', 'client', 'server', 'db', 'database', 'user', 'users', 'message', 'msg', 'title', 'description', 'content', 'template', 'version', 'level', 'color', 'size', 'width', 'height', 'validate', 'check', 'verify', 'apply', 'execute', 'invoke', 'dispatch', 'register', 'connect', 'disconnect', 'listen', 'serve', 'fetch', 'download', 'upload', 'login', 'logout', 'auth', 'authenticate', 'authorize', 'encrypt', 'decrypt', 'hash', 'sign', 'wrap', 'unwrap', 'mount', 'unmount', 'attach', 'detach', 'toJSON', 'fromJSON', 'stringify', 'serialize', 'deserialize', 'normalize', 'transform', 'convert', 'compile', 'generate', 'make', 'factory', 'helper', 'helpers', 'main', 'app', 'plugin', 'plugins', 'callback', 'cb', 'fn', 'func', 'method', 'error', 'err', 'e', 'ctx', 'context', 'req', 'res', 'next', 'done', 'data', 'value', 'values', 'input', 'output', 'args', 'kwargs', 'opts', 'settings', 'env', 'meta', 'info', 'details', 'summary', 'total', 'count', 'sum', 'avg', 'min', 'max', 'first', 'last', 'head', 'tail', 'prev', 'current', 'active', 'enabled', 'disabled', 'visible', 'hidden', 'open', 'closed', 'ready', 'loading', 'loaded', 'success', 'failure', 'ok', 'fail', 'pass', 'skip',
]);

const BUILTINS: Record<string, Set<string>> = {
  python: new Set(['print', 'len', 'range', 'str', 'int', 'float', 'bool', 'list', 'dict', 'set', 'tuple', 'type', 'isinstance', 'issubclass', 'getattr', 'setattr', 'hasattr', 'super', 'object', 'enumerate', 'zip', 'map', 'filter', 'sorted', 'reversed', 'min', 'max', 'sum', 'abs', 'any', 'all', 'open', 'iter', 'next', 'id', 'hash', 'repr', 'format', 'bytes', 'bytearray', 'callable', 'classmethod', 'staticmethod', 'property', 'vars', 'dir', 'globals', 'locals', 'input', 'round', 'divmod', 'pow', 'chr', 'ord', 'hex', 'oct', 'bin', 'frozenset', 'slice', 'memoryview', 'complex', 'Exception', 'BaseException', 'ValueError', 'TypeError', 'KeyError', 'IndexError', 'RuntimeError', 'AttributeError', 'NotImplementedError', 'StopIteration', 'OSError', 'IOError', 'ImportError', 'AssertionError', 'LookupError', 'ZeroDivisionError', 'NotImplemented', 'Ellipsis', 'None', 'True', 'False', 'self', 'cls', 'Optional', 'Union', 'Any', 'List', 'Dict', 'Set', 'Tuple', 'Callable', 'Iterable', 'Iterator', 'Generator', 'Awaitable', 'Coroutine', 'AsyncIterator', 'Type', 'TypeVar', 'Generic', 'Protocol', 'Literal', 'Final', 'ClassVar', 'Sequence', 'Mapping']),
  javascript: new Set(['require', 'console', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Symbol', 'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Date', 'RegExp', 'Error', 'TypeError', 'RangeError', 'SyntaxError', 'JSON', 'Math', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'setImmediate', 'queueMicrotask', 'process', 'Buffer', 'globalThis', 'window', 'document', 'fetch', 'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder', 'Reflect', 'Proxy', 'Function', 'BigInt', 'Intl', 'structuredClone', 'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI', 'undefined', 'null', 'arguments', 'module', 'exports', '__dirname', '__filename', 'Infinity', 'NaN', 'AbortController', 'Event', 'EventTarget', 'Headers', 'Request', 'Response', 'Blob', 'FormData', 'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array', 'ArrayBuffer', 'DataView', 'SharedArrayBuffer', 'Atomics', 'WeakRef', 'FinalizationRegistry', 'Iterator', 'Partial', 'Required', 'Readonly', 'Record', 'Pick', 'Omit', 'Exclude', 'Extract', 'NonNullable', 'ReturnType', 'Parameters', 'InstanceType', 'Awaited', 'Promise', 'this', 'super', 'React', 'Symbol']),
};
// vitest/jest/mocha globals: injected by the test runner, never a definition in the repo. Without
// them every `describe`/`expect` in the corpus becomes an ambiguous candidate set.
for (const n of ['describe', 'it', 'test', 'expect', 'beforeEach', 'afterEach', 'beforeAll', 'afterAll', 'vi', 'jest', 'suite', 'bench']) BUILTINS.javascript!.add(n);
BUILTINS.typescript = BUILTINS.javascript!;
BUILTINS.ruby = new Set(['puts', 'print', 'p', 'pp', 'raise', 'require', 'require_relative', 'attr_reader', 'attr_writer', 'attr_accessor', 'include', 'extend', 'lambda', 'proc', 'loop', 'catch', 'throw', 'format', 'sprintf', 'Array', 'Hash', 'String', 'Integer', 'Float', 'Symbol', 'Proc', 'Struct', 'Class', 'Module', 'Object', 'Kernel', 'Comparable', 'Enumerable', 'Exception', 'StandardError', 'ArgumentError', 'RuntimeError', 'NotImplementedError', 'Time', 'Date', 'File', 'Dir', 'IO', 'JSON', 'YAML', 'ENV', 'Rails', 'ActiveRecord', 'ApplicationRecord', 'ApplicationController', 'RSpec', 'nil', 'true', 'false', 'self']);
BUILTINS.php = new Set(['strlen', 'count', 'array_map', 'array_filter', 'array_keys', 'array_values', 'array_merge', 'in_array', 'implode', 'explode', 'str_replace', 'substr', 'strpos', 'sprintf', 'printf', 'json_encode', 'json_decode', 'is_array', 'is_string', 'is_null', 'isset', 'empty', 'unset', 'compact', 'extract', 'define', 'constant', 'intval', 'floatval', 'strval', 'trim', 'strtolower', 'strtoupper', 'ucfirst', 'preg_match', 'preg_replace', 'file_get_contents', 'file_put_contents', 'var_dump', 'print_r', 'die', 'exit', 'Exception', 'RuntimeException', 'InvalidArgumentException', 'LogicException', 'Throwable', 'Error', 'TypeError', 'Closure', 'Generator', 'ArrayAccess', 'Countable', 'Iterator', 'IteratorAggregate', 'Traversable', 'Stringable', 'JsonSerializable', 'DateTime', 'DateTimeImmutable', 'DateTimeInterface', 'stdClass', 'array', 'string', 'int', 'bool', 'float', 'mixed', 'void', 'null', 'self', 'static', 'parent']);
BUILTINS.go = new Set(['make', 'new', 'len', 'cap', 'append', 'copy', 'delete', 'panic', 'recover', 'print', 'println', 'close', 'error', 'string', 'int', 'int64', 'int32', 'uint', 'byte', 'rune', 'bool', 'float64', 'float32', 'any', 'nil', 'true', 'false', 'iota', 'min', 'max', 'clear', 'complex', 'real', 'imag']);
BUILTINS.rust = new Set(['Some', 'None', 'Ok', 'Err', 'Box', 'Vec', 'String', 'Option', 'Result', 'Rc', 'Arc', 'RefCell', 'Cell', 'Mutex', 'RwLock', 'HashMap', 'HashSet', 'BTreeMap', 'BTreeSet', 'VecDeque', 'Self', 'self', 'drop', 'println', 'print', 'eprintln', 'format', 'panic', 'assert', 'assert_eq', 'vec', 'todo', 'unimplemented', 'unreachable', 'Default', 'Clone', 'Copy', 'Debug', 'Display', 'PartialEq', 'Eq', 'Hash', 'PartialOrd', 'Ord', 'Iterator', 'IntoIterator', 'From', 'Into', 'TryFrom', 'TryInto', 'AsRef', 'Send', 'Sync', 'Sized', 'Fn', 'FnMut', 'FnOnce', 'Deref', 'Drop', 'Error', 'Future', 'Pin']);
BUILTINS.csharp = new Set(['Console', 'Task', 'List', 'Dictionary', 'HashSet', 'IEnumerable', 'IList', 'IDictionary', 'ICollection', 'IReadOnlyList', 'Assert', 'Exception', 'ArgumentException', 'ArgumentNullException', 'InvalidOperationException', 'NotImplementedException', 'String', 'Object', 'Int32', 'Int64', 'Boolean', 'Double', 'Decimal', 'DateTime', 'TimeSpan', 'Guid', 'Math', 'Convert', 'Enumerable', 'StringBuilder', 'Nullable', 'Func', 'Action', 'Predicate', 'CancellationToken', 'ValueTask', 'HttpClient', 'Stream', 'File', 'Path', 'Directory', 'Environment', 'Type', 'Attribute', 'Array', 'Tuple', 'KeyValuePair', 'Fact', 'Theory', 'Test', 'TestMethod', 'Obsolete', 'Serializable']);
BUILTINS.c = new Set(['malloc', 'calloc', 'realloc', 'free', 'printf', 'fprintf', 'sprintf', 'snprintf', 'puts', 'putchar', 'scanf', 'strlen', 'strcpy', 'strncpy', 'strcmp', 'strncmp', 'strcat', 'memcpy', 'memset', 'memcmp', 'memmove', 'fopen', 'fclose', 'fread', 'fwrite', 'fgets', 'exit', 'abort', 'assert', 'sizeof', 'size_t', 'int', 'char', 'void', 'long', 'short', 'float', 'double', 'unsigned', 'bool', 'FILE', 'NULL', 'errno', 'perror', 'atoi', 'atof', 'strtol', 'qsort', 'bsearch', 'getenv', 'main']);
BUILTINS.cpp = new Set([...BUILTINS.c!, 'std', 'string', 'vector', 'map', 'unordered_map', 'set', 'unordered_set', 'shared_ptr', 'unique_ptr', 'make_shared', 'make_unique', 'move', 'forward', 'cout', 'cerr', 'endl', 'size', 'begin', 'end', 'optional', 'variant', 'function', 'array', 'pair', 'tuple', 'runtime_error', 'exception', 'logic_error', 'invalid_argument', 'out_of_range', 'string_view', 'span', 'thread', 'mutex', 'atomic', 'chrono', 'TEST', 'TEST_F', 'EXPECT_EQ', 'ASSERT_EQ', 'EXPECT_TRUE', 'ASSERT_TRUE', 'REQUIRE', 'CHECK', 'nullptr', 'this']);
BUILTINS.java = new Set(['String', 'Object', 'Integer', 'Long', 'Double', 'Float', 'Boolean', 'Character', 'Byte', 'Short', 'Void', 'List', 'ArrayList', 'LinkedList', 'Map', 'HashMap', 'TreeMap', 'LinkedHashMap', 'Set', 'HashSet', 'TreeSet', 'Optional', 'Stream', 'Collectors', 'Arrays', 'Collections', 'Objects', 'System', 'Math', 'Override', 'Deprecated', 'SuppressWarnings', 'FunctionalInterface', 'Exception', 'RuntimeException', 'IllegalArgumentException', 'IllegalStateException', 'NullPointerException', 'Throwable', 'Error', 'Iterable', 'Iterator', 'Comparable', 'Comparator', 'Runnable', 'Callable', 'Thread', 'StringBuilder', 'CharSequence', 'Number', 'Enum', 'Record', 'Class', 'Function', 'Supplier', 'Consumer', 'Predicate', 'BiFunction', 'CompletableFuture', 'Future', 'Executor', 'ExecutorService', 'LocalDate', 'LocalDateTime', 'Instant', 'Duration', 'UUID', 'BigDecimal', 'BigInteger', 'Path', 'Paths', 'Files', 'File', 'InputStream', 'OutputStream', 'Reader', 'Writer', 'IOException', 'Test', 'BeforeEach', 'AfterEach', 'BeforeAll', 'AfterAll', 'Autowired', 'Override']);
BUILTINS.kotlin = new Set(['println', 'print', 'listOf', 'mutableListOf', 'mapOf', 'mutableMapOf', 'setOf', 'mutableSetOf', 'arrayOf', 'emptyList', 'emptyMap', 'require', 'check', 'error', 'TODO', 'lazy', 'run', 'let', 'apply', 'also', 'with', 'takeIf', 'repeat', 'String', 'Int', 'Long', 'Double', 'Float', 'Boolean', 'Char', 'Unit', 'Any', 'Nothing', 'List', 'MutableList', 'Map', 'MutableMap', 'Set', 'MutableSet', 'Array', 'Pair', 'Triple', 'Result', 'Exception', 'RuntimeException', 'IllegalArgumentException', 'IllegalStateException', 'Throwable', 'Sequence', 'Iterable', 'Comparable', 'Number', 'StringBuilder', 'Test', 'JvmStatic', 'Deprecated', 'Suppress']);
BUILTINS.scala = new Set(['println', 'print', 'Option', 'Some', 'None', 'List', 'Seq', 'Map', 'Set', 'Vector', 'Array', 'String', 'Int', 'Long', 'Double', 'Float', 'Boolean', 'Char', 'Unit', 'Any', 'AnyRef', 'Nothing', 'Either', 'Left', 'Right', 'Try', 'Success', 'Failure', 'Future', 'Iterable', 'Iterator', 'Tuple2', 'Exception', 'RuntimeException', 'Throwable', 'StringBuilder', 'require', 'assert', 'implicitly', 'summon']);
BUILTINS.tsx = BUILTINS.javascript!;

function simpleName(t: string): string {
  const s = t.replace(/[*&\[\]]/g, '');
  const i = Math.max(s.lastIndexOf('.'), s.lastIndexOf('::'));
  return i >= 0 ? s.slice(i + 1).replace(/^:/, '') : s;
}

/** The `package` a module symbol's meta records, or ''. */
function packageFromMeta(meta: string | null): string {
  if (!meta || !meta.includes('"package"')) return '';
  try {
    const v = (JSON.parse(meta) as { package?: unknown }).package;
    return typeof v === 'string' ? v : '';
  } catch {
    return '';
  }
}

function familyOf(lang: string): string {
  if (lang === 'javascript' || lang === 'typescript' || lang === 'tsx') return 'js';
  if (lang === 'java' || lang === 'kotlin' || lang === 'scala') return 'jvm';
  if (lang === 'c' || lang === 'cpp') return 'c';
  return lang;
}

/**
 * A reference that provably belongs to something outside the repo (a name imported from an
 * unresolved package, a language builtin). Distinct from `null`, which means "nothing matched":
 * an external name must not be turned into a candidate set, or every `writeFile` from
 * `node:fs/promises` shows up as an ambiguous call.
 */
const EXTERNAL = { external: true } as const;
type External = typeof EXTERNAL;

interface Binding {
  kind: 'module' | 'symbol' | 'external';
  file?: string;
  ids?: string[];
}

interface Resolution {
  ids: string[];
  resolver: Edge['resolver'];
  confidence: number;
}

export interface FileResolutionResult {
  edges: Edge[];
  unresolved: { line: number; scope: string; kind: string; name: string; qualifier: string; candidates: string[] }[];
  importsResolved: number;
  importsTotal: number;
}

interface RefRow {
  file: string;
  line: number;
  byte: number;
  kind: ReferenceKind;
  name: string;
  qualifier: string;
  scope: string;
  arity: number | null;
}

interface ImportRow {
  rowid: number;
  file: string;
  line: number;
  source: string;
  names: string;
  namespace: number;
  alias: string;
  kind: 'static' | 'dynamic' | 'type' | 'reexport';
  relative_level: number;
  resolved: string | null;
}

interface LocalTypeRow {
  scope: string;
  name: string;
  type: string;
  via: string;
}

export class Resolver {
  private exportedByName = new Map<string, SymbolRow[]>();
  private anyByName = new Map<string, SymbolRow[]>();
  private langOfFile = new Map<string, string>();
  private testFiles = new Set<string>();
  private fileSymbols = new Map<string, SymbolRow[]>();
  private dirFiles = new Map<string, string[]>();
  private importsByFile = new Map<string, ImportRow[]>();
  private reexportMemo = new Map<string, SymbolRow[]>();
  private childrenCache = new Map<string, Map<string, SymbolRow[]>>();
  private symbolById = new Map<string, SymbolRow>();
  /** class id -> parent class ids (from extends/implements edges), refreshed lazily. */
  private supers = new Map<string, string[]>();
  /** Swift: target name -> its files, and the reverse. One target is one scope, with no imports. */
  private swiftTargetFiles = new Map<string, string[]>();
  private swiftTargetOfFile = new Map<string, string>();
  /** C#: namespace fqn -> files declaring it, and its exported top-level members. */
  private nsFiles = new Map<string, string[]>();
  private nsMembers = new Map<string, SymbolRow[]>();
  /** C#: fqn -> top-level symbols, for `using static X.Y.Z` and `using F = X.Y.Z`. */
  private csByFqn = new Map<string, SymbolRow[]>();
  /** C#: `global using` rows, visible to every file under the declaring file's directory. */
  private globalUsings: { file: string; dir: string; imp: ImportRow }[] = [];
  /** JVM: file -> its declared package, package -> its files, package -> exported top-level members. */
  private pkgOfFile = new Map<string, string>();
  private pkgFiles = new Map<string, string[]>();
  private pkgMembers = new Map<string, SymbolRow[]>();
  private scopeFilesCache = new Map<string, string[]>();

  constructor(
    readonly store: Store,
    readonly project: ModuleResolutionContext,
  ) {}

  /** Load corpus-wide indexes. Call once per indexing run (after IR insertion). */
  loadIndexes() {
    this.exportedByName.clear();
    this.anyByName.clear();
    this.symbolById.clear();
    this.fileSymbols.clear();
    this.childrenCache.clear();
    this.supers.clear();
    this.langOfFile.clear();
    this.testFiles.clear();
    this.dirFiles.clear();
    this.importsByFile.clear();
    this.reexportMemo.clear();
    this.swiftTargetFiles.clear();
    this.swiftTargetOfFile.clear();
    this.nsFiles.clear();
    this.nsMembers.clear();
    this.csByFqn.clear();
    this.pkgOfFile.clear();
    this.pkgFiles.clear();
    this.pkgMembers.clear();
    this.scopeFilesCache.clear();
    this.globalUsings = [];
    for (const imp of this.store.prep('SELECT rowid, * FROM imports ORDER BY file, rowid').all() as ImportRow[]) {
      let arr = this.importsByFile.get(imp.file);
      if (!arr) this.importsByFile.set(imp.file, (arr = []));
      arr.push(imp);
    }
    for (const f of this.store.prep('SELECT path, language, is_test FROM files ORDER BY path').all() as { path: string; language: string; is_test: number }[]) {
      this.langOfFile.set(f.path, f.language);
      if (f.is_test) this.testFiles.add(f.path);
      const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
      let arr = this.dirFiles.get(dir);
      if (!arr) this.dirFiles.set(dir, (arr = []));
      arr.push(f.path);
      if (f.language === 'swift') {
        const t = this.project.swiftTargetOf?.(f.path);
        if (t) {
          this.swiftTargetOfFile.set(f.path, t);
          let tf = this.swiftTargetFiles.get(t);
          if (!tf) this.swiftTargetFiles.set(t, (tf = []));
          tf.push(f.path);
        }
      }
    }
    // Deterministic order: without it the row order is SQLite's insertion history, so an
    // edit-and-revert would change which candidate a tie-broken lookup picks.
    const rows = this.store.prep('SELECT * FROM symbols ORDER BY file, ordinal').all() as SymbolRow[];
    for (const s of rows) {
      this.symbolById.set(s.id, s);
      let arr = this.fileSymbols.get(s.file);
      if (!arr) this.fileSymbols.set(s.file, (arr = []));
      arr.push(s);
      if (s.kind === 'module') {
        // JVM: the declared package rides on the module symbol's meta (see `insertIR`); fall back
        // to the path below a source root, for files whose package line the grammar missed.
        if (JVM_PKG_LANGS.has(this.langOfFile.get(s.file) ?? '')) {
          const pkg = packageFromMeta(s.meta) || this.packageFromPath(s.file);
          if (pkg) {
            this.pkgOfFile.set(s.file, pkg);
            let pf = this.pkgFiles.get(pkg);
            if (!pf) this.pkgFiles.set(pkg, (pf = []));
            pf.push(s.file);
          }
        }
        continue;
      }
      let a = this.anyByName.get(s.name);
      if (!a) this.anyByName.set(s.name, (a = []));
      a.push(s);
    }
    for (const s of rows) {
      if (s.kind === 'module') continue;
      const top = s.parent ? this.isTopLevelId(s) : false;
      if (s.exported && top) {
        let e = this.exportedByName.get(s.name);
        if (!e) this.exportedByName.set(s.name, (e = []));
        e.push(s);
      }
      // JVM: index the package's exported top-level members by simple name, so `import a.b.C`
      // finds C whatever the file is called (`Models.kt`) and wherever the source set lives.
      const jpkg = this.pkgOfFile.get(s.file);
      if (jpkg && s.exported && top) {
        let pm = this.pkgMembers.get(jpkg);
        if (!pm) this.pkgMembers.set(jpkg, (pm = []));
        pm.push(s);
      }
      // C#: index namespaces so `using X.Y;` and same-namespace siblings reach real files. Both
      // the block form (types parented by a `namespace` symbol) and the file-scoped form (types
      // carrying the namespace as an fqn prefix) end up with the namespace as their fqn prefix.
      if (!top || this.langOfFile.get(s.file) !== 'csharp') continue;
      if (s.kind === 'namespace') {
        this.addNsFile(s.fqn, s.file);
        continue;
      }
      const dot = s.fqn.lastIndexOf('.');
      let byFqn = this.csByFqn.get(s.fqn);
      if (!byFqn) this.csByFqn.set(s.fqn, (byFqn = []));
      byFqn.push(s);
      if (dot < 0 || !s.exported) continue;
      const ns = s.fqn.slice(0, dot);
      this.addNsFile(ns, s.file);
      let m = this.nsMembers.get(ns);
      if (!m) this.nsMembers.set(ns, (m = []));
      m.push(s);
    }
    // Rust: methods live in `impl` blocks; let the struct/enum reach them through supers.
    for (const s of rows) {
      if (!s.meta || !s.meta.includes('"impl":true')) continue;
      for (const t of this.fileSymbols.get(s.file) ?? []) {
        if ((t.kind !== 'struct' && t.kind !== 'enum' && t.kind !== 'class') || t.id === s.id) continue;
        if (t.name !== s.name || t.parent !== s.parent) continue;
        let a = this.supers.get(t.id);
        if (!a) this.supers.set(t.id, (a = []));
        if (!a.includes(s.id)) a.push(s.id);
      }
    }
    for (const e of this.store.prep("SELECT src, dst FROM edges WHERE kind IN ('extends','implements') ORDER BY src, dst").all() as { src: string; dst: string }[]) {
      let a = this.supers.get(e.src);
      if (!a) this.supers.set(e.src, (a = []));
      if (!a.includes(e.dst)) a.push(e.dst);
    }
    // C# `global using` (stored with kind `reexport`): visible to the whole project, approximated
    // by every C# file under the declaring file's directory.
    for (const [f, imps] of this.importsByFile) {
      if (this.langOfFile.get(f) !== 'csharp') continue;
      const dir = f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '';
      for (const imp of imps) if (imp.kind === 'reexport') this.globalUsings.push({ file: f, dir, imp });
    }
  }

  private addNsFile(ns: string, file: string): void {
    let a = this.nsFiles.get(ns);
    if (!a) this.nsFiles.set(ns, (a = []));
    if (!a.includes(file)) a.push(file);
  }

  /**
   * Files sharing `file`'s package scope: a Swift target, otherwise the directory plus — on the
   * JVM — every other file declaring the same package. A Kotlin Multiplatform package is spread
   * over source sets and modules (`common/src/commonMain/kotlin/...` and
   * `androidApp/src/main/java/...`), so the directory alone is not the package.
   */
  private scopeFiles(file: string): string[] {
    const t = this.swiftTargetOfFile.get(file);
    if (t) return this.swiftTargetFiles.get(t) ?? [];
    const cached = this.scopeFilesCache.get(file);
    if (cached) return cached;
    const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '';
    const base = this.dirFiles.get(dir) ?? [];
    const pkg = this.pkgOfFile.get(file);
    const inPkg = pkg ? (this.pkgFiles.get(pkg) ?? []) : [];
    let out = base;
    if (inPkg.length) {
      const seen = new Set(base);
      out = [...base];
      for (const f of inPkg) if (!seen.has(f)) (seen.add(f), out.push(f));
    }
    this.scopeFilesCache.set(file, out);
    return out;
  }

  /** The JVM package of a path below a known source root: `x/src/main/java/a/b/C.java` -> `a.b`. */
  private packageFromPath(file: string): string {
    for (const r of this.project.jvmRoots ?? []) {
      if (!file.startsWith(r + '/')) continue;
      const rest = file.slice(r.length + 1);
      const slash = rest.lastIndexOf('/');
      return slash < 0 ? '' : rest.slice(0, slash).replace(/\//g, '.');
    }
    return '';
  }

  /**
   * Symbols named by a dotted JVM name (`a.b.C`, `a.b.C.Inner`, `a.b.topLevelFn`) through the
   * package index, independent of file names. Falls back to reading the prefix as a type and
   * looking the last segment up as one of its members.
   */
  private jvmLookup(dotted: string, depth = 0): SymbolRow[] {
    const dot = dotted.lastIndexOf('.');
    if (dot < 0 || depth > 4) return [];
    const pkg = dotted.slice(0, dot);
    const name = dotted.slice(dot + 1);
    const direct = (this.pkgMembers.get(pkg) ?? []).filter((s) => s.name === name);
    if (direct.length) return direct;
    const ownerSeg = pkg.slice(pkg.lastIndexOf('.') + 1);
    if (!/^[A-Z]/.test(ownerSeg)) return [];
    for (const owner of this.jvmLookup(pkg, depth + 1)) {
      const mem = this.member(owner.id, name);
      if (mem.length) return mem;
    }
    return [];
  }

  /** Representative file for a JVM import that no file name matched: the file declaring the type. */
  private jvmImportTarget(file: string, imp: ImportRow): string | null {
    const src = imp.source;
    if (imp.namespace) {
      // `import a.b.*`: any other file of the package; `import a.b.C.*`: the file declaring C.
      const f = (this.pkgFiles.get(src) ?? []).find((p) => p !== file);
      if (f) return f;
    }
    return this.jvmLookup(src).find((s) => s.file !== file)?.file ?? null;
  }

  /** `import a.b.*`: bind every exported top-level member of the package, and link their files. */
  private bindJvmWildcard(file: string, imp: ImportRow, bindings: Map<string, Binding>, edges: Edge[]): void {
    const members = this.pkgMembers.get(imp.source);
    if (!members) return;
    const byName = new Map<string, string[]>();
    const files = new Set<string>();
    for (const s of members) {
      if (s.file === file) continue;
      files.add(s.file);
      let a = byName.get(s.name);
      if (!a) byName.set(s.name, (a = []));
      if (a.length < NS_IDS_CAP) a.push(s.id);
    }
    for (const [name, ids] of byName) if (!bindings.has(name)) bindings.set(name, { kind: 'symbol', ids });
    let n = 0;
    for (const f of files) {
      if (f === imp.resolved || ++n > NS_EDGE_CAP) continue;
      edges.push({ src: moduleId(file), dst: moduleId(f), kind: 'imports', file, line: imp.line, resolver: 'import', confidence: 1 });
    }
  }

  private isTopLevelId(s: SymbolRow): boolean {
    // top level = parent is the module symbol, or only namespaces in between
    let cur: SymbolRow | undefined = s;
    let hops = 0;
    while (cur && cur.parent && cur.parent !== cur.file && hops++ < 8) {
      const p = this.symbolById.get(cur.parent);
      if (!p || p.kind !== 'namespace') return false;
      cur = p;
    }
    return true;
  }

  private childrenOf(parentId: string): Map<string, SymbolRow[]> {
    let m = this.childrenCache.get(parentId);
    if (m) return m;
    m = new Map();
    const p = this.symbolById.get(parentId);
    const file = p ? p.file : parentId;
    for (const s of this.fileSymbols.get(file) ?? []) {
      if (s.parent !== parentId) continue;
      let a = m.get(s.name);
      if (!a) m.set(s.name, (a = []));
      a.push(s);
    }
    this.childrenCache.set(parentId, m);
    return m;
  }

  /** Top-level symbols named `name` in every file of `file`'s package scope (directory, or Swift target). */
  private packageMembers(file: string, name: string, includeTests: boolean): SymbolRow[] {
    const out: SymbolRow[] = [];
    for (const f of this.scopeFiles(file)) {
      if (f === file) continue;
      if (!includeTests && this.testFiles.has(f)) continue;
      // Same language, or any two JVM languages: one Kotlin package can hold Java files too.
      const lf = this.langOfFile.get(f) ?? '';
      const l0 = this.langOfFile.get(file) ?? '';
      if (lf !== l0 && !(familyOf(lf) === 'jvm' && familyOf(l0) === 'jvm')) continue;
      const hit = this.childrenOf(moduleId(f)).get(name);
      if (hit) out.push(...hit);
    }
    return out;
  }

  /** Find a member of a class-like symbol by name, walking the supertypes. */
  private member(classId: string, name: string, seen = new Set<string>()): SymbolRow[] {
    if (seen.has(classId)) return [];
    seen.add(classId);
    const direct = this.childrenOf(classId).get(name);
    if (direct?.length) return direct;
    const cls = this.symbolById.get(classId);
    if (cls) {
      // container-style members: fqn `T.name` at module level in the same file or package directory
      const want = `${cls.fqn}.${name}`;
      const inFile = (this.fileSymbols.get(cls.file) ?? []).filter((s) => s.fqn === want && s.parent === moduleId(cls.file));
      if (inFile.length) return inFile;
      if (PACKAGE_DIR_LANGS.has(this.langOfFile.get(cls.file) ?? '')) {
        const out: SymbolRow[] = [];
        for (const f of this.scopeFiles(cls.file)) {
          if (f === cls.file) continue;
          for (const s of this.fileSymbols.get(f) ?? []) if (s.fqn === want && s.parent === moduleId(f)) out.push(s);
        }
        if (out.length) return out;
      }
    }
    for (const sup of this.supers.get(classId) ?? []) {
      const r = this.member(sup, name, seen);
      if (r.length) return r;
    }
    return [];
  }

  private childrenOfAll(parentId: string): SymbolRow[] {
    const out: SymbolRow[] = [];
    for (const arr of this.childrenOf(parentId).values()) out.push(...arr);
    return out;
  }

  private enclosingClass(scopeId: string): SymbolRow | null {
    let cur: SymbolRow | undefined | null = this.symbolById.get(scopeId);
    while (cur) {
      if (CLASS_KINDS.has(cur.kind) && cur.kind !== 'namespace') return cur;
      if ((cur.kind === 'method' || cur.kind === 'constructor') && cur.fqn.includes('.')) {
        // out-of-class definition (`void Repo::save()`) or container-style method: derive the class from the fqn prefix
        const prefix = cur.fqn.slice(0, cur.fqn.lastIndexOf('.'));
        const cls = (this.fileSymbols.get(cur.file) ?? []).find((s) => s.fqn === prefix && CLASS_KINDS.has(s.kind) && s.kind !== 'namespace') ?? (this.anyByName.get(prefix.slice(prefix.lastIndexOf('.') + 1)) ?? []).find((s) => CLASS_KINDS.has(s.kind) && s.kind !== 'namespace' && s.fqn === prefix);
        if (cls) return cls;
      }
      // JS object-augmentation containers (`app.use = function`) live as methods whose fqn prefix is a plain variable
      if (!cur.parent) return null;
      cur = this.symbolById.get(cur.parent);
    }
    return null;
  }

  /** Go-style methods carry their type as a container prefix (`T.Method`) rather than a parent class. */
  private containerClass(scopeId: string): SymbolRow | null {
    const scope = this.symbolById.get(scopeId);
    if (!scope || !scope.fqn.includes('.')) return null;
    const container = scope.fqn.slice(0, scope.fqn.lastIndexOf('.'));
    const hit = this.fileSymbols.get(scope.file)?.find((s) => s.fqn === container && CLASS_KINDS.has(s.kind));
    if (hit) return hit;
    for (const s of this.anyByName.get(container.slice(container.lastIndexOf('.') + 1)) ?? []) if (CLASS_KINDS.has(s.kind) && familyOf(this.langOfFile.get(s.file) ?? '') === familyOf(this.langOfFile.get(scope.file) ?? '')) return s;
    return null;
  }

  private ancestors(scopeId: string): SymbolRow[] {
    const out: SymbolRow[] = [];
    let cur: SymbolRow | undefined = this.symbolById.get(scopeId);
    while (cur) {
      out.push(cur);
      if (!cur.parent) break;
      cur = this.symbolById.get(cur.parent);
    }
    return out;
  }

  // ---------------------------------------------------------------- imports

  private resolveImportTarget(file: string, lang: LanguageSupport, imp: ImportRow): string | null {
    const names = JSON.parse(imp.names) as { name: string; alias: string }[];
    if (lang.id === 'csharp') return this.csharpImportTarget(file, imp, names);
    const candidates = lang.resolveModule(imp.source, file, { source: imp.source, names, namespace: !!imp.namespace, alias: imp.alias, kind: imp.kind, line: imp.line, relativeLevel: imp.relative_level }, this.project);
    for (const c of candidates) {
      // Swift `import <Target>`: the target's files, not a path on disk.
      if (c.startsWith(SWIFT_TARGET_PREFIX)) {
        const hit = (this.swiftTargetFiles.get(c.slice(SWIFT_TARGET_PREFIX.length)) ?? []).find((f) => f !== file);
        if (hit) return hit;
        continue;
      }
      if (c === file) continue;
      if (this.project.hasFile(c)) return c;
    }
    return null;
  }

  /** Representative file for a C# `using`: a file of the namespace, or the file declaring the type. */
  private csharpImportTarget(file: string, imp: ImportRow, names: { name: string; alias: string }[]): string | null {
    const src = imp.source.replace(/::/g, '.');
    if (!imp.namespace) {
      // `using static X.Y.Z`
      const fqn = src ? `${src}.${names[0]?.name ?? ''}` : (names[0]?.name ?? '');
      return (this.csByFqn.get(fqn) ?? []).find((s) => s.file !== file)?.file ?? null;
    }
    if (imp.alias) return (this.csByFqn.get(src) ?? []).find((s) => s.file !== file)?.file ?? null;
    return (this.nsFiles.get(src) ?? []).find((f) => f !== file) ?? null;
  }

  private bindImports(file: string, lang: LanguageSupport, imports: ImportRow[], edges: Edge[], dryRun = false): { bindings: Map<string, Binding>; resolved: number; usings: string[] } {
    const bindings = new Map<string, Binding>();
    const usings: string[] = [];
    const upd = this.store.prep('UPDATE imports SET resolved = ? WHERE rowid = ?');
    let resolved = 0;
    // C#: a file sees its own namespace (and the enclosing ones) without any `using`, and those
    // bind before every `using`, matching how the compiler resolves a simple name.
    if (lang.id === 'csharp') for (const ns of this.fileNamespaces(file)) this.bindNamespaceMembers(ns, file, bindings);
    const jvm = familyOf(lang.id) === 'jvm';
    for (const imp of imports) {
      let target = imp.resolved !== null && dryRun ? imp.resolved : this.resolveImportTarget(file, lang, imp);
      // JVM: a file name need not match the type it declares (`Models.kt` holding `Assignment`),
      // so fall back to the package index before giving up on the import.
      if (!target && jvm) target = this.jvmImportTarget(file, imp);
      if (!dryRun) upd.run(target, imp.rowid);
      imp.resolved = target;
      if (!target) {
        if (imp.namespace && !imp.alias && (lang.id === 'cpp' || lang.id === 'c')) usings.push(imp.source.replace(/::/g, '.'));
        if (lang.id === 'csharp') this.bindCsharpUsing(file, imp, bindings, usings, null);
        // External package: remember its aliases so references through them are not reported as ambiguous.
        const names0 = JSON.parse(imp.names) as { name: string; alias: string }[];
        const aliases = [imp.alias, ...names0.map((n) => n.alias || n.name)].filter(Boolean);
        if (!aliases.length && imp.source && lang.id === 'python') aliases.push(imp.source.split('.')[0]!);
        for (const a of aliases) if (!bindings.has(a)) bindings.set(a, { kind: 'external' });
        continue;
      }
      resolved++;
      edges.push({ src: moduleId(file), dst: moduleId(target), kind: 'imports', file, line: imp.line, resolver: 'import', confidence: imp.kind === 'type' ? 0.9 : 1 });
      const names = JSON.parse(imp.names) as { name: string; alias: string }[];
      const targetSyms = this.fileSymbols.get(target) ?? [];
      if (imp.namespace || (!names.length && imp.alias)) {
        const alias = imp.alias || imp.source;
        if (alias) {
          bindings.set(alias, { kind: 'module', file: target });
          // python `import a.b.c` binds `a` and the full dotted path
          if (imp.source.includes('.') && lang.id === 'python') {
            bindings.set(imp.source, { kind: 'module', file: target });
            const head = imp.source.split('.')[0]!;
            if (!bindings.has(head)) bindings.set(head, { kind: 'module', file: target });
          }
        }
      }
      if (imp.namespace && !imp.alias && jvm) this.bindJvmWildcard(file, imp, bindings, edges);
      if (imp.namespace && !imp.alias && (lang.id === 'bash' || lang.id === 'elixir' || lang.id === 'python' || lang.id === 'solidity')) {
        // wildcard import: bind every top-level symbol of the target by name
        for (const s0 of targetSyms) if (s0.kind !== 'module' && s0.parent === target && !bindings.has(s0.name)) bindings.set(s0.name, { kind: 'symbol', ids: [s0.id] });
      }
      for (const n of names) {
        const alias = n.alias || n.name;
        if (n.name === 'default') {
          const def = this.defaultExport(target);
          if (def.length) bindings.set(alias, { kind: 'symbol', ids: def.map((s) => s.id) });
          else bindings.set(alias, { kind: 'module', file: target });
          continue;
        }
        const matches = targetSyms.filter((s) => s.kind !== 'module' && s.name === n.name && s.parent === target);
        if (matches.length) {
          bindings.set(alias, { kind: 'symbol', ids: matches.map((s) => s.id) });
          continue;
        }
        if (jvm || lang.id === 'csharp') {
          // static import / nested member: `import static a.b.C.m` binds m through class C
          const cls = imp.source.slice(imp.source.lastIndexOf('.') + 1);
          const owner = targetSyms.find((s) => s.name === cls && s.parent === target && CLASS_KINDS.has(s.kind));
          const mem = owner ? this.member(owner.id, n.name) : [];
          if (mem.length) {
            bindings.set(alias, { kind: 'symbol', ids: mem.map((s) => s.id) });
            continue;
          }
        }
        if (jvm) {
          // `import a.b.C` / `import static a.b.C.m` / `import a.b.topLevelFn`, looked up by
          // package rather than by file name.
          const full = imp.source.endsWith('.' + n.name) ? imp.source : `${imp.source}.${n.name}`;
          const rows = this.jvmLookup(full);
          if (rows.length) {
            bindings.set(alias, { kind: 'symbol', ids: rows.slice(0, NS_IDS_CAP).map((s) => s.id) });
            continue;
          }
        }
        // python: `from pkg import submodule`
        if (lang.id === 'python') {
          const base = target.endsWith('/__init__.py') ? target.slice(0, -'/__init__.py'.length) : target.replace(/\.py$/, '');
          for (const c of [`${base}/${n.name}.py`, `${base}/${n.name}/__init__.py`]) {
            if (this.project.hasFile(c)) {
              bindings.set(alias, { kind: 'module', file: c });
              edges.push({ src: moduleId(file), dst: moduleId(c), kind: 'imports', file, line: imp.line, resolver: 'import', confidence: 1 });
              break;
            }
          }
          if (bindings.has(alias)) continue;
          // re-exported through __init__: search transitively one level
          const reexp = this.followReexport(target, n.name, new Set());
          if (reexp.length) bindings.set(alias, { kind: 'symbol', ids: reexp.map((s) => s.id) });
        } else {
          const reexp = this.followReexport(target, n.name, new Set());
          if (reexp.length) bindings.set(alias, { kind: 'symbol', ids: reexp.map((s) => s.id) });
        }
      }
      if (lang.id === 'csharp') this.bindCsharpUsing(file, imp, bindings, usings, edges);
    }
    if (lang.id === 'csharp') {
      // Lowest precedence: `global using` directives declared elsewhere in the same project.
      for (const g of this.globalUsings) {
        if (g.file === file || !(g.dir === '' || file.startsWith(g.dir + '/'))) continue;
        this.bindCsharpUsing(file, g.imp, bindings, usings, null);
      }
    }
    return { bindings, resolved, usings };
  }

  /**
   * Apply one C# `using` to a file's bindings: a plain `using X.Y;` binds every exported top-level
   * symbol of the namespace (and adds `imports` edges to its files), `using F = X.Y.Z;` binds the
   * alias to the type, `using static X.Y.Z;` binds the type's members. Earlier bindings win, so
   * the file's own namespace (bound first) shadows a `using`.
   */
  private bindCsharpUsing(file: string, imp: ImportRow, bindings: Map<string, Binding>, usings: string[], edges: Edge[] | null): void {
    const src = imp.source.replace(/::/g, '.');
    const names = JSON.parse(imp.names) as { name: string; alias: string }[];
    if (!imp.namespace) {
      const member = names[0]?.name;
      if (!member) return;
      const owner = (this.csByFqn.get(src ? `${src}.${member}` : member) ?? [])[0];
      if (!owner) return;
      bindings.set(member, { kind: 'symbol', ids: [owner.id] });
      for (const [name, rows] of this.childrenOf(owner.id)) {
        if (bindings.has(name)) continue;
        const ids = rows.filter((r) => r.exported && r.kind !== 'module').map((r) => r.id);
        if (ids.length) bindings.set(name, { kind: 'symbol', ids: ids.slice(0, NS_IDS_CAP) });
      }
      return;
    }
    if (imp.alias) {
      const rows = this.csByFqn.get(src);
      if (rows?.length) bindings.set(imp.alias, { kind: 'symbol', ids: rows.slice(0, NS_IDS_CAP).map((r) => r.id) });
      return;
    }
    usings.push(src);
    this.bindNamespaceMembers(src, file, bindings);
    if (!edges) return;
    let n = 0;
    for (const f of this.nsFiles.get(src) ?? []) {
      if (f === file || f === imp.resolved) continue;
      if (++n > NS_EDGE_CAP) break;
      edges.push({ src: moduleId(file), dst: moduleId(f), kind: 'imports', file, line: imp.line, resolver: 'import', confidence: 1 });
    }
  }

  /** Bind every exported top-level symbol of a C# namespace by its simple name. */
  private bindNamespaceMembers(ns: string, file: string, bindings: Map<string, Binding>): void {
    const members = this.nsMembers.get(ns);
    if (!members) return;
    const byName = new Map<string, string[]>();
    for (const s of members) {
      if (s.file === file) continue;
      let a = byName.get(s.name);
      if (!a) byName.set(s.name, (a = []));
      if (a.length < NS_IDS_CAP) a.push(s.id);
    }
    for (const [name, ids] of byName) if (!bindings.has(name)) bindings.set(name, { kind: 'symbol', ids });
  }

  /** Namespaces a C# file declares, plus their enclosing namespaces (`A.B` also sees `A`). */
  private fileNamespaces(file: string): string[] {
    const out: string[] = [];
    for (const s of this.fileSymbols.get(file) ?? []) {
      if (s.kind !== 'namespace') continue;
      const parts = s.fqn.split('.');
      for (let i = parts.length; i >= 1; i--) {
        const ns = parts.slice(0, i).join('.');
        if (!out.includes(ns)) out.push(ns);
      }
    }
    return out;
  }

  /** Namespace prefixes visible from a scope: enclosing namespaces (block or file-scoped) and `using` directives. */
  private namespaceCandidates(scopeId: string, usings: string[]): string[] {
    const out = new Set<string>(usings);
    const scope = this.symbolById.get(scopeId);
    if (scope) {
      const parts = scope.fqn.split('.');
      for (let i = parts.length - 1; i >= 1; i--) out.add(parts.slice(0, i).join('.'));
      for (const a of this.ancestors(scopeId)) if (a.kind === 'namespace') out.add(a.fqn);
    }
    return [...out];
  }

  /** The symbol a module's default export refers to (JS `module.exports = X`, `export default`), following re-exports. */
  private defaultExport(file: string, seen = new Set<string>()): SymbolRow[] {
    if (seen.has(file) || seen.size > 6) return [];
    seen.add(file);
    const syms = this.fileSymbols.get(file) ?? [];
    const de = syms.find((s) => s.kind !== 'module' && (s.name === 'module.exports' || (s.meta ?? '').includes('default_export')));
    if (de) {
      const alias = de.meta ? (JSON.parse(de.meta) as { alias_of?: string }).alias_of : undefined;
      if (alias) {
        const local = syms.filter((s) => s.name === alias && s.parent === file);
        if (local.length) return local;
        // alias of an imported name
        const imps = this.importsByFile.get(file) ?? [];
        for (const imp of imps) {
          const names = JSON.parse(imp.names) as { name: string; alias: string }[];
          const hit = names.find((n) => (n.alias || n.name) === alias);
          if (!hit || !imp.resolved) continue;
          return hit.name === 'default' ? this.defaultExport(imp.resolved, seen) : this.followReexport(imp.resolved, hit.name, new Set());
        }
      }
      return [de];
    }
    const imps = (this.importsByFile.get(file) ?? []).filter((i) => i.kind === 'reexport' && i.namespace && !i.alias);
    for (const imp of imps) {
      const lang = languageById(this.langOfFile.get(file) ?? '');
      const target = imp.resolved ?? (lang ? this.resolveImportTarget(file, lang, imp) : null);
      if (!target) continue;
      const r = this.defaultExport(target, seen);
      if (r.length) return r;
    }
    return [];
  }

  /** Follow `from .x import name` / `export { name } from './x'` chains inside `file` to find the real definition. */
  private followReexport(file: string, name: string, seen: Set<string>): SymbolRow[] {
    if (seen.has(file) || seen.size > 6) return [];
    const memoKey = `${file}\u0000${name}`;
    const memo = this.reexportMemo.get(memoKey);
    if (memo && seen.size === 0) return memo;
    seen.add(file);
    const direct = this.childrenOf(moduleId(file)).get(name)?.filter((s) => s.kind !== 'module') ?? [];
    if (direct.length) {
      this.reexportMemo.set(memoKey, direct);
      return direct;
    }
    const lang = languageById(this.langOfFile.get(file) ?? '');
    if (!lang) return [];
    const imps = this.importsByFile.get(file) ?? [];
    for (const imp of imps) {
      const names = JSON.parse(imp.names) as { name: string; alias: string }[];
      const hit = names.find((n) => (n.alias || n.name) === name);
      const star = imp.namespace && !imp.alias; // `from x import *` / `export * from`
      if (!hit && !star) continue;
      const target = imp.resolved ?? this.resolveImportTarget(file, lang, imp);
      if (!target) continue;
      const r = this.followReexport(target, hit ? hit.name : name, seen);
      if (r.length) {
        if (seen.size <= 1) this.reexportMemo.set(memoKey, r);
        return r;
      }
    }
    if (seen.size <= 1) this.reexportMemo.set(memoKey, []);
    return [];
  }

  // ---------------------------------------------------------------- names

  /** Drop `impl` blocks when a real definition with the same name is present. */
  private preferDefinitions(rows: SymbolRow[]): SymbolRow[] {
    if (rows.length < 2) return rows;
    const real = rows.filter((s) => !(s.meta && s.meta.includes('"impl":true')));
    return real.length ? real : rows;
  }

  private lookupScopeChain(name: string, scopeId: string, file: string, skipModule = false): SymbolRow[] {
    // innermost first; skip class-like levels for bare names (members need a receiver)
    for (const anc of this.ancestors(scopeId)) {
      if (CLASS_KINDS.has(anc.kind)) continue;
      const hit = this.childrenOf(anc.id).get(name);
      if (hit?.length) return hit;
    }
    if (skipModule) return [];
    const top = this.childrenOf(moduleId(file)).get(name);
    if (top?.length) return top;
    // object-augmentation style `app.x` defined at module level with container prefix: fqn == name
    return [];
  }

  /**
   * Implicit-receiver member lookup for IMPLICIT_SELF_LANGS: a bare `helper()` inside a method binds
   * to a member of the enclosing class (walking inheritance), then of any outer class, then of an
   * enclosing namespace/module (Ruby `module` methods, C++ namespace functions). Out-of-class
   * definitions (`void Repo::save()`) and container-style methods reach their class through
   * `enclosingClass` / `containerClass`. Returns the rows and whether they came through a class.
   */
  private lookupImplicitMember(name: string, scopeId: string, kind: ReferenceKind): { rows: SymbolRow[]; viaClass: boolean } {
    const filterByKind = (rows: SymbolRow[]): SymbolRow[] => {
      if (kind === 'call') {
        const callable = rows.filter((s) => CALLABLE_KINDS.has(s.kind));
        return callable.length ? callable : rows;
      }
      if (kind === 'value' || kind === 'mention') return rows.filter((s) => PASSABLE_KINDS.has(s.kind));
      if (kind === 'type' || kind === 'extends' || kind === 'implements' || kind === 'new') return rows.filter((s) => CLASS_KINDS.has(s.kind) || s.kind === 'type_alias');
      return rows;
    };
    const seen = new Set<string>();
    const containers: SymbolRow[] = [];
    const first = this.enclosingClass(scopeId) ?? this.containerClass(scopeId);
    if (first) containers.push(first);
    for (const anc of this.ancestors(first ? first.id : scopeId)) if (CLASS_KINDS.has(anc.kind)) containers.push(anc);
    for (const c of containers) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      const rows = filterByKind(this.preferDefinitions(this.member(c.id, name)));
      if (rows.length) return { rows, viaClass: c.kind !== 'namespace' };
    }
    return { rows: [], viaClass: false };
  }

  private resolveBare(name: string, scopeId: string, file: string, bindings: Map<string, Binding>, kind: ReferenceKind, lang: string, usings: string[] = []): Resolution | { candidates: SymbolRow[] } | External | null {
    const implicitSelf = IMPLICIT_SELF_LANGS.has(lang);
    let local = this.preferDefinitions(this.lookupScopeChain(name, scopeId, file, implicitSelf));
    if (local.length) return { ids: local.map((s) => s.id), resolver: 'scope', confidence: 1 };
    if (implicitSelf) {
      // enclosing class (own or inherited) beats a same-file free function, as the language's own lookup does
      const mem = this.lookupImplicitMember(name, scopeId, kind);
      if (mem.rows.length) return { ids: mem.rows.map((s) => s.id), resolver: mem.viaClass ? 'receiver' : 'scope', confidence: mem.viaClass ? 0.95 : 1 };
      local = this.preferDefinitions(this.childrenOf(moduleId(file)).get(name) ?? []);
      if (local.length) return { ids: local.map((s) => s.id), resolver: 'scope', confidence: 1 };
    }
    if (PACKAGE_DIR_LANGS.has(lang)) {
      const pkg = this.preferDefinitions(this.packageMembers(file, name, this.testFiles.has(file)));
      if (pkg.length) return { ids: pkg.map((s) => s.id), resolver: 'scope', confidence: 0.95 };
    }
    const b = bindings.get(name);
    if (b) {
      if (b.kind === 'external') return EXTERNAL;
      if (b.kind === 'symbol' && b.ids?.length) return { ids: b.ids, resolver: 'import', confidence: 1 };
      if (b.kind === 'module' && b.file) {
        if (kind === 'call' || kind === 'new') {
          const de = this.defaultExport(b.file);
          if (de.length) return { ids: de.map((s) => s.id), resolver: 'import', confidence: 1 };
        }
        return { ids: [moduleId(b.file)], resolver: 'import', confidence: 1 };
      }
    }
    if (BUILTINS[lang]?.has(name)) return EXTERNAL;
    // namespace-qualified lookup: `using Acme.Models;` / enclosing `namespace Acme.Models` + `User`
    if (lang === 'csharp' || lang === 'cpp' || lang === 'c') {
      const ns = this.namespaceCandidates(scopeId, usings);
      if (ns.length) {
        const pool = (this.anyByName.get(name) ?? []).filter((s) => s.file !== file && ns.some((n) => s.fqn === `${n}.${name}`));
        const defs = this.preferDefinitions(pool.filter((s) => !(s.meta ?? '').includes('"prototype":true')));
        const pick = defs.length ? defs : pool;
        if (pick.length === 1) return { ids: [pick[0]!.id], resolver: 'import', confidence: 0.95 };
        if (pick.length > 1) return { ids: pick.map((s) => s.id), resolver: 'import', confidence: 0.8 };
      }
    }
    // bare identifiers passed as values are too ambiguous for corpus-wide binding
    if (kind === 'value' || kind === 'mention') {
      if (kind === 'mention') {
        const ex0 = (this.exportedByName.get(name) ?? []).filter((s) => s.file !== file);
        if (ex0.length === 1 && name.length >= 4) return { ids: [ex0[0]!.id], resolver: 'unique', confidence: 0.7 };
      }
      // A callable passed by name across files (`register("err", report_error)` with the function in
      // another compilation unit): bind only when exactly one exported callable in the family has
      // the name, or one of them lives in a file this file imports. Never a data value.
      if (kind === 'value' && !COMMON_MEMBER_NAMES.has(name) && name.length >= 4) {
        const fam = familyOf(lang);
        const fns = (this.exportedByName.get(name) ?? []).filter((s) => PASSABLE_KINDS.has(s.kind) && s.file !== file && familyOf(this.langOfFile.get(s.file) ?? '') === fam && !(s.meta ?? '').includes('"prototype":true'));
        if (fns.length === 1) return { ids: [fns[0]!.id], resolver: 'unique', confidence: 0.7 };
        if (fns.length > 1) {
          const importedFiles = new Set<string>();
          for (const bb of bindings.values()) {
            if (bb.file) importedFiles.add(bb.file);
            for (const id of bb.ids ?? []) importedFiles.add(this.symbolById.get(id)?.file ?? '');
          }
          const viaImport = fns.filter((s) => importedFiles.has(s.file));
          if (viaImport.length === 1) return { ids: [viaImport[0]!.id], resolver: 'heuristic', confidence: 0.6 };
        }
      }
      return null;
    }
    if (COMMON_MEMBER_NAMES.has(name) || name.length < 4) return null;
    // unique exported symbol in the corpus, same language family
    const fam = familyOf(lang);
    const ex = (this.exportedByName.get(name) ?? []).filter((s) => familyOf(this.langOfFile.get(s.file) ?? '') === fam && s.file !== file);
    const wantClass = kind === 'type' || kind === 'extends' || kind === 'implements' || kind === 'new';
    const filtered = wantClass ? ex.filter((s) => CLASS_KINDS.has(s.kind) || s.kind === 'type_alias' || s.kind === 'class') : kind === 'call' ? ex.filter((s) => CALLABLE_KINDS.has(s.kind)) : ex;
    const pool0 = filtered.length ? filtered : ex;
    const defsOnly = pool0.filter((s) => !(s.meta ?? '').includes('"prototype":true'));
    const pool = defsOnly.length ? defsOnly : pool0;
    if (pool.length === 1) return { ids: [pool[0]!.id], resolver: 'unique', confidence: 0.7 };
    if (pool.length > 1) {
      // prefer a file this file imports, or a sibling in the same directory
      const importedFiles = new Set<string>();
      for (const bb of bindings.values()) {
        if (bb.file) importedFiles.add(bb.file);
        for (const id of bb.ids ?? []) importedFiles.add(this.symbolById.get(id)?.file ?? '');
      }
      const viaImport = pool.filter((s) => importedFiles.has(s.file));
      if (viaImport.length === 1) return { ids: [viaImport[0]!.id], resolver: 'heuristic', confidence: 0.6 };
      const dir = file.slice(0, file.lastIndexOf('/') + 1);
      const sib = pool.filter((s) => s.file.startsWith(dir));
      if (sib.length === 1) return { ids: [sib[0]!.id], resolver: 'heuristic', confidence: 0.5 };
      return { candidates: pool.slice(0, 8) };
    }
    return null;
  }

  /** Resolve a type name (used for receiver typing) to a class-like symbol id, or null. */
  private resolveTypeName(type: string, scopeId: string, file: string, bindings: Map<string, Binding>, lang: string): string | null {
    const t = type.includes('.') ? type.slice(type.lastIndexOf('.') + 1) : type;
    const qual = type.includes('.') ? type.slice(0, type.lastIndexOf('.')) : '';
    if (qual) {
      const b = bindings.get(qual);
      if (b?.kind === 'external') return null;
      if (b?.kind === 'module' && b.file) {
        const hit = this.childrenOf(moduleId(b.file)).get(t)?.find((s) => CLASS_KINDS.has(s.kind));
        return hit ? hit.id : null;
      }
    }
    const r = this.resolveBare(t, scopeId, file, bindings, 'type', lang);
    if (r && 'ids' in r) {
      for (const id of r.ids) {
        const s = this.symbolById.get(id);
        if (s && CLASS_KINDS.has(s.kind)) return id;
      }
      // container-like tables/objects (Lua modules, JS object APIs) act as receiver types
      for (const id of r.ids) {
        const s = this.symbolById.get(id);
        if (s && (s.kind === 'variable' || s.kind === 'constant') && this.childrenOf(id).size > 0) return id;
      }
      // type alias to a class? give up
    }
    return null;
  }

  private receiverType(qualifier: string, scopeId: string, file: string, localTypes: LocalTypeRow[], lang: string): string | null {
    // exact match of a local/param/field fact visible from this scope
    const ancIds = new Set(this.ancestors(scopeId).map((a) => a.id));
    ancIds.add(moduleId(file));
    let best: LocalTypeRow | null = null;
    for (const lt of localTypes) {
      if (lt.name !== qualifier) continue;
      if (ancIds.has(lt.scope)) {
        best = lt; // later facts override earlier ones in walk order
      }
    }
    if (best) return best.type;
    // bare field of the enclosing class (or an ancestor): `session.close()` inside a method
    if (/^\w+$/.test(qualifier)) {
      const cls0 = this.enclosingClass(scopeId);
      if (cls0) {
        const fld = this.member(cls0.id, qualifier).find((s) => s.declared_type);
        if (fld?.declared_type) return fld.declared_type;
      }
    }
    // `this.x` / `self.x` / `@x` / `recv.x`: field declared in the enclosing class with a type
    let m = qualifier.match(/^(?:(?:this|self)\.|@)(\w+)$/);
    if (!m) {
      const hm = qualifier.match(/^(\w+)\.(\w+)$/);
      if (hm) {
        const cls0 = this.enclosingClass(scopeId) ?? this.containerClass(scopeId);
        const headType = this.receiverType(hm[1]!, scopeId, file, localTypes, lang);
        if (cls0 && headType && (headType === cls0.name || headType.endsWith('.' + cls0.name))) m = hm.slice(1) as unknown as RegExpMatchArray;
      }
    }
    if (m) {
      const cls = this.enclosingClass(scopeId) ?? this.containerClass(scopeId);
      if (cls) {
        const fld = this.member(cls.id, m[1]!).find((s) => s.declared_type);
        if (fld?.declared_type) return fld.declared_type;
        // constructor assignment fact stored with name `self.x`
        for (const lt of localTypes) if (lt.name === qualifier) return lt.type;
        // `self.x = x` in a constructor where `x` is a typed parameter: reuse the parameter's type
        const memberIds = new Set(this.childrenOfAll(cls.id).map((s) => s.id));
        for (const lt of localTypes) if (lt.name === m[1] && memberIds.has(lt.scope)) return lt.type;
      }
    }
    // module-level variable with declared type
    const top = this.childrenOf(moduleId(file)).get(qualifier)?.find((s) => s.declared_type);
    if (top?.declared_type) return top.declared_type;
    void lang;
    return null;
  }

  private resolveQualified(ref: RefRow, file: string, bindings: Map<string, Binding>, localTypes: LocalTypeRow[], lang: string): Resolution | { candidates: SymbolRow[] } | External | null {
    const q = ref.qualifier;
    const name = ref.name;
    // self / this / cls / super
    if (SELF_NAMES.has(q)) {
      const cls = this.enclosingClass(ref.scope) ?? this.containerClass(ref.scope);
      if (cls) {
        const hits = q === 'super' || q === 'parent' ? (this.supers.get(cls.id) ?? []).flatMap((s) => this.member(s, name)) : this.member(cls.id, name);
        if (hits.length) return { ids: hits.map((s) => s.id), resolver: 'receiver', confidence: 1 };
        return null; // dynamic attribute: not an error worth listing
      }
      // `app.use = function () { this.lazyrouter() }`: the container is a plain object, not a class
      const scope = this.symbolById.get(ref.scope);
      const container = scope && scope.fqn.includes('.') ? scope.fqn.slice(0, scope.fqn.lastIndexOf('.')) : '';
      if (container) {
        const hit = this.fileSymbols.get(file)?.filter((s) => s.fqn === `${container}.${name}`);
        if (hit?.length) return { ids: hit.map((s) => s.id), resolver: 'scope', confidence: 0.9 };
      }
      return null;
    }
    // module alias: `ns.func` / `pkg.sub.Class`
    const b = bindings.get(q) ?? bindings.get(q.split(/[.:]/)[0]!);
    if (b?.kind === 'external') return EXTERNAL;
    if (b && bindings.has(q)) {
      if (b.kind === 'module' && b.file) {
        const hit = this.childrenOf(moduleId(b.file)).get(name);
        if (hit?.length) return { ids: hit.map((s) => s.id), resolver: 'import', confidence: 1 };
        if (PACKAGE_DIR_LANGS.has(lang)) {
          const pkg = this.packageMembers(b.file, name, false).concat(this.childrenOf(moduleId(b.file)).get(name) ?? []);
          if (pkg.length) return { ids: pkg.map((s) => s.id), resolver: 'import', confidence: 1 };
        }
        const re = this.followReexport(b.file, name, new Set());
        if (re.length) return { ids: re.map((s) => s.id), resolver: 'import', confidence: 1 };
        return null; // external or missing member of a known module
      }
      if (b.kind === 'symbol' && b.ids?.length) {
        const hits = b.ids.flatMap((id) => this.member(id, name));
        if (hits.length) return { ids: hits.map((s) => s.id), resolver: 'import', confidence: 1 };
        return null;
      }
    }
    // same-file container: class static member, nested member, or object-augmentation (`app.use`)
    const qd = q.replace(/::/g, '.');
    const direct = this.fileSymbols.get(file)?.filter((s) => s.fqn === `${qd}.${name}`);
    if (direct?.length) return { ids: direct.map((s) => s.id), resolver: 'scope', confidence: 1 };
    const localQ = this.lookupScopeChain(q, ref.scope, file);
    const container = (localQ.length ? localQ : PACKAGE_DIR_LANGS.has(lang) ? this.packageMembers(file, q, this.testFiles.has(file)) : []).find((s) => CLASS_KINDS.has(s.kind) || s.kind === 'constant' || s.kind === 'variable');
    if (container) {
      const hits = this.member(container.id, name);
      if (hits.length) return { ids: hits.map((s) => s.id), resolver: 'scope', confidence: 1 };
      if (container.declared_type) {
        const cid = this.resolveTypeName(container.declared_type, ref.scope, file, bindings, lang);
        if (cid) {
          const h2 = this.member(cid, name);
          if (h2.length) return { ids: h2.map((s) => s.id), resolver: 'receiver', confidence: 0.9 };
        }
      }
    }
    // receiver-typed local: `client.send()` where client: Client
    const t = this.receiverType(q, ref.scope, file, localTypes, lang);
    if (t) {
      const cid = this.resolveTypeName(t, ref.scope, file, bindings, lang);
      if (cid) {
        const hits = this.member(cid, name);
        if (hits.length) return { ids: hits.map((s) => s.id), resolver: 'receiver', confidence: 0.9 };
        return null; // known type, member not declared here (embedded/inherited from outside)
      }
      if (!(this.anyByName.get(simpleName(t)) ?? []).some((s) => CLASS_KINDS.has(s.kind))) return null; // external type
    }
    // dotted qualifier whose head is a module alias: `a.b.C.method`
    if (q.includes('.')) {
      const head = q.split('.')[0]!;
      const hb = bindings.get(head);
      if (hb?.kind === 'module' && hb.file) {
        // try `rest` as a symbol fqn in that module
        const rest = q.slice(head.length + 1);
        const hit = this.fileSymbols.get(hb.file)?.filter((s) => s.fqn === `${rest}.${name}`);
        if (hit?.length) return { ids: hit.map((s) => s.id), resolver: 'import', confidence: 1 };
        return null;
      }
      if (this.isExternalQualifier(q, bindings)) return null;
    }
    // chained call / literal receiver: skip silently
    if (/[()\[\]"'`{}]/.test(q)) return null;
    // exact `Container.name` anywhere in the corpus (docs mentions, same-package references).
    // Only for a qualifier we could NOT account for locally: when `q` is a local, a parameter or
    // an imported binding, its member simply is not something we indexed, and matching the name
    // in an unrelated file is a wrong answer, not a weak one (express's `app.get` would bind to
    // some object literal's `get` elsewhere in the corpus).
    const qualifierKnown = localQ.length > 0 || bindings.has(q) || bindings.has(q.split(/[.:]/)[0]!);
    if (!qualifierKnown) {
      const tail = qd.includes('.') ? qd.slice(qd.lastIndexOf('.') + 1) : qd;
      const fam = familyOf(lang);
      // A lowercase tail is a variable or a module alias, not a type name: much weaker evidence.
      const looksLikeVariable = /^[a-z_$]/.test(tail);
      // A local variable is conventionally the lowerCamel spelling of its class (`$route` of
      // `Route`, `$route` of `Route<...>`): match case-insensitively in that case so the spelling
      // difference alone does not hide the one class in the corpus the name obviously refers to.
      const qdKey = looksLikeVariable ? qd.toLowerCase() : qd;
      const tailKey = looksLikeVariable ? tail.toLowerCase() : tail;
      const nameKey = looksLikeVariable ? name.toLowerCase() : name;
      const exact = (this.anyByName.get(name) ?? []).filter((s) => {
        const fqn = looksLikeVariable ? s.fqn.toLowerCase() : s.fqn;
        return (fqn === `${qdKey}.${nameKey}` || fqn.endsWith(`.${tailKey}.${nameKey}`) || fqn === `${tailKey}.${nameKey}`) && (lang === 'markdown' || familyOf(this.langOfFile.get(s.file) ?? '') === fam);
      });
      if (exact.length === 1) return looksLikeVariable ? { ids: [exact[0]!.id], resolver: 'heuristic', confidence: 0.6 } : { ids: [exact[0]!.id], resolver: 'unique', confidence: 0.8 };
      if (exact.length > 1 && exact.length <= 8) return { candidates: exact };
    }
    // last resort: unique method name corpus-wide (same family). Common names (`run`, `get`, ...)
    // are gated out of the *candidate-set* path below — with dozens of `get`s in the corpus, a
    // multi-way candidate set is noise, not a weak lead. But when the corpus-wide pool for that
    // name in this language family happens to contain exactly one member, the ambiguity the gate
    // exists to avoid never arises, so the tier still applies (`$route->run($request)` binding to
    // the corpus's one `run` method is exactly this case).
    const isCommonName = COMMON_MEMBER_NAMES.has(name);
    if (isCommonName || name.length >= 4) {
      const fam = familyOf(lang);
      let pool = (this.anyByName.get(name) ?? []).filter((s) => (s.kind === 'method' || s.kind === 'property' || s.kind === 'function') && familyOf(this.langOfFile.get(s.file) ?? '') === fam);
      // For a common name, only a member actually declared on a class/struct/interface counts:
      // an object-literal method or module-level function sharing that name (`bag.get`, a loose
      // `function run() {}`) is exactly the noise the common-name gate exists to keep out. A real
      // class member is different evidence — `class Route { function run() {...} }` is the one
      // place in the whole corpus that spells out what `->run(...)` could mean.
      if (isCommonName) pool = pool.filter((s) => !!s.parent && CLASS_KINDS.has(this.symbolById.get(s.parent)?.kind as SymbolKind));
      if (pool.length === 1) return { ids: [pool[0]!.id], resolver: 'heuristic', confidence: 0.5 };
      if (!isCommonName && pool.length > 1 && pool.length <= 8) return { candidates: pool };
    }
    return null;
  }

  private isExternalQualifier(q: string, bindings: Map<string, Binding>): boolean {
    const head = q.split('.')[0]!;
    return !bindings.has(head);
  }

  // ---------------------------------------------------------------- main

  /**
   * Cheap pre-pass: resolve only extends/implements references and record them in `supers`,
   * so a single full pass afterwards sees the complete cross-file inheritance graph.
   */
  prepassSupertypes(file: string): void {
    const langId = this.langOfFile.get(file) ?? '';
    const lang = languageById(langId);
    if (!lang) return;
    const imports = this.importsByFile.get(file) ?? [];
    const refs = (this.store.prep("SELECT * FROM refs WHERE file = ? AND kind IN ('extends','implements')").all(file) as RefRow[]).sort((a, b) => a.byte - b.byte);
    if (!refs.length) return;
    const scratch: Edge[] = [];
    const { bindings, usings } = this.bindImports(file, lang, imports, scratch, true);
    for (const ref of refs) {
      const res = ref.qualifier ? this.resolveQualified(ref, file, bindings, [], langId) : this.resolveBare(ref.name, ref.scope, file, bindings, ref.kind, langId, usings);
      if (!res || !('ids' in res)) continue;
      let a = this.supers.get(ref.scope);
      if (!a) this.supers.set(ref.scope, (a = []));
      for (const id of res.ids) if (id !== ref.scope && !a.includes(id)) a.push(id);
    }
  }

  resolveFile(file: string): FileResolutionResult {
    const langId = this.langOfFile.get(file) ?? '';
    const lang = languageById(langId);
    const edges: Edge[] = [];
    const unresolved: FileResolutionResult['unresolved'] = [];
    if (!lang) return { edges, unresolved, importsResolved: 0, importsTotal: 0 };
    const imports = this.importsByFile.get(file) ?? (this.store.prep('SELECT rowid, * FROM imports WHERE file = ?').all(file) as ImportRow[]);
    const refs = this.store.prep('SELECT * FROM refs WHERE file = ? ORDER BY byte').all(file) as RefRow[];
    const localTypes = this.store.prep('SELECT scope, name, type, via FROM local_types WHERE file = ? ORDER BY rowid').all(file) as LocalTypeRow[];
    const { bindings, resolved, usings } = this.bindImports(file, lang, imports, edges);
    const isTestFile = this.testFiles.has(file);

    // supertypes first so member lookup through inheritance works within this file
    const order = (r: RefRow) => (r.kind === 'extends' || r.kind === 'implements' ? 0 : 1);
    refs.sort((a, b) => order(a) - order(b) || a.byte - b.byte);

    const seenEdge = new Set<string>();
    const push = (src: string, dst: string, kind: EdgeKind, line: number, resolver: Edge['resolver'], confidence: number) => {
      if (src === dst) return;
      const key = `${src}|${dst}|${kind}|${line}`;
      if (seenEdge.has(key)) return;
      seenEdge.add(key);
      edges.push({ src, dst, kind, file, line, resolver, confidence });
    };

    for (const ref of refs) {
      if (ref.kind === 'config') {
        const id = `env::${ref.name}`;
        if (!this.symbolById.has(id)) {
          this.store.prep("INSERT OR IGNORE INTO symbols(id, file, ordinal, kind, name, fqn, start_line, end_line, start_byte, end_byte, signature, doc, modifiers, exported, parent, declared_type, meta) VALUES(?, '', 0, 'config_key', ?, ?, 0, 0, 0, 0, ?, '', '', 1, NULL, NULL, NULL)").run(id, ref.name, `env.${ref.name}`, `env ${ref.name}`);
          this.store.prep("INSERT INTO symbols_fts(id, name, split_name, fqn, signature, doc, file) VALUES(?, ?, ?, ?, ?, '', '')").run(id, ref.name, ref.name.toLowerCase().replace(/_/g, ' '), `env ${ref.name}`, `env ${ref.name}`);
          const row = this.store.getSymbol(id)!;
          this.symbolById.set(id, row);
          let arr = this.fileSymbols.get('');
          if (!arr) this.fileSymbols.set('', (arr = []));
          arr.push(row);
        }
        push(ref.scope, id, 'reads_config', ref.line, 'structural', 1);
        continue;
      }
      let res: Resolution | { candidates: SymbolRow[] } | External | null;
      if (ref.qualifier) res = this.resolveQualified(ref, file, bindings, localTypes, langId);
      else res = this.resolveBare(ref.name, ref.scope, file, bindings, ref.kind, langId, usings);
      if (!res) {
        // The resolver has nothing at all for this reference. Dropping it silently makes a symbol
        // that is only ever reached through a duck-typed receiver, an extension method or a
        // dynamic dispatch look uncalled. Keep the call site with the definitions that share the
        // name, so `callersOf` can offer it as a candidate instead of pretending it does not exist.
        if (ref.kind === 'call' || ref.kind === 'new') {
          const cands = this.nameCandidates(ref.name, ref.scope, ref.qualifier, langId);
          if (cands.length) unresolved.push({ line: ref.line, scope: ref.scope, kind: ref.kind, name: ref.name, qualifier: ref.qualifier, candidates: cands });
        }
        continue;
      }
      // Resolved, but to something outside the repo: no edge, and no candidate set either.
      if ('external' in res) continue;
      if ('candidates' in res) {
        if (ref.kind === 'call' || ref.kind === 'new' || ref.kind === 'extends' || ref.kind === 'implements') unresolved.push({ line: ref.line, scope: ref.scope, kind: ref.kind, name: ref.name, qualifier: ref.qualifier, candidates: res.candidates.map((s) => s.id) });
        continue;
      }
      const kind0: EdgeKind = ref.kind === 'call' || ref.kind === 'new' ? 'calls' : ref.kind === 'extends' ? 'extends' : ref.kind === 'implements' ? 'implements' : ref.kind === 'decorator' ? 'decorates' : 'references';
      // A callable named in value position (`app.get('/x', handler)`, `{ "err", report_error }`,
      // `map(parse)`) is passed, not merely referenced: `passes` lets `path` and `impact` cross it.
      const kindFor = (dst: SymbolRow | undefined): EdgeKind => (ref.kind === 'value' && dst && PASSABLE_KINDS.has(dst.kind) ? 'passes' : kind0);
      if (kind0 === 'extends' || kind0 === 'implements') {
        // Record the supertype now, not on the next run: `prepassSupertypes` only runs for a full
        // resolve, so on the incremental path this is what lets `Sub.run` find `Base.helper`.
        let sup = this.supers.get(ref.scope);
        if (!sup) this.supers.set(ref.scope, (sup = []));
        for (const id of res.ids) if (id !== ref.scope && !sup.includes(id)) sup.push(id);
      }
      for (const dst of res.ids) {
        const dstSym = this.symbolById.get(dst);
        const kind = kindFor(dstSym);
        // a `new X()` / `X()` on a class binds to the class (constructor edge is implied)
        push(ref.scope, dst, kind, ref.line, res.resolver, res.confidence);
        if ((isTestFile || this.isInTest(ref.scope)) && dstSym && !this.testFiles.has(dstSym.file) && (kind === 'calls' || kind === 'references' || kind === 'passes')) {
          const t = this.enclosingTest(ref.scope) ?? ref.scope;
          push(t, dst, 'tests', ref.line, 'structural', 1);
        }
      }
    }

    // routes -> handlers
    for (const s of this.fileSymbols.get(file) ?? []) {
      if (s.kind !== 'route' || !s.meta) continue;
      const meta = JSON.parse(s.meta) as { handler?: string };
      for (const h of (meta.handler ?? '').split(',').map((x) => x.trim()).filter(Boolean)) {
        let ids: string[] = [];
        if (h.includes('.')) {
          const q = h.slice(0, h.lastIndexOf('.'));
          const n = h.slice(h.lastIndexOf('.') + 1);
          const r = this.resolveQualified({ file, line: s.start_line, byte: 0, kind: 'value', name: n, qualifier: q, scope: moduleId(file), arity: null }, file, bindings, localTypes, langId);
          if (r && 'ids' in r) ids = r.ids;
        } else {
          const r = this.resolveBare(h, moduleId(file), file, bindings, 'value', langId, usings);
          if (r && 'ids' in r) ids = r.ids;
          if (!ids.length) {
            const same = (this.fileSymbols.get(file) ?? []).filter((x) => x.name === h && (x.kind === 'method' || x.kind === 'function'));
            ids = same.map((x) => x.id);
          }
        }
        for (const id of ids) push(s.id, id, 'defines_route', s.start_line, 'structural', 1);
      }
    }

    return { edges, unresolved, importsResolved: resolved, importsTotal: imports.length };
  }

  /**
   * Definitions that share a name, as the candidate set for a reference nothing resolved. Read from
   * the in-memory `anyByName` index (this runs per reference, so a SQL query per miss would cost
   * more than the whole resolve pass). Modules are never call targets; production definitions come
   * first and test-only ones fill the tail, because a test helper is rarely the intended callee.
   */
  private nameCandidates(name: string, scope: string, qualifier: string, lang: string, max = 8): string[] {
    // A candidate set only carries information when the name itself is distinctive: a generic
    // member name (`create`, `get`), a language builtin, a `self`/`super`-style receiver, a short
    // identifier, or a name so common in the corpus that "candidates" would mean half the codebase
    // are all just noise that costs index time without ever narrowing anything down.
    if (COMMON_MEMBER_NAMES.has(name) || BUILTINS[lang]?.has(name)) return [];
    if (name.length < 4) return [];
    if (qualifier === 'super' || qualifier === 'parent' || SELF_NAMES.has(qualifier)) return [];
    const pool = this.anyByName.get(name);
    if (!pool || pool.length > 8) return [];
    const prod: string[] = [];
    const tests: string[] = [];
    for (const s of pool) {
      if (s.kind === 'module' || s.id === scope) continue;
      (this.testFiles.has(s.file) ? tests : prod).push(s.id);
      if (prod.length >= max) break;
    }
    return [...prod, ...tests].slice(0, max);
  }

  private isInTest(scopeId: string): boolean {
    return this.enclosingTest(scopeId) !== null;
  }

  private enclosingTest(scopeId: string): string | null {
    for (const a of this.ancestors(scopeId)) if (a.kind === 'test') return a.id;
    return null;
  }
}
