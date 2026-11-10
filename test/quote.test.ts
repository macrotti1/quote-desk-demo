// Quote integrity: finalize (spec 5.5) and the approval gate (5.6). No model, no network, no API key.
// Every file this test writes goes under a fresh temp folder.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { DeskEventSchema, HOLD_REASONS, QuoteSchema } from "../src/contracts.ts";
import type {
  Approver, Catalog, DeskEventBody, Delivery, DraftLine, FinalizeContext, OpenQuestion, Quote, QuoteDraft,
  QuoteStatus, Rfq, RfqTruth,
} from "../src/contracts.ts";
import { loadCatalog, loadRfqs, loadTruth } from "../src/load.ts";
import { PATHS } from "../src/paths.ts";
import { findPart, machiningCostPerPart, materialCostPerPart, resolveMaterial } from "../src/pricing.ts";
import { finalizeQuote } from "../src/quote/finalize.ts";
import { approveAndSend } from "../src/quote/gate.ts";
import { serializeQuote } from "../src/recording.ts";

const mini = (name: string): string => join(PATHS.miniDir, name);
const catalog: Catalog = loadCatalog(mini("catalog.json"));
const rfqs: Rfq[] = loadRfqs(mini("rfqs.json"));
const truth: RfqTruth[] = loadTruth(mini("rfq-truth.json"));

const scratch = mkdtempSync(join(tmpdir(), "qd-s4-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
let dirCount = 0;
/** A path inside the scratch folder that doesn't exist yet. */
function freshDir(...nested: string[]): string {
  dirCount += 1;
  return join(scratch, `case-${dirCount}`, ...nested);
}

function rfq(id: string): Rfq {
  const found = rfqs.find((r) => r.id === id);
  assert.ok(found, `${id} is in the mini RFQs`);
  return found;
}

function ctx(id: string): FinalizeContext {
  return { rfq: rfq(id), marginPct: catalog.marginPct, runId: "run-test-1", model: "claude-opus-5-5",
    effort: "medium", promptHash: "aaaaaaaaaaaa", catalogHash: "bbbbbbbbbbbb", createdAt: "2026-11-09T12:00:00.000Z" };
}

/** Costs the way the tools report them, from the catalog alone. */
function costs(partNumber: string, materialCode: string, quantity: number, toleranceIn: number) {
  const part = findPart(catalog, partNumber);
  const material = resolveMaterial(catalog, materialCode);
  assert.ok(part && material, `${partNumber} and ${materialCode} are in the mini catalog`);
  return { materialCostPerPartUsd: materialCostPerPart(part, material),
    machiningCostPerPartUsd: machiningCostPerPart(catalog, part, material, quantity, toleranceIn) };
}

/** A draft line as a correct model would write it for a truth line. Blocked lines stay unpriced. */
function lineFromTruth(rfqId: string, lineRef: string, over: Partial<DraftLine> = {}): DraftLine {
  const t = truth.find((x) => x.rfqId === rfqId)?.lines.find((l) => l.lineRef === lineRef);
  assert.ok(t, `${rfqId} line ${lineRef} is in the truth file`);
  const priced = t.blockedBy === null && t.materialCode !== null && t.quantity !== null && t.toleranceIn !== null;
  const c = priced && t.materialCode !== null && t.quantity !== null && t.toleranceIn !== null
    ? costs(t.partNumber, t.materialCode, t.quantity, t.toleranceIn)
    : { materialCostPerPartUsd: null, machiningCostPerPartUsd: null };
  return { lineRef: t.lineRef, partNumber: t.partNumber, materialAsRequested: t.materialAsRequested,
    materialCode: t.blockedBy === "material" ? null : t.materialCode, quantity: t.quantity,
    toleranceIn: t.toleranceIn, ...c, stock: t.stockIfOk, leadTimeDays: t.leadTimeDaysIfOk, ...over };
}

function draft(id: string, status: QuoteStatus, lines: DraftLine[], openQuestions: OpenQuestion[] = [],
  over: Partial<QuoteDraft> = {}): QuoteDraft {
  return { rfqId: id, customer: rfq(id).customer, status, lines, assumptions: ["Prices assume the stated material."],
    openQuestions, ...over };
}

function question(lineRef: string | null, field: OpenQuestion["field"], blocking = true): OpenQuestion {
  return { lineRef, field, question: `Please confirm the ${field}.`, blocking };
}

function codes(q: Quote): string[] {
  return q.consistencyErrors.map((e) => e.split(":")[0] ?? e);
}

/** The draft MINI-001 should produce: one tight-tolerance line, in stock. */
function mini001(): QuoteDraft {
  return draft("MINI-001", "ready", [lineFromTruth("MINI-001", "1")]);
}

/** Runs the gate to the end and returns what it yielded and returned. */
async function drain(gen: AsyncGenerator<DeskEventBody, Delivery, undefined>):
  Promise<{ events: DeskEventBody[]; delivery: Delivery }> {
  const events: DeskEventBody[] = [];
  let step = await gen.next();
  while (step.done !== true) {
    events.push(step.value);
    step = await gen.next();
  }
  return { events, delivery: step.value };
}

/** Every event the gate yields must pass the strict event schema once the host adds the envelope. */
function assertValidEvents(events: DeskEventBody[]): void {
  events.forEach((body, seq) => {
    DeskEventSchema.parse({ v: 1, runId: "run-test-1", seq, t: 0, ...body });
  });
}

function spyApprover(decision: "approve" | "decline"): { approver: Approver; calls: Quote[] } {
  const calls: Quote[] = [];
  return { calls, approver: async (q: Quote) => {
    calls.push(q);
    return decision;
  } };
}

describe("finalizeQuote", () => {
  test("the tight case gives 29.34 a part and 1173.60 extended", () => {
    const q = finalizeQuote(mini001(), ctx("MINI-001"));
    const line = q.lines[0];
    assert.ok(line);
    assert.equal(line.toleranceIn, 0.002);
    assert.equal(line.machiningCostPerPartUsd, 17.66);
    assert.equal(line.unitPriceUsd, 29.34);
    assert.equal(line.extendedUsd, 1173.6);
    assert.equal(q.totalUsd, 1173.6);
    assert.deepEqual(q.consistencyErrors, []);
  });

  test("the standard case gives 24.18 a part and 967.20 extended", () => {
    const standard = lineFromTruth("MINI-001", "1",
      { toleranceIn: 0.005, ...costs("QD-90001", "AL-6061-T6", 40, 0.005) });
    const q = finalizeQuote(draft("MINI-001", "ready", [standard]), ctx("MINI-001"));
    const line = q.lines[0];
    assert.ok(line);
    assert.equal(line.materialCostPerPartUsd, 4.91);
    assert.equal(line.machiningCostPerPartUsd, 13.69);
    assert.equal(line.unitPriceUsd, 24.18);
    assert.equal(line.extendedUsd, 967.2);
    assert.equal(q.totalUsd, 967.2);
  });

  test("MINI-006 totals 1461.30", () => {
    const d = draft("MINI-006", "ready", [lineFromTruth("MINI-006", "1"), lineFromTruth("MINI-006", "2")]);
    const q = finalizeQuote(d, ctx("MINI-006"));
    assert.equal(q.totalUsd, 1461.3);
    assert.deepEqual(q.consistencyErrors, []);
  });

  test("a null cost gives a null unit price and a null total", () => {
    const priced = lineFromTruth("MINI-006", "1");
    const unpriced = lineFromTruth("MINI-006", "2", { machiningCostPerPartUsd: null });
    const q = finalizeQuote(draft("MINI-006", "needs_clarification", [priced, unpriced], [question("2", "other")]),
      ctx("MINI-006"));
    assert.equal(q.lines[0]?.unitPriceUsd, 26.39);
    assert.equal(q.lines[1]?.unitPriceUsd, null);
    assert.equal(q.lines[1]?.extendedUsd, null);
    assert.equal(q.totalUsd, null);
    assert.deepEqual(q.consistencyErrors, []);
  });

  test("a null material cost gives a null unit price and a null total", () => {
    const line = lineFromTruth("MINI-001", "1", { materialCostPerPartUsd: null });
    const q = finalizeQuote(draft("MINI-001", "needs_clarification", [line], [question("1", "material")]),
      ctx("MINI-001"));
    assert.equal(q.lines[0]?.unitPriceUsd, null);
    assert.equal(q.lines[0]?.extendedUsd, null);
    assert.equal(q.totalUsd, null);
  });

  test("a null quantity gives a null unit price and a null total", () => {
    const d = draft("MINI-003", "needs_clarification", [lineFromTruth("MINI-003", "1")],
      [question("1", "quantity")]);
    const q = finalizeQuote(d, ctx("MINI-003"));
    assert.equal(q.lines[0]?.quantity, null);
    assert.equal(q.lines[0]?.unitPriceUsd, null);
    assert.equal(q.lines[0]?.extendedUsd, null);
    assert.equal(q.totalUsd, null);
    assert.deepEqual(q.consistencyErrors, []);
  });

  test("the quote passes the strict quote schema and carries margin and meta", () => {
    const q = finalizeQuote(mini001(), ctx("MINI-001"));
    QuoteSchema.parse(q);
    assert.equal(q.marginPct, 30);
    assert.deepEqual(q.meta, { runId: "run-test-1", model: "claude-opus-5-5", effort: "medium",
      promptHash: "aaaaaaaaaaaa", catalogHash: "bbbbbbbbbbbb", createdAt: "2026-11-09T12:00:00.000Z" });
    assert.deepEqual(Object.keys(q), ["rfqId", "customer", "status", "lines", "assumptions", "openQuestions",
      "marginPct", "totalUsd", "consistencyErrors", "meta"]);
  });

  test("finalize changes no value the model wrote and leaves the draft alone", () => {
    const d = draft("MINI-004", "needs_clarification",
      [lineFromTruth("MINI-004", "1"), lineFromTruth("MINI-004", "2")],
      [question("1", "tolerance"), question(null, "other", false)]);
    const before = structuredClone(d);
    const q = finalizeQuote(d, ctx("MINI-004"));
    assert.deepEqual(d, before);
    assert.deepEqual(q.lines.map(({ unitPriceUsd: _u, extendedUsd: _e, ...rest }) => rest), d.lines);
    assert.deepEqual(q.assumptions, d.assumptions);
    assert.deepEqual(q.openQuestions, d.openQuestions);
    assert.equal(q.status, d.status);
    assert.equal(q.rfqId, d.rfqId);
    assert.equal(q.customer, d.customer);
    assert.deepEqual(Object.keys(q.lines[0] ?? {}).slice(-2), ["unitPriceUsd", "extendedUsd"]);
  });

  describe("consistency rules", () => {
    test("a clean ready draft gives []", () => {
      assert.deepEqual(finalizeQuote(mini001(), ctx("MINI-001")).consistencyErrors, []);
    });

    test("a clean pending_stock_check draft gives []: an unverified line keeps its costs and has no lead time", () => {
      const unverified = lineFromTruth("MINI-006", "1", { stock: "unverified", leadTimeDays: null });
      const d = draft("MINI-006", "pending_stock_check", [unverified, lineFromTruth("MINI-006", "2")]);
      const q = finalizeQuote(d, ctx("MINI-006"));
      assert.deepEqual(q.consistencyErrors, []);
      assert.equal(q.totalUsd, 1461.3);
    });

    test("a clean needs_clarification draft gives []: MINI-004 line 2 is priced and the total is null", () => {
      const d = draft("MINI-004", "needs_clarification",
        [lineFromTruth("MINI-004", "1"), lineFromTruth("MINI-004", "2")], [question("1", "tolerance")]);
      const q = finalizeQuote(d, ctx("MINI-004"));
      assert.deepEqual(q.consistencyErrors, []);
      assert.equal(q.lines[0]?.unitPriceUsd, null);
      assert.notEqual(q.lines[1]?.unitPriceUsd, null);
      assert.notEqual(q.lines[1]?.extendedUsd, null);
      assert.equal(q.totalUsd, null);
    });

    test("C1: a draft with no lines", () => {
      const q = finalizeQuote(draft("MINI-001", "ready", []), ctx("MINI-001"));
      assert.deepEqual(codes(q), ["C1"]);
    });

    test("C2: a repeated lineRef", () => {
      const d = draft("MINI-006", "ready",
        [lineFromTruth("MINI-006", "1"), lineFromTruth("MINI-006", "2", { lineRef: "1" })]);
      assert.deepEqual(codes(finalizeQuote(d, ctx("MINI-006"))), ["C2"]);
    });

    test("C3: ready with an unverified line and no lead time", () => {
      const line = lineFromTruth("MINI-001", "1", { stock: "unverified", leadTimeDays: null });
      assert.deepEqual(codes(finalizeQuote(draft("MINI-001", "ready", [line]), ctx("MINI-001"))), ["C3"]);
    });

    test("C3: ready with a blocking question open", () => {
      const d = draft("MINI-001", "ready", [lineFromTruth("MINI-001", "1")], [question("1", "other")]);
      assert.deepEqual(codes(finalizeQuote(d, ctx("MINI-001"))), ["C3"]);
    });

    test("C3: ready with stock not_checked, everything else in place", () => {
      const line = lineFromTruth("MINI-001", "1", { stock: "not_checked" });
      assert.equal(line.leadTimeDays, 10);
      assert.deepEqual(codes(finalizeQuote(draft("MINI-001", "ready", [line]), ctx("MINI-001"))), ["C3"]);
    });

    test("C3: ready with stock unverified but a lead time set", () => {
      const line = lineFromTruth("MINI-001", "1", { stock: "unverified" });
      assert.deepEqual(codes(finalizeQuote(draft("MINI-001", "ready", [line]), ctx("MINI-001"))), ["C3"]);
    });

    test("C3: ready with an in_stock line and no lead time", () => {
      const line = lineFromTruth("MINI-001", "1", { leadTimeDays: null });
      assert.equal(line.stock, "in_stock");
      assert.deepEqual(codes(finalizeQuote(draft("MINI-001", "ready", [line]), ctx("MINI-001"))), ["C3"]);
    });

    test("C3: ready with a null materialCode and no question fires C3 as well as C6", () => {
      const line = lineFromTruth("MINI-001", "1", { materialCode: null });
      assert.notEqual(line.materialCostPerPartUsd, null);
      assert.deepEqual(codes(finalizeQuote(draft("MINI-001", "ready", [line]), ctx("MINI-001"))), ["C3", "C6"]);
    });

    test("C4: pending_stock_check with no unverified line", () => {
      const d = draft("MINI-001", "pending_stock_check", [lineFromTruth("MINI-001", "1")]);
      assert.deepEqual(codes(finalizeQuote(d, ctx("MINI-001"))), ["C4"]);
    });

    test("C4: pending_stock_check with a blocking question open", () => {
      const unverified = lineFromTruth("MINI-001", "1", { stock: "unverified", leadTimeDays: null });
      const d = draft("MINI-001", "pending_stock_check", [unverified], [question(null, "other")]);
      assert.deepEqual(codes(finalizeQuote(d, ctx("MINI-001"))), ["C4"]);
    });

    test("C4: pending_stock_check with a null material cost and no question fires C4 as well as C6", () => {
      const unverified = lineFromTruth("MINI-001", "1",
        { stock: "unverified", leadTimeDays: null, materialCostPerPartUsd: null });
      const d = draft("MINI-001", "pending_stock_check", [unverified]);
      assert.deepEqual(codes(finalizeQuote(d, ctx("MINI-001"))), ["C4", "C6"]);
    });

    test("C4: pending_stock_check with a null material cost and a blocking question on it", () => {
      const unverified = lineFromTruth("MINI-001", "1",
        { stock: "unverified", leadTimeDays: null, materialCostPerPartUsd: null });
      const d = draft("MINI-001", "pending_stock_check", [unverified], [question("1", "material")]);
      assert.deepEqual(codes(finalizeQuote(d, ctx("MINI-001"))), ["C4"]);
    });

    test("C5: needs_clarification with no blocking question", () => {
      const d = draft("MINI-001", "needs_clarification", [lineFromTruth("MINI-001", "1")],
        [question("1", "other", false)]);
      assert.deepEqual(codes(finalizeQuote(d, ctx("MINI-001"))), ["C5"]);
    });

    test("C6: an unpriced line with no blocking question on its lineRef", () => {
      const d = draft("MINI-003", "needs_clarification", [lineFromTruth("MINI-003", "1")],
        [question(null, "quantity")]);
      assert.deepEqual(codes(finalizeQuote(d, ctx("MINI-003"))), ["C6"]);
    });

    test("C6: a null materialCode with costs present and only an RFQ-wide blocking question", () => {
      const line = lineFromTruth("MINI-001", "1", { materialCode: null });
      assert.notEqual(line.materialCostPerPartUsd, null);
      assert.notEqual(line.machiningCostPerPartUsd, null);
      const d = draft("MINI-001", "needs_clarification", [line], [question(null, "material")]);
      assert.deepEqual(codes(finalizeQuote(d, ctx("MINI-001"))), ["C6"]);
    });

    test("C6: a null machining cost and only an RFQ-wide blocking question", () => {
      const line = lineFromTruth("MINI-001", "1", { machiningCostPerPartUsd: null });
      const d = draft("MINI-001", "needs_clarification", [line], [question(null, "other")]);
      assert.deepEqual(codes(finalizeQuote(d, ctx("MINI-001"))), ["C6"]);
    });

    test("C7: a question names a line that doesn't exist", () => {
      const d = draft("MINI-001", "ready", [lineFromTruth("MINI-001", "1")], [question("9", "other", false)]);
      assert.deepEqual(codes(finalizeQuote(d, ctx("MINI-001"))), ["C7"]);
    });

    test("C8: a wrong rfqId and customer", () => {
      const d = draft("MINI-001", "ready", [lineFromTruth("MINI-001", "1")], [],
        { rfqId: "RFQ-999", customer: "Someone Else Ltd" });
      assert.deepEqual(codes(finalizeQuote(d, ctx("MINI-001"))), ["C8"]);
    });

    test("C8 overwrites rfqId and customer with the RFQ's values", () => {
      const d = draft("MINI-001", "ready", [lineFromTruth("MINI-001", "1")], [],
        { rfqId: "RFQ-999", customer: "Someone Else Ltd" });
      const q = finalizeQuote(d, ctx("MINI-001"));
      assert.equal(q.rfqId, "MINI-001");
      assert.equal(q.customer, rfq("MINI-001").customer);
      assert.match(q.consistencyErrors[0] ?? "", /^C8: /);
    });

    test("C8 also fires when only the customer differs", () => {
      const d = draft("MINI-001", "ready", [lineFromTruth("MINI-001", "1")], [], { customer: "Someone Else Ltd" });
      const q = finalizeQuote(d, ctx("MINI-001"));
      assert.deepEqual(codes(q), ["C8"]);
      assert.equal(q.customer, rfq("MINI-001").customer);
    });

    test("C8 also fires when only the rfqId differs", () => {
      const d = draft("MINI-001", "ready", [lineFromTruth("MINI-001", "1")], [], { rfqId: "RFQ-999" });
      const q = finalizeQuote(d, ctx("MINI-001"));
      assert.deepEqual(codes(q), ["C8"]);
      assert.equal(q.rfqId, "MINI-001");
      assert.equal(q.customer, rfq("MINI-001").customer);
    });
  });
});

describe("approveAndSend", () => {
  test("no approver: not_attempted and no file", async () => {
    const outbox = freshDir("outbox");
    const { events, delivery } = await drain(approveAndSend(finalizeQuote(mini001(), ctx("MINI-001")), undefined,
      outbox));
    assert.equal(delivery, "not_attempted");
    assert.deepEqual(events, [{ type: "delivery", outcome: "not_attempted", file: null, reason: null }]);
    assertValidEvents(events);
    assert.equal(existsSync(outbox), false);
  });

  test("pending_stock_check: not_ready with reason pending stock check, and the approver never runs", async () => {
    const unverified = lineFromTruth("MINI-001", "1", { stock: "unverified", leadTimeDays: null });
    const q = finalizeQuote(draft("MINI-001", "pending_stock_check", [unverified]), ctx("MINI-001"));
    assert.deepEqual(q.consistencyErrors, []);
    const spy = spyApprover("approve");
    const outbox = freshDir("outbox");
    const { events, delivery } = await drain(approveAndSend(q, spy.approver, outbox));
    assert.equal(delivery, "not_ready");
    assert.deepEqual(events, [{ type: "delivery", outcome: "not_ready", file: null, reason: "pending stock check" }]);
    assert.equal(HOLD_REASONS.pending_stock_check, "pending stock check");
    assert.equal(spy.calls.length, 0);
    assertValidEvents(events);
    assert.equal(existsSync(outbox), false);
  });

  test("needs_clarification: not_ready with reason needs clarification", async () => {
    const d = draft("MINI-003", "needs_clarification", [lineFromTruth("MINI-003", "1")], [question("1", "quantity")]);
    const q = finalizeQuote(d, ctx("MINI-003"));
    assert.deepEqual(q.consistencyErrors, []);
    const spy = spyApprover("approve");
    const outbox = freshDir("outbox");
    const { events, delivery } = await drain(approveAndSend(q, spy.approver, outbox));
    assert.equal(delivery, "not_ready");
    assert.deepEqual(events, [{ type: "delivery", outcome: "not_ready", file: null, reason: "needs clarification" }]);
    assert.equal(spy.calls.length, 0);
    assertValidEvents(events);
    assert.equal(existsSync(outbox), false);
  });

  test("consistency errors: not_ready with reason consistency errors: C3", async () => {
    const line = lineFromTruth("MINI-001", "1", { stock: "unverified", leadTimeDays: null });
    const q = finalizeQuote(draft("MINI-001", "ready", [line]), ctx("MINI-001"));
    assert.deepEqual(codes(q), ["C3"]);
    const spy = spyApprover("approve");
    const outbox = freshDir("outbox");
    const { events, delivery } = await drain(approveAndSend(q, spy.approver, outbox));
    assert.equal(delivery, "not_ready");
    assert.deepEqual(events, [{ type: "delivery", outcome: "not_ready", file: null, reason: "consistency errors: C3" }]);
    assert.equal(spy.calls.length, 0);
    assertValidEvents(events);
    assert.equal(existsSync(outbox), false);
  });

  test("needs_clarification with a C6 error: the consistency reason wins over the status reason", async () => {
    const d = draft("MINI-003", "needs_clarification", [lineFromTruth("MINI-003", "1")], [question(null, "quantity")]);
    const q = finalizeQuote(d, ctx("MINI-003"));
    assert.deepEqual(codes(q), ["C6"]);
    const spy = spyApprover("approve");
    const outbox = freshDir("outbox");
    const { events, delivery } = await drain(approveAndSend(q, spy.approver, outbox));
    assert.equal(delivery, "not_ready");
    assert.deepEqual(events, [{ type: "delivery", outcome: "not_ready", file: null, reason: "consistency errors: C6" }]);
    assert.equal(spy.calls.length, 0);
    assertValidEvents(events);
    assert.equal(existsSync(outbox), false);
  });

  test("pending_stock_check with a C6 error: the consistency reason wins over the status reason", async () => {
    const unverified = lineFromTruth("MINI-001", "1",
      { stock: "unverified", leadTimeDays: null, materialCostPerPartUsd: null });
    const q = finalizeQuote(draft("MINI-001", "pending_stock_check", [unverified]), ctx("MINI-001"));
    assert.deepEqual(codes(q), ["C4", "C6"]);
    const spy = spyApprover("approve");
    const { events, delivery } = await drain(approveAndSend(q, spy.approver, freshDir("outbox")));
    assert.equal(delivery, "not_ready");
    assert.deepEqual(events,
      [{ type: "delivery", outcome: "not_ready", file: null, reason: "consistency errors: C4, C6" }]);
    assert.equal(spy.calls.length, 0);
  });

  test("two codes join with a comma: consistency errors: C3, C6", async () => {
    const q = finalizeQuote(draft("MINI-003", "ready", [lineFromTruth("MINI-003", "1")]), ctx("MINI-003"));
    assert.deepEqual(codes(q), ["C3", "C6"]);
    const spy = spyApprover("approve");
    const outbox = freshDir("outbox");
    const { events, delivery } = await drain(approveAndSend(q, spy.approver, outbox));
    assert.equal(delivery, "not_ready");
    assert.deepEqual(events,
      [{ type: "delivery", outcome: "not_ready", file: null, reason: "consistency errors: C3, C6" }]);
    assert.equal(spy.calls.length, 0);
    assertValidEvents(events);
    assert.equal(existsSync(outbox), false);
  });

  test("approve: exactly <rfqId>.json with serializeQuote bytes, events requested, resolved, delivery", async () => {
    const q = finalizeQuote(mini001(), ctx("MINI-001"));
    const spy = spyApprover("approve");
    const outbox = freshDir("outbox");
    const { events, delivery } = await drain(approveAndSend(q, spy.approver, outbox));
    assert.equal(delivery, "sent");
    assert.deepEqual(events, [
      { type: "approval_requested", rfqId: "MINI-001", totalUsd: 1173.6 },
      { type: "approval_resolved", decision: "approve" },
      { type: "delivery", outcome: "sent", file: "MINI-001.json", reason: null },
    ]);
    assert.equal(spy.calls.length, 1);
    assert.equal(spy.calls[0], q);
    assertValidEvents(events);
    assert.deepEqual(readdirSync(outbox), ["MINI-001.json"]);
    assert.equal(readFileSync(join(outbox, "MINI-001.json"), "utf8"), serializeQuote(q));
  });

  test("decline: no file, events requested, resolved, delivery declined", async () => {
    const q = finalizeQuote(mini001(), ctx("MINI-001"));
    const spy = spyApprover("decline");
    const outbox = freshDir("outbox");
    const { events, delivery } = await drain(approveAndSend(q, spy.approver, outbox));
    assert.equal(delivery, "declined");
    assert.deepEqual(events, [
      { type: "approval_requested", rfqId: "MINI-001", totalUsd: 1173.6 },
      { type: "approval_resolved", decision: "decline" },
      { type: "delivery", outcome: "declined", file: null, reason: null },
    ]);
    assert.equal(spy.calls.length, 1);
    assertValidEvents(events);
    assert.equal(existsSync(outbox), false);
  });

  test("a missing outbox folder is created, nested folders included", async () => {
    const outbox = freshDir("does", "not", "exist", "yet");
    assert.equal(existsSync(outbox), false);
    const q = finalizeQuote(mini001(), ctx("MINI-001"));
    const { delivery } = await drain(approveAndSend(q, spyApprover("approve").approver, outbox));
    assert.equal(delivery, "sent");
    assert.deepEqual(readdirSync(outbox), ["MINI-001.json"]);
    assert.equal(readFileSync(join(outbox, "MINI-001.json"), "utf8"), serializeQuote(q));
  });

  test("no approver comes first: a pending_stock_check quote with no approver is not_attempted", async () => {
    const unverified = lineFromTruth("MINI-001", "1", { stock: "unverified", leadTimeDays: null });
    const q = finalizeQuote(draft("MINI-001", "pending_stock_check", [unverified]), ctx("MINI-001"));
    assert.deepEqual(q.consistencyErrors, []);
    const outbox = freshDir("outbox");
    const { events, delivery } = await drain(approveAndSend(q, undefined, outbox));
    assert.equal(delivery, "not_attempted");
    assert.deepEqual(events, [{ type: "delivery", outcome: "not_attempted", file: null, reason: null }]);
    assertValidEvents(events);
    assert.equal(existsSync(outbox), false);
  });

  describe("an rfqId that isn't a plain file name", () => {
    const backslash = String.fromCharCode(92);
    const badIds = ["../x", "a/b", `..${backslash}..${backslash}x`, ".."];

    test("the backslash id really carries backslashes", () => {
      assert.equal(badIds[2], ["..", "..", "x"].join(backslash));
      assert.equal(badIds[2]?.length, 7);
    });

    for (const bad of badIds) {
      test(`${JSON.stringify(bad)}: not_ready with reason invalid_id, no approver call, nothing written`, async () => {
        // A ready, consistent quote whose id is swapped after finalize, so C8 can't repair it.
        const q: Quote = { ...finalizeQuote(mini001(), ctx("MINI-001")), rfqId: bad };
        assert.deepEqual(q.consistencyErrors, []);
        const caseDir = freshDir();
        const outbox = join(caseDir, "a", "outbox");
        const spy = spyApprover("approve");
        const { events, delivery } = await drain(approveAndSend(q, spy.approver, outbox));
        assert.equal(delivery, "not_ready");
        assert.deepEqual(events,
          [{ type: "delivery", outcome: "not_ready", file: null, reason: HOLD_REASONS.invalid_id }]);
        assert.equal(HOLD_REASONS.invalid_id, "the RFQ id is not a plain file name");
        assert.equal(spy.calls.length, 0);
        assertValidEvents(events);
        // The outbox sits two levels under the case folder, so a write that escaped it would land here.
        assert.equal(existsSync(caseDir), false);
      });
    }

    test("a bad id with a consistency error keeps the consistency reason", async () => {
      const line = lineFromTruth("MINI-001", "1", { stock: "unverified", leadTimeDays: null });
      const q: Quote = { ...finalizeQuote(draft("MINI-001", "ready", [line]), ctx("MINI-001")), rfqId: "../x" };
      assert.deepEqual(codes(q), ["C3"]);
      const spy = spyApprover("approve");
      const { events } = await drain(approveAndSend(q, spy.approver, freshDir("outbox")));
      assert.deepEqual(events, [{ type: "delivery", outcome: "not_ready", file: null, reason: "consistency errors: C3" }]);
      assert.equal(spy.calls.length, 0);
    });

    test("a bad id on a needs_clarification quote keeps the status reason", async () => {
      const d = draft("MINI-003", "needs_clarification", [lineFromTruth("MINI-003", "1")], [question("1", "quantity")]);
      const q: Quote = { ...finalizeQuote(d, ctx("MINI-003")), rfqId: "a/b" };
      assert.deepEqual(q.consistencyErrors, []);
      const spy = spyApprover("approve");
      const { events } = await drain(approveAndSend(q, spy.approver, freshDir("outbox")));
      assert.deepEqual(events, [{ type: "delivery", outcome: "not_ready", file: null, reason: "needs clarification" }]);
      assert.equal(spy.calls.length, 0);
    });

    test("a bad id with no approver is not_attempted", async () => {
      const q: Quote = { ...finalizeQuote(mini001(), ctx("MINI-001")), rfqId: "../x" };
      const caseDir = freshDir();
      const { events, delivery } = await drain(approveAndSend(q, undefined, join(caseDir, "a", "outbox")));
      assert.equal(delivery, "not_attempted");
      assert.deepEqual(events, [{ type: "delivery", outcome: "not_attempted", file: null, reason: null }]);
      assert.equal(existsSync(caseDir), false);
    });
  });
});
