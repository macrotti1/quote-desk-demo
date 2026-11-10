// The nightly report: decide() on fixtures, the gh command plan, the CLI with a fake gh, and a text check on
// .github/workflows/nightly.yml. No network, no model, no real gh: every gh call goes to a recording fake.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  BODY_CAP, CUT_NOTICE, FOOTER, decide, exitCodeOf, main, parseIssues, parseLatest, parseThresholds, planCommands,
} from "../scripts/nightly-report.ts";
import type { Command, DecideInput, Decision, GhResult, Thresholds } from "../scripts/nightly-report.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FIX = join(ROOT, "test", "fixtures", "nightly");
const DEFAULT_TH: Thresholds = { schema: 1, minPassRate: 1, minCategoryPassRate: {}, maxErrorCases: 0 };
const REPORT_MD = readFileSync(join(FIX, "latest.md"), "utf8");

function fixture(name: string): string | null {
  try {
    return readFileSync(join(FIX, name), "utf8");
  } catch {
    return null;
  }
}

function input(name: string, over: Partial<DecideInput> = {}): DecideInput {
  return {
    evalExit: 0, latest: parseLatest(fixture(name), name), latestMd: REPORT_MD, thresholds: DEFAULT_TH, drill: false,
    date: "2026-11-11", runUrl: "https://github.com/o/r/actions/runs/42", commit: "abc1234", ...over,
  };
}

function kinds(commands: readonly Command[]): string[] {
  return commands.map((c) => c.kind);
}

// ---- the committed thresholds
test("eval/nightly-thresholds.json is the spec's file and parses", () => {
  const text = readFileSync(join(ROOT, "eval", "nightly-thresholds.json"), "utf8");
  assert.deepEqual(JSON.parse(text), { schema: 1, minPassRate: 1, minCategoryPassRate: {}, maxErrorCases: 0 });
  assert.deepEqual(parseThresholds(text, "nightly-thresholds.json"), DEFAULT_TH);
});

test("a malformed thresholds file is refused", () => {
  assert.throws(() => parseThresholds("{\"schema\":1,\"minPassRate\":2,\"minCategoryPassRate\":{},\"maxErrorCases\":0}", "t"));
  assert.throws(() => parseThresholds("{\"schema\":2}", "t"));
  assert.throws(() => parseThresholds("not json", "t"));
});

// ---- decide
test("decide: all pass is ok", () => {
  const d = decide(input("pass.json"));
  assert.equal(d.state, "ok");
  assert.equal(exitCodeOf(d.state), 0);
  assert.deepEqual(d.labels, ["nightly-eval"]);
  assert.equal(d.title, "Nightly eval: 4 of 4 held-out cases passed (2026-11-11)");
  assert.match(d.body, /Failed: none\./);
});

test("decide: one failed case is a regression and names its failed checks", () => {
  const d = decide(input("one-fail.json"));
  assert.equal(d.state, "regression");
  assert.equal(exitCodeOf(d.state), 1);
  assert.equal(d.title, "Nightly eval: 3 of 4 held-out cases passed (2026-11-11)");
  assert.deepEqual(d.labels, ["nightly-eval", "regression"]);
  assert.match(d.body, /^Score: 3 of 4 held-out cases passed, 75\.0% of 4 scored against a threshold of 100\.0%\./m);
  assert.match(d.body, /Failed: holdout-002 \(fail: status\(pending_stock_check\), stock_handling\)\./);
  assert.match(d.body, /Run: https:\/\/github\.com\/o\/r\/actions\/runs\/42, commit abc1234, eval exit 0\./);
});

test("decide: the decision comes from the thresholds, not the eval's own exit code", () => {
  // eval:nightly keeps eval's default floor, so 3 of 4 could exit 0 there; the nightly threshold still says drop.
  assert.equal(decide(input("one-fail.json", { evalExit: 0 })).state, "regression");
  assert.equal(decide(input("pass.json", { evalExit: 1 })).state, "ok");
});

test("decide: a category under its floor is a regression even when the overall rate clears", () => {
  const th = parseThresholds(fixture("thresholds-category.json") ?? "", "thresholds-category.json");
  const d = decide(input("one-fail.json", { thresholds: th }));
  assert.equal(d.state, "regression");
  assert.match(d.body, /Category fallback: 0 of 1, under its floor of 100\.0%\./);
  const loose: Thresholds = { ...th, minCategoryPassRate: {} };
  assert.equal(decide(input("one-fail.json", { thresholds: loose })).state, "ok");
});

test("decide: eval exit 3 is infra", () => {
  const d = decide(input("pass.json", { evalExit: 3 }));
  assert.equal(d.state, "infra");
  assert.equal(exitCodeOf(d.state), 3);
  assert.equal(d.title, "Nightly eval: infrastructure failure (2026-11-11)");
  assert.deepEqual(d.labels, ["nightly-eval", "infra"]);
  assert.match(d.body, /Infrastructure: the eval exited 3\./);
});

test("decide: a missing results file is infra", () => {
  const d = decide(input("missing.json", { evalExit: 3, latestMd: null }));
  assert.equal(d.state, "infra");
  assert.match(d.body, /^Score: none, because the eval exited 3 and missing\.json is missing\./m);
  assert.match(d.body, /\(No report: latest\.md is missing\.\)/);
  assert.equal(decide(input("missing.json", { evalExit: 0 })).state, "infra");
});

test("decide: an unparseable file is infra", () => {
  const d = decide(input("broken.json"));
  assert.equal(d.state, "infra");
  assert.match(d.body, /broken\.json is not valid JSON/);
});

test("decide: schema 2 is infra", () => {
  const d = decide(input("schema-2.json"));
  assert.equal(d.state, "infra");
  assert.match(d.body, /schema-2\.json has schema 2, not 1/);
});

test("decide: zero scored cases is infra", () => {
  const d = decide(input("zero-scored.json"));
  assert.equal(d.state, "infra");
  assert.match(d.body, /no case was scored/);
});

test("decide: errors over the limit are infra, and at the limit they are not", () => {
  const d = decide(input("errors.json"));
  assert.equal(d.state, "infra");
  assert.match(d.body, /1 cases errored, over the limit of 0/);
  assert.match(d.body, /holdout-002 \(error: wall_clock\)/);
  assert.equal(decide(input("errors.json", { thresholds: { ...DEFAULT_TH, maxErrorCases: 1 } })).state, "ok");
});

test("decide: a regression and an error together is a regression", () => {
  const d = decide(input("regression-and-error.json", { evalExit: 3 }));
  assert.equal(d.state, "regression");
  assert.match(d.body, /Failed: holdout-002 \(fail: status\(pending_stock_check\), stock_handling\); holdout-003 \(error: wall_clock\)\./);
});

test("decide: the drill flips the first passing case in memory only", () => {
  const before = fixture("pass.json");
  const read = parseLatest(before, "pass.json");
  const d = decide({ ...input("pass.json"), latest: read, drill: true });
  assert.equal(d.state, "regression");
  assert.ok(d.title.startsWith("[drill] "), d.title);
  assert.equal(d.title, "[drill] Nightly eval: 3 of 4 held-out cases passed (2026-11-11)");
  assert.deepEqual(d.labels, ["nightly-eval", "regression", "drill"]);
  const lines = d.body.split("\n");
  assert.equal(lines[0], "This is a drill forced by workflow_dispatch. The live run scored 4 of 4 before one verdict was flipped.");
  assert.match(d.body, /Score: 3 of 4 held-out cases passed, 75\.0% of 4 scored/);
  assert.match(d.body, /Failed: holdout-001 \(drill: verdict flipped, no check failed\)\./);
  // Nothing on disk and nothing in the parsed input changed.
  assert.equal(fixture("pass.json"), before);
  assert.ok(read.ok);
  if (read.ok) {
    assert.equal(read.latest.totals.pass, 4);
    assert.equal(read.latest.cases[0]?.verdict, "pass");
  }
});

test("decide: the body is capped at 60,000 characters and says so", () => {
  const huge = Array.from({ length: 4000 }, (_, i) => `| holdout-${i} | clean | ok | PASS |  | $0.10 | 0m30s |`).join("\n");
  assert.ok(huge.length > BODY_CAP);
  const d = decide(input("one-fail.json", { latestMd: huge }));
  assert.ok(d.body.length <= BODY_CAP, `body is ${d.body.length}`);
  assert.ok(d.body.includes(CUT_NOTICE));
  assert.ok(d.body.endsWith(FOOTER + "\n"));
  assert.match(d.body, /^Score: /);
  const small = decide(input("one-fail.json"));
  assert.ok(!small.body.includes(CUT_NOTICE));
  assert.ok(small.body.includes(REPORT_MD.trimEnd()), "latest.md goes in verbatim");
  assert.ok(small.body.endsWith(FOOTER + "\n"));
});

// ---- the command plan
function decision(name: string, over: Partial<DecideInput> = {}): Decision {
  return decide(input(name, over));
}
function openIssues(name: string): ReturnType<typeof parseIssues> {
  return parseIssues(fixture(name) ?? "[]", name);
}

test("plan: a regression with no open issue creates one, labels first", () => {
  const d = decision("one-fail.json");
  const cmds = planCommands(d, [], "o/r");
  assert.deepEqual(kinds(cmds), ["label", "label", "create"]);
  assert.deepEqual(cmds[0]?.args.slice(0, 4), ["label", "create", "nightly-eval", "--force"]);
  const create = cmds[2];
  assert.ok(create !== undefined);
  assert.deepEqual(create.args.slice(0, 4), ["issue", "create", "--title", d.title]);
  assert.ok(create.args.includes("regression"));
  assert.deepEqual(create.args.slice(-2), ["--repo", "o/r"]);
  assert.equal(create.body, d.body);
  for (const c of cmds) assert.ok(!c.args.some((a) => a.includes("Score:")), "a body never rides on the command line");
});

test("plan: a regression with an open regression issue edits it and comments", () => {
  const d = decision("one-fail.json");
  const cmds = planCommands(d, openIssues("open-regression.json"), null);
  assert.deepEqual(kinds(cmds), ["label", "label", "edit", "comment"]);
  assert.deepEqual(cmds[2]?.args, ["issue", "edit", "7", "--title", d.title]);
  assert.equal(cmds[2]?.body, d.body);
  assert.deepEqual(cmds[3]?.args, ["issue", "comment", "7"]);
  assert.match(cmds[3]?.body ?? "", /actions\/runs\/42/);
});

test("plan: a drill on an open regression issue adds the drill label", () => {
  const d = decision("pass.json", { drill: true });
  const edit = planCommands(d, openIssues("open-regression.json"), null).find((c) => c.kind === "edit");
  assert.deepEqual(edit?.args, ["issue", "edit", "7", "--title", d.title, "--add-label", "drill"]);
});

test("plan: a real regression taking over a drill's issue removes the drill label", () => {
  const d = decision("one-fail.json");
  const open = [{ number: 7, title: "[drill] Nightly eval", labels: ["nightly-eval", "regression", "drill"] }];
  const cmds = planCommands(d, open, "o/r");
  assert.deepEqual(kinds(cmds), ["label", "label", "edit", "comment"]);
  assert.deepEqual(cmds[2]?.args, ["issue", "edit", "7", "--title", d.title, "--remove-label", "drill", "--repo", "o/r"]);
  const infra = decision("pass.json", { evalExit: 3 });
  const infraOpen = [{ number: 9, title: "[drill] Nightly eval", labels: ["nightly-eval", "infra", "drill"] }];
  const infraEdit = planCommands(infra, infraOpen, null).find((c) => c.kind === "edit");
  assert.ok(infraEdit?.args.includes("--remove-label"));
  const drillAgain = planCommands(decision("pass.json", { drill: true }), open, null).find((c) => c.kind === "edit");
  assert.ok(!drillAgain?.args.includes("--remove-label"), "a drill keeps its own label");
});

test("plan: a drill that still scores ok plans no comment or close", () => {
  const loose: Thresholds = { ...DEFAULT_TH, minPassRate: 0.5 };
  const d = decision("pass.json", { drill: true, thresholds: loose });
  assert.equal(d.state, "ok");
  assert.deepEqual(planCommands(d, openIssues("open-both.json"), "o/r"), []);
});

test("plan: ok with open issues comments Recovered on each nightly issue and closes it", () => {
  const cmds = planCommands(decision("pass.json"), openIssues("open-both.json"), "o/r");
  assert.deepEqual(kinds(cmds), ["comment", "close", "comment", "close"]);
  assert.deepEqual(cmds.map((c) => c.args[2]), ["7", "7", "9", "9"]);
  assert.match(cmds[0]?.body ?? "", /^Recovered\.\n\nScore: 4 of 4 held-out cases passed/);
  assert.match(cmds[0]?.body ?? "", /commit abc1234/);
  assert.ok(!cmds.some((c) => c.args.includes("4")), "an issue without the nightly-eval label is left alone");
});

test("plan: ok with no open issues plans nothing", () => {
  assert.deepEqual(planCommands(decision("pass.json"), [], "o/r"), []);
});

test("plan: infra with an open regression issue leaves that issue alone", () => {
  const cmds = planCommands(decision("pass.json", { evalExit: 3 }), openIssues("open-regression.json"), null);
  assert.deepEqual(kinds(cmds), ["label", "label", "create"]);
  assert.ok(cmds.every((c) => !c.args.includes("7")));
  assert.ok(cmds[2]?.args.includes("infra"));
});

// ---- the CLI with a fake gh
type Call = { args: string[]; body: string | undefined };
function fakeGh(listJson: string, failOn?: string): { calls: Call[]; gh: (args: string[], body?: string) => GhResult } {
  const calls: Call[] = [];
  return {
    calls,
    gh: (args, body) => {
      calls.push({ args, body });
      if (failOn !== undefined && args[1] === failOn) return { status: 1, stdout: "", stderr: "boom" };
      if (args[0] === "issue" && args[1] === "list") return { status: 0, stdout: listJson, stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    },
  };
}

function cli(argv: string[], env: Record<string, string | undefined>, gh = fakeGh("[]")): { code: number; out: string } {
  const lines: string[] = [];
  const code = main(argv, { env, gh: gh.gh, out: (l) => lines.push(l), now: () => new Date("2026-11-11T07:30:00Z"), cwd: ROOT });
  return { code, out: lines.join("\n") };
}

const ACTIONS_ENV = { GITHUB_REPOSITORY: "o/r", GITHUB_SERVER_URL: "https://github.com", GITHUB_RUN_ID: "42", GITHUB_SHA: "0123456789abcdef" };

test("cli: --dry-run calls no gh and prints the decision and commands", () => {
  const gh = fakeGh("[]");
  const r = cli(["--dry-run", "--eval-exit", "0", "--latest", "test/fixtures/nightly/one-fail.json",
    "--open-issues-file", "test/fixtures/nightly/open-regression.json"], {}, gh);
  assert.equal(r.code, 1);
  assert.equal(gh.calls.length, 0);
  const j = JSON.parse(r.out) as { decision: Decision; commands: Command[] };
  assert.equal(j.decision.state, "regression");
  assert.deepEqual(kinds(j.commands), ["label", "label", "edit", "comment"]);
  assert.match(j.decision.body, /no run link/);
});

test("cli: the summary.md beside a summary.json becomes the report", () => {
  const r = cli(["--dry-run", "--eval-exit", "0", "--latest", "recordings/eval-holdout-k3/summary.json"], {});
  assert.equal(r.code, 0);
  const j = JSON.parse(r.out) as { decision: Decision; commands: Command[] };
  assert.equal(j.decision.title, "Nightly eval: 10 of 10 held-out cases passed (2026-11-11)");
  assert.match(j.decision.body, /# quote-desk-demo eval: holdout/);
  assert.deepEqual(j.commands, []);
});

test("cli: without --dry-run it refuses to run when GITHUB_REPOSITORY is unset", () => {
  const gh = fakeGh("[]");
  const r = cli(["--eval-exit", "0", "--latest", "test/fixtures/nightly/one-fail.json"], {}, gh);
  assert.equal(r.code, 3);
  assert.equal(gh.calls.length, 0);
  assert.match(r.out, /GITHUB_REPOSITORY is unset/);
});

test("cli: a live regression lists issues, then edits through --body-file only", () => {
  const gh = fakeGh(fixture("open-regression.json") ?? "[]");
  const r = cli(["--eval-exit", "1", "--latest", "test/fixtures/nightly/one-fail.json"], ACTIONS_ENV, gh);
  assert.equal(r.code, 1);
  assert.deepEqual(gh.calls[0]?.args.slice(0, 2), ["issue", "list"]);
  assert.ok(gh.calls[0]?.args.includes("o/r"));
  const edit = gh.calls.find((c) => c.args[1] === "edit");
  assert.ok(edit !== undefined);
  assert.match(edit.body ?? "", /Run: https:\/\/github\.com\/o\/r\/actions\/runs\/42, commit 0123456, eval exit 1\./);
  assert.ok(!r.out.includes("Score:"), "bodies are not printed");
});

test("cli: a failed gh call turns an ok run into infra", () => {
  const gh = fakeGh(fixture("open-regression.json") ?? "[]", "close");
  const r = cli(["--eval-exit", "0", "--latest", "test/fixtures/nightly/pass.json"], ACTIONS_ENV, gh);
  assert.equal(r.code, 3);
  assert.match(r.out, /gh close failed/);
});

test("cli: a drill that still scores ok touches no issue and exits 3", () => {
  const th = "test/fixtures/nightly/thresholds-loose.json";
  const gh = fakeGh(fixture("open-both.json") ?? "[]");
  const r = cli(["--eval-exit", "0", "--latest", "test/fixtures/nightly/pass.json", "--thresholds", th, "--drill"], ACTIONS_ENV, gh);
  assert.equal(r.code, 3);
  assert.equal(gh.calls.length, 0);
  assert.match(r.out, /still cleared the threshold/);
  const dry = cli(["--dry-run", "--eval-exit", "0", "--latest", "test/fixtures/nightly/pass.json", "--thresholds", th,
    "--drill", "--open-issues-file", "test/fixtures/nightly/open-both.json"], {});
  assert.equal(dry.code, 3);
  const j = JSON.parse(dry.out) as { decision: Decision; commands: Command[]; note?: string };
  assert.equal(j.decision.state, "ok");
  assert.deepEqual(j.commands, []);
  assert.match(j.note ?? "", /still cleared the threshold/);
});

test("cli: a bad or missing --eval-exit is a usage error, exit 3", () => {
  assert.equal(cli(["--dry-run"], {}).code, 3);
  assert.equal(cli(["--dry-run", "--eval-exit", "x"], {}).code, 3);
  assert.equal(cli(["--dry-run", "--eval-exit", "0", "--bogus"], {}).code, 3);
});

// ---- the workflow file
const YML = readFileSync(join(ROOT, ".github", "workflows", "nightly.yml"), "utf8");

test("nightly.yml: every npm run script exists in package.json", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
  const names = [...YML.matchAll(/npm run ([\w:-]+)/g)].map((m) => m[1]);
  assert.ok(names.length >= 2);
  for (const name of names) assert.ok(name !== undefined && name in pkg.scripts, `npm run ${name} is not a script`);
});

test("nightly.yml: both triggers, no push trigger, and issues: write", () => {
  assert.match(YML, /^ {2}schedule:\n {4}- cron: "17 7 \* \* \*"$/m);
  assert.match(YML, /^ {2}workflow_dispatch:$/m);
  assert.match(YML, /^ {6}drill:\n(?: {8}.*\n)*? {8}type: boolean$/m);
  assert.doesNotMatch(YML, /^ {2}(push|pull_request):/m);
  assert.match(YML, /^ {2}issues: write$/m);
  assert.match(YML, /^ {2}contents: read$/m);
});

test("nightly.yml: secrets. appears only inside env: mappings", () => {
  const lines = YML.split("\n");
  let seen = 0;
  lines.forEach((line, i) => {
    if (!line.includes("secrets.")) return;
    seen += 1;
    const indent = line.search(/\S/);
    let parent = "";
    for (let j = i - 1; j >= 0; j--) {
      const above = lines[j] ?? "";
      if (above.trim() === "" || above.trim().startsWith("#")) continue;
      if (above.search(/\S/) < indent) {
        parent = above.trim();
        break;
      }
    }
    assert.equal(parent, "env:", `line ${i + 1} uses secrets. outside an env mapping: ${line.trim()}`);
  });
  assert.ok(seen >= 2, "the key check and the eval step both read the secret");
});
