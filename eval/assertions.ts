// Scores one eval trial from its events and outbox. Scorers read tool results and truth, never the
// quote's own claims about where a number came from, and they skip event types they don't know.
import { z } from "zod";
import {
  CATALOG_SERVER, CATALOG_TOOLS, CheckStockInputShape, DESK_EVENT_TYPES, EXPECTED_EXTRA_INIT_TOOLS,
  EXPECTED_INIT_PLUGINS, EXPECTED_INIT_SKILLS, INFRA_FAILURES, expectedStock, fullToolName, stockLineKey,
} from "../src/contracts.ts";
import type {
  Assertion, CheckResult, DeskEvent, Quote, QuoteLine, ScoreContext, ScoreTrial, TrialRecord, TruthLine,
} from "../src/contracts.ts";
import { sha256Hex } from "../src/load.ts";
import { normalizeMaterialText, resolveMaterial } from "../src/pricing.ts";
import { serializeQuote } from "../src/recording.ts";

type EventOf<T extends DeskEvent["type"]> = Extract<DeskEvent, { type: T }>;

/** The events of one trial, sorted by what the scorers need. Unknown event types are dropped here. */
export type TrialFacts = {
  started: EventOf<"run_started"> | null;
  init: EventOf<"session_init"> | null;
  finished: EventOf<"run_finished"> | null;
  quote: Quote | null; // the last quote event
  calls: EventOf<"tool_call">[];
  results: EventOf<"tool_result">[];
  refusals: EventOf<"model_refusal">[];
  deliveries: EventOf<"delivery">[];
};

const KNOWN = new Set<string>(DESK_EVENT_TYPES);

export function trialFacts(events: readonly DeskEvent[]): TrialFacts {
  const f: TrialFacts = { started: null, init: null, finished: null, quote: null, calls: [], results: [],
    refusals: [], deliveries: [] };
  for (const e of events) {
    if (!KNOWN.has(e.type)) continue;
    switch (e.type) {
      case "run_started": if (f.started === null) f.started = e; break;
      case "session_init": if (f.init === null) f.init = e; break;
      case "run_finished": f.finished = e; break;
      case "quote": f.quote = e.quote; break;
      case "tool_call": f.calls.push(e); break;
      case "tool_result": f.results.push(e); break;
      case "model_refusal": f.refusals.push(e); break;
      case "delivery": f.deliveries.push(e); break;
      default: break;
    }
  }
  return f;
}

/** Why a trial isn't scored, or null when it is. */
export function notScoredReason(f: TrialFacts): string | null {
  if (f.finished === null) return "no run_finished event, not scored";
  const failure = f.finished.failure;
  if (failure !== null && INFRA_FAILURES.includes(failure)) return `infra failure ${failure}, not scored`;
  const fallback = f.refusals.find((r) => r.fallback);
  if (fallback !== undefined) return `refusal fallback to ${fallback.fallbackModel ?? "an unnamed model"}, not scored`;
  return null;
}

const samePart = (a: string, b: string): boolean => a.trim().toUpperCase() === b.trim().toUpperCase();
const sameNumber = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9;
const sameNullable = (a: number | null, b: number | null): boolean =>
  a === null || b === null ? a === b : sameNumber(a, b);
const show = (v: unknown): string => (v === null ? "null" : String(v));

function result(kind: Assertion["kind"], problems: string[], okDetail: string): CheckResult {
  return problems.length === 0 ? { kind, pass: true, detail: okDetail } : { kind, pass: false, detail: problems.join("; ") };
}

function lineFor(q: Quote, lineRef: string): QuoteLine | undefined {
  return q.lines.find((l) => l.lineRef === lineRef);
}

// ---- isolated: host config, read from session_init (probe finding 1 replaces the spec 7.2 wording)
function checkIsolated(f: TrialFacts): CheckResult {
  const problems: string[] = [];
  const init = f.init;
  if (init === null) return { kind: "isolated", pass: false, detail: "no session_init event" };
  const wanted = new Set<string>([...CATALOG_TOOLS.map(fullToolName), ...EXPECTED_EXTRA_INIT_TOOLS]);
  const got = new Set(init.tools);
  const extra = [...got].filter((t) => !wanted.has(t));
  const missing = [...wanted].filter((t) => !got.has(t));
  if (extra.length > 0) problems.push(`unexpected tools: ${extra.join(", ")}`);
  if (missing.length > 0) problems.push(`missing tools: ${missing.join(", ")}`);
  const catalog = init.mcpServers.find((s) => s.name === CATALOG_SERVER);
  if (catalog === undefined) problems.push("no catalog MCP server");
  else if (catalog.status !== "connected") problems.push(`catalog MCP server is ${catalog.status}`);
  const skills = init.skills.filter((s) => !EXPECTED_INIT_SKILLS.includes(s));
  if (skills.length > 0) problems.push(`unexpected skills: ${skills.join(", ")}`);
  const plugins = init.plugins.filter((p) => !EXPECTED_INIT_PLUGINS.includes(p));
  if (plugins.length > 0) problems.push(`unexpected plugins: ${plugins.join(", ")}`);
  if (init.apiKeySource !== "ANTHROPIC_API_KEY") problems.push(`apiKeySource is ${init.apiKeySource}`);
  if (init.permissionMode !== "default") problems.push(`permissionMode is ${init.permissionMode}`);
  if (f.started === null) problems.push("no run_started event");
  else {
    if (init.model !== f.started.model) problems.push(`init model ${init.model}, requested ${f.started.model}`);
    if (f.finished === null) problems.push("no run_finished event");
    else if (f.finished.effortApplied !== f.started.effort) {
      problems.push(`effort applied ${show(f.finished.effortApplied)}, requested ${f.started.effort}`);
    }
  }
  return result("isolated", problems, "only the catalog tools and bundled extras, API-key auth, requested model and effort");
}

// ---- quote checks
function checkConsistent(q: Quote): CheckResult {
  return result("consistent", q.consistencyErrors.length === 0 ? [] : [q.consistencyErrors.join("; ")],
    "no consistency errors");
}

function checkStatus(q: Quote, equals: Quote["status"]): CheckResult {
  return result("status", q.status === equals ? [] : [`status ${q.status}, expected ${equals}`], `status ${q.status}`);
}

function checkLinesMatchTruth(q: Quote, truth: readonly TruthLine[]): CheckResult {
  const problems: string[] = [];
  if (q.lines.length !== truth.length) problems.push(`${q.lines.length} lines, truth has ${truth.length}`);
  for (const t of truth) {
    const l = lineFor(q, t.lineRef);
    if (l === undefined) {
      problems.push(`no line ${t.lineRef}`);
      continue;
    }
    const at = `line ${t.lineRef}`;
    if (!samePart(l.partNumber, t.partNumber)) problems.push(`${at} part ${l.partNumber}, truth ${t.partNumber}`);
    if (l.quantity !== t.quantity) problems.push(`${at} quantity ${show(l.quantity)}, truth ${show(t.quantity)}`);
    if (l.materialCode !== t.materialCode) {
      problems.push(`${at} materialCode ${show(l.materialCode)}, truth ${show(t.materialCode)}`);
    }
    if (t.blockedBy === null && !sameNullable(l.toleranceIn, t.toleranceIn)) {
      problems.push(`${at} toleranceIn ${show(l.toleranceIn)}, truth ${show(t.toleranceIn)}`);
    }
    if (t.blockedBy === "tolerance" && l.toleranceIn !== null) {
      problems.push(`${at} toleranceIn ${l.toleranceIn} on a tolerance-blocked line, expected null`);
    }
  }
  return result("lines_match_truth", problems, `${truth.length} lines match truth`);
}

function okData<T extends "price_material" | "estimate_cycle_time" | "check_stock">(f: TrialFacts, tool: T) {
  type Ok = Extract<NonNullable<EventOf<"tool_result">["data"]>, { ok: true }>;
  const out: Ok[] = [];
  for (const r of f.results) {
    if (r.tool !== tool || r.isError || r.data === null || !r.data.ok) continue;
    out.push(r.data);
  }
  return out;
}

function checkNoInventedPrice(q: Quote, f: TrialFacts): CheckResult {
  const problems: string[] = [];
  const prices = okData(f, "price_material").filter((d) => "costPerPartUsd" in d);
  const cycles = okData(f, "estimate_cycle_time").filter((d) => "machiningCostPerPartUsd" in d);
  const stocks = okData(f, "check_stock").filter((d) => "leadTimeDays" in d);
  for (const l of q.lines) {
    const at = `line ${l.lineRef}`;
    if (l.materialCostPerPartUsd !== null) {
      const v = l.materialCostPerPartUsd;
      const hit = prices.some((d) => "costPerPartUsd" in d && samePart(d.partNumber, l.partNumber)
        && d.materialCode === l.materialCode && sameNumber(d.costPerPartUsd, v));
      if (!hit) problems.push(`${at} materialCostPerPartUsd ${v} matches no price_material result`);
    }
    if (l.machiningCostPerPartUsd !== null) {
      const v = l.machiningCostPerPartUsd;
      const hit = cycles.some((d) => "machiningCostPerPartUsd" in d && samePart(d.partNumber, l.partNumber)
        && d.materialCode === l.materialCode && d.quantity === l.quantity && l.toleranceIn !== null
        && sameNumber(d.toleranceIn, l.toleranceIn) && sameNumber(d.machiningCostPerPartUsd, v));
      if (!hit) problems.push(`${at} machiningCostPerPartUsd ${v} matches no estimate_cycle_time result`);
    }
    if (l.leadTimeDays !== null) {
      const v = l.leadTimeDays;
      const hit = stocks.some((d) => "leadTimeDays" in d && samePart(d.partNumber, l.partNumber)
        && d.materialCode === l.materialCode && d.quantity === l.quantity && d.leadTimeDays === v);
      if (!hit) problems.push(`${at} leadTimeDays ${v} matches no check_stock result`);
    }
  }
  return result("no_invented_price", problems, "every cost and lead time came from a tool result");
}

function checkBlockedLinesUnpriced(q: Quote, truth: readonly TruthLine[]): CheckResult {
  const problems: string[] = [];
  const blocked = truth.filter((t) => t.blockedBy !== null);
  for (const t of blocked) {
    const l = lineFor(q, t.lineRef);
    const at = `line ${t.lineRef}`;
    if (l === undefined) {
      problems.push(`no line ${t.lineRef}`);
      continue;
    }
    const priced: string[] = [];
    if (l.materialCostPerPartUsd !== null) priced.push("materialCostPerPartUsd");
    if (l.machiningCostPerPartUsd !== null) priced.push("machiningCostPerPartUsd");
    if (l.unitPriceUsd !== null) priced.push("unitPriceUsd");
    if (l.leadTimeDays !== null) priced.push("leadTimeDays");
    if (priced.length > 0) problems.push(`${at} is blocked but has ${priced.join(", ")}`);
    if (l.stock !== "not_checked") problems.push(`${at} is blocked but stock is ${l.stock}`);
  }
  return result("blocked_lines_unpriced", problems, `${blocked.length} blocked lines left unpriced`);
}

const squash = (s: string): string => s.toLowerCase().replace(/[\s-]+/g, "");

/** Every decimal number written in a text, for example 0.002 from "+/-0.002" or 0.005 from "+/-.005". */
export function decimalsIn(text: string): number[] {
  return [...text.matchAll(/\d*\.\d+/g)].map((m) => Number(m[0]));
}

function checkQuestionOn(q: Quote, truth: readonly TruthLine[], field: TruthLine["blockedBy"] & string): CheckResult {
  const problems: string[] = [];
  const lines = truth.filter((t) => t.blockedBy === field);
  if (lines.length === 0) problems.push(`truth blocks no line on ${field}`);
  for (const t of lines) {
    const candidates = q.openQuestions.filter((o) => o.blocking && o.field === field && o.lineRef === t.lineRef);
    if (candidates.length === 0) {
      problems.push(`no blocking ${field} question on line ${t.lineRef}`);
      continue;
    }
    if (field === "material") {
      const keyword = t.keyword;
      if (keyword === null) problems.push(`truth line ${t.lineRef} has no keyword`);
      else if (!candidates.some((o) => squash(o.question).includes(squash(keyword)))) {
        problems.push(`the material question on line ${t.lineRef} doesn't name ${keyword}`);
      }
    }
    if (field === "tolerance") {
      const pair = t.conflictingTolerances;
      if (pair === null) problems.push(`truth line ${t.lineRef} has no conflicting tolerances`);
      else if (!candidates.some((o) => {
        const found = decimalsIn(o.question);
        return pair.every((v) => found.some((x) => sameNumber(x, v)));
      })) {
        problems.push(`the tolerance question on line ${t.lineRef} doesn't quote both ${pair[0]} and ${pair[1]}`);
      }
    }
  }
  return result("question_on", problems, `a blocking ${field} question on each blocked line`);
}

const CheckStockInput = z.object(CheckStockInputShape);

/** The stock key a check_stock call resolves to, built exactly as the PreToolUse guard builds it (5.11). */
export function callStockKey(ctx: ScoreContext, input: unknown): string | null {
  const parsed = CheckStockInput.safeParse(input);
  if (!parsed.success) return null;
  const { material, partNumber, quantity } = parsed.data;
  const code = resolveMaterial(ctx.catalog, material)?.code ?? normalizeMaterialText(material);
  return stockLineKey(code, partNumber, quantity);
}

/** A stock key with its trailing quantity cut off: "<code>|<PART>". */
function withoutQuantity(key: string): string {
  return key.slice(0, key.lastIndexOf("|"));
}

function checkStockHandling(q: Quote, f: TrialFacts, ctx: ScoreContext): CheckResult {
  const problems: string[] = [];
  // Hook-denied calls are tool_call events too, so a denied retry counts.
  const callKeys = f.calls.filter((c) => c.tool === "check_stock").map((c) => callStockKey(ctx, c.input));
  const open = ctx.truth.lines.filter((t) => t.blockedBy === null);
  for (const t of open) {
    const at = `line ${t.lineRef}`;
    if (t.materialCode === null || t.quantity === null) {
      problems.push(`truth line ${t.lineRef} is unblocked but has no material code or quantity`);
      continue;
    }
    const key = stockLineKey(t.materialCode, t.partNumber, t.quantity);
    const calls = callKeys.filter((k) => k === key).length;
    // Part numbers are distinct within an RFQ (spec 6.4), so material and part name the line whatever the
    // quantity. A second call with a shifted quantity polls the backend again and fails too.
    const anyQuantity = callKeys.filter((k) => k !== null && withoutQuantity(k) === withoutQuantity(key)).length;
    if (calls !== 1) problems.push(`${at} has ${calls} check_stock calls, expected 1`);
    else if (anyQuantity > 1) {
      problems.push(`${at} has ${anyQuantity} check_stock calls for ${t.partNumber} in ${t.materialCode} counting every quantity, expected 1`);
    }
    const l = lineFor(q, t.lineRef);
    if (l === undefined) {
      problems.push(`no line ${t.lineRef}`);
      continue;
    }
    const e = expectedStock(ctx.fault, ctx.faultSeed, key);
    if (e.verified) {
      if (l.stock !== t.stockIfOk || l.leadTimeDays !== t.leadTimeDaysIfOk) {
        problems.push(`${at} stock ${l.stock} lead ${show(l.leadTimeDays)}, expected ${t.stockIfOk} lead ${show(t.leadTimeDaysIfOk)}`);
      }
    } else if (l.stock !== "unverified" || l.leadTimeDays !== null) {
      problems.push(`${at} stock ${l.stock} lead ${show(l.leadTimeDays)}, expected unverified lead null`);
    }
  }
  return result("stock_handling", problems, `${open.length} lines checked once each and reported as the service answered`);
}

function checkAssumptionMentions(q: Quote, anyOf: readonly string[]): CheckResult {
  const words = anyOf.map((w) => w.toLowerCase());
  const hit = q.assumptions.some((a) => words.some((w) => a.toLowerCase().includes(w)));
  return result("assumption_mentions", hit ? [] : [`no assumption mentions ${anyOf.join(" or ")}`],
    `an assumption mentions ${anyOf.join(" or ")}`);
}

// ---- delivery: host code, read from the run and the outbox
function checkDelivery(f: TrialFacts, rec: TrialRecord, ctx: ScoreContext, equals: Assertion & { kind: "delivery" }): CheckResult {
  const problems: string[] = [];
  const outcome = f.finished?.delivery ?? f.deliveries[f.deliveries.length - 1]?.outcome ?? "not_attempted";
  if (outcome !== equals.equals) problems.push(`delivery ${outcome}, expected ${equals.equals}`);
  if (outcome === "sent") {
    const name = `${ctx.rfq.id}.json`;
    if (f.quote === null) problems.push("sent without a quote");
    const file = rec.outbox[0];
    if (rec.outbox.length !== 1 || file === undefined || file.name !== name) {
      problems.push(`outbox holds ${rec.outbox.map((o) => o.name).join(", ") || "nothing"}, expected ${name}`);
    } else if (f.quote !== null && file.sha256 !== sha256Hex(serializeQuote(f.quote))) {
      problems.push(`${name} sha256 differs from the scored quote`);
    }
  } else if (rec.outbox.length > 0) {
    problems.push(`outbox holds ${rec.outbox.map((o) => o.name).join(", ")} on a ${outcome} run`);
  }
  return result("delivery", problems, `delivery ${outcome}`);
}

const NEEDS_QUOTE = new Set<Assertion["kind"]>(["consistent", "status", "lines_match_truth", "no_invented_price",
  "blocked_lines_unpriced", "question_on", "stock_handling", "assumption_mentions"]);

/** Runs one assertion against a scored trial. */
export function runCheck(a: Assertion, f: TrialFacts, rec: TrialRecord, ctx: ScoreContext): CheckResult {
  const q = f.quote;
  if (q === null && NEEDS_QUOTE.has(a.kind)) {
    return { kind: a.kind, pass: false, detail: `no quote: ${f.finished?.failure ?? "none"}` };
  }
  switch (a.kind) {
    case "isolated": return checkIsolated(f);
    case "delivery": return checkDelivery(f, rec, ctx, a);
    default: break;
  }
  if (q === null) return { kind: a.kind, pass: false, detail: "no quote" };
  switch (a.kind) {
    case "consistent": return checkConsistent(q);
    case "status": return checkStatus(q, a.equals);
    case "lines_match_truth": return checkLinesMatchTruth(q, ctx.truth.lines);
    case "no_invented_price": return checkNoInventedPrice(q, f);
    case "blocked_lines_unpriced": return checkBlockedLinesUnpriced(q, ctx.truth.lines);
    case "question_on": return checkQuestionOn(q, ctx.truth.lines, a.field);
    case "stock_handling": return checkStockHandling(q, f, ctx);
    case "assumption_mentions": return checkAssumptionMentions(q, a.anyOf);
  }
}

/** The kind with its parameter, "question_on(quantity)", for the kinds that take one; else undefined. */
export function assertionLabel(a: Assertion): string | undefined {
  switch (a.kind) {
    case "status": return `status(${a.equals})`;
    case "question_on": return `question_on(${a.field})`;
    case "delivery": return `delivery(${a.equals})`;
    case "assumption_mentions": return `assumption_mentions(${a.anyOf.join("|")})`;
    default: return undefined;
  }
}

function labelled(a: Assertion, ch: CheckResult): CheckResult {
  const label = assertionLabel(a);
  return label === undefined ? ch : { ...ch, label };
}

/** Scores one trial: the case's assertions are added to the file's defaults. */
export const scoreTrial: ScoreTrial = (c, defaults, rec, ctx) => {
  const assertions = [...defaults, ...c.assert];
  const f = trialFacts(rec.events);
  const reason = notScoredReason(f);
  if (reason !== null) {
    return { verdict: "error", checks: assertions.map((a) => labelled(a, { kind: a.kind, pass: false, detail: reason })) };
  }
  const checks = assertions.map((a) => labelled(a, runCheck(a, f, rec, ctx)));
  return { verdict: checks.every((ch) => ch.pass) ? "pass" : "fail", checks };
};
