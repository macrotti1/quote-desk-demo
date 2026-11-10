// The agent runtime (slice S3): prompt, options, env scrub, guards, event mapper and runQuote.
// No model, no network, no claude spawn: query is a fake async generator, and env is a fake base env.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join, sep } from "node:path";
import { describe, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import type { HookCallback, HookInput, NotificationHookInput, Options, PreToolUseHookInput, SDKMessage }
  from "@anthropic-ai/claude-agent-sdk";
import { CATALOG_TOOLS, DeskEventSchema, INFRA_FAILURES, LIMITS, QUOTE_DRAFT_JSON_SCHEMA, STRUCTURED_OUTPUT_TOOL,
  fullToolName } from "../src/contracts.ts";
import type { ApproveAndSend, CheckStockOk, DeskEvent, DeskEventBody, FinalizeQuote, LookupPartOk, QuoteDraft,
  Rfq, RunOptions } from "../src/contracts.ts";
import { loadCatalog, sha256Hex } from "../src/load.ts";
import { PATHS } from "../src/paths.ts";
import { createEventMapper, createScrubber, scrubText } from "../src/agent/events.ts";
import { RETRY_CAP_REASON, createGuards } from "../src/agent/guards.ts";
import type { GuardDenied, Guards } from "../src/agent/guards.ts";
import { buildOptions, childEnv } from "../src/agent/options.ts";
import { PROMPT_HASH, SYSTEM_PROMPT, buildUserPrompt } from "../src/agent/prompt.ts";
import { createRunQuote } from "../src/agent/run.ts";
import type { RunQuoteDeps } from "../src/agent/run.ts";
import * as fx from "./fixtures/sdk/messages.ts";

const MINI_CATALOG = join(PATHS.miniDir, "catalog.json");
const catalog = loadCatalog(MINI_CATALOG);
const FAKE_BASE_ENV: Record<string, string | undefined> = { PATH: "p", ANTHROPIC_API_KEY: "test-not-a-key",
  CLAUDECODE: "1", CLAUDE_EFFORT: "high", ANTHROPIC_BASE_URL: "x", anthropic_model: "m" };
const FAKE_DROPPED = ["ANTHROPIC_BASE_URL", "CLAUDECODE", "CLAUDE_EFFORT", "anthropic_model"];
// A made-up key in the real key's shape, built from parts so a grep for the prefix finds no literal.
const KEY_PREFIX = ["sk", "ant"].join("-");
const FAKE_KEY = [KEY_PREFIX, "api03", "MadeUpForTestsOnly_0123456789"].join("-");

// An RFQ that is in no data file.
const AD_HOC_RFQ: Rfq = { id: "ADHOC-7", customer: "Invented Fixtures Co",
  contactEmail: "buyer@invented-fixtures.example", receivedOn: "2026-11-09", subject: "Quick quote",
  body: "Hello,\n\nPlease quote QD-90001, qty 40, 6061-T6, +/-0.002.\n\nThanks,\nInvented Fixtures purchasing" };

const VALID_DRAFT: QuoteDraft = { rfqId: "ADHOC-7", customer: "Invented Fixtures Co", status: "ready",
  lines: [{ lineRef: "1", partNumber: "QD-90001", materialAsRequested: "6061-T6", materialCode: "AL-6061-T6",
    quantity: 40, toleranceIn: 0.002, materialCostPerPartUsd: 4.91, machiningCostPerPartUsd: 17.66,
    stock: "in_stock", leadTimeDays: 10 }],
  assumptions: [], openQuestions: [] };

const STOCK_INPUT = { material: "AL-6061-T6", partNumber: "QD-90001", quantity: 40 };
const STOCK_OK: CheckStockOk = { ok: true, materialCode: "AL-6061-T6", partNumber: "QD-90001", quantity: 40,
  requiredLb: 46.8, onHandLb: 900, status: "in_stock", leadTimeDays: 10, attempts: 1 };
const LOOKUP_OK: LookupPartOk = { ok: true, partNumber: "QD-90001", description: "Mounting plate", family: "plate",
  stockShape: "plate", stockSize: "0.500 x 4.000 x 6.00", standardToleranceIn: 0.005, operationCount: 2 };

const signal = new AbortController().signal;

function hookInput(tool_name: string, tool_input: unknown, tool_use_id: string, effort?: string): PreToolUseHookInput {
  const base: PreToolUseHookInput = { session_id: fx.SESSION_ID, transcript_path: "transcript.jsonl", cwd: "workdir",
    hook_event_name: "PreToolUse", tool_name, tool_input, tool_use_id };
  return effort === undefined ? base : { ...base, effort: { level: effort } };
}

function preToolUseOf(hooks: Options["hooks"]): HookCallback {
  const cb = hooks?.PreToolUse?.[0]?.hooks[0];
  assert.ok(cb, "a PreToolUse hook is registered");
  return cb;
}

function callHook(hooks: Options["hooks"], input: HookInput) {
  const id = input.hook_event_name === "PreToolUse" ? input.tool_use_id : undefined;
  return preToolUseOf(hooks)(input, id, { signal });
}

function newGuards(): { g: Guards; denies: GuardDenied[] } {
  const denies: GuardDenied[] = [];
  return { g: createGuards(catalog, (e) => denies.push(e)), denies };
}

const DENY_RETRY = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny",
  permissionDecisionReason: RETRY_CAP_REASON } };

// ---------------------------------------------------------------- prompt

describe("prompt", () => {
  test("the RFQ body sits inside the rfq_email tags", () => {
    const p = buildUserPrompt(AD_HOC_RFQ);
    assert.ok(p.includes(`<rfq_email>\n${AD_HOC_RFQ.body}\n</rfq_email>`));
    assert.ok(p.startsWith(`RFQ ADHOC-7 from Invented Fixtures Co <buyer@invented-fixtures.example>, received 2026-11-09.\nSubject: Quick quote\n`));
    assert.ok(p.endsWith("\nPrepare the quote."));
  });

  test("the answers block appears only when answers are given", () => {
    assert.ok(!buildUserPrompt(AD_HOC_RFQ).includes("<customer_answers>"));
    assert.ok(!buildUserPrompt(AD_HOC_RFQ, []).includes("<customer_answers>"));
    const p = buildUserPrompt(AD_HOC_RFQ, [{ lineRef: "1", answer: "50 pieces" }, { lineRef: "2", answer: "304" }]);
    assert.ok(p.includes("</rfq_email>\n<customer_answers>\nLine 1: 50 pieces\nLine 2: 304\n</customer_answers>\nPrepare the quote."));
  });

  test("PROMPT_HASH is 12 hex chars and stable", () => {
    assert.match(PROMPT_HASH, /^[0-9a-f]{12}$/);
    assert.equal(PROMPT_HASH, sha256Hex(SYSTEM_PROMPT).slice(0, 12));
    // Pinned on purpose. Recordings carry this hash, so the lead updates this literal whenever the prompt changes.
    assert.equal(PROMPT_HASH, "1987b32c0d4f");
  });

  test("no truth field name appears in either prompt", () => {
    const user = buildUserPrompt(AD_HOC_RFQ, [{ lineRef: "1", answer: "50" }]);
    for (const name of ["blockedBy", "stockIfOk", "keyword", "conflictingTolerances"]) {
      assert.ok(!SYSTEM_PROMPT.toLowerCase().includes(name.toLowerCase()), `system prompt names ${name}`);
      assert.ok(!user.toLowerCase().includes(name.toLowerCase()), `user prompt names ${name}`);
    }
  });

  test("the system prompt carries all 14 rules, the tool names and no dashes", () => {
    for (let n = 1; n <= 14; n++) assert.ok(SYSTEM_PROMPT.includes(`\n${n}. `), `rule ${n}`);
    for (const t of CATALOG_TOOLS) assert.ok(SYSTEM_PROMPT.includes(t), t);
    assert.ok(SYSTEM_PROMPT.includes("Stock not verified for line <n>: inventory service unavailable."));
    assert.ok(SYSTEM_PROMPT.includes("<rfq_email>"));
    assert.ok(!/[\u2013\u2014]/.test(SYSTEM_PROMPT), "no en or em dash");
  });
});

// ---------------------------------------------------------------- options and env

describe("options", () => {
  test("buildOptions returns every key the spec lists", () => {
    const abortController = new AbortController();
    const { g } = newGuards();
    const onStderr = (_: string): void => {};
    const env = { PATH: "p" };
    const o = buildOptions({ model: "claude-opus-5-5", effort: "medium", stockFault: "flaky:0.5", faultSeed: 7,
      stockDelayMs: 50, catalogPath: "catalog.json", workDir: "workdir", env, maxTurns: 20, maxBudgetUsd: 0.75,
      abortController, canUseTool: g.canUseTool, hooks: g.hooks, onStderr });
    assert.deepEqual(Object.keys(o).sort(), ["abortController", "canUseTool", "cwd", "effort", "env", "hooks",
      "maxBudgetUsd", "maxTurns", "mcpServers", "model", "outputFormat", "permissionMode", "persistSession",
      "plugins", "settingSources", "skills", "stderr", "strictMcpConfig", "systemPrompt", "tools",
      "verbatimPrompts"]);
    assert.equal(o.model, "claude-opus-5-5");
    assert.equal(o.effort, "medium");
    assert.equal(o.systemPrompt, SYSTEM_PROMPT);
    assert.deepEqual(o.tools, []);
    assert.deepEqual(o.mcpServers, { catalog: { type: "stdio", command: process.execPath,
      args: [PATHS.serverEntry, "--catalog", "catalog.json", "--stock-fault", "flaky:0.5", "--fault-seed=7",
        "--stock-delay-ms=50"],
      timeout: LIMITS.serverTimeoutMs, alwaysLoad: true } });
    assert.equal(o.canUseTool, g.canUseTool);
    assert.equal(o.hooks, g.hooks);
    assert.deepEqual(o.outputFormat, { type: "json_schema", schema: QUOTE_DRAFT_JSON_SCHEMA });
    assert.deepEqual(o.settingSources, []);
    assert.equal(o.strictMcpConfig, true);
    assert.deepEqual(o.skills, []);
    assert.deepEqual(o.plugins, []);
    assert.equal(o.persistSession, false);
    assert.equal(o.permissionMode, "default");
    assert.equal(o.verbatimPrompts, true);
    assert.equal(o.cwd, "workdir");
    assert.equal(o.env, env);
    assert.equal(o.maxTurns, 20);
    assert.equal(o.maxBudgetUsd, 0.75);
    assert.equal(o.abortController, abortController);
    assert.equal(o.stderr, onStderr);
    assert.ok(!("allowedTools" in o) && !("fallbackModel" in o));
  });

  test("childEnv keeps PATH and the key, drops the other four and adds the two names", () => {
    const { env, dropped } = childEnv({ ...FAKE_BASE_ENV, UNSET_ONE: undefined }, "cfg");
    assert.deepEqual(env, { PATH: "p", ANTHROPIC_API_KEY: "test-not-a-key", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      CLAUDE_CONFIG_DIR: "cfg" });
    assert.deepEqual(dropped, FAKE_DROPPED);
  });

  test("buildOptions passes the fault seed and the stock delay as joined --flag=value args", () => {
    const { g } = newGuards();
    const argsFor = (faultSeed: number, stockDelayMs: number): string[] | undefined => {
      const o = buildOptions({ model: "claude-opus-5-5", effort: "medium", stockFault: "ok", faultSeed, stockDelayMs,
        catalogPath: "catalog.json", workDir: "workdir", env: {}, maxTurns: 20, maxBudgetUsd: 0.75,
        abortController: new AbortController(), canUseTool: g.canUseTool, hooks: g.hooks, onStderr: () => {} });
      const server = o.mcpServers?.["catalog"];
      assert.ok(server !== undefined && (server.type === undefined || server.type === "stdio"));
      return server.args;
    };
    assert.deepEqual(argsFor(-3, 0), [PATHS.serverEntry, "--catalog", "catalog.json", "--stock-fault", "ok",
      "--fault-seed=-3", "--stock-delay-ms=0"]);
    assert.deepEqual(argsFor(2, 2500)?.slice(5), ["--fault-seed=2", "--stock-delay-ms=2500"]);
    // A strict parseArgs (the server's flag parser is one) reads the joined negative seed, and refuses the split form.
    const flags = { catalog: { type: "string" }, "stock-fault": { type: "string" }, "fault-seed": { type: "string" },
      "stock-delay-ms": { type: "string" } } as const;
    const parsed = parseArgs({ args: argsFor(-3, 0)?.slice(1) ?? [], options: flags, strict: true });
    assert.equal(parsed.values["fault-seed"], "-3");
    assert.equal(parsed.values["stock-delay-ms"], "0");
    assert.throws(() => parseArgs({ args: ["--fault-seed", "-3"], options: flags, strict: true }));
  });
});

// ---------------------------------------------------------------- guards

describe("guards", () => {
  test("the 5 allowed names pass", async () => {
    const { g, denies } = newGuards();
    for (const name of [...CATALOG_TOOLS.map(fullToolName), STRUCTURED_OUTPUT_TOOL]) {
      const input = { partNumber: "QD-90001" };
      assert.deepEqual(await g.canUseTool(name, input, { signal, toolUseID: "toolu_a", requestId: "req_fixture" }),
        { behavior: "allow", updatedInput: input });
    }
    assert.equal(denies.length, 0);
  });

  test("Bash is denied with a message and one guard_denied, never null", async () => {
    const { g, denies } = newGuards();
    const r = await g.canUseTool("Bash", { command: "ls" }, { signal, toolUseID: "toolu_bash", requestId: "req_fixture" });
    assert.notEqual(r, null);
    assert.deepEqual(r, { behavior: "deny", message: "Not available at the quote desk: Bash" });
    assert.deepEqual(denies, [{ type: "guard_denied", tool: "Bash", toolUseId: "toolu_bash", by: "allowlist",
      reason: "Not available at the quote desk: Bash" }]);
  });

  test("a second identical check_stock is denied with retry_cap and the hook's tool_use_id", async () => {
    const { g, denies } = newGuards();
    const stock = fullToolName("check_stock");
    assert.deepEqual(await callHook(g.hooks, hookInput(stock, STOCK_INPUT, "toolu_s1")), {});
    assert.equal(denies.length, 0);
    assert.deepEqual(await callHook(g.hooks, hookInput(stock, STOCK_INPUT, "toolu_s2")), DENY_RETRY);
    assert.deepEqual(denies, [{ type: "guard_denied", tool: "check_stock", toolUseId: "toolu_s2", by: "retry_cap",
      reason: RETRY_CAP_REASON }]);
    assert.deepEqual(await callHook(g.hooks, hookInput(stock, STOCK_INPUT, "toolu_s3")), DENY_RETRY);
    assert.equal(denies.length, 2);
  });

  test("retry_cap takes toolUseId from input.tool_use_id, never the callback's second argument", async () => {
    const { g, denies } = newGuards();
    const stock = fullToolName("check_stock");
    const hook = preToolUseOf(g.hooks);
    assert.deepEqual(await hook(hookInput(stock, STOCK_INPUT, "toolu_in1"), "toolu_wrong", { signal }), {});
    assert.deepEqual(await hook(hookInput(stock, STOCK_INPUT, "toolu_in2"), "toolu_wrong", { signal }), DENY_RETRY);
    assert.deepEqual(await hook(hookInput(stock, STOCK_INPUT, "toolu_in3"), undefined, { signal }), DENY_RETRY);
    assert.deepEqual(denies.map((d) => [d.by, d.toolUseId]), [["retry_cap", "toolu_in2"], ["retry_cap", "toolu_in3"]]);
  });

  test("lines count separately, and an alias shares a key with its code", async () => {
    const { g, denies } = newGuards();
    const stock = fullToolName("check_stock");
    assert.deepEqual(await callHook(g.hooks, hookInput(stock, STOCK_INPUT, "toolu_1")), {});
    assert.deepEqual(await callHook(g.hooks, hookInput(stock, { ...STOCK_INPUT, quantity: 41 }, "toolu_2")), {});
    assert.deepEqual(await callHook(g.hooks, hookInput(stock, { ...STOCK_INPUT, partNumber: "QD-90002" }, "toolu_3")), {});
    assert.deepEqual(await callHook(g.hooks, hookInput(stock, { ...STOCK_INPUT, material: "SS-304" }, "toolu_4")), {});
    assert.equal(denies.length, 0);
    // "6061" is an alias of AL-6061-T6, and the part number is trimmed and upper-cased in the key.
    assert.deepEqual(await callHook(g.hooks,
      hookInput(stock, { material: "6061", partNumber: " qd-90001 ", quantity: 40 }, "toolu_5")), DENY_RETRY);
    assert.deepEqual(denies.map((d) => d.toolUseId), ["toolu_5"]);
    // An unknown material keys on its normalized text.
    assert.deepEqual(await callHook(g.hooks,
      hookInput(stock, { material: "Ti-6Al-4V", partNumber: "QD-90001", quantity: 40 }, "toolu_6")), {});
    assert.deepEqual(await callHook(g.hooks,
      hookInput(stock, { material: "  ti-6al-4v ", partNumber: "QD-90001", quantity: 40 }, "toolu_7")), DENY_RETRY);
  });

  test("other tools, other events and malformed tool_input return {}", async () => {
    const { g, denies } = newGuards();
    const stock = fullToolName("check_stock");
    for (const t of ["lookup_part", "price_material", "estimate_cycle_time"] as const) {
      assert.deepEqual(await callHook(g.hooks, hookInput(fullToolName(t), STOCK_INPUT, "toolu_x")), {});
      assert.deepEqual(await callHook(g.hooks, hookInput(fullToolName(t), STOCK_INPUT, "toolu_y")), {});
    }
    assert.deepEqual(await callHook(g.hooks, hookInput("Bash", { command: "ls" }, "toolu_b")), {});
    for (const bad of [null, "text", { ...STOCK_INPUT, quantity: "40" }, { material: "AL-6061-T6" }]) {
      assert.deepEqual(await callHook(g.hooks, hookInput(stock, bad, "toolu_bad")), {});
      assert.deepEqual(await callHook(g.hooks, hookInput(stock, bad, "toolu_bad2")), {});
    }
    const notification: NotificationHookInput = { session_id: fx.SESSION_ID, transcript_path: "transcript.jsonl",
      cwd: "workdir", hook_event_name: "Notification", message: "hello", notification_type: "info" };
    assert.deepEqual(await callHook(g.hooks, notification), {});
    assert.equal(denies.length, 0);
  });

  test("effortApplied is null before any hook call, then the first effort.level seen", async () => {
    const { g } = newGuards();
    assert.equal(g.effortApplied(), null);
    await callHook(g.hooks, hookInput(fullToolName("lookup_part"), { partNumber: "QD-90001" }, "toolu_1"));
    assert.equal(g.effortApplied(), null);
    await callHook(g.hooks, hookInput(STRUCTURED_OUTPUT_TOOL, {}, "toolu_2", "medium"));
    assert.equal(g.effortApplied(), "medium");
    await callHook(g.hooks, hookInput(fullToolName("lookup_part"), { partNumber: "QD-90001" }, "toolu_3", "high"));
    assert.equal(g.effortApplied(), "medium");
  });
});

// ---------------------------------------------------------------- mapper

function asEvent(body: DeskEventBody, seq = 0): DeskEvent {
  return { v: 1, runId: "run-fixture", seq, t: 0, ...body };
}
function assertValidEvents(bodies: DeskEventBody[]): void {
  bodies.forEach((b, i) => {
    const r = DeskEventSchema.safeParse(asEvent(b, i));
    assert.ok(r.success, `${b.type} fits DeskEventSchema: ${r.success ? "" : r.error.message}`);
  });
}

describe("event mapper", () => {
  test("init maps to session_init with model and permissionMode", () => {
    const m = createEventMapper();
    const out = m.map(fx.init());
    assert.equal(out.length, 1);
    const e = out[0];
    assert.ok(e !== undefined && e.type === "session_init");
    assert.equal(e.model, "claude-opus-5-5");
    assert.equal(e.permissionMode, "default");
    assert.deepEqual(e.tools, [STRUCTURED_OUTPUT_TOOL, ...CATALOG_TOOLS.map(fullToolName)]);
    assert.deepEqual(e.mcpServers, [{ name: "catalog", status: "connected" }]);
    assert.equal(e.skills.length, 18);
    assert.deepEqual(e.plugins, ["cc-plugin-agents-md", "cc-plugin-telemetry", "cc-plugin-privacy",
      "cc-plugin-plugin-authoring"]);
    assert.equal(e.apiKeySource, "ANTHROPIC_API_KEY");
    assert.equal(e.claudeCodeVersion, "2.1.321");
    assertValidEvents(out);
  });

  test("tool_call uses short names for catalog tools and verbatim names otherwise", () => {
    const m = createEventMapper();
    const a = m.map(fx.assistantToolUse("toolu_1", fullToolName("lookup_part"), { partNumber: "QD-90001" }));
    assert.deepEqual(a, [{ type: "tool_call", toolUseId: "toolu_1", tool: "lookup_part", input: { partNumber: "QD-90001" } }]);
    const b = m.map(fx.assistantToolUse("toolu_2", "Bash", { command: "ls" }));
    assert.deepEqual(b, [{ type: "tool_call", toolUseId: "toolu_2", tool: "Bash", input: { command: "ls" } }]);
    const c = m.map(fx.assistantToolUse("toolu_3", "mcp__catalog__slow_tool", {}));
    assert.equal(c[0]?.type === "tool_call" ? c[0].tool : null, "mcp__catalog__slow_tool");
    assertValidEvents([...a, ...b, ...c]);
  });

  test("the StructuredOutput call and its result are both dropped, and so is a result never recorded", () => {
    const m = createEventMapper();
    assert.deepEqual(m.map(fx.assistantToolUse("toolu_so", STRUCTURED_OUTPUT_TOOL, VALID_DRAFT)), []);
    assert.deepEqual(m.map(fx.userToolResult("toolu_so", fx.STRUCTURED_OUTPUT_ACK)), []);
    assert.deepEqual(m.map(fx.userToolResult("toolu_never", JSON.stringify(LOOKUP_OK))), []);
  });

  test("string and block tool_result content both parse", () => {
    let clock = 1000;
    const m = createEventMapper({ now: () => clock });
    m.map(fx.assistantToolUse("toolu_1", fullToolName("lookup_part"), { partNumber: "QD-90001" }));
    m.map(fx.assistantToolUse("toolu_2", fullToolName("check_stock"), STOCK_INPUT));
    clock = 1250;
    const s = m.map(fx.userToolResult("toolu_1", JSON.stringify(LOOKUP_OK)));
    assert.deepEqual(s, [{ type: "tool_result", toolUseId: "toolu_1", tool: "lookup_part", isError: false,
      data: LOOKUP_OK, text: JSON.stringify(LOOKUP_OK), ms: 250 }]);
    const b = m.map(fx.userToolResult("toolu_2", [{ type: "text", text: JSON.stringify(STOCK_OK) }]));
    assert.equal(b.length, 1);
    assert.ok(b[0]?.type === "tool_result");
    assert.deepEqual(b[0].data, STOCK_OK);
    assert.equal(b[0].text, JSON.stringify(STOCK_OK));
    assertValidEvents([...s, ...b]);
  });

  test("an isError ToolError parses, and non-JSON or MCP validation text gives data: null", () => {
    const m = createEventMapper();
    const stock = fullToolName("check_stock");
    const unavailable = { ok: false, code: "STOCK_UNAVAILABLE", message: "inventory service unavailable",
      suggestions: [], attempts: 3 };
    m.map(fx.assistantToolUse("toolu_1", stock, STOCK_INPUT));
    m.map(fx.assistantToolUse("toolu_2", stock, STOCK_INPUT));
    m.map(fx.assistantToolUse("toolu_3", stock, { ...STOCK_INPUT, quantity: 0 }));
    m.map(fx.assistantToolUse("toolu_4", stock, STOCK_INPUT));
    m.map(fx.assistantToolUse("toolu_5", fullToolName("lookup_part"), { partNumber: "QD-90001" }));
    const out = [
      ...m.map(fx.userToolResult("toolu_1", JSON.stringify(unavailable), true)),
      ...m.map(fx.userToolResult("toolu_2", fx.hookDenialText(RETRY_CAP_REASON), true)),
      ...m.map(fx.userToolResult("toolu_3", fx.MCP_VALIDATION_TEXT, true)),
      ...m.map(fx.userToolResult("toolu_4", fx.SERVER_TIMEOUT_TEXT, true)),
      // valid JSON in the wrong shape for the tool
      ...m.map(fx.userToolResult("toolu_5", JSON.stringify({ ...LOOKUP_OK, extra: 1 }))),
    ];
    const results = out.filter((e) => e.type === "tool_result");
    assert.equal(results.length, 5);
    assert.deepEqual(results.map((r) => r.isError), [true, true, true, true, false]);
    assert.deepEqual(results[0]?.data, unavailable);
    assert.deepEqual(results.slice(1).map((r) => r.data), [null, null, null, null]);
    assert.equal(results[2]?.text, fx.MCP_VALIDATION_TEXT);
    assertValidEvents(out);
  });

  test("text is cut at 2000 chars, and a long Ok result still parses", () => {
    const m = createEventMapper();
    const long: LookupPartOk = { ...LOOKUP_OK, description: "d".repeat(2500) };
    m.map(fx.assistantToolUse("toolu_1", fullToolName("lookup_part"), { partNumber: "QD-90001" }));
    const out = m.map(fx.userToolResult("toolu_1", JSON.stringify(long)));
    assert.ok(out[0]?.type === "tool_result");
    assert.equal(out[0].text.length, 2000);
    assert.deepEqual(out[0].data, long);
  });

  test("both refusal subtypes map to model_refusal", () => {
    const m = createEventMapper();
    const out = [...m.map(fx.refusalFallback()), ...m.map(fx.refusalFallback({ scope: "local", category: "cyber" })),
      ...m.map(fx.refusalNoFallback({ category: "bio" })), ...m.map(fx.refusalNoFallback())];
    assert.deepEqual(out, [
      { type: "model_refusal", fallback: true, originalModel: "claude-opus-5-5", fallbackModel: "claude-sonnet-5-5",
        scope: "session", category: null },
      { type: "model_refusal", fallback: true, originalModel: "claude-opus-5-5", fallbackModel: "claude-sonnet-5-5",
        scope: "local", category: "cyber" },
      { type: "model_refusal", fallback: false, originalModel: "claude-opus-5-5", fallbackModel: null, scope: null,
        category: "bio" },
      { type: "model_refusal", fallback: false, originalModel: "claude-opus-5-5", fallbackModel: null, scope: null,
        category: null },
    ]);
    assertValidEvents(out);
  });

  test("an assistant error code is kept", () => {
    const m = createEventMapper();
    assert.equal(m.lastAssistantError(), null);
    m.map(fx.assistantError("rate_limit"));
    m.map(fx.assistantError("overloaded"));
    assert.equal(m.lastAssistantError(), "overloaded");
    m.map(fx.assistantError(""));
    m.map(fx.assistantText("still here"));
    assert.equal(m.lastAssistantError(), "overloaded");
  });

  test("text becomes assistant_text, while blank text and thinking are skipped", () => {
    const m = createEventMapper();
    assert.deepEqual(m.map(fx.assistantText("Looking up QD-90001.")), [{ type: "assistant_text", text: "Looking up QD-90001." }]);
    assert.deepEqual(m.map(fx.assistantText("  \n ")), []);
    assert.deepEqual(m.map(fx.assistantThinking("private reasoning")), []);
  });

  test("unknown types are ignored", () => {
    const m = createEventMapper();
    assert.deepEqual(m.map(fx.unknownType()), []);
    assert.deepEqual(m.map(fx.thinkingTokens()), []);
    assert.deepEqual(m.map(fx.resultSuccess({ structuredOutput: VALID_DRAFT })), []);
  });
});

// ---------------------------------------------------------------- scrubbing

const HOME = homedir();
const TMP = tmpdir();
const USER = ((): string | null => {
  try {
    return userInfo().username;
  } catch {
    return null;
  }
})();
function spellingsOf(p: string): string[] {
  return [p, p.split("\\").join("/"), p.split("\\").join("\\\\")];
}
/** True when text holds the home dir, the temp dir or the user name in any spelling the scrub covers. */
function leaks(text: string): string | null {
  const lower = text.toLowerCase();
  for (const p of [...spellingsOf(HOME), ...spellingsOf(TMP)]) {
    if (p.length >= 3 && lower.includes(p.toLowerCase())) return "a home or temp path";
  }
  if (USER !== null && USER.length >= 3) {
    const escaped = USER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`, "i").test(text)) return "the user name";
  }
  return null;
}

describe("scrubText", () => {
  test("turns the home dir in three spellings, plus the user name, into ~ and <user>", () => {
    const [native, forward, escaped] = spellingsOf(HOME);
    const tail = `error at ${native}${sep}a.ts\nlog ${forward}/b.ts\njson "${escaped}\\\\c.ts"\n` +
      `upper ${HOME.toUpperCase()}${sep}d.ts\nwho ${USER ?? "nobody"} ran it\ntemp ${TMP}${sep}e.txt`;
    const out = scrubText(tail);
    assert.equal(leaks(out), null);
    assert.ok(out.includes(`error at ~${sep}a.ts`));
    assert.ok(out.includes("log ~/b.ts"));
    assert.ok(out.includes(`json "~\\\\c.ts"`));
    assert.ok(out.includes(`upper ~${sep}d.ts`));
    if (USER !== null && USER.length >= 3) assert.ok(out.includes("who <user> ran it"));
    assert.ok(out.includes(`temp <tmp>${sep}e.txt`));
  });

  test("a Windows-shaped temp dir inside the home dir becomes <tmp>, not ~", () => {
    const bs = "\\";
    // A made-up drive and folders: Windows-shaped, but no real profile layout.
    const home = ["Q:", "Desk", "deskuser"].join(bs);
    const tmp = [home, "Work", "Spool"].join(bs);
    const scrub = createScrubber({ home, tmp, user: "deskuser" });
    assert.equal(scrub(`${tmp}${bs}quote-desk-1 and ${home}${bs}x`), `<tmp>${bs}quote-desk-1 and ~${bs}x`);
    assert.equal(scrub("q:/desk/DESKUSER/work/spool/q"), "<tmp>/q");
    assert.equal(scrub(`"Q:${bs}${bs}Desk${bs}${bs}deskuser${bs}${bs}y"`), `"~${bs}${bs}y"`);
    assert.equal(scrub("deskuser and deskusers and DeskUser"), "<user> and deskusers and <user>");
    assert.equal(createScrubber({ home: "/", tmp: "/t", user: "ab" })("/a/b ab"), "/a/b ab");
  });

  test("the MSYS, JSON-inside-JSON and URL-encoded spellings of a home dir are scrubbed", () => {
    const bs = "\\";
    // A made-up drive and user, built from parts so no line looks like a real profile path.
    const home = ["Q:", "Desk", "example-user"].join(bs);
    const scrub = createScrubber({ home, tmp: [home, "Work", "Spool"].join(bs), user: "example-user" });
    assert.equal(scrub(["", "q", "Desk", "example-user", "notes"].join("/")), "~/notes");
    assert.equal(scrub(["", "q", "Desk", "example-user", "Work", "Spool", "x"].join("/")), "<tmp>/x");
    assert.equal(scrub(`"${["Q:", "Desk", "example-user", "notes"].join(bs.repeat(4))}"`), `"~${bs.repeat(4)}notes"`);
    assert.equal(scrub(encodeURIComponent(`${home}${bs}notes`)), "~%5Cnotes");
    assert.equal(scrub(encodeURIComponent(`${home}${bs}notes`).toLowerCase()), "~%5cnotes");
    assert.equal(scrub(encodeURIComponent(["Q:", "Desk", "example-user", "notes"].join("/"))), "~%2Fnotes");
    // The user name after a URL-encoded separator, in a path that isn't the home dir.
    assert.equal(scrub(encodeURIComponent(["R:", "share", "example-user", "x"].join(bs))), "R%3A%5Cshare%5C<user>%5Cx");
    assert.equal(scrub("R%3A%2Fshare%2Fexample-user%2Fx"), "R%3A%2Fshare%2F<user>%2Fx");
  });

  test("an API key shape and the run's literal key become <key>", () => {
    const scrub = createScrubber({ home: "Q:", tmp: "Q:", user: null, key: "literal-env-secret-42" });
    assert.equal(scrub(`ANTHROPIC_API_KEY=${FAKE_KEY} and literal-env-secret-42.`), "ANTHROPIC_API_KEY=<key> and <key>.");
    assert.equal(scrub(`${KEY_PREFIX}-short stays`), `${KEY_PREFIX}-short stays`, "under 8 characters after the prefix");
    assert.equal(createScrubber({ home: "Q:", tmp: "Q:", user: null, key: "seven77" })("seven77"), "seven77");
    assert.equal(scrubText(`auth ${FAKE_KEY}`), "auth <key>", "the default scrubber knows the shape too");
  });
});

// ---------------------------------------------------------------- runQuote

type Script = (options: Options) => AsyncGenerator<SDKMessage, void, undefined>;

const fakeFinalize: FinalizeQuote = (draft, ctx) => ({ rfqId: draft.rfqId, customer: draft.customer,
  status: draft.status, lines: draft.lines.map((l) => ({ ...l, unitPriceUsd: null, extendedUsd: null })),
  assumptions: draft.assumptions, openQuestions: draft.openQuestions, marginPct: ctx.marginPct, totalUsd: null,
  consistencyErrors: [], meta: { runId: ctx.runId, model: ctx.model, effort: ctx.effort, promptHash: ctx.promptHash,
    catalogHash: ctx.catalogHash, createdAt: ctx.createdAt } });

const fakeGate: ApproveAndSend = async function* (quote, approver) {
  yield { type: "approval_requested", rfqId: quote.rfqId, totalUsd: quote.totalUsd };
  const decision = approver === undefined ? "decline" : await approver(quote);
  yield { type: "approval_resolved", decision };
  const outcome = decision === "approve" ? "sent" : "declined";
  yield { type: "delivery", outcome, file: decision === "approve" ? `${quote.rfqId}.json` : null, reason: null };
  return outcome;
};

type Harness = { deps: RunQuoteDeps; calls: { prompt: string; options: Options }[] };

function harness(script: Script): Harness {
  const calls: { prompt: string; options: Options }[] = [];
  const deps: RunQuoteDeps = {
    query: (p) => {
      calls.push(p);
      return script(p.options);
    },
    finalizeQuote: fakeFinalize,
    approveAndSend: fakeGate,
    loadCatalog,
    env: FAKE_BASE_ENV,
  };
  return { deps, calls };
}

async function collect(gen: AsyncGenerator<DeskEvent, void, undefined>, onEvent?: (e: DeskEvent) => void):
  Promise<DeskEvent[]> {
  const out: DeskEvent[] = [];
  for await (const e of gen) {
    out.push(e);
    onEvent?.(e);
  }
  return out;
}

async function run(script: Script, opts: RunOptions = {}, onEvent?: (e: DeskEvent) => void,
  patch: Partial<RunQuoteDeps> = {}, rfq: Rfq = AD_HOC_RFQ) {
  const h = harness(script);
  const events = await collect(createRunQuote({ ...h.deps, ...patch })(rfq,
    { catalogPath: MINI_CATALOG, stockDelayMs: 0, ...opts }), onEvent);
  checkEnvelope(events);
  const last = events[events.length - 1];
  assert.ok(last !== undefined && last.type === "run_finished");
  return { events, finished: last, calls: h.calls };
}

/** run_started first, exactly one run_finished last, seq strictly increasing, one runId, v 1, every event valid. */
function checkEnvelope(events: DeskEvent[]): void {
  assert.ok(events.length >= 2);
  assert.equal(events[0]?.type, "run_started");
  assert.equal(events[events.length - 1]?.type, "run_finished");
  assert.equal(events.filter((e) => e.type === "run_finished").length, 1);
  const runId = events[0]?.runId;
  events.forEach((e, i) => {
    assert.equal(e.v, 1);
    assert.equal(e.runId, runId);
    assert.equal(e.seq, i);
    if (i > 0) assert.ok(e.t >= (events[i - 1]?.t ?? 0));
    const r = DeskEventSchema.safeParse(e);
    assert.ok(r.success, `${e.type} fits DeskEventSchema: ${r.success ? "" : r.error.message}`);
  });
  const started = events[0];
  assert.ok(started?.type === "run_started");
  assert.deepEqual(started.droppedEnvNames, FAKE_DROPPED);
  for (const name of started.droppedEnvNames) {
    assert.ok(!Object.values(FAKE_BASE_ENV).includes(name), "names only, never values");
  }
}

function waitForAbort(options: Options): Promise<never> {
  const s = options.abortController?.signal;
  assert.ok(s, "the runner passes an abortController");
  return new Promise<never>((_, reject) => {
    const fail = (): void => reject(new Error("The operation was aborted"));
    if (s.aborted) fail();
    else s.addEventListener("abort", fail, { once: true });
  });
}

async function canUse(options: Options, name: string, input: Record<string, unknown>, id: string) {
  assert.ok(options.canUseTool, "the runner passes canUseTool");
  const r = await options.canUseTool(name, input, { signal, toolUseID: id, requestId: "req_fixture" });
  assert.ok(r !== null, "canUseTool never returns null");
  return r;
}

const types = (events: DeskEvent[]): string[] => events.map((e) => e.type);

describe("createRunQuote", () => {
  test("valid draft: quote, fake gate events, ok", async () => {
    const stock = fullToolName("check_stock");
    let cwd = "";
    const { events, finished, calls } = await run(async function* (o) {
      cwd = o.cwd ?? "";
      yield fx.init();
      yield fx.thinkingTokens();
      assert.equal((await canUse(o, "Bash", { command: "ls" }, "toolu_bash")).behavior, "deny");
      yield fx.assistantToolUse("toolu_s1", stock, STOCK_INPUT);
      assert.deepEqual(await callHook(o.hooks, hookInput(stock, STOCK_INPUT, "toolu_s1", "medium")), {});
      assert.equal((await canUse(o, stock, STOCK_INPUT, "toolu_s1")).behavior, "allow");
      yield fx.userToolResult("toolu_s1", JSON.stringify(STOCK_OK));
      const again = { material: "6061", partNumber: "QD-90001", quantity: 40 };
      assert.deepEqual(await callHook(o.hooks, hookInput(stock, again, "toolu_s2", "medium")), DENY_RETRY);
      yield fx.assistantToolUse("toolu_s2", stock, again);
      yield fx.userToolResult("toolu_s2", fx.hookDenialText(RETRY_CAP_REASON), true);
      await callHook(o.hooks, hookInput(STRUCTURED_OUTPUT_TOOL, VALID_DRAFT, "toolu_so", "medium"));
      yield fx.assistantToolUse("toolu_so", STRUCTURED_OUTPUT_TOOL, VALID_DRAFT);
      yield fx.userToolResult("toolu_so", fx.STRUCTURED_OUTPUT_ACK);
      yield fx.unknownType();
      yield fx.resultSuccess({ structuredOutput: VALID_DRAFT });
    }, { approver: async () => "approve" });

    assert.deepEqual(types(events), ["run_started", "session_init", "guard_denied", "tool_call", "tool_result",
      "guard_denied", "tool_call", "tool_result", "quote", "approval_requested", "approval_resolved", "delivery",
      "run_finished"]);
    const denied = events.filter((e) => e.type === "guard_denied");
    assert.deepEqual(denied.map((d) => [d.by, d.tool, d.toolUseId]),
      [["allowlist", "Bash", "toolu_bash"], ["retry_cap", "check_stock", "toolu_s2"]]);
    const results = events.filter((e) => e.type === "tool_result");
    assert.deepEqual(results.map((r) => [r.isError, r.data === null]), [[false, false], [true, true]]);
    const quote = events.find((e) => e.type === "quote");
    assert.ok(quote?.type === "quote");
    assert.equal(quote.quote.rfqId, "ADHOC-7");
    assert.equal(quote.quote.meta.promptHash, PROMPT_HASH);
    assert.equal(quote.quote.meta.runId, finished.runId);
    assert.equal(quote.quote.marginPct, catalog.marginPct);
    assert.equal(finished.ok, true);
    assert.equal(finished.failure, null);
    assert.equal(finished.detail, null);
    assert.equal(finished.delivery, "sent");
    assert.equal(finished.effortApplied, "medium");
    assert.equal(finished.costUsd, fx.TOTAL_COST_USD);
    assert.equal(finished.turns, fx.NUM_TURNS);
    assert.deepEqual(finished.modelsUsed, ["claude-opus-5-5", "claude-haiku-5-5"]);
    assert.deepEqual(finished.usage, { inputTokens: 1406, outputTokens: 558, cacheReadInputTokens: 4533,
      cacheCreationInputTokens: 2582 });
    const started = events[0];
    assert.ok(started?.type === "run_started");
    assert.equal(started.rfqId, "ADHOC-7");
    assert.match(started.catalogHash, /^[0-9a-f]{12}$/);
    assert.equal(started.promptHash, PROMPT_HASH);
    // The query got the user prompt, the child env and a temp work dir that is gone afterwards.
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.prompt, buildUserPrompt(AD_HOC_RFQ));
    const env = calls[0]?.options.env;
    assert.equal(env?.["ANTHROPIC_API_KEY"], "test-not-a-key");
    assert.equal(env?.["CLAUDE_CONFIG_DIR"], join(cwd, "config"));
    assert.equal(env?.["CLAUDE_EFFORT"], undefined);
    assert.ok(cwd.includes("quote-desk-"));
    assert.equal(existsSync(cwd), false, "the work dir is removed");
  });

  test("runQuote accepts an ad hoc Rfq that isn't in any data file", async () => {
    const { finished } = await run(async function* () {
      yield fx.init();
      yield fx.resultSuccess({ structuredOutput: VALID_DRAFT });
    });
    assert.equal(finished.ok, true);
    assert.equal(finished.delivery, "declined"); // the fake gate declines without an approver
  });

  test("success with no structured_output: no_structured_output", async () => {
    const { events, finished } = await run(async function* () {
      yield fx.init();
      yield fx.resultSuccess({ result: "I could not finish the quote." });
    });
    assert.equal(finished.ok, false);
    assert.equal(finished.failure, "no_structured_output");
    assert.equal(finished.delivery, "not_attempted");
    assert.ok(!types(events).includes("quote"));
  });

  test("success with is_error and api_error_status 529: sdk_error, a trial error", async () => {
    const { finished } = await run(async function* () {
      yield fx.init();
      yield fx.assistantError("overloaded");
      yield fx.resultSuccess({ isError: true, apiErrorStatus: 529, result: "API Error: 529 Overloaded" });
      throw new Error("Claude Code returned an error result: API Error: 529 Overloaded");
    });
    assert.equal(finished.failure, "sdk_error");
    assert.ok(INFRA_FAILURES.includes("sdk_error"), "sdk_error scores as a trial error");
    assert.equal(finished.detail, "api 529: API Error: 529 Overloaded; assistant error: overloaded");
    assert.equal(finished.costUsd, fx.TOTAL_COST_USD);
  });

  test("bad draft: invalid_draft", async () => {
    const { finished } = await run(async function* () {
      yield fx.init();
      yield fx.resultSuccess({ structuredOutput: { ...VALID_DRAFT, status: "approved" } });
    });
    assert.equal(finished.failure, "invalid_draft");
    assert.ok(finished.detail?.includes("status"));
    assert.equal(finished.delivery, "not_attempted");
  });

  test("error_max_turns, then a throw: max_turns", async () => {
    const { finished } = await run(async function* () {
      yield fx.init();
      yield fx.resultError("error_max_turns", ["Reached maximum number of turns (20)"]);
      throw new Error("Claude Code returned an error result: Reached maximum number of turns (20)");
    });
    assert.equal(finished.failure, "max_turns");
    assert.equal(finished.detail, "Reached maximum number of turns (20)");
    assert.equal(finished.turns, 20);
  });

  test("the other error subtypes map to budget, structured_output and sdk_error", async () => {
    const cases: [fx.ErrorSubtype, string][] = [["error_max_budget_usd", "budget"],
      ["error_max_structured_output_retries", "structured_output"], ["error_during_execution", "sdk_error"]];
    for (const [subtype, failure] of cases) {
      const { finished } = await run(async function* () {
        yield fx.init();
        yield fx.resultError(subtype, ["first", "second"]);
        throw new Error("Claude Code returned an error result");
      });
      assert.equal(finished.failure, failure);
      assert.equal(finished.detail, "first; second");
    }
  });

  test("catalog failed at init: mcp_unavailable", async () => {
    let aborted = false;
    const { finished } = await run(async function* (o) {
      yield fx.init({ catalogStatus: "failed" });
      try {
        await waitForAbort(o);
      } finally {
        aborted = o.abortController?.signal.aborted === true;
      }
    });
    assert.equal(finished.failure, "mcp_unavailable");
    assert.equal(finished.detail, "catalog server status: failed");
    assert.equal(aborted, true);
  });

  test("wallClockMs 50: wall_clock", async () => {
    const t0 = Date.now();
    const { finished } = await run(async function* (o) {
      yield fx.init();
      await waitForAbort(o);
    }, { wallClockMs: 50 });
    assert.equal(finished.failure, "wall_clock");
    assert.ok(Date.now() - t0 < 5000);
  });

  test("wallClockMs 50 holds even when the stream ignores the abort", async () => {
    const { finished } = await run(async function* () {
      yield fx.init();
      await new Promise<void>(() => {}); // never settles
    }, { wallClockMs: 50 });
    assert.equal(finished.failure, "wall_clock");
  });

  test("a kept valid-draft result, then a hang past wallClockMs: wall_clock wins", async () => {
    const { events, finished } = await run(async function* (o) {
      yield fx.init();
      yield fx.resultSuccess({ structuredOutput: VALID_DRAFT });
      await waitForAbort(o);
    }, { wallClockMs: 50 });
    assert.equal(finished.failure, "wall_clock");
    assert.equal(finished.delivery, "not_attempted");
    assert.ok(!types(events).includes("quote"));
  });

  test("a kept valid-draft result, then a failed catalog init: mcp_unavailable wins", async () => {
    const { events, finished } = await run(async function* (o) {
      yield fx.resultSuccess({ structuredOutput: VALID_DRAFT });
      yield fx.init({ catalogStatus: "failed" });
      await waitForAbort(o);
    });
    assert.equal(finished.failure, "mcp_unavailable");
    assert.equal(finished.detail, "catalog server status: failed");
    assert.ok(!types(events).includes("quote"));
  });

  test("an is_error success that carries a valid structured_output: sdk_error, no quote", async () => {
    const { events, finished } = await run(async function* () {
      yield fx.init();
      yield fx.resultSuccess({ isError: true, apiErrorStatus: 401, result: "bad key", structuredOutput: VALID_DRAFT });
      throw new Error("Claude Code returned an error result: bad key");
    });
    assert.equal(finished.failure, "sdk_error");
    assert.equal(finished.detail, "api 401: bad key");
    assert.equal(finished.delivery, "not_attempted");
    assert.ok(!types(events).includes("quote"));
  });

  test("stderr past 4 KB: the detail keeps only the last 4096 chars", async () => {
    const { finished } = await run(async function* (o) {
      o.stderr?.("a".repeat(1000));
      o.stderr?.("b".repeat(2000));
      yield fx.init();
      o.stderr?.("c".repeat(2000));
      throw new Error("Claude Code process exited with code 1");
    });
    assert.equal(finished.failure, "sdk_error");
    const prefix = "Claude Code process exited with code 1; stderr: ";
    assert.ok(finished.detail !== null && finished.detail.startsWith(prefix));
    const tail = finished.detail.slice(prefix.length);
    assert.equal(tail.length, 4096);
    assert.equal(tail, "a".repeat(96) + "b".repeat(2000) + "c".repeat(2000));
  });

  test("the caller's signal: aborted", async () => {
    const caller = new AbortController();
    const { finished } = await run(async function* (o) {
      yield fx.init();
      await waitForAbort(o);
    }, { signal: caller.signal }, (e) => { if (e.type === "session_init") caller.abort(); });
    assert.equal(finished.failure, "aborted");
  });

  test("model_refusal_no_fallback, then success with no structured_output: refusal", async () => {
    const { events, finished } = await run(async function* () {
      yield fx.init();
      yield fx.refusalNoFallback({ category: "cyber" });
      yield fx.resultSuccess({ result: "" });
    });
    assert.ok(types(events).includes("model_refusal"));
    assert.equal(finished.failure, "refusal");
  });

  test("invalid options: missing catalog, stockFault hang, stockDelayMs 3000", async () => {
    const cases: [RunOptions, string][] = [
      [{ catalogPath: join(PATHS.miniDir, "no-such-catalog.json") }, "no-such-catalog.json: cannot read the file"],
      [{ stockFault: "hang" }, "invalid stock fault: hang"],
      [{ stockDelayMs: 3000 }, "stockDelayMs must be 0 to 2500, got 3000"],
    ];
    for (const [opts, detail] of cases) {
      const { events, finished, calls } = await run(async function* () {
        yield fx.init();
      }, opts);
      assert.deepEqual(types(events), ["run_started", "run_finished"]);
      const started = events[0];
      assert.ok(started?.type === "run_started");
      assert.equal(started.catalogHash, "");
      assert.equal(finished.ok, false);
      assert.equal(finished.failure, "invalid_options");
      assert.ok(finished.detail?.startsWith(detail), `${finished.detail} starts with ${detail}`);
      assert.equal(finished.costUsd, null);
      assert.equal(finished.usage, null);
      assert.equal(finished.effortApplied, null);
      assert.equal(finished.turns, null);
      assert.deepEqual(finished.modelsUsed, []);
      assert.equal(finished.delivery, "not_attempted");
      assert.equal(calls.length, 0, "query is never called");
      assert.equal(leaks(JSON.stringify(events)), null);
    }
  });

  test("invalid options: a fractional or unsafe faultSeed, a fractional stockDelayMs, an RFQ id that isn't a file name",
    async () => {
      const cases: [RunOptions, Rfq, string][] = [
        [{ faultSeed: 1.5 }, AD_HOC_RFQ, "faultSeed must be a safe integer, got 1.5"],
        [{ faultSeed: 2 ** 53 }, AD_HOC_RFQ, "faultSeed must be a safe integer"],
        [{ stockDelayMs: 50.5 }, AD_HOC_RFQ, "stockDelayMs must be a whole number, got 50.5"],
        [{}, { ...AD_HOC_RFQ, id: "../outbox-escape" }, "the RFQ id is not a plain file name"],
        [{}, { ...AD_HOC_RFQ, id: "Q 7" }, "the RFQ id is not a plain file name"],
        [{}, { ...AD_HOC_RFQ, id: "x".repeat(65) }, "the RFQ id is not a plain file name"],
      ];
      for (const [opts, rfq, detail] of cases) {
        const { events, finished, calls } = await run(async function* () {
          yield fx.init();
        }, opts, undefined, {}, rfq);
        assert.deepEqual(types(events), ["run_started", "run_finished"]);
        assert.equal(finished.failure, "invalid_options");
        assert.ok(finished.detail?.startsWith(detail), `${finished.detail} starts with ${detail}`);
        assert.equal(finished.ok, false);
        assert.equal(finished.delivery, "not_attempted");
        assert.equal(calls.length, 0, "query is never called");
      }
      // A negative seed is a safe integer and passes.
      const { calls } = await run(async function* () {
        yield fx.init();
      }, { faultSeed: -3 });
      assert.equal(calls.length, 1);
    });

  test("the stream ends after init with no result: null cost, usage and turns", async () => {
    const { finished } = await run(async function* () {
      yield fx.init();
    });
    assert.equal(finished.failure, "sdk_error");
    assert.equal(finished.costUsd, null);
    assert.equal(finished.usage, null);
    assert.equal(finished.turns, null);
    assert.deepEqual(finished.modelsUsed, []);
    assert.ok(finished.detail?.startsWith("the stream ended without a result"));
  });

  test("a throw with no result: sdk_error with the stderr tail and the assistant error code", async () => {
    const { finished } = await run(async function* (o) {
      o.stderr?.("spawn warning: one\n");
      yield fx.init();
      yield fx.assistantError("authentication_failed");
      throw new Error("Claude Code process exited with code 1");
    });
    assert.equal(finished.failure, "sdk_error");
    assert.equal(finished.detail,
      "Claude Code process exited with code 1; assistant error: authentication_failed; stderr: spawn warning: one\n");
  });

  test("a finalizeQuote that throws: sdk_error, no quote, ok false", async () => {
    const { events, finished } = await run(async function* () {
      yield fx.init();
      yield fx.resultSuccess({ structuredOutput: VALID_DRAFT });
    }, {}, undefined, { finalizeQuote: () => { throw new Error("finalize broke"); } });
    assert.ok(!types(events).includes("quote"));
    assert.equal(finished.ok, false);
    assert.equal(finished.failure, "sdk_error");
    assert.equal(finished.detail, "finalize: finalize broke");
    assert.equal(finished.delivery, "not_attempted");
  });

  test("a consumer that stops early: the query is aborted and closed, and the work dir is removed", async () => {
    let closedAborted: boolean | null = null;
    const h = harness(async function* (o) {
      try {
        yield fx.init();
        yield fx.assistantText("more to come");
      } finally {
        closedAborted = o.abortController?.signal.aborted === true;
      }
    });
    const gen = createRunQuote(h.deps)(AD_HOC_RFQ, { catalogPath: MINI_CATALOG, stockDelayMs: 0 });
    for await (const e of gen) if (e.type === "session_init") break;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(closedAborted, true, "the stream was closed after the controller aborted");
    const cwd = h.calls[0]?.options.cwd;
    assert.ok(cwd !== undefined && cwd.includes("quote-desk-"));
    assert.equal(existsSync(cwd), false);
  });

  test("no event JSON contains the home dir, temp dir or user name", async () => {
    const [, forward, escaped] = spellingsOf(HOME);
    const who = USER ?? "nobody";
    const { events, finished } = await run(async function* (o) {
      o.stderr?.(`cache at ${HOME}${sep}cache and ${TMP}${sep}x, json "${escaped}", user ${who}\n`);
      yield fx.init();
      yield fx.assistantText(`Reading ${forward}/notes.txt for ${who}`);
      await canUse(o, "Bash", { command: `type ${HOME}${sep}secret.txt` }, "toolu_b");
      yield fx.assistantToolUse("toolu_b", "Bash", { command: `type ${HOME}${sep}secret.txt` });
      yield fx.userToolResult("toolu_b", `denied for ${HOME}`, true);
      throw new Error(`failed in ${TMP}${sep}quote-desk-x`);
    });
    assert.equal(finished.failure, "sdk_error");
    assert.ok(finished.detail?.includes("stderr: cache at ~"));
    for (const e of events) assert.equal(leaks(JSON.stringify(e)), null, `${e.type} leaks`);
  });

  // ---- a gate or approver that throws (spec 5.9 step 8 as amended: ok means a quote exists and no failure)

  const validDraftScript: Script = async function* () {
    yield fx.init();
    yield fx.resultSuccess({ structuredOutput: VALID_DRAFT });
  };

  function assertGateFailure(events: DeskEvent[], finished: Extract<DeskEvent, { type: "run_finished" }>,
    detail: string): void {
    assert.equal(finished.ok, false);
    assert.equal(finished.failure, "sdk_error");
    assert.equal(finished.detail, detail);
    assert.ok(finished.detail?.startsWith("approve and send: "));
    assert.equal(finished.delivery, "not_attempted");
    assert.ok(!types(events).includes("delivery"), "no delivery event on this path");
    assert.equal(finished.costUsd, fx.TOTAL_COST_USD, "the result's cost still lands");
  }

  test("an approver that throws inside the gate: sdk_error, ok false, delivery not_attempted", async () => {
    const { events, finished } = await run(validDraftScript, { approver: async () => { throw new Error("tty gone"); } });
    assert.deepEqual(types(events), ["run_started", "session_init", "quote", "approval_requested", "run_finished"]);
    assertGateFailure(events, finished, "approve and send: tty gone");
  });

  test("a gate that yields approval_requested and then throws: sdk_error, nothing more from the gate", async () => {
    let returned = false;
    const gate: ApproveAndSend = async function* (quote) {
      try {
        yield { type: "approval_requested", rfqId: quote.rfqId, totalUsd: quote.totalUsd };
        throw new Error("EEXIST: outbox is a file");
      } finally {
        returned = true;
      }
    };
    const { events, finished } = await run(validDraftScript, { approver: async () => "approve" }, undefined,
      { approveAndSend: gate });
    assert.deepEqual(types(events), ["run_started", "session_init", "quote", "approval_requested", "run_finished"]);
    assertGateFailure(events, finished, "approve and send: EEXIST: outbox is a file");
    assert.equal(returned, true);
  });

  test("a gate whose first next() throws: sdk_error, ok false, delivery not_attempted", async () => {
    const gate: ApproveAndSend = async function* () {
      throw new Error("disk full");
    };
    const { events, finished } = await run(validDraftScript, {}, undefined, { approveAndSend: gate });
    assert.deepEqual(types(events), ["run_started", "session_init", "quote", "run_finished"]);
    assertGateFailure(events, finished, "approve and send: disk full");
  });

  // ---- closing the stream before the work dir goes (Windows keeps a child's cwd locked until it exits)

  /** A query that yields init, then waits for the abort (or forever), with the given return(). */
  function handQuery(onOptions: (o: Options) => void, ignoreAbort: boolean,
    close: () => Promise<IteratorResult<SDKMessage>>): RunQuoteDeps["query"] {
    return ({ options }) => {
      onOptions(options);
      let sentInit = false;
      return {
        [Symbol.asyncIterator]: (): AsyncIterator<SDKMessage> => ({
          next: async (): Promise<IteratorResult<SDKMessage>> => {
            if (!sentInit) {
              sentInit = true;
              return { done: false, value: fx.init() };
            }
            return ignoreAbort ? new Promise<never>(() => {}) : waitForAbort(options);
          },
          return: close,
        }),
      };
    };
  }

  test("an early end waits for the stream to close before it removes the work dir", async () => {
    let cwd = "";
    let dirWhileClosing: boolean | null = null;
    const query = handQuery((o) => { cwd = o.cwd ?? ""; }, false, async () => {
      await delay(300); // the SDK's return() waits for the CLI child to exit
      dirWhileClosing = existsSync(cwd);
      return { done: true, value: undefined };
    });
    const { finished } = await run(async function* () {}, { wallClockMs: 50 }, undefined, { query });
    assert.equal(finished.failure, "wall_clock");
    assert.ok(cwd.includes("quote-desk-"));
    assert.equal(dirWhileClosing, true, "the work dir is still there while the stream closes");
    assert.equal(existsSync(cwd), false, "and gone once the run has ended");
  });

  test("a stream whose return() never settles still ends the run, and the work dir is removed",
    { timeout: 20_000 }, async () => {
      let cwd = "";
      const query = handQuery((o) => { cwd = o.cwd ?? ""; }, true, () => new Promise<never>(() => {}));
      const t0 = Date.now();
      const { finished } = await run(async function* () {}, { wallClockMs: 50 }, undefined, { query });
      assert.equal(finished.failure, "wall_clock");
      assert.ok(Date.now() - t0 < 10_000, "the close wait is bounded");
      assert.equal(existsSync(cwd), false);
    });

  // ---- keys and model-written free text

  test("an API key in assistant text, tool results, result errors, the detail and stderr becomes <key>", async () => {
    const stock = fullToolName("check_stock");
    const toolError = { ok: false, code: "INVALID_INPUT", message: `bad header ${FAKE_KEY}`, suggestions: [],
      attempts: null };
    const withResult = await run(async function* (o) {
      o.stderr?.(`auth ${FAKE_KEY}\n`);
      yield fx.init();
      yield fx.assistantText(`The key is ${FAKE_KEY}, and the env one is test-not-a-key.`);
      yield fx.assistantToolUse("toolu_k", stock, { ...STOCK_INPUT, note: FAKE_KEY });
      yield fx.userToolResult("toolu_k", JSON.stringify(toolError), true);
      yield fx.resultError("error_during_execution", [`auth ${FAKE_KEY}`, "env test-not-a-key"]);
      throw new Error("Claude Code returned an error result");
    });
    assert.equal(withResult.finished.detail, "auth <key>; env <key>");
    const result = withResult.events.find((e) => e.type === "tool_result");
    assert.ok(result?.type === "tool_result" && result.data !== null && !result.data.ok);
    assert.equal(result.data.message, "bad header <key>");
    const noResult = await run(async function* (o) {
      o.stderr?.(`auth ${FAKE_KEY} with test-not-a-key\n`);
      yield fx.init();
      throw new Error(`exited: bad key ${FAKE_KEY}`);
    });
    assert.equal(noResult.finished.detail, "exited: bad key <key>; stderr: auth <key> with <key>\n");
    for (const e of [...withResult.events, ...noResult.events]) {
      const json = JSON.stringify(e);
      assert.ok(!json.includes(KEY_PREFIX) && !json.includes("test-not-a-key"), `${e.type} holds a key`);
    }
  });

  test("a key that straddles the 4 KB stderr cut leaves no fragment in the detail", async () => {
    const { finished } = await run(async function* (o) {
      o.stderr?.(`auth ${FAKE_KEY}\n`);
      o.stderr?.("y".repeat(4096 - 21));
      yield fx.init();
      throw new Error("Claude Code process exited with code 1");
    });
    const detail = finished.detail ?? "";
    assert.ok(!detail.includes(FAKE_KEY.slice(-20)), "no tail of the key");
    assert.ok(detail.endsWith(`stderr: auth <key>\n${"y".repeat(4096 - 21)}`));
  });

  test("a draft's assumptions and question text are scrubbed before finalizeQuote, the rest is not", async () => {
    const [, forward] = spellingsOf(HOME);
    const draft: QuoteDraft = { ...VALID_DRAFT,
      assumptions: [`Read ${HOME}${sep}notes.txt with ${FAKE_KEY}`, "Standard finish"],
      openQuestions: [{ lineRef: "1", field: "other", question: `Is ${forward}/drawing.pdf current?`, blocking: false }] };
    const seen: { draft: QuoteDraft | null } = { draft: null };
    const finalize: FinalizeQuote = (d, ctx) => {
      seen.draft = d;
      return fakeFinalize(d, ctx);
    };
    const { events, finished } = await run(async function* () {
      yield fx.init();
      yield fx.resultSuccess({ structuredOutput: draft });
    }, {}, undefined, { finalizeQuote: finalize });
    assert.equal(finished.ok, true);
    const got = seen.draft;
    assert.ok(got !== null);
    assert.deepEqual(got.assumptions, [`Read ~${sep}notes.txt with <key>`, "Standard finish"]);
    assert.deepEqual(got.openQuestions, [{ lineRef: "1", field: "other", question: "Is ~/drawing.pdf current?",
      blocking: false }]);
    assert.equal(got.rfqId, VALID_DRAFT.rfqId);
    assert.equal(got.customer, VALID_DRAFT.customer);
    assert.deepEqual(got.lines, VALID_DRAFT.lines);
    for (const e of events) {
      const json = JSON.stringify(e);
      assert.equal(leaks(json), null, `${e.type} leaks`);
      assert.ok(!json.includes(KEY_PREFIX), `${e.type} holds a key`);
    }
  });
});
