// Entry point for `npm run eval`. Applies the repo's .env, then wires runQuote, the prompt hash
// and a y/N prompt into the eval runner.
import { createInterface } from "node:readline/promises";
import { runEval } from "../eval/runner.ts";
import { PROMPT_HASH } from "../src/agent/prompt.ts";
import type { KeySource } from "../src/contracts.ts";
import { runQuote } from "../src/index.ts";
import { readDotEnv } from "../src/load.ts";
import { PATHS } from "../src/paths.ts";

// A key in .env beats one in the shell. The output names the source, never the value.
const fromFile = readDotEnv(PATHS.dotEnv);
Object.assign(process.env, fromFile);
const keySource: KeySource = fromFile["ANTHROPIC_API_KEY"]
  ? ".env"
  : process.env["ANTHROPIC_API_KEY"]
    ? "environment"
    : "unset";

// Asks on a real console. With piped input or output there is nobody to ask, so the run goes ahead.
async function confirm(line: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return true;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(line);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

process.exitCode = await runEval(process.argv.slice(2), {
  runQuote,
  promptHash: PROMPT_HASH,
  env: process.env,
  keySource,
  stdout: process.stdout,
  now: () => new Date(),
  confirm,
});
