// The page's reducer (web/src/state.ts) over the three recorded demo runs. No model, no network.
import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { DeskEvent } from "../src/contracts.ts";
import { PATHS } from "../src/paths.ts";
import { readRecording } from "../src/recording.ts";
import { allRows, initialState, reduce } from "../web/src/state.ts";
import type { ViewState } from "../web/src/state.ts";

function eventsOf(name: string): DeskEvent[] {
  return readRecording(join(PATHS.recordingsDir, `${name}.jsonl`)).events;
}

function play(events: readonly DeskEvent[]): ViewState {
  return events.reduce(reduce, initialState);
}

describe("web state: recorded demo runs", () => {
  test("clean: two groups of four ok rows, ready, 2277.5, declined", () => {
    const s = play(eventsOf("demo-clean"));
    assert.deepEqual(s.groups.map((g) => g.partNumber), ["QD-10122", "QD-10229"]);
    for (const g of s.groups) {
      assert.equal(g.rows.length, 4);
      assert.ok(g.rows.every((r) => r.status === "ok"), `${g.partNumber ?? "?"} rows all ok`);
      assert.deepEqual(g.rows.map((r) => r.tool).sort(),
        ["check_stock", "estimate_cycle_time", "lookup_part", "price_material"]);
    }
    assert.equal(s.quote?.status, "ready");
    assert.equal(s.quote?.totalUsd, 2277.5);
    assert.equal(s.approval, "decline");
    assert.equal(s.delivery?.outcome, "declined");
    assert.equal(s.phase, "done");
    assert.equal(s.finish?.ok, true);
    assert.equal(s.run?.rfqId, "RFQ-001");
    assert.equal(s.run?.stockFault, "ok");
    assert.equal(s.notices.length, 0);
  });

  test("stock-down: both check_stock rows are STOCK_UNAVAILABLE errors and the quote is held", () => {
    const s = play(eventsOf("demo-stock-down"));
    const stock = allRows(s).filter((r) => r.tool === "check_stock");
    assert.equal(stock.length, 2);
    for (const r of stock) {
      assert.equal(r.status, "error");
      assert.equal(r.code, "STOCK_UNAVAILABLE");
      assert.equal(r.summary, "No answer after 3 of 3 attempts (simulated). Stock is unverified.");
    }
    assert.ok(allRows(s).filter((r) => r.tool !== "check_stock").every((r) => r.status === "ok"));
    assert.equal(s.quote?.status, "pending_stock_check");
    assert.equal(s.approval, "none");
    assert.equal(s.delivery?.outcome, "not_ready");
    assert.equal(s.delivery?.reason, "pending stock check");
    assert.equal(s.run?.stockFault, "down");
  });

  test("unknown-material: one group, one ok row and three UNKNOWN_MATERIAL errors, a material question", () => {
    const s = play(eventsOf("demo-unknown-material"));
    assert.deepEqual(s.groups.map((g) => g.partNumber), ["QD-10270"]);
    const rows = allRows(s);
    assert.equal(rows.filter((r) => r.status === "ok").length, 1);
    const errors = rows.filter((r) => r.status === "error");
    assert.equal(errors.length, 3);
    assert.ok(errors.every((r) => r.code === "UNKNOWN_MATERIAL"));
    assert.equal(s.quote?.status, "needs_clarification");
    assert.equal(s.quote?.totalUsd, null);
    assert.deepEqual(s.quote?.openQuestions.map((q) => q.field), ["material"]);
    assert.equal(s.delivery?.outcome, "not_ready");
  });
});

describe("web state: phases", () => {
  test("drafting between the last tool result and the quote", () => {
    const events = eventsOf("demo-clean");
    const quoteAt = events.findIndex((e) => e.type === "quote");
    assert.ok(quoteAt > 0);
    const before = play(events.slice(0, quoteAt));
    assert.equal(before.phase, "drafting");
    assert.equal(before.draftingSince, events[quoteAt - 1]?.t);
    assert.equal(before.quote, null);
    const after = reduce(before, events[quoteAt] as DeskEvent);
    assert.notEqual(after.phase, "drafting");
    assert.equal(after.draftingSince, null);
  });

  test("tools while a call is pending, starting before the first call, awaiting_approval on request", () => {
    const events = eventsOf("demo-clean");
    assert.equal(play(events.slice(0, 1)).phase, "starting");
    assert.equal(play(events.slice(0, 2)).phase, "starting");
    const firstCall = events.findIndex((e) => e.type === "tool_call");
    assert.equal(play(events.slice(0, firstCall + 1)).phase, "tools");
    const requested = events.findIndex((e) => e.type === "approval_requested");
    assert.equal(play(events.slice(0, requested + 1)).phase, "awaiting_approval");
  });

  test("a failed run ends in failed with its reason", () => {
    const events = eventsOf("demo-clean").slice(0, 3);
    const last = events[events.length - 1];
    assert.ok(last !== undefined);
    const finished: DeskEvent = { v: 1, runId: last.runId, seq: last.seq + 1, t: last.t + 1, type: "run_finished",
      ok: false, failure: "wall_clock", detail: "the run took longer than 180 s", costUsd: null, usage: null,
      modelsUsed: [], effortApplied: null, turns: null, durationMs: 180000, delivery: "not_attempted" };
    const s = play([...events, finished]);
    assert.equal(s.phase, "failed");
    assert.equal(s.finish?.failure, "wall_clock");
  });

  test("an unknown event type changes nothing", () => {
    const s = play(eventsOf("demo-clean").slice(0, 6));
    const unknown = { v: 1, runId: "x", seq: 99, t: 99999, type: "from_the_future", note: "hi" } as unknown as DeskEvent;
    assert.equal(reduce(s, unknown), s);
    assert.equal(reduce(initialState, unknown), initialState);
  });

  test("a guard denial ends its pending row and shows as a notice", () => {
    const events = eventsOf("demo-clean");
    const callAt = events.findIndex((e) => e.type === "tool_call");
    const call = events[callAt];
    assert.ok(call !== undefined && call.type === "tool_call");
    const denied: DeskEvent = { v: 1, runId: call.runId, seq: call.seq + 1, t: call.t + 1, type: "guard_denied",
      tool: "Bash", toolUseId: call.toolUseId, by: "allowlist", reason: "Bash is not on the allowlist" };
    const s = play([...events.slice(0, callAt + 1), denied]);
    const row = allRows(s).find((r) => r.toolUseId === call.toolUseId);
    assert.equal(row?.status, "error");
    assert.equal(row?.code, "DENIED");
    assert.equal(s.notices.length, 1);
    assert.equal(s.phase, "drafting");
  });

  test("reduce never mutates the state it was given", () => {
    const events = eventsOf("demo-stock-down");
    let s = initialState;
    const frozen = JSON.stringify(initialState);
    for (const e of events) {
      const before = JSON.stringify(s);
      const next = reduce(s, e);
      assert.equal(JSON.stringify(s), before);
      s = next;
    }
    assert.equal(JSON.stringify(initialState), frozen);
  });
});
