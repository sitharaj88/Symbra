#!/usr/bin/env node
// V8's optimizing wasm compiler exhausts its zone memory on the largest tree-sitter grammars
// (Node 25 + Swift). Baseline-only wasm compilation must be chosen at process start and costs
// nothing measurable for parsing, so the launcher re-executes Node with the flag.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const FLAG = '--liftoff-only';
// SYMBRA_NO_REEXEC guards against re-exec loops.
if (!process.execArgv.includes(FLAG) && !process.env.SYMBRA_NO_REEXEC) {
  const r = spawnSync(process.execPath, [FLAG, fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: 'inherit', env: { ...process.env, SYMBRA_NO_REEXEC: '1' } });
  process.exit(r.status ?? 1);
}
import('../dist/cli.js').then((m) => m.main(process.argv)).catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});
