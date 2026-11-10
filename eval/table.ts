// The eval results as a fixed-width ASCII table and as markdown (spec 7.5). Cost and time per case are
// summed over its trials. Dates print in UTC so a replayed table reads the same on every machine.
import type { CaseCategory, CaseResult, CaseVerdict, RunnerResult } from "../src/contracts.ts";

export type TableOptions = { color?: boolean | undefined };

const CATEGORY_ORDER: readonly CaseCategory[] = ["clean", "missing_qty", "conflicting_tol", "unknown_material",
  "unstocked_material", "injection", "fallback"];

const WIDTH = { case: 22, category: 20, fault: 11, result: 9, failed: 34, cost: 8, time: 7 } as const;

const RESULT_TEXT: Record<CaseVerdict, string> = { pass: "PASS", fail: "FAIL", flaky: "FLAKY", error: "ERROR",
  skipped: "SKIPPED" };
const RESULT_COLOR: Record<CaseVerdict, string> = { pass: "32", fail: "31", flaky: "33", error: "35", skipped: "90" };

/** Pads to the column width; a longer value keeps two spaces after it so columns never touch. */
function cell(text: string, width: number): string {
  return text.length >= width ? `${text}  ` : text.padEnd(width);
}

export function formatUsd(x: number): string {
  return `$${x.toFixed(2)}`;
}

/** "2m03s". */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

/** "2026-11-12 21:04" from an ISO timestamp, in UTC. */
export function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0, 16).replace("T", " ");
}

function percent(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function caseCost(c: CaseResult): string {
  const known = c.trials.filter((t) => t.costUsd !== null);
  if (c.trials.length > 0 && known.length === 0) return "n/a";
  return formatUsd(known.reduce((s, t) => s + (t.costUsd ?? 0), 0));
}

function caseTime(c: CaseResult): string {
  return formatDuration(c.trials.reduce((s, t) => s + t.durationMs, 0));
}

/** What the "failed checks" column says for one case. A replay ran no trials, so its skipped text counts the
 * recordings it found rather than blaming the budget cap. A check prints its label when it has one. */
export function failedChecksText(c: CaseResult, repeat: number, mode: RunnerResult["mode"] = "live"): string {
  if (c.verdict === "error") {
    const t = c.trials.find((x) => x.verdict === "error");
    return t?.checks[0]?.detail ?? (t?.failure !== null && t?.failure !== undefined ? `${t.failure}, not scored` : "not scored");
  }
  if (c.verdict === "skipped") {
    return mode === "replay" ? `skipped: ${c.trials.length} of ${repeat} recordings found`
      : `skipped: ${c.trials.length} of ${repeat} trials ran (budget cap)`;
  }
  if (c.verdict === "pass") return "";
  const counts = new Map<string, number>();
  for (const t of c.trials) {
    for (const name of new Set(t.checks.filter((ch) => !ch.pass).map((ch) => ch.label ?? ch.kind))) {
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  return [...counts].map(([kind, n]) => (n === c.trials.length ? kind : `${kind} (${n} of ${c.trials.length} trials)`))
    .join(", ");
}

function headerLine(r: RunnerResult): string {
  const mode = r.mode === "replay" ? "  replay" : "";
  return `quote-desk-demo eval  ${r.caseSet}${mode}  model ${r.model}  effort ${r.effort}  k ${r.repeat}  sdk ${r.sdkVersion}`
    + `  seed ${r.dataSeed}  git ${r.gitSha ?? "none"}  ${formatDate(r.startedAt)}`;
}

export function totalsLine(r: RunnerResult): string {
  const t = r.totals;
  return `${t.cases} cases  ${t.pass} pass  ${t.fail} fail  ${t.flaky} flaky  ${t.error} error  ${t.skipped} skipped`
    + `  case pass rate ${percent(t.passRate)} of ${t.scored} scored (all k trials pass)`
    + `  trial pass rate ${percent(t.trialPassRate)}`;
}

export function categoryLine(r: RunnerResult): string {
  const parts: string[] = [];
  for (const cat of CATEGORY_ORDER) {
    const c = r.totals.byCategory[cat];
    if (c !== undefined) parts.push(`${cat} ${c.pass}/${c.scored}`);
  }
  return `by category  ${parts.join("  ")}`;
}

export function costLine(r: RunnerResult): string {
  const n = r.totals.unreportedTrials;
  return `cost ${formatUsd(r.totals.costUsd)} SDK-estimated, ${n} ${n === 1 ? "trial" : "trials"} unreported`
    + `  wall ${formatDuration(r.totals.durationMs)}`;
}

/** The ASCII table. Color only when asked; the runner asks on a TTY with NO_COLOR unset. */
export function renderTable(r: RunnerResult, o: TableOptions = {}): string {
  const paint = (verdict: CaseVerdict, text: string): string =>
    o.color === true ? `\u001b[${RESULT_COLOR[verdict]}m${text}\u001b[0m` : text;
  const lines: string[] = [headerLine(r)];
  lines.push(cell("case", WIDTH.case) + cell("category", WIDTH.category) + cell("fault", WIDTH.fault)
    + cell("result", WIDTH.result) + cell("failed checks", WIDTH.failed) + "cost".padStart(WIDTH.cost)
    + "time".padStart(WIDTH.time));
  for (const c of r.cases) {
    const result = cell(RESULT_TEXT[c.verdict], WIDTH.result);
    lines.push(cell(c.caseId, WIDTH.case) + cell(c.category, WIDTH.category) + cell(c.stockFault, WIDTH.fault)
      + paint(c.verdict, result) + cell(failedChecksText(c, r.repeat, r.mode), WIDTH.failed)
      + caseCost(c).padStart(WIDTH.cost) + caseTime(c).padStart(WIDTH.time));
  }
  lines.push(totalsLine(r), categoryLine(r), costLine(r));
  return lines.map((l) => l.trimEnd()).join("\n") + "\n";
}

const md = (s: string): string => s.replace(/\|/g, "\\|");

/** The markdown version: a header block, then the same columns. Week 2 reuses it as an issue body. */
export function renderMarkdown(r: RunnerResult): string {
  const lines: string[] = [`# quote-desk-demo eval: ${r.caseSet}${r.mode === "replay" ? " (replay)" : ""}`, ""];
  const block: [string, string][] = [["set", r.caseSet], ["model", r.model], ["effort", r.effort],
    ["k", String(r.repeat)], ["sdk", r.sdkVersion], ["seed", String(r.dataSeed)], ["git", r.gitSha ?? "none"],
    ["date", formatDate(r.startedAt)], ["totals", totalsLine(r)],
    ["category", categoryLine(r).replace(/^by category {2}/, "")], ["cost", costLine(r).replace(/^cost /, "")]];
  for (const [k, v] of block) lines.push(`- ${k}: ${v}`);
  lines.push("", "| case | category | fault | result | failed checks | cost | time |",
    "|---|---|---|---|---|---:|---:|");
  for (const c of r.cases) {
    lines.push(`| ${md(c.caseId)} | ${c.category} | ${md(c.stockFault)} | ${RESULT_TEXT[c.verdict]} | `
      + `${md(failedChecksText(c, r.repeat, r.mode))} | ${caseCost(c)} | ${caseTime(c)} |`);
  }
  return lines.join("\n") + "\n";
}
