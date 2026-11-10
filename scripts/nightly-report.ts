// The nightly eval's report step: reads eval/results/latest.json, decides ok, regression or infra against
// eval/nightly-thresholds.json, then opens, updates or closes one GitHub issue per state through `gh`.
// Node built-ins only. `decide` and `planCommands` are pure; every `gh` call goes through one injected function.
// Exit codes: 0 ok, 1 regression, 3 infra (also for bad flags, an unexpected error or a drill that still scored ok,
// so 1 always means a drop).
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

export const BODY_CAP = 60_000;
export const FOOTER = "Opened by .github/workflows/nightly.yml. Every customer, part and price in this repo is synthetic.";
export const CUT_NOTICE = "(Report cut to keep this issue under 60,000 characters. The full report is in the run's"
  + " nightly-eval-results artifact.)";
export const LABEL = { nightly: "nightly-eval", regression: "regression", infra: "infra", drill: "drill" } as const;
const LABEL_STYLE: Record<string, { color: string; description: string }> = {
  "nightly-eval": { color: "1D76DB", description: "Opened by the nightly eval workflow" },
  regression: { color: "B60205", description: "The nightly eval scored under its threshold" },
  infra: { color: "FBCA04", description: "The nightly eval could not produce a score" },
  drill: { color: "C5DEF5", description: "Forced by workflow_dispatch to test the alarm" },
};
const DEFAULT_LATEST = "eval/results/latest.json";
const DEFAULT_THRESHOLDS = "eval/nightly-thresholds.json";

// ---- shapes (checked by hand: this script imports nothing from the repo)
export type Thresholds = { schema: 1; minPassRate: number; minCategoryPassRate: Record<string, number>; maxErrorCases: number };
export type CategoryTotals = { cases: number; scored: number; pass: number };
export type Totals = {
  cases: number; pass: number; fail: number; flaky: number; error: number; skipped: number; scored: number;
  passRate: number; byCategory: Record<string, CategoryTotals>;
};
export type Check = { kind: string; pass: boolean; label?: string };
export type Trial = { verdict: string; failure?: string | null; checks: Check[] };
export type CaseRow = { caseId: string; category: string; verdict: string; trials: Trial[] };
export type Latest = { schema: 1; caseSet: string; gitSha: string | null; totals: Totals; cases: CaseRow[] };
export type LatestRead = { ok: true; latest: Latest } | { ok: false; problem: string };

export type State = "ok" | "regression" | "infra";
export type DecideInput = {
  evalExit: number;
  latest: LatestRead;
  latestMd: string | null;
  thresholds: Thresholds;
  drill: boolean;
  /** YYYY-MM-DD, for the title. */
  date: string;
  runUrl: string | null;
  commit: string | null;
};
export type Decision = { state: State; title: string; labels: string[]; body: string; summary: string[] };

export type Issue = { number: number; title: string; labels: string[] };
export type CommandKind = "label" | "create" | "edit" | "comment" | "close";
/** `body`, when present, is passed to gh with --body-file by the runner, never on the command line. */
export type Command = { kind: CommandKind; args: string[]; body?: string };
export type GhResult = { status: number; stdout: string; stderr: string };
export type Gh = (args: string[], body?: string) => GhResult;

class ReportError extends Error {}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function isCount(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}
function isRate(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
}

// ---- parsing
/** Parses latest.json (or a summary.json). Never throws: a bad file is an infra result, not a crash. */
export function parseLatest(text: string | null, name: string): LatestRead {
  if (text === null) return { ok: false, problem: `${name} is missing` };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, problem: `${name} is not valid JSON` };
  }
  if (!isRecord(raw)) return { ok: false, problem: `${name} is not a JSON object` };
  if (raw["schema"] !== 1) return { ok: false, problem: `${name} has schema ${JSON.stringify(raw["schema"] ?? null)}, not 1` };
  const t = raw["totals"];
  const bad = (what: string): LatestRead => ({ ok: false, problem: `${name} does not match schema 1: ${what}` });
  if (!isRecord(t)) return bad("no totals");
  for (const key of ["cases", "pass", "fail", "flaky", "error", "skipped", "scored"]) {
    if (!isCount(t[key])) return bad(`totals.${key} is not a count`);
  }
  if (!isRate(t["passRate"])) return bad("totals.passRate is not a rate");
  const byCategory: Record<string, CategoryTotals> = {};
  const rawCats = t["byCategory"];
  if (rawCats !== undefined && !isRecord(rawCats)) return bad("totals.byCategory is not an object");
  for (const [cat, c] of Object.entries(rawCats ?? {})) {
    if (!isRecord(c) || !isCount(c["cases"]) || !isCount(c["scored"]) || !isCount(c["pass"])) {
      return bad(`totals.byCategory.${cat} is malformed`);
    }
    byCategory[cat] = { cases: c["cases"], scored: c["scored"], pass: c["pass"] };
  }
  const rawCases = raw["cases"];
  if (!Array.isArray(rawCases)) return bad("cases is not a list");
  const cases: CaseRow[] = [];
  for (const c of rawCases) {
    if (!isRecord(c) || typeof c["caseId"] !== "string" || typeof c["category"] !== "string"
      || typeof c["verdict"] !== "string") return bad("a case has no caseId, category or verdict");
    const trials: Trial[] = [];
    for (const tr of Array.isArray(c["trials"]) ? c["trials"] : []) {
      if (!isRecord(tr)) continue;
      const checks: Check[] = [];
      for (const ch of Array.isArray(tr["checks"]) ? tr["checks"] : []) {
        if (!isRecord(ch) || typeof ch["kind"] !== "string" || typeof ch["pass"] !== "boolean") continue;
        const check: Check = { kind: ch["kind"], pass: ch["pass"] };
        if (typeof ch["label"] === "string") check.label = ch["label"];
        checks.push(check);
      }
      const trial: Trial = { verdict: typeof tr["verdict"] === "string" ? tr["verdict"] : "unknown", checks };
      if (typeof tr["failure"] === "string") trial.failure = tr["failure"];
      trials.push(trial);
    }
    cases.push({ caseId: c["caseId"], category: c["category"], verdict: c["verdict"], trials });
  }
  const totals: Totals = {
    cases: t["cases"] as number, pass: t["pass"] as number, fail: t["fail"] as number, flaky: t["flaky"] as number,
    error: t["error"] as number, skipped: t["skipped"] as number, scored: t["scored"] as number,
    passRate: t["passRate"] as number, byCategory,
  };
  return {
    ok: true,
    latest: { schema: 1, caseSet: typeof raw["caseSet"] === "string" ? raw["caseSet"] : "eval",
      gitSha: typeof raw["gitSha"] === "string" ? raw["gitSha"] : null, totals, cases },
  };
}

/** Parses eval/nightly-thresholds.json. Throws on a malformed file: that is a repo bug, and a test pins the file. */
export function parseThresholds(text: string, name: string): Thresholds {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ReportError(`${name} is not valid JSON`);
  }
  if (!isRecord(raw) || raw["schema"] !== 1) throw new ReportError(`${name} needs "schema": 1`);
  const min = raw["minPassRate"];
  const maxErr = raw["maxErrorCases"];
  const cats = raw["minCategoryPassRate"];
  if (!isRate(min)) throw new ReportError(`${name}: minPassRate must be a number from 0 to 1`);
  if (!isCount(maxErr)) throw new ReportError(`${name}: maxErrorCases must be a whole number, 0 or more`);
  if (!isRecord(cats)) throw new ReportError(`${name}: minCategoryPassRate must be an object`);
  const floors: Record<string, number> = {};
  for (const [cat, v] of Object.entries(cats)) {
    if (!isRate(v)) throw new ReportError(`${name}: minCategoryPassRate.${cat} must be a number from 0 to 1`);
    floors[cat] = v;
  }
  return { schema: 1, minPassRate: min, minCategoryPassRate: floors, maxErrorCases: maxErr };
}

/** Accepts exactly what `gh issue list --json number,title,labels` prints. */
export function parseIssues(text: string, name: string): Issue[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ReportError(`${name} is not valid JSON`);
  }
  if (!Array.isArray(raw)) throw new ReportError(`${name} must be a JSON list of issues`);
  return raw.map((i, n) => {
    if (!isRecord(i) || !isCount(i["number"])) throw new ReportError(`${name}: item ${n} has no issue number`);
    const labels = (Array.isArray(i["labels"]) ? i["labels"] : [])
      .map((l) => (typeof l === "string" ? l : isRecord(l) && typeof l["name"] === "string" ? l["name"] : null))
      .filter((l): l is string => l !== null);
    return { number: i["number"], title: typeof i["title"] === "string" ? i["title"] : "", labels };
  });
}

// ---- deciding
function pct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

function setName(caseSet: string): string {
  return caseSet === "holdout" ? "held-out" : caseSet;
}

/** Case-level totals rebuilt from the case verdicts. Trial-level fields are left out: the drill flips a case only. */
function recount(cases: readonly CaseRow[]): Totals {
  const count = (v: string): number => cases.filter((c) => c.verdict === v).length;
  const scored = cases.length - count("error") - count("skipped");
  const byCategory: Record<string, CategoryTotals> = {};
  for (const c of cases) {
    const cat = byCategory[c.category] ?? { cases: 0, scored: 0, pass: 0 };
    cat.cases += 1;
    if (c.verdict !== "error" && c.verdict !== "skipped") cat.scored += 1;
    if (c.verdict === "pass") cat.pass += 1;
    byCategory[c.category] = cat;
  }
  return { cases: cases.length, pass: count("pass"), fail: count("fail"), flaky: count("flaky"), error: count("error"),
    skipped: count("skipped"), scored, passRate: scored === 0 ? 0 : count("pass") / scored, byCategory };
}

type Floor = { category: string; pass: number; scored: number; floor: number };

function categoriesBelow(t: Totals, th: Thresholds): Floor[] {
  const out: Floor[] = [];
  for (const [category, floor] of Object.entries(th.minCategoryPassRate)) {
    const c = t.byCategory[category];
    if (c !== undefined && c.scored > 0 && c.pass / c.scored < floor) out.push({ category, pass: c.pass, scored: c.scored, floor });
  }
  return out;
}

function failedChecks(c: CaseRow): string[] {
  const seen = new Set<string>();
  for (const t of c.trials) for (const ch of t.checks) if (!ch.pass) seen.add(ch.label ?? ch.kind);
  return [...seen];
}

function failedLine(latest: Latest | null, flipped: string | null): string {
  if (latest === null) return "Failed: no case results.";
  const rows = latest.cases.filter((c) => c.verdict !== "pass").map((c) => {
    if (c.caseId === flipped) return `${c.caseId} (drill: verdict flipped, no check failed)`;
    if (c.verdict === "error") {
      const why = [...new Set(c.trials.map((t) => t.failure).filter((f): f is string => typeof f === "string"))];
      return `${c.caseId} (error${why.length > 0 ? `: ${why.join(", ")}` : ""})`;
    }
    if (c.verdict === "skipped") return `${c.caseId} (skipped)`;
    const checks = failedChecks(c);
    return `${c.caseId} (${c.verdict}${checks.length > 0 ? `: ${checks.join(", ")}` : ""})`;
  });
  return rows.length === 0 ? "Failed: none." : `Failed: ${rows.join("; ")}.`;
}

/** The whole body, at most BODY_CAP characters: only the latest.md part is cut, and the body says so. */
export function buildBody(head: string[], latestMd: string | null): string {
  const top = head.join("\n") + "\n\n";
  const footer = "\n\n" + FOOTER + "\n";
  let report = (latestMd ?? "(No report: latest.md is missing.)").trimEnd();
  if (top.length + report.length + footer.length > BODY_CAP) {
    const notice = "\n\n" + CUT_NOTICE;
    const room = Math.max(0, BODY_CAP - top.length - footer.length - notice.length);
    let cut = report.slice(0, room);
    const lastBreak = cut.lastIndexOf("\n");
    if (lastBreak > 0) cut = cut.slice(0, lastBreak);
    report = cut.trimEnd() + notice;
  }
  return top + report + footer;
}

/** Section 5.5 of the week 2 spec. Pure: dates, links and file contents come in through `input`. */
export function decide(input: DecideInput): Decision {
  const th = input.thresholds;
  let latest: Latest | null = input.latest.ok ? input.latest.latest : null;
  let drillLine: string | null = null;
  let flipped: string | null = null;
  if (input.drill) {
    const prefix = "This is a drill forced by workflow_dispatch.";
    if (latest === null) {
      drillLine = `${prefix} There were no results to flip a verdict in.`;
    } else {
      const first = latest.cases.find((c) => c.verdict === "pass");
      if (first === undefined) {
        drillLine = `${prefix} No case passed, so no verdict was flipped.`;
      } else {
        drillLine = `${prefix} The live run scored ${latest.totals.pass} of ${latest.totals.cases} before one verdict`
          + " was flipped.";
        flipped = first.caseId;
        const cases = latest.cases.map((c) => (c === first ? { ...c, verdict: "fail" } : c));
        latest = { ...latest, cases, totals: recount(cases) };
      }
    }
  }

  const t = latest?.totals ?? null;
  const below = t === null ? [] : categoriesBelow(t, th);
  const infraWhy: string[] = [];
  if (input.evalExit !== 0 && input.evalExit !== 1) infraWhy.push(`the eval exited ${input.evalExit}`);
  if (!input.latest.ok) infraWhy.push(input.latest.problem);
  if (t !== null && t.scored === 0) infraWhy.push("no case was scored");
  if (t !== null && t.error > th.maxErrorCases) infraWhy.push(`${t.error} cases errored, over the limit of ${th.maxErrorCases}`);

  let state: State;
  if (t !== null && t.scored > 0 && (t.passRate < th.minPassRate || below.length > 0)) state = "regression";
  else if (infraWhy.length > 0) state = "infra";
  else state = "ok";

  const set = setName(latest?.caseSet ?? "eval");
  let score: string;
  if (t === null) {
    score = `Score: none, because ${infraWhy.join(" and ")}.`;
  } else {
    score = `Score: ${t.pass} of ${t.cases} ${set} cases passed, ${pct(t.passRate)} of ${t.scored} scored against a`
      + ` threshold of ${pct(th.minPassRate)}.`;
    for (const b of below) score += ` Category ${b.category}: ${b.pass} of ${b.scored}, under its floor of ${pct(b.floor)}.`;
    if (t.error > 0) score += ` ${t.error} errored (limit ${th.maxErrorCases}).`;
    if (state === "infra") score += ` Infrastructure: ${infraWhy.join("; ")}.`;
  }
  const run = `Run: ${input.runUrl ?? "no run link (not on GitHub Actions)"}, commit ${input.commit ?? "unknown"},`
    + ` eval exit ${input.evalExit}.`;
  const summary = [score, failedLine(latest, flipped), run];

  const what = state === "infra" ? "infrastructure failure" : `${t?.pass ?? 0} of ${t?.cases ?? 0} ${set} cases passed`;
  const title = `${input.drill ? "[drill] " : ""}Nightly eval: ${what} (${input.date})`;
  const labels: string[] = [LABEL.nightly];
  if (state !== "ok") labels.push(state);
  if (input.drill) labels.push(LABEL.drill);
  const head = drillLine === null ? summary : [drillLine, ...summary];
  return { state, title, labels, body: buildBody(head, input.latestMd), summary };
}

export function exitCodeOf(state: State): number {
  return state === "ok" ? 0 : state === "regression" ? 1 : 3;
}

// ---- planning
/** The gh commands for a decision, given the open nightly issues. Pure. `repo` adds --repo when set. */
export function planCommands(d: Decision, open: readonly Issue[], repo: string | null): Command[] {
  const r = repo === null ? [] : ["--repo", repo];
  const nightly = open.filter((i) => i.labels.includes(LABEL.nightly)).sort((a, b) => a.number - b.number);
  const commands: Command[] = [];
  if (d.state === "ok") {
    // A drill that still cleared the threshold proves nothing about the alarm: it must never close a real issue.
    if (d.labels.includes(LABEL.drill)) return commands;
    const note = ["Recovered.", "", ...d.summary].join("\n") + "\n";
    for (const i of nightly) {
      commands.push({ kind: "comment", args: ["issue", "comment", String(i.number), ...r], body: note });
      commands.push({ kind: "close", args: ["issue", "close", String(i.number), ...r] });
    }
    return commands;
  }
  for (const name of d.labels) {
    const style = LABEL_STYLE[name];
    const extra = style === undefined ? [] : ["--color", style.color, "--description", style.description];
    commands.push({ kind: "label", args: ["label", "create", name, "--force", ...extra, ...r] });
  }
  const mine = nightly.find((i) => i.labels.includes(d.state));
  if (mine === undefined) {
    const labelArgs = d.labels.flatMap((l) => ["--label", l]);
    commands.push({ kind: "create", args: ["issue", "create", "--title", d.title, ...labelArgs, ...r], body: d.body });
    return commands;
  }
  const missing = d.labels.filter((l) => !mine.labels.includes(l));
  const addArgs = missing.length === 0 ? [] : ["--add-label", missing.join(",")];
  // A real result taking over an issue a drill opened drops the drill label, so a real drop never reads as forced.
  const staleDrill = !d.labels.includes(LABEL.drill) && mine.labels.includes(LABEL.drill);
  const removeArgs = staleDrill ? ["--remove-label", LABEL.drill] : [];
  commands.push({ kind: "edit",
    args: ["issue", "edit", String(mine.number), "--title", d.title, ...addArgs, ...removeArgs, ...r], body: d.body });
  const note = ["Updated by a later nightly run.", "", ...d.summary].join("\n") + "\n";
  commands.push({ kind: "comment", args: ["issue", "comment", String(mine.number), ...r], body: note });
  return commands;
}

// ---- running
/** The one place gh is spawned: no shell, and a body only ever travels in a temp file through --body-file. */
export const spawnGh: Gh = (args, body) => {
  let dir: string | null = null;
  try {
    const full = [...args];
    if (body !== undefined) {
      dir = mkdtempSync(join(tmpdir(), "nightly-report-"));
      const file = join(dir, "body.md");
      writeFileSync(file, body, "utf8");
      full.push("--body-file", file);
    }
    const r = spawnSync("gh", full, { shell: false, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
    if (r.error !== undefined) return { status: 127, stdout: "", stderr: r.error.message };
    return { status: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
  } finally {
    if (dir !== null) rmSync(dir, { recursive: true, force: true });
  }
};

export type MainDeps = {
  env: Record<string, string | undefined>;
  gh: Gh;
  out: (line: string) => void;
  now: () => Date;
  cwd: string;
};

const USAGE = [
  "Usage: node scripts/nightly-report.ts --eval-exit <n> [options]",
  "  --eval-exit <n>            exit code of npm run eval:nightly (required)",
  `  --latest <file>            results file (default ${DEFAULT_LATEST}); the report is latest.md beside it,`,
  "                             or summary.md when the file is a summary.json",
  `  --thresholds <file>        thresholds (default ${DEFAULT_THRESHOLDS})`,
  "  --drill                    flip the first passing case to fail in memory and mark the issue [drill]",
  "  --dry-run                  call no gh; print { decision, commands } as JSON",
  "  --open-issues-file <file>  with --dry-run, the open issues as gh issue list --json number,title,labels prints them",
  "Exit codes: 0 ok, 1 regression, 3 infra, a usage error or a drill that still scored ok.",
].join("\n");

function readOrNull(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

/** The CLI. Returns the exit code and never throws. */
export function main(argv: string[], deps: MainDeps): number {
  try {
    return run(argv, deps);
  } catch (err) {
    deps.out(`nightly-report: ${err instanceof Error ? err.message : String(err)}`);
    if (!(err instanceof ReportError)) deps.out("nightly-report: unexpected error, reported as infra (exit 3)");
    return 3;
  }
}

function run(argv: string[], deps: MainDeps): number {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv, allowPositionals: false, strict: true,
      options: {
        "eval-exit": { type: "string" }, latest: { type: "string" }, thresholds: { type: "string" },
        drill: { type: "boolean" }, "dry-run": { type: "boolean" }, "open-issues-file": { type: "string" },
        help: { type: "boolean" },
      },
    }));
  } catch (err) {
    throw new ReportError(`${err instanceof Error ? err.message : String(err)}\n${USAGE}`);
  }
  if (values.help === true) {
    deps.out(USAGE);
    return 0;
  }
  const exitText = values["eval-exit"];
  if (exitText === undefined || !/^\d{1,3}$/.test(exitText)) {
    throw new ReportError(`--eval-exit needs the eval's exit code as a whole number\n${USAGE}`);
  }
  const dryRun = values["dry-run"] === true;
  const issuesFile = values["open-issues-file"];
  if (issuesFile !== undefined && !dryRun) throw new ReportError("--open-issues-file only works with --dry-run");
  const env = deps.env;
  const repo = env["GITHUB_REPOSITORY"] ?? null;
  // Never guess the repository: gh may be logged in on this machine and would write to whatever the remote says.
  if (!dryRun && (repo === null || repo === "")) {
    throw new ReportError("GITHUB_REPOSITORY is unset, so there is no repository to file issues in. Use --dry-run off Actions.");
  }

  const latestPath = resolve(deps.cwd, values.latest ?? DEFAULT_LATEST);
  const mdName = basename(latestPath) === "summary.json" ? "summary.md" : "latest.md";
  const thresholdsPath = resolve(deps.cwd, values.thresholds ?? DEFAULT_THRESHOLDS);
  const thresholdsText = readOrNull(thresholdsPath);
  if (thresholdsText === null) throw new ReportError(`${basename(thresholdsPath)} is missing`);
  const thresholds = parseThresholds(thresholdsText, basename(thresholdsPath));

  const server = env["GITHUB_SERVER_URL"];
  const runId = env["GITHUB_RUN_ID"];
  const runUrl = server && repo && runId ? `${server}/${repo}/actions/runs/${runId}` : null;
  const latest = parseLatest(readOrNull(latestPath), basename(latestPath));
  const sha = env["GITHUB_SHA"];
  const commit = sha ? sha.slice(0, 7) : latest.ok ? latest.latest.gitSha : null;

  const decision = decide({
    evalExit: Number(exitText), latest, latestMd: readOrNull(join(dirname(latestPath), mdName)), thresholds,
    drill: values.drill === true, date: deps.now().toISOString().slice(0, 10), runUrl, commit,
  });
  // A drill that lands on ok means the alarm did not fire: plan nothing and fail the run so Mike sees it.
  const drillMissed = values.drill === true && decision.state === "ok";
  const code = drillMissed ? 3 : exitCodeOf(decision.state);
  const missNote = "The drill's flipped result still cleared the threshold, so no issue was touched and the drill"
    + " failed. Check eval/nightly-thresholds.json.";

  if (dryRun) {
    const open = issuesFile === undefined ? [] : parseIssues(readFileSync(resolve(deps.cwd, issuesFile), "utf8"), basename(issuesFile));
    const commands = planCommands(decision, open, repo === "" ? null : repo);
    deps.out(JSON.stringify(drillMissed ? { decision, commands, note: missNote } : { decision, commands }, null, 2));
    return code;
  }

  deps.out(`Decision: ${decision.state}. ${decision.title}`);
  if (drillMissed) {
    deps.out(missNote);
    return code;
  }
  const listed = deps.gh(["issue", "list", "--label", LABEL.nightly, "--state", "open", "--json", "number,title,labels",
    "--limit", "100", "--repo", repo as string]);
  if (listed.status !== 0) {
    deps.out(`gh issue list failed (exit ${listed.status}): ${listed.stderr.trim()}`);
    return 3;
  }
  const open = parseIssues(listed.stdout, "gh issue list output");
  for (const cmd of planCommands(decision, open, repo)) {
    deps.out(`gh ${cmd.args.join(" ")}${cmd.body === undefined ? "" : " --body-file <body>"}`);
    const r = deps.gh(cmd.args, cmd.body);
    if (r.status !== 0) {
      deps.out(`gh ${cmd.kind} failed (exit ${r.status}): ${r.stderr.trim()}`);
      return code === 0 ? 3 : code;
    }
  }
  return code;
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2), {
    env: process.env, gh: spawnGh, out: (line) => process.stdout.write(line + "\n"), now: () => new Date(),
    cwd: process.cwd(),
  });
}
