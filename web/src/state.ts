// The page's view of one run, built only from desk events. Plain TypeScript with no DOM, React or Node
// imports, so the Node tests can import it. reduce() never mutates its input, and an event type this
// version doesn't know returns the same state object.
import type { Delivery, DeskEvent, FailureReason, Quote, ToolResult } from "../../src/contracts.ts";
import { leadTime, millis, money, num, oneLine } from "./format.ts";

export type Phase = "idle" | "starting" | "tools" | "drafting" | "awaiting_approval" | "done" | "failed";
export type RowStatus = "pending" | "ok" | "error";
export type ActivityRow = { toolUseId: string; tool: string; status: RowStatus; code: string | null; summary: string;
  ms: number | null };
/** Rows for one part number, in order of first appearance. partNumber null holds calls that named no part. */
export type ActivityGroup = { partNumber: string | null; rows: ActivityRow[] };
export type RunInfo = { rfqId: string; model: string; effort: string; stockFault: string; apiKeySource: string | null };
export type ApprovalState = "none" | "requested" | "approve" | "decline";
export type DeliveryInfo = { outcome: Delivery; file: string | null; reason: string | null };
export type FinishInfo = { ok: boolean; failure: FailureReason | null; detail: string | null; costUsd: number | null;
  turns: number | null; durationMs: number; modelsUsed: string[] };
export type Notice = { kind: "guard"; tool: string; toolUseId: string; by: string; text: string }
  | { kind: "refusal"; text: string };
export type ViewState = {
  phase: Phase;
  run: RunInfo | null;
  groups: ActivityGroup[];
  quote: Quote | null;
  approval: ApprovalState;
  delivery: DeliveryInfo | null;
  finish: FinishInfo | null;
  notices: Notice[];
  /** t (ms since start) of the event that put the run in drafting, else null. */
  draftingSince: number | null;
};

export const initialState: ViewState = { phase: "idle", run: null, groups: [], quote: null, approval: "none",
  delivery: null, finish: null, notices: [], draftingSince: null };

/** The state a page shows between pressing a button and the first event. */
export const startingState: ViewState = { ...initialState, phase: "starting" };

const CATALOG_PREFIX = "mcp__catalog__";
/** "check_stock" for "mcp__catalog__check_stock"; other names as they are. */
export function shortTool(tool: string): string {
  return tool.startsWith(CATALOG_PREFIX) ? tool.slice(CATALOG_PREFIX.length) : tool;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function partOfInput(input: unknown): string | null {
  if (!isRecord(input)) return null;
  const p = input["partNumber"];
  return typeof p === "string" && p.trim() !== "" ? p.trim().toUpperCase() : null;
}

function partOfData(data: ToolResult | null): string | null {
  if (data === null || !data.ok) return null;
  return data.partNumber.trim().toUpperCase();
}

/** What the call asked for, shown while it is pending. */
function inputSummary(tool: string, input: unknown): string {
  if (!isRecord(input)) return "";
  const parts: string[] = [];
  const material = input["material"];
  const quantity = input["quantity"];
  const tol = input["toleranceIn"];
  if (typeof material === "string") parts.push(material);
  if (typeof quantity === "number") parts.push(`qty ${num(quantity)}`);
  if (typeof tol === "number") parts.push(`tol ${num(tol)}`);
  if (parts.length === 0 && shortTool(tool) === "lookup_part") return "looking up the part";
  return oneLine(parts.join(", "), 120);
}

/** The words for a stock call that got no answer, as the storyboard shows them. */
export function stockUnavailableText(attempts: number | null): string {
  // STOCK_ATTEMPTS in src/contracts.ts; repeated here because the page imports types only from there.
  const n = attempts ?? 3;
  return `No answer after ${n} of 3 attempts (simulated). Stock is unverified.`;
}

/** The one-line summary of a tool result. */
export function resultSummary(data: ToolResult | null, text: string): string {
  if (data === null) return oneLine(text, 160);
  if (!data.ok) {
    if (data.code === "STOCK_UNAVAILABLE") return stockUnavailableText(data.attempts);
    return oneLine(data.message, 200);
  }
  if ("description" in data) return oneLine(`${data.description}, stock ${data.stockSize}`, 160);
  if ("materialName" in data) return oneLine(`${data.materialName}, material $${money(data.costPerPartUsd)} per part`, 160);
  if ("operations" in data) {
    const ops = data.operations.length;
    return `${data.toleranceTier} tolerance (${num(data.toleranceIn)} in), ${ops} ${ops === 1 ? "operation" : "operations"}`;
  }
  const status = data.status === "in_stock" ? "in stock" : data.status === "not_stocked" ? "not stocked" : "short";
  return `${status}: ${num(data.onHandLb)} lb on hand for ${num(data.requiredLb)} lb required, lead time ` +
    leadTime(data.leadTimeDays);
}

function withRow(groups: ActivityGroup[], partNumber: string | null, row: ActivityRow): ActivityGroup[] {
  const i = groups.findIndex((g) => g.partNumber === partNumber);
  if (i < 0) return [...groups, { partNumber, rows: [row] }];
  return groups.map((g, j) => (j === i ? { ...g, rows: [...g.rows, row] } : g));
}

function findRow(groups: ActivityGroup[], toolUseId: string): boolean {
  return groups.some((g) => g.rows.some((r) => r.toolUseId === toolUseId));
}

function updateRow(groups: ActivityGroup[], toolUseId: string, change: (r: ActivityRow) => ActivityRow): ActivityGroup[] {
  return groups.map((g) => (g.rows.some((r) => r.toolUseId === toolUseId)
    ? { ...g, rows: g.rows.map((r) => (r.toolUseId === toolUseId ? change(r) : r)) }
    : g));
}

function allRowsAnswered(groups: ActivityGroup[]): boolean {
  let rows = 0;
  for (const g of groups) {
    for (const r of g.rows) {
      rows++;
      if (r.status === "pending") return false;
    }
  }
  return rows > 0;
}

/**
 * The phase follows from the rest of the state. done: a quote has arrived, no approval is pending and the
 * run hasn't failed (finish fills in when run_finished lands). drafting: every row has its result and no
 * quote has arrived.
 */
function withPhase(s: ViewState, t: number): ViewState {
  let phase: Phase;
  if (s.finish !== null) phase = s.finish.ok ? "done" : "failed";
  else if (s.approval === "requested") phase = "awaiting_approval";
  else if (s.quote !== null) phase = "done";
  else if (allRowsAnswered(s.groups)) phase = "drafting";
  else if (s.groups.length > 0) phase = "tools";
  else phase = "starting";
  const draftingSince = phase === "drafting" ? (s.phase === "drafting" ? s.draftingSince : t) : null;
  if (phase === s.phase && draftingSince === s.draftingSince) return s;
  return { ...s, phase, draftingSince };
}

/** Applies one event. Unknown event types return the state unchanged. */
export function reduce(state: ViewState, event: DeskEvent): ViewState {
  const e = event;
  let next: ViewState;
  switch (e.type) {
    case "run_started":
      next = { ...initialState, phase: "starting",
        run: { rfqId: e.rfqId, model: e.model, effort: e.effort, stockFault: e.stockFault, apiKeySource: null } };
      break;
    case "session_init":
      next = state.run === null ? state : { ...state, run: { ...state.run, apiKeySource: e.apiKeySource } };
      break;
    case "assistant_text":
      return state;
    case "tool_call": {
      if (findRow(state.groups, e.toolUseId)) return state;
      const denied = state.notices.find((n) => n.kind === "guard" && n.toolUseId === e.toolUseId);
      const row: ActivityRow = denied === undefined
        ? { toolUseId: e.toolUseId, tool: shortTool(e.tool), status: "pending", code: null,
          summary: inputSummary(e.tool, e.input), ms: null }
        : { toolUseId: e.toolUseId, tool: shortTool(e.tool), status: "error", code: "DENIED",
          summary: oneLine(denied.text, 200), ms: null };
      next = { ...state, groups: withRow(state.groups, partOfInput(e.input), row) };
      break;
    }
    case "tool_result": {
      const status: RowStatus = e.isError || (e.data !== null && !e.data.ok) ? "error" : "ok";
      const code = e.data !== null && !e.data.ok ? e.data.code : null;
      const summary = resultSummary(e.data, e.text);
      const change = (r: ActivityRow): ActivityRow => ({ ...r, status, code, summary, ms: e.ms });
      const groups = findRow(state.groups, e.toolUseId)
        ? updateRow(state.groups, e.toolUseId, change)
        : withRow(state.groups, partOfData(e.data),
          change({ toolUseId: e.toolUseId, tool: shortTool(e.tool), status, code, summary, ms: e.ms }));
      next = { ...state, groups };
      break;
    }
    case "guard_denied": {
      const notice: Notice = { kind: "guard", tool: shortTool(e.tool), toolUseId: e.toolUseId, by: e.by, text: e.reason };
      // A denied call may never get a result, so its row stops waiting here.
      const groups = updateRow(state.groups, e.toolUseId,
        (r) => (r.status === "pending" ? { ...r, status: "error", code: "DENIED", summary: oneLine(e.reason, 200) } : r));
      next = { ...state, groups, notices: [...state.notices, notice] };
      break;
    }
    case "model_refusal": {
      const text = `${e.originalModel} refused (${e.category ?? "no category"}); fallback ${e.fallbackModel ?? "none"}`;
      next = { ...state, notices: [...state.notices, { kind: "refusal", text }] };
      break;
    }
    case "quote":
      next = { ...state, quote: e.quote };
      break;
    case "approval_requested":
      next = { ...state, approval: "requested" };
      break;
    case "approval_resolved":
      next = { ...state, approval: e.decision };
      break;
    case "delivery":
      next = { ...state, delivery: { outcome: e.outcome, file: e.file, reason: e.reason } };
      break;
    case "run_finished":
      next = { ...state, finish: { ok: e.ok, failure: e.failure, detail: e.detail, costUsd: e.costUsd, turns: e.turns,
        durationMs: e.durationMs, modelsUsed: [...e.modelsUsed] } };
      break;
    default:
      return state;
  }
  return withPhase(next, e.t);
}

/** Every row of every group, in display order. */
export function allRows(s: ViewState): ActivityRow[] {
  return s.groups.flatMap((g) => g.rows);
}

/** "75 ms", or "" while a row is pending. */
export function rowTime(r: ActivityRow): string {
  return r.ms === null ? "" : millis(r.ms);
}
