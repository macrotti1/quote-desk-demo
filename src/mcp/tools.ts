// The four catalog tool handlers. Each one checks its input first, then the part, then the
// material, and returns an Ok object or a ToolError. Every price and weight comes from src/pricing.ts;
// the one sum done here is the informational minutesPerPart.
import { STOCK_ATTEMPTS, STOCK_BACKOFF_MS, stockLineKey } from "../contracts.ts";
import type {
  Catalog, CheckStockInput, CheckStockOk, EstimateCycleTimeInput, EstimateCycleTimeOk, LookupPartInput,
  LookupPartOk, Material, Part, PriceMaterialInput, PriceMaterialOk, ToolError, ToolErrorCode,
} from "../contracts.ts";
import {
  blankWeightLb, findPart, machiningCostPerPart, materialCostPerPart, normalizeMaterialText, operationEstimates,
  resolveMaterial, round2, stockCheck, stockSizeText, toleranceTier,
} from "../pricing.ts";
import type { StockBackend } from "./faults.ts";

const MAX_SUGGESTIONS = 3;

function toolError(code: ToolErrorCode, message: string, suggestions: string[] = [],
  attempts: number | null = null): ToolError {
  return { ok: false, code, message, suggestions, attempts };
}

function invalid(message: string): ToolError {
  return toolError("INVALID_INPUT", message);
}

// ---- input checks (5.4): every string trimmed and non-empty, quantity a whole number >= 1,
// toleranceIn > 0 when given. The shapes are registered with bare types, so these are the checks the model sees.

function checkText(field: string, value: unknown): ToolError | null {
  if (typeof value !== "string" || value.trim() === "") return invalid(`${field} must be a non-empty string.`);
  return null;
}

function checkQuantity(value: unknown): ToolError | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    return invalid(`quantity must be a whole number of at least 1 (got ${JSON.stringify(value) ?? "nothing"}).`);
  }
  return null;
}

function checkTolerance(value: unknown): ToolError | null {
  if (value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return invalid(`toleranceIn must be a positive number of inches when given (got ${JSON.stringify(value) ?? "nothing"}).`);
  }
  return null;
}

function firstError(...checks: (ToolError | null)[]): ToolError | null {
  for (const c of checks) if (c !== null) return c;
  return null;
}

// ---- lookups

function partOrError(catalog: Catalog, partNumber: string): Part | ToolError {
  const part = findPart(catalog, partNumber);
  if (part === null) return toolError("NOT_FOUND", `No part numbered ${partNumber.trim()} is in the catalog.`);
  return part;
}

/** Edit distance between two strings, counting single-character inserts, deletes and substitutions. */
function levenshtein(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, (previous[j - 1] ?? 0) + cost);
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

/**
 * Up to 3 stocked material names nearest the normalized input. A material's distance is its smallest
 * Levenshtein distance over its name and aliases; ties go to the lower code.
 */
export function materialSuggestions(catalog: Catalog, text: string): string[] {
  const wanted = normalizeMaterialText(text);
  return catalog.materials
    .filter((m) => m.stocked)
    .map((m) => ({ m, distance: Math.min(...[m.name, ...m.aliases].map((n) => levenshtein(wanted, normalizeMaterialText(n)))) }))
    .sort((x, y) => x.distance - y.distance || (x.m.code < y.m.code ? -1 : x.m.code > y.m.code ? 1 : 0))
    .slice(0, MAX_SUGGESTIONS)
    .map((s) => s.m.name);
}

function materialOrError(catalog: Catalog, text: string): Material | ToolError {
  const material = resolveMaterial(catalog, text);
  if (material !== null) return material;
  const suggestions = materialSuggestions(catalog, text);
  const hint = suggestions.length > 0 ? ` Nearest stocked materials: ${suggestions.join(", ")}.` : "";
  return toolError("UNKNOWN_MATERIAL", `No catalog material matches "${text.trim()}".${hint}`, suggestions);
}

function isError<T extends object>(x: T | ToolError): x is ToolError {
  return "ok" in x && x.ok === false;
}

// ---- handlers

export function lookupPart(catalog: Catalog, input: LookupPartInput): LookupPartOk | ToolError {
  const bad = checkText("partNumber", input.partNumber);
  if (bad !== null) return bad;
  const part = partOrError(catalog, input.partNumber);
  if (isError(part)) return part;
  return { ok: true, partNumber: part.partNumber, description: part.description, family: part.family,
    stockShape: part.stock.shape, stockSize: stockSizeText(part.stock), standardToleranceIn: part.standardToleranceIn,
    operationCount: part.routing.length };
}

export function priceMaterial(catalog: Catalog, input: PriceMaterialInput): PriceMaterialOk | ToolError {
  const bad = firstError(checkText("partNumber", input.partNumber), checkText("material", input.material));
  if (bad !== null) return bad;
  const part = partOrError(catalog, input.partNumber);
  if (isError(part)) return part;
  const material = materialOrError(catalog, input.material);
  if (isError(material)) return material;
  return { ok: true, partNumber: part.partNumber, materialCode: material.code, materialName: material.name,
    stocked: material.stocked, stockSize: stockSizeText(part.stock), blankWeightLb: round2(blankWeightLb(part, material)),
    usdPerLb: material.usdPerLb, costPerPartUsd: materialCostPerPart(part, material) };
}

export function estimateCycleTime(catalog: Catalog, input: EstimateCycleTimeInput): EstimateCycleTimeOk | ToolError {
  const bad = firstError(checkText("partNumber", input.partNumber), checkText("material", input.material),
    checkQuantity(input.quantity), checkTolerance(input.toleranceIn));
  if (bad !== null) return bad;
  const part = partOrError(catalog, input.partNumber);
  if (isError(part)) return part;
  const material = materialOrError(catalog, input.material);
  if (isError(material)) return material;
  const toleranceIn = input.toleranceIn ?? part.standardToleranceIn;
  const operations = operationEstimates(catalog, part, material, input.quantity, toleranceIn);
  // Run minutes per part over every step, setup left out. pricing.ts has no function for this
  // informational field, so it is summed here from the per-step estimates.
  const minutesPerPart = round2(operations.reduce((sum, o) => sum + o.runMinPerPart, 0));
  return { ok: true, partNumber: part.partNumber, materialCode: material.code, quantity: input.quantity, toleranceIn,
    toleranceTier: toleranceTier(part, toleranceIn), operations, minutesPerPart,
    machiningCostPerPartUsd: machiningCostPerPart(catalog, part, material, input.quantity, toleranceIn) };
}

export function stockUnavailable(): ToolError {
  return toolError("STOCK_UNAVAILABLE",
    `Inventory service timed out on ${STOCK_ATTEMPTS} of ${STOCK_ATTEMPTS} attempts (simulated). Stock is unverified.`,
    [], STOCK_ATTEMPTS);
}

/**
 * Checks stock for one line: up to STOCK_ATTEMPTS backend attempts on the line's key, waiting
 * STOCK_BACKOFF_MS between them, stopping at the first success.
 */
export async function checkStock(catalog: Catalog, input: CheckStockInput, backend: StockBackend,
  sleep: (ms: number) => Promise<void>): Promise<CheckStockOk | ToolError> {
  const bad = firstError(checkText("material", input.material), checkText("partNumber", input.partNumber),
    checkQuantity(input.quantity));
  if (bad !== null) return bad;
  const part = partOrError(catalog, input.partNumber);
  if (isError(part)) return part;
  const material = materialOrError(catalog, input.material);
  if (isError(material)) return material;
  const key = stockLineKey(material.code, part.partNumber, input.quantity);
  for (let attemptNo = 1; attemptNo <= STOCK_ATTEMPTS; attemptNo++) {
    if (attemptNo > 1) await sleep(STOCK_BACKOFF_MS[attemptNo - 2] ?? 0);
    if (await backend.attempt(key)) {
      const s = stockCheck(catalog, material, part, input.quantity);
      return { ok: true, materialCode: material.code, partNumber: part.partNumber, quantity: input.quantity,
        requiredLb: s.requiredLb, onHandLb: s.onHandLb, status: s.status, leadTimeDays: s.leadTimeDays, attempts: attemptNo };
    }
  }
  return stockUnavailable();
}
