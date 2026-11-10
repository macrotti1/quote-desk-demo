// The doctor: every check's ok, warn and fail path with injected deps, exit codes, the --json shape,
// and one run with the real deps against this checkout. No model, no network, and nothing here
// reads process.env: the key source comes from scripted objects.
import assert from "node:assert/strict";
import { join, sep } from "node:path";
import { Writable } from "node:stream";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { binaryCandidates, createDoctorDeps, doctorMain, importProblem, keySourceFrom, renderCheck, scrubPaths }
  from "../src/cli/doctor.ts";
import type { Check, DoctorDeps, DoctorReport } from "../src/cli/doctor.ts";
import { PATHS } from "../src/paths.ts";

const ROOT = join(sep, "fake", "repo");
const PROMPT = "aaaaaaaaaaaa";
const TOOLS = ["lookup_part", "price_material", "estimate_cycle_time", "check_stock"] as const;
const KEY_MARKER = "sk-ant-doctor-test-MARKER-7f3e";

function sink(): { stream: Writable; text: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({ write(chunk, _enc, cb) { chunks.push(String(chunk)); cb(); } });
  return { stream, text: () => chunks.join("") };
}

const p = (...parts: string[]): string => join(ROOT, ...parts);

/** An in-memory checkout where every check passes. Tests change one file or dep to reach a path. */
function healthyFiles(): Map<string, string> {
  const files = new Map<string, string>();
  const catalog = '{"catalog":"fake"}';
  files.set(p("package.json"), JSON.stringify({ engines: { node: ">=24.2.0" },
    dependencies: { "@anthropic-ai/claude-agent-sdk": "0.3.321", "@modelcontextprotocol/sdk": "1.32.2", zod: "4.6.7" } }));
  files.set(p("node_modules", "@anthropic-ai", "claude-agent-sdk", "package.json"), '{"version":"0.3.321"}');
  files.set(p("node_modules", "@modelcontextprotocol", "sdk", "package.json"), '{"version":"1.32.2"}');
  files.set(p("node_modules", "zod", "package.json"), '{"version":"4.6.7"}');
  files.set(p("node_modules", "@anthropic-ai", "claude-agent-sdk-win32-x64", "claude.exe"), "binary");
  files.set(p("data", "catalog.json"), catalog);
  return files;
}

function catalogHashOf(files: Map<string, string>): Promise<string> {
  return import("node:crypto").then(({ createHash }) =>
    createHash("sha256").update(files.get(p("data", "catalog.json")) ?? "").digest("hex").slice(0, 12));
}

async function addRecordings(files: Map<string, string>, promptHash = PROMPT): Promise<void> {
  const catalogHash = await catalogHashOf(files);
  const header = JSON.stringify({ kind: "header", header: { promptHash, catalogHash } });
  for (const name of ["demo-clean.jsonl", "demo-stock-down.jsonl", "demo-unknown-material.jsonl"]) {
    files.set(p("recordings", name), `${header}\n`);
  }
  for (const folder of ["eval-k3", "eval-holdout-k3"]) {
    files.set(p("recordings", folder, "case-1.jsonl"), `${header}\n`);
    files.set(p("recordings", folder, "case-2.jsonl"), `${header}\n`);
    files.set(p("recordings", folder, "summary.json"), JSON.stringify({ promptHash, catalogHash }));
  }
  files.set(p("web", "dist", "index.html"), "<!doctype html>");
}

function fakeDeps(files: Map<string, string>, over: Partial<DoctorDeps> = {}): { deps: DoctorDeps; text: () => string } {
  const out = sink();
  const exists = (path: string): boolean =>
    files.has(path) || [...files.keys()].some((k) => k.startsWith(path + sep));
  const deps: DoctorDeps = {
    stdout: out.stream,
    keySource: ".env",
    root: ROOT,
    fs: {
      existsSync: exists,
      readFile: (path) => {
        const text = files.get(path);
        if (text === undefined) throw new Error(`ENOENT: ${path}`);
        return Buffer.from(text, "utf8");
      },
      readdirSync: (path) => {
        if (!exists(path)) throw new Error(`ENOENT: ${path}`);
        const names = new Set<string>();
        for (const k of files.keys()) {
          if (!k.startsWith(path + sep)) continue;
          const next = k.slice(path.length + 1).split(sep)[0];
          if (next !== undefined) names.add(next);
        }
        return [...names];
      },
    },
    node: { version: "24.22.1", platform: "win32", arch: "x64" },
    resolveFromSdk: (request) => p("node_modules", ...request.split("/")),
    claudeCodeVersion: () => "2.1.321",
    promptHash: () => PROMPT,
    readRecordingHashes: (path) => {
      const first = (files.get(path) ?? "").split("\n")[0] ?? "";
      const line = JSON.parse(first) as { header: { promptHash: string; catalogHash: string } };
      return { promptHash: line.header.promptHash, catalogHash: line.header.catalogHash };
    },
    catalogTools: () => TOOLS,
    listServerTools: () => Promise.resolve([...TOOLS]),
    now: (() => { let t = 0; return () => (t += 100); })(),
    serverTimeoutMs: 200,
    ...over,
  };
  return { deps, text: out.text };
}

async function healthy(over: Partial<DoctorDeps> = {}): Promise<{ deps: DoctorDeps; text: () => string;
  files: Map<string, string> }> {
  const files = healthyFiles();
  await addRecordings(files);
  return { ...fakeDeps(files, over), files };
}

async function runJson(deps: DoctorDeps, text: () => string): Promise<{ code: number; report: DoctorReport }> {
  const code = await doctorMain(["--json"], deps);
  return { code, report: JSON.parse(text()) as DoctorReport };
}

function find(report: DoctorReport, name: string): Check {
  const check = report.checks.find((c) => c.name === name);
  assert.ok(check !== undefined, `no ${name} check`);
  return check;
}

test("a healthy checkout: seven ok lines in order, exit 0", async () => {
  const { deps, text } = await healthy();
  const code = await doctorMain([], deps);
  assert.equal(code, 0);
  const lines = text().trimEnd().split("\n");
  assert.deepEqual(lines.map((l) => l.split(/\s+/)[1]), ["node", "deps", "binary", "key", "server", "recordings", "web"]);
  for (const line of lines) assert.match(line, /^ok {4}/);
});

test("--json prints one object whose checks match the text lines", async () => {
  const a = await healthy({ keySource: "unset" });
  const { code, report } = await runJson(a.deps, a.text);
  const b = await healthy({ keySource: "unset" });
  assert.equal(await doctorMain([], b.deps), code);
  assert.equal(report.ok, true);
  assert.deepEqual(Object.keys(report).sort(), ["checks", "ok"]);
  assert.deepEqual(b.text().trimEnd().split("\n"), report.checks.map(renderCheck));
  for (const c of report.checks) assert.ok(["ok", "warn", "fail"].includes(c.status));
});

test("usage: --help exits 0, an unknown flag exits 2", async () => {
  const a = await healthy();
  assert.equal(await doctorMain(["--help"], a.deps), 0);
  assert.match(a.text(), /^Usage: node bin\/doctor\.ts \[--json\]/);
  const b = await healthy();
  assert.equal(await doctorMain(["--nope"], b.deps), 2);
  assert.match(b.text(), /^Error: /);
});

test("node: fails below engines.node, and when engines.node is unreadable", async () => {
  const a = await healthy({ node: { version: "24.1.9", platform: "win32", arch: "x64" } });
  const r = await runJson(a.deps, a.text);
  assert.equal(r.code, 1);
  assert.equal(find(r.report, "node").status, "fail");
  assert.match(find(r.report, "node").detail, /older than >=24\.2\.0/);
  assert.equal(r.report.ok, false);

  const b = await healthy();
  b.files.set(p("package.json"), JSON.stringify({ engines: { node: "^24" }, dependencies: {} }));
  const rb = await runJson(b.deps, b.text);
  assert.equal(find(rb.report, "node").status, "fail");
});

test("deps: fails with run npm ci when a dependency is missing or at another version", async () => {
  const a = await healthy();
  a.files.delete(p("node_modules", "zod", "package.json"));
  const r = await runJson(a.deps, a.text);
  assert.equal(r.code, 1);
  assert.equal(find(r.report, "deps").status, "fail");
  assert.match(find(r.report, "deps").detail, /zod is not installed.*run npm ci$/);

  const b = await healthy();
  b.files.set(p("node_modules", "zod", "package.json"), '{"version":"4.5.0"}');
  const rb = await runJson(b.deps, b.text);
  assert.match(find(rb.report, "deps").detail, /zod is 4\.5\.0, pinned 4\.6\.7: run npm ci$/);
});

test("binary: ok names the package path, fails when no platform package resolves", async () => {
  const a = await healthy();
  const ok = find((await runJson(a.deps, a.text)).report, "binary");
  assert.equal(ok.status, "ok");
  assert.equal(ok.detail, "Claude Code 2.1.321 at node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe");

  const b = await healthy({ resolveFromSdk: () => { throw new Error("Cannot find module"); } });
  const rb = await runJson(b.deps, b.text);
  assert.equal(rb.code, 1);
  assert.equal(find(rb.report, "binary").status, "fail");
  assert.match(find(rb.report, "binary").detail, /no Claude Code binary for win32-x64/);

  const c = await healthy();
  c.files.delete(p("node_modules", "@anthropic-ai", "claude-agent-sdk-win32-x64", "claude.exe"));
  assert.equal(find((await runJson(c.deps, c.text)).report, "binary").status, "fail");
});

test("binary: the candidates follow the SDK's naming, glibc then musl on Linux", () => {
  assert.deepEqual(binaryCandidates("win32", "arm64"), ["@anthropic-ai/claude-agent-sdk-win32-arm64/claude.exe"]);
  assert.deepEqual(binaryCandidates("darwin", "arm64"), ["@anthropic-ai/claude-agent-sdk-darwin-arm64/claude"]);
  assert.deepEqual(binaryCandidates("linux", "x64"), ["@anthropic-ai/claude-agent-sdk-linux-x64/claude",
    "@anthropic-ai/claude-agent-sdk-linux-x64-musl/claude"]);
});

test("key: ok for .env and environment, warn when unset or unreadable, and the value never prints", async () => {
  const scripted = { ANTHROPIC_API_KEY: KEY_MARKER };
  assert.equal(keySourceFrom(scripted, {}), ".env");
  assert.equal(keySourceFrom({}, scripted), "environment");
  assert.equal(keySourceFrom(scripted, { ANTHROPIC_API_KEY: "other" }), ".env");
  assert.equal(keySourceFrom({}, {}), "unset");

  for (const source of [keySourceFrom(scripted, {}), keySourceFrom({}, scripted)]) {
    const a = await healthy({ keySource: source });
    const r = await runJson(a.deps, a.text);
    assert.equal(find(r.report, "key").status, "ok");
    assert.equal(find(r.report, "key").detail, `API key source: ${source}`);
    const b = await healthy({ keySource: source });
    await doctorMain([], b.deps);
    for (const out of [a.text(), b.text()]) {
      assert.ok(!out.includes(KEY_MARKER), "the key value never appears");
      assert.ok(!out.includes("MARKER"), "nor any part of it");
    }
  }
  const u = await healthy({ keySource: keySourceFrom({}, {}) });
  const ru = await runJson(u.deps, u.text);
  assert.equal(ru.code, 0, "a missing key is a warning, not a failure");
  assert.equal(find(ru.report, "key").status, "warn");
  assert.match(find(ru.report, "key").detail, /replays work, live runs won't/);
  const n = await healthy({ keySource: null });
  assert.equal(find((await runJson(n.deps, n.text)).report, "key").status, "warn");
});

test("server: ok with the 4 tools, fail on a short list, a crash, or no answer in time", async () => {
  const a = await healthy();
  const ok = find((await runJson(a.deps, a.text)).report, "server");
  assert.equal(ok.status, "ok");
  assert.equal(ok.detail, "the catalog server listed its 4 tools in 100 ms");

  const b = await healthy({ listServerTools: () => Promise.resolve(["lookup_part"]) });
  const rb = await runJson(b.deps, b.text);
  assert.equal(rb.code, 1);
  assert.match(find(rb.report, "server").detail, /listed 1 tools \(lookup_part\), expected/);

  const c = await healthy({ listServerTools: () => Promise.reject(new Error("spawn failed")) });
  assert.match(find((await runJson(c.deps, c.text)).report, "server").detail, /did not start: spawn failed/);

  let aborted = false;
  const hang = (signal: AbortSignal): Promise<string[]> => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); });
  });
  const d = await healthy({ listServerTools: hang, serverTimeoutMs: 50 });
  const rd = await runJson(d.deps, d.text);
  assert.equal(find(rd.report, "server").status, "fail");
  assert.match(find(rd.report, "server").detail, /listed no tools within 0\.05 s/);
  assert.ok(aborted, "the timeout aborts the server start");
});

test("recordings: warn on a stale hash, an unparseable file, or a missing folder; never a fail", async () => {
  const a = await healthy({ promptHash: () => "bbbbbbbbbbbb" });
  const ra = await runJson(a.deps, a.text);
  assert.equal(ra.code, 0);
  const stale = find(ra.report, "recordings");
  assert.equal(stale.status, "warn");
  assert.match(stale.detail, /^recordings were made with a different prompt or catalog: recordings\/demo-clean\.jsonl/);

  const b = await healthy();
  b.files.set(p("recordings", "eval-k3", "case-2.jsonl"), "{not json\n");
  const rb = find((await runJson(b.deps, b.text)).report, "recordings");
  assert.equal(rb.status, "warn");
  assert.match(rb.detail, /could not parse recordings\/eval-k3\/case-2\.jsonl/);

  const c = await healthy();
  for (const k of [...c.files.keys()]) if (k.includes(`${sep}eval-holdout-k3${sep}`)) c.files.delete(k);
  assert.match(find((await runJson(c.deps, c.text)).report, "recordings").detail, /recordings\/eval-holdout-k3 \(missing\)/);

  const d = await healthy({ promptHash: () => { throw new Error("Cannot find package 'zod'"); } });
  assert.match(find((await runJson(d.deps, d.text)).report, "recordings").detail, /cannot compute the current hashes/);

  const e = await healthy();
  const okCheck = find((await runJson(e.deps, e.text)).report, "recordings");
  assert.equal(okCheck.status, "ok");
  assert.match(okCheck.detail, /^3 demo recordings and 4 eval trials match prompt aaaaaaaaaaaa/);
});

test("web: ok when web/dist/index.html exists, warn otherwise", async () => {
  const a = await healthy();
  a.files.delete(p("web", "dist", "index.html"));
  const r = await runJson(a.deps, a.text);
  assert.equal(r.code, 0);
  assert.equal(find(r.report, "web").status, "warn");
  assert.equal(find(r.report, "web").detail, "web/dist/index.html is missing: run npm run web:build");
});

test("text lines print FAIL in capitals and exit 1 when any check fails", async () => {
  const a = await healthy({ listServerTools: () => Promise.reject(new Error("boom")) });
  assert.equal(await doctorMain([], a.deps), 1);
  assert.match(a.text(), /^FAIL  server {6}/m);
});

test("scrubPaths: absolute paths under the root, plain or as file URLs, print repo-relative", () => {
  const win = "C:\\Users\\pat\\clone";
  assert.equal(scrubPaths(`ENOENT: no such file or directory, open '${win}\\recordings\\eval-k3\\summary.json'`, win),
    "ENOENT: no such file or directory, open 'recordings/eval-k3/summary.json'");
  assert.equal(scrubPaths("open 'C:/Users/pat/clone/data/catalog.json'", win), "open 'data/catalog.json'");
  assert.equal(scrubPaths(`cwd ${win}, done`, win), "cwd ., done");
  assert.equal(scrubPaths(`imported from ${pathToFileURL(ROOT).href}/src/contracts.ts`, ROOT), "imported from src/contracts.ts");
  assert.equal(scrubPaths("nothing to change", win), "nothing to change");
});

test("importProblem: a missing package is named, anything else keeps the npm ci hint", () => {
  const missing = Object.assign(new Error(`Cannot find package 'zod' imported from ${p("src", "contracts.ts")}`),
    { code: "ERR_MODULE_NOT_FOUND" });
  assert.equal(importProblem(missing, ROOT), "zod isn't installed: run npm ci");
  const long = importProblem(new Error(`bad module at ${p("src", "x".repeat(300))}`), ROOT);
  assert.match(long, / \(run npm ci\)$/);
  assert.ok(!long.includes(ROOT), long);
  assert.ok(long.length <= 200, `${long.length} characters`);
});

test("no detail prints an absolute path when a file is missing or a module won't load", async () => {
  const a = await healthy({ catalogTools: () => { throw new Error(`Cannot load ${p("src", "contracts.ts")}`); } });
  a.files.delete(p("data", "catalog.json"));
  const ra = await runJson(a.deps, a.text);
  assert.match(find(ra.report, "server").detail, /^cannot load the tool list: Cannot load src\/contracts\.ts$/);
  assert.match(find(ra.report, "recordings").detail, /^cannot compute the current hashes: ENOENT: data\/catalog\.json$/);
  assert.ok(!a.text().includes(ROOT), a.text());

  const b = await healthy();
  b.files.delete(p("recordings", "eval-k3", "summary.json"));
  const rb = await runJson(b.deps, b.text);
  assert.match(find(rb.report, "recordings").detail, /recordings\/eval-k3\/summary\.json \(ENOENT: recordings\/eval-k3\/summary\.json\)/);
  assert.ok(!b.text().includes(ROOT), b.text());

  const deep = p("recordings", "eval-k3", "y".repeat(250));
  const c = await healthy({ readRecordingHashes: () => { throw new Error(`ENOENT: ${deep}`); } });
  await doctorMain([], c.deps);
  assert.ok(!c.text().includes(ROOT), "a long path is made relative before the 200 character cut");
  assert.ok(!c.text().includes("fake"), "and no part of the root survives the cut");
});

test("the real deps on this checkout: node, deps, binary, server and recordings pass", { timeout: 30_000 }, async () => {
  const out = sink();
  const deps = await createDoctorDeps(out.stream, "unset");
  deps.serverTimeoutMs = 20_000; // parallel test files and CI runners can start the server slowly
  const code = await doctorMain(["--json"], deps);
  const report = JSON.parse(out.text()) as DoctorReport;
  for (const name of ["node", "deps", "binary", "server", "recordings"]) {
    assert.equal(find(report, name).status, "ok", `${name}: ${find(report, name).detail}`);
  }
  assert.equal(find(report, "key").status, "warn");
  assert.notEqual(find(report, "web").status, "fail");
  assert.equal(code, 0);
  assert.ok(!out.text().includes(PATHS.root), "no absolute path in the output");
});
