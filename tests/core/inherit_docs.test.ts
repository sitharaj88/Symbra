import { describe, it, expect, afterEach } from 'vitest';
import { indexRepo } from '../../src/index/indexer.js';
import { inheritDocs } from '../../src/analyze/inherit_docs.js';
import { search } from '../../src/query/search.js';
import { Store } from '../../src/store/db.js';
import { makeRepo, type TempRepo } from './helpers.js';

const repos: TempRepo[] = [];
function repo(files: Record<string, string> = {}): TempRepo {
  const r = makeRepo(files);
  repos.push(r);
  return r;
}
afterEach(() => {
  while (repos.length) repos.pop()!.cleanup();
});

const SENDER = `/** Dispatches a request to the single handler registered for it. */
export interface ISender {
  /** Asynchronously send a request through the mediator pipeline to a handler. */
  send(request: string): Promise<string>;
}
`;

const MEDIATOR = `import { ISender } from './sender.js';

export class Mediator implements ISender {
  send(request: string): Promise<string> {
    return Promise.resolve(request);
  }
}
`;

async function indexed(r: TempRepo) {
  await indexRepo({ root: r.root, dbPath: r.dbPath, embed: false });
  return new Store(r.dbPath);
}

describe('doc inheritance', () => {
  it('gives an undocumented implementation the interface method doc, with provenance', async () => {
    const r = repo({ 'sender.ts': SENDER, 'mediator.ts': MEDIATOR });
    const store = await indexed(r);
    const impl = store.symbolsByName('send').find((s) => s.file === 'mediator.ts')!;
    expect(impl.doc).toBe('Asynchronously send a request through the mediator pipeline to a handler.');
    expect(JSON.parse(impl.meta!).doc_from).toBe('sender.ts::ISender.send');
    // The class itself implements exactly one documented interface, so it inherits too.
    const cls = store.getSymbol('mediator.ts::Mediator')!;
    expect(cls.doc).toBe('Dispatches a request to the single handler registered for it.');
    expect(JSON.parse(cls.meta!).doc_from).toBe('sender.ts::ISender');
    store.close();
  });

  it('makes the implementation findable by a word that only appears in the interface doc', async () => {
    const r = repo({ 'sender.ts': SENDER, 'mediator.ts': MEDIATOR });
    const store = await indexed(r);
    const hits = search(store, 'asynchronously pipeline handler', { limit: 20 });
    expect(hits.some((h) => h.symbol.id === 'mediator.ts::Mediator.send')).toBe(true);
    store.close();
  });

  it('is a no-op when rerun', async () => {
    const r = repo({ 'sender.ts': SENDER, 'mediator.ts': MEDIATOR });
    const store = await indexed(r);
    expect(inheritDocs(store)).toBe(0);
    const before = store.getSymbol('mediator.ts::Mediator.send')!;
    expect(inheritDocs(store)).toBe(0);
    const after = store.getSymbol('mediator.ts::Mediator.send')!;
    expect(after.doc).toBe(before.doc);
    expect(after.meta).toBe(before.meta);
    store.close();
  });

  it('re-extraction wins: a real doc added to the implementation replaces the inherited one', async () => {
    const r = repo({ 'sender.ts': SENDER, 'mediator.ts': MEDIATOR });
    let store = await indexed(r);
    expect(store.getSymbol('mediator.ts::Mediator.send')!.doc).toContain('Asynchronously');
    store.close();
    r.write(
      'mediator.ts',
      MEDIATOR.replace('  send(', '  /** Its very own documentation. */\n  send('),
    );
    store = await indexed(r);
    const impl = store.getSymbol('mediator.ts::Mediator.send')!;
    expect(impl.doc).toBe('Its very own documentation.');
    expect(impl.meta ? JSON.parse(impl.meta).doc_from : undefined).toBeUndefined();
    store.close();
  });

  it('leaves the implementation untouched when the base has no doc either', async () => {
    const r = repo({
      'base.ts': 'export interface ISender {\n  send(request: string): Promise<string>;\n}\n',
      'mediator.ts': "import { ISender } from './base.js';\n\nexport class Mediator implements ISender {\n  send(request: string): Promise<string> {\n    return Promise.resolve(request);\n  }\n}\n",
    });
    const store = await indexed(r);
    const impl = store.getSymbol('mediator.ts::Mediator.send')!;
    expect(impl.doc).toBe('');
    expect(impl.meta ? JSON.parse(impl.meta).doc_from : undefined).toBeUndefined();
    store.close();
  });

  it('refreshes an inherited doc when only the interface file changes', async () => {
    const r = repo({ 'sender.ts': SENDER, 'mediator.ts': MEDIATOR });
    let store = await indexed(r);
    expect(store.getSymbol('mediator.ts::Mediator.send')!.doc).toContain('mediator pipeline');
    store.close();
    // Only the interface changes; the implementation's own file is untouched.
    r.write('sender.ts', SENDER.replace('Asynchronously send a request through the mediator pipeline to a handler.', 'Route the request to its handler and await the response.'));
    const stats = await indexRepo({ root: r.root, dbPath: r.dbPath, embed: false });
    expect(stats.changed).toBe(1);
    store = new Store(r.dbPath);
    expect(store.getSymbol('mediator.ts::Mediator.send')!.doc).toBe('Route the request to its handler and await the response.');
    store.close();
  });

  it('walks a transitive chain and stops at a cycle', async () => {
    const r = repo({
      'a.ts': '/** The root of the hierarchy. */\nexport interface A {\n  /** Ping the remote peer and wait for a pong. */\n  ping(): void;\n}\n',
      'b.ts': "import { A } from './a.js';\nexport interface B extends A {}\n",
      'c.ts': "import { B } from './b.js';\nexport class C implements B {\n  ping(): void {}\n}\n",
    });
    const store = await indexed(r);
    expect(store.getSymbol('c.ts::C.ping')!.doc).toBe('Ping the remote peer and wait for a pong.');
    store.close();
  });
});
