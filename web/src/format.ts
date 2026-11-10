// Text formatting for the page. Plain TypeScript with no DOM, React or Node imports, so the Node tests
// can import it. Money matches money() in src/cli/render.ts, so the page and the terminal agree.
import type { StockState } from "../../src/contracts.ts";

/** "2,277.50": two decimals and thousands commas, never locale-dependent. */
export function money(n: number): string {
  const [whole = "0", cents = "00"] = Math.abs(n).toFixed(2).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${n < 0 ? "-" : ""}${grouped}.${cents}`;
}

/** "$2,277.50", or "not priced" for null. */
export function dollars(n: number | null): string {
  return n === null ? "not priced" : `$${money(n)}`;
}

/** "75 ms" for a tool call's time. */
export function millis(ms: number): string {
  return `${Math.max(0, Math.round(ms))} ms`;
}

/** "14.2 s" for a run's length. */
export function seconds(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(1)} s`;
}

/** "+/-0.002" for a tolerance in inches, "unknown" for null. */
export function tolerance(inches: number | null): string {
  if (inches === null || !Number.isFinite(inches)) return "unknown";
  return `+/-${String(inches)}`;
}

/** "10 days", or "unknown" for null. */
export function leadTime(days: number | null): string {
  if (days === null) return "unknown";
  return days === 1 ? "1 day" : `${days} days`;
}

const STOCK_WORDS: Record<StockState, string> = { in_stock: "in stock", short: "short", not_stocked: "not stocked",
  unverified: "unverified", not_checked: "not checked" };

/** The stock state in words. */
export function stockWords(s: StockState): string {
  return STOCK_WORDS[s] ?? s;
}

/** A number as printed: finite numbers as they are, anything else "?". */
export function num(n: number): string {
  return Number.isFinite(n) ? String(n) : "?";
}

/** "2026-11-10" from an ISO timestamp, or the text as given when it isn't one. */
export function isoDate(iso: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(iso);
  return m?.[1] ?? iso;
}

/** The stock service as the top strip names it: "ok", "down (simulated)" or "flaky (simulated)". */
export function stockServiceWords(fault: string): string {
  if (fault === "ok") return "ok";
  if (fault === "down") return "down (simulated)";
  if (fault.startsWith("flaky:") || fault.startsWith("fail-first:")) return "flaky (simulated)";
  return `${fault} (simulated)`;
}

/** One line of model or RFQ text: whitespace runs become one space, cut to max characters with "..." at the end. */
export function oneLine(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, Math.max(0, max - 3))}...`;
}
