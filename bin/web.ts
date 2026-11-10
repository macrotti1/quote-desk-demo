// Entry point for `npm run web`. Applies the repo's .env the way bin/demo.ts does, then serves the page from
// web/dist on 127.0.0.1. Prints one line; names where the key came from, never its value.
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { KeySource } from "../src/contracts.ts";
import { runQuote } from "../src/index.ts";
import { readDotEnv } from "../src/load.ts";
import { PATHS } from "../src/paths.ts";
import { WEB_DEFAULTS, createWebServer, systemClock } from "../src/web/server.ts";

const USAGE = "Usage: node bin/web.ts [--port 4310] [--max-runs 20] [--no-live]";

function wholeNumber(raw: string | undefined, fallback: number, min: number, max: number, flag: string): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!/^[0-9]+$/.test(raw) || !Number.isSafeInteger(n) || n < min || n > max) {
    process.stdout.write(`Error: ${flag} takes a whole number from ${min} to ${max} (got ${raw})\n${USAGE}\n`);
    process.exit(2);
  }
  return n;
}

let flags: { port?: string | undefined; "max-runs"?: string | undefined; "no-live"?: boolean | undefined;
  help?: boolean | undefined };
try {
  flags = parseArgs({ args: process.argv.slice(2), strict: true, allowPositionals: false, options: {
    port: { type: "string" }, "max-runs": { type: "string" }, "no-live": { type: "boolean" },
    help: { type: "boolean", short: "h" },
  } }).values;
} catch (err) {
  process.stdout.write(`Error: ${(err as Error).message}\n${USAGE}\n`);
  process.exit(2);
}
if (flags.help === true) {
  process.stdout.write(`${USAGE}\n`);
  process.exit(0);
}
const port = wholeNumber(flags.port, WEB_DEFAULTS.port, 1, 65535, "--port");
const maxRuns = wholeNumber(flags["max-runs"], WEB_DEFAULTS.maxRuns, 0, 1000, "--max-runs");

// A key in .env beats one in the shell. The output names the source, never the value.
const fromFile = readDotEnv(PATHS.dotEnv);
Object.assign(process.env, fromFile);
const keySource: KeySource = fromFile["ANTHROPIC_API_KEY"]
  ? ".env"
  : process.env["ANTHROPIC_API_KEY"]
    ? "environment"
    : "unset";
const live = flags["no-live"] !== true && keySource !== "unset";

const web = createWebServer({ runQuote, keySource, recordingsDir: PATHS.recordingsDir,
  staticDir: join(PATHS.root, "web", "dist"), clock: systemClock, live, maxRuns });

try {
  const bound = await web.listen(port);
  process.stdout.write(`Quote Desk page: http://127.0.0.1:${bound} (API key: ${keySource}, live runs ${live ? "on" : "off"})\n`);
} catch (err) {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "EADDRINUSE") {
    process.stdout.write(`Port ${port} is taken. Stop whatever holds it, or pass --port <n>.\n`);
  } else {
    process.stdout.write(`Could not listen on 127.0.0.1:${port} (${code ?? "error"}).\n`);
  }
  process.exit(1);
}

let stopping = false;
function stop(): void {
  if (stopping) return;
  stopping = true;
  void web.close().then(() => process.exit(0));
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
