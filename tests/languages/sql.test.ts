import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFile } from '../../src/index/extract.js';
import { registerLanguage } from '../../src/languages/registry.js';
import { sql } from '../../src/languages/sql.js';

const src = readFileSync(new URL('../fixtures/sql/schema.sql', import.meta.url), 'utf8');

beforeAll(() => {
  registerLanguage(sql);
});

describe('sql extractor', () => {
  it('indexes tables, columns, views, functions and triggers', async () => {
    const ir = (await extractFile('db/schema.sql', src))!;
    expect(ir.language).toBe('sql');
    expect(ir.doc).toBe('Application schema. Owned by the platform team.');
    const by = Object.fromEntries(ir.definitions.map((d) => [d.fqn, d]));

    expect(by['users'].kind).toBe('struct');
    expect(by['users'].doc).toBe('People who can sign in.');
    expect(by['users'].meta).toMatchObject({ sql: 'table', schema: 'public' });
    expect(by['users'].range.startLine).toBe(7);
    expect(by['users.email'].kind).toBe('field');
    expect(by['users.email'].declaredType).toBe('VARCHAR(255)');
    expect(by['users.created_at'].declaredType).toBe('TIMESTAMP WITH TIME ZONE');
    expect(by['users.id'].meta).toMatchObject({ primaryKey: true });
    // A table constraint is not a column.
    expect(by['orders.CONSTRAINT']).toBeUndefined();
    expect(by['orders.total_cents'].declaredType).toBe('NUMERIC(12, 2)');

    expect(by['order_status'].kind).toBe('enum');
    expect(ir.definitions.filter((d) => d.kind === 'enum_member').map((d) => d.name)).toEqual([
      'pending',
      'paid',
      'shipped',
    ]);

    expect(by['order_summary'].meta).toMatchObject({ view: true });
    expect(by['order_summary'].doc).toBe('Orders with their customer email.');
    expect(by['orders.idx_orders_user'].meta).toMatchObject({ sql: 'index', table: 'orders' });
    expect(by['total_for_user'].kind).toBe('function');
    expect(by['total_for_user'].declaredType).toBe('NUMERIC');
    expect(by['orders_audit'].meta).toMatchObject({ sql: 'trigger', table: 'orders' });
  });

  it('reads COMMENT ON as documentation', async () => {
    const ir = (await extractFile('db/schema.sql', src))!;
    const by = Object.fromEntries(ir.definitions.map((d) => [d.fqn, d]));
    expect(by['orders'].doc).toBe('One row per customer order.');
    expect(by['orders.total_cents'].doc).toBe('Total in minor units.');
  });

  it('turns foreign keys and body table reads into references', async () => {
    const ir = (await extractFile('db/schema.sql', src))!;
    const ord = (fqn: string) => ir.definitions.find((d) => d.fqn === fqn)!.ordinal;
    const has = (kind: string, name: string, scopeFqn: string) =>
      ir.references.some((r) => r.kind === kind && r.name === name && r.scope === ord(scopeFqn));

    // inline REFERENCES and FOREIGN KEY … REFERENCES both link table -> table
    expect(has('value', 'users', 'orders')).toBe(true);
    expect(has('value', 'orders', 'order_items')).toBe(true);
    // ALTER TABLE attaches the edge to the table it alters
    expect(has('value', 'products', 'order_items')).toBe(true);
    // a column typed with a user-defined type links to it
    expect(has('type', 'order_status', 'orders')).toBe(true);
    // view and function bodies read tables
    expect(has('value', 'orders', 'order_summary')).toBe(true);
    expect(has('value', 'users', 'order_summary')).toBe(true);
    expect(has('value', 'orders', 'total_for_user')).toBe(true);
    expect(has('value', 'audit_log', 'audit_order')).toBe(true);
    // function -> function calls
    expect(has('call', 'total_for_user', 'audit_order')).toBe(true);
    expect(has('call', 'audit_order', 'orders_audit')).toBe(true);
    expect(has('value', 'orders', 'orders_audit')).toBe(true);
    // `INSERT INTO t (…)` is a table read, never a function call
    expect(ir.references.some((r) => r.kind === 'call' && r.name === 'audit_log')).toBe(false);
    // builtins stay out of the graph
    expect(ir.references.some((r) => r.name.toLowerCase() === 'coalesce' || r.name.toLowerCase() === 'sum')).toBe(false);
  });

  it('ignores comments, strings and dollar-quoted bodies when splitting statements', async () => {
    const tricky = [
      "-- CREATE TABLE not_a_table (x int);",
      "/* CREATE TABLE also_not (x int); */",
      "CREATE TABLE real_one (label TEXT DEFAULT 'a; b -- c');",
      "CREATE FUNCTION f() RETURNS void AS $body$ BEGIN PERFORM 1; PERFORM 2; END; $body$ LANGUAGE plpgsql;",
    ].join('\n');
    const ir = (await extractFile('db/tricky.sql', tricky))!;
    expect(ir.definitions.map((d) => d.name)).toEqual(['real_one', 'label', 'f']);
    expect(ir.definitions.find((d) => d.name === 'label')!.declaredType).toBe('TEXT');
  });
});
