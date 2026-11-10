// The catalog tool handlers and the simulated stock backend, called directly. No model, no network.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import {
  CheckStockOkSchema, DEFAULT_FAULT_SEED, EstimateCycleTimeOkSchema, LookupPartOkSchema, PriceMaterialOkSchema,
  STOCK_ATTEMPTS, ToolErrorSchema, expectedStock, parseStockFault, stockLineKey,
} from "../src/contracts.ts";
import type { Catalog, CheckStockOk, EstimateCycleTimeOk, PriceMaterialOk, ToolError, ToolResult } from "../src/contracts.ts";
import { loadCatalog } from "../src/load.ts";
import { PATHS } from "../src/paths.ts";
import { extendedPrice, round2, unitPrice } from "../src/pricing.ts";
import { createStockBackend } from "../src/mcp/faults.ts";
import type { StockBackend } from "../src/mcp/faults.ts";
import { checkStock, estimateCycleTime, lookupPart, materialSuggestions, priceMaterial } from "../src/mcp/tools.ts";

const catalog: Catalog = loadCatalog(join(PATHS.miniDir, "catalog.json"));

/** An instant sleep that records every wait it was asked for. */
function fakeSleep(): { sleep: (ms: number) => Promise<void>; waits: number[] } {
  const waits: number[] = [];
  return { waits, sleep: (ms: number) => { waits.push(ms); return Promise.resolve(); } };
}

function backendFor(fault: string, faultSeed = DEFAULT_FAULT_SEED, delayMs = 0) {
  const { sleep, waits } = fakeSleep();
  return { backend: createStockBackend({ fault: parseStockFault(fault), faultSeed, delayMs, sleep }), sleep, waits };
}

function assertOk<T extends ToolResult>(r: T | ToolError): T {
  assert.equal(r.ok, true, `expected Ok, got ${JSON.stringify(r)}`);
  return r as T;
}

function assertError(r: ToolResult, code: ToolError["code"]): ToolError {
  assert.equal(r.ok, false, `expected ${code}, got ${JSON.stringify(r)}`);
  const e = ToolErrorSchema.parse(r);
  assert.equal(e.code, code);
  return e;
}

/** An Ok object carries exactly the keys of its schema, so the MCP client's additionalProperties check passes. */
function assertExactKeys(r: object, shape: object): void {
  assert.deepEqual(Object.keys(r).sort(), Object.keys(shape).sort());
}

type Line = { part: string; material: string; quantity: number; toleranceIn?: number };

/** Prices one line through the tools, the way the agent would. */
async function quoteLine(line: Line, backend: StockBackend, sleep: (ms: number) => Promise<void>) {
  const price = assertOk<PriceMaterialOk>(priceMaterial(catalog, { partNumber: line.part, material: line.material }));
  const estimate = assertOk<EstimateCycleTimeOk>(estimateCycleTime(catalog, { partNumber: line.part,
    material: line.material, quantity: line.quantity, ...(line.toleranceIn === undefined ? {} : { toleranceIn: line.toleranceIn }) }));
  const stock = assertOk<CheckStockOk>(await checkStock(catalog, { material: line.material, partNumber: line.part,
    quantity: line.quantity }, backend, sleep));
  const unit = unitPrice(price.costPerPartUsd, estimate.machiningCostPerPartUsd, catalog.marginPct);
  return { price, estimate, stock, unit, extended: extendedPrice(unit, line.quantity) };
}

// ---- goldens

test("the 5.3 golden: QD-90001 in AL-6061-T6 at 40, standard and tight", async () => {
  const { backend, sleep } = backendFor("ok");
  const standard = await quoteLine({ part: "QD-90001", material: "AL-6061-T6", quantity: 40, toleranceIn: 0.005 }, backend, sleep);
  assert.equal(standard.price.costPerPartUsd, 4.91);
  assert.equal(standard.estimate.toleranceTier, "standard");
  assert.equal(standard.estimate.machiningCostPerPartUsd, 13.69);
  assert.equal(standard.unit, 24.18);
  assert.equal(standard.extended, 967.2);
  assert.equal(standard.stock.requiredLb, 46.8);

  const tight = await quoteLine({ part: "QD-90001", material: "AL-6061-T6", quantity: 40, toleranceIn: 0.002 }, backend, sleep);
  assert.equal(tight.price.costPerPartUsd, 4.91);
  assert.equal(tight.estimate.toleranceTier, "tight");
  assert.equal(tight.estimate.toleranceIn, 0.002);
  assert.equal(tight.estimate.machiningCostPerPartUsd, 17.66);
  assert.equal(tight.unit, 29.34);
  assert.equal(tight.extended, 1173.6);
  assert.equal(tight.stock.requiredLb, 46.8);
});

test("estimate_cycle_time lists each operation in routing order, the saw never takes the tight factor", () => {
  const r = assertOk<EstimateCycleTimeOk>(estimateCycleTime(catalog,
    { partNumber: "QD-90001", material: "AL-6061-T6", quantity: 40, toleranceIn: 0.002 }));
  assert.deepEqual(r.operations.map((o) => [o.op, o.machineId, o.machineKind, o.usdPerHour, o.setupMin, o.runMinPerPart]),
    [[10, "SAW-1", "saw", 40, 6, 1], [20, "MILL3-1", "mill3", 85, 45, 10.8]]);
  // Run minutes only: 1.0 on the saw plus 8.0 * 1.35 on the mill.
  assert.equal(r.minutesPerPart, 11.8);
  const standard = assertOk<EstimateCycleTimeOk>(estimateCycleTime(catalog,
    { partNumber: "QD-90001", material: "AL-6061-T6", quantity: 40, toleranceIn: 0.005 }));
  assert.equal(standard.minutesPerPart, 9);
  assert.ok(EstimateCycleTimeOkSchema.safeParse(r).success);
  assertExactKeys(r, EstimateCycleTimeOkSchema.shape);
});

const MINI_TABLE: { name: string; line: Line; material: number; machining: number; unit: number; extended: number;
  requiredLb: number; status: CheckStockOk["status"]; lead: number; toleranceIn: number; tier: "standard" | "tight" }[] = [
  { name: "MINI-001 line 1", line: { part: "QD-90001", material: "6061-T6", quantity: 40, toleranceIn: 0.002 },
    material: 4.91, machining: 17.66, unit: 29.34, extended: 1173.6, requiredLb: 46.8, status: "in_stock", lead: 10,
    toleranceIn: 0.002, tier: "tight" },
  { name: "MINI-004 line 2", line: { part: "QD-90004", material: "304 stainless", quantity: 100, toleranceIn: 0.005 },
    material: 1.74, machining: 7.83, unit: 12.44, extended: 1244, requiredLb: 34.1, status: "short", lead: 20,
    toleranceIn: 0.005, tier: "standard" },
  { name: "MINI-005 line 1", line: { part: "QD-90002", material: "410 stainless", quantity: 25 },
    material: 5.14, machining: 16.04, unit: 27.53, extended: 688.25, requiredLb: 32.97, status: "not_stocked", lead: 24,
    toleranceIn: 0.002, tier: "standard" },
  { name: "MINI-006 line 1", line: { part: "QD-90001", material: "6061 aluminum", quantity: 20, toleranceIn: 0.01 },
    material: 4.91, machining: 15.39, unit: 26.39, extended: 527.8, requiredLb: 23.4, status: "in_stock", lead: 10,
    toleranceIn: 0.01, tier: "standard" },
  { name: "MINI-006 line 2", line: { part: "QD-90003", material: "POM", quantity: 50 },
    material: 1.14, machining: 13.22, unit: 18.67, extended: 933.5, requiredLb: 10.2, status: "in_stock", lead: 10,
    toleranceIn: 0.005, tier: "standard" },
];

for (const row of MINI_TABLE) {
  test(`the mini table: ${row.name} prices to the cent, ${row.status}, lead ${row.lead}`, async () => {
    const { backend, sleep } = backendFor("ok");
    const q = await quoteLine(row.line, backend, sleep);
    assert.equal(q.price.costPerPartUsd, row.material);
    assert.equal(q.estimate.machiningCostPerPartUsd, row.machining);
    assert.equal(q.estimate.toleranceIn, row.toleranceIn);
    assert.equal(q.estimate.toleranceTier, row.tier);
    assert.equal(q.unit, row.unit);
    assert.equal(q.extended, row.extended);
    assert.equal(q.stock.requiredLb, row.requiredLb);
    assert.equal(q.stock.status, row.status);
    assert.equal(q.stock.leadTimeDays, row.lead);
    assert.equal(q.stock.attempts, 1);
  });
}

test("the mini table: MINI-006 totals 1461.30", async () => {
  const { backend, sleep } = backendFor("ok");
  const lines = MINI_TABLE.filter((r) => r.name.startsWith("MINI-006"));
  assert.equal(lines.length, 2);
  let total = 0;
  for (const r of lines) total += (await quoteLine(r.line, backend, sleep)).extended;
  assert.equal(round2(total), 1461.3);
});

test("lookup_part returns the part's facts with exactly its schema's keys", () => {
  const r = assertOk(lookupPart(catalog, { partNumber: " qd-90002 " }));
  assert.deepEqual(r, { ok: true, partNumber: "QD-90002", description: "Drive shaft", family: "shaft",
    stockShape: "round_bar", stockSize: "1.000 dia x 6.00", standardToleranceIn: 0.002, operationCount: 2 });
  assert.ok(LookupPartOkSchema.safeParse(r).success);
  assertExactKeys(r, LookupPartOkSchema.shape);
});

test("price_material and check_stock Ok objects carry exactly their schema's keys", async () => {
  const price = assertOk<PriceMaterialOk>(priceMaterial(catalog, { partNumber: "QD-90004", material: "304 SS" }));
  assert.equal(price.materialCode, "SS-304");
  assert.equal(price.materialName, "Stainless 304");
  assert.equal(price.stocked, true);
  assert.equal(price.stockSize, "1.000 dia x 1.50");
  assert.equal(price.usdPerLb, 5.1);
  assert.ok(PriceMaterialOkSchema.safeParse(price).success);
  assertExactKeys(price, PriceMaterialOkSchema.shape);
  const { backend, sleep } = backendFor("ok");
  const stock = assertOk<CheckStockOk>(await checkStock(catalog, { material: "SS-304", partNumber: "QD-90004", quantity: 10 }, backend, sleep));
  assert.ok(CheckStockOkSchema.safeParse(stock).success);
  assertExactKeys(stock, CheckStockOkSchema.shape);
});

// ---- error codes

test("an unknown part is NOT_FOUND in every tool, before the material is looked at", async () => {
  const { backend, sleep } = backendFor("ok");
  const results: ToolResult[] = [
    lookupPart(catalog, { partNumber: "QD-00000" }),
    priceMaterial(catalog, { partNumber: "QD-00000", material: "unobtainium" }),
    estimateCycleTime(catalog, { partNumber: "QD-00000", material: "unobtainium", quantity: 5 }),
    await checkStock(catalog, { material: "unobtainium", partNumber: "QD-00000", quantity: 5 }, backend, sleep),
  ];
  for (const r of results) {
    const e = assertError(r, "NOT_FOUND");
    assert.deepEqual(e.suggestions, []);
    assert.equal(e.attempts, null);
    assert.match(e.message, /QD-00000/);
  }
});

test("an unknown material is UNKNOWN_MATERIAL with up to 3 stocked suggestions in every tool that takes one", async () => {
  const { backend, sleep } = backendFor("ok");
  const results: ToolResult[] = [
    priceMaterial(catalog, { partNumber: "QD-90002", material: "Ti-6Al-4V titanium" }),
    estimateCycleTime(catalog, { partNumber: "QD-90002", material: "Ti-6Al-4V titanium", quantity: 10 }),
    await checkStock(catalog, { material: "Ti-6Al-4V titanium", partNumber: "QD-90002", quantity: 10 }, backend, sleep),
  ];
  const stockedNames = catalog.materials.filter((m) => m.stocked).map((m) => m.name);
  for (const r of results) {
    const e = assertError(r, "UNKNOWN_MATERIAL");
    assert.equal(e.attempts, null);
    assert.ok(e.suggestions.length >= 1 && e.suggestions.length <= 3);
    for (const s of e.suggestions) assert.ok(stockedNames.includes(s), `${s} is a stocked material name`);
    assert.match(e.message, /Ti-6Al-4V titanium/);
  }
});

test("UNKNOWN_MATERIAL suggestions: nearest first, stocked only, ties broken by code", () => {
  // One letter off the alias "acetal".
  assert.equal(materialSuggestions(catalog, "Acetel")[0], "Acetal (POM)");
  // Nearest is Stainless 410, which isn't stocked, so it never shows.
  const typo = assertError(priceMaterial(catalog, { partNumber: "QD-90002", material: "410 stainles" }), "UNKNOWN_MATERIAL");
  assert.ok(!typo.suggestions.includes("Stainless 410"));
  assert.equal(typo.suggestions[0], "Stainless 304");
  // Thirty letters that share nothing with any name: every material is 30 edits away, so code order decides.
  assert.deepEqual(materialSuggestions(catalog, "z".repeat(30)), ["Aluminum 6061-T6", "Acetal (POM)", "Stainless 304"]);
});

// ---- input checks

test("input checks: quantity 0, quantity 2.5, toleranceIn -1 and material \"\" are INVALID_INPUT", async () => {
  const base = { partNumber: "QD-90001", material: "AL-6061-T6" };
  const { backend, sleep } = backendFor("ok");
  const cases: { field: string; result: ToolResult }[] = [
    { field: "quantity", result: estimateCycleTime(catalog, { ...base, quantity: 0 }) },
    { field: "quantity", result: estimateCycleTime(catalog, { ...base, quantity: 2.5 }) },
    { field: "quantity", result: await checkStock(catalog, { ...base, quantity: 0 }, backend, sleep) },
    { field: "quantity", result: await checkStock(catalog, { ...base, quantity: 2.5 }, backend, sleep) },
    { field: "toleranceIn", result: estimateCycleTime(catalog, { ...base, quantity: 10, toleranceIn: -1 }) },
    { field: "material", result: priceMaterial(catalog, { ...base, material: "" }) },
    { field: "material", result: estimateCycleTime(catalog, { ...base, material: "", quantity: 10 }) },
    { field: "material", result: await checkStock(catalog, { ...base, material: "", quantity: 10 }, backend, sleep) },
    { field: "partNumber", result: lookupPart(catalog, { partNumber: "   " }) },
  ];
  for (const c of cases) {
    const e = assertError(c.result, "INVALID_INPUT");
    assert.ok(e.message.includes(c.field), `"${e.message}" names ${c.field}`);
    assert.deepEqual(e.suggestions, []);
    assert.equal(e.attempts, null);
  }
});

test("input checks: toleranceIn 0 is INVALID_INPUT, since a tolerance must be above zero", () => {
  const e = assertError(estimateCycleTime(catalog, { partNumber: "QD-90001", material: "AL-6061-T6", quantity: 10,
    toleranceIn: 0 }), "INVALID_INPUT");
  assert.ok(e.message.includes("toleranceIn"), `"${e.message}" names toleranceIn`);
  assert.deepEqual(e.suggestions, []);
  assert.equal(e.attempts, null);
});

test("input checks run before any lookup, and a bad check_stock call never reaches the backend", async () => {
  assertError(estimateCycleTime(catalog, { partNumber: "QD-00000", material: "unobtainium", quantity: 0 }), "INVALID_INPUT");
  let calls = 0;
  const spy: StockBackend = { attempt: () => { calls++; return Promise.resolve(true); } };
  const { sleep } = fakeSleep();
  assertError(await checkStock(catalog, { material: "AL-6061-T6", partNumber: "QD-90001", quantity: 2.5 }, spy, sleep), "INVALID_INPUT");
  assertError(await checkStock(catalog, { material: "AL-6061-T6", partNumber: "QD-00000", quantity: 2 }, spy, sleep), "NOT_FOUND");
  assertError(await checkStock(catalog, { material: "unobtainium", partNumber: "QD-90001", quantity: 2 }, spy, sleep), "UNKNOWN_MATERIAL");
  assert.equal(calls, 0);
});

test("a tolerance at or above the part standard is standard, below it is tight, and omitted means the standard", () => {
  const base = { partNumber: "QD-90001", material: "AL-6061-T6", quantity: 40 };
  const omitted = assertOk<EstimateCycleTimeOk>(estimateCycleTime(catalog, base));
  assert.equal(omitted.toleranceIn, 0.005);
  assert.equal(omitted.toleranceTier, "standard");
  assert.equal(omitted.machiningCostPerPartUsd, 13.69);
  assert.equal(assertOk<EstimateCycleTimeOk>(estimateCycleTime(catalog, { ...base, toleranceIn: 0.005 })).toleranceTier, "standard");
  assert.equal(assertOk<EstimateCycleTimeOk>(estimateCycleTime(catalog, { ...base, toleranceIn: 0.004 })).toleranceTier, "tight");
});

// ---- fault modes: one check_stock call per mode

const MINI_001_LINE = { material: "AL-6061-T6", partNumber: "QD-90001", quantity: 40 };
const MINI_001_KEY = stockLineKey("AL-6061-T6", "QD-90001", 40);

const FAULT_ROWS: { fault: string; verified: boolean; attempts: number }[] = [
  { fault: "ok", verified: true, attempts: 1 },
  { fault: "fail-first:1", verified: true, attempts: 2 },
  { fault: "fail-first:2", verified: true, attempts: 3 },
  { fault: "fail-first:3", verified: false, attempts: 3 },
  { fault: "down", verified: false, attempts: 3 },
];

for (const row of FAULT_ROWS) {
  test(`fault ${row.fault}: ${row.verified ? `Ok with attempts ${row.attempts}` : "STOCK_UNAVAILABLE"}, as expectedStock says`, async () => {
    const { backend, sleep } = backendFor(row.fault);
    const r = await checkStock(catalog, MINI_001_LINE, backend, sleep);
    const expected = expectedStock(parseStockFault(row.fault), DEFAULT_FAULT_SEED, MINI_001_KEY);
    assert.deepEqual(expected, { verified: row.verified, attempts: row.attempts });
    if (row.verified) {
      assert.equal(assertOk<CheckStockOk>(r).attempts, expected.attempts);
    } else {
      const e = assertError(r, "STOCK_UNAVAILABLE");
      assert.equal(e.attempts, expected.attempts);
      assert.equal(e.message, "Inventory service timed out on 3 of 3 attempts (simulated). Stock is unverified.");
      assert.deepEqual(e.suggestions, []);
    }
  });
}

test("fault down: 3 attempts, each waits the stock delay, with 200 then 400 between them", async () => {
  const { sleep, waits } = fakeSleep();
  let attempts = 0;
  const inner = createStockBackend({ fault: parseStockFault("down"), faultSeed: DEFAULT_FAULT_SEED, delayMs: 7, sleep });
  const counting: StockBackend = { attempt: (key) => { attempts++; return inner.attempt(key); } };
  assertError(await checkStock(catalog, MINI_001_LINE, counting, sleep), "STOCK_UNAVAILABLE");
  assert.equal(attempts, STOCK_ATTEMPTS);
  assert.deepEqual(waits, [7, 200, 7, 400, 7]);
});

test("fault flaky:0.7 seed 7 on MINI-006: line 1 Ok on attempt 3, line 2 STOCK_UNAVAILABLE", async () => {
  const fault = parseStockFault("flaky:0.7");
  const { backend, sleep } = backendFor("flaky:0.7", 7);
  const line1 = await checkStock(catalog, { material: "6061 aluminum", partNumber: "QD-90001", quantity: 20 }, backend, sleep);
  const line2 = await checkStock(catalog, { material: "POM", partNumber: "QD-90003", quantity: 50 }, backend, sleep);
  const e1 = expectedStock(fault, 7, "AL-6061-T6|QD-90001|20");
  const e2 = expectedStock(fault, 7, "PL-POM|QD-90003|50");
  assert.deepEqual(e1, { verified: true, attempts: 3 });
  assert.deepEqual(e2, { verified: false, attempts: 3 });
  const ok = assertOk<CheckStockOk>(line1);
  assert.equal(ok.attempts, 3);
  assert.equal(ok.status, "in_stock");
  assert.equal(assertError(line2, "STOCK_UNAVAILABLE").attempts, 3);
});

// ---- the backend's counters

test("the backend counts attempts per key, and the count persists for a key within one backend", async () => {
  const { backend } = backendFor("fail-first:3");
  const a: boolean[] = [];
  for (let i = 0; i < 4; i++) a.push(await backend.attempt("A|QD-1|1"));
  assert.deepEqual(a, [false, false, false, true]);
  // A new key starts at attempt 1, whatever the other key has used.
  assert.equal(await backend.attempt("B|QD-1|1"), false);
  // A second backend is a second server process: its counters start over.
  const { backend: fresh } = backendFor("fail-first:3");
  assert.equal(await fresh.attempt("A|QD-1|1"), false);
});

test("check_stock: a second call on a key picks up where the first left off, other keys are independent", async () => {
  const { backend, sleep } = backendFor("fail-first:3");
  assertError(await checkStock(catalog, MINI_001_LINE, backend, sleep), "STOCK_UNAVAILABLE");
  // Attempt 4 on this key passes, so the second call verifies on its first attempt.
  assert.equal(assertOk<CheckStockOk>(await checkStock(catalog, MINI_001_LINE, backend, sleep)).attempts, 1);
  // Same part and material, another quantity: another key, starting at attempt 1.
  assertError(await checkStock(catalog, { ...MINI_001_LINE, quantity: 41 }, backend, sleep), "STOCK_UNAVAILABLE");
  // The key is built from the material code and the normalized part number, whatever the model typed.
  assert.equal(assertOk<CheckStockOk>(await checkStock(catalog, { material: "6061", partNumber: " qd-90001 ", quantity: 41 },
    backend, sleep)).attempts, 1);
});
