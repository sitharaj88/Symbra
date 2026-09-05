import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFile } from '../../src/index/extract.js';
import { registerLanguage } from '../../src/languages/registry.js';
import { solidity } from '../../src/languages/solidity.js';

beforeAll(() => registerLanguage(solidity));

const src = readFileSync(new URL('../fixtures/solidity/Vault.sol', import.meta.url), 'utf8');
const testSrc = readFileSync(new URL('../fixtures/solidity/Vault.t.sol', import.meta.url), 'utf8');

describe('solidity extractor', () => {
  it('extracts contracts, interfaces and libraries', async () => {
    const ir = (await extractFile('src/Vault.sol', src))!;
    expect(ir.language).toBe('solidity');
    expect(ir.errorPct).toBe(0);
    const by = Object.fromEntries(ir.definitions.map((d) => [d.fqn, d]));
    expect(by['IVault'].kind).toBe('interface');
    expect(by['IVault'].doc).toContain('@notice Deposit and withdraw.');
    expect(by['MathLib'].kind).toBe('class');
    expect(by['MathLib'].meta?.library).toBe(true);
    expect(by['Pausable'].modifiers).toContain('abstract');
    expect(by['Vault'].kind).toBe('class');
    expect(by['Vault'].supertypes.map((s) => s.name)).toEqual(['Pausable', 'IVault', 'Ownable']);
    expect(by['Vault'].supertypes.every((s) => s.kind === 'extends')).toBe(true);
    expect(by['Vault'].doc).toContain('The main vault.');
  });

  it('extracts functions, constructors and modifiers', async () => {
    const ir = (await extractFile('src/Vault.sol', src))!;
    const by = Object.fromEntries(ir.definitions.map((d) => [d.fqn, d]));
    expect(by['Vault.deposit'].kind).toBe('method');
    expect(by['Vault.deposit'].modifiers).toEqual(['external', 'payable']);
    expect(by['Vault.deposit'].signature).toContain('function deposit(uint256 amount)');
    expect(by['Vault.helper'].modifiers).toEqual(['private', 'pure']);
    expect(by['Vault.helper'].exported).toBe(false);
    expect(by['Vault.constructor'].kind).toBe('constructor');
    expect(by['Pausable.whenNotPaused'].kind).toBe('function');
    expect(by['Pausable.whenNotPaused'].meta?.modifier).toBe(true);
    expect(by['MathLib.add'].signature).toContain('internal pure returns (uint256)');
  });

  it('extracts events, errors, structs, enums and state variables', async () => {
    const ir = (await extractFile('src/Vault.sol', src))!;
    const by = Object.fromEntries(ir.definitions.map((d) => [d.fqn, d]));
    expect(by['Vault.Deposited'].kind).toBe('type_alias');
    expect(by['Vault.Deposited'].meta?.event).toBe(true);
    expect(by['Vault.Deposited'].doc).toBe('Emitted on deposit.');
    expect(by['Vault.InsufficientBalance'].meta?.error).toBe(true);
    expect(by['Vault.Status'].kind).toBe('enum');
    expect(by['Vault.Status.Active'].kind).toBe('enum_member');
    expect(by['Vault.Account'].kind).toBe('struct');
    expect(by['Vault.Account.balance'].kind).toBe('field');
    expect(by['Vault.Account.status'].declaredType).toBe('Status');
    expect(by['Vault.totalSupply'].kind).toBe('field');
    expect(by['Vault.totalSupply'].declaredType).toBe('uint256');
    // mapping value type is what a receiver lookup needs
    expect(by['Vault.accounts'].declaredType).toBe('Account');
    expect(by['MathLib.ONE'].kind).toBe('constant');
  });

  it('extracts imports', async () => {
    const ir = (await extractFile('src/Vault.sol', src))!;
    const by = Object.fromEntries(ir.imports.map((i) => [i.source, i]));
    expect(by['./Base.sol'].namespace).toBe(true);
    expect(by['./tokens/IERC20.sol'].names).toEqual([
      { name: 'IERC20', alias: 'IERC20' },
      { name: 'IERC721', alias: 'NFT' },
    ]);
    expect(by['./math/Math.sol'].alias).toBe('Math');
    expect(by['@openzeppelin/contracts/access/Ownable.sol']).toBeTruthy();
    expect(solidity.resolveModule('./tokens/IERC20.sol', 'src/Vault.sol', by['./tokens/IERC20.sol'], { hasFile: () => true })).toEqual(['src/tokens/IERC20.sol']);
    expect(solidity.resolveModule('@openzeppelin/contracts/access/Ownable.sol', 'src/Vault.sol', by['./Base.sol'], { hasFile: () => true })).toEqual([]);
  });

  it('extracts calls, new, emits, modifiers-as-decorators and using', async () => {
    const ir = (await extractFile('src/Vault.sol', src))!;
    const r = ir.references;
    expect(r.some((x) => x.kind === 'call' && x.name === 'helper' && x.qualifier === '')).toBe(true);
    expect(r.some((x) => x.kind === 'call' && x.name === 'add' && x.qualifier === 'MathLib')).toBe(true);
    expect(r.some((x) => x.kind === 'call' && x.name === 'add' && x.qualifier === 'a.balance')).toBe(true);
    expect(r.some((x) => x.kind === 'new' && x.name === 'Vault')).toBe(true);
    expect(r.some((x) => x.kind === 'value' && x.name === 'Deposited')).toBe(true);
    expect(r.some((x) => x.kind === 'decorator' && x.name === 'whenNotPaused')).toBe(true);
    expect(r.some((x) => x.kind === 'type' && x.name === 'MathLib')).toBe(true);
    expect(r.some((x) => x.kind === 'extends' && x.name === 'Pausable')).toBe(true);
    expect(ir.localTypes.some((t) => t.name === 'a' && t.type === 'Account')).toBe(true);
  });

  it('recognises Foundry tests and env config reads', async () => {
    const ir = (await extractFile('test/Vault.t.sol', testSrc))!;
    const by = Object.fromEntries(ir.definitions.map((d) => [d.fqn, d]));
    expect(by['VaultTest.testDeposit'].kind).toBe('test');
    expect(by['VaultTest.testDeposit'].meta?.framework).toBe('foundry');
    expect(by['VaultTest.testRevertsWhenPaused'].kind).toBe('test');
    expect(by['VaultTest.setUp'].kind).toBe('method');
    expect(by['VaultTest.vault'].declaredType).toBe('Vault');
    expect(ir.references.some((x) => x.kind === 'config' && x.name === 'MAINNET_RPC_URL')).toBe(true);
    expect(solidity.isTestFile!('test/Vault.t.sol')).toBe(true);
    expect(solidity.isTestFile!('src/Vault.sol')).toBe(false);
  });
});
