# Changelog

## 1.0.0 (2026-09-05)

First public release.

### What it is

Symbra weaves a repository into a live, queryable symbol graph — every function, class, method,
route, test and config key with its exact range, signature, doc comment, callers, callees, imports
and inheritance — stores it in SQLite (Node's built-in implementation, zero native deps), keeps it
fresh as files change, and serves it to AI coding agents over MCP or the CLI. Parsing is
tree-sitter compiled to WebAssembly; there is no LLM and no cloud call anywhere in the pipeline.

### Languages

35 languages (counting TypeScript/TSX as one and OCaml's `.ml`/`.mli` as one), grouped by how they
land in the index:

- **Systems and application languages:** TypeScript, TSX, JavaScript, Python, Go, Rust, Java,
  Kotlin, Scala, C#, C, C++, Ruby, PHP, Swift, Dart, Elixir, Zig, Lua, Bash, Objective-C, Groovy
  (and Gradle build scripts), Haskell, OCaml, F#, Julia, Solidity — classes, functions, methods,
  fields, tests (JUnit/pytest/RSpec/PHPUnit/XCTest/Pester/hspec/alcotest/Foundry/…) and framework
  routes (Express/Fastify/Koa/NestJS, FastAPI/Flask, Spring/JAX-RS/Ktor, ASP.NET, Rails/Sinatra,
  Laravel/Symfony, Phoenix) are extracted per language, with resolution through scope, imports,
  receiver types and inheritance.
- **Config and infrastructure shapes:** Terraform/HCL (every block as a symbol named after its
  terraform address), YAML shapes (GitHub Actions, GitLab CI, docker-compose, Kubernetes, OpenAPI —
  YAML matching no recognised shape yields nothing, deliberately), Makefiles (targets and
  variables, detected by content for extension-less files).
- **Grammar-less extractors:** Markdown (headings, links, backticked identifiers), SQL (a
  comment/string-masking scanner, since no tree-sitter SQL grammar ships as wasm), Vue and Svelte
  single-file components (script/template/style blocks scanned from raw source, script parsed as
  JS/TS with real line numbers preserved).

Every edge records the resolver tier that produced it (`scope`, `import`, `receiver`, `unique`,
`heuristic`, `structural`) and a confidence, so results can be audited or filtered.

### Indexing and resolution

- **Tiered resolver.** Lexical scope, package/module imports (with re-export following, tsconfig
  paths, Python packages, Go module paths, Rust `mod`/`use`, JVM source roots), receiver types
  (annotations, `new`, constructor injection), inheritance, then unique-global as a last resort;
  ambiguous references are kept as **candidate sets** instead of being guessed, and reported as
  such rather than silently dropped.
- **Implicit-self member calls.** A bare `helper()` inside a method that reaches the enclosing
  class's own or inherited members without a receiver resolves correctly across Java, Kotlin,
  Scala, C#, Swift, Ruby, C++ and Dart (Python and JavaScript need `self.`/`this.`; Go has no
  implicit receiver).
- **Callbacks and function pointers (`passes` edges).** A bare identifier passed as an argument
  rather than called at the call site produces a `passes` edge instead of being invisible to the
  graph (Swift, C#); `callers`/`callees` label these `passes (passed as callback)`, and
  `path`/`impact` cross them like any other edge.
- **Doc inheritance, with provenance.** A supertype's or interface's doc is copied down to an
  undocumented override, and every copy records where the doc actually came from
  (`meta.doc_from`), so retrieval can discount an inherited doc and rank the true source first when
  they tie.
- **SCIP import.** `symbra import-scip index.scip` upgrades the graph with compiler-accurate
  references from scip-typescript, scip-python, scip-java, scip-go, rust-analyzer or scip-clang:
  heuristic call edges at a resolved call site are replaced by `resolver = scip, confidence = 1`
  edges and the matching candidate sets are collapsed. `--include-variables` (default off) also
  creates rows for variable definitions Symbra does not extract by default.
- **Incremental updates.** SQLite with FTS5, per-file upsert on change, and re-resolution of a
  changed file's dependents — not a full re-extract. Deferred analysis marks PageRank/communities
  as stale after a small edit so `overview()`/`symbra viz` pay that cost once instead of on every
  one-file change.
- **Generated and minified files are skipped.** Built output (hashed bundle names, known chunk
  names, directories like `site/assets/`, `public/assets/`, `static/js/`, `storybook-static/`) is
  skipped by name before extraction; any plain-named file is still skipped at read time if it's
  minified (very long lines) or carries an `@generated`/`DO NOT EDIT` marker. Both counts are
  reported as "N generated/minified files skipped" when indexing; a `.symbraignore` negation
  (`!path/hand-written.js`) forces a file back in.

### Retrieval

Hybrid retrieval fuses BM25F over `symbols_fts` (name/split-identifier/signature/doc) with
personalised PageRank over the edge graph, plus an optional local embeddings tier
(`symbra embed`, `Xenova/bge-small-en-v1.5`, ~32 MB, ~130 symbols/s) that fuses in by reciprocal
rank without replacing the lexical and graph signals. Intent routing dispatches questions shaped
like "who calls X", "what breaks if I change X", "how does X reach Y" or "where is X defined"
straight to the graph tools instead of running free-form retrieval, and `path` is weighted
(containment costs more than a call, high fan-in hubs carry a penalty) rather than a plain hop
count.

Measured on 132 hand-written questions over 11 indexed repositories (httpx, express, gin, gson,
moshi, MediatR, Slim, sinatra, bytes, fmt, Alamofire — Python, JS, Go, Java, Kotlin, C#, PHP,
Ruby, Rust, C++, Swift) across five question kinds:

- recall@5 61.4 (lexical: BM25 + PageRank only) → **69.7** with the semantic tier on.
- `callers` and `impact` questions: **100%** found at rank 1.
- All of the semantic-tier gain lands in free-form `explore` questions (30.9 → 45.6 recall@5).

### Agent integration

An MCP server exposes **9 tools** — `explore`, `symbol`, `callers`, `callees`, `path`, `impact`,
`search`, `overview`, `status` — each response prefixed with a freshness line (last indexed, last
checked, symbol/edge counts) and STALE markers on symbols whose file changed after indexing.

`symbra install --tool <name>` registers the server and writes short, marker-fenced guidance
(`<!-- symbra:start/end -->`) into the host's config for **Claude Code, Cursor, Codex, Windsurf,
VS Code, Gemini and Arcturn**. `--hooks` adds a once-per-session PreToolUse hint (Claude Code only)
that nudges an agent reaching for grep without ever blocking a tool call.

### Visualisation

A single self-contained HTML file (`symbra viz`) renders the graph with an inline canvas: semantic
zoom from subsystems to modules to symbols, filters by edge kind/language/directory, deterministic
initial view, hash deep links to a specific symbol, and no CDN dependency — it works fully offline.

### Performance

Measured on an Apple M-series laptop: httpx (17.7K LOC Python) indexes in **0.6 s**; Django (2,375
files, about 1M lines) indexes in about **20 s** (59,850 symbols, 135,881 edges, best of four
`--full` runs, 19.5–54 s depending on machine load).

### Distribution

`npx symbra` needs no install step. The package is **3.3 MB packed / 33.2 MB unpacked**: the 21
languages reached for constantly (Python, JS/TS/TSX, Go, Rust, Java, C#, C, C++, Ruby, PHP, Kotlin,
Swift, Scala, Bash, JSON, YAML, TOML, CSS, HTML, plus Markdown which needs no grammar) ship their
tree-sitter grammars in the package; the other 18 languages are fetched from npm on first use and
cached under `~/.cache/symbra/grammars`, verified against the registry's published sha512
`dist.integrity` before being trusted. `symbra grammars [names…|--all|--list]` prefetches languages
for offline use or reports shipped/cached/missing status; `SYMBRA_OFFLINE=1` (or a network failure)
makes indexing skip files in a not-yet-fetched language with a one-line warning instead of aborting
the run. `SYMBRA_*` environment variables switch or redirect the embeddings tier
(`SYMBRA_EMBED`, `SYMBRA_EMBED_BACKEND`, `SYMBRA_MODEL_DIR`) and the grammar cache
(`SYMBRA_GRAMMARS`).

### Requirements

Node.js **>= 22.5** (for built-in SQLite).
