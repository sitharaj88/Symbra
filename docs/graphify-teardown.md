# Graphify teardown

A code-level review of [Graphify-Labs/graphify](https://github.com/Graphify-Labs/graphify) v0.9.53 (commit `33362d9`, 2026-08-30), done to decide what Symbra must do differently. Numbers below come from reading the source and from running graphify on httpx, express, and graphify itself.

## What graphify is

A Python CLI plus a 41 KB "skill" prompt for 22 AI assistants. Tree-sitter parses code into a name graph, an LLM pass extracts docs/PDFs/images, Leiden clusters the result, and three static files are written: `graph.json`, `graph.html`, `GRAPH_REPORT.md`. Query, path, explain, affected, and an MCP server read `graph.json`. 65K lines of Python, 114K GitHub stars, 1,256 open issues, YC S26.

## What it gets right

- Code extraction is local and needs no LLM. httpx (17.7K LOC) extracts in 6.3 s, graphify itself (153K lines) in 21.8 s.
- Every edge carries `file:line` provenance and an `EXTRACTED` / `INFERRED` tag.
- `explain`, `path`, `affected`, and `god-nodes` are compact (under 1.5K tokens) and precise.
- Real module resolution for JS/TS (tsconfig paths, workspaces, `exports` conditions) and Python (relative imports).
- Prompt-injection hardening on the LLM pass is above average.
- The "work memory" idea (time-decayed, corroborated lessons from past answers) is genuinely good.

## Where it breaks

### Retrieval

- `query` is substring matching over node **labels**. No stemming, synonyms, docstrings, or embeddings. Their own reference doc says the literal matcher "returns 0 hits and the answer collapses to noise" on vocabulary mismatch, and offloads the fix to the host LLM via a manual vocabulary-expansion protocol.
- Scoring uses 1000× / 100× / 1× tier cliffs with five stacked patches (coverage squaring, per-term guaranteed seeds, verb demotion, label dedup, 20% gap cutoff).
- Expansion is fixed-depth BFS. No query-conditioned ranking. The token budget is advisory: a 2000-token query on httpx returned 9,129 tokens.
- Output is labels plus coordinates. The agent still has to open the files, which the PreToolUse hook then nags about.
- No retrieval-quality benchmark exists. `bench_query_scoring.py` measures latency only.

### Extraction

- Nodes have no kind, no end line, no signature, no parameters, no docstring, no visibility. Class-vs-function is recovered by parsing the label string (`label.endswith(")") and "." not in label`).
- Call resolution falls back to a flat corpus-wide `label -> ids` table with hand-maintained builtin blocklists (~130 names) and "prefer the non-test file nearest in the path tree" tie-breaking.
- Node IDs embed the file path, so any move or rename orphans history. Four separate ID-repair passes exist.
- Zero tree-sitter queries. One 3,183-line `_extract_generic` function with 97 `ts_module ==` string comparisons inside it.
- JS/TS files bypass the cache and are parsed twice per run. The resolution phase is single-threaded with 83 linear sweeps over all edges.
- On express (21K LOC): 7 `calls` edges total. All 43 `app.X = function` / `res.X = function` methods were missing. The top "god nodes" were `keywords`, `contributors`, and `scripts` from `package.json`.
- Import cycles counted `if TYPE_CHECKING:` imports, producing false positives on httpx.
- Extraction and resolver failures are swallowed into log warnings.

### Graph model and storage

- Undirected `networkx.Graph` by default. Parallel edges between the same pair collapse to one relation (`calls` + `imports` becomes one edge). Direction is smuggled through `_src` / `_tgt` attributes.
- Hyperedges live in a dict attribute, not in the graph.
- Storage is pretty-printed node-link JSON with a 512 MiB cap. 153K lines of Python produced a 14.8 MB file that every consumer parses whole.
- Community labels come from the highest-degree member. Cohesion is raw edge density, which penalises large communities by construction.
- God nodes are plain degree with a curated noise denylist.

### LLM layer and cache

- Five hand-written backend call functions with per-provider `if` branches. No structured output except a degenerate schema on the `claude-cli` path. JSON is scraped from raw text with a brace-balancing parser.
- No prompt caching, no batch API.
- Two parallel change-tracking systems (SHA256 cache plus MD5 manifest), ten interacting special cases in `save_semantic_cache`, and a count-based "shrink guard" that refuses writes when the node count drops.
- SCIP ingest is a stub that reads "LLM-generated SCIP-style JSON", not compiler output.
- No embeddings, no vector index, no SQLite anywhere.

### Agent integration

- `graphify install` writes 16 near-identical 41 KB skill files and 112 reference files (700 KB of duplicated prompt text) and never registers the MCP server.
- The PreToolUse hook spawns a Python process on every Read/Grep/Bash call, regex-parses shell commands, and injects "MANDATORY: You MUST" on every file read. Strict mode denies the first Read of a session using marker files on disk.
- The semantic pass is an RPC protocol built from filesystem side effects: subagents write chunk JSON, the parent checks file existence as the success signal.
- Third-party reviews report the same outcome: agents skip the graph and read files directly, and the output is treated as noise.

### Operations

- `watch` does a full corpus re-extract on every debounced batch even though incremental extraction exists for the git hook path.
- Visualisations load vis-network, mermaid, and d3 from CDNs. The "self-contained" HTML does not work offline. Above 5,000 nodes the graph is replaced by a community-level aggregate.
- Install friction is a recurring complaint: the PyPI package is `graphifyy`, PATH setup differs per installer, and the skill has to sniff the right Python interpreter at runtime.

## What the market says

Competitors that emerged in 2026 (CodeGraph, GitNexus, codebase-memory-mcp, code-review-graph) all converged on the same shape: TypeScript or a static binary, an embedded database, file watchers, a small MCP tool surface, and a one-shot "explore" tool. Independent measurements favour that shape (58 to 88% fewer tool calls). The gap none of them fill, per the comparisons: generated code, config-driven routing, framework magic, and edges that only exist at build time.

## Consequences for Symbra

1. Real symbol table with kinds, ranges, signatures, docs, and scope-aware resolution. Candidate sets when ambiguous, never a guess.
2. SQLite as the store: incremental per-file upsert, FTS5 over names and docs, no size cap, no whole-file parse on read.
3. Hybrid retrieval: BM25F over typed fields plus personalised PageRank over the graph, packed by marginal relevance under a real token budget, returning source spans.
4. MCP server registered at install. One `explore` tool that answers in a single call, plus a small set of precise tools.
5. Incremental watch that re-indexes only changed files and their dependents.
6. Offline, vendored visualisation served from the store.
7. Framework edges: HTTP routes, tests to subjects, config and env keys.
8. Zero LLM required. Zero native compilation. One command to install.
