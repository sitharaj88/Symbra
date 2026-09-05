import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
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
}

interface VizData {
  root: string;
  generated: string;
  stats: { files: number; symbols: number; edges: number };
  communities: { id: number; label: string; size: number; dirs: string[]; peripheral: boolean }[];
  nodes: VizNode[];
  edges: [number, number, string][]; // node index, node index, kind
  commEdges: [number, number, number][]; // community, community, weight
}

const MAX_NODES = 2500;

export function buildVizData(store: Store, root: string): VizData {
  const comms = store.prep('SELECT community, label, size, dirs, peripheral FROM community_labels WHERE level = 0 ORDER BY size DESC').all() as { community: number; label: string; size: number; dirs: string; peripheral: number }[];
  const communities = comms.map((c) => ({ id: c.community, label: c.label, size: c.size, dirs: JSON.parse(c.dirs) as string[], peripheral: !!c.peripheral }));
  const total = store.countSymbols();
  // Pick nodes: all if small, else top-N by pagerank with a per-community floor.
  const rows = store
    .prep(
      "SELECT s.*, COALESCE(m.pagerank,0) AS pr, COALESCE(m.callers,0) AS callers, c.community AS comm FROM symbols s LEFT JOIN metrics m ON m.symbol = s.id LEFT JOIN communities c ON c.symbol = s.id AND c.level = 0 WHERE s.kind NOT IN ('module','test','section','enum_member','field','variable','constant','config_key') AND c.community IS NOT NULL ORDER BY pr DESC",
    )
    .all() as (SymbolRow & { pr: number; callers: number; comm: number })[];
  let chosen = rows;
  if (rows.length > MAX_NODES) {
    const perComm = new Map<number, number>();
    chosen = [];
    for (const r of rows) {
      const n = perComm.get(r.comm) ?? 0;
      if (chosen.length < MAX_NODES * 0.7 || n < 8) {
        chosen.push(r);
        perComm.set(r.comm, n + 1);
      }
      if (chosen.length >= MAX_NODES) break;
    }
  }
  const index = new Map<string, number>();
  const nodes: VizNode[] = chosen.map((r, i) => {
    index.set(r.id, i);
    return { id: r.id, name: r.name, fqn: r.fqn, kind: r.kind, file: r.file, line: r.start_line, endLine: r.end_line, c: r.comm, pr: Math.round(r.pr * 10) / 10, callers: r.callers, sig: r.signature.slice(0, 160), doc: r.doc.split('\n')[0]!.slice(0, 160) };
  });
  const edges: [number, number, string][] = [];
  const commW = new Map<string, number>();
  const commOf = new Map<string, number>();
  for (const r of store.prep('SELECT symbol, community FROM communities WHERE level = 0').all() as { symbol: string; community: number }[]) commOf.set(r.symbol, r.community);
  for (const e of store.prep("SELECT src, dst, kind FROM edges WHERE kind IN ('calls','extends','implements','references','passes','defines_route')").all() as { src: string; dst: string; kind: string }[]) {
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
  return { root, generated: new Date().toISOString(), stats: { files: store.allFiles().length, symbols: total, edges: store.countEdges() }, communities, nodes, edges, commEdges };
}

export function renderViz(data: VizData): string {
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Symbra map · ${escapeHtml(data.root.split('/').pop() ?? 'repo')}</title>
<style>
:root{--bg:#0f1115;--panel:#171a21;--ink:#e6e8ee;--muted:#8b93a7;--line:#2a2f3a;--accent:#7aa2f7}
html,body{margin:0;height:100%;background:var(--bg);color:var(--ink);font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
#top{position:fixed;top:0;left:0;right:0;height:44px;display:flex;align-items:center;gap:10px;padding:0 12px;background:var(--panel);border-bottom:1px solid var(--line);z-index:2}
#top b{font-weight:600}#top input{flex:1;max-width:420px;background:#0f1115;border:1px solid var(--line);color:var(--ink);padding:6px 8px;border-radius:6px}
#top button,#top select{background:#0f1115;border:1px solid var(--line);color:var(--ink);padding:5px 9px;border-radius:6px;cursor:pointer}
#top .muted{color:var(--muted)}
canvas{position:fixed;top:44px;left:0;right:0;bottom:0;display:block;cursor:grab}
#side{position:fixed;top:44px;right:0;bottom:0;width:340px;background:var(--panel);border-left:1px solid var(--line);overflow:auto;padding:12px;display:none;z-index:2}
#side h3{margin:0 0 6px;font-size:14px;word-break:break-all}#side .k{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.04em;margin-top:10px}
#side code{font:12px ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;word-break:break-all;color:#c0caf5}
#side a{color:var(--accent);text-decoration:none}#side li{list-style:none;margin:2px 0}#side ul{padding:0;margin:0}
#legend{position:fixed;left:12px;bottom:12px;background:rgba(23,26,33,.92);border:1px solid var(--line);border-radius:8px;padding:8px 10px;max-width:320px;max-height:40vh;overflow:auto;font-size:12px;z-index:2}
#legendBody>div{display:flex;align-items:center;gap:6px;cursor:pointer;padding:1px 0}#legend i{width:10px;height:10px;border-radius:50%;display:inline-block}
#legendToggle{cursor:pointer;font-weight:600;color:var(--muted);user-select:none;margin-bottom:4px}
#legend.collapsed #legendBody{display:none}
#hint{position:fixed;left:12px;top:56px;color:var(--muted);font-size:12px;z-index:2}
</style></head><body>
<div id="top"><b>Symbra</b><span class="muted">${escapeHtml(data.root.split('/').pop() ?? '')} · ${data.stats.files} files · ${data.stats.symbols} symbols · ${data.stats.edges} edges</span>
<input id="q" placeholder="search symbols…" autocomplete="off"><select id="kind"><option value="">all kinds</option></select><button id="back">◀ subsystems</button><button id="fit">fit</button></div>
<div id="hint">click a subsystem to expand · click a symbol for details · drag to pan · wheel to zoom</div>
<canvas id="c"></canvas><div id="legend"><div id="legendToggle">▾ legend</div><div id="legendBody"></div></div><div id="side"></div>
<script id="data" type="application/json">${json}</script>
<script>
(()=>{
const D=JSON.parse(document.getElementById('data').textContent);
const cv=document.getElementById('c'),ctx=cv.getContext('2d');const side=document.getElementById('side');
const PAL=['#7aa2f7','#9ece6a','#f7768e','#e0af68','#bb9af7','#7dcfff','#ff9e64','#73daca','#c0caf5','#f4a261','#2a9d8f','#e76f51','#8ecae6','#ffb703','#b5e48c','#ff85a1','#a8dadc','#ffd166','#06d6a0','#ef476f'];
const col=c=>PAL[c%PAL.length];
let W,H,dpr=window.devicePixelRatio||1;function resize(){W=innerWidth;H=innerHeight-44;cv.width=W*dpr;cv.height=H*dpr;cv.style.width=W+'px';cv.style.height=H+'px';ctx.setTransform(dpr,0,0,dpr,0,0);draw()}addEventListener('resize',resize);
let view={x:0,y:0,k:1};let mode='comm';let focus=null;let nodes=[],links=[],sel=null,hover=null,filterKind='',query='';let labelBoxes=[];
const byComm=new Map();D.nodes.forEach((n,i)=>{if(!byComm.has(n.c))byComm.set(n.c,[]);byComm.get(n.c).push(i)});
const adj=new Map();D.edges.forEach(([a,b,k])=>{(adj.get(a)||adj.set(a,[]).get(a)).push([b,k,0]);(adj.get(b)||adj.set(b,[]).get(b)).push([a,k,1])});
const kinds=[...new Set(D.nodes.map(n=>n.kind))].sort();for(const k of kinds){const o=document.createElement('option');o.value=k;o.textContent=k;document.getElementById('kind').appendChild(o)}
function layout(ns,ls,iters){const n=ns.length;if(!n)return;const isComm=mode==='comm';
if(isComm){
const coreIdx=[],periphIdx=[];for(let i=0;i<n;i++)(ns[i].peripheral?periphIdx:coreIdx).push(i);
const degree=new Map();for(const [i,j] of ls){if(!ns[i].peripheral&&!ns[j].peripheral){degree.set(i,(degree.get(i)||0)+1);degree.set(j,(degree.get(j)||0)+1)}}
const linkedIdx=[],unlinkedIdx=[];for(const i of coreIdx)((degree.get(i)||0)>0?linkedIdx:unlinkedIdx).push(i);
const nl=linkedIdx.length||1;const Rlinked=Math.sqrt(nl)*30+60;const Rcap=Rlinked*1.6;
linkedIdx.forEach((i,k)=>{const a=k*2.399963;const r=Rlinked*Math.sqrt((k+.5)/nl);ns[i].x=Math.cos(a)*r;ns[i].y=Math.sin(a)*r;ns[i].vx=0;ns[i].vy=0});
const nu=unlinkedIdx.length||1;
unlinkedIdx.forEach((i,k)=>{const a=k*2.399963+1.7;const r=Rlinked*0.75+(Rcap-Rlinked*0.75)*Math.sqrt((k+.5)/nu);ns[i].x=Math.cos(a)*r;ns[i].y=Math.sin(a)*r;ns[i].vx=0;ns[i].vy=0});
const coreLinks=ls.filter(([i,j])=>!ns[i].peripheral&&!ns[j].peripheral);
for(let it=0;it<iters;it++){const t=1-it/iters;const rep=1200*t+80;
for(let a=0;a<coreIdx.length;a++){const A=ns[coreIdx[a]];for(let b=a+1;b<coreIdx.length;b++){const B=ns[coreIdx[b]];let dx=A.x-B.x,dy=A.y-B.y;let d2=dx*dx+dy*dy+0.01;const rSum=A.r+B.r;const sizeK=1+rSum*0.05;if(d2>90000*sizeK*sizeK)continue;const d=Math.sqrt(d2);const f=(rep*sizeK)/d2;let fx=dx*f,fy=dy*f;const minSep=rSum+28;if(d<minSep){const push=(minSep-d)*2.5;fx+=dx/d*push;fy+=dy/d*push}A.vx+=fx;A.vy+=fy;B.vx-=fx;B.vy-=fy}}
for(const [i,j,w] of coreLinks){const A=ns[i],B=ns[j];const dx=B.x-A.x,dy=B.y-A.y;const d=Math.sqrt(dx*dx+dy*dy)+0.01;const rest=A.r+B.r+90;const strength=0.008;const f=(d-rest)*strength*(w||1);A.vx+=dx/d*f;A.vy+=dy/d*f;B.vx-=dx/d*f;B.vy-=dy/d*f}
for(const i of coreIdx){const p=ns[i];const gk=0.012/(1+p.r/20);p.vx-=p.x*gk;p.vy-=p.y*gk;p.x+=p.vx*0.6;p.y+=p.vy*0.6;p.vx*=0.5;p.vy*=0.5}}
for(let sweep=0;sweep<20;sweep++){let any=false;for(let a=0;a<coreIdx.length;a++){const A=ns[coreIdx[a]];for(let b=a+1;b<coreIdx.length;b++){const B=ns[coreIdx[b]];const minD=A.r+B.r+28;let dx=B.x-A.x,dy=B.y-A.y;let d=Math.sqrt(dx*dx+dy*dy);if(d<1e-3){const ang=(a*7+b*13)%6.283;dx=Math.cos(ang);dy=Math.sin(ang);d=1e-3}if(d<minD){const overlap=(minD-d)/2;const ux=dx/d,uy=dy/d;A.x-=ux*overlap;A.y-=uy*overlap;B.x+=ux*overlap;B.y+=uy*overlap;any=true}}}if(!any)break}
let ccx=0,ccy=0;for(const i of coreIdx){ccx+=ns[i].x;ccy+=ns[i].y}if(coreIdx.length){ccx/=coreIdx.length;ccy/=coreIdx.length}
let coreR=60;for(const i of coreIdx){const p=ns[i];const d=Math.hypot(p.x-ccx,p.y-ccy)+p.r;if(d>coreR)coreR=d}
const periphSorted=[...periphIdx].sort((x,y)=>(ns[y].size||0)-(ns[x].size||0));
const ringR=coreR+80;const np=periphSorted.length||1;
periphSorted.forEach((i,k)=>{const a=(k/np)*6.283185+0.5;const jitter=(k%2)*24;ns[i].x=ccx+Math.cos(a)*(ringR+jitter);ns[i].y=ccy+Math.sin(a)*(ringR+jitter);ns[i].vx=0;ns[i].vy=0});
for(let sweep=0;sweep<20;sweep++){let any=false;
for(let a=0;a<periphSorted.length;a++){const A=ns[periphSorted[a]];
const dOrigin=Math.hypot(A.x-ccx,A.y-ccy)||1e-3;const minFromCore=coreR+A.r+20;if(dOrigin<minFromCore){A.x=ccx+(A.x-ccx)/dOrigin*minFromCore;A.y=ccy+(A.y-ccy)/dOrigin*minFromCore;any=true}
for(let b=a+1;b<periphSorted.length;b++){const B=ns[periphSorted[b]];const minD=A.r+B.r+16;let dx=B.x-A.x,dy=B.y-A.y;let d=Math.sqrt(dx*dx+dy*dy);if(d<1e-3){const ang=(a*7+b*13)%6.283;dx=Math.cos(ang);dy=Math.sin(ang);d=1e-3}if(d<minD){const overlap=(minD-d)/2;const ux=dx/d,uy=dy/d;A.x-=ux*overlap;A.y-=uy*overlap;B.x+=ux*overlap;B.y+=uy*overlap;any=true}}}
if(!any)break}
}else{const R=Math.sqrt(n)*28+60;ns.forEach((p,i)=>{const a=i*2.399963;const r=R*Math.sqrt((i+.5)/n);p.x=Math.cos(a)*r;p.y=Math.sin(a)*r;p.vx=0;p.vy=0});
for(let it=0;it<iters;it++){const t=1-it/iters;const rep=1200*t+80;for(let i=0;i<n;i++){const a=ns[i];for(let j=i+1;j<n;j++){const b=ns[j];let dx=a.x-b.x,dy=a.y-b.y;let d2=dx*dx+dy*dy+0.01;const rSum=a.r+b.r;const sizeK=1+rSum*0.05;if(d2>90000*sizeK*sizeK)continue;const d=Math.sqrt(d2);const f=(rep*sizeK)/d2;let fx=dx*f,fy=dy*f;const minSep=rSum+24;if(d<minSep){const push=(minSep-d)*2.5;fx+=dx/d*push;fy+=dy/d*push}a.vx+=fx;a.vy+=fy;b.vx-=fx;b.vy-=fy}}
for(const [i,j,w] of ls){const a=ns[i],b=ns[j];const dx=b.x-a.x,dy=b.y-a.y;const d=Math.sqrt(dx*dx+dy*dy)+0.01;const rest=a.r+b.r+30;const strength=0.02;const f=(d-rest)*strength*(w||1);a.vx+=dx/d*f;a.vy+=dy/d*f;b.vx-=dx/d*f;b.vy-=dy/d*f}
for(const p of ns){const gk=0.004;p.vx-=p.x*gk;p.vy-=p.y*gk;p.x+=p.vx*0.6;p.y+=p.vy*0.6;p.vx*=0.5;p.vy*=0.5}}}
}
function setHash(h){try{history.replaceState(null,'',h?location.pathname+location.search+'#'+h:location.pathname+location.search)}catch(e){}}
function parseHash(){const m=/(?:^|[#&])c=(-?\d+)/.exec(location.hash);return m?parseInt(m[1],10):null}
function showComms(){mode='comm';focus=null;sel=null;const cs=D.communities;nodes=cs.map(c=>{const r0=c.size<3?5:8+Math.sqrt(c.size)*2.2;const r=c.peripheral?r0*0.6:r0;return{id:'c'+c.id,c:c.id,label:c.label,size:c.size,r,tiny:c.size<3||c.peripheral,peripheral:c.peripheral,comm:c}});const idx=new Map(cs.map((c,i)=>[c.id,i]));links=D.commEdges.filter(([a,b])=>idx.has(a)&&idx.has(b)).map(([a,b,w])=>[idx.get(a),idx.get(b),Math.min(3,Math.log2(w+1))]);layout(nodes,links,400);legend();fit();placeLabels();fit();draw();side.style.display='none';setHash('')}
function showComm(cid){mode='sym';focus=cid;sel=null;const ids=byComm.get(cid)||[];const local=new Map(ids.map((i,j)=>[i,j]));nodes=ids.map(i=>{const n=D.nodes[i];return{id:n.id,gi:i,n,c:n.c,r:4+Math.min(14,Math.sqrt(n.pr+n.callers)*1.6)}});links=[];for(const [a,b,k] of D.edges){const la=local.get(a),lb=local.get(b);if(la!==undefined&&lb!==undefined)links.push([la,lb,1,k])}layout(nodes,links,300);labelBoxes=[];legend();fit();side.style.display='none';setHash('c='+cid)}
function boxHitsCircle(x0,y0,x1,y1,cx,cy,cr){const nx=Math.max(x0,Math.min(cx,x1));const ny=Math.max(y0,Math.min(cy,y1));const dx=cx-nx,dy=cy-ny;return dx*dx+dy*dy<cr*cr}
function placeLabels(){
if(mode!=='comm'){for(const p of nodes){p.showLabel=true;p.lx=p.r+3/view.k;p.ly=0;p.leader=false;p.labelFs=null}labelBoxes=[];return}
const fsBase=11/view.k,fsSmall=10/view.k;const gap=4/view.k;const placed=[];
const order=[...nodes].sort((a,b)=>b.r-a.r);
const mkCands=(p,tw,fs)=>[
{lx:p.r+gap,ly:fs/3},
{lx:-p.r-gap-tw,ly:fs/3},
{lx:-tw/2,ly:p.r+gap+fs},
{lx:-tw/2,ly:-p.r-gap},
{lx:p.r*0.7+gap,ly:-p.r*0.7-gap},
{lx:-p.r*0.7-gap-tw,ly:-p.r*0.7-gap},
{lx:p.r*0.7+gap,ly:p.r*0.7+gap+fs},
{lx:-p.r*0.7-gap-tw,ly:p.r*0.7+gap+fs},
];
for(const p of order){
p.leader=false;p.labelFs=null;
if(p.tiny){p.showLabel=false;continue}
p.showLabel=true;
const label='#'+p.c+' '+p.label;
let fs=fsBase;ctx.font=fs+'px sans-serif';let tw=ctx.measureText(label).width;
let cands=mkCands(p,tw,fs);
let chosen=null,box=null;
for(const c of cands){
const x0=p.x+c.lx,x1=x0+tw,y1=p.y+c.ly+fs*0.3,y0=y1-fs*1.1;
let hit=false;
for(const b of placed){if(x0<b.x1&&x1>b.x0&&y0<b.y1&&y1>b.y0){hit=true;break}}
if(!hit){for(const q of nodes){if(q===p)continue;if(boxHitsCircle(x0,y0,x1,y1,q.x,q.y,q.r)){hit=true;break}}}
if(!hit){chosen=c;box={x0,y0,x1,y1};break}
}
if(!chosen){
fs=fsSmall;ctx.font=fs+'px sans-serif';tw=ctx.measureText(label).width;
cands=mkCands(p,tw,fs);
const c=cands[0];
const x0=p.x+c.lx,x1=x0+tw,y1=p.y+c.ly+fs*0.3,y0=y1-fs*1.1;
chosen=c;box={x0,y0,x1,y1};p.leader=true;
}
placed.push(box);
p.lx=chosen.lx;p.ly=chosen.ly;p.labelFs=fs;
}
labelBoxes=placed;
}
function fit(){if(!nodes.length)return;let x0=1e9,y0=1e9,x1=-1e9,y1=-1e9;
const core=mode==='comm'?nodes.filter(p=>!p.peripheral):nodes;
const boundNodes=(mode==='comm'&&core.length>=3)?core:nodes;
for(const p of boundNodes){x0=Math.min(x0,p.x-p.r);y0=Math.min(y0,p.y-p.r);x1=Math.max(x1,p.x+p.r);y1=Math.max(y1,p.y+p.r)}
if(mode==='comm')for(const b of labelBoxes){x0=Math.min(x0,b.x0);y0=Math.min(y0,b.y0);x1=Math.max(x1,b.x1);y1=Math.max(y1,b.y1)}
const pad=60;
const legendEl=document.getElementById('legend');
const legendW=legendEl?legendEl.offsetWidth+16:0;
const legendH=legendEl?legendEl.offsetHeight+16:0;
const sideW=side.style.display==='block'?340:0;
const availX0=legendW,availX1=W-sideW,availY0=0,availY1=H-legendH;
const availW=Math.max(80,availX1-availX0-pad);
const availH=Math.max(80,availY1-availY0-pad);
let k=Math.min(availW/(x1-x0+1),availH/(y1-y0+1),3);
if(boundNodes.length){let maxR=0;for(const p of boundNodes)if(p.r>maxR)maxR=p.r;const capDiam=W*0.12;if(maxR*2*k>capDiam)k=capDiam/(maxR*2)}
view.k=k;
const cx=(availX0+availX1)/2,cy=(availY0+availY1)/2;
view.x=cx-(x0+x1)/2*k;
view.y=cy-(y0+y1)/2*k;
draw()}
function legend(){const L=document.getElementById('legendBody');L.innerHTML='';const cs=mode==='comm'?[...D.communities].sort((a,b)=>(a.peripheral===b.peripheral?0:a.peripheral?1:-1)).slice(0,24):D.communities.filter(c=>c.id===focus);for(const c of cs){const d=document.createElement('div');if(c.peripheral)d.style.opacity='0.6';d.innerHTML='<i style="background:'+col(c.id)+'"></i><span>#'+c.id+' '+esc(c.label)+' <span style="color:#8b93a7">('+c.size+')</span>'+(c.peripheral?' <span style="color:#8b93a7">[peripheral]</span>':'')+'</span>';d.onclick=()=>showComm(c.id);L.appendChild(d)}}
function esc(s){return String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}
function visible(p){if(mode!=='sym')return true;if(filterKind&&p.n.kind!==filterKind)return false;if(query&&!(p.n.fqn.toLowerCase().includes(query)||p.n.file.toLowerCase().includes(query)))return false;return true}
function draw(){ctx.clearRect(0,0,W,H);ctx.save();ctx.translate(view.x,view.y);ctx.scale(view.k,view.k);
const hl=new Set();if(sel!=null&&mode==='sym'){for(const [a,b] of links){if(a===sel)hl.add(b);if(b===sel)hl.add(a)}}
ctx.lineWidth=1/view.k;for(const [a,b,w,k] of links){const A=nodes[a],B=nodes[b];if(!visible(A)||!visible(B))continue;const on=sel!=null&&(a===sel||b===sel);ctx.strokeStyle=on?'rgba(122,162,247,.9)':mode==='comm'?'rgba(139,147,167,'+(0.15+w*0.12)+')':k==='calls'?'rgba(139,147,167,.35)':k==='extends'||k==='implements'?'rgba(158,206,106,.5)':'rgba(139,147,167,.18)';ctx.lineWidth=(on?2:mode==='comm'?w:1)/view.k;ctx.beginPath();ctx.moveTo(A.x,A.y);ctx.lineTo(B.x,B.y);ctx.stroke();
if(mode==='sym'&&(on||view.k>1.2)){const ang=Math.atan2(B.y-A.y,B.x-A.x);const tx=B.x-Math.cos(ang)*B.r,ty=B.y-Math.sin(ang)*B.r;ctx.fillStyle=ctx.strokeStyle;ctx.beginPath();ctx.moveTo(tx,ty);ctx.lineTo(tx-Math.cos(ang-0.4)*6/view.k,ty-Math.sin(ang-0.4)*6/view.k);ctx.lineTo(tx-Math.cos(ang+0.4)*6/view.k,ty-Math.sin(ang+0.4)*6/view.k);ctx.fill()}}
for(let i=0;i<nodes.length;i++){const p=nodes[i];if(!visible(p))continue;const dim=sel!=null&&i!==sel&&!hl.has(i);const peripheralFade=mode==='comm'&&p.peripheral?0.5:1;ctx.globalAlpha=(dim?0.35:1)*peripheralFade;ctx.fillStyle=col(p.c);ctx.beginPath();ctx.arc(p.x,p.y,p.r,0,6.283);ctx.fill();if(i===sel||i===hover){ctx.strokeStyle='#fff';ctx.lineWidth=2/view.k;ctx.stroke()}
if(mode==='comm'){const showLbl=p.showLabel||i===hover;if(showLbl){const label='#'+p.c+' '+p.label;const fs=p.labelFs||11/view.k;ctx.font=fs+'px sans-serif';const lx=p.x+(p.lx!==undefined?p.lx:p.r+3/view.k),ly=p.y+(p.ly!==undefined?p.ly:fs/3);if(p.leader){const ang=Math.atan2(ly-p.y,lx-p.x);ctx.strokeStyle=dim?'rgba(139,147,167,.3)':'rgba(139,147,167,.6)';ctx.lineWidth=1/view.k;ctx.beginPath();ctx.moveTo(p.x+Math.cos(ang)*p.r,p.y+Math.sin(ang)*p.r);ctx.lineTo(lx,ly-fs*0.3);ctx.stroke()}ctx.fillStyle=dim?'rgba(230,232,238,.4)':'#e6e8ee';ctx.fillText(label,lx,ly)}}else{const label=p.n.name;const fs=Math.max(10/view.k,9);if(p.r>7||view.k>1.6||i===sel||hl.has(i)){ctx.font=fs+'px sans-serif';ctx.fillStyle=dim?'rgba(230,232,238,.4)':'#e6e8ee';ctx.fillText(label,p.x+p.r+3/view.k,p.y+fs/3)}}ctx.globalAlpha=1}
ctx.restore()}
function pick(mx,my){const x=(mx-view.x)/view.k,y=(my-view.y)/view.k;let best=-1,bd=1e9;for(let i=0;i<nodes.length;i++){const p=nodes[i];if(!visible(p))continue;const d=Math.hypot(p.x-x,p.y-y);if(d<p.r+4/view.k&&d<bd){bd=d;best=i}}return best}
let drag=null,downOnCanvas=false;cv.addEventListener('mousedown',e=>{downOnCanvas=true;drag={x:e.clientX,y:e.clientY,vx:view.x,vy:view.y,moved:false}});
addEventListener('mousemove',e=>{if(drag){const dx=e.clientX-drag.x,dy=e.clientY-drag.y;if(Math.abs(dx)+Math.abs(dy)>3)drag.moved=true;view.x=drag.vx+dx;view.y=drag.vy+dy;draw();return}const h=pick(e.clientX,e.clientY-44);if(h!==hover){hover=h;cv.style.cursor=h>=0?'pointer':'grab';draw()}});
addEventListener('mouseup',e=>{if(!drag||!downOnCanvas){downOnCanvas=false;return}downOnCanvas=false;const moved=drag.moved;drag=null;if(moved)return;const i=pick(e.clientX,e.clientY-44);if(i<0){sel=null;draw();return}if(mode==='comm'){showComm(nodes[i].c)}else{sel=i;detail(nodes[i]);draw()}});
cv.addEventListener('wheel',e=>{e.preventDefault();const f=Math.exp(-e.deltaY*0.0015);const mx=e.clientX,my=e.clientY-44;view.x=mx-(mx-view.x)*f;view.y=my-(my-view.y)*f;view.k*=f;draw()},{passive:false});
function detail(p){const n=p.n;const c=D.communities.find(c=>c.id===n.c);const rows=(adj.get(p.gi)||[]);const outs=rows.filter(r=>r[2]===0),ins=rows.filter(r=>r[2]===1);const li=(r)=>{const m=D.nodes[r[0]];return'<li><a href="#" data-g="'+r[0]+'">'+esc(m.fqn)+'</a> <span style="color:#8b93a7">'+r[1]+'</span></li>'};
side.innerHTML='<h3>'+esc(n.fqn)+'</h3><div><span style="color:'+col(n.c)+'">●</span> '+esc(n.kind)+' · <a href="vscode://file/'+encodeURI(D.root+'/'+n.file)+':'+n.line+'">'+esc(n.file)+':'+n.line+'-'+n.endLine+'</a></div>'+(n.sig?'<div class="k">signature</div><code>'+esc(n.sig)+'</code>':'')+(n.doc?'<div class="k">doc</div><div>'+esc(n.doc)+'</div>':'')+'<div class="k">importance</div><div>pagerank '+n.pr+' · callers '+n.callers+' · subsystem #'+n.c+' '+esc(c?c.label:'')+'</div>'+(ins.length?'<div class="k">incoming ('+ins.length+')</div><ul>'+ins.slice(0,40).map(li).join('')+'</ul>':'')+(outs.length?'<div class="k">outgoing ('+outs.length+')</div><ul>'+outs.slice(0,40).map(li).join('')+'</ul>':'');side.style.display='block';
side.querySelectorAll('a[data-g]').forEach(a=>a.onclick=ev=>{ev.preventDefault();const g=+a.dataset.g;const m=D.nodes[g];if(m.c!==focus)showComm(m.c);const i=nodes.findIndex(q=>q.gi===g);if(i>=0){sel=i;detail(nodes[i]);view.x=W/2-nodes[i].x*view.k-170;view.y=H/2-nodes[i].y*view.k;draw()}})}
const legendToggle=document.getElementById('legendToggle');
let legendCollapsed=true;try{const v=localStorage.getItem('symbraLegendCollapsed');if(v!==null)legendCollapsed=v==='1'}catch(e){}
function syncLegendUI(){document.getElementById('legend').classList.toggle('collapsed',legendCollapsed);legendToggle.textContent=(legendCollapsed?'▸':'▾')+' legend'}
legendToggle.onclick=()=>{legendCollapsed=!legendCollapsed;try{localStorage.setItem('symbraLegendCollapsed',legendCollapsed?'1':'0')}catch(e){}syncLegendUI();fit()};
syncLegendUI();
document.getElementById('back').onclick=showComms;document.getElementById('fit').onclick=fit;
document.getElementById('kind').onchange=e=>{filterKind=e.target.value;draw()};
let qFocused=false;const qEl=document.getElementById('q');qEl.value='';qEl.addEventListener('focus',()=>{qFocused=true});
qEl.oninput=e=>{if(!qFocused)return;query=e.target.value.trim().toLowerCase();if(mode==='comm'&&query){const hit=D.nodes.findIndex(n=>n.fqn.toLowerCase().includes(query));if(hit>=0)showComm(D.nodes[hit].c)}draw()};
resize();
const initC=parseHash();
if(initC!=null&&D.communities.some(c=>c.id===initC))showComm(initC);else showComms();
addEventListener('hashchange',()=>{const id=parseHash();if(id!=null&&D.communities.some(c=>c.id===id)){if(id!==focus)showComm(id)}else if(mode!=='comm'){showComms()}});
})();
</script></body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function writeViz(store: Store, root: string, out: string): string {
  const data = buildVizData(store, root);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, renderViz(data));
  return out;
}
