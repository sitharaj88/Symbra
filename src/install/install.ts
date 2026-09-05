import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { readJsonc } from '../index/project.js';

export interface InstallOptions {
  root: string;
  tools: string[];
  global: boolean;
  hooks?: boolean;
  /**
   * Override the MCP server command, e.g. "node /path/to/bin/symbra.js" for a local checkout
   * instead of "npx -y symbra". Split on spaces: first token is the command, the rest become
   * leading args, with `serve` appended.
   */
  command?: string;
}

/** The nine read-only tools Arcturn's project-MCP permission gate needs allow rules for. */
const ARCTURN_READ_ONLY_TOOLS = ['explore', 'search', 'symbol', 'callers', 'callees', 'path', 'impact', 'overview', 'status'];

const START = '<!-- symbra:start -->';
const END = '<!-- symbra:end -->';

const GUIDANCE_MD = `${START}
## Symbra (code intelligence)

This repository is indexed by Symbra into a live symbol graph (definitions, calls, imports, inheritance, routes, tests) served over MCP. Use it before grepping or reading files one by one:

- \`explore(question)\` answers "how does X work", "where is Y", "what handles Z" in one call with ranked symbols, source and relations.
- \`symbol(name)\`, \`callers(name)\`, \`callees(name)\`, \`path(from, to)\` for precise graph questions.
- \`impact()\` with no arguments lists everything affected by the current git diff and the tests to run; \`impact(name)\` does the same for one symbol.
- \`overview()\` gives subsystems, hubs, entry points and env vars.

CLI equivalents: \`symbra explore "…"\`, \`symbra symbol Name\`, \`symbra impact\`. The index refreshes itself on every call; responses flag STALE symbols when a file changed after indexing.
${END}
`;

/**
 * The MCP server entry. A config that lives outside the repository (`~/.codex/config.toml`,
 * `~/.claude.json`, the Windsurf config) is loaded with an arbitrary cwd, so the root has to be
 * named explicitly; a project-scoped config can rely on the repository being the cwd.
 */
function mcpServerEntry(root?: string, commandOverride?: string): { command: string; args: string[] } {
  if (commandOverride) {
    const [command, ...rest] = commandOverride.split(' ').filter(Boolean);
    return { command: command!, args: [...rest, 'serve'] };
  }
  return { command: 'npx', args: root ? ['-y', 'symbra', '-C', root, 'serve'] : ['-y', 'symbra', 'serve'] };
}

/**
 * Renders a value as a TOML string. Uses a literal string (`'…'`) when the value has no single
 * quote or control character — this is the simplest way to carry a Windows path like
 * `C:\Users\runner\...` verbatim, since literal strings do no escaping at all. Otherwise falls
 * back to a basic string with `\` and `"` escaped, which is always valid.
 */
export function tomlString(value: string): string {
  if (!value.includes("'") && !/[\x00-\x1f\x7f]/.test(value)) {
    return `'${value}'`;
  }
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${escaped}"`;
}

/** Sets the `symbra` server entry. */
function setServerEntry(servers: Record<string, unknown>, entry: unknown): void {
  servers.symbra = entry;
}

function mergeJsonFile(path: string, mutate: (j: Record<string, unknown>) => void, log: (m: string) => void) {
  let j: Record<string, unknown> = {};
  if (existsSync(path)) {
    const raw = readFileSync(path, 'utf8');
    if (raw.trim()) {
      let parsed: unknown;
      try {
        parsed = readJsonc(path);
      } catch (err) {
        // These files hold the user's own settings (and, for ~/.claude.json, their prompt
        // history). Rewriting one we could not read would destroy it, so refuse instead.
        throw new Error(`${path} could not be parsed as JSON (${(err as Error).message}). Symbra will not modify a config file it cannot read — fix the syntax, or move that file aside, and run \`symbra install\` again.`);
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`${path} does not contain a JSON object. Symbra will not overwrite it — move that file aside and run \`symbra install\` again.`);
      }
      j = parsed as Record<string, unknown>;
    }
  }
  mutate(j);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(j, null, 2) + '\n');
  log(`wrote ${path}`);
}

function upsertSection(path: string, log: (m: string) => void) {
  let content = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const s = content.indexOf(START);
  const e = s >= 0 ? content.indexOf(END) : -1;
  if (s >= 0 && e > s) content = content.slice(0, s) + GUIDANCE_MD.trimEnd() + content.slice(e + END.length);
  else content = (content.trimEnd() ? content.trimEnd() + '\n\n' : '') + GUIDANCE_MD;
  writeFileSync(path, content);
  log(`updated ${path}`);
}

export async function install(opts: InstallOptions): Promise<void> {
  const log = (m: string) => console.log(`[symbra] ${m}`);
  const tools = opts.tools.includes('all') ? ['claude', 'cursor', 'codex', 'windsurf', 'vscode', 'gemini', 'arcturn'] : opts.tools;
  const localEntry = mcpServerEntry(undefined, opts.command);
  const globalEntry = mcpServerEntry(opts.root, opts.command);
  const entry = opts.global ? globalEntry : localEntry;
  const home = homedir();
  for (const t of tools) {
    switch (t) {
      case 'claude': {
        // Project-scoped .mcp.json is picked up by Claude Code automatically; user scope goes to ~/.claude.json.
        const path = opts.global ? join(home, '.claude.json') : join(opts.root, '.mcp.json');
        mergeJsonFile(
          path,
          (j) => {
            const servers = (j.mcpServers as Record<string, unknown>) ?? {};
            setServerEntry(servers, entry);
            j.mcpServers = servers;
          },
          log,
        );
        upsertSection(join(opts.root, 'CLAUDE.md'), log);
        if (opts.hooks) {
          mergeJsonFile(
            join(opts.root, '.claude', 'settings.json'),
            (j) => {
              const hooks = (j.hooks as Record<string, unknown[]>) ?? {};
              const pre = (hooks.PreToolUse as { matcher?: string; hooks?: { type?: string; command?: string }[] }[]) ?? [];
              const already = pre.some((h) => h.hooks?.some((x) => (x.command ?? '').includes('symbra hook')));
              if (!already) pre.push({ matcher: 'Bash|Grep', hooks: [{ type: 'command', command: 'npx -y symbra hook' }] });
              hooks.PreToolUse = pre;
              j.hooks = hooks;
            },
            log,
          );
        }
        break;
      }
      case 'cursor': {
        const path = opts.global ? join(home, '.cursor', 'mcp.json') : join(opts.root, '.cursor', 'mcp.json');
        mergeJsonFile(
          path,
          (j) => {
            const servers = (j.mcpServers as Record<string, unknown>) ?? {};
            setServerEntry(servers, entry);
            j.mcpServers = servers;
          },
          log,
        );
        const rule = join(opts.root, '.cursor', 'rules', 'symbra.mdc');
        mkdirSync(dirname(rule), { recursive: true });
        writeFileSync(rule, `---\ndescription: Use the Symbra code-intelligence MCP tools before grepping\nalwaysApply: true\n---\n${GUIDANCE_MD}`);
        log(`wrote ${rule}`);
        break;
      }
      case 'codex': {
        const path = join(home, '.codex', 'config.toml');
        let toml = existsSync(path) ? readFileSync(path, 'utf8') : '';
        if (/\[mcp_servers\.symbra\]/.test(toml)) {
          log(`${path} already has symbra`);
        } else {
          toml = toml.trimEnd() + `\n\n[mcp_servers.symbra]\ncommand = ${tomlString(globalEntry.command)}\nargs = [${globalEntry.args.map((a) => tomlString(a)).join(', ')}]\n`;
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, toml);
          log(`wrote ${path}`);
        }
        upsertSection(join(opts.root, 'AGENTS.md'), log);
        break;
      }
      case 'windsurf': {
        const path = join(home, '.codeium', 'windsurf', 'mcp_config.json');
        mergeJsonFile(
          path,
          (j) => {
            const servers = (j.mcpServers as Record<string, unknown>) ?? {};
            setServerEntry(servers, globalEntry);
            j.mcpServers = servers;
          },
          log,
        );
        const rule = join(opts.root, '.windsurf', 'rules', 'symbra.md');
        mkdirSync(dirname(rule), { recursive: true });
        writeFileSync(rule, GUIDANCE_MD);
        log(`wrote ${rule}`);
        break;
      }
      case 'vscode': {
        const path = join(opts.root, '.vscode', 'mcp.json');
        mergeJsonFile(
          path,
          (j) => {
            const servers = (j.servers as Record<string, unknown>) ?? {};
            setServerEntry(servers, { type: 'stdio', ...localEntry });
            j.servers = servers;
          },
          log,
        );
        upsertSection(join(opts.root, 'AGENTS.md'), log);
        break;
      }
      case 'gemini': {
        const path = opts.global ? join(home, '.gemini', 'settings.json') : join(opts.root, '.gemini', 'settings.json');
        mergeJsonFile(
          path,
          (j) => {
            const servers = (j.mcpServers as Record<string, unknown>) ?? {};
            setServerEntry(servers, entry);
            j.mcpServers = servers;
          },
          log,
        );
        upsertSection(join(opts.root, 'GEMINI.md'), log);
        break;
      }
      case 'arcturn': {
        // Arcturn (https://arcturn.dev) reads `.arcturn/mcp.json` shaped `{ servers: { ... } }`,
        // where each entry needs an explicit `type` (see packages/mcp/src/config.ts upstream);
        // ~/.arcturn/mcp.json is the --global equivalent, loaded with an arbitrary cwd like
        // Codex's config, so it needs the explicit -C <root> args too.
        const path = opts.global ? join(home, '.arcturn', 'mcp.json') : join(opts.root, '.arcturn', 'mcp.json');
        mergeJsonFile(
          path,
          (j) => {
            const servers = (j.servers as Record<string, unknown>) ?? {};
            setServerEntry(servers, { type: 'stdio', ...entry });
            j.servers = servers;
          },
          log,
        );
        upsertSection(join(opts.root, 'ARCTURN.md'), log);
        // Project MCP tools are permission-gated in a non-interactive Arcturn run: without an
        // explicit allow rule per tool in .arcturn/config.json, calls like mcp__symbra__explore
        // are denied. Merge in allow rules for the read-only tools only (nothing that mutates).
        mergeJsonFile(
          join(opts.root, '.arcturn', 'config.json'),
          (j) => {
            const permissions = Array.isArray(j.permissions) ? (j.permissions as Record<string, unknown>[]) : [];
            for (const tool of ARCTURN_READ_ONLY_TOOLS) {
              const rule = { tool: `mcp__symbra__${tool}`, specifier: '*', action: 'allow', scope: 'project' };
              const already = permissions.some((p) => p.tool === rule.tool && p.specifier === rule.specifier && p.action === rule.action && p.scope === rule.scope);
              if (!already) permissions.push(rule);
            }
            j.permissions = permissions;
          },
          log,
        );
        log('run `arcturn trust --allow` once in this repo so Arcturn starts the project MCP server');
        if (opts.hooks) {
          // Arcturn's preToolUse hooks (packages/cli/src/hooks.ts upstream) can only allow or
          // deny a tool call (exit 0; stdout `{"decision":"deny",...}`; or exit 2) — there is no
          // channel equivalent to Claude Code's hookSpecificOutput.additionalContext to surface
          // the grep-vs-explore hint through. Registering one would just spawn a process per
          // Bash/Grep call for no observable benefit, so --hooks is a no-op here; see
          // src/install/hook.ts for the Arcturn-aware branch that always allows.
          log('--hooks has no effect for arcturn: its preToolUse hooks can only allow or deny with no channel for a hint — guidance comes from ARCTURN.md instead');
        }
        break;
      }
      default:
        log(`unknown tool "${t}" (use claude, cursor, codex, windsurf, vscode, gemini, arcturn, all)`);
    }
  }
  // keep the index out of git
  const gi = join(opts.root, '.gitignore');
  const cur = existsSync(gi) ? readFileSync(gi, 'utf8') : '';
  if (!/^\.symbra\/?$/m.test(cur)) {
    writeFileSync(gi, (cur.trimEnd() ? cur.trimEnd() + '\n' : '') + '.symbra/\n');
    log('added .symbra/ to .gitignore');
  }
  log('done. Restart your AI tool so it picks up the MCP server.');
}
