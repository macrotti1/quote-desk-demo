// The doctor: a preflight a presenter runs before showing the demo. Every check reads files or
// starts the local catalog server; nothing here calls a model, touches the network or reads an
// environment value. Everything comes in through DoctorDeps, so tests drive each path with fakes.
// Static imports stay with node builtins, paths.ts and types: a clone without `npm ci` has no zod
// or MCP SDK, and the doctor has to say "run npm ci" instead of crashing on an import.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { KeySource } from "../contracts.ts";
import { PATHS, bundledClaudeCodeVersion } from "../paths.ts";

export type CheckStatus = "ok" | "warn" | "fail";
export type Check = { name: string; status: CheckStatus; detail: string };
export type DoctorReport = { ok: boolean; checks: Check[] };

export type DoctorFs = {
  existsSync(path: string): boolean;
  readFile(path: string): Buffer;
  readdirSync(path: string): string[];
};

export type DoctorDeps = {
  stdout: NodeJS.WritableStream;
  /** Where the key would come from, or null when .env couldn't be read. Never the key itself. */
  keySource: KeySource | null;
  root: string;
  fs: DoctorFs;
  node: { version: string; platform: string; arch: string };
  /** Resolves a module request from the Agent SDK's own folder. Throws when it can't. */
  resolveFromSdk: (request: string) => string;
  claudeCodeVersion: () => string | null;
  /** The current prompt hash. Throws when the prompt module can't load. */
  promptHash: () => string;
  /** Parses a recording and returns its header hashes. Throws when the file doesn't parse. */
  readRecordingHashes: (path: string) => { promptHash: string; catalogHash: string };
  /** The tool names the catalog server must list. Throws when the contracts can't load. */
  catalogTools: () => readonly string[];
  /** Starts the catalog server, lists its tools and stops it. Stops early when the signal aborts. */
  listServerTools: (signal: AbortSignal) => Promise<string[]>;
  now: () => number;
  serverTimeoutMs?: number;
};

export const SERVER_TIMEOUT_MS = 5000;
export const DEMO_RECORDINGS = ["demo-clean.jsonl", "demo-stock-down.jsonl", "demo-unknown-material.jsonl"] as const;
export const EVAL_FOLDERS = ["eval-k3", "eval-holdout-k3"] as const;
const SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";
const USAGE = "Usage: node bin/doctor.ts [--json]";

/** The same rule bin/demo.ts applies: a key in .env beats one in the shell. Returns the source only. */
export function keySourceFrom(fromFile: Record<string, string | undefined>,
  env: Record<string, string | undefined>): KeySource {
  return fromFile["ANTHROPIC_API_KEY"] ? ".env" : env["ANTHROPIC_API_KEY"] ? "environment" : "unset";
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Rewrites every absolute path under root, as a plain path or a file URL, to a repo-relative one with
 * forward slashes (root itself becomes "."). Node's error text carries absolute paths, and those name
 * the user's home folder, so every detail goes through here before it prints.
 */
export function scrubPaths(text: string, root: string): string {
  if (root === "") return text;
  const forms = new Set<string>([root, root.split("\\").join("/")]);
  try {
    forms.add(pathToFileURL(root).href);
  } catch {
    // a root that isn't a valid path has no file URL form
  }
  let out = text;
  for (const form of [...forms].sort((a, b) => b.length - a.length)) {
    const pattern = new RegExp(`${escapeRegExp(form)}((?:[\\\\/][^\\s'"\`,;()]*)?)`, "gi");
    out = out.replace(pattern, (_match, rest: string) => (rest === "" ? "." : rest.slice(1).split("\\").join("/")));
  }
  return out;
}

/** The first line of an error, paths under root made relative, cut to 200 characters. */
function messageOf(err: unknown, root = ""): string {
  const text = err instanceof Error ? err.message : String(err);
  const first = scrubPaths(text.split("\n")[0] ?? "", root);
  return first.length > 200 ? `${first.slice(0, 197)}...` : first;
}

/** Why a module that needs npm ci didn't load, ending in the npm ci hint so no later cut can drop it. */
export function importProblem(err: unknown, root: string): string {
  const text = err instanceof Error ? err.message : String(err);
  const pkg = /Cannot find package '([^']+)'/.exec(text)?.[1];
  if (pkg !== undefined) return `${pkg} isn't installed: run npm ci`;
  const first = messageOf(err, root);
  return `${first.length > 180 ? `${first.slice(0, 177)}...` : first} (run npm ci)`;
}

function rel(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

function readJson(deps: DoctorDeps, path: string): unknown {
  return JSON.parse(deps.fs.readFile(path).toString("utf8")) as unknown;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseVersion(text: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(text.trim());
  if (m === null) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function atLeast(have: [number, number, number], need: [number, number, number]): boolean {
  for (let i = 0; i < 3; i++) {
    const h = have[i] ?? 0;
    const n = need[i] ?? 0;
    if (h !== n) return h > n;
  }
  return true;
}

function rootPackage(deps: DoctorDeps): Record<string, unknown> {
  const pkg = readJson(deps, join(deps.root, "package.json"));
  if (!isRecord(pkg)) throw new Error("package.json is not an object");
  return pkg;
}

function checkNode(deps: DoctorDeps): Check {
  const engines = rootPackage(deps)["engines"];
  const range = isRecord(engines) ? engines["node"] : undefined;
  const m = typeof range === "string" ? /^>=\s*(\d+\.\d+\.\d+)$/.exec(range.trim()) : null;
  const need = m?.[1] === undefined ? null : parseVersion(m[1]);
  if (need === null) return { name: "node", status: "fail", detail: "package.json has no engines.node of the form >=X.Y.Z" };
  const have = parseVersion(deps.node.version);
  const want = `>=${need.join(".")}`;
  if (have === null) return { name: "node", status: "fail", detail: `cannot read the Node version ${deps.node.version}` };
  if (!atLeast(have, need)) {
    return { name: "node", status: "fail", detail: `Node ${have.join(".")} is older than ${want}: install Node 24.2 or later` };
  }
  return { name: "node", status: "ok", detail: `Node ${have.join(".")} satisfies ${want}` };
}

function checkDeps(deps: DoctorDeps): Check {
  const pinned = rootPackage(deps)["dependencies"];
  if (!isRecord(pinned)) return { name: "deps", status: "fail", detail: "package.json has no dependencies" };
  const found: string[] = [];
  const problems: string[] = [];
  for (const [name, want] of Object.entries(pinned)) {
    const file = join(deps.root, "node_modules", ...name.split("/"), "package.json");
    if (!deps.fs.existsSync(file)) {
      problems.push(`${name} is not installed`);
      continue;
    }
    let version: unknown;
    try {
      const pkg = readJson(deps, file);
      version = isRecord(pkg) ? pkg["version"] : undefined;
    } catch {
      version = undefined;
    }
    if (version !== want) problems.push(`${name} is ${typeof version === "string" ? version : "unreadable"}, pinned ${String(want)}`);
    else found.push(`${name} ${version}`);
  }
  if (problems.length > 0) return { name: "deps", status: "fail", detail: `${problems.join("; ")}: run npm ci` };
  return { name: "deps", status: "ok", detail: found.join(", ") };
}

/** The platform packages the SDK looks in, in its own order. */
export function binaryCandidates(platform: string, arch: string): string[] {
  const exe = platform === "win32" ? ".exe" : "";
  const base = `${SDK_PACKAGE}-`;
  const names = platform === "linux" ? [`${base}linux-${arch}`, `${base}linux-${arch}-musl`] : [`${base}${platform}-${arch}`];
  return names.map((name) => `${name}/claude${exe}`);
}

function checkBinary(deps: DoctorDeps): Check {
  const { platform, arch } = deps.node;
  const candidates = binaryCandidates(platform, arch);
  for (const request of candidates) {
    let path: string;
    try {
      path = deps.resolveFromSdk(request);
    } catch {
      continue;
    }
    if (!deps.fs.existsSync(path)) continue;
    let version: string | null;
    try {
      version = deps.claudeCodeVersion();
    } catch {
      version = null;
    }
    const where = rel(deps.root, path);
    return { name: "binary", status: "ok", detail: `Claude Code ${version ?? "(version unknown)"} at ${where}` };
  }
  const packages = candidates.map((c) => c.slice(0, c.lastIndexOf("/"))).join(" or ");
  return { name: "binary", status: "fail", detail: `no Claude Code binary for ${platform}-${arch} (${packages}): run npm ci` };
}

function checkKey(deps: DoctorDeps): Check {
  if (deps.keySource === ".env" || deps.keySource === "environment") {
    return { name: "key", status: "ok", detail: `API key source: ${deps.keySource}` };
  }
  if (deps.keySource === null) {
    return { name: "key", status: "warn", detail: "could not read .env (or npm ci hasn't run): replays work, live runs won't" };
  }
  return { name: "key", status: "warn", detail: "API key source: unset (replays work, live runs won't)" };
}

async function checkServer(deps: DoctorDeps): Promise<Check> {
  let expected: string[];
  try {
    expected = [...deps.catalogTools()].sort();
  } catch (err) {
    return { name: "server", status: "fail", detail: `cannot load the tool list: ${messageOf(err, deps.root)}` };
  }
  const timeoutMs = deps.serverTimeoutMs ?? SERVER_TIMEOUT_MS;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => {
      expired = true;
      resolve("timeout");
      controller.abort();
    }, timeoutMs);
  });
  const started = deps.now();
  try {
    const listing = deps.listServerTools(controller.signal);
    listing.catch(() => undefined); // a late rejection after a timeout must not go unhandled
    const result = await Promise.race([listing, timedOut]);
    if (result === "timeout" || expired) {
      return { name: "server", status: "fail", detail: `the catalog server listed no tools within ${timeoutMs / 1000} s` };
    }
    const ms = Math.round(deps.now() - started);
    const got = [...result].sort();
    if (got.length !== expected.length || got.some((name, i) => name !== expected[i])) {
      return { name: "server", status: "fail",
        detail: `the catalog server listed ${got.length} tools (${got.join(", ") || "none"}), expected ${expected.join(", ")}` };
    }
    return { name: "server", status: "ok", detail: `the catalog server listed its ${got.length} tools in ${ms} ms` };
  } catch (err) {
    if (expired) {
      return { name: "server", status: "fail", detail: `the catalog server listed no tools within ${timeoutMs / 1000} s` };
    }
    return { name: "server", status: "fail", detail: `the catalog server did not start: ${messageOf(err, deps.root)}` };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
  }
}

function checkRecordings(deps: DoctorDeps): Check {
  const name = "recordings";
  let wantPrompt: string;
  let wantCatalog: string;
  try {
    wantPrompt = deps.promptHash();
    wantCatalog = createHash("sha256").update(deps.fs.readFile(join(deps.root, "data", "catalog.json")))
      .digest("hex").slice(0, 12);
  } catch (err) {
    return { name, status: "warn", detail: `cannot compute the current hashes: ${messageOf(err, deps.root)}` };
  }
  const dir = join(deps.root, "recordings");
  const unreadable: string[] = [];
  const stale: string[] = [];
  const compare = (path: string, hashes: { promptHash: unknown; catalogHash: unknown }): void => {
    if (hashes.promptHash !== wantPrompt || hashes.catalogHash !== wantCatalog) stale.push(rel(deps.root, path));
  };
  const readOne = (path: string): void => {
    try {
      compare(path, deps.readRecordingHashes(path));
    } catch (err) {
      unreadable.push(`${rel(deps.root, path)} (${messageOf(err, deps.root)})`);
    }
  };
  for (const file of DEMO_RECORDINGS) readOne(join(dir, file));
  let trials = 0;
  for (const folder of EVAL_FOLDERS) {
    const folderPath = join(dir, folder);
    let entries: string[];
    try {
      entries = deps.fs.readdirSync(folderPath).sort();
    } catch {
      unreadable.push(`recordings/${folder} (missing)`);
      continue;
    }
    const jsonl = entries.filter((e) => e.endsWith(".jsonl"));
    if (jsonl.length === 0) unreadable.push(`recordings/${folder} (no recordings)`);
    for (const file of jsonl) readOne(join(folderPath, file));
    trials += jsonl.length;
    const summaryPath = join(folderPath, "summary.json");
    try {
      const summary = readJson(deps, summaryPath);
      if (!isRecord(summary)) throw new Error("not an object");
      compare(summaryPath, { promptHash: summary["promptHash"], catalogHash: summary["catalogHash"] });
    } catch (err) {
      unreadable.push(`${rel(deps.root, summaryPath)} (${messageOf(err, deps.root)})`);
    }
  }
  const list = (items: string[]): string =>
    items.length > 3 ? `${items.slice(0, 3).join(", ")} and ${items.length - 3} more` : items.join(", ");
  if (unreadable.length > 0) return { name, status: "warn", detail: `could not parse ${list(unreadable)}` };
  if (stale.length > 0) {
    return { name, status: "warn", detail: `recordings were made with a different prompt or catalog: ${list(stale)}` };
  }
  return { name, status: "ok",
    detail: `${DEMO_RECORDINGS.length} demo recordings and ${trials} eval trials match prompt ${wantPrompt}, catalog ${wantCatalog}` };
}

function checkWeb(deps: DoctorDeps): Check {
  if (deps.fs.existsSync(join(deps.root, "web", "dist", "index.html"))) {
    return { name: "web", status: "ok", detail: "web/dist/index.html is built" };
  }
  return { name: "web", status: "warn", detail: "web/dist/index.html is missing: run npm run web:build" };
}

/** Runs every check in order. A check that throws counts as a fail with its message. */
export async function runChecks(deps: DoctorDeps): Promise<DoctorReport> {
  const steps: [string, () => Check | Promise<Check>][] = [
    ["node", () => checkNode(deps)],
    ["deps", () => checkDeps(deps)],
    ["binary", () => checkBinary(deps)],
    ["key", () => checkKey(deps)],
    ["server", () => checkServer(deps)],
    ["recordings", () => checkRecordings(deps)],
    ["web", () => checkWeb(deps)],
  ];
  const checks: Check[] = [];
  for (const [name, run] of steps) {
    try {
      checks.push(await run());
    } catch (err) {
      checks.push({ name, status: "fail", detail: messageOf(err, deps.root) });
    }
  }
  for (const check of checks) check.detail = scrubPaths(check.detail, deps.root);
  return { ok: checks.every((c) => c.status !== "fail"), checks };
}

/** One line per check: ok, warn or FAIL, the name, the detail. */
export function renderCheck(check: Check): string {
  const label = check.status === "fail" ? "FAIL" : check.status;
  return `${label.padEnd(4)}  ${check.name.padEnd(10)}  ${check.detail}`;
}

/** Runs the doctor and returns the exit code: 0 nothing failed, 1 a check failed, 2 a usage error. */
export async function doctorMain(argv: string[], deps: DoctorDeps): Promise<number> {
  let json = false;
  try {
    const { values } = parseArgs({ args: argv, strict: true, allowPositionals: false,
      options: { json: { type: "boolean" }, help: { type: "boolean", short: "h" } } });
    if (values.help === true) {
      deps.stdout.write(`${USAGE}\n`);
      return 0;
    }
    json = values.json === true;
  } catch (err) {
    deps.stdout.write(`Error: ${messageOf(err)}\n${USAGE}\n`);
    return 2;
  }
  const report = await runChecks(deps);
  if (json) deps.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else deps.stdout.write(`${report.checks.map(renderCheck).join("\n")}\n`);
  return report.ok ? 0 : 1;
}

async function tryImport<T>(load: () => Promise<T>): Promise<{ ok: true; mod: T } | { ok: false; error: string }> {
  try {
    return { ok: true, mod: await load() };
  } catch (err) {
    return { ok: false, error: importProblem(err, PATHS.root) };
  }
}

function need<T>(m: { ok: true; mod: T } | { ok: false; error: string }): T {
  if (!m.ok) throw new Error(m.error);
  return m.mod;
}

/** Starts the real catalog server over stdio with this Node, lists its tools and closes it. */
export async function listToolsOverStdio(signal: AbortSignal): Promise<string[]> {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  // env stays at the transport default, which passes only a short safe list (no API key).
  const transport = new StdioClientTransport({ command: process.execPath, args: [PATHS.serverEntry], stderr: "pipe" });
  transport.stderr?.on("data", () => undefined); // the server's start line; drained, never printed
  const client = new Client({ name: "quote-desk-doctor", version: "0.0.0" });
  const stop = (): void => {
    void client.close().catch(() => undefined);
  };
  signal.addEventListener("abort", stop, { once: true });
  try {
    await client.connect(transport, { signal });
    const { tools } = await client.listTools(undefined, { signal });
    return tools.map((t) => t.name);
  } finally {
    signal.removeEventListener("abort", stop);
    await client.close().catch(() => undefined);
  }
}

/** The real dependencies. Modules that need npm ci load here, and a missing one fails its check only. */
export async function createDoctorDeps(stdout: NodeJS.WritableStream, keySource: KeySource | null):
  Promise<DoctorDeps> {
  const prompt = await tryImport(() => import("../agent/prompt.ts"));
  const recording = await tryImport(() => import("../recording.ts"));
  const contracts = await tryImport(() => import("../contracts.ts"));
  return {
    stdout,
    keySource,
    root: PATHS.root,
    fs: { existsSync, readFile: (path) => readFileSync(path), readdirSync: (path) => readdirSync(path) },
    node: { version: process.versions.node, platform: process.platform, arch: process.arch },
    resolveFromSdk: (request) => createRequire(import.meta.resolve(SDK_PACKAGE)).resolve(request),
    claudeCodeVersion: bundledClaudeCodeVersion,
    promptHash: () => need(prompt).PROMPT_HASH,
    readRecordingHashes: (path) => {
      const { header } = need(recording).readRecording(path);
      return { promptHash: header.promptHash, catalogHash: header.catalogHash };
    },
    catalogTools: () => need(contracts).CATALOG_TOOLS,
    listServerTools: listToolsOverStdio,
    now: () => performance.now(),
  };
}
