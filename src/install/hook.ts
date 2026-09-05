import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Claude Code PreToolUse hook: reads the tool call from stdin and, at most once per session,
 * attaches a one-line hint that the repository has a Symbra index. Never blocks, never nags.
 */
export async function runHook(root: string): Promise<void> {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  let input: {
    session_id?: string;
    tool_name?: string;
    tool_input?: { command?: string; pattern?: string };
    // Arcturn's preToolUse payload (packages/cli/src/hooks.ts upstream): `{ event, toolName, input, cwd }`.
    toolName?: string;
    input?: unknown;
  } = {};
  try {
    input = JSON.parse(raw);
  } catch {
    return;
  }
  // Recognise Arcturn's shape so a manually wired-up hook never crashes on the different field
  // names — but its hook protocol only supports allow/deny, with no channel like Claude Code's
  // hookSpecificOutput.additionalContext to surface a hint through. There is nothing useful to
  // do with an Arcturn payload, so always allow silently; `symbra install --tool arcturn
  // --hooks` does not register this hook for that reason (see install.ts).
  if (typeof input.toolName === 'string' || input.input !== undefined) return;
  const tool = input.tool_name ?? '';
  const cmd = input.tool_input?.command ?? '';
  const isSearch = tool === 'Grep' || (tool === 'Bash' && /(^|[\s;&|])(rg|grep|ag|ack|find)\s/.test(cmd));
  if (!isSearch) return;
  if (!existsSync(join(root, '.symbra', 'index.db'))) return;
  const sid = (input.session_id ?? 'default').replace(/[^\w-]/g, '_');
  const dir = join(root, '.symbra', 'sessions');
  const marker = join(dir, `${sid}.hinted`);
  if (existsSync(marker)) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(marker, String(Date.now()));
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: 'This repository has a Symbra symbol index. The symbra MCP tools (explore, symbol, callers, impact) usually answer structure questions in one call; grep is still fine for literal strings.',
      },
    }),
  );
}
