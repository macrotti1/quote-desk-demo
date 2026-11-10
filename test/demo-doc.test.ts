// DEMO.md against the repo: the commands it names exist, the recordings it names exist, and the
// figures it quotes match the files they come from. No model, no network.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { PATHS } from "../src/paths.ts";
import { readRecording } from "../src/recording.ts";

const doc = readFileSync(join(PATHS.root, "DEMO.md"), "utf8");

function readJson(rel: string): unknown {
  return JSON.parse(readFileSync(join(PATHS.root, rel), "utf8")) as unknown;
}

function trialTotals(rel: string): { passed: number; scored: number } {
  const summary = readJson(rel) as { totals?: { trialsPassed?: unknown; trialsScored?: unknown } };
  const passed = summary.totals?.trialsPassed;
  const scored = summary.totals?.trialsScored;
  assert.ok(typeof passed === "number" && typeof scored === "number", `${rel} has trial totals`);
  return { passed, scored };
}

test("every npm run <name> in DEMO.md is a script in package.json", () => {
  const scripts = (readJson("package.json") as { scripts: Record<string, string> }).scripts;
  const names = [...doc.matchAll(/npm run ([a-z][a-z0-9:-]*)/g)].map((m) => m[1] ?? "");
  assert.ok(names.length >= 5, "DEMO.md names its commands");
  for (const name of names) assert.ok(name in scripts, `npm run ${name} is not in package.json`);
});

test("every recordings/ path in DEMO.md exists", () => {
  const paths = [...doc.matchAll(/recordings\/[A-Za-z0-9._/-]*[A-Za-z0-9_]/g)].map((m) => m[0]);
  assert.ok(paths.length > 0);
  for (const rel of paths) assert.ok(existsSync(join(PATHS.root, rel)), `${rel} does not exist`);
});

test("the clean total in DEMO.md is the total in recordings/demo-clean.jsonl", () => {
  const rec = readRecording(join(PATHS.recordingsDir, "demo-clean.jsonl"));
  const quote = rec.events.find((e) => e.type === "quote");
  assert.ok(quote !== undefined && quote.type === "quote");
  const total = quote.quote.totalUsd;
  assert.ok(typeof total === "number");
  const shown = total.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  assert.equal(shown, "2,277.50");
  assert.ok(doc.includes(`$${shown}`), `DEMO.md shows $${shown}`);
  for (const m of doc.matchAll(/\$2,2\d\d\.\d\d/g)) assert.equal(m[0], `$${shown}`);
});

test("the trial counts in DEMO.md match the two summary.json files", () => {
  const tuned = trialTotals("recordings/eval-k3/summary.json");
  const holdout = trialTotals("recordings/eval-holdout-k3/summary.json");
  assert.ok(doc.includes(`${tuned.passed} of ${tuned.scored}`), `DEMO.md says ${tuned.passed} of ${tuned.scored}`);
  assert.ok(doc.includes(`${holdout.passed} of ${holdout.scored}`),
    `DEMO.md says ${holdout.passed} of ${holdout.scored}`);
  assert.equal(`${tuned.passed} of ${tuned.scored}`, "87 of 87");
  assert.equal(`${holdout.passed} of ${holdout.scored}`, "30 of 30");
});

test("DEMO.md says synthetic and simulated, stays at 1,300 words or fewer, and holds no long dash", () => {
  assert.match(doc, /synthetic/);
  assert.match(doc, /simulated/);
  const words = doc.split(/\s+/).filter((w) => w !== "").length;
  assert.ok(words <= 1300, `DEMO.md has ${words} words`);
  assert.doesNotMatch(doc, /[\u2013\u2014]/);
  assert.ok(!doc.includes("\r"), "LF line endings");
  assert.ok(doc.endsWith("\n"));
});
