// The demo CLI: rendering of the three recorded scenarios, and demoMain driven by a fake runQuote.
// No model, no network, no API key, and nothing here reads process.env.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";
import { DEFAULT_EFFORT, DEFAULT_MODEL, HOLD_REASONS, STOCK_DELAY_MS } from "../src/contracts.ts";
import type { DeskEvent, Delivery, Quote, Recording, Rfq, RunOptions, RunQuote, ToolError } from "../src/contracts.ts";
import { sha256Hex } from "../src/load.ts";
import { PATHS } from "../src/paths.ts";
import { readRecording, serializeQuote } from "../src/recording.ts";
import { demoMain } from "../src/cli/demo.ts";
import type { DemoDeps } from "../src/cli/demo.ts";
import { renderEvent, renderHeader, renderQuote } from "../src/cli/render.ts";

const fixture = (name: string): string => join(PATHS.root, "test", "fixtures", "cli", name);
const RFQS = fixture("rfqs.json");
const TEXT_DELTA_LINE = '{"kind":"event","event":{"type":"text_delta","text":"x"}}';
const OFF = { color: false };
const ESC = "\u001b";

function load(name: string): Recording {
  return readRecording(fixture(name));
}

function renderAll(rec: Recording, o = OFF): string[] {
  return rec.events.flatMap((e) => (e.type === "run_started" ? [renderHeader(e, ".env", o)] : renderEvent(e, o)));
}

function quoteOf(rec: Recording): Quote {
  const e = rec.events.find((x) => x.type === "quote");
  assert.ok(e !== undefined && e.type === "quote", "the recording holds a quote");
  return e.quote;
}

function isAscii(s: string): boolean {
  return [...s].every((ch) => (ch.codePointAt(0) ?? 0) < 0x80);
}

const count = (lines: string[], re: RegExp): number => lines.filter((l) => re.test(l)).length;

const clean = load("clean.jsonl");
const unknown = load("unknown-material.jsonl");
const down = load("stock-down.jsonl");

// ---- rendering

test("each fixture holds one text_delta line, readRecording skips it and renderEvent renders nothing for it", () => {
  for (const name of ["clean.jsonl", "unknown-material.jsonl", "stock-down.jsonl"]) {
    const raw = readFileSync(fixture(name), "utf8");
    assert.equal(raw.split("\n").filter((l) => l === TEXT_DELTA_LINE).length, 1, `${name} has one text_delta line`);
    assert.ok(!raw.includes("\r"), `${name} uses LF line endings`);
    const rec = load(name);
    assert.ok(rec.events.every((e) => (e.type as string) !== "text_delta"));
    assert.deepEqual(rec.events.map((e) => e.seq), rec.events.map((_, i) => i));
  }
  const delta = { v: 1, runId: "r", seq: 3, t: 10, type: "text_delta", text: "x" } as unknown as DeskEvent;
  assert.deepEqual(renderEvent(delta, OFF), []);
  assert.deepEqual(renderEvent(delta, { color: true }), []);
});

test("clean.jsonl renders the header, one init line, every tool call, attempts and the quote table", () => {
  const lines = renderAll(clean);
  assert.equal(lines[0], "quote-desk-demo  RFQ-001  model claude-opus-5-5  effort medium  stock fault ok  API key: .env");
  assert.equal(count(lines, /^session {2}model claude-opus-5-5 {2}permission default {2}tools lookup_part, price_material, estimate_cycle_time, check_stock, StructuredOutput {2}mcp catalog connected/), 1);
  for (const tool of ["lookup_part", "price_material", "estimate_cycle_time", "check_stock"]) {
    assert.equal(count(lines, new RegExp(`^-> ${tool} `)), 2, `two ${tool} calls`);
  }
  assert.ok(lines.includes("-> lookup_part partNumber=QD-90001"));
  assert.ok(lines.includes("-> price_material partNumber=QD-90004 material=\"304 stainless\""));
  assert.ok(lines.includes("-> StructuredOutput (quote draft)"));
  assert.equal(count(lines, /^ {3}ok QD-\d+ \S+ in_stock .* attempts 1\/3 \d+ms$/), 2);
  assert.equal(count(lines, /^ {3}ok /), 9, "8 catalog results and the StructuredOutput result");

  const header = lines.findIndex((l) => /^line +part +material +qty +material \$ +machining \$ +unit \$ +ext \$ +stock +lead$/.test(l));
  assert.ok(header > 0, "the table header is there");
  assert.equal(lines[header - 1], "Quote RFQ-001  Ridgeback Fixture Works  status ready");
  const row1 = (lines[header + 1] ?? "").split(/ {2,}/);
  assert.deepEqual(row1, ["1", "QD-90001", "AL-6061-T6", "40", "4.91", "17.66", "29.34", "1,173.60", "in_stock", "10 d"]);
  const row2 = (lines[header + 2] ?? "").split(/ {2,}/);
  assert.deepEqual([row2[0], row2[1], row2[2], row2[3], row2[8]], ["2", "QD-90004", "SS-304", "20", "in_stock"]);
  const total = quoteOf(clean).totalUsd;
  assert.ok(total !== null);
  const totalText = total.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/, ",");
  assert.ok(lines.includes("Assumptions:"));
  assert.ok(lines.includes(`Total $${totalText}  (margin 30%)`));
  assert.ok(lines.includes(`Approval requested for RFQ-001, total $${totalText}`));
  assert.ok(lines.includes("Decision: decline"));
  assert.ok(lines.includes("Declined"));
  assert.equal(lines.at(-1), "cost $0.09 (SDK estimate)  turns 6  31.5s");
});

test("unknown-material.jsonl renders UNKNOWN_MATERIAL, the blocking question and Held: needs clarification", () => {
  const lines = renderAll(unknown);
  assert.equal(lines[0], "quote-desk-demo  RFQ-019  model claude-opus-5-5  effort medium  stock fault ok  API key: .env");
  assert.ok(lines.includes("-> price_material partNumber=QD-90002 material=\"Ti-6Al-4V titanium\""));
  assert.equal(count(lines, /^ {3}UNKNOWN_MATERIAL .*Suggestions: Stainless 304, Aluminum 6061-T6\. \d+ms$/), 1);
  assert.equal(count(lines, /^-> (estimate_cycle_time|check_stock) /), 0);
  const header = lines.findIndex((l) => l.startsWith("line "));
  assert.deepEqual((lines[header + 1] ?? "").split(/ {2,}/),
    ["1", "QD-90002", "Ti-6Al-4V titanium (not in catalog)", "10", "-", "-", "-", "-", "not_checked", "-"]);
  assert.ok(lines.includes("Open questions:"));
  assert.equal(count(lines, /^ {2}line 1, material, blocking: We don't carry Ti-6Al-4V titanium\. /), 1);
  assert.ok(lines.includes("Total: not priced while a line is blocked"));
  assert.ok(lines.includes(`Held: ${HOLD_REASONS.needs_clarification}`));
  assert.equal(count(lines, /^(Approval requested|Decision:)/), 0);
});

test("an error message that already names its suggestions prints them once, and a clipped one still shows them", () => {
  const base = { v: 1 as const, runId: "r", seq: 6, t: 70, type: "tool_result" as const, toolUseId: "t1",
    tool: "mcp__catalog__price_material", isError: true, ms: 2 };
  const suggestions = ["Aluminum 6061-T6", "Aluminum 7075-T6", "Brass C360"];
  const err = (message: string): ToolError => ({ ok: false, code: "UNKNOWN_MATERIAL", message, suggestions, attempts: null });
  // The shape the price_material tool sends: the nearest materials are already in the message.
  const named = err(`No catalog material matches "Ti-6Al-4V titanium". Nearest stocked materials: ${suggestions.join(", ")}.`);
  const [line = ""] = renderEvent({ ...base, data: named, text: JSON.stringify(named) }, OFF);
  assert.equal(line.split("Suggestions:").length - 1, 0, line);
  for (const s of suggestions) assert.equal(line.split(s).length - 1, 1, `${s} once in: ${line}`);
  // A message long enough that clipping cuts the names off gets them appended.
  const long = err(`No catalog material matches "${"x".repeat(150)}". Nearest stocked materials: ${suggestions.join(", ")}.`);
  const [clipped = ""] = renderEvent({ ...base, data: long, text: JSON.stringify(long) }, OFF);
  assert.equal(clipped.split("Suggestions:").length - 1, 1, clipped);
  assert.ok(clipped.includes(`Suggestions: ${suggestions.join(", ")}.`), clipped);
});

test("stock-down.jsonl shows the passing shape: one check_stock per line, STOCK_UNAVAILABLE, no guard line", () => {
  const lines = renderAll(down);
  const q = quoteOf(down);
  assert.equal(lines[0], "quote-desk-demo  RFQ-001  model claude-opus-5-5  effort medium  stock fault down  API key: .env");
  assert.equal(count(lines, /^-> check_stock /), q.lines.length);
  assert.equal(count(lines, /^ {3}STOCK_UNAVAILABLE .* attempts 3\/3 \d+ms$/), q.lines.length);
  assert.equal(count(lines, /\[guard\]/), 0);
  assert.equal(down.events.filter((e) => e.type === "guard_denied").length, 0);
  const header = lines.findIndex((l) => l.startsWith("line "));
  for (let i = 1; i <= q.lines.length; i++) {
    const cells = (lines[header + i] ?? "").split(/ {2,}/);
    assert.deepEqual([cells[8], cells[9]], ["unverified", "-"]);
    assert.notEqual(cells[7], "-", "an unverified line stays priced");
  }
  assert.ok(lines.some((l) => l.startsWith("Total $")));
  assert.ok(lines.includes(`Held: ${HOLD_REASONS.pending_stock_check}`));
  assert.ok(lines.includes("Held: pending stock check"));
});

test("no ANSI when color is off, ANSI when it is on, and every line is ASCII", () => {
  for (const rec of [clean, unknown, down]) {
    const plain = renderAll(rec).join("\n");
    assert.ok(!plain.includes(ESC));
    assert.ok(isAscii(plain));
    const colored = renderAll(rec, { color: true }).join("\n");
    assert.ok(colored.includes(`${ESC}[`));
    assert.ok(isAscii(colored));
  }
});

test("an inline guard_denied event renders the [guard] line, and a refusal renders its line", () => {
  const base = { v: 1 as const, runId: "r", seq: 5, t: 100 };
  assert.deepEqual(renderEvent({ ...base, type: "guard_denied", tool: "check_stock", toolUseId: "toolu_9",
    by: "retry_cap", reason: "check_stock already ran for this line. If it failed, mark the line unverified and continue." }, OFF),
  ["   [guard] check_stock already ran for this line. If it failed, mark the line unverified and continue."]);
  assert.deepEqual(renderEvent({ ...base, type: "model_refusal", fallback: false, originalModel: "claude-opus-5-5",
    fallbackModel: null, scope: null, category: "cyber" }, OFF),
  ["[refusal] claude-opus-5-5 refused (cyber); fallback none"]);
  assert.deepEqual(renderEvent({ ...base, type: "model_refusal", fallback: true, originalModel: "claude-opus-5-5",
    fallbackModel: "claude-sonnet-5-5", scope: "turn", category: null }, OFF),
  ["[refusal] claude-opus-5-5 refused (no category); fallback claude-sonnet-5-5"]);
});

test("model text is cleaned to ASCII with no escape codes and assistant text stays under 300 characters", () => {
  const base = { v: 1 as const, runId: "r", seq: 2, t: 5 };
  const [line] = renderEvent({ ...base, type: "assistant_text", text: `Tolerance \u00b10.002 \u2014 ok ${ESC}[31mred${ESC}[0m\ntwo` }, OFF);
  assert.equal(line, "Tolerance +/-0.002 - ok ?[31mred?[0m two");
  const long = renderEvent({ ...base, type: "assistant_text", text: "word ".repeat(200) }, OFF);
  assert.equal(long.length, 1);
  assert.ok((long[0] ?? "").length < 300 && (long[0] ?? "").endsWith("..."));
  const q = quoteOf(unknown);
  const lines = renderQuote({ ...q, customer: "Caf\u00e9 \u201cNorth\u201d", assumptions: ["\u00d7 2"] }, OFF);
  assert.ok(lines.every(isAscii));
  assert.equal(lines[0], "Quote RFQ-019  Caf? \"North\"  status needs_clarification");
});

test("run_finished renders cost unreported when the SDK reported none, and the failure when the run wasn't ok", () => {
  const base = { v: 1 as const, runId: "r", seq: 9, t: 900 };
  assert.deepEqual(renderEvent({ ...base, type: "run_finished", ok: false, failure: "max_turns", detail: "hit 20 turns",
    costUsd: null, usage: null, modelsUsed: [], effortApplied: null, turns: null, durationMs: 1234, delivery: "not_attempted" }, OFF),
  ["Run failed: max_turns: hit 20 turns", "cost unreported  turns -  1.2s"]);
  assert.deepEqual(renderEvent({ ...base, type: "delivery", outcome: "sent", file: "RFQ-001.json", reason: null }, OFF),
    ["Wrote out/outbox/RFQ-001.json"]);
  assert.deepEqual(renderEvent({ ...base, type: "delivery", outcome: "not_attempted", file: null, reason: null }, OFF),
    ["Not offered for approval"]);
});

// ---- demoMain with a fake runQuote

type Call = { rfq: Rfq; opts: RunOptions | undefined };

/**
 * A fake runQuote that replays a recording's events up to the quote, then acts as the gate: a quote that
 * isn't ready is held, a ready one goes to the approver, and an approved one is written to the outbox.
 */
function fakeRun(source: Recording): { runQuote: RunQuote; calls: Call[] } {
  const calls: Call[] = [];
  const runQuote: RunQuote = async function* (rfq, opts) {
    calls.push({ rfq, opts });
    let seq = 0;
    const runId = source.events[0]?.runId ?? "r";
    const env = () => ({ v: 1 as const, runId, seq: seq++, t: seq * 10 });
    let delivery: Delivery = "not_attempted";
    for (const e of source.events) {
      if (e.type === "approval_requested" || e.type === "approval_resolved" || e.type === "delivery") continue;
      if (e.type === "run_finished") {
        yield { ...e, ...env(), delivery };
        continue;
      }
      yield { ...e, ...env() };
      if (e.type !== "quote") continue;
      const approver = opts?.approver;
      if (e.quote.status !== "ready") {
        delivery = "not_ready";
        yield { ...env(), type: "delivery", outcome: delivery, file: null, reason: HOLD_REASONS[e.quote.status] };
      } else if (approver === undefined) {
        yield { ...env(), type: "delivery", outcome: delivery, file: null, reason: null };
      } else {
        yield { ...env(), type: "approval_requested", rfqId: e.quote.rfqId, totalUsd: e.quote.totalUsd };
        const decision = await approver(e.quote);
        yield { ...env(), type: "approval_resolved", decision };
        let file: string | null = null;
        if (decision === "approve") {
          file = `${e.quote.rfqId}.json`;
          const dir = opts?.outboxDir;
          assert.ok(dir !== undefined);
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, file), serializeQuote(e.quote));
        }
        delivery = decision === "approve" ? "sent" : "declined";
        yield { ...env(), type: "delivery", outcome: delivery, file, reason: null };
      }
    }
  };
  return { runQuote, calls };
}

const noRun: RunQuote = async function* () {
  throw new Error("runQuote must not be called");
};

function sink(): { stream: Writable; text: () => string; lines: () => string[] } {
  const chunks: string[] = [];
  const stream = new Writable({ write(chunk, _enc, cb) { chunks.push(String(chunk)); cb(); } });
  const text = (): string => chunks.join("");
  return { stream, text, lines: () => text().split("\n").filter((l) => l !== "") };
}

function stdinOf(text: string): PassThrough {
  const s = new PassThrough();
  s.end(text);
  return s;
}

const scratch = mkdtempSync(join(tmpdir(), "qd-cli-"));
test.after(() => rmSync(scratch, { recursive: true, force: true }));
let outboxNo = 0;

function setup(o: { source?: Recording; runQuote?: RunQuote; stdin?: string; tty?: boolean; stdinIsTTY?: boolean;
  stdoutIsTTY?: boolean; env?: Record<string, string | undefined>; keySource?: DemoDeps["keySource"];
  rfqsPath?: string } = {}) {
  const fake = fakeRun(o.source ?? clean);
  const out = sink();
  const deps: DemoDeps = { runQuote: o.runQuote ?? fake.runQuote, stdin: stdinOf(o.stdin ?? ""), stdout: out.stream,
    stdinIsTTY: o.stdinIsTTY ?? o.tty ?? false, stdoutIsTTY: o.stdoutIsTTY ?? o.tty ?? false,
    env: o.env ?? { NO_COLOR: "1" }, keySource: o.keySource ?? ".env", rfqsPath: o.rfqsPath ?? RFQS,
    outboxDir: join(scratch, `outbox-${++outboxNo}`) };
  return { deps, calls: fake.calls, out };
}

function onlyCall(calls: Call[]): Call & { opts: RunOptions } {
  assert.equal(calls.length, 1, "runQuote ran once");
  const c = calls[0];
  assert.ok(c !== undefined && c.opts !== undefined);
  return { rfq: c.rfq, opts: c.opts };
}

test("each scenario maps to its RFQ and stock fault, with the demo defaults in opts", async () => {
  const cases: [string, Recording, string, string, number][] = [
    ["clean", clean, "RFQ-001", "ok", 0], ["unknown-material", unknown, "RFQ-019", "ok", 0],
    ["stock-down", down, "RFQ-001", "down", 0]];
  for (const [scenario, source, rfqId, fault, code] of cases) {
    const { deps, calls, out } = setup({ source });
    assert.equal(await demoMain(["--scenario", scenario, "--approve", "no"], deps), code, scenario);
    const { rfq, opts } = onlyCall(calls);
    assert.equal(rfq.id, rfqId);
    assert.equal(rfq.contactEmail.endsWith(".example"), true);
    assert.deepEqual([opts.stockFault, opts.model, opts.effort, opts.stockDelayMs, opts.outboxDir],
      [fault, DEFAULT_MODEL, DEFAULT_EFFORT, STOCK_DELAY_MS.demo, deps.outboxDir]);
    assert.equal(typeof opts.approver, "function");
    assert.ok(!("faultSeed" in opts) && !("catalogPath" in opts) && !("signal" in opts), "unset options are omitted");
    assert.equal(out.lines()[0], `quote-desk-demo  ${rfqId}  model claude-opus-5-5  effort medium  stock fault ${fault}  API key: .env`);
    assert.ok(!out.text().includes("No TTY"));
  }
});

test("a live run with no outboxDir in deps hands runQuote PATHS.outbox", async () => {
  const { deps, calls } = setup();
  const { outboxDir: _given, ...rest } = deps;
  const bare: DemoDeps = rest;
  assert.ok(!("outboxDir" in bare), "this run goes through the default");
  // --approve no, so nothing is written to the real outbox.
  assert.equal(await demoMain(["--scenario", "clean", "--approve", "no"], bare), 0);
  assert.equal(onlyCall(calls).opts.outboxDir, PATHS.outbox);
});

test("--approve no declines and --approve yes approves", async () => {
  const no = setup();
  assert.equal(await demoMain(["--scenario", "clean", "--approve", "no"], no.deps), 0);
  const noOpts = onlyCall(no.calls).opts;
  assert.ok(noOpts.approver !== undefined);
  assert.equal(await noOpts.approver(quoteOf(clean)), "decline");
  assert.ok(no.out.lines().includes("Declined"));
  assert.ok(!no.out.text().includes("Wrote out/outbox"));

  const yes = setup();
  assert.equal(await demoMain(["--scenario", "clean", "--approve", "yes"], yes.deps), 0);
  const yesOpts = onlyCall(yes.calls).opts;
  assert.ok(yesOpts.approver !== undefined);
  assert.equal(await yesOpts.approver(quoteOf(clean)), "approve");
  assert.ok(yes.out.lines().includes("Wrote out/outbox/RFQ-001.json"));
  assert.ok(!yes.out.text().includes("[y/N]"), "only --approve ask prompts");
});

test("--stock-fault is parsed, normalized, overrides a scenario's fault, and a bad spec is a usage error", async () => {
  const runs: [string[], string][] = [
    [["--rfq", "RFQ-019", "--stock-fault", "flaky:0.50"], "flaky:0.5"],
    [["--rfq", "rfq-019", "--stock-fault", "fail-first:2"], "fail-first:2"],
    [["--rfq", "RFQ-001", "--stock-fault", "down"], "down"],
    [["--scenario", "stock-down", "--stock-fault", "ok"], "ok"],
    [["--rfq", "RFQ-001"], "ok"],
  ];
  for (const [args, fault] of runs) {
    const { deps, calls } = setup();
    await demoMain([...args, "--approve", "no"], deps);
    const { rfq, opts } = onlyCall(calls);
    assert.equal(opts.stockFault, fault, args.join(" "));
    assert.equal(rfq.id, args[1]?.toUpperCase() === "RFQ-019" ? "RFQ-019" : "RFQ-001");
  }
  for (const bad of ["flaky:1.5", "fail-first:0", "sometimes", ""]) {
    const { deps, calls, out } = setup();
    assert.equal(await demoMain(["--stock-fault", bad, "--approve", "no"], deps), 2, bad);
    assert.equal(calls.length, 0);
    assert.ok(out.text().includes(`invalid stock fault: ${bad}`));
  }
});

test("with no TTY the demo runs --scenario clean --approve no and says so in one line", async () => {
  const NO_TTY = "No TTY: running --scenario clean --approve no. Pass --scenario and --approve to choose.";
  const piped = setup({ stdinIsTTY: false, stdoutIsTTY: true });
  assert.equal(await demoMain([], piped.deps), 0);
  assert.equal(piped.out.lines()[0], NO_TTY);
  assert.equal(piped.out.lines().filter((l) => l.startsWith("No TTY")).length, 1);
  const { rfq, opts } = onlyCall(piped.calls);
  assert.deepEqual([rfq.id, opts.stockFault], ["RFQ-001", "ok"]);
  assert.ok(opts.approver !== undefined);
  assert.equal(await opts.approver(quoteOf(clean)), "decline");
  assert.ok(piped.out.lines().includes("Declined"));
  assert.ok(!piped.out.text().includes("Pick a run"), "no menu without a TTY");

  const scenario = setup({ stdinIsTTY: false, stdoutIsTTY: true, source: down });
  await demoMain(["--scenario", "stock-down"], scenario.deps);
  assert.equal(scenario.out.lines()[0], "No TTY: running --approve no. Pass --approve to choose.");

  const ask = setup({ stdinIsTTY: true, stdoutIsTTY: false });
  await demoMain(["--scenario", "clean", "--approve", "ask"], ask.deps);
  assert.equal(ask.out.lines()[0], "No TTY: running --approve no. Pass --approve to choose.");
  assert.ok(!ask.out.text().includes("[y/N]"));

  const approveOnly = setup({ stdinIsTTY: false, stdoutIsTTY: false });
  await demoMain(["--approve", "no"], approveOnly.deps);
  assert.equal(approveOnly.out.lines()[0], "No TTY: running --scenario clean. Pass --scenario to choose.");

  const chosen = setup({ stdinIsTTY: false, stdoutIsTTY: false });
  await demoMain(["--scenario", "clean", "--approve", "no"], chosen.deps);
  assert.ok(!chosen.out.text().includes("No TTY"));

  // A usage error means nothing runs, so there's no fallback to announce.
  const unknownId = setup({ stdinIsTTY: false, stdoutIsTTY: false });
  assert.equal(await demoMain(["--rfq", "RFQ-999"], unknownId.deps), 2);
  assert.equal(unknownId.calls.length, 0);
  assert.ok(unknownId.out.text().includes("Error: unknown RFQ id: RFQ-999 (not in rfqs.json)"));
  assert.ok(!unknownId.out.text().includes("No TTY"), unknownId.out.text());
});

test("with both TTYs the demo shows the menu and asks before writing", async () => {
  const pickClean = setup({ tty: true, stdin: "1\ny\n" });
  assert.equal(await demoMain([], pickClean.deps), 0);
  const text = pickClean.out.text();
  assert.ok(text.includes("  1  clean (RFQ-001)\n  2  unknown material (RFQ-019)\n  3  stock service down (RFQ-001, stock fault down)\n  or type an RFQ id\nChoice [1]: "));
  assert.ok(text.includes("Write this quote to out/outbox/RFQ-001.json for buyer@ridgeback-fixtures.example? [y/N] "));
  assert.ok(pickClean.out.lines().includes("Wrote out/outbox/RFQ-001.json"));
  assert.ok(!text.includes("No TTY"));
  assert.equal(onlyCall(pickClean.calls).rfq.id, "RFQ-001");

  const decline = setup({ tty: true, stdin: "\n\n" });
  assert.equal(await demoMain([], decline.deps), 0);
  assert.ok(decline.out.lines().includes("Declined"), "an empty answer is no");

  // Only y or yes writes, in any case; anything else declines and leaves the outbox empty.
  const outboxFiles = (d: DemoDeps): string[] => {
    assert.ok(d.outboxDir !== undefined);
    return existsSync(d.outboxDir) ? readdirSync(d.outboxDir) : [];
  };
  for (const answer of ["yes", "Y"]) {
    const typed = setup({ tty: true, stdin: `1\n${answer}\n` });
    assert.equal(await demoMain([], typed.deps), 0, answer);
    assert.ok(typed.out.lines().includes("Wrote out/outbox/RFQ-001.json"), answer);
    assert.deepEqual(outboxFiles(typed.deps), ["RFQ-001.json"], answer);
  }
  for (const answer of ["no", "yeah"]) {
    const typed = setup({ tty: true, stdin: `1\n${answer}\n` });
    assert.equal(await demoMain([], typed.deps), 0, answer);
    assert.ok(typed.out.lines().includes("Declined"), answer);
    assert.deepEqual(outboxFiles(typed.deps), [], answer);
  }

  const pickDown = setup({ tty: true, stdin: "3\n", source: down });
  await demoMain([], pickDown.deps);
  assert.deepEqual([onlyCall(pickDown.calls).rfq.id, onlyCall(pickDown.calls).opts.stockFault], ["RFQ-001", "down"]);
  assert.ok(pickDown.out.lines().includes("Held: pending stock check"));
  assert.ok(!pickDown.out.text().includes("[y/N]"), "a held quote is never offered");

  const byId = setup({ tty: true, stdin: "rfq-019\n", source: unknown });
  await demoMain(["--stock-fault", "flaky:0.3"], byId.deps);
  assert.deepEqual([onlyCall(byId.calls).rfq.id, onlyCall(byId.calls).opts.stockFault], ["RFQ-019", "flaky:0.3"]);

  const badPick = setup({ tty: true, stdin: "RFQ-404\n" });
  assert.equal(await demoMain([], badPick.deps), 2);
  assert.equal(badPick.calls.length, 0);

  const closed = setup({ tty: true, stdin: "" });
  assert.equal(await demoMain([], closed.deps), 2);
  assert.equal(closed.calls.length, 0);
});

test("--replay prints the banner first and last, needs no key and never calls runQuote", async () => {
  const { deps, out } = setup({ runQuote: noRun, keySource: "unset", rfqsPath: join(scratch, "missing.json") });
  assert.equal(await demoMain(["--replay", fixture("unknown-material.jsonl")], deps), 0);
  const lines = out.lines();
  const banner = "REPLAY of a demo run recorded 2026-11-09 18:30 UTC on claude-opus-5-5, no model called";
  assert.equal(lines[0], banner);
  assert.equal(lines.at(-1), banner);
  assert.equal(lines[1], "quote-desk-demo  RFQ-019  model claude-opus-5-5  effort medium  stock fault ok  API key: not used (replay)");
  assert.ok(lines.includes("Held: needs clarification"));
  assert.ok(!out.text().includes(ESC));

  const downReplay = setup({ runQuote: noRun });
  assert.equal(await demoMain(["--replay", fixture("stock-down.jsonl")], downReplay.deps), 0);
  assert.ok(downReplay.out.lines().includes("Held: pending stock check"));

  const missing = setup({ runQuote: noRun });
  assert.equal(await demoMain(["--replay", join(scratch, "nope.jsonl")], missing.deps), 2);
  assert.ok(missing.out.text().includes("nope.jsonl: cannot read the file (ENOENT)"));

  const mixed = setup({ runQuote: noRun });
  assert.equal(await demoMain(["--replay", fixture("clean.jsonl"), "--scenario", "clean"], mixed.deps), 2);
});

test("a bad flag, an unknown --rfq or another usage error returns 2 without running", async () => {
  const bad: string[][] = [
    ["--bogus"], ["--rfq", "RFQ-999", "--approve", "no"], ["--approve", "maybe"], ["--scenario", "dirty"],
    ["--scenario", "clean", "--rfq", "RFQ-001"], ["--effort", "extreme"], ["stray"], ["--model", ""],
    ["--rfq"], ["--record", ""],
  ];
  for (const args of bad) {
    const { deps, calls, out } = setup();
    assert.equal(await demoMain(args, deps), 2, args.join(" "));
    assert.equal(calls.length, 0, args.join(" "));
    assert.ok(out.text().includes("Usage: node bin/demo.ts"), args.join(" "));
  }
  const unknownRfq = setup();
  await demoMain(["--rfq", "RFQ-999", "--approve", "no"], unknownRfq.deps);
  assert.ok(unknownRfq.out.text().includes("Error: unknown RFQ id: RFQ-999 (not in rfqs.json)"));

  const noKey = setup({ keySource: "unset" });
  assert.equal(await demoMain(["--scenario", "clean", "--approve", "no"], noKey.deps), 2);
  assert.equal(noKey.calls.length, 0);

  const noFile = setup({ rfqsPath: join(scratch, "absent", "rfqs.json") });
  assert.equal(await demoMain(["--scenario", "clean", "--approve", "no"], noFile.deps), 2);
  assert.ok(noFile.out.text().includes("rfqs.json: cannot read the file (ENOENT)"));
  assert.ok(!noFile.out.text().includes(scratch), "no absolute path in the message");

  const help = setup();
  assert.equal(await demoMain(["--help"], help.deps), 0);
  assert.equal(help.calls.length, 0);
});

test("the model comes from --model, else a non-empty QUOTE_DESK_MODEL, else the default", async () => {
  const runs: [string[], Record<string, string | undefined>, string][] = [
    [[], { NO_COLOR: "1" }, DEFAULT_MODEL],
    [[], { NO_COLOR: "1", QUOTE_DESK_MODEL: "claude-sonnet-5-5" }, "claude-sonnet-5-5"],
    [[], { NO_COLOR: "1", QUOTE_DESK_MODEL: "  " }, DEFAULT_MODEL],
    [["--model", "claude-haiku-5-5"], { NO_COLOR: "1", QUOTE_DESK_MODEL: "claude-sonnet-5-5" }, "claude-haiku-5-5"],
  ];
  for (const [args, env, model] of runs) {
    const { deps, calls } = setup({ env });
    await demoMain(["--scenario", "clean", "--approve", "no", ...args], deps);
    assert.equal(onlyCall(calls).opts.model, model);
  }
  const effort = setup();
  await demoMain(["--scenario", "clean", "--approve", "no", "--effort", "high"], effort.deps);
  assert.equal(onlyCall(effort.calls).opts.effort, "high");
});

test("color needs a TTY stdout and no NO_COLOR at all", async () => {
  const colored = setup({ stdoutIsTTY: true, env: {} });
  await demoMain(["--scenario", "clean", "--approve", "no"], colored.deps);
  assert.ok(colored.out.text().includes(`${ESC}[`));
  for (const env of [{ NO_COLOR: "1" }, { NO_COLOR: "" }]) {
    const plain = setup({ stdoutIsTTY: true, env });
    await demoMain(["--scenario", "clean", "--approve", "no"], plain.deps);
    assert.ok(!plain.out.text().includes(ESC));
  }
  const piped = setup({ stdoutIsTTY: false, env: {} });
  await demoMain(["--scenario", "clean", "--approve", "no"], piped.deps);
  assert.ok(!piped.out.text().includes(ESC));
  assert.ok(isAscii(piped.out.text()));
});

test("a run that isn't ok exits 1", async () => {
  const started = clean.events[0];
  const finished = clean.events.at(-1);
  assert.ok(started?.type === "run_started" && finished?.type === "run_finished");
  const failed: RunQuote = async function* () {
    yield started;
    yield { ...finished, seq: 1, ok: false, failure: "max_turns", detail: null, costUsd: 0.31, delivery: "not_attempted" };
  };
  const { deps, out } = setup({ runQuote: failed });
  assert.equal(await demoMain(["--scenario", "clean", "--approve", "no"], deps), 1);
  assert.ok(out.lines().includes("Run failed: max_turns"));
  assert.equal(out.lines().at(-1), "cost $0.31 (SDK estimate)  turns 6  31.5s");

  const throws = setup({ runQuote: noRun });
  assert.equal(await demoMain(["--scenario", "clean", "--approve", "no"], throws.deps), 1);
  assert.ok(throws.out.text().includes("Run failed: runQuote must not be called"));
});

test("--record writes a demo recording that replays, with the outbox file's sha256", async () => {
  const path = join(scratch, "rec", "demo-clean.jsonl");
  const { deps, out } = setup();
  assert.equal(await demoMain(["--scenario", "clean", "--approve", "yes", "--record", path], deps), 0);
  assert.ok(out.lines().includes(`Recorded ${path}`));
  const rec = readRecording(path);
  assert.deepEqual([rec.header.kind, rec.header.rfqId, rec.header.caseId, rec.header.trial, rec.header.gitSha,
    rec.header.stockFault], ["demo", "RFQ-001", null, null, null, "ok"]);
  assert.ok(rec.events.some((e) => e.type === "delivery" && e.outcome === "sent"));
  assert.deepEqual(rec.outbox, [{ name: "RFQ-001.json", sha256: sha256Hex(serializeQuote(quoteOf(clean))) }]);

  const again = setup({ runQuote: noRun });
  assert.equal(await demoMain(["--replay", path], again.deps), 0);
  assert.ok(again.out.lines().includes("Wrote out/outbox/RFQ-001.json"));

  const declined = join(scratch, "rec", "declined.jsonl");
  const second = setup();
  await demoMain(["--scenario", "clean", "--approve", "no", "--record", declined], second.deps);
  assert.deepEqual(readRecording(declined).outbox, []);
});
