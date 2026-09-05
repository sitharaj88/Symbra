import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { install } from '../../src/install/install.js';
import { readJsonc, stripJsonc } from '../../src/index/project.js';
import { makeRepo, type TempRepo } from './helpers.js';

const repos: TempRepo[] = [];
let savedHome: string | undefined;
function repo(files: Record<string, string> = {}): TempRepo {
  const r = makeRepo(files);
  repos.push(r);
  return r;
}
afterEach(() => {
  if (savedHome !== undefined) {
    process.env.HOME = savedHome;
    savedHome = undefined;
  }
  while (repos.length) repos.pop()!.cleanup();
});

describe('readJsonc', () => {
  it('does not treat // inside a JSON string as a comment', () => {
    const r = repo({ 'c.json': '{"url": "https://example.com/x", "note": "a // b", "block": "a /* b */ c"}' });
    expect(readJsonc(join(r.root, 'c.json'))).toEqual({ url: 'https://example.com/x', note: 'a // b', block: 'a /* b */ c' });
  });

  it('still reads comments and trailing commas when the file is not strict JSON', () => {
    const r = repo({ 'c.json': '{\n  // leading\n  "a": 1, /* inline */\n  "b": "http://x", // trailing\n}\n' });
    expect(readJsonc(join(r.root, 'c.json'))).toEqual({ a: 1, b: 'http://x' });
  });

  it('leaves a trailing-comma-looking string alone', () => {
    expect(JSON.parse(stripJsonc('{"a": "x, }", "b": 1}'))).toEqual({ a: 'x, }', b: 1 });
  });

  it('throws rather than returning a partial document', () => {
    const r = repo({ 'c.json': '{"a": 1' });
    expect(() => readJsonc(join(r.root, 'c.json'))).toThrow();
  });
});

describe('install', () => {
  it('refuses to rewrite a config file it could not parse', async () => {
    const r = repo({});
    const cfg = join(r.root, '.vscode', 'mcp.json');
    mkdirSync(join(r.root, '.vscode'), { recursive: true });
    const original = '{"servers": {"other": {}}, THIS IS NOT JSON';
    writeFileSync(cfg, original);
    await expect(install({ root: r.root, tools: ['vscode'], global: false })).rejects.toThrow(/could not be parsed as JSON/);
    // The user's file — which for ~/.claude.json holds their prompt history — is untouched.
    expect(readFileSync(cfg, 'utf8')).toBe(original);
    expect(existsSync(cfg + '.symbra-backup')).toBe(false);
  });

  it('names the repository root for configs that live outside it', async () => {
    const r = repo({});
    savedHome = process.env.HOME;
    const home = join(r.root, '..', 'home');
    mkdirSync(home, { recursive: true });
    process.env.HOME = home;

    await install({ root: r.root, tools: ['codex', 'windsurf', 'vscode'], global: false });

    // Codex reads ~/.codex/config.toml with an arbitrary cwd, so the root must be explicit.
    const toml = readFileSync(join(home, '.codex', 'config.toml'), 'utf8');
    expect(toml).toContain(`"-C", "${r.root}"`);
    const windsurf = JSON.parse(readFileSync(join(home, '.codeium', 'windsurf', 'mcp_config.json'), 'utf8'));
    expect(windsurf.mcpServers.symbra.args).toEqual(['-y', 'symbra', '-C', r.root, 'serve']);
    // A project-scoped config runs with the repository as cwd and needs no root.
    const vscode = JSON.parse(readFileSync(join(r.root, '.vscode', 'mcp.json'), 'utf8'));
    expect(vscode.servers.symbra.args).toEqual(['-y', 'symbra', 'serve']);
  });

  it('writes the root into the user-level Claude config with --global', async () => {
    const r = repo({});
    savedHome = process.env.HOME;
    const home = join(r.root, '..', 'home2');
    mkdirSync(home, { recursive: true });
    process.env.HOME = home;
    await install({ root: r.root, tools: ['claude'], global: true });
    const claude = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'));
    expect(claude.mcpServers.symbra.args).toEqual(['-y', 'symbra', '-C', r.root, 'serve']);
  });

  it('writes .arcturn/mcp.json with the servers/type shape and merges with an existing server', async () => {
    const r = repo({});
    const cfg = join(r.root, '.arcturn', 'mcp.json');
    mkdirSync(join(r.root, '.arcturn'), { recursive: true });
    writeFileSync(cfg, JSON.stringify({ servers: { other: { type: 'stdio', command: 'foo', args: [] } } }));

    await install({ root: r.root, tools: ['arcturn'], global: false });

    const j = JSON.parse(readFileSync(cfg, 'utf8'));
    expect(j.servers.other).toEqual({ type: 'stdio', command: 'foo', args: [] });
    expect(j.servers.symbra).toEqual({ type: 'stdio', command: 'npx', args: ['-y', 'symbra', 'serve'] });
  });

  it('upserts the fenced guidance section into ARCTURN.md', async () => {
    const r = repo({ 'ARCTURN.md': '# My project\n\nsome notes\n' });
    await install({ root: r.root, tools: ['arcturn'], global: false });
    const md = readFileSync(join(r.root, 'ARCTURN.md'), 'utf8');
    expect(md).toContain('# My project');
    expect(md).toContain('<!-- symbra:start -->');
    expect(md).toContain('<!-- symbra:end -->');
    expect(md).toContain('Symbra (code intelligence)');
  });

  it('refuses to rewrite an unparseable .arcturn/mcp.json, even with a // inside a string', async () => {
    const r = repo({});
    const cfg = join(r.root, '.arcturn', 'mcp.json');
    mkdirSync(join(r.root, '.arcturn'), { recursive: true });
    const original = '{"servers": {"other": {"type": "stdio", "command": "https://example.com // not json"}}, THIS IS NOT JSON';
    writeFileSync(cfg, original);
    await expect(install({ root: r.root, tools: ['arcturn'], global: false })).rejects.toThrow(/could not be parsed as JSON/);
    expect(readFileSync(cfg, 'utf8')).toBe(original);
  });

  it('merges the nine read-only allow rules into .arcturn/config.json, preserving other permissions', async () => {
    const r = repo({});
    const cfg = join(r.root, '.arcturn', 'config.json');
    mkdirSync(join(r.root, '.arcturn'), { recursive: true });
    writeFileSync(cfg, JSON.stringify({ someOtherSetting: true, permissions: [{ tool: 'mcp__other__thing', specifier: '*', action: 'allow', scope: 'project' }] }));

    await install({ root: r.root, tools: ['arcturn'], global: false });

    const j = JSON.parse(readFileSync(cfg, 'utf8'));
    expect(j.someOtherSetting).toBe(true);
    expect(j.permissions).toContainEqual({ tool: 'mcp__other__thing', specifier: '*', action: 'allow', scope: 'project' });
    const symbraTools = ['explore', 'search', 'symbol', 'callers', 'callees', 'path', 'impact', 'overview', 'status'];
    for (const t of symbraTools) {
      expect(j.permissions).toContainEqual({ tool: `mcp__symbra__${t}`, specifier: '*', action: 'allow', scope: 'project' });
    }
    expect(j.permissions).toHaveLength(symbraTools.length + 1);
  });

  it('is idempotent: running arcturn install twice yields nine rules, not eighteen', async () => {
    const r = repo({});
    await install({ root: r.root, tools: ['arcturn'], global: false });
    await install({ root: r.root, tools: ['arcturn'], global: false });
    const cfg = join(r.root, '.arcturn', 'config.json');
    const j = JSON.parse(readFileSync(cfg, 'utf8'));
    expect(j.permissions).toHaveLength(9);
  });

  it('refuses to rewrite an unparseable .arcturn/config.json', async () => {
    const r = repo({});
    mkdirSync(join(r.root, '.arcturn'), { recursive: true });
    const cfg = join(r.root, '.arcturn', 'config.json');
    const original = '{"permissions": [], THIS IS NOT JSON';
    writeFileSync(cfg, original);
    await expect(install({ root: r.root, tools: ['arcturn'], global: false })).rejects.toThrow(/could not be parsed as JSON/);
    expect(readFileSync(cfg, 'utf8')).toBe(original);
  });

  it('logs a reminder to run `arcturn trust --allow`', async () => {
    const r = repo({});
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((m: string) => {
      logs.push(m);
    });
    await install({ root: r.root, tools: ['arcturn'], global: false });
    spy.mockRestore();
    expect(logs.some((l) => l.includes('arcturn trust --allow'))).toBe(true);
  });

  it('honors --command to override the MCP server command for all targets', async () => {
    const r = repo({});
    await install({ root: r.root, tools: ['arcturn', 'vscode'], global: false, command: 'node /path/to/bin/symbra.js' });

    const arcturn = JSON.parse(readFileSync(join(r.root, '.arcturn', 'mcp.json'), 'utf8'));
    expect(arcturn.servers.symbra).toEqual({ type: 'stdio', command: 'node', args: ['/path/to/bin/symbra.js', 'serve'] });

    const vscode = JSON.parse(readFileSync(join(r.root, '.vscode', 'mcp.json'), 'utf8'));
    expect(vscode.servers.symbra).toEqual({ type: 'stdio', command: 'node', args: ['/path/to/bin/symbra.js', 'serve'] });
  });
});
