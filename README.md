# Symbra

**Local-first, live code intelligence for AI coding agents.**

Symbra weaves a repository into a symbol graph — every function, class, method, route, test and config key with its exact range, signature, doc comment, callers, callees, imports and inheritance — stores it in SQLite, keeps it fresh as you edit, and serves it to Claude Code, Cursor, Codex, Windsurf, VS Code and Gemini over MCP. One tool call replaces a grep-and-read loop.

- **Zero LLM, zero cloud, zero native compilation.** Parsing is tree-sitter compiled to WebAssembly; storage is Node's built-in SQLite. Nothing leaves your machine.
- **Live, not static.** The index is a database, not a JSON dump. Changed files re-index in milliseconds; the MCP server refreshes itself on every call and flags stale symbols.
- **Symbols, not strings.** Calls resolve through lexical scope, real module resolution (tsconfig paths, Python packages, re-exports), declared receiver types and inheritance. Ambiguous references are kept as candidate sets instead of being guessed.
- **Answers in one call.** `explore("how does connection pooling work")` returns the ranked symbols with source, relations and the paths between them, packed under a token budget.
- **Blast radius from your diff.** `impact` with no arguments reads `git diff`, walks reverse dependencies and lists the tests to run.

```bash
npx symbra index            # build the index for the current repo (seconds)
npx symbra install          # register the MCP server with Claude Code (+ Cursor, Codex, ... via --tool)
npx symbra explore "where are timeouts configured"
```

## Why another code graph

[Graphify](https://github.com/Graphify-Labs/graphify) popularised the idea of a knowledge graph for AI assistants, and its 114K stars show the demand. Symbra was built after reading graphify end to end (see [docs/graphify-teardown.md](docs/graphify-teardown.md)) to fix what makes agents ignore such graphs in practice:

| | Graphify 0.9.53 | Symbra |
|---|---|---|
| Node data | label, file, start line | kind, start/end line, byte range, signature, doc, modifiers, exported, declared type |
| Call resolution | corpus-wide name table with a hand-written builtin blocklist | scope → imports → receiver type → unique global; unresolved kept as candidates |
| Parallel edges | collapsed to one relation per pair | every call site is an edge with line and resolver provenance |
| Query | substring match over labels, fixed-depth BFS, advisory token budget | BM25 over names/split identifiers/signatures/docs + personalised PageRank, packed by relevance under a real budget, with source |
| Storage | pretty-printed JSON, 512 MiB cap, parsed whole on every read | SQLite with FTS5, incremental per-file upsert |
| Freshness | full re-extract on every watch event | only changed files and their dependents |
| Agent integration | 700 KB of duplicated skill prompts, MCP server not registered at install | MCP server registered at install, 9 tools, short marker-fenced guidance |
| Visualisation | vis-network from a CDN, breaks above 5,000 nodes | self-contained canvas map with semantic zoom (subsystems → symbols), works offline |
| Install | Python, `graphifyy` package, PATH setup, interpreter sniffing | `npx symbra` |

Measured on the same machine (Apple M-series, 8 cores):

| Repository | graphify extract | Symbra index | Notes |
|---|---|---|---|
| httpx (17.7K LOC Python) | 6.3 s | 0.6 s | Symbra resolves `Client.request → Client.send` through the receiver type; graphify's query for "connection pooling" returned 72 nodes without `Limits` or `HTTPTransport` |
| express (21.5K LOC JS) | 1.4 s | 0.7 s | graphify extracted 3 symbols from `lib/application.js` and 7 call edges repo-wide; Symbra finds all 20 `app.x = function` methods and 812 calls |
| graphify itself (764 files, 153K lines Python plus fixtures in 18 other languages) | 21.8 s | 8.0 s (4.5 s for the Python alone) | 11,059 symbols, 22,758 edges |
| Django (2,375 files, about 1M lines) | not measured | 20 s | 59,850 symbols, 135,881 edges, 750 MB peak memory (best of four `--full` runs; 19.5–54 s depending on machine load) |

Retrieval quality is measured, not asserted. `npm run bench` runs 132 hand-written questions over 11
indexed repositories (httpx, express, gin, gson, moshi, MediatR, Slim, sinatra, bytes, fmt,
Alamofire — Python, JS, Go, Java, Kotlin, C#, PHP, Ruby, Rust, C++, Swift) across five question
kinds, with the gold answer recorded as a symbol fqn:

| Retrieval | recall@1 | recall@5 | found | MRR |
|---|---|---|---|---|
| lexical only (BM25 + PageRank) | 43.9 | 61.4 | 74.2 | 0.514 |
| + semantic tier (`symbra embed`) | 47.7 | **72.0** | 81.8 | 0.573 |

The graph questions (`callers`, `impact`, `search`) already find the gold symbol in 100% of cases;
the movement is in free-form `explore` questions, where recall@5 goes from 30.9 to 51.5. Full
harness, questions and per-repo results are in [bench/](bench/).

## Install

Requires Node 22.5 or newer (for built-in SQLite). The launcher runs Node with `--liftoff-only` because V8's optimizing wasm compiler runs out of memory on the largest grammars; parsing speed is unaffected.

```bash
npm install -g symbra       # or use npx symbra ... without installing
cd your-repo
symbra index
symbra install --tool claude,cursor    # claude | cursor | codex | windsurf | vscode | gemini | arcturn | all
```

`install` writes the MCP server entry (`.mcp.json`, `.cursor/mcp.json`, `~/.codex/config.toml`, `.arcturn/mcp.json`, …), a short guidance section in `CLAUDE.md` / `AGENTS.md` / `GEMINI.md` / `ARCTURN.md` between `<!-- symbra:start -->` markers, and adds `.symbra/` to `.gitignore`. Add `--hooks` for a once-per-session Claude Code hint when the agent reaches for grep; it never blocks a tool call (Arcturn's hook protocol has no channel for a hint, so `--hooks` is a no-op there — its guidance comes from `ARCTURN.md` alone). Use `--command "<cmd>"` to register a different server command (e.g. a local checkout) instead of the default `npx -y symbra`.

### Arcturn

```bash
symbra index
symbra install --tool arcturn
arcturn trust --allow
```

`symbra install --tool arcturn` writes `.arcturn/mcp.json` and also merges nine allow rules (one per read-only tool: `explore`, `search`, `symbol`, `callers`, `callees`, `path`, `impact`, `overview`, `status`) into `.arcturn/config.json`, since Arcturn's project MCP tools are permission-gated — a non-interactive run denies them without an explicit rule. The merge is additive and idempotent: it only appends rules that are missing and never touches unrelated config or permissions. Running `install` again does not duplicate rules. Arcturn also requires `arcturn trust --allow` once per repo before it will start project MCP servers at all. The Arcturn VS Code extension reads the same `.arcturn/` configuration, so no separate setup is needed there.

For a local checkout of symbra (instead of the published npm package), point the server entry at your build directly:

```bash
symbra install --tool arcturn --command "node /path/to/symbra/bin/symbra.js"
```

The npm package ships wasm grammars for 21 core languages (Python, JS/TS/TSX, Go, Rust, Java, C#, C, C++, Ruby, PHP, Kotlin, Swift, Scala, Bash, JSON, YAML, TOML, CSS, HTML — plus Markdown, which needs no grammar at all). Everything else (Dart, Elixir, Lua, Zig, HCL/Terraform, Objective-C, Groovy, PowerShell, Haskell, OCaml, F#, Julia, Solidity, Svelte, Make, Vue) is fetched from npm on first use and cached under `~/.cache/symbra/grammars`, verified against the registry's published sha512 before it's trusted — still zero native compilation, just a one-time download for the long tail. Prefetch before going offline with `symbra grammars --all` (or name specific languages, e.g. `symbra grammars dart lua`); `symbra grammars --list` shows what's shipped, cached, or missing. `SYMBRA_OFFLINE=1` (or a network failure) makes indexing skip files in a not-yet-fetched language with a one-line warning instead of failing the run; `SYMBRA_GRAMMARS=<dir>` points at a directory of your own prebuilt grammars.

## CLI

```
symbra index [path] [--full]        build or update the index (incremental)
symbra status                        freshness, counts, resolver statistics
symbra explore "<question>"          one-shot context pack (alias: query)
symbra search <terms>                ranked symbol search
symbra symbol <name>                 signature, doc, relations, tests, source (alias: explain)
symbra callers <name> [-d 2]         who calls or references it
symbra callees <name>                what it calls
symbra path <from> <to>              shortest structural path
symbra impact [name] [--base ref]    blast radius of a symbol or of the git diff, with tests to run
symbra overview                      subsystems, hubs, entry points, env vars, import cycles
symbra embed                         compute local semantic vectors (optional tier)
symbra import-scip <index.scip>      upgrade edges with compiler-accurate references
symbra viz [--open]                  self-contained HTML map at .symbra/map.html
symbra grammars [names…|--all|--list]  prefetch or show status of tree-sitter grammars
symbra watch                         re-index as files change
symbra serve                         MCP server over stdio (what the agents use)
```

`explore` understands intent: "who calls X", "what breaks if I change X", "how does X reach Y" and "where is X defined" dispatch to the graph tools; anything else runs hybrid retrieval.

Example, on httpx:

```
$ symbra path Client HTTPTransport
2 hops
  [class] Client  httpx/_client.py:594-1304
  --> [contains] [method private] Client._init_transport  httpx/_client.py:718-738
  --> [calls L731] [class] HTTPTransport  httpx/_transports/default.py:135-262

$ symbra impact Timeout -d 2
12 dependent symbols in 2 files · 29 tests
depth 1:
  [constructor] BaseClient.__init__  httpx/_client.py:189-221  calls Timeout
  [method] BaseClient.build_request  httpx/_client.py:340-389  calls Timeout
  ...
tests to run:
  tests/client/test_client.py::test_build_request
  tests/test_config.py::test_timeout_eq
```

## MCP tools

| Tool | What it returns |
|---|---|
| `explore(question, budget?, source?)` | ranked symbols with signatures, docs, source bodies and the relations among them; ranked symbols that did not fit the budget are counted, not silently dropped |
| `symbol(name)` | definition, supertypes and subtypes, members, callers, callees, tests, source |
| `callers(name, depth?)` / `callees(name)` | direct or transitive edges with call-site lines and resolver confidence; a reference the resolver could not narrow to one definition is labelled `(candidate, conf 0.5)` rather than reported as a certain edge; a callback or function pointer handed to another function shows as `passes (passed as callback)` |
| `path(from, to)` | shortest chain of contains/calls/extends/passes edges |
| `impact(name?, depth?, base?)` | reverse dependency closure grouped by depth plus tests to run; no name means the git diff |
| `search(query, kind?, path?)` | ranked symbol search |
| `overview()` | subsystems with labels, hubs, entry points, env vars, import cycles, index quality |
| `status(reindex?)` | freshness and counts |

Every response starts with `[symbra] index 3m ago, checked 2s ago @ 1a2b3c4d · 1802 symbols · 3779 edges` — when the index was last written and when it was last verified against the working tree, which are the same clock only when the last check found a change. Symbols whose file changed after indexing are marked STALE.

## Optional: semantic search

BM25 finds a symbol when you know a word in its name. It does not find `_redirect_headers` from
"what gets stripped when a 302 points at a different domain". An optional local embedding tier
closes that gap; it fuses with BM25 and PageRank by reciprocal rank rather than replacing them.

```bash
npm i @huggingface/transformers   # optional, not installed by default
symbra embed                    # downloads Xenova/bge-small-en-v1.5 once (~32 MB), then vectorises
```

Vectors live in the same SQLite file and are incremental by text hash, so `symbra embed` after an
edit only re-embeds what changed. Throughput is about 130 symbols/s on an M-series laptop (httpx:
929 symbols in 7 s). Nothing is sent anywhere: the model runs locally through onnxruntime-node, with
a WASM fallback.

| Variable | Effect |
|---|---|
| `SYMBRA_EMBED=0` | switch the tier off entirely — no model load, no fusion |
| `SYMBRA_EMBED_BACKEND=wasm\|node` | pin the runtime (default: native first, WASM as fallback) |
| `SYMBRA_MODEL_DIR=<dir>` | move the model cache (default `~/.cache/symbra/models`) |

Without the package, without the model, or with no vectors computed, every query behaves exactly as
it did before — the tier is additive. The MCP server preloads the model when the store has vectors,
so the first question does not pay the session-creation cost.

Measured effect on the benchmark: overall recall@5 61.4 → 68.9, and 30.9 → 45.6 on free-form
`explore` questions.

## Compiler-accurate references (SCIP)

Symbra's resolver is a tiered approximation of a compiler. When you already have a real one, feed
it in: [SCIP](https://github.com/sourcegraph/scip) indexes from `scip-typescript`, `scip-python`,
`scip-java`, `scip-go`, `rust-analyzer` or `scip-clang` upgrade the graph in place.

```bash
scip-typescript index                 # or your language's indexer
symbra import-scip index.scip --dry-run   # report what would change
symbra import-scip index.scip
```

Heuristic call edges at a SCIP-resolved call site are replaced by edges with `resolver = scip` and
`confidence = 1`, and the candidate sets they came from are collapsed. On express: 920 edges over
141/141 documents, 467 heuristic edges replaced, 259 candidate sets resolved, in 0.3 s.

A SCIP index names every binding, including the module-scope consts, destructured locals and
re-export aliases that Symbra deliberately does not extract. By default those are not turned into
new symbol rows — references to variables Symbra *did* extract still resolve. `--include-variables`
opts in; on express it adds 1112 `variable` rows, growing the symbol count by 53%.

## What gets indexed

35 languages (counting TypeScript/TSX as one and OCaml's `.ml`/`.mli` as one; 37 grammars are
registered once those are split out). The core set ships with the package; the long tail downloads
on first use — see [Install](#install). In monorepos, pnpm/npm workspace packages resolve by
package name into their source (`@scope/pkg`, subpaths), and tsconfig/jsconfig `paths` are read
from the nearest config up the tree, following `extends`.

| Language | Definitions | Resolution |
|---|---|---|
| TypeScript, TSX, JavaScript | functions, classes, interfaces, types, enums, namespaces, methods, fields, CommonJS and prototype assignments (`app.use = function`), object-literal APIs, `describe`/`it` tests, Express/Fastify/Koa/NestJS routes | ES and CommonJS imports, re-exports and `module.exports`, tsconfig `paths`/`baseUrl`, `this.x` fields, `new T()` locals, constructor parameter properties |
| Python | functions, classes, methods, properties, dataclasses, enums, constants, `pytest` tests, FastAPI/Flask routes | relative and package imports, `__init__` re-exports, `TYPE_CHECKING` imports, annotated parameters and fields, `self.x = x` injection |
| Go | functions, methods with receivers, structs and embedded fields, interfaces, consts and vars, `Test*` functions, `net/http`, gin, echo, chi and fiber routes | package-directory scope, module-path imports via `go.mod`, receiver types, `x := T{}` and `NewT()` locals |
| Rust | functions, `impl` blocks, structs, enums, traits, consts, type aliases, macros, `#[test]` | `use` trees with `as`/globs, `mod` files, `crate::`/`self::`/`super::` paths, `Foo::new()` locals |
| Java, Kotlin, Scala | classes, interfaces, records, enums, annotations, methods, fields, JUnit tests, Spring and JAX-RS routes, Ktor routes, ScalaTest specs | declared package recorded per file; imports (`import a.b.C`, nested types, Kotlin top-level functions, wildcards, `import static`) resolve by package and symbol name, same-package files see each other across directories, source sets and modules, Kotlin Multiplatform source sets (`commonMain`, `androidMain`, `iosMain`, `jvmMain`, `desktopMain`, `jsMain`, `wasmJsMain`, `*Test`) recognised as source roots, inherited fields, declared and `new T()` locals |
| C# | namespaces (block and file-scoped), classes, records, structs, interfaces, enums, properties, events, primary constructors, xUnit/NUnit/MSTest tests, ASP.NET attribute and minimal-API routes | `using` directives and enclosing namespaces, receiver types, `var x = new T()` |
| C, C++ | functions and prototypes, structs, unions, enums, typedefs, macros, classes, namespaces, templates, out-of-class methods, gtest and Catch2 tests | `#include` paths, `using namespace`, smart-pointer members, `this->x` |
| Ruby, PHP | modules, classes, mixins, `attr_*` properties, visibility sections, RSpec/minitest, Rails and Sinatra routes; namespaces, traits, enums, promoted constructor params, PHPUnit, Laravel and Symfony routes | `require_relative`, PSR-4 best effort, `@ivar`/`$this->x` typing, `parent::` |
| Swift, Dart, Elixir, Zig, Lua, Bash | classes, structs, protocols, extensions, mixins, `defmodule`/`def`, `test` blocks, Phoenix routes, Lua module tables, shell functions | relative imports, `alias`/`import`, `require`, `source` |
| Markdown | headings as sections, links as edges, backticked identifiers as references to code | relative links |
| Terraform, HCL | every block kind (`resource`, `module`, `variable`, `output`, …) as a symbol named after its terraform address, plain `.tf`/`.hcl` too | traversals as references addressed like the blocks they point at, local module sources resolved to the module's files |
| YAML shapes (GitHub Actions, GitLab CI, docker-compose, Kubernetes, OpenAPI) | jobs and steps, services with their dependencies and env keys, each Kubernetes document as `Kind/name`, OpenAPI routes and schemas — YAML of no recognised shape yields nothing, deliberately | secrets/env keys as config reads, compose service dependencies |
| Makefiles (`Makefile`, extension-less names detected by content) | targets and variables with docs and `.PHONY` flags | prerequisites, variable references, `include` directives as imports, sub-`make` calls |
| SQL (grammar-less scanner) | tables, columns, views, functions, triggers, with `COMMENT ON` as documentation | foreign keys and body table reads as references |
| Objective-C (`.h` claimed by content, not just extension) | `@interface`/`@implementation`/category/extension members reparented onto one symbol per type, `NS_ENUM`/`NS_OPTIONS` macros the grammar can't parse, XCTest methods | `#import`/`#include` with local headers resolved next to the source, message sends, allocations, receiver facts, config reads |
| Groovy, Gradle build scripts | classes, members, Spock specifications and feature methods; Gradle `dependencies {}`/`plugins {}` blocks and `task` definitions read as their own shape rather than through the (weaker) Gradle grammar | JVM-style imports, project dependency references resolved to the subproject build script, task `dependsOn` references |
| PowerShell (`.ps1`/`.psm1`/`.psd1`) | functions with comment-based help as docs, classes, members, enums, Pester blocks as nested tests | `Import-Module` and dot-sourcing as imports, parameter types, env reads |
| Haskell | modules, types, classes, functions (multiple equations collapsed into one symbol), instances modeled as impl blocks reparented onto their type, hspec `describe`/`it` tests | imports, qualified calls, config reads |
| OCaml (`.ml`/`.mli`) | types, modules, classes, `let` bindings, `.mli` signatures as prototypes, alcotest/`test_*` tests | `open`/`include` as namespace imports, qualified calls, type references, config reads |
| F# | namespaces, modules, types, members, attributed test functions | `open`, calls, member calls, config reads |
| Julia | modules, structs, functions and constants, macros, multiple methods collapsed into one symbol with a method count, `@testset` blocks | `using`/`import`/`include`, calls, type annotations, decorators, config reads |
| Solidity | contracts, interfaces, libraries, functions, constructors, modifiers, events, errors, structs, enums, state variables, Foundry tests | imports, calls, `new`, `emit`, modifiers as decorators, `using`, Foundry `vm.env*` as config reads |
| Vue, Svelte single-file components (grammar-less: script/template/style blocks scanned and the script parsed as JS/TS) | one component symbol named after the file, props (`defineProps`/options-API `props`/Svelte 5 `$props()`) as fields, emits as component metadata | imports and calls from the script block, template component usage as references (PascalCased for kebab-case tags), `.vue`/`.svelte` specifiers resolved through the JS module resolver |

Environment variable reads (`process.env.X`, `os.environ["X"]`, `os.Getenv`, …) become `config_key` symbols with `reads_config` edges, so "where is DATABASE_URL used" is a graph question.

Every edge records the resolver tier that produced it (`scope`, `import`, `receiver`, `unique`, `heuristic`, `structural`) and a confidence, so you can audit or filter.

## How it works

```
scan (gitignore-aware) → parse (tree-sitter WASM, worker threads) → IR per file
  → SQLite (symbols, refs, imports, local types, FTS5)
  → resolve changed files and their importers (scope → import → receiver → unique)
  → PageRank over production code, Louvain communities with directory prior and hierarchical refinement
  → CLI · MCP · HTML map
```

Design notes: [docs/DESIGN.md](docs/DESIGN.md). Determinism is a requirement: same input, same IDs, same community numbering, on every machine.

Built output — hashed bundle names (`index-DrLLgu_7.js`, `main.a1b2c3d4.js`), known chunk names (`chunk-*.js`, `vendor.js`), and directories like `site/assets/`, `public/assets/`, `static/js/`, `storybook-static/` — is skipped by name before extraction, and a plain-named file (any language) is still skipped at read time if it's minified (very long lines) or carries an `@generated`/`DO NOT EDIT` marker in its first few lines; both counts are reported as "N generated/minified files skipped" when you index. If a legitimate file gets caught by mistake, force it back in with a negation in `.symbraignore` (`!site/assets/hand-written.js`) — symbra already reads that file for every ignore rule, including these heuristics.

## Development

```bash
npm install
npm run grammars     # vendor core grammars into ./grammars and long-tail ones into ./grammars-optional (already committed; the loader checks both locally, so a source checkout never needs network for any language)
npm run build
npm test             # vitest: extractor fixtures + an end-to-end index of tests/fixtures/repo
npm run bench        # retrieval quality over bench/questions.json (needs the repos in bench/repos.json indexed)
node bin/symbra.js index ../some-repo
```

Adding a language is one file in `src/languages/` implementing `LanguageSupport` (definitions, imports, references, module resolution) plus a fixture and a test. `node scripts/dump-node-types.mjs <grammar>` prints the node and field names a grammar exposes.

---

## 👤 Author

**Sitharaj Seenivasan**

- 🌐 Website: [sitharaj.in](https://sitharaj.in)
- 💼 LinkedIn: [sitharaj08](https://www.linkedin.com/in/sitharaj08)
- 💻 GitHub: [sitharaj88](https://github.com/sitharaj88)

## ☕ Support

If this project helps you, consider buying me a coffee — it keeps the work going.

[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-support-FFDD00?logo=buy-me-a-coffee&logoColor=black)](https://buymeacoffee.com/sitharaj88)

## 📄 License

Licensed under the [Apache License 2.0](LICENSE). © 2026 Sitharaj Seenivasan.
