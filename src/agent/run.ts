// runQuote (spec 5.9): one RFQ in, a stream of desk events out. It never throws. The real `query`
// arrives through RunQuoteDeps; only src/index.ts imports it.
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { CATALOG_SERVER, DEFAULT_EFFORT, DEFAULT_FAULT_SEED, DEFAULT_MODEL, LIMITS, QuoteDraftSchema,
  RFQ_ID_PATTERN, STOCK_DELAY_MS, parseStockFault } from "../contracts.ts";
import type { ApproveAndSend, Catalog, Delivery, DeskEvent, DeskEventBody, FailureReason, FinalizeQuote, Quote,
  QuoteDraft, Rfq, RunOptions, RunQuote, TokenUsage } from "../contracts.ts";
import { fileHash } from "../load.ts";
import { PATHS } from "../paths.ts";
import { createEventMapper, createRunScrubber } from "./events.ts";
import { createGuards } from "./guards.ts";
import { buildOptions, childEnv } from "./options.ts";
import { PROMPT_HASH, buildUserPrompt } from "./prompt.ts";

export type RunQuoteDeps = {
  query: (p: { prompt: string; options: Options }) => AsyncIterable<SDKMessage>;
  finalizeQuote: FinalizeQuote;
  approveAndSend: ApproveAndSend;
  loadCatalog: (path?: string) => Catalog;
  env: Record<string, string | undefined>; // base env for childEnv(); src/index.ts passes process.env
};

const STDERR_TAIL_MAX = 4096;
const STDERR_BUFFER_MAX = STDERR_TAIL_MAX + 1024;
const RESULT_TEXT_MAX = 500;
/** How long finally waits for the query stream to close (the SDK's return() waits for the CLI to exit). */
export const STREAM_CLOSE_WAIT_MS = 3000;

type Scrub = (s: string) => string;

/** The model-written free text in a draft, scrubbed. Ids, part numbers and material codes stay as written. */
function scrubDraft(d: QuoteDraft, scrub: Scrub): QuoteDraft {
  return { ...d, assumptions: d.assumptions.map(scrub),
    openQuestions: d.openQuestions.map((q) => ({ ...q, question: scrub(q.question) })) };
}

/** Waits for p, but no longer than ms. Never rejects. */
async function settleWithin(p: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); });
  try {
    await Promise.race([p.then(() => {}, () => {}), bound]);
  } finally {
    clearTimeout(timer);
  }
}

type Rec = Record<string, unknown>;
function rec(x: unknown): Rec | null {
  return x !== null && typeof x === "object" && !Array.isArray(x) ? (x as Rec) : null;
}
function num(x: unknown): number | null {
  return typeof x === "number" && Number.isFinite(x) ? x : null;
}
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

type Outcome = { draft: QuoteDraft } | { failure: FailureReason; detail: string | null };

/** Step 6: what the kept result message means. The first match wins. */
function classifyResult(r: Rec, lastAssistantError: string | null, refusalNoFallback: boolean, scrub: Scrub):
  Outcome {
  const subtype = r["subtype"];
  const errors = Array.isArray(r["errors"]) ? r["errors"].map(String).join("; ") : "";
  const errorsDetail = errors === "" ? null : scrub(errors);
  switch (subtype) {
    case "success": {
      const text = typeof r["result"] === "string" ? r["result"] : "";
      if (r["is_error"] === true) {
        const status = r["api_error_status"];
        let detail = `api ${typeof status === "number" ? status : "unknown"}: ${scrub(text)}`;
        if (lastAssistantError !== null) detail += `; assistant error: ${lastAssistantError}`;
        return { failure: "sdk_error", detail };
      }
      const output = r["structured_output"];
      if (output !== undefined && output !== null) {
        const parsed = QuoteDraftSchema.safeParse(output);
        if (parsed.success) return { draft: parsed.data };
        const issues = parsed.error.issues.slice(0, 3)
          .map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`);
        return { failure: "invalid_draft", detail: scrub(issues.join("; ")) };
      }
      const said = text.trim() === "" ? null : scrub(text).slice(0, RESULT_TEXT_MAX);
      return { failure: refusalNoFallback ? "refusal" : "no_structured_output", detail: said };
    }
    case "error_max_turns": return { failure: "max_turns", detail: errorsDetail };
    case "error_max_budget_usd": return { failure: "budget", detail: errorsDetail };
    case "error_max_structured_output_retries": return { failure: "structured_output", detail: errorsDetail };
    case "error_during_execution": return { failure: "sdk_error", detail: errorsDetail };
    default: return { failure: "sdk_error", detail: `unknown result subtype: ${String(subtype)}` };
  }
}

/** usage summed over every modelUsage entry, Haiku side calls included; null without a record. */
function sumUsage(modelUsage: unknown): TokenUsage | null {
  const all = rec(modelUsage);
  if (all === null) return null;
  const u: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
  for (const entry of Object.values(all)) {
    const e = rec(entry);
    if (e === null) continue;
    u.inputTokens += num(e["inputTokens"]) ?? 0;
    u.outputTokens += num(e["outputTokens"]) ?? 0;
    u.cacheReadInputTokens += num(e["cacheReadInputTokens"]) ?? 0;
    u.cacheCreationInputTokens += num(e["cacheCreationInputTokens"]) ?? 0;
  }
  return u;
}

export function createRunQuote(deps: RunQuoteDeps): RunQuote {
  return (rfq: Rfq, opts?: RunOptions) => runOne(deps, rfq, opts ?? {});
}

async function* runOne(deps: RunQuoteDeps, rfq: Rfq, opts: RunOptions): AsyncGenerator<DeskEvent, void, undefined> {
  // ---- step 1: defaults and option checks
  const runId = randomUUID();
  const t0 = performance.now();
  const elapsed = (): number => Math.max(0, Math.round(performance.now() - t0));
  let seq = 0;
  const stamp = (body: DeskEventBody): DeskEvent => ({ v: 1, runId, seq: seq++, t: elapsed(), ...body });

  const model = opts.model ?? DEFAULT_MODEL;
  const effort = opts.effort ?? DEFAULT_EFFORT;
  const stockFault = opts.stockFault ?? "ok";
  const faultSeed = opts.faultSeed ?? DEFAULT_FAULT_SEED;
  const stockDelayMs = opts.stockDelayMs ?? STOCK_DELAY_MS.demo;
  const catalogPath = opts.catalogPath ?? PATHS.catalog;
  const outboxDir = opts.outboxDir ?? PATHS.outbox;
  const maxTurns = opts.maxTurns ?? LIMITS.maxTurns;
  const maxBudgetUsd = opts.maxBudgetUsd ?? LIMITS.maxBudgetUsd;
  const wallClockMs = opts.wallClockMs ?? LIMITS.wallClockMs;
  // The dropped names don't depend on configDir; step 2 builds the real env.
  const droppedEnvNames = childEnv(deps.env, "").dropped;
  // This run's scrubber also removes the literal API key. The value stays inside the closure.
  const scrub = createRunScrubber(deps.env["ANTHROPIC_API_KEY"]);

  const started = (catalogHash: string): DeskEventBody => ({ type: "run_started", rfqId: rfq.id, model, effort,
    stockFault, faultSeed, promptHash: PROMPT_HASH, catalogHash, droppedEnvNames });
  type Finish = { ok: boolean; failure: FailureReason | null; detail: string | null; costUsd: number | null;
    usage: TokenUsage | null; modelsUsed: string[]; effortApplied: string | null; turns: number | null;
    delivery: Delivery };
  const finished = (f: Finish): DeskEventBody => ({ type: "run_finished", ...f, durationMs: elapsed() });

  let catalog: Catalog;
  let catalogHash: string;
  try {
    // The id names the outbox file and the recording, so it must be a plain file name.
    if (!RFQ_ID_PATTERN.test(rfq.id)) {
      throw new Error(`the RFQ id is not a plain file name: ${JSON.stringify(rfq.id.slice(0, 80))}`);
    }
    parseStockFault(stockFault);
    // The server's flag parser refuses anything else, which would end the run as mcp_unavailable instead.
    if (!Number.isSafeInteger(faultSeed)) throw new Error(`faultSeed must be a safe integer, got ${faultSeed}`);
    if (!Number.isInteger(stockDelayMs)) throw new Error(`stockDelayMs must be a whole number, got ${stockDelayMs}`);
    if (!(stockDelayMs >= 0 && stockDelayMs <= STOCK_DELAY_MS.max)) {
      throw new Error(`stockDelayMs must be 0 to ${STOCK_DELAY_MS.max}, got ${stockDelayMs}`);
    }
    catalog = deps.loadCatalog(catalogPath);
    catalogHash = fileHash(catalogPath);
  } catch (err) {
    yield stamp(started(""));
    yield stamp(finished({ ok: false, failure: "invalid_options", detail: scrub(messageOf(err)), costUsd: null,
      usage: null, modelsUsed: [], effortApplied: null, turns: null, delivery: "not_attempted" }));
    return;
  }
  yield stamp(started(catalogHash));

  // ---- steps 2 and 3: work dir, guards, options, abort wiring
  const queue: DeskEventBody[] = [];
  const guards = createGuards(catalog, (e) => { queue.push(e); });
  const mapper = createEventMapper({ scrub });
  let stderrTail = "";
  // The buffer keeps a margin past the 4 KB tail, so a key cut at the buffer's head is scrubbed out of the
  // margin and never reaches the tail that's kept.
  const onStderr = (data: string): void => { stderrTail = (stderrTail + data).slice(-STDERR_BUFFER_MAX); };

  const controller = new AbortController();
  // Set only by the timer or the caller's signal. The mcp_unavailable path aborts the controller directly,
  // so it never reads as one of these.
  let abortedBy: "wall_clock" | "aborted" | null = null;
  const abortFor = (cause: "wall_clock" | "aborted"): void => {
    if (controller.signal.aborted) return;
    abortedBy = cause;
    controller.abort();
  };
  const onCallerAbort = (): void => abortFor("aborted");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let workDir: string | null = null;
  let iterator: AsyncIterator<SDKMessage> | null = null;
  let streamDone = false;
  let gate: AsyncGenerator<DeskEventBody, Delivery, undefined> | null = null;
  let gateDone = false;
  let finishedYielded = false;

  let result: Rec | null = null;
  let mcpStatus: string | null = null;
  let refusalNoFallback = false;
  let threw = false;
  let thrown: unknown;

  try {
    // ---- step 4: the query stream
    try {
      workDir = mkdtempSync(join(tmpdir(), "quote-desk-"));
      const configDir = join(workDir, "config");
      mkdirSync(configDir);
      const options = buildOptions({ model, effort, stockFault, faultSeed, stockDelayMs, catalogPath, workDir,
        env: childEnv(deps.env, configDir).env, maxTurns, maxBudgetUsd, abortController: controller,
        canUseTool: guards.canUseTool, hooks: guards.hooks, onStderr });
      if (opts.signal !== undefined) {
        if (opts.signal.aborted) abortFor("aborted");
        else opts.signal.addEventListener("abort", onCallerAbort, { once: true });
      }
      timer = setTimeout(() => abortFor("wall_clock"), wallClockMs);
      // Races each next() so the wall clock holds even when the stream ignores the abort.
      const abortSeen = new Promise<"abort">((resolve) => {
        if (controller.signal.aborted) resolve("abort");
        else controller.signal.addEventListener("abort", () => resolve("abort"), { once: true });
      });
      if (!controller.signal.aborted) {
        iterator = deps.query({ prompt: buildUserPrompt(rfq, opts.answers), options })[Symbol.asyncIterator]();
        for (;;) {
          const next = iterator.next();
          next.catch(() => {}); // a rejection after an abort has nobody waiting for it
          const step = await Promise.race([next, abortSeen]);
          if (step === "abort") break;
          if (step.done === true) {
            streamDone = true;
            break;
          }
          for (const e of queue.splice(0)) yield stamp(e);
          const msg = rec(step.value);
          const bodies = mapper.map(step.value);
          if (msg !== null && msg["type"] === "system" && msg["subtype"] === "init") {
            const servers = Array.isArray(msg["mcp_servers"]) ? msg["mcp_servers"].map(rec) : [];
            const status = servers.find((s) => s !== null && s["name"] === CATALOG_SERVER)?.["status"];
            if (status !== "connected") {
              mcpStatus = typeof status === "string" ? status : "missing";
              controller.abort();
            }
          }
          if (msg !== null && msg["type"] === "result") result = msg;
          for (const b of bodies) {
            if (b.type === "model_refusal" && !b.fallback) refusalNoFallback = true;
            yield stamp(b);
          }
        }
      }
    } catch (err) {
      // The SDK throws after an error result or an is_error success (A10, A22); the kept result decides.
      threw = true;
      thrown = err;
    }
    clearTimeout(timer);
    timer = undefined;
    opts.signal?.removeEventListener("abort", onCallerAbort);
    for (const e of queue.splice(0)) yield stamp(e);

    // ---- step 5: classify
    let outcome: Outcome;
    if (abortedBy === "wall_clock") {
      outcome = { failure: "wall_clock", detail: `wall clock limit of ${wallClockMs} ms reached` };
    } else if (abortedBy === "aborted") {
      outcome = { failure: "aborted", detail: "aborted by the caller" };
    } else if (mcpStatus !== null) {
      outcome = { failure: "mcp_unavailable", detail: `catalog server status: ${mcpStatus}` };
    } else if (result !== null) {
      outcome = classifyResult(result, mapper.lastAssistantError(), refusalNoFallback, scrub);
    } else {
      const parts = [threw ? scrub(messageOf(thrown)) : "the stream ended without a result"];
      const code = mapper.lastAssistantError();
      if (code !== null) parts.push(`assistant error: ${code}`);
      if (stderrTail.trim() !== "") parts.push(`stderr: ${scrub(stderrTail).slice(-STDERR_TAIL_MAX)}`);
      outcome = { failure: "sdk_error", detail: parts.join("; ") };
    }

    // ---- step 7: finalize and the gate
    let failure: FailureReason | null = null;
    let detail: string | null = null;
    let quote: Quote | null = null;
    let delivery: Delivery = "not_attempted";
    if ("draft" in outcome) {
      try {
        quote = deps.finalizeQuote(scrubDraft(outcome.draft, scrub), { rfq, marginPct: catalog.marginPct, runId, model, effort,
          promptHash: PROMPT_HASH, catalogHash, createdAt: new Date().toISOString() });
      } catch (err) {
        failure = "sdk_error";
        detail = `finalize: ${scrub(messageOf(err))}`;
      }
      if (quote !== null) {
        yield stamp({ type: "quote", quote });
        try {
          gate = deps.approveAndSend(quote, opts.approver, outboxDir);
          let step = await gate.next();
          while (step.done !== true) {
            yield stamp(step.value);
            step = await gate.next();
          }
          gateDone = true;
          delivery = step.value;
        } catch (err) {
          gateDone = true;
          failure = "sdk_error";
          detail = `approve and send: ${scrub(messageOf(err))}`;
          delivery = "not_attempted";
        }
      }
    } else {
      failure = outcome.failure;
      detail = outcome.detail;
    }

    // ---- step 8: run_finished
    for (const e of queue.splice(0)) yield stamp(e);
    const modelUsage = rec(result?.["modelUsage"]);
    const body = finished({
      ok: quote !== null && failure === null,
      failure, detail,
      costUsd: result === null ? null : num(result["total_cost_usd"]),
      usage: result === null ? null : sumUsage(modelUsage),
      modelsUsed: modelUsage === null ? [] : Object.keys(modelUsage),
      effortApplied: guards.effortApplied(),
      turns: result === null ? null : num(result["num_turns"]),
      delivery,
    });
    finishedYielded = true;
    yield stamp(body);
  } catch (err) {
    // A bug in this file, never an SDK outcome. The run still ends with exactly one run_finished.
    if (!finishedYielded) {
      finishedYielded = true;
      yield stamp(finished({ ok: false, failure: "sdk_error", detail: `internal: ${scrub(messageOf(err))}`,
        costUsd: null, usage: null, modelsUsed: [], effortApplied: guards.effortApplied(), turns: null,
        delivery: "not_attempted" }));
    }
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onCallerAbort);
    if (iterator !== null && !streamDone) {
      // An abort, a throw or a consumer that stopped early: stop the CLI so it can't keep spending, and give it
      // time to exit, since Windows won't remove a dir that a live process has as its cwd. A stream that never
      // settles gets STREAM_CLOSE_WAIT_MS and no more.
      if (!controller.signal.aborted) controller.abort();
      let closing: Promise<unknown> = Promise.resolve();
      try {
        closing = iterator.return?.() ?? Promise.resolve();
      } catch {
        // a return() that throws has nothing left to wait for
      }
      await settleWithin(closing, STREAM_CLOSE_WAIT_MS);
    }
    if (gate !== null && !gateDone) {
      try {
        await gate.return("not_attempted");
      } catch {
        // the gate's own cleanup failed; nothing left to report to
      }
    }
    if (workDir !== null) {
      try {
        // Async, so the retries don't block the timers the SDK uses to end the child.
        await rm(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch {
        // a leftover temp dir is harmless
      }
    }
  }
}
