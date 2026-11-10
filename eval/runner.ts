// The eval runner (spec 7.4): live trials through an injected runQuote, or a replay that re-scores a
// recorded run and calls nothing. bin/eval.ts wires the real dependencies; tests pass fakes.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import {
  CaseSetSchema, CasesFileSchema, DEFAULT_EFFORT, DEFAULT_FAULT_SEED, DEFAULT_MODEL, LIMITS, STOCK_DELAY_MS,
  parseStockFault,
} from "../src/contracts.ts";
import type {
  CaseCategory, CaseResult, CaseSet, CaseVerdict, CasesFile, Catalog, CategoryTotals, DeskEvent, Effort, EvalCase,
  KeySource, OutboxFile, RecordingHeader, Rfq, RfqTruth, RunOptions, RunQuote, RunnerResult, ScoreContext,
  TrialRecord, TrialResult,
} from "../src/contracts.ts";
import { fileHash, loadCatalog, loadRfqs, loadTruth } from "../src/load.ts";
import { PATHS, bundledClaudeCodeVersion, repoRelative, sdkVersion } from "../src/paths.ts";
import { headerFromEvents, readRecording, writeRecording } from "../src/recording.ts";
import { scoreTrial, trialFacts } from "./assertions.ts";
import { formatDate, formatUsd, renderMarkdown, renderTable } from "./table.ts";

export type EvalDeps = { runQuote: RunQuote | null; promptHash: string; env: Record<string, string | undefined>;
  keySource: KeySource; stdout: NodeJS.WritableStream; now: () => Date;
  confirm: (line: string) => Promise<boolean>; // bin/eval.ts asks y/N when stdin and stdout are TTYs, else true
  paths?: { cases?: string; catalog?: string; rfqs?: string; truth?: string; resultsDir?: string;
    recordingsDir?: string } | undefined;
  // Not in spec 4.3: lets a test supply the commit instead of running git. Default: git rev-parse --short HEAD.
  gitSha?: (() => string | null) | undefined };

/** A usage or config error: the runner prints it and exits 2. */
class UsageError extends Error {}

const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];
const CATEGORY_ORDER: readonly CaseCategory[] = ["clean", "missing_qty", "conflicting_tol", "unknown_material",
  "unstocked_material", "injection", "fallback"];
const CASE_VERDICTS = ["pass", "fail", "flaky", "error", "skipped"] as const;

export const USAGE = [
  "usage: npm run eval -- [flags]",
  "  --cases <file>             cases file (default eval/cases.json); its rfqsFile and truthFile pick the data",
  "  --only <list>              comma-separated categories or case-id prefixes",
  "  --repeat <k>               trials per case (default 1)",
  "  --concurrency <n>          trials at once (default 4)",
  "  --model <id>               default QUOTE_DESK_MODEL, else " + DEFAULT_MODEL,
  "  --effort <level>           default " + DEFAULT_EFFORT,
  "  --min-pass <rate>          floor for the case pass rate (default 0.9)",
  "  --min-category-pass <rate> floor for every category (default 0.66)",
  "  --max-run-usd <usd>        no new trials once spend reaches it (default 12)",
  "  --replay <dir>             re-score a recorded run; calls no model",
  "  --list                     validate the cases and print them; calls no model",
  "  --yes                      skip the confirm on a terminal",
].join("\n");

type Flags = { cases: string | undefined; only: string | undefined; repeat: number; concurrency: number;
  model: string; effort: Effort; minPass: number; minCategoryPass: number; maxRunUsd: number;
  replay: string | undefined; list: boolean; yes: boolean };

function intFlag(name: string, raw: string | undefined, fallback: number, min: number): number {
  if (raw === undefined) return fallback;
  if (!/^[0-9]+$/.test(raw) || Number(raw) < min || !Number.isSafeInteger(Number(raw))) {
    throw new UsageError(`--${name} needs a whole number of at least ${min}, got ${raw}`);
  }
  return Number(raw);
}

function rateFlag(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const x = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(x) || x < 0 || x > 1) {
    throw new UsageError(`--${name} needs a number from 0 to 1, got ${raw}`);
  }
  return x;
}

function parseFlags(argv: string[], env: Record<string, string | undefined>): Flags {
  let values: Record<string, string | boolean | undefined>;
  try {
    values = parseArgs({ args: argv, strict: true, allowPositionals: false, options: {
      cases: { type: "string" }, only: { type: "string" }, repeat: { type: "string" },
      concurrency: { type: "string" }, model: { type: "string" }, effort: { type: "string" },
      "min-pass": { type: "string" }, "min-category-pass": { type: "string" }, "max-run-usd": { type: "string" },
      replay: { type: "string" }, list: { type: "boolean" }, yes: { type: "boolean" },
    } }).values;
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
  const str = (k: string): string | undefined => (typeof values[k] === "string" ? values[k] : undefined);
  const effortRaw = str("effort") ?? DEFAULT_EFFORT;
  const effort = EFFORTS.find((e) => e === effortRaw);
  if (effort === undefined) throw new UsageError(`--effort must be one of ${EFFORTS.join(", ")}, got ${effortRaw}`);
  const modelFlag = str("model");
  if (modelFlag !== undefined && modelFlag.trim() === "") throw new UsageError("--model needs a model id");
  const envModel = env["QUOTE_DESK_MODEL"]?.trim();
  const usdRaw = str("max-run-usd");
  let maxRunUsd = 12;
  if (usdRaw !== undefined) {
    maxRunUsd = Number(usdRaw);
    if (usdRaw.trim() === "" || !Number.isFinite(maxRunUsd) || maxRunUsd < 0) {
      throw new UsageError(`--max-run-usd needs a dollar amount of 0 or more, got ${usdRaw}`);
    }
  }
  return { cases: str("cases"), only: str("only"), repeat: intFlag("repeat", str("repeat"), 1, 1),
    concurrency: intFlag("concurrency", str("concurrency"), 4, 1),
    model: modelFlag?.trim() ?? (envModel !== undefined && envModel !== "" ? envModel : DEFAULT_MODEL), effort,
    minPass: rateFlag("min-pass", str("min-pass"), 0.9),
    minCategoryPass: rateFlag("min-category-pass", str("min-category-pass"), 0.66), maxRunUsd,
    replay: str("replay"), list: values["list"] === true, yes: values["yes"] === true };
}

function readCasesFile(path: string): CasesFile {
  const name = basename(path);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new UsageError(`${name}: cannot read the file (${(err as NodeJS.ErrnoException).code ?? "read error"})`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new UsageError(`${name}: not valid JSON`);
  }
  const parsed = CasesFileSchema.safeParse(json);
  if (!parsed.success) throw new UsageError(`${name}: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

function loadOrUsage<T>(load: () => T): T {
  try {
    return load();
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
}

type Setup = { casesPath: string; cases: CasesFile; selected: EvalCase[]; catalog: Catalog; catalogPath: string;
  rfqs: Map<string, Rfq>; truth: Map<string, RfqTruth>; resultsDir: string; recordingsDir: string };

function selectCases(all: EvalCase[], only: string | undefined): EvalCase[] {
  if (only === undefined) return all;
  const tokens = only.split(",").map((s) => s.trim()).filter((s) => s !== "");
  if (tokens.length === 0) throw new UsageError("--only needs categories or case-id prefixes");
  const hits = (c: EvalCase, t: string): boolean => c.category === t || c.id.startsWith(t);
  for (const t of tokens) {
    if (!all.some((c) => hits(c, t))) throw new UsageError(`--only ${t} matches no case`);
  }
  return all.filter((c) => tokens.some((t) => hits(c, t)));
}

function setup(flags: Flags, deps: EvalDeps): Setup {
  const casesPath = flags.cases !== undefined ? resolve(flags.cases) : deps.paths?.cases ?? PATHS.cases;
  const cases = readCasesFile(casesPath);
  // --cases on the command line always takes the data files it names; otherwise deps.paths may stand in.
  const pick = (override: string | undefined, rel: string): string =>
    flags.cases === undefined && override !== undefined ? override : resolve(PATHS.root, rel);
  const rfqsPath = pick(deps.paths?.rfqs, cases.rfqsFile);
  const truthPath = pick(deps.paths?.truth, cases.truthFile);
  const catalogPath = deps.paths?.catalog ?? PATHS.catalog;
  const catalog = loadOrUsage(() => loadCatalog(catalogPath));
  const rfqs = new Map(loadOrUsage(() => loadRfqs(rfqsPath)).map((r) => [r.id, r]));
  const truth = new Map(loadOrUsage(() => loadTruth(truthPath)).map((t) => [t.rfqId, t]));
  for (const c of cases.cases) {
    if (!rfqs.has(c.rfqId)) throw new UsageError(`${c.id}: unknown rfqId ${c.rfqId} (not in ${basename(rfqsPath)})`);
    if (!truth.has(c.rfqId)) throw new UsageError(`${c.id}: rfqId ${c.rfqId} has no truth in ${basename(truthPath)}`);
  }
  return { casesPath, cases, selected: selectCases(cases.cases, flags.only), catalog, catalogPath, rfqs, truth,
    resultsDir: deps.paths?.resultsDir ?? PATHS.resultsDir, recordingsDir: deps.paths?.recordingsDir ?? PATHS.recordingsDir };
}

// ---- verdicts and totals
export function caseVerdict(trials: readonly TrialResult[], repeat: number): CaseVerdict {
  if (trials.some((t) => t.verdict === "error")) return "error";
  if (trials.length < repeat) return "skipped";
  if (trials.every((t) => t.verdict === "pass")) return "pass";
  if (trials.every((t) => t.verdict === "fail")) return "fail";
  return "flaky";
}

export function totalsOf(cases: readonly CaseResult[], durationMs: number): RunnerResult["totals"] {
  const count = (v: CaseVerdict): number => cases.filter((c) => c.verdict === v).length;
  const trials = cases.flatMap((c) => c.trials);
  const scoredTrials = trials.filter((t) => t.verdict !== "error");
  const passedTrials = scoredTrials.filter((t) => t.verdict === "pass").length;
  const scored = cases.length - count("error") - count("skipped");
  const byCategory: Partial<Record<CaseCategory, CategoryTotals>> = {};
  for (const cat of CATEGORY_ORDER) {
    const inCat = cases.filter((c) => c.category === cat);
    if (inCat.length === 0) continue;
    byCategory[cat] = { cases: inCat.length, scored: inCat.filter((c) => c.verdict !== "error" && c.verdict !== "skipped").length,
      pass: inCat.filter((c) => c.verdict === "pass").length };
  }
  return { cases: cases.length, pass: count("pass"), fail: count("fail"), flaky: count("flaky"), error: count("error"),
    skipped: count("skipped"), scored, passRate: scored === 0 ? 0 : count("pass") / scored,
    trialsScored: scoredTrials.length, trialsPassed: passedTrials,
    trialPassRate: scoredTrials.length === 0 ? 0 : passedTrials / scoredTrials.length,
    costUsd: Math.round(trials.reduce((s, t) => s + (t.costUsd ?? 0), 0) * 1e6) / 1e6,
    unreportedTrials: trials.filter((t) => t.costUsd === null).length, durationMs, byCategory };
}

/** Live exit code: 1 for a floor breach, then 3 for an error or a skipped case, else 0. */
export function liveExitCode(r: RunnerResult): number {
  const t = r.totals;
  const belowFloor = t.scored > 0 && t.passRate < r.minPass;
  const categoryBelow = Object.values(t.byCategory).some((c) => c !== undefined && c.scored > 0
    && c.pass / c.scored < r.minCategoryPass);
  if (belowFloor || categoryBelow) return 1;
  if (t.error > 0 || t.skipped > 0) return 3;
  return 0;
}

// ---- files
function stampOf(d: Date): string {
  const iso = d.toISOString();
  return `${iso.slice(0, 10).replace(/-/g, "")}-${iso.slice(11, 19).replace(/:/g, "")}`;
}

function freshDir(path: string): string {
  let dir = path;
  for (let n = 2; existsSync(dir); n++) dir = `${path}-${n}`;
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Repo-relative when the file is inside the repo, else "<folder>/<file>", so no absolute path is recorded. */
function shownPath(abs: string): string {
  const rel = repoRelative(abs);
  if (rel.startsWith("..") || isAbsolute(rel)) return `${basename(dirname(abs))}/${basename(abs)}`;
  return rel;
}

function outboxFiles(dir: string): OutboxFile[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => statSync(join(dir, name)).isFile()).sort()
    .map((name) => ({ name, sha256: createHash("sha256").update(readFileSync(join(dir, name))).digest("hex") }));
}

function writeResults(dir: string, r: RunnerResult, alsoLatest: string | null): void {
  mkdirSync(dir, { recursive: true });
  const json = JSON.stringify(r, null, 2) + "\n";
  const markdown = renderMarkdown(r);
  writeFileSync(join(dir, "summary.json"), json, "utf8");
  writeFileSync(join(dir, "summary.md"), markdown, "utf8");
  if (alsoLatest !== null) {
    writeFileSync(join(alsoLatest, "latest.json"), json, "utf8");
    writeFileSync(join(alsoLatest, "latest.md"), markdown, "utf8");
  }
}

function defaultGitSha(): string | null {
  try {
    const out = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: PATHS.root, encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"], timeout: 5000 });
    const sha = out.trim();
    return /^[0-9a-f]{4,40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

// Only the fields the pre-run line and a replay read. Unknown keys are ignored.
const RecordedSummarySchema = z.object({ schema: z.literal(1), mode: z.enum(["live", "replay"]), caseSet: CaseSetSchema,
  startedAt: z.string(), model: z.string(), effort: z.enum(["low", "medium", "high", "xhigh", "max"]),
  sdkVersion: z.string(), claudeCodeVersion: z.string().nullable(), promptHash: z.string(), catalogHash: z.string(),
  gitSha: z.string().nullable(), dataSeed: z.number(), repeat: z.number().int().min(1), minPass: z.number(),
  minCategoryPass: z.number(), totals: z.object({ costUsd: z.number(), durationMs: z.number() }),
  cases: z.array(z.object({ caseId: z.string(), verdict: z.enum(CASE_VERDICTS),
    trials: z.array(z.object({ trial: z.number().optional(), recording: z.string().optional() })) })) });
type RecordedSummary = z.infer<typeof RecordedSummarySchema>;

function readSummary(path: string): RecordedSummary {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new UsageError(`${basename(dirname(path))}/summary.json: not valid JSON`);
  }
  const parsed = RecordedSummarySchema.safeParse(json);
  if (!parsed.success) throw new UsageError(`${basename(dirname(path))}/summary.json: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

/** The newest live summary for this case set under the recordings folder, for the pre-run line. */
function lastRecordedRun(recordingsDir: string, set: CaseSet): string {
  if (!existsSync(recordingsDir)) return "none";
  let best: { s: RecordedSummary; dir: string } | null = null;
  for (const dir of readdirSync(recordingsDir).sort()) {
    const file = join(recordingsDir, dir, "summary.json");
    if (!existsSync(file)) continue;
    let s: RecordedSummary;
    try {
      s = readSummary(file);
    } catch {
      continue;
    }
    if (s.mode !== "live" || s.caseSet !== set) continue;
    if (best === null || s.startedAt > best.s.startedAt) best = { s, dir };
  }
  if (best === null) return "none";
  const trials = best.s.cases.reduce((n, c) => n + c.trials.length, 0);
  return `${formatUsd(best.s.totals.costUsd)} for ${trials} trials (${basename(recordingsDir)}/${best.dir}/summary.json)`;
}

// ---- trials
type TrialInput = { c: EvalCase; trial: number };

function trialResultOf(trial: number, rec: TrialRecord, ctx: ScoreContext, c: EvalCase, defaults: CasesFile["defaults"],
  recording: string, measuredMs: number): TrialResult {
  const scored = scoreTrial(c, defaults, rec, ctx);
  const f = trialFacts(rec.events);
  return { trial, verdict: scored.verdict, failure: f.finished?.failure ?? null, status: f.quote?.status ?? null,
    delivery: f.finished?.delivery ?? "not_attempted", costUsd: f.finished?.costUsd ?? null,
    durationMs: f.finished?.durationMs ?? measuredMs, checks: scored.checks, recording };
}

function caseResults(selected: readonly EvalCase[], trials: Map<string, TrialResult[]>, repeat: number): CaseResult[] {
  return selected.map((c) => {
    const list = [...(trials.get(c.id) ?? [])].sort((a, b) => a.trial - b.trial);
    return { caseId: c.id, category: c.category, rfqId: c.rfqId, stockFault: c.stockFault,
      verdict: caseVerdict(list, repeat), trials: list };
  });
}

async function liveRun(flags: Flags, s: Setup, deps: EvalDeps, out: (line: string) => void): Promise<number> {
  const runQuote = deps.runQuote;
  if (deps.keySource === "unset") {
    throw new UsageError("ANTHROPIC_API_KEY is unset, so a live run can't start. Set it in .env or the environment,"
      + " or re-score the committed run without a model: npm run eval:replay");
  }
  if (runQuote === null) throw new UsageError("no runQuote was wired in, so a live run can't start");
  const k = flags.repeat;
  out(`Live run: ${s.selected.length} cases x ${k} ${k === 1 ? "trial" : "trials"} on ${flags.model}`
    + ` (effort ${flags.effort}). API key: ${deps.keySource}. Last recorded run: ${lastRecordedRun(s.recordingsDir, s.cases.set)}.`
    + ` Cap ${formatUsd(flags.maxRunUsd)}.`);
  if (!flags.yes && !(await deps.confirm("Start the run? [y/N] "))) {
    out("Nothing run.");
    return 0;
  }

  const startedAt = deps.now();
  const outDir = freshDir(join(s.resultsDir, stampOf(startedAt)));
  const gitSha = (deps.gitSha ?? defaultGitSha)();
  const jobs: TrialInput[] = s.selected.flatMap((c) => Array.from({ length: k }, (_, i) => ({ c, trial: i + 1 })));
  const trials = new Map<string, TrialResult[]>();
  let claudeCodeVersion: string | null = null;
  let spent = 0;
  let next = 0;

  const runOne = async ({ c, trial }: TrialInput): Promise<TrialResult> => {
    const rfq = s.rfqs.get(c.rfqId);
    const truth = s.truth.get(c.rfqId);
    if (rfq === undefined || truth === undefined) throw new Error(`${c.id}: rfq ${c.rfqId} vanished`);
    const name = `${c.id}-${trial}`;
    const outboxDir = join(outDir, "outbox", name);
    mkdirSync(outboxDir, { recursive: true });
    const faultSeed = c.faultSeed ?? DEFAULT_FAULT_SEED;
    const opts: RunOptions = { model: flags.model, effort: flags.effort, stockFault: c.stockFault, faultSeed,
      stockDelayMs: STOCK_DELAY_MS.eval, approver: async () => c.approve, outboxDir, catalogPath: s.catalogPath };
    const t0 = deps.now().getTime();
    const events: DeskEvent[] = [];
    try {
      for await (const e of runQuote(rfq, opts)) events.push(e);
    } catch (err) {
      // runQuote never throws by contract; if it does, the trial has no run_finished and scores as error.
      out(`${name}: runQuote threw: ${(err as Error).message}`);
    }
    const measuredMs = Math.max(0, deps.now().getTime() - t0);
    const outbox = outboxFiles(outboxDir);
    const recordedAt = deps.now().toISOString();
    const header: RecordingHeader = events.some((e) => e.type === "run_started")
      ? headerFromEvents(events, { kind: "eval", caseId: c.id, trial, gitSha, recordedAt })
      : { v: 1, kind: "eval", recordedAt, rfqId: rfq.id, caseId: c.id, trial, model: flags.model, effort: flags.effort,
        sdkVersion: sdkVersion(), claudeCodeVersion: bundledClaudeCodeVersion(), stockFault: c.stockFault, faultSeed,
        promptHash: deps.promptHash, catalogHash: fileHash(s.catalogPath), gitSha };
    const file = join(outDir, `${name}.jsonl`);
    writeRecording(file, { header, events, outbox });
    const init = events.find((e) => e.type === "session_init");
    if (claudeCodeVersion === null && init !== undefined && init.type === "session_init") {
      claudeCodeVersion = init.claudeCodeVersion;
    }
    const ctx: ScoreContext = { catalog: s.catalog, rfq, truth, fault: parseStockFault(c.stockFault), faultSeed };
    return trialResultOf(trial, { caseId: c.id, trial, events, outbox }, ctx, c, s.cases.defaults, basename(file),
      measuredMs);
  };

  const worker = async (): Promise<void> => {
    for (;;) {
      // No new trial once spend reaches the cap; a trial that reported no cost counts as the per-run budget.
      if (next >= jobs.length || spent >= flags.maxRunUsd) return;
      const job = jobs[next];
      next += 1;
      if (job === undefined) return;
      const r = await runOne(job);
      spent += r.costUsd ?? LIMITS.maxBudgetUsd;
      const list = trials.get(job.c.id) ?? [];
      list.push(r);
      trials.set(job.c.id, list);
    }
  };
  await Promise.all(Array.from({ length: Math.min(flags.concurrency, Math.max(1, jobs.length)) }, () => worker()));

  const finishedAt = deps.now();
  const cases = caseResults(s.selected, trials, k);
  const result: RunnerResult = { schema: 1, mode: "live", caseSet: s.cases.set, startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(), model: flags.model, effort: flags.effort, sdkVersion: sdkVersion(),
    claudeCodeVersion: claudeCodeVersion ?? bundledClaudeCodeVersion(), promptHash: deps.promptHash,
    catalogHash: fileHash(s.catalogPath), gitSha, dataSeed: s.catalog.seed, repeat: k, minPass: flags.minPass,
    minCategoryPass: flags.minCategoryPass,
    totals: totalsOf(cases, Math.max(0, finishedAt.getTime() - startedAt.getTime())), cases };
  writeResults(outDir, result, s.resultsDir);
  out(renderTable(result, { color: useColor(deps) }).trimEnd());
  if (spent >= flags.maxRunUsd && jobs.length > cases.reduce((n, c) => n + c.trials.length, 0)) {
    out(`Stopped at the ${formatUsd(flags.maxRunUsd)} cap: spend counted ${formatUsd(spent)}.`);
  }
  out(`Results: ${shownPath(join(outDir, "summary.json"))}`);
  return liveExitCode(result);
}

function useColor(deps: EvalDeps): boolean {
  const tty = (deps.stdout as { isTTY?: boolean }).isTTY === true;
  return tty && deps.env["NO_COLOR"] === undefined;
}

// ---- replay
async function replayRun(flags: Flags, s: Setup, deps: EvalDeps, out: (line: string) => void): Promise<number> {
  const dir = resolve(flags.replay ?? ".");
  const summaryPath = join(dir, "summary.json");
  if (!existsSync(summaryPath)) {
    throw new UsageError(`${basename(dir)}/summary.json is missing; --replay needs the summary of the recorded run`);
  }
  const recorded = readSummary(summaryPath);
  const banner = `REPLAY of a run recorded ${formatDate(recorded.startedAt)} on ${recorded.model}, no model called`;
  out(banner);

  const byId = new Map(s.cases.cases.map((c) => [c.id, c]));
  const selectedIds = new Set(s.selected.map((c) => c.id));
  const recordedCases = recorded.cases.filter((c) => selectedIds.has(c.caseId) || !byId.has(c.caseId));
  for (const rc of recordedCases) {
    if (!byId.has(rc.caseId)) throw new UsageError(`${rc.caseId} is in summary.json but not in ${basename(s.casesPath)}`);
  }
  const listed = new Set(recordedCases.map((c) => c.caseId));
  const warnings: string[] = [];
  const trials = new Map<string, TrialResult[]>();
  const seen = new Map<string, string>(); // "<caseId>#<trial>" to the file that recorded it
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".jsonl")).sort()) {
    const path = join(dir, name);
    const rec = loadOrUsage(() => readRecording(path));
    const { caseId, trial } = rec.header;
    if (caseId === null || trial === null) throw new UsageError(`${name}: the header names no case and trial`);
    const first = seen.get(`${caseId}#${trial}`);
    if (first !== undefined) throw new UsageError(`${first} and ${name} both record ${caseId} trial ${trial}`);
    seen.set(`${caseId}#${trial}`, name);
    if (!selectedIds.has(caseId) && byId.has(caseId)) continue; // left out by --only
    const c = byId.get(caseId);
    if (c === undefined) throw new UsageError(`${name}: case ${caseId} isn't in ${basename(s.casesPath)}`);
    if (!listed.has(caseId)) throw new UsageError(`${name}: case ${caseId} isn't in summary.json`);
    const rfq = s.rfqs.get(c.rfqId);
    const truth = s.truth.get(c.rfqId);
    if (rfq === undefined || truth === undefined) throw new UsageError(`${caseId}: unknown rfqId ${c.rfqId}`);
    // Score against the schedule the server actually ran, which the header records.
    const fault = loadOrUsage(() => parseStockFault(rec.header.stockFault));
    if (rec.header.stockFault !== c.stockFault || rec.header.faultSeed !== (c.faultSeed ?? DEFAULT_FAULT_SEED)) {
      warnings.push(`warning: ${name} ran ${rec.header.stockFault} seed ${rec.header.faultSeed}; the cases file now says`
        + ` ${c.stockFault} seed ${c.faultSeed ?? DEFAULT_FAULT_SEED}`);
    }
    const ctx: ScoreContext = { catalog: s.catalog, rfq, truth, fault, faultSeed: rec.header.faultSeed };
    const record: TrialRecord = { caseId, trial, events: rec.events, outbox: rec.outbox ?? [] };
    const r = trialResultOf(trial, record, ctx, c, s.cases.defaults, name, 0);
    const list = trials.get(caseId) ?? [];
    list.push(r);
    trials.set(caseId, list);
  }

  const currentCatalogHash = fileHash(s.catalogPath);
  if (recorded.promptHash !== deps.promptHash) {
    warnings.push(`warning: promptHash differs: recorded ${recorded.promptHash}, current ${deps.promptHash}`);
  }
  if (recorded.catalogHash !== currentCatalogHash) {
    warnings.push(`warning: catalogHash differs: recorded ${recorded.catalogHash}, current ${currentCatalogHash}`);
  }

  // A trial summary.json lists with no recording next to it is missing, not cut by a cap: say which file.
  for (const rc of recordedCases) {
    const found = new Set((trials.get(rc.caseId) ?? []).map((t) => t.trial));
    for (const t of rc.trials) {
      if (t.trial === undefined || found.has(t.trial)) continue;
      const file = t.recording !== undefined ? basename(t.recording) : `${rc.caseId}-${t.trial}.jsonl`;
      warnings.push(`warning: ${rc.caseId} trial ${t.trial}: summary.json lists ${file}, which is missing from ${basename(dir)}`);
    }
  }

  const selectedCases = recordedCases.map((rc) => byId.get(rc.caseId)).filter((c): c is EvalCase => c !== undefined);
  const cases = caseResults(selectedCases, trials, recorded.repeat);
  const changed: string[] = [];
  for (const c of cases) {
    const was = recordedCases.find((rc) => rc.caseId === c.caseId)?.verdict;
    if (was !== c.verdict) changed.push(`  ${c.caseId}: recorded ${was ?? "none"}, re-scored ${c.verdict}`);
  }
  const startedAt = deps.now();
  const result: RunnerResult = { schema: 1, mode: "replay", caseSet: s.cases.set, startedAt: startedAt.toISOString(),
    finishedAt: deps.now().toISOString(), model: recorded.model, effort: recorded.effort, sdkVersion: recorded.sdkVersion,
    claudeCodeVersion: recorded.claudeCodeVersion, promptHash: recorded.promptHash, catalogHash: recorded.catalogHash,
    gitSha: recorded.gitSha, dataSeed: recorded.dataSeed, repeat: recorded.repeat, minPass: recorded.minPass,
    minCategoryPass: recorded.minCategoryPass, totals: totalsOf(cases, recorded.totals.durationMs), cases };
  writeResults(freshDir(join(s.resultsDir, `replay-${stampOf(startedAt)}`)), result, null);

  for (const w of warnings) out(w);
  out(renderTable(result, { color: useColor(deps) }).trimEnd());
  if (changed.length > 0) {
    out(`${changed.length} case ${changed.length === 1 ? "verdict differs" : "verdicts differ"} from the recording:`);
    for (const line of changed) out(line);
  } else {
    out(`Every re-scored verdict matches the recording (${cases.length} cases).`);
  }
  out(banner);
  return changed.length > 0 ? 1 : 0;
}

// ---- list
function listCases(s: Setup, out: (line: string) => void): number {
  out(`${s.selected.length} cases in ${basename(s.casesPath)} (set ${s.cases.set}); defaults: `
    + s.cases.defaults.map((a) => a.kind).join(", "));
  for (const c of s.selected) {
    const seed = c.faultSeed !== undefined ? ` seed ${c.faultSeed}` : "";
    out(`${c.id.padEnd(22)}${c.category.padEnd(20)}${c.rfqId.padEnd(10)}${(c.stockFault + seed).padEnd(18)}`
      + c.assert.map((a) => a.kind).join(", "));
  }
  return 0;
}

/** The eval entry point. Returns the exit code (spec 7.6). */
export async function runEval(argv: string[], deps: EvalDeps): Promise<number> {
  const out = (line: string): void => {
    deps.stdout.write(line + "\n");
  };
  try {
    const flags = parseFlags(argv, deps.env);
    const s = setup(flags, deps);
    if (flags.list) return listCases(s, out);
    if (flags.replay !== undefined) return await replayRun(flags, s, deps, out);
    return await liveRun(flags, s, deps, out);
  } catch (err) {
    if (err instanceof UsageError) {
      out(`eval: ${err.message}`);
      out(USAGE);
      return 2;
    }
    throw err;
  }
}
