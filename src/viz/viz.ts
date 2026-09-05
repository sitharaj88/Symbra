import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Store, SymbolRow } from '../store/db.js';

interface VizNode {
  id: string;
  name: string;
  fqn: string;
  kind: string;
  file: string;
  line: number;
  endLine: number;
  c: number; // community
  pr: number;
  callers: number;
  sig: string;
  doc: string;
  lang: number; // index into VizData.langs
  dir: number; // index into VizData.dirs
}

interface VizData {
  root: string;
  repo: string;
  generated: string;
  stats: { files: number; symbols: number; edges: number; subsystems: number };
  langs: string[];
  dirs: string[];
  communities: { id: number; label: string; size: number; dirs: string[]; peripheral: boolean }[];
  nodes: VizNode[];
  edges: [number, number, string][]; // node index, node index, kind
  commEdges: [number, number, number][]; // community, community, weight
  /** Source text for a symbol, keyed by node index. Present for the highest-PageRank symbols only. */
  bodies: Record<string, string>;
  /** True when the repo was too large to embed and nodes are the top `MAX_NODES` by PageRank. */
  sampled: boolean;
  /** How many symbols carry a community assignment, sampled or not. */
  placed: number;
}

const MAX_NODES = 3000;
/** Byte budget for embedded source bodies. Beyond this the drawer shows a `symbra symbol` hint. */
const BODY_BUDGET = 8 * 1024 * 1024;
/** Bodies are only collected for this many symbols, highest PageRank first. */
const BODY_TOP_N = 5000;
const BODY_MAX_LINES = 80;

export function buildVizData(store: Store, root: string): VizData {
  const comms = store.prep('SELECT community, label, size, dirs, peripheral FROM community_labels WHERE level = 0 ORDER BY size DESC').all() as { community: number; label: string; size: number; dirs: string; peripheral: number }[];
  const communities = comms.map((c) => ({ id: c.community, label: c.label, size: c.size, dirs: JSON.parse(c.dirs) as string[], peripheral: !!c.peripheral }));
  const total = store.countSymbols();
  // Pick nodes: all if small, else top-N by pagerank with a per-community floor.
  const rows = store
    .prep(
      // Every symbol the community layer actually placed. Drilling into a subsystem must show all
      // of its members -- low-importance ones simply render as small, unlabelled dots.
      "SELECT s.*, COALESCE(m.pagerank,0) AS pr, COALESCE(m.callers,0) AS callers, c.community AS comm FROM symbols s LEFT JOIN metrics m ON m.symbol = s.id LEFT JOIN communities c ON c.symbol = s.id AND c.level = 0 WHERE c.community IS NOT NULL ORDER BY pr DESC",
    )
    .all() as (SymbolRow & { pr: number; callers: number; comm: number })[];
  let chosen = rows;
  const sampled = rows.length > MAX_NODES;
  if (sampled) {
    // Guarantee every subsystem a floor of members, then spend what is left on the highest
    // PageRank symbols overall, so the budget is always fully used.
    const FLOOR = 8;
    const perComm = new Map<number, number>();
    const taken = new Set<string>();
    chosen = [];
    for (const r of rows) {
      const n = perComm.get(r.comm) ?? 0;
      if (n >= FLOOR || chosen.length >= MAX_NODES) continue;
      chosen.push(r);
      taken.add(r.id);
      perComm.set(r.comm, n + 1);
    }
    for (const r of rows) {
      if (chosen.length >= MAX_NODES) break;
      if (!taken.has(r.id)) chosen.push(r);
    }
  }
  const langOf = new Map<string, string>();
  for (const f of store.allFiles()) langOf.set(f.path, f.language);
  const langs: string[] = [];
  const langIdx = new Map<string, number>();
  const dirs: string[] = [];
  const dirIdx = new Map<string, number>();
  const intern = (v: string, list: string[], idx: Map<string, number>) => {
    let i = idx.get(v);
    if (i === undefined) {
      i = list.length;
      list.push(v);
      idx.set(v, i);
    }
    return i;
  };
  const index = new Map<string, number>();
  const nodes: VizNode[] = chosen.map((r, i) => {
    index.set(r.id, i);
    const slash = r.file.lastIndexOf('/');
    const dir = slash < 0 ? '.' : r.file.slice(0, slash);
    return {
      id: r.id,
      name: r.name,
      fqn: r.fqn,
      kind: r.kind,
      file: r.file,
      line: r.start_line,
      endLine: r.end_line,
      c: r.comm,
      pr: Math.round(r.pr * 10) / 10,
      callers: r.callers,
      sig: r.signature.slice(0, 320),
      doc: r.doc.split('\n').slice(0, 4).join('\n').slice(0, 400),
      lang: intern(langOf.get(r.file) ?? 'other', langs, langIdx),
      dir: intern(dir, dirs, dirIdx),
    };
  });
  const edges: [number, number, string][] = [];
  const commW = new Map<string, number>();
  const commOf = new Map<string, number>();
  for (const r of store.prep('SELECT symbol, community FROM communities WHERE level = 0').all() as { symbol: string; community: number }[]) commOf.set(r.symbol, r.community);
  for (const e of store.prep("SELECT src, dst, kind FROM edges WHERE kind IN ('calls','imports','extends','implements','references','passes','defines_route')").all() as { src: string; dst: string; kind: string }[]) {
    const a = index.get(e.src);
    const b = index.get(e.dst);
    if (a !== undefined && b !== undefined && a !== b) edges.push([a, b, e.kind]);
    const ca = commOf.get(e.src);
    const cb = commOf.get(e.dst);
    if (ca !== undefined && cb !== undefined && ca !== cb) {
      const k = ca < cb ? `${ca}:${cb}` : `${cb}:${ca}`;
      commW.set(k, (commW.get(k) ?? 0) + 1);
    }
  }
  const commEdges: [number, number, number][] = [...commW.entries()].map(([k, w]) => {
    const [a, b] = k.split(':').map(Number) as [number, number];
    return [a, b, w];
  });
  return {
    root,
    repo: root.split('/').filter(Boolean).pop() ?? 'repo',
    generated: new Date().toISOString(),
    stats: { files: store.allFiles().length, symbols: total, edges: store.countEdges(), subsystems: communities.length },
    langs,
    dirs,
    communities,
    nodes,
    edges,
    commEdges,
    bodies: collectBodies(nodes, root),
    sampled,
    placed: rows.length,
  };
}

/**
 * Read the source text of the highest-PageRank symbols so the drawer can show a body without a
 * network round-trip. Files are read once and shared between the symbols that live in them; the
 * whole collection stops at `BODY_BUDGET` so a huge repo does not produce a huge HTML file.
 */
function collectBodies(nodes: VizNode[], root: string): Record<string, string> {
  const order = nodes.map((_n, i) => i).sort((a, b) => nodes[b]!.pr - nodes[a]!.pr).slice(0, BODY_TOP_N);
  const cache = new Map<string, string[] | null>();
  const out: Record<string, string> = {};
  let bytes = 0;
  for (const i of order) {
    if (bytes >= BODY_BUDGET) break;
    const n = nodes[i]!;
    let lines = cache.get(n.file);
    if (lines === undefined) {
      try {
        lines = readFileSync(join(root, n.file), 'utf8').split('\n');
      } catch {
        lines = null;
      }
      if (cache.size > 400) cache.clear();
      cache.set(n.file, lines);
    }
    if (!lines) continue;
    const body = lines.slice(n.line - 1, Math.min(n.endLine, n.line - 1 + BODY_MAX_LINES)).join('\n');
    if (!body.trim()) continue;
    bytes += body.length + 12;
    out[String(i)] = body;
  }
  return out;
}

export function renderViz(data: VizData): string {
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en" data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(data.repo)} · Symbra map</title>
<style>${CSS}</style></head><body>
<header id="top">
  <div class="brand"><span class="mark"></span><span class="wordmark">Symbra</span></div>
  <div class="sep"></div>
  <nav id="crumbs" aria-label="Breadcrumb"></nav>
  <div class="grow"></div>
  <div id="pills" class="pills"></div>
  <button id="btnFit" class="ghost" title="Fit to view (f)">Fit</button>
  <button id="btnPng" class="ghost" title="Export the map as a PNG">Export PNG</button>
  <button id="btnTheme" class="ghost icon" title="Toggle theme (t)" aria-label="Toggle theme"></button>
</header>
<div id="main">
  <aside id="sidebar">
    <div class="search">
      <input id="q" type="search" placeholder="Search symbols" autocomplete="off" spellcheck="false"><kbd>/</kbd>
    </div>
    <div id="results" class="results" hidden></div>
    <div id="browse">
      <section class="block">
        <h2>Filters</h2>
        <div id="kinds" class="chips"></div>
        <div class="row"><label for="lang">Language</label><select id="lang"></select></div>
        <div class="row"><label for="dir">Directory</label><select id="dir"></select></div>
        <label class="check"><input type="checkbox" id="periph" checked><span>Show peripheral</span></label>
      </section>
      <section class="block grow-block">
        <h2>Subsystems <span id="subCount" class="muted"></span></h2>
        <div id="subs" class="subs"></div>
      </section>
    </div>
  </aside>
  <div id="stage">
    <canvas id="c"></canvas>
    <div id="tip" class="tip" hidden></div>
    <div id="edgekey" class="edgekey" hidden></div>
    <canvas id="mini" class="mini" hidden></canvas>
    <div id="empty" class="empty" hidden></div>
    <div id="hint" class="hint">Click a subsystem to drill in · drag to pan · scroll to zoom · <kbd>/</kbd> to search</div>
  </div>
  <aside id="drawer" aria-hidden="true">
    <div class="dhead">
      <div class="dtitle"><span id="dkind" class="badge"></span><h3 id="dname"></h3></div>
      <button id="dclose" class="ghost icon" aria-label="Close">✕</button>
    </div>
    <div id="dfqn" class="dfqn"></div>
    <div class="tabs" role="tablist">
      <button class="tab on" data-tab="overview" role="tab">Overview</button>
      <button class="tab" data-tab="relations" role="tab">Relations</button>
      <button class="tab" data-tab="source" role="tab">Source</button>
    </div>
    <div id="dbody" class="dbody"></div>
  </aside>
</div>
<script id="data" type="application/json">${json}</script>
<script>${JS}</script>
</body></html>`;
}

const CSS = `
:root{
  --bg:#111114;--panel:#17171b;--elev:#1e1e24;--line:#2a2a31;--line2:#37373f;
  --ink:#ecebe9;--ink2:#b9b7b2;--muted:#8e8b85;--faint:#63615c;
  --accent:#7fa6ff;--accent-ink:#0b0d14;--accent-soft:rgba(127,166,255,.16);
  --shadow:0 10px 30px rgba(0,0,0,.45),0 1px 0 rgba(255,255,255,.03) inset;
  --radius:10px;
  --ui:Inter,-apple-system,"SF Pro Text","Segoe UI",Roboto,sans-serif;
  --mono:"JetBrains Mono","SF Mono",Menlo,Consolas,monospace;
}
html[data-theme=light]{
  --bg:#faf9f7;--panel:#ffffff;--elev:#f3f2ef;--line:#e5e3de;--line2:#d6d3cc;
  --ink:#1b1a18;--ink2:#4a4842;--muted:#6d6a63;--faint:#96938c;
  --accent:#2f57c9;--accent-ink:#ffffff;--accent-soft:rgba(47,87,201,.10);
  --shadow:0 8px 24px rgba(28,26,22,.10),0 0 0 1px rgba(28,26,22,.04);
}
*{box-sizing:border-box}
[hidden]{display:none!important}
html,body{margin:0;height:100%;overflow:hidden}
body{background:var(--bg);color:var(--ink);font:13px/1.5 var(--ui);-webkit-font-smoothing:antialiased;display:flex;flex-direction:column}
button,input,select{font:inherit;color:inherit}
kbd{font:11px/1 var(--mono);border:1px solid var(--line2);border-bottom-width:2px;border-radius:4px;padding:2px 4px;color:var(--muted);background:var(--elev)}
.grow{flex:1}
.muted{color:var(--muted)}

/* top bar */
#top{height:48px;flex:none;display:flex;align-items:center;gap:10px;padding:0 12px;background:var(--panel);border-bottom:1px solid var(--line);position:relative;z-index:6}
.brand{display:flex;align-items:center;gap:8px}
.mark{width:16px;height:16px;border-radius:5px;background:conic-gradient(from 140deg,var(--accent),#c79bff,#3fcdb4,var(--accent));box-shadow:0 0 0 1px rgba(255,255,255,.10) inset}
.wordmark{font-weight:640;letter-spacing:-.01em}
.sep{width:1px;height:18px;background:var(--line)}
#crumbs{display:flex;align-items:center;gap:6px;min-width:0;font-size:12.5px}
#crumbs button{background:none;border:0;padding:2px 4px;border-radius:6px;color:var(--ink2);cursor:pointer;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#crumbs button:hover{background:var(--elev);color:var(--ink)}
#crumbs button.cur{color:var(--ink);font-weight:560;cursor:default}
#crumbs button.cur:hover{background:none}
#crumbs .chev{color:var(--faint);font-size:11px}
.pills{display:flex;gap:6px}
.pill{display:inline-flex;gap:5px;align-items:center;background:var(--elev);border:1px solid var(--line);border-radius:999px;padding:3px 9px;font-size:11.5px;color:var(--muted);white-space:nowrap}
.pill b{color:var(--ink2);font-weight:580;font-variant-numeric:tabular-nums}
button.ghost{background:var(--elev);border:1px solid var(--line);border-radius:8px;padding:5px 10px;cursor:pointer;color:var(--ink2)}
button.ghost:hover{border-color:var(--line2);color:var(--ink)}
button.ghost.icon{padding:5px 8px;line-height:1}

/* layout */
#main{flex:1;display:flex;min-height:0;position:relative}
#sidebar{width:284px;flex:none;background:var(--panel);border-right:1px solid var(--line);display:flex;flex-direction:column;min-height:0;z-index:4}
.search{position:relative;padding:10px;border-bottom:1px solid var(--line);flex:none}
.search input{width:100%;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:7px 34px 7px 10px;outline:none}
html[data-theme=light] .search input{background:var(--elev)}
.search input:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
.search input::-webkit-search-cancel-button{display:none}
.search kbd{position:absolute;right:18px;top:17px;pointer-events:none}
.search input:focus + kbd{opacity:0}
#browse,.results{overflow:auto;flex:1;min-height:0}
#browse{display:flex;flex-direction:column}
.block{padding:12px 10px;border-bottom:1px solid var(--line)}
.block.grow-block{flex:1;min-height:0;display:flex;flex-direction:column;border-bottom:0;padding-bottom:0}
.block h2{margin:0 0 8px;font-size:10.5px;letter-spacing:.09em;text-transform:uppercase;color:var(--faint);font-weight:600;display:flex;gap:6px;align-items:baseline}
.chips{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:10px}
.chip{border:1px solid var(--line);background:var(--bg);border-radius:999px;padding:2.5px 8px;font-size:11.5px;color:var(--muted);cursor:pointer;white-space:nowrap}
html[data-theme=light] .chip{background:var(--elev)}
.chip:hover{border-color:var(--line2);color:var(--ink2)}
.chip.on{background:var(--accent);border-color:var(--accent);color:var(--accent-ink);font-weight:560}
.row{display:flex;align-items:center;gap:8px;margin:6px 0}
.row label{width:66px;flex:none;color:var(--muted);font-size:12px}
.row select{flex:1;min-width:0;background:var(--bg);border:1px solid var(--line);border-radius:7px;padding:4px 6px;outline:none}
html[data-theme=light] .row select{background:var(--elev)}
.check{display:flex;align-items:center;gap:7px;margin-top:9px;color:var(--ink2);cursor:pointer;font-size:12.5px}
.check input{accent-color:var(--accent)}

/* subsystem list */
.subs{overflow:auto;flex:1;min-height:0;padding-bottom:10px}
.sub{display:grid;grid-template-columns:9px 1fr auto;gap:8px;align-items:center;padding:6px 8px;border-radius:8px;cursor:pointer}
.sub:hover{background:var(--elev)}
.sub.on{background:var(--accent-soft);box-shadow:inset 0 0 0 1px var(--accent)}
.sub .sw{width:9px;height:9px;border-radius:3px}
.sub .nm{min-width:0;overflow:hidden}
.sub .nm .t{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12.5px}
.sub .bar{height:3px;border-radius:2px;margin-top:4px;background:var(--line);overflow:hidden}
.sub .bar i{display:block;height:100%;border-radius:2px}
.sub .n{font-size:11px;color:var(--muted);font-variant-numeric:tabular-nums}
.sub.periph{opacity:.62}
.sub.periph .n::after{content:" ·p";color:var(--faint)}

/* search results */
.results{padding:6px}
.res{padding:6px 8px;border-radius:8px;cursor:pointer;display:flex;gap:8px;align-items:baseline}
.res .sw{width:7px;height:7px;border-radius:2px;flex:none;transform:translateY(-1px)}
.res .txt{min-width:0;flex:1}
.res .t,.res .f{display:block}
.res .t{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12.5px}
.res .t em{font-style:normal;color:var(--accent);font-weight:620}
.res .f{font:10.5px/1.4 var(--mono);color:var(--faint);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.res.on,.res:hover{background:var(--elev)}
.res.on{box-shadow:inset 0 0 0 1px var(--line2)}
.nores{padding:26px 14px;text-align:center;color:var(--muted)}
.nores b{display:block;color:var(--ink2);margin-bottom:4px}

/* stage */
#stage{flex:1;position:relative;min-width:0;overflow:hidden}
#stage.with-drawer .mini{right:414px}
#stage.with-drawer .hint{transform:translateX(-50%) translateX(-200px)}
canvas#c{display:block;width:100%;height:100%;cursor:grab}
canvas#c.grabbing{cursor:grabbing}
canvas#c.point{cursor:pointer}
.tip{position:absolute;z-index:5;pointer-events:none;background:var(--panel);border:1px solid var(--line2);border-radius:9px;padding:7px 10px;box-shadow:var(--shadow);max-width:320px}
.tip .t{font-weight:600;font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tip .m{color:var(--muted);font-size:11px;margin-top:2px}
.tip .f{font:10.5px/1.4 var(--mono);color:var(--faint);margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.edgekey{position:absolute;left:14px;bottom:14px;z-index:4;background:color-mix(in srgb,var(--panel) 88%,transparent);border:1px solid var(--line);border-radius:10px;padding:8px 10px;backdrop-filter:blur(8px);display:flex;flex-wrap:wrap;gap:4px 12px;max-width:420px}
.edgekey span{display:inline-flex;align-items:center;gap:6px;font-size:11px;color:var(--muted)}
.edgekey i{width:14px;height:2px;border-radius:2px}
.mini{position:absolute;right:14px;transition:right .26s cubic-bezier(.22,.7,.3,1);bottom:14px;z-index:4;width:168px;height:118px;border:1px solid var(--line);border-radius:10px;background:color-mix(in srgb,var(--panel) 86%,transparent);cursor:crosshair;box-shadow:var(--shadow)}
.hint{position:absolute;left:50%;transition:opacity .3s,transform .26s;transform:translateX(-50%);bottom:14px;z-index:3;color:var(--faint);font-size:11.5px;pointer-events:none;transition:opacity .3s}
.hint.gone{opacity:0}
.empty{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;text-align:center;color:var(--muted);z-index:3;pointer-events:none;padding:40px}
.empty b{color:var(--ink2);font-size:14px}

/* drawer */
#drawer{position:absolute;top:0;right:0;bottom:0;width:400px;background:var(--panel);border-left:1px solid var(--line);box-shadow:var(--shadow);z-index:5;display:flex;flex-direction:column;transform:translateX(102%);transition:transform .26s cubic-bezier(.22,.7,.3,1);will-change:transform}
#drawer.open{transform:none}
.dhead{display:flex;align-items:flex-start;gap:8px;padding:12px 12px 0}
.dtitle{flex:1;min-width:0;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dhead h3{margin:0;font-size:15px;font-weight:620;word-break:break-word;line-height:1.25}
.badge{font-size:10.5px;letter-spacing:.05em;text-transform:uppercase;font-weight:640;border-radius:5px;padding:2px 6px;border:1px solid;white-space:nowrap}
.dfqn{padding:4px 12px 10px;font:11px/1.45 var(--mono);color:var(--faint);word-break:break-all}
.tabs{display:flex;gap:2px;padding:0 10px;border-bottom:1px solid var(--line);flex:none}
.tab{background:none;border:0;border-bottom:2px solid transparent;padding:7px 9px;margin-bottom:-1px;color:var(--muted);cursor:pointer;font-size:12.5px}
.tab:hover{color:var(--ink2)}
.tab.on{color:var(--ink);border-bottom-color:var(--accent);font-weight:560}
.dbody{overflow:auto;flex:1;min-height:0;padding:12px}
.dbody h4{margin:16px 0 6px;font-size:10.5px;letter-spacing:.09em;text-transform:uppercase;color:var(--faint);font-weight:600}
.dbody h4:first-child{margin-top:0}
.dbody a{color:var(--accent);text-decoration:none}
.dbody a:hover{text-decoration:underline}
.sig{font:11.5px/1.55 var(--mono);background:var(--elev);border:1px solid var(--line);border-radius:8px;padding:8px 10px;white-space:pre-wrap;word-break:break-word;color:var(--ink2)}
.doc{color:var(--ink2);white-space:pre-wrap}
.meter{display:flex;align-items:center;gap:9px;margin-top:2px}
.meter .track{flex:1;height:6px;border-radius:3px;background:var(--elev);overflow:hidden;border:1px solid var(--line)}
.meter .track i{display:block;height:100%;background:linear-gradient(90deg,var(--accent),#c79bff)}
.meter .v{font:11px/1 var(--mono);color:var(--muted);font-variant-numeric:tabular-nums}
.facts{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font-size:12.5px}
.facts dt{color:var(--muted)}
.facts dd{margin:0;color:var(--ink2);word-break:break-all}
.rel{margin-bottom:4px}
.relh{display:flex;align-items:center;gap:7px;font-size:11.5px;color:var(--muted);margin:12px 0 5px}
.relh i{width:12px;height:2px;border-radius:2px}
.relh b{color:var(--ink2);font-weight:560}
.rl{list-style:none;margin:0;padding:0}
.rl li{display:flex;gap:7px;align-items:baseline;padding:3px 6px;border-radius:6px;cursor:pointer}
.rl li:hover{background:var(--elev)}
.rl .sw{width:7px;height:7px;border-radius:2px;flex:none}
.rl .t{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12.5px}
.rl .k{font-size:10.5px;color:var(--faint);font-family:var(--mono)}
.src{font:11.5px/1.55 var(--mono);background:var(--elev);border:1px solid var(--line);border-radius:8px;padding:10px 0;overflow:auto;max-height:none;color:var(--ink2)}
.src .ln{display:block;padding:0 12px 0 0;white-space:pre}
.src .g{display:inline-block;width:44px;text-align:right;padding-right:12px;color:var(--faint);user-select:none}
.t-k{color:#c79bff;font-weight:560}
.t-s{color:#8fd694}
.t-c{color:var(--faint);font-style:italic}
.t-n{color:#f5c65b}
.t-f{color:#6e9bff}
html[data-theme=light] .t-k{color:#7b3fbe}
html[data-theme=light] .t-s{color:#1d7a3f}
html[data-theme=light] .t-c{color:#8a877f}
html[data-theme=light] .t-n{color:#9a6800}
html[data-theme=light] .t-f{color:#2f57c9}
.note{color:var(--muted);background:var(--elev);border:1px dashed var(--line2);border-radius:8px;padding:10px}
.note code{font:11.5px var(--mono);color:var(--ink2)}
::-webkit-scrollbar{width:10px;height:10px}
::-webkit-scrollbar-thumb{background:var(--line);border-radius:6px;border:3px solid transparent;background-clip:padding-box}
::-webkit-scrollbar-thumb:hover{background:var(--line2);background-clip:padding-box;border:3px solid transparent}
::-webkit-scrollbar-track{background:transparent}
@media (max-width:900px){#sidebar{width:230px}#drawer{width:min(400px,86vw)}.pills{display:none}}
`;

/**
 * The client. Written as plain ES5-ish JavaScript with no template literals so it can live inside
 * this file's own template literal without escaping games.
 */
const JS = String.raw`
(function(){
'use strict';
var D=JSON.parse(document.getElementById('data').textContent);
var $=function(id){return document.getElementById(id)};
var cv=$('c'),ctx=cv.getContext('2d'),stage=$('stage'),drawer=$('drawer'),tip=$('tip'),mini=$('mini'),mctx=mini.getContext('2d');

/* ---------------------------------------------------------------- theme */
var THEMES={
  dark:{bg:'#111114',hull:.06,edge:'138,136,130',ink:'#ecebe9',ink2:'#b9b7b2',muted:'#8e8b85',faint:'#63615c',line:'#2a2a31',accent:'#7fa6ff',halo:'#ffffff',
    pal:['#6E9BFF','#FF9D5C','#3FCDB4','#FF87BE','#B6D65C','#B79CFF','#F5C65B','#56C8EA','#FF7A7A','#5FD08A','#E48BE8','#93B2D8']},
  light:{bg:'#faf9f7',hull:.08,edge:'109,106,99',ink:'#1b1a18',ink2:'#4a4842',muted:'#6d6a63',faint:'#96938c',line:'#e5e3de',accent:'#2f57c9',halo:'#1b1a18',
    pal:['#2F57C9','#B8560A','#0E7F6B','#B93375','#5C7A0E','#6B45C9','#96700A','#0A6E93','#C0362F','#237A45','#933D96','#41608C']}
};
var theme='dark',booted=false;
try{var st=localStorage.getItem('symbra-theme');if(st==='light'||st==='dark')theme=st;
    else if(window.matchMedia&&matchMedia('(prefers-color-scheme: light)').matches)theme='light';}catch(e){}
function T(){return THEMES[theme]}
function applyTheme(){document.documentElement.setAttribute('data-theme',theme);
  $('btnTheme').textContent=theme==='dark'?'☾':'☀';
  colCache={};
  if(booted){buildSubs();buildEdgeKey();if(query)renderResults();if(sel!=null)renderDrawer()}
  requestDraw()}
function toggleTheme(){theme=theme==='dark'?'light':'dark';try{localStorage.setItem('symbra-theme',theme)}catch(e){}applyTheme()}

/* ------------------------------------------------------- colour helpers */
function hex2rgb(h){return [parseInt(h.slice(1,3),16),parseInt(h.slice(3,5),16),parseInt(h.slice(5,7),16)]}
function rgb2hsl(r,g,b){r/=255;g/=255;b/=255;var mx=Math.max(r,g,b),mn=Math.min(r,g,b),h=0,s=0,l=(mx+mn)/2,d=mx-mn;
  if(d){s=l>.5?d/(2-mx-mn):d/(mx+mn);h=mx===r?(g-b)/d+(g<b?6:0):mx===g?(b-r)/d+2:(r-g)/d+4;h/=6}return [h,s,l]}
function hsl2css(h,s,l,a){return 'hsla('+(h*360).toFixed(1)+','+(s*100).toFixed(1)+'%,'+(l*100).toFixed(1)+'%,'+a+')'}
var colCache={};
/* One curated 12-hue palette. Communities past 12 reuse the hues with a lightness/chroma shift so
   a 96-subsystem repo still reads as distinct families rather than a rainbow. */
function hsl(cid,peripheral){
  var key=cid+'|'+(peripheral?1:0)+'|'+theme;var v=colCache[key];if(v)return v;
  var pal=T().pal;var base=pal[((cid%pal.length)+pal.length)%pal.length];
  var c=rgb2hsl.apply(null,hex2rgb(base));var cyc=Math.floor(Math.abs(cid)/pal.length)%3;
  var h=c[0],s=c[1],l=c[2];
  if(cyc===1){l=theme==='dark'?Math.min(.86,l+.13):Math.max(.20,l-.11);s=Math.max(.18,s-.14)}
  else if(cyc===2){l=theme==='dark'?Math.max(.36,l-.13):Math.min(.62,l+.10);s=Math.min(.95,s+.10);h=(h+.02)%1}
  if(peripheral){s*=.58;l=theme==='dark'?l*.88:Math.min(.62,l+.10)}
  v=colCache[key]=[h,s,l];return v}
function col(cid,a,peripheral){var c=hsl(cid,peripheral);return hsl2css(c[0],c[1],c[2],a===undefined?1:a)}
function colL(cid,dl,a,peripheral){var c=hsl(cid,peripheral);return hsl2css(c[0],c[1],Math.max(0,Math.min(1,c[2]+dl)),a===undefined?1:a)}

var EK=[['calls','#8e8b85',.30],['imports','#6E9BFF',.42],['extends','#5FD08A',.55],['implements','#5FD08A',.55],['passes','#F5C65B',.42],['references','#B79CFF',.30],['defines_route','#FF9D5C',.5]];
var EKMAP={};for(var i=0;i<EK.length;i++)EKMAP[EK[i][0]]=EK[i];
function ekColor(k,a){var e=EKMAP[k];var c=e?e[1]:'#8e8b85';var rgb=hex2rgb(c);
  if(theme==='light'){var h=rgb2hsl(rgb[0],rgb[1],rgb[2]);return hsl2css(h[0],Math.min(1,h[1]*1.05),Math.max(.28,h[2]*.62),a)}
  return 'rgba('+rgb[0]+','+rgb[1]+','+rgb[2]+','+a+')'}
function ekAlpha(k){var e=EKMAP[k];return e?e[2]:.3}

/* ------------------------------------------------------------- indexes */
var byComm={};for(var i=0;i<D.nodes.length;i++){var cc=D.nodes[i].c;(byComm[cc]||(byComm[cc]=[])).push(i)}
var commById={};for(var i=0;i<D.communities.length;i++)commById[D.communities[i].id]=D.communities[i];
var adj={};/* gi -> [otherGi, kind, dir(0=out,1=in)] */
for(var i=0;i<D.edges.length;i++){var e=D.edges[i];(adj[e[0]]||(adj[e[0]]=[])).push([e[1],e[2],0]);(adj[e[1]]||(adj[e[1]]=[])).push([e[0],e[2],1])}
var maxPR=1;for(var i=0;i<D.nodes.length;i++)if(D.nodes[i].pr>maxPR)maxPR=D.nodes[i].pr;

/* Stored subsystem labels are top identifier tokens ("httpx: client request error"), which reads
   like a word cloud. When a label is nothing but two or three bare tokens, rebuild it at display
   time from the data already embedded: the subsystem's dominant location plus its two most
   important symbols -> "httpx/_client - Client, AsyncClient". Purely cosmetic; the stored label
   is left alone. */
var HEADKIND={"class":3,"interface":3,"struct":3,"trait":3,"component":3,"enum":2.4,"type":2,"type_alias":2,"namespace":2,"module":2,"function":1.4,"constructor":.6,"method":.5,"property":.2,"field":.1,"variable":.1,"constant":.1,"enum_member":.05};
var labelCache={};
function labelOf(c){
  var v=labelCache[c.id];if(v!==undefined)return v;
  v=c.label;
  var bare=/^(?:.+?:\s*)?[A-Za-z0-9_]+(?:\s+[A-Za-z0-9_]+){1,2}$/.test(c.label);
  var ids=byComm[c.id]||[];
  if(bare&&ids.length){
    /* Weight by importance, not by head count: a 60-member enum should not out-vote the class
       the subsystem is actually named after. */
    var fc={},dc={},bf='',bfn=0,bd='',bdn=0,tot=0;
    for(var i=0;i<ids.length;i++){var n=D.nodes[ids[i]];
      var kw=HEADKIND[n.kind];var w=(n.pr+n.callers*.35+.15)*(kw===undefined?1:kw);
      var f=n.file,d=D.dirs[n.dir];tot+=w;
      fc[f]=(fc[f]||0)+w;dc[d]=(dc[d]||0)+w;
      if(fc[f]>bfn){bfn=fc[f];bf=f}
      if(dc[d]>bdn){bdn=dc[d];bd=d}}
    /* one file carrying most of the subsystem's weight is more telling than its directory */
    var loc=(bfn>=tot*.4)?bf.replace(/\.[A-Za-z0-9]+$/,''):bd;
    if(!loc||loc==='.')loc=(c.dirs&&c.dirs[0])||'';
    var order=ids.slice().sort(function(a,b){
      var A=D.nodes[a],B=D.nodes[b];
      var ka=HEADKIND[A.kind],kb=HEADKIND[B.kind];
      return (B.pr+B.callers*.35)*(kb===undefined?1:kb)-(A.pr+A.callers*.35)*(ka===undefined?1:ka)});
    var names=[],seen={};
    for(var i=0;i<order.length&&names.length<2;i++){var nm=D.nodes[order[i]].name;
      if(!nm||seen[nm])continue;seen[nm]=1;names.push(nm)}
    if(loc&&names.length)v=loc+' \u00b7 '+names.join(', ');
    else if(names.length)v=names.join(', ')}
  labelCache[c.id]=v;return v}
var kindList=[];var seenK={};for(var i=0;i<D.nodes.length;i++){var k=D.nodes[i].kind;if(!seenK[k]){seenK[k]=1;kindList.push(k)}}kindList.sort();

/* --------------------------------------------------------------- state */
var view={x:0,y:0,k:1};
var mode='comm';        /* 'comm' | 'sym' */
var focus=null;         /* community id at symbol level */
var nodes=[],links=[],hulls=[];
var sel=null,hover=null,hoverSub=null;
var query='',results=[],resSel=-1;
var fKinds={},fLang='',fDir='',showPeriph=true;
var W=0,H=0,dpr=1;
var dirty=false,anim=null;
var tab='overview';

/* -------------------------------------------------------------- sizing */
function resize(){
  var r=stage.getBoundingClientRect();W=Math.max(1,r.width);H=Math.max(1,r.height);
  dpr=Math.min(2.5,window.devicePixelRatio||1);
  cv.width=Math.round(W*dpr);cv.height=Math.round(H*dpr);
  ctx.setTransform(dpr,0,0,dpr,0,0);
  mini.width=168*dpr;mini.height=118*dpr;mctx.setTransform(dpr,0,0,dpr,0,0);
  requestDraw()}
addEventListener('resize',resize);

function requestDraw(){if(dirty)return;dirty=true;requestAnimationFrame(function(){dirty=false;draw()})}

/* ------------------------------------------------------------- layout */
/* Uniform-grid repulsion keeps the symbol level usable for a 2,000-symbol subsystem: only
   neighbours in adjacent cells push on each other, so it is O(n) per iteration, not O(n^2). */
function repelGrid(ns,rep,minGap){
  var n=ns.length;if(n<2)return;
  var cell=0;for(var i=0;i<n;i++)cell=Math.max(cell,ns[i].r);cell=Math.max(28,cell*2+minGap);
  var g={};
  for(var i=0;i<n;i++){var p=ns[i];var cx=Math.floor(p.x/cell),cy=Math.floor(p.y/cell);var key=cx+','+cy;(g[key]||(g[key]=[])).push(i)}
  for(var key in g){
    var parts=key.split(','),cx=+parts[0],cy=+parts[1];
    var mine=g[key];
    for(var ox=0;ox<=1;ox++)for(var oy=(ox===0?0:-1);oy<=1;oy++){
      var other=g[(cx+ox)+','+(cy+oy)];if(!other)continue;
      var same=(ox===0&&oy===0);
      for(var a=0;a<mine.length;a++){var A=ns[mine[a]];
        for(var b=same?a+1:0;b<other.length;b++){var B=ns[other[b]];if(A===B)continue;
          var dx=A.x-B.x,dy=A.y-B.y,d2=dx*dx+dy*dy+.01;var d=Math.sqrt(d2);
          var sizeK=1+(A.r+B.r)*.05;var f=rep*sizeK/d2;var fx=dx*f,fy=dy*f;
          var minSep=A.r+B.r+minGap+(A.r+B.r)*.16;
          if(d<minSep){var push=(minSep-d)*2.2;fx+=dx/d*push;fy+=dy/d*push}
          A.vx+=fx;A.vy+=fy;B.vx-=fx;B.vy-=fy}}}}}

function relax(ns,minGap,sweeps){
  var n=ns.length;if(n<2)return;
  var cell=0;for(var i=0;i<n;i++)cell=Math.max(cell,ns[i].r);cell=Math.max(24,cell*2+minGap);
  for(var s=0;s<sweeps;s++){
    var g={},any=false;
    for(var i=0;i<n;i++){var p=ns[i];var key=Math.floor(p.x/cell)+','+Math.floor(p.y/cell);(g[key]||(g[key]=[])).push(i)}
    for(var key in g){var parts=key.split(','),cx=+parts[0],cy=+parts[1];var mine=g[key];
      for(var ox=0;ox<=1;ox++)for(var oy=(ox===0?0:-1);oy<=1;oy++){
        var other=g[(cx+ox)+','+(cy+oy)];if(!other)continue;var same=(ox===0&&oy===0);
        for(var a=0;a<mine.length;a++){var A=ns[mine[a]];
          for(var b=same?a+1:0;b<other.length;b++){var B=ns[other[b]];if(A===B)continue;
            var minD=A.r+B.r+minGap+(A.r+B.r)*.16,dx=B.x-A.x,dy=B.y-A.y,d=Math.sqrt(dx*dx+dy*dy);
            if(d<1e-3){dx=Math.cos(a*7+b*13);dy=Math.sin(a*7+b*13);d=1e-3}
            if(d<minD){var ov=(minD-d)/2,ux=dx/d,uy=dy/d;A.x-=ux*ov;A.y-=uy*ov;B.x+=ux*ov;B.y+=uy*ov;any=true}}}}}
    if(!any)break}}

function clamp(v,m){return v>m?m:(v<-m?-m:(v===v?v:0))}
function seedPhyllotaxis(ns,idxs,R,rot){
  var n=idxs.length||1;
  for(var k=0;k<idxs.length;k++){var p=ns[idxs[k]];var a=k*2.399963+(rot||0);var r=R*Math.sqrt((k+.5)/n);
    p.x=Math.cos(a)*r;p.y=Math.sin(a)*r;p.vx=0;p.vy=0}}

function layoutComm(ns,ls,iters){
  var n=ns.length;if(!n)return;
  var coreIdx=[],periphIdx=[];
  for(var i=0;i<n;i++)(ns[i].peripheral?periphIdx:coreIdx).push(i);
  if(!coreIdx.length){coreIdx=periphIdx;periphIdx=[]}
  var deg={};for(var i=0;i<ls.length;i++){var a=ls[i][0],b=ls[i][1];if(!ns[a].peripheral&&!ns[b].peripheral){deg[a]=(deg[a]||0)+1;deg[b]=(deg[b]||0)+1}}
  var linked=[],unlinked=[];for(var i=0;i<coreIdx.length;i++)((deg[coreIdx[i]]||0)>0?linked:unlinked).push(coreIdx[i]);
  var nl=linked.length||1;var R=Math.sqrt(nl)*30+58;var Rcap=R*1.45;
  seedPhyllotaxis(ns,linked,R,0);
  var coreLinks=[];for(var i=0;i<ls.length;i++)if(!ns[ls[i][0]].peripheral&&!ns[ls[i][1]].peripheral)coreLinks.push(ls[i]);
  var core=[];for(var i=0;i<coreIdx.length;i++)core.push(ns[coreIdx[i]]);
  for(var it=0;it<iters;it++){
    var t=1-it/iters;
    repelGrid(core,760*t+70,12);
    for(var i=0;i<coreLinks.length;i++){var L=coreLinks[i],A=ns[L[0]],B=ns[L[1]];
      var dx=B.x-A.x,dy=B.y-A.y,d=Math.sqrt(dx*dx+dy*dy)+.01;var rest=A.r+B.r+58;var f=(d-rest)*.013*(L[2]||1);
      A.vx+=dx/d*f;A.vy+=dy/d*f;B.vx-=dx/d*f;B.vy-=dy/d*f}
    for(var i=0;i<core.length;i++){var p=core[i];var gk=.030/(1+p.r/26);p.vx-=p.x*gk;p.vy-=p.y*gk;
      p.vx=clamp(p.vx,60);p.vy=clamp(p.vy,60);p.x+=p.vx*.6;p.y+=p.vy*.6;p.vx*=.5;p.vy*=.5}}
  relax(core,12,30);
  /* Most repos have far more subsystems than inter-subsystem links. Rather than let the
     unlinked ones drift, pack them by size around the linked cluster: the result reads as a
     deliberate composition instead of a scatter. */
  if(unlinked.length){
    var placed=[];for(var i=0;i<linked.length;i++)placed.push(ns[linked[i]]);
    var px=0,py=0;
    for(var i=0;i<placed.length;i++){px+=placed[i].x;py+=placed[i].y}
    if(placed.length){px/=placed.length;py/=placed.length}else{px=0;py=0}
    var start=0;for(var i=0;i<placed.length;i++)start=Math.max(start,Math.hypot(placed[i].x-px,placed[i].y-py)+placed[i].r);
    var order=unlinked.slice().sort(function(a,b){return ns[b].r-ns[a].r});
    for(var oi=0;oi<order.length;oi++){
      var p=ns[order[oi]];var gap=12+p.r*.18;
      var rad=Math.max(start+p.r+gap,p.r+gap),ang=oi*2.399963,ok=false;
      for(var tries=0;tries<4000&&!ok;tries++){
        var cx2=px+Math.cos(ang)*rad,cy2=py+Math.sin(ang)*rad;
        ok=true;
        for(var j=0;j<placed.length;j++){var q=placed[j];
          if(Math.hypot(q.x-cx2,q.y-cy2)<q.r+p.r+gap){ok=false;break}}
        if(ok){p.x=cx2;p.y=cy2}else{ang+=.42;rad+=.22}}
      p.vx=0;p.vy=0;placed.push(p)}}
  relax(core,10,14);
  var ccx=0,ccy=0;for(var i=0;i<core.length;i++){ccx+=core[i].x;ccy+=core[i].y}
  if(core.length){ccx/=core.length;ccy/=core.length}
  var coreR=60;for(var i=0;i<core.length;i++){var d=Math.hypot(core[i].x-ccx,core[i].y-ccy)+core[i].r;if(d>coreR)coreR=d}
  var ps=periphIdx.slice().sort(function(x,y){return (ns[y].size||0)-(ns[x].size||0)});
  var maxPR2=0;for(var i=0;i<ps.length;i++)maxPR2=Math.max(maxPR2,ns[ps[i]].r);
  var np=ps.length||1;var ringR=coreR+maxPR2+26;
  for(var k=0;k<ps.length;k++){var p=ns[ps[k]];var a=(k/np)*6.283185+.45;var jit=(k%2)*(maxPR2*.9+10);
    p.x=ccx+Math.cos(a)*(ringR+jit);p.y=ccy+Math.sin(a)*(ringR+jit);p.vx=0;p.vy=0}
  var pn=[];for(var i=0;i<ps.length;i++)pn.push(ns[ps[i]]);
  for(var s=0;s<24;s++){
    for(var i=0;i<pn.length;i++){var A=pn[i];var dO=Math.hypot(A.x-ccx,A.y-ccy)||1e-3;var minF=coreR+A.r+18;
      if(dO<minF){A.x=ccx+(A.x-ccx)/dO*minF;A.y=ccy+(A.y-ccy)/dO*minF}}
    relax(pn,10,1)}
}

function layoutSym(ns,ls,iters){
  var n=ns.length;if(!n)return;
  var all=[];for(var i=0;i<n;i++)all.push(i);
  var R=Math.sqrt(n)*26+70;
  seedPhyllotaxis(ns,all,R,0);
  var ctxNodes=[];for(var i=0;i<n;i++)if(ns[i].ctx)ctxNodes.push(i);
  var coreArr=[],ctxArr=[];
  for(var i=0;i<n;i++)(ns[i].ctx?ctxArr:coreArr).push(ns[i]);
  var coreLinks=[];for(var i=0;i<ls.length;i++)if(!ns[ls[i][0]].ctx&&!ns[ls[i][1]].ctx)coreLinks.push(ls[i]);
  for(var it=0;it<iters;it++){
    var t=1-it/iters;
    repelGrid(coreArr,900*t+90,16);
    for(var i=0;i<coreLinks.length;i++){var L=coreLinks[i],A=ns[L[0]],B=ns[L[1]];
      var dx=B.x-A.x,dy=B.y-A.y,d=Math.sqrt(dx*dx+dy*dy)+.01;var rest=A.r+B.r+34;var f=(d-rest)*.022;
      A.vx+=dx/d*f;A.vy+=dy/d*f;B.vx-=dx/d*f;B.vy-=dy/d*f}
    for(var i=0;i<coreArr.length;i++){var p=coreArr[i];p.vx-=p.x*.005;p.vy-=p.y*.005;
      p.vx=clamp(p.vx,45);p.vy=clamp(p.vy,45);p.x+=p.vx*.6;p.y+=p.vy*.6;p.vx*=.5;p.vy*=.5}}
  relax(coreArr,14,20);
  if(ctxArr.length){
    /* context nodes from neighbouring subsystems: park them on a ring, angled toward whichever
       core node they actually connect to, then group them by community so the hulls read. */
    var cx=0,cy=0;for(var i=0;i<coreArr.length;i++){cx+=coreArr[i].x;cy+=coreArr[i].y}
    if(coreArr.length){cx/=coreArr.length;cy/=coreArr.length}
    var rad=90;for(var i=0;i<coreArr.length;i++)rad=Math.max(rad,Math.hypot(coreArr[i].x-cx,coreArr[i].y-cy));
    var groups={};for(var i=0;i<ctxArr.length;i++){(groups[ctxArr[i].c]||(groups[ctxArr[i].c]=[])).push(ctxArr[i])}
    var keys=Object.keys(groups);
    /* order groups by the mean angle of their attachment points so nearby work stays nearby */
    var ordered=keys.map(function(kk){
      var g=groups[kk],sx=0,sy=0,m=0;
      for(var i=0;i<g.length;i++){var an=g[i].anchor;if(an){sx+=an.x-cx;sy+=an.y-cy;m++}}
      return {k:kk,a:m?Math.atan2(sy,sx):0}}).sort(function(a,b){return a.a-b.a});
    var span=6.283185/Math.max(1,ordered.length);
    for(var gi=0;gi<ordered.length;gi++){
      var g=groups[ordered[gi].k];var a0=ordered[gi].a;
      var rows=Math.max(1,Math.ceil(g.length/8));
      var step=Math.min(.22,span*.8/Math.max(1,Math.ceil(g.length/rows)));
      for(var i=0;i<g.length;i++){
        var col2=Math.floor(i/rows);
        var a=a0+(col2-(Math.ceil(g.length/rows)-1)/2)*step;
        var rr=rad+110+(i%rows)*34;
        g[i].x=cx+Math.cos(a)*rr;g[i].y=cy+Math.sin(a)*rr;g[i].vx=0;g[i].vy=0}}
    relax(ns,14,18);
    var lim=rad+330;
    for(var i=0;i<ctxArr.length;i++){var p=ctxArr[i];
      var d=Math.hypot(p.x-cx,p.y-cy);
      if(d>lim){p.x=cx+(p.x-cx)/d*lim;p.y=cy+(p.y-cy)/d*lim}}}
}

/* Andrew monotone chain, then a rounded offset outline. */
function convexHull(pts){
  if(pts.length<3)return null;
  var p=pts.slice().sort(function(a,b){return a[0]-b[0]||a[1]-b[1]});
  function cross(o,a,b){return (a[0]-o[0])*(b[1]-o[1])-(a[1]-o[1])*(b[0]-o[0])}
  var lo=[],up=[];
  for(var i=0;i<p.length;i++){while(lo.length>=2&&cross(lo[lo.length-2],lo[lo.length-1],p[i])<=0)lo.pop();lo.push(p[i])}
  for(var i=p.length-1;i>=0;i--){while(up.length>=2&&cross(up[up.length-2],up[up.length-1],p[i])<=0)up.pop();up.push(p[i])}
  lo.pop();up.pop();var h=lo.concat(up);
  return h.length>=3?h:null}

/* ------------------------------------------------------ scene building */
function buildComm(){
  mode='comm';focus=null;sel=null;closeDrawer();hideTip();hover=-1;
  var cs=D.communities.filter(function(c){return showPeriph||!c.peripheral});
  if(!cs.length)cs=D.communities;
  nodes=cs.map(function(c){
    var base=c.size<3?7:9+Math.sqrt(c.size)*2.4;
    return {kind:'comm',c:c.id,label:labelOf(c),size:c.size,peripheral:c.peripheral,comm:c,
            r:Math.max(5,c.peripheral?base*.68:base),x:0,y:0,vx:0,vy:0}});
  var pos={};for(var i=0;i<cs.length;i++)pos[cs[i].id]=i;
  links=[];
  for(var i=0;i<D.commEdges.length;i++){var e=D.commEdges[i];
    if(pos[e[0]]!==undefined&&pos[e[1]]!==undefined)links.push([pos[e[0]],pos[e[1]],Math.min(3.2,Math.log2(e[2]+1)),'',e[2]])}
  layoutComm(nodes,links,320);
  hulls=[];buildGrid();
  syncChrome();setHash('');
  fit(false);}

function buildSym(cid,animate){
  mode='sym';focus=cid;sel=null;hideTip();hover=-1;closeDrawer();
  var ids=(byComm[cid]||[]).slice();
  var localOf={};
  nodes=[];
  for(var i=0;i<ids.length;i++){var gi=ids[i];var n=D.nodes[gi];
    localOf[gi]=nodes.length;
    nodes.push({kind:'sym',gi:gi,n:n,c:n.c,ctx:false,r:2.6+Math.min(15,Math.sqrt(n.pr+n.callers)*1.7),x:0,y:0,vx:0,vy:0})}
  /* pull in the strongest outside neighbours so cross-subsystem structure is visible */
  var candidates={};
  for(var i=0;i<ids.length;i++){var rows=adj[ids[i]]||[];
    for(var j=0;j<rows.length;j++){var g=rows[j][0];if(localOf[g]!==undefined)continue;
      var e=candidates[g]||(candidates[g]={n:0,anchor:ids[i]});e.n++}}
  var ctxIds=Object.keys(candidates).map(Number).sort(function(a,b){
    var d=candidates[b].n-candidates[a].n;return d||(D.nodes[b].pr-D.nodes[a].pr)}).slice(0,ids.length>600?24:48);
  for(var i=0;i<ctxIds.length;i++){var gi=ctxIds[i];var n=D.nodes[gi];
    localOf[gi]=nodes.length;
    nodes.push({kind:'sym',gi:gi,n:n,c:n.c,ctx:true,r:2.8+Math.min(9,Math.sqrt(n.pr+n.callers)*1.1),x:0,y:0,vx:0,vy:0})}
  links=[];
  for(var i=0;i<D.edges.length;i++){var e=D.edges[i];var a=localOf[e[0]],b=localOf[e[1]];
    if(a!==undefined&&b!==undefined&&a!==b&&!(nodes[a].ctx&&nodes[b].ctx))links.push([a,b,1,e[2]])}
  /* anchors: where a context node attaches to the core */
  for(var i=0;i<links.length;i++){var L=links[i],A=nodes[L[0]],B=nodes[L[1]];
    if(A.ctx&&!B.ctx&&!A.anchor)A.anchor=B;if(B.ctx&&!A.ctx&&!B.anchor)B.anchor=A}
  layoutSym(nodes,links,ids.length>900?140:280);
  computeHulls();buildGrid();
  syncChrome();setHash('c='+cid);
  fit(animate!==false);}

function computeHulls(){
  hulls=[];
  if(mode!=='sym')return;
  var g={};for(var i=0;i<nodes.length;i++){var p=nodes[i];(g[p.c]||(g[p.c]=[])).push(p)}
  for(var key in g){var arr=g[key];if(arr.length<3)continue;
    var pts=[];for(var i=0;i<arr.length;i++){var p=arr[i];
      /* sample the circle so the hull wraps the disc, not just the centre */
      for(var a=0;a<6;a++)pts.push([p.x+Math.cos(a*1.0472)*(p.r+9),p.y+Math.sin(a*1.0472)*(p.r+9)])}
    var h=convexHull(pts);if(h)hulls.push({c:+key,pts:h,n:arr.length,core:+key===focus})}
  hulls.sort(function(a,b){return (a.core?1:0)-(b.core?1:0)})}

/* --------------------------------------------------- spatial hit index */
var grid=null;
function buildGrid(){
  var cell=48,mx=0;for(var i=0;i<nodes.length;i++)mx=Math.max(mx,nodes[i].r);
  cell=Math.max(32,mx*1.4);
  var g={};
  for(var i=0;i<nodes.length;i++){var p=nodes[i];
    var x0=Math.floor((p.x-p.r)/cell),x1=Math.floor((p.x+p.r)/cell),y0=Math.floor((p.y-p.r)/cell),y1=Math.floor((p.y+p.r)/cell);
    for(var x=x0;x<=x1;x++)for(var y=y0;y<=y1;y++){var key=x+','+y;(g[key]||(g[key]=[])).push(i)}}
  grid={cell:cell,g:g}}
function pick(sx,sy){
  if(!grid)return -1;
  var x=(sx-view.x)/view.k,y=(sy-view.y)/view.k;var pad=6/view.k;
  var cell=grid.cell,best=-1,bd=1e9;
  var cx=Math.floor(x/cell),cy=Math.floor(y/cell);
  for(var ox=-1;ox<=1;ox++)for(var oy=-1;oy<=1;oy++){
    var b=grid.g[(cx+ox)+','+(cy+oy)];if(!b)continue;
    for(var i=0;i<b.length;i++){var p=nodes[b[i]];if(!visible(p))continue;
      var d=Math.hypot(p.x-x,p.y-y);if(d<p.r+pad&&d<bd){bd=d;best=b[i]}}}
  return best}

/* -------------------------------------------------------------- filters */
function anyKind(){for(var k in fKinds)if(fKinds[k])return true;return false}
function visible(p){
  if(p.kind==='comm')return showPeriph||!p.peripheral;
  var n=p.n;
  if(anyKind()&&!fKinds[n.kind])return false;
  if(fLang!==''&&D.langs[n.lang]!==fLang)return false;
  if(fDir!==''&&D.dirs[n.dir].indexOf(fDir)!==0)return false;
  return true}
function matched(p){
  if(!query)return true;
  if(p.kind==='comm')return p.label.toLowerCase().indexOf(query)>=0;
  return matchSet[p.gi]===1}
var matchSet={};

/* ------------------------------------------------------- view + anim */
function insets(){
  return {l:14,r:(drawer.classList.contains('open')?412:14),t:14,b:(mode==='sym'?142:38)}}
function boundsOf(list){
  var b={x0:1e9,y0:1e9,x1:-1e9,y1:-1e9};
  for(var i=0;i<list.length;i++){var p=list[i];
    b.x0=Math.min(b.x0,p.x-p.r);b.y0=Math.min(b.y0,p.y-p.r);b.x1=Math.max(b.x1,p.x+p.r);b.y1=Math.max(b.y1,p.y+p.r)}
  return b}
function fit(animate){
  var list=nodes.filter(visible);
  if(mode==='sym'){var own=list.filter(function(p){return !p.ctx});if(own.length)list=own}
  if(!list.length)list=nodes;
  if(!list.length)return;
  var b=boundsOf(list);
  var ins=insets();
  /* labels sit under (overview) or beside (symbols) a node, so reserve room for them */
  var lp=Math.max(24,(b.x1-b.x0)*.045);
  b.x0-=lp;b.x1+=lp;b.y1+=Math.max(14,(b.y1-b.y0)*.02);
  var padX=mode==='comm'?46:40,padY=mode==='comm'?34:32;
  var availW=Math.max(80,W-ins.l-ins.r-padX*2),availH=Math.max(80,H-ins.t-ins.b-padY*2);
  var k=Math.min(availW/Math.max(1,b.x1-b.x0),availH/Math.max(1,b.y1-b.y0),mode==='comm'?2.6:3.2);
  var maxR=0;for(var i=0;i<list.length;i++)maxR=Math.max(maxR,list[i].r);
  var capD=Math.min(W,H)*(mode==='comm'?.30:.22);
  if(maxR*2*k>capD)k=capD/(maxR*2);
  var cx=ins.l+padX+availW/2,cy=ins.t+padY+availH/2;
  var target={k:k,x:cx-(b.x0+b.x1)/2*k,y:cy-(b.y0+b.y1)/2*k};
  if(animate===false){view=target;requestDraw()}else animateTo(target,300)}
function animateTo(target,ms){
  var from={x:view.x,y:view.y,k:view.k},t0=performance.now();
  if(anim)cancelAnimationFrame(anim);
  function step(now){
    var t=Math.min(1,(now-t0)/ms);var e=t<.5?4*t*t*t:1-Math.pow(-2*t+2,3)/2;
    /* interpolate zoom geometrically so the motion feels even */
    view.k=from.k*Math.pow(target.k/from.k,e);
    view.x=from.x+(target.x-from.x)*e;view.y=from.y+(target.y-from.y)*e;
    draw();
    if(t<1)anim=requestAnimationFrame(step);else anim=null}
  anim=requestAnimationFrame(step)}
function centerOn(p,k,ms){
  var ins=insets();
  var cx=ins.l+(W-ins.l-ins.r)/2,cy=ins.t+(H-ins.t-ins.b)/2;
  var kk=k||view.k;
  animateTo({k:kk,x:cx-p.x*kk,y:cy-p.y*kk},ms||300)}

/* ---------------------------------------------------------------- draw */
var TAU=Math.PI*2;
var FONT='Inter,-apple-system,"SF Pro Text","Segoe UI",Roboto,sans-serif';
function draw(){
  var t=T();
  ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.clearRect(0,0,W,H);
  ctx.fillStyle=t.bg;ctx.fillRect(0,0,W,H);
  drawScene(ctx,W,H,view,true);
  drawMini();}

function drawScene(g,w,h,v,interactive){
  var t=T();
  g.save();g.translate(v.x,v.y);g.scale(v.k,v.k);
  var neigh=null;
  var focusIdx=(hover>=0&&hover!=null)?hover:(sel!=null?sel:-1);
  if(mode==='sym'&&focusIdx>=0){neigh={};neigh[focusIdx]=1;
    for(var i=0;i<links.length;i++){var L=links[i];if(L[0]===focusIdx)neigh[L[1]]=1;else if(L[1]===focusIdx)neigh[L[0]]=1}}

  /* hulls */
  for(var i=0;i<hulls.length;i++){var hl=hulls[i];
    g.beginPath();
    var pts=hl.pts;
    g.moveTo((pts[0][0]+pts[1][0])/2,(pts[0][1]+pts[1][1])/2);
    for(var j=1;j<=pts.length;j++){var a=pts[j%pts.length],b=pts[(j+1)%pts.length];
      g.quadraticCurveTo(a[0],a[1],(a[0]+b[0])/2,(a[1]+b[1])/2)}
    g.closePath();
    g.fillStyle=col(hl.c,hl.core?(theme==='dark'?.075:.085):(theme==='dark'?.045:.05),false);
    g.fill();
    g.strokeStyle=col(hl.c,hl.core?.32:.18,false);g.lineWidth=(hl.core?1.4:1)/v.k;g.setLineDash(hl.core?[]:[6/v.k,5/v.k]);g.stroke();g.setLineDash([])}

  /* edges */
  if(mode==='comm'){
    for(var i=0;i<links.length;i++){var L=links[i],A=nodes[L[0]],B=nodes[L[1]];
      if(!visible(A)||!visible(B))continue;
      var on=interactive&&hover!=null&&hover>=0&&(L[0]===hover||L[1]===hover);
      var w0=Math.max(.6,L[2]*1.15);
      g.beginPath();curve(g,A,B,true);
      if(on){g.strokeStyle=t.accent;g.globalAlpha=.85;g.lineWidth=(w0+1.6)/v.k;
        g.shadowColor=t.accent;g.shadowBlur=10;g.stroke();g.shadowBlur=0;g.globalAlpha=1}
      else{g.strokeStyle='rgba('+t.edge+','+(0.10+Math.min(.30,L[2]*.11))+')';g.lineWidth=w0/v.k;g.stroke()}}
  }else{
    var thin=links.length>4000;
    for(var i=0;i<links.length;i++){var L=links[i],A=nodes[L[0]],B=nodes[L[1]];
      if(!visible(A)||!visible(B))continue;
      var on=neigh&&(L[0]===focusIdx||L[1]===focusIdx);
      var dim=neigh&&!on;
      if(dim&&thin)continue;
      var k=L[3];
      g.beginPath();curve(g,A,B,true);
      g.strokeStyle=on?t.accent:ekColor(k,(dim?.07:ekAlpha(k))*((A.ctx||B.ctx)?.6:1));
      g.lineWidth=(on?1.9:.9)/v.k;g.stroke();
      if(on||v.k>1.7){arrow(g,A,B,g.strokeStyle,v.k)}}}

  /* nodes */
  for(var i=0;i<nodes.length;i++){var p=nodes[i];if(!visible(p))continue;
    var dim=(neigh&&!neigh[i])||(query&&!matched(p));
    g.globalAlpha=dim?(theme==='dark'?.16:.2):1;
    if(p.kind==='comm')drawBubble(g,p,i,v,interactive);
    else drawDot(g,p,i,v,dim);
    g.globalAlpha=1}
  g.restore();
  drawLabels(g,w,h,v,neigh,focusIdx);}

/* A gentle arc between the two rims. Trimming to the circle edge keeps discs clean: nothing
   crosses a subsystem bubble, so the composition reads as nodes-and-links, not a scribble. */
function curve(g,A,B,trim){
  var dx=B.x-A.x,dy=B.y-A.y;var mx=(A.x+B.x)/2,my=(A.y+B.y)/2;
  var cx=mx-dy*.13,cy=my+dx*.13;
  var ax=A.x,ay=A.y,bx=B.x,by=B.y;
  if(trim){
    var d1=Math.hypot(cx-A.x,cy-A.y)||1,d2=Math.hypot(B.x-cx,B.y-cy)||1;
    ax=A.x+(cx-A.x)/d1*A.r;ay=A.y+(cy-A.y)/d1*A.r;
    bx=B.x-(B.x-cx)/d2*B.r;by=B.y-(B.y-cy)/d2*B.r}
  g.moveTo(ax,ay);g.quadraticCurveTo(cx,cy,bx,by)}
function arrow(g,A,B,style,k){
  var ang=Math.atan2(B.y-A.y,B.x-A.x);
  var tx=B.x-Math.cos(ang)*(B.r+1),ty=B.y-Math.sin(ang)*(B.r+1);var s=5.5/k;
  g.fillStyle=style;g.beginPath();g.moveTo(tx,ty);
  g.lineTo(tx-Math.cos(ang-.42)*s,ty-Math.sin(ang-.42)*s);
  g.lineTo(tx-Math.cos(ang+.42)*s,ty-Math.sin(ang+.42)*s);g.closePath();g.fill()}

function drawBubble(g,p,i,v,interactive){
  var isHot=interactive&&(i===hover||(hoverSub!=null&&hoverSub===p.c));
  g.beginPath();g.arc(p.x,p.y,p.r,0,TAU);g.closePath();
  if(isHot){g.shadowColor=col(p.c,.7,p.peripheral);g.shadowBlur=28}
  g.fillStyle=T().bg;g.fill();
  g.shadowBlur=0;
  g.fillStyle=col(p.c,theme==='dark'?.30:.17,p.peripheral);g.fill();
  /* glossy highlight, clipped to the disc: a concentric-free gradient would cone-artifact */
  g.save();g.clip();
  var gr=g.createRadialGradient(p.x-p.r*.3,p.y-p.r*.38,0,p.x-p.r*.3,p.y-p.r*.38,p.r*1.7);
  gr.addColorStop(0,colL(p.c,theme==='dark'?.20:.26,theme==='dark'?.72:.42,p.peripheral));
  gr.addColorStop(.45,col(p.c,theme==='dark'?.30:.18,p.peripheral));
  gr.addColorStop(1,col(p.c,0,p.peripheral));
  g.fillStyle=gr;g.fillRect(p.x-p.r,p.y-p.r,p.r*2,p.r*2);
  g.restore();
  g.beginPath();g.arc(p.x,p.y,p.r,0,TAU);g.closePath();
  g.lineWidth=(isHot?2.1:1.2)/v.k;
  g.strokeStyle=col(p.c,isHot?1:(theme==='dark'?.78:.66),p.peripheral);
  g.stroke();}

function drawDot(g,p,i,v,dim){
  var t=T();
  g.beginPath();g.arc(p.x,p.y,p.r,0,TAU);g.closePath();
  g.fillStyle=col(p.c,p.ctx?(theme==='dark'?.42:.42):1,false);
  g.fill();
  if(!dim&&p.r>4.5){g.lineWidth=1/v.k;g.strokeStyle=colL(p.c,theme==='dark'?.22:-.16,.9,false);g.stroke()}
  if(i===sel||i===hover){g.lineWidth=2.2/v.k;g.strokeStyle=T().accent;g.beginPath();g.arc(p.x,p.y,p.r+3/v.k,0,TAU);g.closePath();g.stroke()}}

/* Screen-space greedy label placement: highest priority first, skip on collision. Keeps
   dense subsystems readable and makes labels appear progressively as you zoom in. */
function drawLabels(g,w,h,v,neigh,focusIdx){
  var t=T();
  var order=[];
  for(var i=0;i<nodes.length;i++){var p=nodes[i];if(!visible(p))continue;
    if(query&&!matched(p)&&i!==hover&&i!==sel)continue;
    var pri=p.kind==='comm'?p.size*1000:(p.n.pr+p.n.callers)*(p.ctx?.3:1);
    if(i===hover||i===sel)pri=1e12;else if(neigh&&neigh[i])pri+=1e6;
    order.push([i,pri])}
  order.sort(function(a,b){return b[1]-a[1]});
  var cap=mode==='comm'?200:Math.min(110,Math.max(18,Math.round(24*v.k)));
  var boxes=[],drawn=0;
  var sx=function(x){return x*v.k+v.x},sy=function(y){return y*v.k+v.y};
  for(var oi=0;oi<order.length&&drawn<cap;oi++){
    var i=order[oi][0],p=nodes[i];
    var px=sx(p.x),py=sy(p.y),pr=p.r*v.k;
    if(px<-260||px>w+260||py<-80||py>h+80)continue;
    var forced=(i===hover||i===sel);
    if(p.kind==='comm'){
      if(pr<7&&!forced)continue;
      var label=p.label,sub=String(p.size);
      var fs=Math.max(10.5,Math.min(15,7+pr*.30));
      g.font='560 '+fs+'px '+FONT;
      var tw=g.measureText(label).width;
      if(tw>Math.max(190,pr*7)&&!forced){
        /* very long label in a small bubble: clip it rather than overwhelm the composition */
        while(tw>Math.max(190,pr*7)&&label.length>6){label=label.slice(0,-2);tw=g.measureText(label+'…').width}
        label=label+'…'}
      var bh=fs*1.15+11;
      /* try below, then above, then to the sides before giving up on the label */
      var cands=[[px,py+pr+3],[px,py-pr-3-bh],[px+pr+6+tw/2,py-bh/2],[px-pr-6-tw/2,py-bh/2]];
      var placedAt=null;
      for(var ci=0;ci<cands.length;ci++){
        var bx0=cands[ci][0]-tw/2-4,bx1=cands[ci][0]+tw/2+4,by0=cands[ci][1],by1=by0+bh;
        if(!forced&&(hit(boxes,bx0,by0,bx1,by1)||hitsNode(bx0,by0,bx1,by1,i,v)))continue;
        placedAt=[cands[ci][0],by0,bx0,bx1,by1];break}
      if(!placedAt){
        if(!forced)continue;
        placedAt=[px,py+pr+3,px-tw/2-4,px+tw/2+4,py+pr+3+bh]}
      boxes.push([placedAt[2],placedAt[1],placedAt[3],placedAt[4]]);drawn++;
      var lcx=placedAt[0],lty=placedAt[1];
      g.textAlign='center';g.textBaseline='top';
      g.lineWidth=3;g.strokeStyle=theme==='dark'?'rgba(17,17,20,.78)':'rgba(250,249,247,.85)';
      g.strokeText(label,lcx,lty);
      g.fillStyle=p.peripheral?t.muted:t.ink;g.fillText(label,lcx,lty);
      g.font='500 '+Math.max(9.5,fs*.78)+'px '+FONT;
      g.strokeText(sub,lcx,lty+fs*1.16);
      g.fillStyle=t.faint;g.fillText(sub,lcx,lty+fs*1.16);
    }else{
      if(pr<3.4&&!forced&&!(neigh&&neigh[i]))continue;
      var label=p.n.name;
      var fs=forced?12.5:Math.max(10,Math.min(12.5,8.4+pr*.22));
      g.font=(forced?'620 ':'500 ')+fs+'px '+FONT;
      var tw=g.measureText(label).width;
      var bx0=px+pr+4,bx1=bx0+tw,by0=py-fs*.62,by1=py+fs*.62;
      if(!forced&&hit(boxes,bx0-2,by0-1,bx1+2,by1+1))continue;
      boxes.push([bx0-2,by0-1,bx1+2,by1+1]);drawn++;
      g.textAlign='left';g.textBaseline='middle';
      g.lineWidth=3;g.strokeStyle=theme==='dark'?'rgba(17,17,20,.8)':'rgba(250,249,247,.86)';
      g.strokeText(label,bx0,py);
      g.fillStyle=p.ctx?t.muted:(forced?t.ink:t.ink2);g.fillText(label,bx0,py)}}
  g.textAlign='left';g.textBaseline='alphabetic'}
/* Does a screen-space label box land on another bubble? Overview only: at symbol level there are
   thousands of dots and the labels sit tight against them by design. */
function hitsNode(x0,y0,x1,y1,skip,v){
  if(mode!=='comm')return false;
  for(var i=0;i<nodes.length;i++){
    if(i===skip)continue;var p=nodes[i];if(!visible(p))continue;
    var cx=p.x*v.k+v.x,cy=p.y*v.k+v.y,cr=p.r*v.k+2;
    if(cx+cr<x0||cx-cr>x1||cy+cr<y0||cy-cr>y1)continue;
    var nx=Math.max(x0,Math.min(cx,x1)),ny=Math.max(y0,Math.min(cy,y1));
    if((cx-nx)*(cx-nx)+(cy-ny)*(cy-ny)<cr*cr)return true}
  return false}
function hit(boxes,x0,y0,x1,y1){
  for(var i=0;i<boxes.length;i++){var b=boxes[i];
    if(x0<b[2]&&x1>b[0]&&y0<b[3]&&y1>b[1])return true}
  return false}

/* ------------------------------------------------------------- minimap */
function drawMini(){
  if(mode!=='sym'||!nodes.length){mini.hidden=true;return}
  mini.hidden=false;
  var t=T();var mw=168,mh=118;
  mctx.setTransform(dpr,0,0,dpr,0,0);mctx.clearRect(0,0,mw,mh);
  var own=nodes.filter(function(p){return !p.ctx});
  var b=boundsOf(own.length?own:nodes);
  var pad=Math.max(30,(b.x1-b.x0)*.12);b.x0-=pad;b.x1+=pad;b.y0-=pad;b.y1+=pad;
  var k=Math.min((mw-14)/Math.max(1,b.x1-b.x0),(mh-14)/Math.max(1,b.y1-b.y0));
  var ox=mw/2-(b.x0+b.x1)/2*k,oy=mh/2-(b.y0+b.y1)/2*k;
  miniView={k:k,x:ox,y:oy};
  for(var i=0;i<nodes.length;i++){var p=nodes[i];if(!visible(p))continue;
    mctx.fillStyle=col(p.c,p.ctx?.35:.8,false);
    mctx.fillRect(p.x*k+ox-1,p.y*k+oy-1,2,2)}
  /* viewport rectangle */
  var vx0=(0-view.x)/view.k*k+ox,vy0=(0-view.y)/view.k*k+oy;
  var vx1=(W-view.x)/view.k*k+ox,vy1=(H-view.y)/view.k*k+oy;
  mctx.strokeStyle=t.accent;mctx.lineWidth=1;
  mctx.strokeRect(Math.max(.5,vx0),Math.max(.5,vy0),Math.min(mw,vx1)-Math.max(0,vx0),Math.min(mh,vy1)-Math.max(0,vy0));
  mctx.fillStyle=theme==='dark'?'rgba(127,166,255,.10)':'rgba(47,87,201,.08)';
  mctx.fillRect(Math.max(.5,vx0),Math.max(.5,vy0),Math.min(mw,vx1)-Math.max(0,vx0),Math.min(mh,vy1)-Math.max(0,vy0))}
var miniView=null;
function miniJump(ev){
  if(!miniView)return;
  var r=mini.getBoundingClientRect();
  var wx=(ev.clientX-r.left-miniView.x)/miniView.k,wy=(ev.clientY-r.top-miniView.y)/miniView.k;
  view.x=W/2-wx*view.k;view.y=H/2-wy*view.k;requestDraw()}
mini.addEventListener('mousedown',function(e){e.preventDefault();miniJump(e);
  var mv=function(ev){miniJump(ev)},up=function(){removeEventListener('mousemove',mv);removeEventListener('mouseup',up)};
  addEventListener('mousemove',mv);addEventListener('mouseup',up)});

/* -------------------------------------------------------- chrome (DOM) */
function nf(n){return n>=1e6?(n/1e6).toFixed(1)+'M':n>=1e4?Math.round(n/1e3)+'k':nfull(n)}
function nfull(n){return String(n).replace(/\B(?=(\d{3})+(?!\d))/g,',')}
function esc(s){return String(s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}

function syncChrome(){
  /* pills */
  var f=D.stats;
  var pill=function(n,t){return '<span class="pill"><b>'+nf(n)+'</b> '+t+'</span>'};
  var pills;
  if(mode==='sym'){
    var c=commById[focus];var shown=nodes.filter(function(p){return !p.ctx}).length;
    var total=c?c.size:shown;
    pills=[shown<total?pill(shown,'of '+nfull(total)+' by importance'):pill(shown,shown===1?'symbol':'symbols'),
           pill(links.length,'edges')]}
  else{
    pills=[pill(f.files,'files'),pill(f.symbols,'symbols'),pill(f.edges,'edges'),pill(f.subsystems,'subsystems')];
    if(D.sampled)pills.push(pill(D.nodes.length,'of '+nfull(D.placed)+' mapped by importance'))}
  $('pills').innerHTML=pills.join('');
  /* breadcrumb */
  var cr=$('crumbs');cr.innerHTML='';
  var repoBtn=document.createElement('button');repoBtn.textContent=D.repo;
  if(mode==='comm'){repoBtn.className='cur'}else{repoBtn.onclick=function(){buildComm()}}
  cr.appendChild(repoBtn);
  if(mode==='sym'){
    var ch=document.createElement('span');ch.className='chev';ch.textContent='›';cr.appendChild(ch);
    var c=commById[focus];
    var b=document.createElement('button');b.className=sel==null?'cur':'';
    b.innerHTML='<span style="color:'+col(focus,1,c&&c.peripheral)+'">●</span> '+esc(c?labelOf(c):'#'+focus);
    if(sel!=null)b.onclick=function(){sel=null;closeDrawer();syncChrome();requestDraw()};
    cr.appendChild(b);
    if(sel!=null&&nodes[sel]){var ch2=document.createElement('span');ch2.className='chev';ch2.textContent='›';cr.appendChild(ch2);
      var b2=document.createElement('button');b2.className='cur';b2.textContent=nodes[sel].n.name;cr.appendChild(b2)}}
  /* subsystem list highlight */
  var els=$('subs').children;
  for(var i=0;i<els.length;i++)els[i].classList.toggle('on',mode==='sym'&&+els[i].dataset.c===focus);
  $('edgekey').hidden=mode!=='sym';
  $('hint').classList.toggle('gone',mode==='sym');
  checkEmpty()}

function checkEmpty(){
  var e=$('empty');
  var vis=0;for(var i=0;i<nodes.length;i++)if(visible(nodes[i])&&matched(nodes[i]))vis++;
  if(!nodes.length){
    e.hidden=false;
    if(mode==='sym'){var c=commById[focus];
      e.innerHTML='<b>No mapped symbols here</b><div>“'+esc(c?labelOf(c):'#'+focus)+'” holds only declarations Symbra does not place on the map (modules, fields, constants).</div><div class="muted">Press <kbd>Esc</kbd> to go back.</div>'}
    else e.innerHTML='<b>Nothing to map</b><div>No subsystems were detected. Run <code>symbra index</code> first.</div>'}
  else if(!vis){
    e.hidden=false;
    e.innerHTML=query?'<b>No symbols match “'+esc(query)+'”</b><div>Try a shorter query, or clear the kind and language filters.</div>'
      :'<b>Everything is filtered out</b><div>Loosen the kind, language or directory filter in the sidebar.</div>'}
  else e.hidden=true}

function buildSubs(){
  var box=$('subs');box.innerHTML='';
  var cs=D.communities.slice().sort(function(a,b){
    if(a.peripheral!==b.peripheral)return a.peripheral?1:-1;return b.size-a.size});
  var max=1;for(var i=0;i<cs.length;i++)max=Math.max(max,cs[i].size);
  var shown=0;
  for(var i=0;i<cs.length;i++){(function(c){
    if(c.peripheral&&!showPeriph)return;
    shown++;
    var d=document.createElement('div');d.className='sub'+(c.peripheral?' periph':'');d.dataset.c=c.id;
    d.innerHTML='<span class="sw" style="background:'+col(c.id,1,c.peripheral)+'"></span>'+
      '<span class="nm"><span class="t">'+esc(labelOf(c))+'</span><span class="bar"><i style="width:'+Math.max(3,Math.round(c.size/max*100))+'%;background:'+col(c.id,.85,c.peripheral)+'"></i></span></span>'+
      '<span class="n">'+nf(c.size)+'</span>';
    d.title=labelOf(c)+' · '+c.size+' symbols'+(c.dirs.length?' · '+c.dirs.slice(0,3).join(', '):'');
    d.onclick=function(){if(mode==='sym'&&focus===c.id)buildComm();else buildSym(c.id,true)};
    d.onmouseenter=function(){if(mode==='comm'){hoverSub=c.id;requestDraw()}};
    d.onmouseleave=function(){if(hoverSub!=null){hoverSub=null;requestDraw()}};
    box.appendChild(d)})(cs[i])}
  $('subCount').textContent=shown}

function buildFilters(){
  var box=$('kinds');box.innerHTML='';
  for(var i=0;i<kindList.length;i++){(function(k){
    var b=document.createElement('button');b.className='chip';b.textContent=k;
    b.onclick=function(){fKinds[k]=!fKinds[k];b.classList.toggle('on',!!fKinds[k]);buildGrid();syncChrome();requestDraw()};
    box.appendChild(b)})(kindList[i])}
  var ls=$('lang');ls.innerHTML='<option value="">All</option>';
  D.langs.slice().sort().forEach(function(l){var o=document.createElement('option');o.value=l;o.textContent=l;ls.appendChild(o)});
  ls.onchange=function(){fLang=ls.value;syncChrome();requestDraw()};
  /* directory prefixes: the top level plus the busiest second level */
  var counts={};
  for(var i=0;i<D.nodes.length;i++){var d=D.dirs[D.nodes[i].dir];var parts=d.split('/');
    for(var j=1;j<=Math.min(2,parts.length);j++){var pre=parts.slice(0,j).join('/');counts[pre]=(counts[pre]||0)+1}}
  var keys=Object.keys(counts).filter(function(k){return k&&k!=='.'&&counts[k]>=2}).sort(function(a,b){return counts[b]-counts[a]}).slice(0,40).sort();
  var ds=$('dir');ds.innerHTML='<option value="">All</option>';
  keys.forEach(function(k){var o=document.createElement('option');o.value=k;o.textContent=k+'/ ('+counts[k]+')';ds.appendChild(o)});
  ds.onchange=function(){fDir=ds.value;syncChrome();requestDraw()};
  $('periph').onchange=function(){showPeriph=$('periph').checked;buildSubs();
    if(mode==='comm')buildComm();else{buildGrid();syncChrome();requestDraw()}};
  buildEdgeKey()}
function buildEdgeKey(){
  var key=$('edgekey');
  key.innerHTML=['calls','imports','extends','passes','references'].map(function(k){
    return '<span><i style="background:'+ekColor(k,.95)+'"></i>'+k+'</span>'}).join('')+
    '<span><i style="background:'+T().accent+'"></i>selected</span>'}

/* --------------------------------------------------------------- search */
/* Subsequence fuzzy match: consecutive runs and word-boundary starts score higher. */
function fuzzy(q,s){
  var ls=s.toLowerCase(),n=ls.length,m=q.length;
  if(!m)return null;
  var idx=[],qi=0,score=0,run=0;
  for(var i=0;i<n&&qi<m;i++){
    if(ls.charCodeAt(i)===q.charCodeAt(qi)){
      var prev=i>0?ls.charAt(i-1):'';
      var bound=(i===0||prev==='.'||prev==='/'||prev==='_'||prev==='-'||(s.charAt(i)>='A'&&s.charAt(i)<='Z'&&prev>='a'&&prev<='z'));
      score+=1+(bound?6:0)+run*3;run++;idx.push(i);qi++}
    else run=0}
  if(qi<m)return null;
  score-=idx[0]*0.12;score-= (n-m)*0.02;
  return {score:score,idx:idx}}
function hlText(s,idx){
  if(!idx)return esc(s);
  var out='',j=0;
  for(var i=0;i<s.length;i++){
    if(j<idx.length&&idx[j]===i){out+='<em>'+esc(s.charAt(i))+'</em>';j++}
    else out+=esc(s.charAt(i))}
  return out}
function runSearch(){
  matchSet={};results=[];resSel=-1;
  if(!query){$('results').hidden=true;$('browse').hidden=false;syncChrome();requestDraw();return}
  var out=[];
  for(var i=0;i<D.nodes.length;i++){var n=D.nodes[i];
    var m=fuzzy(query,n.name);var where='name',s=m?m.score*3.2:-1e9;
    var m2=fuzzy(query,n.fqn);if(m2&&m2.score*1.6>s){s=m2.score*1.6;m=m2;where='fqn'}
    var m3=fuzzy(query,n.file);if(m3&&m3.score>s){s=m3.score;m=m3;where='file'}
    if(!m||s<=-1e8)continue;
    s+=Math.min(6,n.pr*.35);
    out.push({gi:i,s:s,m:m,where:where});matchSet[i]=1}
  out.sort(function(a,b){return b.s-a.s});
  results=out.slice(0,80);
  renderResults();
  syncChrome();requestDraw()}
function renderResults(){
  var box=$('results');box.hidden=false;$('browse').hidden=true;
  if(!results.length){
    box.innerHTML='<div class="nores"><b>No matches for “'+esc(query)+'”</b>Search runs over symbol names, fully-qualified names and file paths.</div>';return}
  box.innerHTML='';
  results.forEach(function(r,i){
    var n=D.nodes[r.gi];var c=commById[n.c];
    var d=document.createElement('div');d.className='res'+(i===resSel?' on':'');
    d.innerHTML='<span class="sw" style="background:'+col(n.c,1,c&&c.peripheral)+'"></span>'+
      '<span class="txt"><span class="t">'+(r.where==='name'?hlText(n.name,r.m.idx):esc(n.name))+
      '&nbsp;<span class="muted" style="font-size:11px">'+esc(n.kind)+'</span></span>'+
      '<span class="f">'+(r.where==='file'?hlText(n.file,r.m.idx):esc(n.file))+':'+n.line+'</span></span>';
    d.onclick=function(){resSel=i;openGlobal(r.gi)};
    box.appendChild(d)})}
function moveRes(dir){
  if(!results.length)return;
  resSel=Math.max(0,Math.min(results.length-1,resSel+dir));
  renderResults();
  var el=$('results').children[resSel];if(el&&el.scrollIntoView)el.scrollIntoView({block:'nearest'})}

/* --------------------------------------------------------------- drawer */
function localOfGlobal(gi){for(var i=0;i<nodes.length;i++)if(nodes[i].gi===gi)return i;return -1}
function openGlobal(gi){
  var n=D.nodes[gi];
  if(mode!=='sym'||n.c!==focus){buildSym(n.c,true)}
  var li=localOfGlobal(gi);
  if(li<0){buildSym(n.c,false);li=localOfGlobal(gi)}
  if(li<0)return;
  sel=li;openDrawer();syncChrome();
  centerOn(nodes[li],Math.max(view.k,1.3),320)}
function openDrawer(){drawer.classList.add('open');stage.classList.add('with-drawer');drawer.setAttribute('aria-hidden','false');renderDrawer();requestDraw()}
function closeDrawer(){stage.classList.remove('with-drawer');if(!drawer.classList.contains('open'))return;drawer.classList.remove('open');drawer.setAttribute('aria-hidden','true')}
$('dclose').onclick=function(){closeDrawer();sel=null;syncChrome();requestDraw()};
Array.prototype.forEach.call(document.querySelectorAll('.tab'),function(b){
  b.onclick=function(){tab=b.dataset.tab;
    Array.prototype.forEach.call(document.querySelectorAll('.tab'),function(x){x.classList.toggle('on',x===b)});
    renderDrawer()}});

var KINDHUE={"class":0,"interface":5,"function":9,"method":9,"struct":2,"enum":6,"type":7,"trait":5,"component":3,"constant":6,"route":1};
function badge(kind){
  var h=KINDHUE[kind]!==undefined?KINDHUE[kind]:(kind.charCodeAt(0)+kind.length)%12;
  return {bg:col(h,theme==='dark'?.16:.10,false),fg:colL(h,theme==='dark'?.12:-.06,1,false),bd:col(h,.42,false)}}

function vscodeHref(n){return 'vscode://file/'+encodeURI(D.root+'/'+n.file)+':'+n.line}

function renderDrawer(){
  if(sel==null||!nodes[sel]||!nodes[sel].n)return;
  var p=nodes[sel],n=p.n,gi=p.gi;
  var b=badge(n.kind);
  var kd=$('dkind');kd.textContent=n.kind;kd.style.background=b.bg;kd.style.color=b.fg;kd.style.borderColor=b.bd;
  $('dname').textContent=n.name;
  var fq=$('dfqn');fq.textContent=n.fqn;fq.hidden=(n.fqn===n.name);
  var body=$('dbody');
  if(tab==='overview')body.innerHTML=ovHtml(n,gi);
  else if(tab==='relations')body.innerHTML=relHtml(gi);
  else body.innerHTML=srcHtml(n,gi);
  body.scrollTop=0;
  Array.prototype.forEach.call(body.querySelectorAll('[data-g]'),function(a){
    a.onclick=function(ev){ev.preventDefault();openGlobal(+a.dataset.g)}})}

function ovHtml(n,gi){
  var c=commById[n.c];
  var rows=adj[gi]||[];var outs=0,ins=0;
  for(var i=0;i<rows.length;i++)rows[i][2]===0?outs++:ins++;
  var pct=Math.max(2,Math.min(100,Math.round(n.pr/maxPR*100)));
  var h='';
  if(n.sig)h+='<h4>Signature</h4><div class="sig">'+esc(n.sig)+'</div>';
  if(n.doc)h+='<h4>Documentation</h4><div class="doc">'+esc(n.doc)+'</div>';
  h+='<h4>Importance</h4><div class="meter"><span class="track"><i style="width:'+pct+'%"></i></span><span class="v">'+n.pr.toFixed(1)+'</span></div>'+
     '<div class="muted" style="margin-top:5px;font-size:12px">'+n.callers+' callers · '+ins+' incoming · '+outs+' outgoing edges</div>';
  h+='<h4>Location</h4><dl class="facts">'+
     '<dt>File</dt><dd><a href="'+vscodeHref(n)+'">'+esc(n.file)+':'+n.line+'</a></dd>'+
     '<dt>Lines</dt><dd>'+n.line+'–'+n.endLine+' ('+(n.endLine-n.line+1)+')</dd>'+
     '<dt>Language</dt><dd>'+esc(D.langs[n.lang])+'</dd>'+
     '<dt>Subsystem</dt><dd><a href="#" data-c="'+n.c+'" style="color:'+col(n.c,1,c&&c.peripheral)+'">'+esc(c?labelOf(c):'#'+n.c)+'</a>'+(c&&c.peripheral?' <span class="muted">peripheral</span>':'')+'</dd>'+
     '</dl>';
  return h}

function relHtml(gi){
  var rows=adj[gi]||[];
  if(!rows.length)return '<div class="note">No resolved relations for this symbol. It may be a leaf, or its callers live in files Symbra could not resolve.</div>';
  var groups={};
  for(var i=0;i<rows.length;i++){var r=rows[i];var key=(r[2]===1?'in':'out')+'|'+r[1];(groups[key]||(groups[key]=[])).push(r[0])}
  var keys=Object.keys(groups).sort(function(a,b){
    var da=a.split('|')[0],db=b.split('|')[0];
    if(da!==db)return da==='in'?-1:1;return groups[b].length-groups[a].length});
  var h='';
  for(var i=0;i<keys.length;i++){
    var parts=keys[i].split('|'),dir=parts[0],kind=parts[1];var list=groups[keys[i]];
    /* de-duplicate and order by importance */
    var seen={},uniq=[];
    for(var j=0;j<list.length;j++)if(!seen[list[j]]){seen[list[j]]=1;uniq.push(list[j])}
    uniq.sort(function(a,b){return D.nodes[b].pr-D.nodes[a].pr});
    h+='<div class="relh"><i style="background:'+ekColor(kind,.95)+'"></i><b>'+(dir==='in'?'incoming':'outgoing')+' '+esc(kind)+'</b> <span>'+uniq.length+'</span></div><ul class="rl">';
    for(var j=0;j<Math.min(60,uniq.length);j++){var m=D.nodes[uniq[j]];var c=commById[m.c];
      h+='<li data-g="'+uniq[j]+'"><span class="sw" style="background:'+col(m.c,1,c&&c.peripheral)+'"></span><span class="t">'+esc(m.name)+'</span><span class="k">'+esc(m.kind)+'</span></li>'}
    if(uniq.length>60)h+='<li class="muted" style="cursor:default">… '+(uniq.length-60)+' more</li>';
    h+='</ul>'}
  return h}

var KW=('abstract as async await base bool break by byte case catch char class const constexpr continue crate data debugger def default defer del delete do double dyn elif else end enum event except export extends extern false final finally float fn for from func function global go goto if impl implement implements import in include inline instanceof int interface internal is lambda let lazy loop match mod module move mut namespace new nil none not null object open operator or override package partial pass private protected pub public raise readonly rec record ref register return sealed self short signed sizeof static struct super switch sync template then this throw throws trait true try type typedef typeof union unless unsafe until use using val var virtual void volatile when where while with yield').split(' ');
var KWSET={};for(var i=0;i<KW.length;i++)KWSET[KW[i]]=1;
var BT=String.fromCharCode(96);
/* A deliberately small, language-agnostic tokenizer: comments, strings, numbers, keywords and
   call heads. It is a highlighter, not a parser, so it errs toward leaving text plain. */
function highlight(src){
  var out='';var i=0,n=src.length;
  var re=/\/\*[\s\S]*?(?:\*\/|$)|(?:\/\/|#(?!\[)|--(?=[ \t])|;;)[^\n]*|"""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)|"(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?|\u0060(?:\\.|[^\u0060\\])*\u0060?|\b\d[\w.]*\b|[A-Za-z_$][\w$]*/g;
  var m;
  while((m=re.exec(src))){
    out+=esc(src.slice(i,m.index));
    var s=m[0];var cls='';
    var c0=s.charAt(0);
    if(s.indexOf('/*')===0||s.indexOf('//')===0||c0==='#'||s.indexOf('--')===0||s.indexOf(';;')===0)cls='t-c';
    else if(c0==='"'||c0==="'"||c0===BT)cls='t-s';
    else if(c0>='0'&&c0<='9')cls='t-n';
    else if(KWSET[s])cls='t-k';
    else if(src.charAt(m.index+s.length)==='('||src.charAt(m.index+s.length)==='<')cls='t-f';
    if(cls){var parts=s.split('\n');
      for(var pi=0;pi<parts.length;pi++){if(pi)out+='\n';out+='<span class="'+cls+'">'+esc(parts[pi])+'</span>'}}
    else out+=esc(s);
    i=m.index+s.length}
  out+=esc(src.slice(i));
  return out}

function srcHtml(n,gi){
  var body=D.bodies[String(gi)];
  if(!body)return '<div class="note">Source is not embedded for this symbol — the map keeps its bodies to the highest-PageRank symbols so the file stays small.<br><br>Run <code>symbra symbol '+esc(n.name)+'</code> to print it, or <a href="'+vscodeHref(n)+'">open it in VS Code</a>.</div>';
  var lines=body.split('\n');
  var trunc=(n.endLine-n.line+1)>lines.length;
  var html=highlight(body).split('\n');
  var h='<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">'+
    '<span class="muted" style="font:11px var(--mono)">'+esc(n.file)+':'+n.line+'</span>'+
    '<a href="'+vscodeHref(n)+'">Open in VS Code ↗</a></div>';
  h+='<div class="src">';
  for(var i=0;i<html.length;i++)h+='<span class="ln"><span class="g">'+(n.line+i)+'</span>'+html[i]+'</span>';
  h+='</div>';
  if(trunc)h+='<div class="muted" style="margin-top:8px;font-size:12px">Showing the first '+lines.length+' of '+(n.endLine-n.line+1)+' lines.</div>';
  return h}

/* -------------------------------------------------------- interactions */
function stagePos(e){var r=cv.getBoundingClientRect();return [e.clientX-r.left,e.clientY-r.top]}
var drag=null;
cv.addEventListener('mousedown',function(e){
  var p=stagePos(e);drag={sx:e.clientX,sy:e.clientY,vx:view.x,vy:view.y,moved:false};cv.classList.add('grabbing')});
addEventListener('mousemove',function(e){
  if(drag){var dx=e.clientX-drag.sx,dy=e.clientY-drag.sy;
    if(Math.abs(dx)+Math.abs(dy)>3)drag.moved=true;
    view.x=drag.vx+dx;view.y=drag.vy+dy;hideTip();requestDraw();return}
  var r=cv.getBoundingClientRect();
  if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom){
    if(hover!=null&&hover>=0){hover=-1;hideTip();requestDraw()}return}
  var p=stagePos(e);var h=pick(p[0],p[1]);
  if(h!==hover){hover=h;cv.classList.toggle('point',h>=0);requestDraw()}
  if(h>=0)showTip(nodes[h],e.clientX,e.clientY);else hideTip()});
addEventListener('mouseup',function(e){
  if(!drag)return;var moved=drag.moved;drag=null;cv.classList.remove('grabbing');
  if(moved)return;
  var r=cv.getBoundingClientRect();
  if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)return;
  var p=stagePos(e);var i=pick(p[0],p[1]);
  if(i<0){if(sel!=null){sel=null;closeDrawer();syncChrome();requestDraw()}return}
  if(mode==='comm')buildSym(nodes[i].c,true);
  else{if(nodes[i].ctx&&nodes[i].c!==focus){openGlobal(nodes[i].gi)}else{sel=i;openDrawer();syncChrome();requestDraw()}}});
cv.addEventListener('dblclick',function(e){
  var p=stagePos(e);var i=pick(p[0],p[1]);
  if(i>=0)centerOn(nodes[i],Math.min(4,view.k*1.9),300);else fit(true)});
cv.addEventListener('wheel',function(e){
  e.preventDefault();
  var p=stagePos(e);
  var f=Math.exp(-e.deltaY*(e.deltaMode===1?0.03:0.0015));
  var nk=Math.max(0.04,Math.min(60,view.k*f));f=nk/view.k;
  view.x=p[0]-(p[0]-view.x)*f;view.y=p[1]-(p[1]-view.y)*f;view.k=nk;
  hideTip();requestDraw()},{passive:false});

function showTip(p,cx,cy){
  var h;
  if(p.kind==='comm'){
    var c=p.comm;
    h='<div class="t">'+esc(labelOf(c))+'</div><div class="m">subsystem · '+nf(c.size)+' symbols'+(c.peripheral?' · peripheral':'')+'</div>'+
      (c.dirs.length?'<div class="f">'+esc(c.dirs.slice(0,3).join('  '))+'</div>':'')}
  else{var n=p.n;
    h='<div class="t">'+esc(n.name)+'</div><div class="m">'+esc(n.kind)+
      (p.ctx?' · <span style="color:'+col(n.c,1)+'">'+esc(commById[n.c]?labelOf(commById[n.c]):'')+'</span>':'')+'</div>'+
      '<div class="f">'+esc(n.file)+':'+n.line+'</div>'}
  tip.innerHTML=h;tip.hidden=false;
  var r=stage.getBoundingClientRect();
  var x=cx-r.left+14,y=cy-r.top+16;
  if(x+tip.offsetWidth>r.width-8)x=cx-r.left-tip.offsetWidth-14;
  if(y+tip.offsetHeight>r.height-8)y=cy-r.top-tip.offsetHeight-14;
  tip.style.left=Math.max(6,x)+'px';tip.style.top=Math.max(6,y)+'px'}
function hideTip(){if(!tip.hidden)tip.hidden=true}
document.addEventListener('mouseleave',function(){hideTip();if(hover!=null&&hover>=0){hover=-1;requestDraw()}});
addEventListener('blur',function(){hideTip();if(hover!=null&&hover>=0){hover=-1;requestDraw()}});

/* --------------------------------------------------------------- hash */
function setHash(h){try{history.replaceState(null,'',h?location.pathname+location.search+'#'+h:location.pathname+location.search)}catch(e){}}
function parseHash(){var m=/(?:^|[#&])c=(-?\d+)/.exec(location.hash);return m?parseInt(m[1],10):null}
addEventListener('hashchange',function(){
  var id=parseHash();
  if(id!=null&&commById[id]!==undefined){if(id!==focus)buildSym(id,true)}
  else if(mode!=='comm')buildComm()});

/* ------------------------------------------------------------ keyboard */
var qEl=$('q');
qEl.addEventListener('input',function(){query=qEl.value.trim().toLowerCase();runSearch()});
qEl.addEventListener('keydown',function(e){
  if(e.key==='ArrowDown'){e.preventDefault();moveRes(1)}
  else if(e.key==='ArrowUp'){e.preventDefault();moveRes(-1)}
  else if(e.key==='Enter'){e.preventDefault();if(results.length){if(resSel<0)resSel=0;renderResults();openGlobal(results[resSel].gi)}}
  else if(e.key==='Escape'){e.preventDefault();if(qEl.value){qEl.value='';query='';runSearch()}else qEl.blur()}});
addEventListener('keydown',function(e){
  var inField=/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement&&document.activeElement.tagName||'');
  if(e.key==='/'&&!inField){e.preventDefault();qEl.focus();qEl.select();return}
  if(e.key==='Escape'){
    if(inField)return;
    if(drawer.classList.contains('open')){closeDrawer();sel=null;syncChrome();requestDraw()}
    else if(mode==='sym')buildComm();
    return}
  if(inField)return;
  if(e.key==='f'){e.preventDefault();fit(true)}
  else if(e.key==='t'){e.preventDefault();toggleTheme()}
  else if(e.key==='ArrowDown'&&results.length){e.preventDefault();moveRes(1)}
  else if(e.key==='ArrowUp'&&results.length){e.preventDefault();moveRes(-1)}
  else if(e.key==='Enter'&&results.length&&resSel>=0){e.preventDefault();openGlobal(results[resSel].gi)}});

/* --------------------------------------------------------------- chrome */
$('btnFit').onclick=function(){fit(true)};
$('btnTheme').onclick=toggleTheme;
$('btnPng').onclick=function(){
  var scale=2,pw=W*scale,ph=H*scale;
  var o=document.createElement('canvas');o.width=pw;o.height=ph;
  var g=o.getContext('2d');
  g.setTransform(scale,0,0,scale,0,0);
  g.fillStyle=T().bg;g.fillRect(0,0,W,H);
  var hv=hover;hover=-1;
  drawScene(g,W,H,view,false);
  hover=hv;
  g.font='600 12px '+FONT;g.fillStyle=T().muted;g.textAlign='right';
  g.fillText('Symbra · '+D.repo+(mode==='sym'&&commById[focus]?' · '+labelOf(commById[focus]):''),W-14,H-14);
  var a=document.createElement('a');
  a.download='symbra-'+D.repo+(mode==='sym'?'-'+focus:'')+'.png';
  try{a.href=o.toDataURL('image/png')}catch(err){return}
  document.body.appendChild(a);a.click();document.body.removeChild(a)};

/* --------------------------------------------------------------- boot */
applyTheme();
buildFilters();
buildSubs();
booted=true;
resize();
var initC=parseHash();
if(initC!=null&&commById[initC]!==undefined)buildSym(initC,false);else buildComm();
setTimeout(function(){$('hint').classList.add('gone')},9000);
})();
`;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function writeViz(store: Store, root: string, out: string): string {
  const data = buildVizData(store, root);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, renderViz(data));
  return out;
}
