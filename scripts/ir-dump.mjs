// Usage: node scripts/ir-dump.mjs <file> [--refs] [--imports]
import { readFileSync } from 'node:fs';
import { extractFile } from '../dist/index/extract.js';
const [file, ...flags] = process.argv.slice(2);
const src = readFileSync(file, 'utf8');
const t0 = performance.now();
const ir = await extractFile(file, src);
const ms = (performance.now() - t0).toFixed(1);
if (!ir) { console.log('unsupported'); process.exit(0); }
console.log(`# ${file} lang=${ir.language} ${ms}ms defs=${ir.definitions.length} refs=${ir.references.length} imports=${ir.imports.length} localTypes=${ir.localTypes.length} err=${ir.errorPct}%`);
if (ir.doc) console.log('moduleDoc:', JSON.stringify(ir.doc.slice(0, 80)));
for (const d of ir.definitions) console.log(`  [${d.kind}] ${d.fqn}  L${d.range.startLine}-${d.range.endLine} ${d.exported ? 'exp' : ''} ${d.modifiers.join(',')} ${d.supertypes.map(s => s.kind + ':' + s.name).join(' ')} :: ${d.signature.slice(0, 90)}${d.doc ? '  // ' + d.doc.split('\n')[0].slice(0, 50) : ''}`);
if (flags.includes('--imports')) for (const i of ir.imports) console.log(`  import ${i.kind} ${i.source} ${i.namespace ? '* as ' + i.alias : ''} ${i.names.map(n => n.name + (n.alias !== n.name ? ' as ' + n.alias : '')).join(', ')} L${i.line}${i.relativeLevel ? ' lvl=' + i.relativeLevel : ''}`);
if (flags.includes('--refs')) for (const r of ir.references) console.log(`  ref ${r.kind} ${r.qualifier ? r.qualifier + '.' : ''}${r.name}${r.arity !== undefined ? '/' + r.arity : ''} L${r.line} scope=${r.scope >= 0 ? ir.definitions[r.scope].fqn : '-'}`);
if (flags.includes('--types')) for (const t of ir.localTypes) console.log(`  type ${t.name}: ${t.type} (${t.via}) scope=${t.scope >= 0 ? ir.definitions[t.scope].fqn : '-'}`);
