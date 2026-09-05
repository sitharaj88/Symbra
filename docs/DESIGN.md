# Symbra design

Symbra weaves a codebase into a live, queryable symbol graph and serves it to AI coding agents. Local-first, zero LLM, zero native compilation, one command to install.

## Principles

1. **Symbols, not strings.** Every node is a definition with a kind, a byte range, a signature, and a doc comment. Every edge records the resolver that produced it and the evidence it used.
2. **Live, not static.** The store is SQLite. Indexing is incremental per file. The MCP server reads the store directly, so an agent editing code sees the graph update under it.
3. **Answer in one call.** The primary tool returns a context pack: ranked symbols with their source, the paths between them, and the blast radius. The agent should rarely need a second call.
4. **Honest about uncertainty.** Unresolved references keep their candidate set. Nothing is guessed silently.
5. **Deterministic.** Same input, same output, same IDs, same community numbering, on every machine.

## Pipeline

```
scan -> parse (tree-sitter queries) -> IR (definitions, references, imports)
     -> store (SQLite) -> resolve (scope, import, receiver type) -> edges
     -> analyse (PageRank, communities, metrics) -> serve (CLI, MCP, HTML)
```

Each stage reads and writes the store. A file change invalidates that file's IR and the resolution of files that import it, nothing else.

## Symbol IR

```
Definition { id, fqn, kind, name, file, range, container, signature, doc, modifiers, exported }
Reference  { file, range, name, qualifier, kind (call | type | value | extends | implements | import) }
Import     { file, range, source, names[], alias, kind (static | dynamic | type) }
```

`id` is a SCIP-style descriptor: `python . . httpx/_client.py/Client#send().` Stable across edits that do not move the symbol. A separate structural fingerprint lets a later pass detect renames and moves.

Kinds: `module, namespace, class, interface, struct, enum, enum_member, trait, function, method, constructor, property, field, variable, constant, type_alias, macro, route, test`.

## Store (SQLite, WAL)

- `files(path, hash, language, size, mtime, indexed_at)`
- `symbols(id, file, kind, name, fqn, start_line, end_line, start_byte, end_byte, signature, doc, modifiers, exported, container)`
- `edges(src, dst, kind, file, line, resolver, confidence, evidence)` where kind is one of `calls, references, passes, imports, extends, implements, contains, defines_route, tests, reads_config, decorates`
- `unresolved(file, line, name, qualifier, candidates_json)`
- `symbols_fts(name, split_name, signature, doc, fqn)` FTS5 with BM25
- `metrics(symbol, pagerank, in_degree, out_degree, betweenness_est)`
- `communities(symbol, level, community, label)`

Parallel edges are kept. A `calls` edge is one call site.

## Resolution

Tiered, in order. Each edge records which tier produced it.

1. **Same scope.** A binder pass builds lexical scopes per file. Locals and parameters shadow imports.
2. **Import binding.** Module resolution per language: relative paths, `tsconfig` paths and `baseUrl`, package `exports`, Python packages and `__init__`, Go module paths, Rust `mod` and `use`, Java packages.
3. **Receiver type.** For `x.f()`, the declared type of `x` (parameter annotation, field type, constructor assignment, `new T()`) is looked up and `f` resolved on `T` and its ancestors.
4. **Unique global.** If exactly one exported definition in the corpus has the name and the language family matches, bind with `confidence = 0.7`.
5. **Candidates.** Otherwise the reference is stored in `unresolved` with its candidate set, and is reported as such.

## Retrieval

`query(text)`:

1. Tokenise the question, split identifiers (`getUserById` -> `get user by id`), keep code tokens verbatim.
2. BM25F over `symbols_fts` with field weights `name 4, split_name 3, fqn 2, signature 1.5, doc 1`.
3. Take the top seeds and run personalised PageRank from them over the edge graph, with edge weights by kind (`calls 1.0, extends 0.9, implements 0.9, references 0.5, imports 0.3, contains 0.2`).
4. Fuse BM25 and PPR by reciprocal rank.
5. Pack under the token budget by marginal relevance: each symbol's signature and doc first, source body for the top few, then edges between packed symbols.

Intent routing before step 2: questions shaped like "what breaks if", "who calls", "how does X reach Y", or "where is X defined" dispatch to `impact`, `callers`, `path`, and `symbol` instead.

## MCP tools

| tool | purpose |
|---|---|
| `explore` | one-shot context pack for a natural-language question or symbol name |
| `symbol` | definition, signature, doc, source, callers, callees, tests |
| `callers` / `callees` | direct edges with call-site lines |
| `impact` | blast radius of a symbol or of the current git diff, with tests to run |
| `path` | shortest path between two symbols |
| `search` | ranked symbol search |
| `overview` | architecture summary: communities, hubs, entry points, routes |
| `status` | index freshness, stale files, unresolved counts |

Every response begins with a freshness line naming both when the index was last written and when it was last checked against the working tree. Stale files are named, never hidden. A caller the resolver could not narrow to one definition is rendered as a candidate with its confidence, not as a certain edge, and symbols that did not fit the token budget are counted in the response rather than silently dropped.

## Agent integration

`symbra install` does three things and nothing else: registers the MCP server in the host config, appends a short marker-fenced section to `CLAUDE.md` / `AGENTS.md`, and, on hosts that support it, adds a PreToolUse hint hook that fires only for search commands and only once per session. The hint is one line and names the tool. No "MANDATORY", no denial.

## Communities and metrics

- Louvain on the weighted, directed edge graph treated as undirected for modularity, with a directory prior (an extra weak edge between symbols in the same directory). Deterministic node order, fixed seed.
- Two levels: modules (directory-aligned) and sub-communities.
- Labels from the common path prefix and the top TF-IDF tokens of member names, never from the single highest-degree member.
- Importance from PageRank on the reverse call graph, in-degree, and out-degree, exposed as numbers.

## Frameworks and non-code edges

- HTTP routes: Express, Fastify, Koa, NestJS decorators, FastAPI, Flask, Django `urls.py`, Go `net/http` and chi/gin, Spring annotations. Each route is a `route` symbol with a `defines_route` edge to its handler.
- Tests: test files by name pattern, `tests` edges from a test function to the symbols it imports or calls.
- Config: environment variable reads (`process.env.X`, `os.environ["X"]`, `os.Getenv`) become `reads_config` edges to a config symbol.
- Markdown: headings become symbols, links become `references` edges, and backticked identifiers that match a symbol name become `references` edges.

## Visualisation

A single self-contained HTML file with an inline canvas renderer. No CDN. Semantic zoom: communities at the top, modules on zoom, symbols on further zoom. Filters by edge kind, language, and directory. Click opens source. Served from the store, so a 100K-symbol repo renders the top level instantly and loads detail on demand.

## Semantic tier

Retrieval is lexical first. BM25F over `symbols_fts` is precise when the question contains a word from the symbol's name, signature or doc, and it is worthless when it does not: nothing in "what gets stripped when a 302 points at a different domain" matches `_redirect_headers`. An optional embedding tier covers that case. `symbra embed` renders each symbol as a short text (kind, fqn, signature, doc, container) and stores a normalised 384-dimension vector from `Xenova/bge-small-en-v1.5` (about 32 MB, run locally through onnxruntime-node with a WASM fallback) alongside a hash of that text, so re-embedding after an edit only touches what changed. A query is embedded with the model's retrieval prefix and scored by cosine against the matrix; the hits fuse with the BM25 hits by reciprocal rank before personalised PageRank runs, so the semantic tier can only add seeds, never reorder the graph expansion on its own.

The tier is additive in the strict sense: `searchHybrid`/`exploreHybrid` are the async entry points, and with no vectors, no model, or `SYMBRA_EMBED=0` they call straight through to the synchronous `search`/`explore`. Graph intents (callers, impact, path, define) never embed — they have an exact target. Measured on the 132-question benchmark in `bench/`, the tier moves overall recall@5 from 61.4 to 68.9, all of it in free-form `explore` questions (30.9 → 45.6).

## SCIP ingest

The resolver tiers are an approximation of a compiler. When a real one is available its output is strictly better, so `symbra import-scip` reads a [SCIP](https://github.com/sourcegraph/scip) index from `scip-typescript`, `scip-python`, `scip-java`, `scip-go`, `rust-analyzer` or `scip-clang` and upgrades the graph in place. SCIP symbols are parsed into descriptors and matched onto existing Symbra rows by file, line range and name; references then become edges with `resolver = 'scip'` and `confidence = 1`. At a call site a SCIP edge resolves, the heuristic edges for that site are deleted and the `unresolved` candidate row that produced them is dropped — the candidate set was honest about not knowing, and now we know.

Definitions SCIP has that Symbra does not are created, with one deliberate exception: a SCIP index names every binding, including module-scope consts, destructured locals and re-export aliases, and importing them all buries the real symbols. By default a definition that maps to a `variable` kind and matches no existing row is skipped (references to variables Symbra *did* extract still resolve, because those match an existing row); `--include-variables` opts in. On express that flag is the difference between 285 and 1398 mapped definitions out of 1398 seen.

## Language modules

Each language is one file in `src/languages/` implementing the `LanguageSupport` contract:

- `definition` — walks the parse tree (or, for a grammar-less extractor, the raw source) and
  produces `Definition`s: kind, name, range, signature, doc, modifiers, container.
- `imports` — the file's import/require/use statements as `Import`s, before resolution.
- `references` — calls, type uses, config reads and the like, as `Reference`s the resolver later
  binds to definitions.
- `resolveModule` — turns an import's raw source string (a relative path, a package name, a
  module path) into the file(s) it points at, using the language's own resolution rules
  (tsconfig `paths`, Python packages, Go module paths, Rust `mod`/`use`, JVM source roots, …).
- `isTestFile` / a test-detecting shape in `definition` — marks test functions and blocks so
  `impact` can name tests to run.
- `detect` — an optional hook that lets a language claim a file by content instead of extension
  alone. The motivating case is Objective-C: a bare `.h` is ambiguous with C/C++, so `objc.ts`
  inspects the content and `languageForContent` in `src/languages/registry.ts` prefers a `detect`
  match over the extension-based one.
- `postWalk` — an optional pass called once with every definition of the file, after the main walk,
  for shapes that are easier to fix up with whole-file knowledge than inline (e.g. reparenting
  `@implementation`/category members onto the `@interface` they extend, the same treatment Rust
  `impl` and Swift `extension` blocks get).

### Grammar-less extractors

Not every shape worth indexing has a tree-sitter grammar, and some that do are better read as text:

- **Markdown** never had a grammar — headings, links and backticked identifiers are read from the
  source directly.
- **SQL** has no tree-sitter grammar shipped as wasm, so `sql.ts` is a small scanner: mask
  comments, string literals and dollar-quoted bodies (so quoting can't confuse statement
  splitting), split into statements, then match each statement head against the DDL shapes worth
  indexing. The masked copy stays the same length as the source, so ranges and docs always read
  back from the real text.
- **Vue and Svelte** single-file components have no unified grammar either. `sfc.ts` scans the
  `<script>`/`<template>`/`<style>` blocks out of the raw source, blanks everything else, and hands
  the script block to the existing JavaScript/TypeScript parser with line numbers shifted back to
  the real `.vue`/`.svelte` positions — so a component's script is extracted with the same fidelity
  as a standalone `.ts` file, and template component usage is scanned separately and turned into
  references.

### Core vs long-tail grammars

`grammars/manifest.json` is the single source of truth for every grammar's npm package, version
and wasm file name. 21 languages reached for constantly (Python, JS/TS/TSX, Go, Rust, Java, C#, C,
C++, Ruby, PHP, Kotlin, Swift, Scala, Bash, JSON, YAML, TOML, CSS, HTML, plus Markdown which needs
no grammar) are vendored into `./grammars` and ship inside the npm package. The other 18 — the long
tail, including all 14 languages added for 0.3.0 plus Dart, Elixir, Lua and Zig from 0.1.0 — live
in `./grammars-optional`, a sibling directory the package's `files` list never includes, and are
fetched from npm on first use: `src/parse/loader.ts` downloads the tarball named in the manifest,
verifies it against the registry's published sha512 before trusting it, extracts the wasm entry
and caches it under `~/.cache/symbra/grammars`. A source checkout has both directories vendored
locally (`npm run grammars`), so the loader — and the test suite — never needs the network.

## Out of scope

LLM summaries and cross-repository graphs. The store schema and the resolver tiers leave room for both.
