// The ideal scripted agent over the real case files: every tuned and held-out case must pass through the
// real createRunQuote, guards, finalizeQuote, approveAndSend, tool handlers, runEval and scorers. This reads
// the generated data (eval/cases.json with data/rfqs.json and data/rfq-truth.json, and the holdout pair), so
// it is committed together with that data. No model, no network, no git; stockDelayMs is 0.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { test } from "node:test";
import { CATALOG_SERVER } from "../src/contracts.ts";
import type { RfqTruth, RunQuote, RunnerResult } from "../src/contracts.ts";
import { createRunQuote } from "../src/agent/run.ts";
import { PROMPT_HASH } from "../src/agent/prompt.ts";
import { loadCatalog, loadTruth } from "../src/load.ts";
import { PATHS } from "../src/paths.ts";
import { finalizeQuote } from "../src/quote/finalize.ts";
import { approveAndSend } from "../src/quote/gate.ts";
import { readRecording } from "../src/recording.ts";
import { runEval } from "../eval/runner.ts";
import { STANDING_PRICE_NOTE, scriptedAgent } from "./helpers/scripted-agent.ts";

const truth = new Map<string, RfqTruth>(
  [...loadTruth(PATHS.truth), ...loadTruth(PATHS.truthHoldout)].map((t) => [t.rfqId, t]));
const BASE_ENV: Record<string, string | undefined> = { ANTHROPIC_API_KEY: "placeholder-not-a-key", PATH: "" };

async function idealRun(cases: string, expected: number): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "qd-oracle-"));
  try {
    const agent = scriptedAgent("ideal", truth);
    const inner = createRunQuote({ query: agent.query, finalizeQuote, approveAndSend, loadCatalog, env: BASE_ENV });
    // runEval passes STOCK_DELAY_MS.eval; 0 keeps the run fast and still goes through the server flags.
    const runQuote: RunQuote = (rfq, opts) => inner(rfq, { ...opts, stockDelayMs: 0 });
    let text = "";
    const stdout = new Writable({ write(chunk, _encoding, done) {
      text += String(chunk);
      done();
    } });
    const resultsDir = join(root, "results");
    const code = await runEval(["--yes"], { runQuote, promptHash: PROMPT_HASH, env: {}, keySource: "environment",
      stdout, now: () => new Date(), confirm: async () => true, gitSha: () => "abc1234",
      paths: { cases, resultsDir, recordingsDir: join(root, "recordings") } });
    assert.equal(code, 0, text);
    const runs = readdirSync(resultsDir).filter((d) => /^\d{8}-\d{6}/.test(d));
    assert.equal(runs.length, 1);
    const summary = JSON.parse(readFileSync(join(resultsDir, runs[0] ?? "", "summary.json"), "utf8")) as RunnerResult;
    assert.equal(summary.cases.length, expected);
    for (const c of summary.cases) {
      const failed = c.trials.flatMap((t) => t.checks.filter((ch) => !ch.pass).map((ch) => `${ch.kind}: ${ch.detail}`));
      assert.equal(c.verdict, "pass", `${c.caseId}: ${failed.join("; ")}`);
    }
    assert.equal(summary.totals.pass, expected);
    assert.equal(agent.seen.length, expected);
    for (const s of agent.seen) assert.deepEqual(s.problems, []);
    for (const s of agent.seen) {
      const srv = s.options.mcpServers?.[CATALOG_SERVER];
      assert.ok(srv !== undefined && srv.type === "stdio" && (srv.args ?? []).includes("--stock-delay-ms=0"));
    }
    // The injection case passes on the request the email makes, not on the standing pricing note.
    const injection = summary.cases.filter((c) => c.category === "injection");
    assert.equal(injection.length, 1);
    for (const c of injection) {
      for (const t of c.trials) {
        const quote = readRecording(join(resultsDir, runs[0] ?? "", t.recording)).events
          .find((e) => e.type === "quote");
        assert.ok(quote !== undefined && quote.type === "quote");
        assert.ok(quote.quote.assumptions.some((a) => a.startsWith("Not applied: the email asks for a ")),
          `${c.caseId}: ${quote.quote.assumptions.join(" | ")}`);
        assert.ok(!quote.quote.assumptions.includes(STANDING_PRICE_NOTE));
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("the ideal agent passes all 29 tuned cases", async () => {
  await idealRun(PATHS.cases, 29);
});

test("the ideal agent passes all 10 held-out cases", async () => {
  await idealRun(PATHS.casesHoldout, 10);
});
