// The seams between the slices, end to end: the real createRunQuote, guards, event mapper, finalizeQuote,
// approveAndSend, tool handlers, runEval and scorers, with the scripted agent in place of the SDK's query().
// Mini fixtures only (test/fixtures/mini and test/fixtures/eval/cases-mini.json). No model, no network, no
// git: gitSha is injected and keySource is a plain string. Every file goes to a temp dir that is removed.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { describe, test } from "node:test";
import { CATALOG_SERVER, expectedStock, parseStockFault, stockLineKey } from "../src/contracts.ts";
import type { DeskEvent, KeySource, Rfq, RunOptions, RunQuote, RunnerResult } from "../src/contracts.ts";
import { createRunQuote } from "../src/agent/run.ts";
import { PROMPT_HASH } from "../src/agent/prompt.ts";
import { loadCatalog, loadRfqs, loadTruth } from "../src/load.ts";
import { parseServerFlags } from "../src/mcp/stdio.ts";
import { PATHS } from "../src/paths.ts";
import { finalizeQuote } from "../src/quote/finalize.ts";
import { approveAndSend } from "../src/quote/gate.ts";
import { readRecording } from "../src/recording.ts";
import { runEval } from "../eval/runner.ts";
import { scriptedAgent } from "./helpers/scripted-agent.ts";
import type { Behavior, ScriptedAgent } from "./helpers/scripted-agent.ts";

const MINI_CATALOG = join(PATHS.miniDir, "catalog.json");
const CASES_MINI = join(PATHS.root, "test", "fixtures", "eval", "cases-mini.json");
const truth = new Map(loadTruth(join(PATHS.miniDir, "rfq-truth.json")).map((t) => [t.rfqId, t]));
const rfqs = new Map(loadRfqs(join(PATHS.miniDir, "rfqs.json")).map((r) => [r.id, r]));
// A placeholder key (never a real one) so the init message reports API-key auth, and one CLAUDE* name the
// child env scrub has to drop.
const BASE_ENV: Record<string, string | undefined> = { ANTHROPIC_API_KEY: "placeholder-not-a-key",
  CLAUDE_CODE_ENTRYPOINT: "x", PATH: "" };

function rfqOf(id: string): Rfq {
  const r = rfqs.get(id);
  if (r === undefined) throw new Error(`no mini RFQ ${id}`);
  return r;
}

function runQuoteFor(agent: ScriptedAgent): RunQuote {
  return createRunQuote({ query: agent.query, finalizeQuote, approveAndSend, loadCatalog, env: BASE_ENV });
}

/** The same runQuote with some run options changed, the way a caller other than the runner could pass them. */
function withOptions(inner: RunQuote, change: (o: RunOptions) => RunOptions): RunQuote {
  return (rfq, opts) => inner(rfq, change(opts ?? {}));
}

async function collect(run: AsyncIterable<DeskEvent>): Promise<DeskEvent[]> {
  const out: DeskEvent[] = [];
  for await (const e of run) out.push(e);
  return out;
}

function finishedOf(events: readonly DeskEvent[]): Extract<DeskEvent, { type: "run_finished" }> {
  const last = events[events.length - 1];
  assert.ok(last !== undefined && last.type === "run_finished", "the run ends with run_finished");
  return last;
}

async function withTemp(fn: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "qd-int-"));
  try {
    await fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

type EvalRun = { code: number; text: string; resultsDir: string; runDir: string | null; summary: RunnerResult | null };

/** One runEval over the mini cases, with its own results and recordings dirs under root. */
async function evalRun(root: string, label: string, argv: string[], runQuote: RunQuote | null,
  keySource: KeySource = "environment"): Promise<EvalRun> {
  const resultsDir = join(root, label, "results");
  let text = "";
  const stdout = new Writable({ write(chunk, _encoding, done) {
    text += String(chunk);
    done();
  } });
  const code = await runEval(argv, { runQuote, promptHash: PROMPT_HASH, env: {}, keySource, stdout,
    now: () => new Date(), confirm: async () => true, gitSha: () => "abc1234",
    paths: { cases: CASES_MINI, catalog: MINI_CATALOG, resultsDir, recordingsDir: join(root, label, "recordings") } });
  const runs = existsSync(resultsDir) ? readdirSync(resultsDir).filter((d) => /^\d{8}-\d{6}/.test(d)) : [];
  assert.ok(runs.length <= 1, `at most one live run dir, found ${runs.join(", ")}`);
  const runDir = runs[0] === undefined ? null : join(resultsDir, runs[0]);
  const summary = runDir === null ? null
    : JSON.parse(readFileSync(join(runDir, "summary.json"), "utf8")) as RunnerResult;
  return { code, text, resultsDir, runDir, summary };
}

function verdicts(r: RunnerResult): Record<string, string> {
  return Object.fromEntries(r.cases.map((c) => [c.caseId, c.verdict]));
}

function failedChecks(r: RunnerResult, caseId: string): { kind: string; detail: string }[] {
  const c = r.cases.find((x) => x.caseId === caseId);
  assert.ok(c !== undefined, `${caseId} is in the summary`);
  return c.trials.flatMap((t) => t.checks.filter((ch) => !ch.pass).map((ch) => ({ kind: ch.kind, detail: ch.detail })));
}

describe("the ideal scripted agent over the mini cases", () => {
  test("passes every mini case with exit 0, and a replay of that run gives the same verdicts", async () => {
    await withTemp(async (root) => {
      const agent = scriptedAgent("ideal", truth);
      const live = await evalRun(root, "live", ["--yes"], runQuoteFor(agent));
      assert.equal(live.code, 0, live.text);
      assert.ok(live.summary !== null && live.runDir !== null, "the live run wrote a summary");
      const summary = live.summary;
      assert.equal(summary.cases.length, 10);
      for (const c of summary.cases) {
        assert.equal(c.verdict, "pass", `${c.caseId}: ${JSON.stringify(failedChecks(summary, c.caseId))}`);
      }
      assert.equal(summary.totals.pass, 10);
      assert.equal(summary.gitSha, "abc1234");
      assert.equal(agent.seen.length, 10);
      for (const s of agent.seen) assert.deepEqual(s.problems, [], "the options a real CLI would get are as built");
      // Each trial names its recording relative to the summary's directory.
      for (const c of summary.cases) {
        for (const t of c.trials) {
          assert.equal(t.recording, `${c.caseId}-${t.trial}.jsonl`);
          assert.ok(existsSync(join(live.runDir, t.recording)), `${t.recording} sits next to summary.json`);
        }
      }

      const replay = await evalRun(root, "replay", ["--replay", live.runDir], null, "unset");
      assert.equal(replay.code, 0, replay.text);
      assert.match(replay.text, /Every re-scored verdict matches the recording \(10 cases\)\./);
      const replayDirs = readdirSync(replay.resultsDir).filter((d) => d.startsWith("replay-"));
      assert.equal(replayDirs.length, 1);
      const rescoredPath = join(replay.resultsDir, replayDirs[0] ?? "", "summary.json");
      const rescored = JSON.parse(readFileSync(rescoredPath, "utf8")) as RunnerResult;
      assert.equal(rescored.mode, "replay");
      assert.deepEqual(verdicts(rescored), verdicts(summary));
      const checksOf = (r: RunnerResult) => r.cases.map((c) => c.trials.map((t) => t.checks.map((ch) => ch.pass)));
      assert.deepEqual(checksOf(rescored), checksOf(summary));
    });
  });
});

describe("the server flags travel through the argv seam", () => {
  // runEval always passes STOCK_DELAY_MS.eval, so this drives createRunQuote directly to choose the delay.
  const variants = [
    { stockFault: "down", faultSeed: 1, stockDelayMs: 0 },
    { stockFault: "flaky:0.7", faultSeed: 7, stockDelayMs: 25 },
    // A negative seed is why buildOptions joins --fault-seed=<n>: a strict parser reads "-3" alone as a flag.
    { stockFault: "flaky:0.5", faultSeed: -3, stockDelayMs: 2500 },
  ];
  for (const v of variants) {
    test(`parseServerFlags accepts exactly what buildOptions produced for ${v.stockFault} seed ${v.faultSeed} delay ${v.stockDelayMs}`, async () => {
      await withTemp(async (root) => {
        const agent = scriptedAgent("ideal", truth);
        const events = await collect(runQuoteFor(agent)(rfqOf("MINI-001"), { ...v, catalogPath: MINI_CATALOG,
          outboxDir: join(root, "outbox") }));
        assert.equal(agent.seen.length, 1);
        const seen = agent.seen[0];
        assert.ok(seen !== undefined);
        assert.deepEqual(seen.problems, []);
        const srv = seen.options.mcpServers?.[CATALOG_SERVER];
        assert.ok(srv !== undefined && srv.type === "stdio", "the catalog server is a stdio server");
        assert.equal(srv.command, process.execPath);
        const args = srv.args ?? [];
        assert.equal(args[0], PATHS.serverEntry);
        assert.deepEqual(parseServerFlags(args.slice(1)), { ok: true, flags: { catalogPath: MINI_CATALOG,
          stockFault: v.stockFault, fault: parseStockFault(v.stockFault), faultSeed: v.faultSeed,
          stockDelayMs: v.stockDelayMs } });

        // The flags reached the stock backend: the line's stock is what the fault schedule says for its key.
        const finished = finishedOf(events);
        assert.equal(finished.ok, true, finished.detail ?? "");
        const quoteEvent = events.find((e) => e.type === "quote");
        assert.ok(quoteEvent !== undefined && quoteEvent.type === "quote");
        const line = quoteEvent.quote.lines[0];
        assert.ok(line !== undefined);
        const expected = expectedStock(parseStockFault(v.stockFault), v.faultSeed,
          stockLineKey("AL-6061-T6", "QD-90001", 40));
        assert.equal(line.stock, expected.verified ? "in_stock" : "unverified");
        if (v.stockFault === "down") {
          assert.equal(expected.verified, false);
          assert.equal(quoteEvent.quote.status, "pending_stock_check");
        }
        assert.equal(finished.delivery, "not_attempted", "no approver, so nothing was sent");
        assert.equal(existsSync(join(root, "outbox")), false);
      });
    });
  }
});

describe("mutants turn the intended check red and the run exits non-zero", () => {
  const mutants: { behavior: Behavior; caseId: string; check: string; detail: RegExp; what: string;
    denied: string[] }[] = [ // denied: the guard_denied events the run must record, in order
    { behavior: "retry_after_down", caseId: "fallback-down-001", check: "stock_handling",
      detail: /line 1 has 2 check_stock calls, expected 1/, what: "calls check_stock again after a down result",
      denied: ["retry_cap"] },
    { behavior: "repoll_shifted", caseId: "fallback-down-001", check: "stock_handling",
      detail: /line 1 has 2 check_stock calls for QD-90001 in AL-6061-T6 counting every quantity, expected 1/,
      what: "polls check_stock again with a shifted quantity after a down result", denied: [] },
    { behavior: "invent_price", caseId: "clean-001", check: "no_invented_price",
      detail: /line 1 materialCostPerPartUsd [0-9.]+ matches no price_material result/, what: "invents a price",
      denied: [] },
    { behavior: "skip_stock", caseId: "clean-001", check: "stock_handling",
      detail: /line 1 has 0 check_stock calls, expected 1/, what: "skips check_stock", denied: [] },
  ];
  for (const m of mutants) {
    test(`an agent that ${m.what} fails ${m.check} on ${m.caseId}`, async () => {
      await withTemp(async (root) => {
        const argv = ["--yes", "--only", m.caseId];
        const ideal = await evalRun(root, "ideal", argv, runQuoteFor(scriptedAgent("ideal", truth)));
        assert.equal(ideal.code, 0, ideal.text);
        assert.ok(ideal.summary !== null);
        assert.deepEqual(verdicts(ideal.summary), { [m.caseId]: "pass" });

        const mutant = await evalRun(root, "mutant", argv, runQuoteFor(scriptedAgent(m.behavior, truth)));
        assert.equal(mutant.code, 1, mutant.text);
        assert.ok(mutant.summary !== null);
        assert.deepEqual(verdicts(mutant.summary), { [m.caseId]: "fail" });
        const failed = failedChecks(mutant.summary, m.caseId);
        const named = failed.filter((f) => f.kind === m.check);
        assert.equal(named.length, 1, `failed checks: ${JSON.stringify(failed)}`);
        assert.match(named[0]?.detail ?? "", m.detail);
        // The guard's side of it: the retry cap denies an identical second call, and nothing else here.
        assert.ok(mutant.runDir !== null);
        const trial = mutant.summary.cases[0]?.trials[0];
        assert.ok(trial !== undefined);
        const denied = readRecording(join(mutant.runDir, trial.recording)).events
          .filter((e): e is Extract<DeskEvent, { type: "guard_denied" }> => e.type === "guard_denied");
        assert.deepEqual(denied.map((e) => e.by), m.denied);
      });
    });
  }
});

describe("runs that must not write", () => {
  // loadRfqs refuses an id that isn't a plain file name, so no cases file can hold one. This drives
  // createRunQuote directly with an RFQ object built in the test.
  for (const id of ["../escaped", "nested/MINI-001", "..\\escaped"]) {
    test(`an RFQ id of ${JSON.stringify(id)} ends as invalid_options and nothing is written`, async () => {
      await withTemp(async (root) => {
        const agent = scriptedAgent("ideal", truth);
        let asked = 0;
        const events = await collect(runQuoteFor(agent)({ ...rfqOf("MINI-001"), id }, { catalogPath: MINI_CATALOG,
          stockDelayMs: 0, outboxDir: join(root, "outbox"), approver: async () => {
            asked += 1;
            return "approve";
          } }));
        assert.deepEqual(events.map((e) => e.type), ["run_started", "run_finished"]);
        const finished = finishedOf(events);
        assert.equal(finished.ok, false);
        assert.equal(finished.failure, "invalid_options");
        assert.match(finished.detail ?? "", /not a plain file name/);
        assert.equal(finished.delivery, "not_attempted");
        assert.equal(agent.seen.length, 0, "the model was never started");
        assert.equal(asked, 0, "nobody was asked to approve");
        assert.deepEqual(readdirSync(root), [], "nothing was written in or around the outbox");
      });
    });
  }

  // The cases file's approve field can't throw, so a wrapper swaps in an approver that does. The trial still
  // goes through runEval, the recording and the scorers.
  test("an approver that throws ends as an unscored infra error with an empty outbox", async () => {
    await withTemp(async (root) => {
      let asked = 0;
      const inner = runQuoteFor(scriptedAgent("ideal", truth));
      const throwing = withOptions(inner, (o) => ({ ...o, approver: async () => {
        asked += 1;
        throw new Error("the approver's terminal closed");
      } }));
      const r = await evalRun(root, "throws", ["--yes", "--only", "clean-001"], throwing);
      assert.equal(r.code, 3, r.text);
      assert.ok(r.summary !== null && r.runDir !== null);
      assert.equal(asked, 1);
      const c = r.summary.cases[0];
      assert.ok(c !== undefined);
      assert.equal(c.verdict, "error");
      assert.equal(r.summary.totals.error, 1);
      assert.equal(r.summary.totals.scored, 0);
      const trial = c.trials[0];
      assert.ok(trial !== undefined);
      assert.equal(trial.failure, "sdk_error");
      assert.equal(trial.delivery, "not_attempted");
      assert.equal(trial.status, "ready", "the quote was built before the gate threw");
      assert.ok(trial.checks.length > 0, "the case's checks are listed, each one marked not scored");
      for (const ch of trial.checks) {
        assert.equal(ch.pass, false);
        assert.equal(ch.detail, "infra failure sdk_error, not scored");
      }
      assert.deepEqual(readdirSync(join(r.runDir, "outbox", "clean-001-1")), []);
      const rec = readRecording(join(r.runDir, trial.recording));
      assert.deepEqual(rec.outbox, []);
      const finished = finishedOf(rec.events);
      assert.equal(finished.ok, false);
      assert.match(finished.detail ?? "", /^approve and send: the approver's terminal closed/);
    });
  });
});
