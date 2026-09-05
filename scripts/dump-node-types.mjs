import { Parser, Language } from 'web-tree-sitter';
await Parser.init();
const want = process.argv.slice(2);
for (const name of want) {
  const L = await Language.load(`grammars/tree-sitter-${name}.wasm`);
  const named = new Set(), fields = new Set();
  for (let i = 0; i < L.nodeTypeCount; i++) if (L.nodeTypeIsNamed(i)) named.add(L.nodeTypeForId(i));
  for (let i = 1; i <= L.fieldCount; i++) { const f = L.fieldNameForId(i); if (f) fields.add(f); }
  console.log(`== ${name} (abi ${L.abiVersion}) named=${named.size} fields=${fields.size}`);
  console.log('FIELDS:', [...fields].sort().join(' '));
  const interesting = [...named].filter(t => /declar|defin|import|export|call|invoc|class|func|method|struct|interface|enum|trait|impl|module|namespace|package|use_|require|assign|member|attribute|selector|field|param|decorat|annot|comment|string|identifier|type|arrow|lambda|object|property|heritage|extends|implements|superclass|base|receiver|arguments|argument_list|new_|creation|record|const|static|var|let|lexical|generic|scoped|dotted|relative|alias|wildcard|body|block|program|source_file|expression_statement|return|macro|mod_|abstract|signature|spec|clause|path/.test(t));
  console.log('TYPES:', interesting.sort().join(' '));
  console.log();
}
