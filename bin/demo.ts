// Entry point for `npm run demo`. Applies the repo's .env, then hands the real runQuote to the demo CLI.
import { demoMain } from "../src/cli/demo.ts";
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

process.exitCode = await demoMain(process.argv.slice(2), {
  runQuote,
  stdin: process.stdin,
  stdout: process.stdout,
  stdinIsTTY: Boolean(process.stdin.isTTY),
  stdoutIsTTY: Boolean(process.stdout.isTTY),
  env: process.env,
  keySource,
});
