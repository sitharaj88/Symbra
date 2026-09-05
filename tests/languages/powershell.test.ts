import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFile } from '../../src/index/extract.js';
import { registerLanguage } from '../../src/languages/registry.js';
import { powershell } from '../../src/languages/powershell.js';

registerLanguage(powershell);
const src = readFileSync(new URL('../fixtures/powershell/Sample.psm1', import.meta.url), 'utf8');
const tests = readFileSync(new URL('../fixtures/powershell/Sample.Tests.ps1', import.meta.url), 'utf8');
const PATH = 'scripts/Sample.psm1';
const TEST_PATH = 'scripts/Sample.Tests.ps1';

describe('powershell extractor', () => {
  it('extracts functions with comment-based help and signatures', async () => {
    const ir = (await extractFile(PATH, src))!;
    const by = Object.fromEntries(ir.definitions.map((d) => [d.fqn, d]));

    expect(ir.doc).toBe('Sample module for extractor tests.');
    expect(by['Get-User'].kind).toBe('function');
    // .SYNOPSIS wins over .DESCRIPTION
    expect(by['Get-User'].doc).toBe('Looks up a user by name.');
    expect(by['Get-User'].signature).toBe('function Get-User([string] $Name, [Session] $Session, [int] $Retries)');
    // a `script:` scope prefix is stripped from the name and kept as a modifier
    expect(by['Format-User']).toMatchObject({ kind: 'function', modifiers: ['script'], exported: false });
    expect(by['Format-User'].doc).toBe('Formats a user for display.');
  });

  it('extracts classes, members and enums', async () => {
    const ir = (await extractFile(PATH, src))!;
    const by = Object.fromEntries(ir.definitions.map((d) => [d.fqn, d]));

    expect(by['UserRepo']).toMatchObject({ kind: 'class', supertypes: [{ name: 'BaseRepo', kind: 'extends' }] });
    expect(by['UserRepo.Name']).toMatchObject({ kind: 'field', declaredType: undefined });
    expect(by['UserRepo.Hits']).toMatchObject({ kind: 'field', modifiers: ['hidden'], exported: false });
    expect(by['UserRepo.UserRepo'].kind).toBe('constructor');
    expect(by['UserRepo.Find']).toMatchObject({ kind: 'method', declaredType: 'User' });
    expect(by['UserRepo.Reset'].modifiers).toContain('static');
    expect(by['Status'].kind).toBe('enum');
    expect(ir.definitions.filter((d) => d.kind === 'enum_member').map((d) => d.fqn)).toEqual(['Status.Active', 'Status.Inactive']);
  });

  it('extracts Import-Module and dot-sourcing as imports', async () => {
    const ir = (await extractFile(PATH, src))!;
    expect(ir.imports.map((i) => i.source)).toEqual(['Az.Storage', 'lib/Helpers.psm1', 'Common.ps1']);
    const dotSource = ir.imports[2]!;
    expect(powershell.resolveModule(dotSource.source, PATH, dotSource, { hasFile: () => true })).toEqual(['scripts/Common.ps1', 'Common.ps1']);
    const rel = ir.imports[1]!;
    expect(powershell.resolveModule(rel.source, PATH, rel, { hasFile: () => true })).toContain('scripts/lib/Helpers.psm1');
  });

  it('extracts calls, constructions, parameter types and env reads', async () => {
    const ir = (await extractFile(PATH, src))!;
    const calls = ir.references.filter((r) => r.kind === 'call' || r.kind === 'new');
    expect(calls.some((c) => c.kind === 'new' && c.name === 'UserRepo')).toBe(true);
    expect(calls.some((c) => c.kind === 'call' && c.name === 'Find' && c.qualifier === 'repo')).toBe(true);
    expect(calls.some((c) => c.kind === 'call' && c.name === 'Format-User')).toBe(true);
    // shipped cmdlets are not edges into the repo
    expect(calls.some((c) => c.name === 'Write-Host' || c.name === 'New-Object')).toBe(false);

    expect(ir.localTypes.some((t) => t.name === 'Session' && t.type === 'Session' && t.via === 'annotation')).toBe(true);
    expect(ir.localTypes.some((t) => t.name === 'repo' && t.type === 'UserRepo' && t.via === 'new')).toBe(true);
    expect(ir.localTypes.some((t) => t.name === 'other' && t.type === 'UserRepo' && t.via === 'new')).toBe(true);
    // `[string]` and `[CmdletBinding()]` are not repo types; `[Session]` is
    expect(ir.references.some((r) => r.kind === 'type' && r.name === 'Session')).toBe(true);
    expect(ir.references.some((r) => r.kind === 'type' && ['string', 'int', 'CmdletBinding', 'Parameter'].includes(r.name))).toBe(false);

    expect(ir.references.some((r) => r.kind === 'config' && r.name === 'API_TOKEN')).toBe(true);
  });

  it('extracts Pester blocks as nested tests', async () => {
    const ir = (await extractFile(TEST_PATH, tests))!;
    const by = Object.fromEntries(ir.definitions.map((d) => [d.fqn, d]));
    expect(by['Get-User']).toMatchObject({ kind: 'test', meta: { framework: 'pester', block: 'Describe' } });
    expect(by['Get-User.returns a user'].kind).toBe('test');
    // the call under test is still recorded, from inside the test's scope
    const call = ir.references.find((r) => r.kind === 'call' && r.name === 'Get-User')!;
    expect(ir.definitions[call.scope].name).toBe('returns a user');
    expect(ir.imports.map((i) => i.source)).toEqual(['Sample.psm1']);
  });
});
