// Turns the model's draft into the quote the host sends. Prices come from src/pricing.ts only, and
// the consistency rules (spec 5.5) are checked here. Nothing the model wrote is changed, except
// rfqId and customer, which always come from the RFQ (C8).
import type { DraftLine, FinalizeContext, FinalizeQuote, QuoteDraft, QuoteLine, Rfq } from "../contracts.ts";
import { extendedPrice, round2, unitPrice } from "../pricing.ts";

const PRICED_STOCK = new Set<string>(["in_stock", "short", "not_stocked"]);

function blockingRefs(draft: QuoteDraft): Set<string | null> {
  return new Set(draft.openQuestions.filter((q) => q.blocking).map((q) => q.lineRef));
}

function hasBlocking(draft: QuoteDraft): boolean {
  return draft.openQuestions.some((q) => q.blocking);
}

/** The names of the priced fields a line leaves null: quantity, code and both costs. */
function missingPriceInputs(line: DraftLine): string[] {
  const missing: string[] = [];
  if (line.quantity === null) missing.push("quantity");
  if (line.materialCode === null) missing.push("materialCode");
  if (line.materialCostPerPartUsd === null) missing.push("materialCostPerPartUsd");
  if (line.machiningCostPerPartUsd === null) missing.push("machiningCostPerPartUsd");
  return missing;
}

function describe(problems: string[]): string {
  return problems.join("; ");
}

/**
 * Checks the 5.5 rules against a draft. Returns at most one string per rule, in rule order, each
 * starting with its code ("C3: ..."). An empty list means the draft is consistent.
 */
function consistencyErrors(draft: QuoteDraft, rfq: Rfq): string[] {
  const errors: string[] = [];
  const refs = draft.lines.map((l) => l.lineRef);
  const refSet = new Set(refs);

  // C1: at least one line.
  if (draft.lines.length === 0) errors.push("C1: the draft has no lines");

  // C2: lineRefs are unique.
  const repeated = [...new Set(refs.filter((r, i) => refs.indexOf(r) !== i))];
  if (repeated.length > 0) errors.push(`C2: lineRef repeated: ${repeated.join(", ")}`);

  // C3: ready means no blocking question and every line fully priced, with a lead time and a checked stock state.
  if (draft.status === "ready") {
    const problems: string[] = [];
    if (hasBlocking(draft)) problems.push("a blocking question is open");
    for (const line of draft.lines) {
      const missing = missingPriceInputs(line);
      if (line.leadTimeDays === null) missing.push("leadTimeDays");
      if (missing.length > 0) problems.push(`line ${line.lineRef} has no ${missing.join(", ")}`);
      if (!PRICED_STOCK.has(line.stock)) problems.push(`line ${line.lineRef} stock is ${line.stock}`);
    }
    if (problems.length > 0) errors.push(`C3: ready but ${describe(problems)}`);
  }

  // C4: pending_stock_check means no blocking question, every line priced, and at least one unverified line.
  if (draft.status === "pending_stock_check") {
    const problems: string[] = [];
    if (hasBlocking(draft)) problems.push("a blocking question is open");
    for (const line of draft.lines) {
      const missing = missingPriceInputs(line);
      if (missing.length > 0) problems.push(`line ${line.lineRef} has no ${missing.join(", ")}`);
    }
    if (!draft.lines.some((l) => l.stock === "unverified")) problems.push("no line is unverified");
    if (problems.length > 0) errors.push(`C4: pending_stock_check but ${describe(problems)}`);
  }

  // C5: needs_clarification means at least one blocking question.
  if (draft.status === "needs_clarification" && !hasBlocking(draft)) {
    errors.push("C5: needs_clarification but no blocking question is open");
  }

  // C6: a line missing a quantity, code or cost has a blocking question on its lineRef.
  const blocked = blockingRefs(draft);
  const unasked = draft.lines
    .filter((l) => missingPriceInputs(l).length > 0 && !blocked.has(l.lineRef))
    .map((l) => l.lineRef);
  if (unasked.length > 0) errors.push(`C6: no blocking question on line ${unasked.join(", ")}`);

  // C7: every non-null question lineRef names a line.
  const strays = [...new Set(draft.openQuestions
    .map((q) => q.lineRef)
    .filter((r): r is string => r !== null && !refSet.has(r)))];
  if (strays.length > 0) errors.push(`C7: a question names a line that doesn't exist: ${strays.join(", ")}`);

  // C8: rfqId and customer match the RFQ.
  const wrong: string[] = [];
  if (draft.rfqId !== rfq.id) wrong.push("rfqId");
  if (draft.customer !== rfq.customer) wrong.push("customer");
  if (wrong.length > 0) errors.push(`C8: ${wrong.join(" and ")} replaced with the RFQ's value`);

  return errors;
}

function priceLine(line: DraftLine, marginPct: number): QuoteLine {
  const { quantity, materialCostPerPartUsd: material, machiningCostPerPartUsd: machining } = line;
  if (quantity === null || material === null || machining === null) {
    return { ...line, unitPriceUsd: null, extendedUsd: null };
  }
  const unit = unitPrice(material, machining, marginPct);
  return { ...line, unitPriceUsd: unit, extendedUsd: extendedPrice(unit, quantity) };
}

export const finalizeQuote: FinalizeQuote = (draft: QuoteDraft, ctx: FinalizeContext) => {
  const lines = draft.lines.map((l) => priceLine(l, ctx.marginPct));
  let totalUsd: number | null = 0;
  let sum = 0;
  for (const line of lines) {
    if (line.extendedUsd === null) {
      totalUsd = null;
      break;
    }
    sum += line.extendedUsd;
  }
  if (totalUsd !== null) totalUsd = round2(sum);
  return {
    rfqId: ctx.rfq.id,
    customer: ctx.rfq.customer,
    status: draft.status,
    lines,
    assumptions: [...draft.assumptions],
    openQuestions: draft.openQuestions.map((q) => ({ ...q })),
    marginPct: ctx.marginPct,
    totalUsd,
    consistencyErrors: consistencyErrors(draft, ctx.rfq),
    meta: { runId: ctx.runId, model: ctx.model, effort: ctx.effort, promptHash: ctx.promptHash,
      catalogHash: ctx.catalogHash, createdAt: ctx.createdAt },
  };
};
