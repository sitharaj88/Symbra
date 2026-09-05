/**
 * Bench-style regression tests for two ranking failures on natural-language questions.
 *
 * A. "where is a tool call checked for permission before it runs" used to return a `checked:
 *    boolean` property first, because the exact-identifier bonus fired on the plain English word
 *    "checked" (7 chars, one symbol in the repo spelled that way, so the frequency scaling gave it
 *    full strength) and outweighed every retrieval signal combined.
 * B. "what makes the agent loop stop iterating" used to be topped by a test helper in
 *    `src/test-helpers/`, which the indexer does not mark `is_test` and which the peripheral-path
 *    prior did not cover, so its large caller count lifted it over the function the question is
 *    about.
 *
 * The repository below is synthetic and minimal: it reproduces the *pattern* (a property named
 * `checked`, a heavily-called helper under `test-helpers/`, and a function whose doc says the loop
 * "stops"), not the codebase the failures were found in.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { indexRepo } from '../../src/index/indexer.js';
import { Store } from '../../src/store/db.js';
import { search, isTestFile, isBehaviouralQuestion, TEST_PATH } from '../../src/query/search.js';

let dir: string;
let store: Store;

const FILES: Record<string, string> = {
  'src/ui/markdown.ts': `
/** One item of a list block. \`checked\` is null unless it is a task item. */
export interface MarkdownItem {
  checked: boolean | null;
  content: string;
}
`,
  'src/core/hooks.ts': `
export interface ToolCallInfo {
  name: string;
  input: Record<string, unknown>;
}

export interface AgentHooks {
  /**
   * Runs before validation and the permission gate.
   * @param call - The tool call the model requested.
   */
  beforeToolCall(call: ToolCallInfo): Promise<void>;
}
`,
  'src/core/loop.ts': `
export interface LoopResult {
  reason: string;
}

export interface LoopRuntime {
  maxTurns: number;
  emit(event: string): void;
}

/**
 * Drive the agent until the model stops requesting tools, the run is aborted,
 * or something fails.
 */
export async function runLoop(rt: LoopRuntime): Promise<LoopResult> {
  for (let turn = 0; turn < rt.maxTurns; turn++) {
    rt.emit('turn');
  }
  return { reason: 'done' };
}
`,
  'src/cli/test-helpers/scratch.ts': `
export interface Scratch {
  home: string;
}

/** Create an isolated home/project pair. */
export async function makeScratch(): Promise<Scratch> {
  return { home: '/tmp' };
}
`,
  // many callers of makeScratch, so the caller prior would lift it without a test-path demotion
  'src/cli/callers.ts': `
import { makeScratch } from './test-helpers/scratch.js';
export async function a() { return makeScratch(); }
export async function b() { return makeScratch(); }
export async function c() { return makeScratch(); }
export async function d() { return makeScratch(); }
export async function e() { return makeScratch(); }
export async function f() { return makeScratch(); }
`,
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'symbra-qrank-'));
  for (const [rel, body] of Object.entries(FILES)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  await indexRepo({ root: dir, dbPath: join(dir, 'index.db') });
  store = new Store(join(dir, 'index.db'));
});
afterAll(() => {
  store?.close();
  rmSync(dir, { recursive: true, force: true });
});

const fqns = (q: string, limit = 8) => search(store, q, { limit }).map((h) => h.symbol.fqn);

describe('A: a plain English word must not win on the exact-name bonus', () => {
  it('ranks the permission hook above the property spelled `checked`', () => {
    const top = fqns('where is a tool call checked for permission before it runs');
    expect(top[0]).toBe('AgentHooks.beforeToolCall');
    expect(top.indexOf('MarkdownItem.checked')).not.toBe(0);
  });

  it('still honours the exact name when the query IS the name', () => {
    // one- and two-token queries are lookups, not questions: the bonus must survive there
    expect(fqns('checked')[0]).toBe('MarkdownItem.checked');
    expect(fqns('runLoop')[0]).toBe('runLoop');
  });

  it('classifies questions and lookups apart', () => {
    expect(isBehaviouralQuestion('where is a tool call checked for permission before it runs', 6)).toBe(true);
    expect(isBehaviouralQuestion('what makes the agent loop stop iterating', 5)).toBe(true);
    expect(isBehaviouralQuestion('checked', 1)).toBe(false);
    expect(isBehaviouralQuestion('runLoop', 1)).toBe(false);
    // a wh-word alone is not enough; a lookup stays a lookup
    expect(isBehaviouralQuestion('what is a Store', 2)).toBe(false);
  });
});

describe('B: the loop-stopping question finds the function, not the scaffolding', () => {
  it('ranks runLoop first and demotes the test helper', () => {
    const top = fqns('what makes the agent loop stop iterating');
    expect(top[0]).toBe('runLoop');
    expect(top.slice(0, 5)).not.toContain('makeScratch');
  });

  it('matches "stops" in the doc from the query word "stop"', () => {
    // no stemming in the FTS tokenizer; queryTerms + prefix matching must bridge the gap
    expect(fqns('what stops the loop from iterating').slice(0, 3)).toContain('runLoop');
  });
});

describe('test-scaffolding paths the indexer does not mark is_test', () => {
  it('recognises helper, spec and __tests__ layouts from the path alone', () => {
    for (const p of [
      'src/cli/test-helpers/scratch.ts',
      'packages/a/src/test-utils/fake.ts',
      'app/__tests__/thing.ts',
      'lib/thing.test.ts',
      'lib/thing_test.go',
      'lib/thing.spec.js',
      'tests/e2e/run.ts',
      'spec/models/user_spec.rb',
    ]) {
      expect(TEST_PATH.test(p), p).toBe(true);
    }
  });

  it('does not sweep up production code', () => {
    for (const p of ['src/core/loop.ts', 'src/latest/contest.ts', 'src/protest/manifest.ts', 'src/attestation.ts']) {
      expect(TEST_PATH.test(p), p).toBe(false);
    }
  });

  it('unions the store classification with the path heuristic', () => {
    expect(isTestFile('src/cli/test-helpers/scratch.ts', new Set())).toBe(true);
    expect(isTestFile('src/core/loop.ts', new Set(['src/core/loop.ts']))).toBe(true);
    expect(isTestFile('src/core/loop.ts', new Set())).toBe(false);
  });
});
