// Turns desk events and quotes into terminal lines. Pure functions: no I/O, no process state.
// Every line is ASCII. Text that came from the model or an RFQ is cleaned first, so a stray
// control character or escape sequence in a reply can never reach the terminal.
import { CATALOG_SERVER, STOCK_ATTEMPTS, STRUCTURED_OUTPUT_TOOL } from "../contracts.ts";
import type { DeskEvent, OpenQuestion, Quote, QuoteLine, ToolResult } from "../contracts.ts";

export type RenderOptions = { color: boolean };

const STYLES = { bold: "1", dim: "2", red: "31", green: "32", yellow: "33", cyan: "36" } as const;
type Style = keyof typeof STYLES;

function paint(o: RenderOptions, style: Style, s: string): string {
  return o.color ? `\u001b[${STYLES[style]}m${s}\u001b[0m` : s;
}

// Common typographic characters a model writes, mapped to plain ASCII.
const REPLACEMENTS: Record<string, string> = {
  "\u2014": "-", "\u2013": "-", "\u2012": "-", "\u2212": "-", "\u2018": "'", "\u2019": "'", "\u201c": "\"",
  "\u201d": "\"", "\u2026": "...", "\u00b1": "+/-", "\u00d7": "x", "\u00b0": " deg", "\u00a0": " ",
  "\u2264": "<=", "\u2265": ">=", "\u2022": "*",
};

/** Makes the text printable ASCII: whitespace becomes a space, common symbols are spelled out, anything else is "?". */
export function asciiText(s: string): string {
  let out = "";
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x20 && code <= 0x7e) out += ch;
    else if (/\s/.test(ch) && ch !== "\u00a0") out += " ";
    else out += REPLACEMENTS[ch] ?? "?";
  }
  return out;
}

/** For text from the model or an RFQ: one line, ASCII, at most `max` characters, ending in "..." when cut. */
export function clip(s: string, max: number): string {
  const t = asciiText(s.replace(/\s+/g, " ").trim());
  return t.length <= max ? t : `${t.slice(0, Math.max(0, max - 3))}...`;
}

/** "1,173.60": two decimals and thousands commas, never locale-dependent. */
export function money(n: number): string {
  const [whole = "0", cents = "00"] = Math.abs(n).toFixed(2).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${n < 0 ? "-" : ""}${grouped}.${cents}`;
}

function num(n: number): string {
  return Number.isFinite(n) ? String(n) : "?";
}

function shortTool(tool: string): string {
  const prefix = `mcp__${CATALOG_SERVER}__`;
  return tool.startsWith(prefix) ? tool.slice(prefix.length) : tool;
}

/** One-line input for a tool call: key=value pairs for a flat object, JSON otherwise. */
function compactInput(input: unknown): string {
  if (input !== null && typeof input === "object" && !Array.isArray(input)) {
    const parts: string[] = [];
    for (const [key, value] of Object.entries(input)) {
      if (typeof value === "string") parts.push(`${key}=${/\s/.test(value) || value === "" ? JSON.stringify(value) : value}`);
      else if (typeof value === "number" || typeof value === "boolean" || value === null) parts.push(`${key}=${String(value)}`);
      else parts.push(`${key}=${JSON.stringify(value) ?? "?"}`);
    }
    return clip(parts.join(" "), 160);
  }
  return clip(JSON.stringify(input) ?? String(input), 160);
}

function ms(n: number): string {
  return `${Math.round(n)}ms`;
}

function okSummary(d: Exclude<ToolResult, { ok: false }>): string {
  if ("description" in d) {
    return `${d.partNumber} ${d.description}, ${d.stockShape} ${d.stockSize}, standard tol ${num(d.standardToleranceIn)}, ` +
      `${d.operationCount} ops`;
  }
  if ("materialName" in d) {
    return `${d.materialCode} ${num(d.blankWeightLb)} lb at $${money(d.usdPerLb)}/lb, material $${money(d.costPerPartUsd)} per part`;
  }
  if ("operations" in d) {
    return `${d.materialCode} qty ${num(d.quantity)} tol ${num(d.toleranceIn)} (${d.toleranceTier}), ${d.operations.length} ops, ` +
      `${num(d.minutesPerPart)} min per part, machining $${money(d.machiningCostPerPartUsd)} per part`;
  }
  return `${d.status} ${num(d.requiredLb)} of ${num(d.onHandLb)} lb on hand, lead ${num(d.leadTimeDays)} days`;
}

function toolResultLines(e: Extract<DeskEvent, { type: "tool_result" }>, o: RenderOptions): string[] {
  const d = e.data;
  const isStock = shortTool(e.tool) === "check_stock";
  if (d === null) {
    const tag = e.isError ? paint(o, "red", "error") : paint(o, "green", "ok");
    return [`   ${tag} ${clip(e.text, 160)} ${ms(e.ms)}`];
  }
  if (!d.ok) {
    let summary = clip(d.message, 160);
    // The tool may already name the suggestions in its message; add them only when the printed text lacks one.
    const shown = d.suggestions.every((s) => summary.includes(clip(s, 160)));
    if (d.suggestions.length > 0 && !shown) summary += ` Suggestions: ${clip(d.suggestions.join(", "), 120)}.`;
    const attempts = isStock && d.attempts !== null ? ` attempts ${d.attempts}/${STOCK_ATTEMPTS}` : "";
    return [`   ${paint(o, "red", d.code)} ${summary}${attempts} ${ms(e.ms)}`];
  }
  const attempts = "attempts" in d ? ` attempts ${d.attempts}/${STOCK_ATTEMPTS}` : "";
  return [`   ${paint(o, "green", "ok")} ${asciiText(okSummary(d))}${attempts} ${ms(e.ms)}`];
}

/** The first line of a run. `apiKey` names where the key came from, never its value. */
export function renderHeader(e: Extract<DeskEvent, { type: "run_started" }>, apiKey: string, o: RenderOptions): string {
  return headerCore(e, o) + asciiText(`  API key: ${apiKey}`);
}

function headerCore(e: Extract<DeskEvent, { type: "run_started" }>, o: RenderOptions): string {
  return paint(o, "bold", asciiText(`quote-desk-demo  ${e.rfqId}  model ${e.model}  effort ${e.effort}  ` +
    `stock fault ${e.stockFault}`));
}

function money$(n: number | null): string {
  return n === null ? "-" : money(n);
}

function deliveryLine(e: Extract<DeskEvent, { type: "delivery" }>, o: RenderOptions): string {
  switch (e.outcome) {
    case "sent": return paint(o, "green", asciiText(`Wrote out/outbox/${e.file ?? "?"}`));
    case "not_ready": return paint(o, "yellow", asciiText(`Held: ${e.reason ?? "not ready"}`));
    case "declined": return paint(o, "yellow", "Declined");
    case "not_attempted": return "Not offered for approval";
  }
}

/** The lines for one event. Event types this version doesn't know render nothing. */
export function renderEvent(e: DeskEvent, o: { color: boolean }): string[] {
  switch (e.type) {
    case "run_started":
      return [headerCore(e, o)];
    case "session_init": {
      const servers = e.mcpServers.map((s) => `${s.name} ${s.status}`).join(", ") || "none";
      return [paint(o, "dim", asciiText(`session  model ${e.model}  permission ${e.permissionMode}  ` +
        `tools ${e.tools.map(shortTool).join(", ")}  mcp ${servers}  skills ${e.skills.length}  ` +
        `plugins ${e.plugins.length}  auth ${e.apiKeySource}  claude code ${e.claudeCodeVersion}`))];
    }
    case "assistant_text": {
      const text = clip(e.text, 299);
      return text === "" ? [] : [paint(o, "dim", text)];
    }
    case "tool_call": {
      const tool = shortTool(e.tool);
      if (tool === STRUCTURED_OUTPUT_TOOL) return [`${paint(o, "cyan", "->")} ${tool} (quote draft)`];
      return [`${paint(o, "cyan", "->")} ${asciiText(tool)} ${compactInput(e.input)}`.trimEnd()];
    }
    case "tool_result":
      return toolResultLines(e, o);
    case "guard_denied":
      return [`   ${paint(o, "yellow", "[guard]")} ${clip(e.reason, 200)}`];
    case "model_refusal":
      return [paint(o, "red", asciiText(`[refusal] ${e.originalModel} refused (${e.category ?? "no category"}); ` +
        `fallback ${e.fallbackModel ?? "none"}`))];
    case "quote":
      return renderQuote(e.quote, o);
    case "approval_requested":
      return [asciiText(`Approval requested for ${e.rfqId}, total ${e.totalUsd === null ? "not priced" : `$${money(e.totalUsd)}`}`)];
    case "approval_resolved":
      return [`Decision: ${e.decision}`];
    case "delivery":
      return [deliveryLine(e, o)];
    case "run_finished": {
      const lines: string[] = [];
      if (!e.ok) {
        lines.push(paint(o, "red", `Run failed: ${asciiText(e.failure ?? "unknown")}` +
          (e.detail !== null && e.detail !== "" ? `: ${clip(e.detail, 200)}` : "")));
      }
      const cost = e.costUsd === null ? "cost unreported" : `cost $${e.costUsd.toFixed(2)} (SDK estimate)`;
      const turns = e.turns === null ? "turns -" : `turns ${e.turns}`;
      lines.push(`${cost}  ${turns}  ${(e.durationMs / 1000).toFixed(1)}s`);
      return lines;
    }
    default:
      return [];
  }
}

type Column = { title: string; right: boolean; cell: (l: QuoteLine) => string };

const COLUMNS: Column[] = [
  { title: "line", right: false, cell: (l) => clip(l.lineRef, 6) },
  { title: "part", right: false, cell: (l) => clip(l.partNumber, 16) },
  { title: "material", right: false,
    cell: (l) => l.materialCode !== null ? clip(l.materialCode, 16) : clip(`${l.materialAsRequested} (not in catalog)`, 36) },
  { title: "qty", right: true, cell: (l) => (l.quantity === null ? "?" : String(l.quantity)) },
  { title: "material $", right: true, cell: (l) => money$(l.materialCostPerPartUsd) },
  { title: "machining $", right: true, cell: (l) => money$(l.machiningCostPerPartUsd) },
  { title: "unit $", right: true, cell: (l) => money$(l.unitPriceUsd) },
  { title: "ext $", right: true, cell: (l) => money$(l.extendedUsd) },
  { title: "stock", right: false, cell: (l) => l.stock },
  { title: "lead", right: false, cell: (l) => (l.leadTimeDays === null ? "-" : `${l.leadTimeDays} d`) },
];

function questionLine(q: OpenQuestion): string {
  const where = q.lineRef === null ? "general" : `line ${q.lineRef}`;
  return `  ${asciiText(where)}, ${q.field}${q.blocking ? ", blocking" : ""}: ${clip(q.question, 400)}`;
}

/** The quote as a table, then open questions, assumptions, consistency errors and the total. */
export function renderQuote(q: Quote, o: { color: boolean }): string[] {
  const rows = q.lines.map((l) => COLUMNS.map((c) => c.cell(l)));
  const widths = COLUMNS.map((c, i) => Math.max(c.title.length, ...rows.map((r) => (r[i] ?? "").length)));
  const format = (cells: string[]): string => cells
    .map((cell, i) => {
      const width = widths[i] ?? cell.length;
      return COLUMNS[i]?.right === true ? cell.padStart(width) : cell.padEnd(width);
    })
    .join("  ")
    .trimEnd();

  const lines: string[] = [];
  lines.push(paint(o, "bold", asciiText(`Quote ${q.rfqId}  ${q.customer}  status ${q.status}`)));
  lines.push(paint(o, "bold", format(COLUMNS.map((c) => c.title))));
  for (const r of rows) lines.push(format(r));
  if (q.openQuestions.length > 0) {
    lines.push("Open questions:");
    for (const question of q.openQuestions) lines.push(questionLine(question));
  }
  if (q.assumptions.length > 0) {
    lines.push("Assumptions:");
    for (const a of q.assumptions) lines.push(`  - ${clip(a, 400)}`);
  }
  if (q.consistencyErrors.length > 0) {
    lines.push(paint(o, "red", "Consistency errors:"));
    for (const c of q.consistencyErrors) lines.push(`  ${clip(c, 400)}`);
  }
  lines.push(q.totalUsd === null
    ? paint(o, "bold", "Total: not priced while a line is blocked")
    : paint(o, "bold", `Total $${money(q.totalUsd)}`) + `  (margin ${num(q.marginPct)}%)`);
  return lines;
}
