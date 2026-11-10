// The child process env and the Agent SDK options for one run (spec S3).
import type { CanUseTool, Options } from "@anthropic-ai/claude-agent-sdk";
import { CATALOG_SERVER, LIMITS, QUOTE_DRAFT_JSON_SCHEMA } from "../contracts.ts";
import type { Effort } from "../contracts.ts";
import { PATHS } from "../paths.ts";
import { SYSTEM_PROMPT } from "./prompt.ts";

const API_KEY_NAME = "ANTHROPIC_API_KEY";
const DROPPED_PREFIX = /^(claude|anthropic)/i;

/**
 * The env the CLI child gets. Copies every defined value from base, drops each CLAUDE* or ANTHROPIC* name
 * (any case) except ANTHROPIC_API_KEY, then turns off auto memory and points the config dir at configDir.
 * Returns the dropped names, sorted, and never their values.
 */
export function childEnv(base: Record<string, string | undefined>, configDir: string):
  { env: Record<string, string>; dropped: string[] } {
  const env: Record<string, string> = {};
  const dropped: string[] = [];
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (name !== API_KEY_NAME && DROPPED_PREFIX.test(name)) {
      dropped.push(name);
      continue;
    }
    env[name] = value;
  }
  env["CLAUDE_CODE_DISABLE_AUTO_MEMORY"] = "1";
  env["CLAUDE_CONFIG_DIR"] = configDir;
  dropped.sort();
  return { env, dropped };
}

export type BuildOptionsArgs = {
  model: string; effort: Effort; stockFault: string; faultSeed: number; stockDelayMs: number;
  catalogPath: string; workDir: string; env: Record<string, string>; maxTurns: number; maxBudgetUsd: number;
  abortController: AbortController; canUseTool: CanUseTool; hooks: NonNullable<Options["hooks"]>;
  onStderr: (data: string) => void;
};

/**
 * The options for one query. No allowedTools (it would shadow canUseTool) and no fallbackModel: only the
 * lead applies the U2 fallback.
 */
export function buildOptions(a: BuildOptionsArgs): Options {
  return {
    model: a.model,
    effort: a.effort,
    systemPrompt: SYSTEM_PROMPT,
    tools: [],
    mcpServers: {
      [CATALOG_SERVER]: {
        type: "stdio",
        command: process.execPath,
        // The joined --flag=value form, because a strict parseArgs reads "--fault-seed", "-3" as two flags.
        args: [PATHS.serverEntry, "--catalog", a.catalogPath, "--stock-fault", a.stockFault,
          `--fault-seed=${a.faultSeed}`, `--stock-delay-ms=${a.stockDelayMs}`],
        timeout: LIMITS.serverTimeoutMs,
        alwaysLoad: true,
      },
    },
    canUseTool: a.canUseTool,
    hooks: a.hooks,
    outputFormat: { type: "json_schema", schema: QUOTE_DRAFT_JSON_SCHEMA },
    settingSources: [],
    strictMcpConfig: true,
    skills: [],
    plugins: [],
    persistSession: false,
    permissionMode: "default",
    verbatimPrompts: true,
    cwd: a.workDir,
    env: a.env,
    maxTurns: a.maxTurns,
    maxBudgetUsd: a.maxBudgetUsd,
    abortController: a.abortController,
    stderr: a.onStderr,
  };
}
