// Absolute paths resolved from this file's location, never from the working directory,
// plus the installed SDK's version facts.
import { readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export const PATHS: { root: string; dataDir: string; catalog: string; rfqs: string; truth: string;
  rfqsHoldout: string; truthHoldout: string; denylist: string; denylistLocal: string; dotEnv: string;
  serverEntry: string; outbox: string; resultsDir: string; recordingsDir: string; cases: string;
  casesHoldout: string; miniDir: string } = {
  root,
  dataDir: join(root, "data"),
  catalog: join(root, "data", "catalog.json"),
  rfqs: join(root, "data", "rfqs.json"),
  truth: join(root, "data", "rfq-truth.json"),
  rfqsHoldout: join(root, "data", "rfqs-holdout.json"),
  truthHoldout: join(root, "data", "rfq-truth-holdout.json"),
  denylist: join(root, "data", "denylist.txt"),
  denylistLocal: join(root, "data", "denylist.local.txt"),
  dotEnv: join(root, ".env"),
  serverEntry: join(root, "src", "mcp", "stdio.ts"),
  outbox: join(root, "out", "outbox"),
  resultsDir: join(root, "eval", "results"),
  recordingsDir: join(root, "recordings"),
  cases: join(root, "eval", "cases.json"),
  casesHoldout: join(root, "eval", "cases-holdout.json"),
  miniDir: join(root, "test", "fixtures", "mini"),
};

/** A path relative to the repo root, with forward slashes on every platform. */
export function repoRelative(absPath: string): string {
  return relative(root, absPath).split(sep).join("/");
}

// The SDK's exports map has no "./package.json", so require.resolve and a JSON import both fail.
// Resolving the package main works without loading it, and package.json sits beside it.
function sdkPackage(): { version?: unknown; claudeCodeVersion?: unknown } {
  const url = new URL("package.json", import.meta.resolve("@anthropic-ai/claude-agent-sdk"));
  return JSON.parse(readFileSync(url, "utf8")) as { version?: unknown; claudeCodeVersion?: unknown };
}

/** The installed Agent SDK version, for example "0.3.321". */
export function sdkVersion(): string {
  const { version } = sdkPackage();
  if (typeof version !== "string") throw new Error("the Agent SDK package.json has no version");
  return version;
}

/** The Claude Code version the installed SDK bundles, or null when its package.json doesn't say. */
export function bundledClaudeCodeVersion(): string | null {
  const { claudeCodeVersion } = sdkPackage();
  return typeof claudeCodeVersion === "string" ? claudeCodeVersion : null;
}
