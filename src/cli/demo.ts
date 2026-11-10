// The demo CLI: pick an RFQ, run the desk on it, render every event, and ask before anything is
// written to the outbox. Everything it touches comes in through DemoDeps, so tests drive it with a
// fake runQuote and plain streams, and nothing here reads process state.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { Interface } from "node:readline";
import { parseArgs } from "node:util";
import { DEFAULT_EFFORT, DEFAULT_MODEL, STOCK_DELAY_MS, formatStockFault, parseStockFault } from "../contracts.ts";
import type { Approver, DeskEvent, Effort, KeySource, OutboxFile, Recording, Rfq, RunOptions, RunQuote }
  from "../contracts.ts";
import { loadRfqs } from "../load.ts";
import { PATHS } from "../paths.ts";
import { headerFromEvents, readRecording, writeRecording } from "../recording.ts";
import { asciiText, renderEvent, renderHeader } from "./render.ts";

export type DemoDeps = { runQuote: RunQuote; stdin: NodeJS.ReadableStream; stdout: NodeJS.WritableStream;
  stdinIsTTY: boolean; stdoutIsTTY: boolean; env: Record<string, string | undefined>; keySource: KeySource;
  rfqsPath?: string | undefined; outboxDir?: string | undefined };

type ScenarioName = "clean" | "unknown-material" | "stock-down";
const SCENARIOS: Record<ScenarioName, { rfqId: string; stockFault: string; label: string }> = {
  clean: { rfqId: "RFQ-001", stockFault: "ok", label: "clean" },
  "unknown-material": { rfqId: "RFQ-019", stockFault: "ok", label: "unknown material" },
  "stock-down": { rfqId: "RFQ-001", stockFault: "down", label: "stock service down" },
};
const SCENARIO_NAMES = Object.keys(SCENARIOS) as ScenarioName[];
const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];
const APPROVE_MODES = ["ask", "yes", "no"] as const;
type ApproveMode = (typeof APPROVE_MODES)[number];

const USAGE = "Usage: node bin/demo.ts [--scenario clean|unknown-material|stock-down | --rfq <id>] " +
  "[--stock-fault <spec>] [--approve ask|yes|no] [--model <id>] [--effort low|medium|high|xhigh|max] " +
  "[--record <path>]\n       node bin/demo.ts --replay <path>";

function isScenario(s: string): s is ScenarioName {
  return (SCENARIO_NAMES as string[]).includes(s);
}
function isEffort(s: string): s is Effort {
  return (EFFORTS as readonly string[]).includes(s);
}
function isApproveMode(s: string): s is ApproveMode {
  return (APPROVE_MODES as readonly string[]).includes(s);
}

/** Reads stdin one line at a time, opened only when something asks, closed by the caller. */
class LineReader {
  private rl: Interface | undefined;
  private lines: AsyncIterator<string> | undefined;
  private readonly input: NodeJS.ReadableStream;
  constructor(input: NodeJS.ReadableStream) {
    this.input = input;
  }
  async next(): Promise<string | null> {
    if (this.lines === undefined) {
      this.rl = createInterface({ input: this.input, terminal: false, crlfDelay: Infinity });
      this.lines = this.rl[Symbol.asyncIterator]();
    }
    const r = await this.lines.next();
    return r.done === true ? null : r.value;
  }
  close(): void {
    this.rl?.close();
  }
}

/** Runs the demo and returns the exit code: 0 a quote was produced, 1 the run wasn't ok, 2 a usage error. */
export async function demoMain(argv: string[], deps: DemoDeps): Promise<number> {
  const out = (lines: string[]): void => {
    if (lines.length > 0) deps.stdout.write(lines.join("\n") + "\n");
  };
  const usageError = (message: string): number => {
    out([`Error: ${asciiText(message)}`, USAGE]);
    return 2;
  };
  // NO_COLOR counts as set whatever its value, so color needs a TTY and no NO_COLOR at all.
  const o = { color: deps.stdoutIsTTY && deps.env["NO_COLOR"] === undefined };

  let flags: { scenario?: string | undefined; rfq?: string | undefined; "stock-fault"?: string | undefined;
    approve?: string | undefined; model?: string | undefined; effort?: string | undefined;
    record?: string | undefined; replay?: string | undefined; help?: boolean | undefined };
  try {
    flags = parseArgs({ args: argv, strict: true, allowPositionals: false, options: {
      scenario: { type: "string" }, rfq: { type: "string" }, "stock-fault": { type: "string" },
      approve: { type: "string" }, model: { type: "string" }, effort: { type: "string" },
      record: { type: "string" }, replay: { type: "string" }, help: { type: "boolean", short: "h" },
    } }).values;
  } catch (err) {
    return usageError((err as Error).message);
  }
  if (flags.help === true) {
    out([USAGE]);
    return 0;
  }

  if (flags.replay !== undefined) {
    const others = (["scenario", "rfq", "stock-fault", "approve", "model", "effort", "record"] as const)
      .filter((k) => flags[k] !== undefined);
    if (others.length > 0) return usageError(`--replay takes no other flags (got --${others.join(", --")})`);
    if (flags.replay === "") return usageError("--replay needs a path");
    return replay(flags.replay, o, out);
  }

  if (flags.scenario !== undefined && !isScenario(flags.scenario)) {
    return usageError(`unknown scenario: ${flags.scenario} (use ${SCENARIO_NAMES.join(", ")})`);
  }
  if (flags.scenario !== undefined && flags.rfq !== undefined) return usageError("pass --scenario or --rfq, not both");
  if (flags.rfq !== undefined && flags.rfq.trim() === "") return usageError("--rfq needs an RFQ id");
  if (flags.approve !== undefined && !isApproveMode(flags.approve)) {
    return usageError(`--approve takes ask, yes or no (got ${flags.approve})`);
  }
  if (flags.effort !== undefined && !isEffort(flags.effort)) {
    return usageError(`--effort takes ${EFFORTS.join(", ")} (got ${flags.effort})`);
  }
  if (flags.model !== undefined && flags.model.trim() === "") return usageError("--model needs a model id");
  if (flags.record !== undefined && flags.record === "") return usageError("--record needs a path");
  let flagFault: string | undefined;
  if (flags["stock-fault"] !== undefined) {
    try {
      flagFault = formatStockFault(parseStockFault(flags["stock-fault"]));
    } catch (err) {
      return usageError((err as Error).message);
    }
  }
  if (deps.keySource === "unset") {
    return usageError("no API key: put ANTHROPIC_API_KEY in .env or set it in the environment");
  }

  const rfqsPath = deps.rfqsPath ?? PATHS.rfqs;
  let rfqs: Rfq[];
  try {
    rfqs = loadRfqs(rfqsPath);
  } catch (err) {
    out([`Error: ${asciiText((err as Error).message)}`]);
    return 2;
  }
  const findRfq = (id: string): Rfq | undefined => rfqs.find((r) => r.id.toUpperCase() === id.trim().toUpperCase());

  const reader = new LineReader(deps.stdin);
  try {
    const tty = deps.stdinIsTTY && deps.stdoutIsTTY;
    const fallback: string[] = []; // the flags a missing TTY chose, for the one "No TTY" line
    let rfqId: string;
    let scenarioFault: string | undefined;

    if (flags.scenario !== undefined && isScenario(flags.scenario)) {
      ({ rfqId, stockFault: scenarioFault } = SCENARIOS[flags.scenario]);
    } else if (flags.rfq !== undefined) {
      rfqId = flags.rfq;
    } else if (tty) {
      const picked = await menu(reader, deps, out);
      if (picked === null) return usageError("no choice made");
      if (isScenario(picked)) ({ rfqId, stockFault: scenarioFault } = SCENARIOS[picked]);
      else rfqId = picked;
    } else {
      ({ rfqId, stockFault: scenarioFault } = SCENARIOS.clean);
      fallback.push("--scenario clean");
    }

    // Look the RFQ up before the No TTY line, so a usage error doesn't announce a run that never happens.
    const rfq = findRfq(rfqId);
    if (rfq === undefined) return usageError(`unknown RFQ id: ${rfqId} (not in ${basename(rfqsPath)})`);

    let approve: ApproveMode;
    if (flags.approve !== undefined && isApproveMode(flags.approve)) approve = flags.approve;
    else approve = tty ? "ask" : "no";
    if (approve === "ask" && !tty) approve = "no";
    if (!tty && flags.approve !== "yes" && flags.approve !== "no") fallback.push("--approve no");
    if (fallback.length > 0) {
      const names = fallback.map((f) => f.split(" ")[0] ?? f);
      out([`No TTY: running ${fallback.join(" ")}. Pass ${names.join(" and ")} to choose.`]);
    }

    const envModel = deps.env["QUOTE_DESK_MODEL"]?.trim();
    const model = flags.model?.trim() ?? (envModel !== undefined && envModel !== "" ? envModel : DEFAULT_MODEL);
    const effort: Effort = flags.effort !== undefined && isEffort(flags.effort) ? flags.effort : DEFAULT_EFFORT;
    const outboxDir = deps.outboxDir ?? PATHS.outbox;
    const opts: RunOptions = { model, effort, stockFault: flagFault ?? scenarioFault ?? "ok",
      stockDelayMs: STOCK_DELAY_MS.demo, approver: makeApprover(approve, rfq, reader, deps), outboxDir };

    const events: DeskEvent[] = [];
    let crashed = false;
    try {
      for await (const e of deps.runQuote(rfq, opts)) {
        events.push(e);
        out(e.type === "run_started" ? [renderHeader(e, deps.keySource, o)] : renderEvent(e, o));
      }
    } catch (err) {
      // runQuote promises never to throw; if it does anyway, say so and keep what arrived.
      crashed = true;
      out([`Run failed: ${asciiText((err as Error).message ?? String(err))}`]);
    }

    let code = exitCode(events);
    if (crashed) code = 1;
    if (flags.record !== undefined) {
      const recorded = record(flags.record, events, outboxDir);
      out([recorded.message]);
      if (!recorded.ok) code = code === 0 ? 1 : code;
    }
    return code;
  } finally {
    reader.close();
  }
}

/** 0 when a quote arrived and the run finished ok, else 1. */
function exitCode(events: DeskEvent[]): number {
  const finished = events.findLast((e) => e.type === "run_finished");
  const quoted = events.some((e) => e.type === "quote");
  return quoted && finished !== undefined && finished.type === "run_finished" && finished.ok ? 0 : 1;
}

/** Writes a prompt with no newline and reads one answer. null means stdin ended. */
async function ask(reader: LineReader, stdout: NodeJS.WritableStream, prompt: string): Promise<string | null> {
  stdout.write(prompt);
  const answer = await reader.next();
  if (answer === null) stdout.write("\n");
  return answer;
}

/** The TTY menu. Returns a scenario name or an RFQ id as typed, or null when stdin ends. */
async function menu(reader: LineReader, deps: DemoDeps, out: (lines: string[]) => void): Promise<string | null> {
  out(["Pick a run:", ...SCENARIO_NAMES.map((name, i) => {
    const s = SCENARIOS[name];
    const fault = s.stockFault === "ok" ? "" : `, stock fault ${s.stockFault}`;
    return `  ${i + 1}  ${s.label} (${s.rfqId}${fault})`;
  }), "  or type an RFQ id"]);
  const answer = await ask(reader, deps.stdout, "Choice [1]: ");
  if (answer === null) return null;
  const t = answer.trim();
  if (t === "") return "clean";
  const byNumber = /^[0-9]+$/.test(t) ? SCENARIO_NAMES[Number(t) - 1] : undefined;
  return byNumber ?? t;
}

function makeApprover(mode: ApproveMode, rfq: Rfq, reader: LineReader, deps: DemoDeps): Approver {
  if (mode === "yes") return async () => "approve";
  if (mode === "no") return async () => "decline";
  return async (quote) => {
    // The quote event has already printed the table, so the approver only asks.
    const answer = await ask(reader, deps.stdout,
      asciiText(`Write this quote to out/outbox/${quote.rfqId}.json for ${rfq.contactEmail}? [y/N]`) + " ");
    const a = (answer ?? "").trim().toLowerCase();
    return a === "y" || a === "yes" ? "approve" : "decline";
  };
}

function record(path: string, events: DeskEvent[], outboxDir: string): { ok: boolean; message: string } {
  if (!events.some((e) => e.type === "run_started")) return { ok: false, message: "Not recorded: the run never started" };
  const outbox: OutboxFile[] = [];
  for (const e of events) {
    if (e.type !== "delivery" || e.outcome !== "sent" || e.file === null) continue;
    try {
      outbox.push({ name: e.file, sha256: createHash("sha256").update(readFileSync(join(outboxDir, e.file))).digest("hex") });
    } catch {
      // The gate said it wrote the file but it can't be read back; the recording lists only what exists.
    }
  }
  try {
    // gitSha stays null: the demo never shells out to git.
    const header = headerFromEvents(events, { kind: "demo", caseId: null, trial: null, gitSha: null,
      recordedAt: new Date().toISOString() });
    writeRecording(resolve(path), { header, events, outbox });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { ok: false, message: `Not recorded: ${code ?? asciiText((err as Error).message)}` };
  }
  return { ok: true, message: asciiText(`Recorded ${path}`) };
}

function recordedWhen(iso: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(iso);
  return m === null ? asciiText(iso) : `${m[1]} ${m[2]} UTC`;
}

/** Re-renders a recording. Needs no key, no RFQ file and no model; runQuote is never called. */
function replay(path: string, o: { color: boolean }, out: (lines: string[]) => void): number {
  let rec: Recording;
  try {
    rec = readRecording(resolve(path));
  } catch (err) {
    out([`Error: ${asciiText((err as Error).message)}`]);
    return 2;
  }
  const banner = asciiText(`REPLAY of a demo run recorded ${recordedWhen(rec.header.recordedAt)} on ` +
    `${rec.header.model}, no model called`);
  out([banner]);
  for (const e of rec.events) {
    out(e.type === "run_started" ? [renderHeader(e, "not used (replay)", o)] : renderEvent(e, o));
  }
  out([banner]);
  return exitCode(rec.events);
}
