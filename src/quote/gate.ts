// The approval gate (spec 5.6). A quote reaches the outbox only when it is ready, consistent and a
// person (or the eval's scripted approver) says yes. Events carry the outbox file's base name only.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOLD_REASONS, RFQ_ID_PATTERN } from "../contracts.ts";
import type { ApproveAndSend, Approver, DeskEventBody, Delivery, Quote } from "../contracts.ts";
import { serializeQuote } from "../recording.ts";

/** The rule codes in a quote's consistency errors, deduped, in the order they appear. */
function errorCodes(errors: string[]): string[] {
  const codes: string[] = [];
  for (const e of errors) {
    const match = /^C\d+/.exec(e);
    const code = match === null ? e : match[0];
    if (!codes.includes(code)) codes.push(code);
  }
  return codes;
}

/** Why a quote is held, or null when it may go to the approver. */
function holdReason(quote: Quote): string | null {
  if (quote.consistencyErrors.length > 0) {
    return `${HOLD_REASONS.inconsistent}: ${errorCodes(quote.consistencyErrors).join(", ")}`;
  }
  if (quote.status === "ready") return null;
  return HOLD_REASONS[quote.status];
}

export const approveAndSend: ApproveAndSend = async function* (quote: Quote, approver: Approver | undefined,
  outboxDir: string): AsyncGenerator<DeskEventBody, Delivery, undefined> {
  if (approver === undefined) {
    yield { type: "delivery", outcome: "not_attempted", file: null, reason: null };
    return "not_attempted";
  }

  const reason = holdReason(quote);
  if (reason !== null) {
    yield { type: "delivery", outcome: "not_ready", file: null, reason };
    return "not_ready";
  }

  // The file name is `${rfqId}.json`, so an id with a separator or ".." would steer the write out of the
  // outbox. Hold it before anyone is asked to approve.
  if (!RFQ_ID_PATTERN.test(quote.rfqId)) {
    yield { type: "delivery", outcome: "not_ready", file: null, reason: HOLD_REASONS.invalid_id };
    return "not_ready";
  }

  yield { type: "approval_requested", rfqId: quote.rfqId, totalUsd: quote.totalUsd };
  const decision = await approver(quote);
  yield { type: "approval_resolved", decision };

  if (decision !== "approve") {
    yield { type: "delivery", outcome: "declined", file: null, reason: null };
    return "declined";
  }

  const file = `${quote.rfqId}.json`;
  mkdirSync(outboxDir, { recursive: true });
  writeFileSync(join(outboxDir, file), serializeQuote(quote), "utf8");
  yield { type: "delivery", outcome: "sent", file, reason: null };
  return "sent";
};
