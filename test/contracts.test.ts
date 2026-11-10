// Contracts, arithmetic, fault schedule and recordings. No model, no network, no API key.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CATALOG_TOOLS, CasesFileSchema, DESK_EVENT_TYPES, DeskEventSchema, QUOTE_DRAFT_JSON_SCHEMA, QuoteDraftSchema,
  RFQ_ID_PATTERN, RfqSchema,
  SCHEMA_BOUND_KEYS, STOCK_ATTEMPTS, SYNTHETIC_NOTICE, TOOL_RESULT_SCHEMAS, expectedStock, formatStockFault,
  fullToolName, parseStockFault, stockAttemptFails, stockLineKey,
} from "../src/contracts.ts";
import type { Catalog, Quote, QuoteDraft, RfqTruth, StockFault, TruthLine } from "../src/contracts.ts";
import { fileHash, loadCatalog, loadRfqs, loadTruth, readDotEnv, sha256Hex } from "../src/load.ts";
import { PATHS, bundledClaudeCodeVersion, repoRelative, sdkVersion } from "../src/paths.ts";
import {
  blankWeightLb, extendedPrice, findMachine, findPart, machiningCostPerPart, materialCostPerPart,
  normalizeMaterialText, operationEstimates, resolveMaterial, round2, stockCheck, stockSizeText, stockVolumeIn3,
  toleranceTier, unitPrice,
} from "../src/pricing.ts";
import { headerFromEvents, readRecording, serializeQuote, writeRecording } from "../src/recording.ts";
import { faultDraw, fmix32, fnv1a32, mulberry32 } from "../src/rng.ts";

const mini = (name: string): string => join(PATHS.miniDir, name);
const catalog: Catalog = loadCatalog(mini("catalog.json"));
const truth: RfqTruth[] = loadTruth(mini("rfq-truth.json"));

function truthLine(rfqId: string, lineRef: string): TruthLine {
  const line = truth.find((t) => t.rfqId === rfqId)?.lines.find((l) => l.lineRef === lineRef);
  assert.ok(line, `${rfqId} line ${lineRef} is in the truth file`);
  return line;
}

/** Prices one truth line the way the host does, from the catalog alone. */
function price(rfqId: string, lineRef: string) {
  const line = truthLine(rfqId, lineRef);
  assert.ok(line.materialCode !== null && line.quantity !== null && line.toleranceIn !== null);
  const part = findPart(catalog, line.partNumber);
  const material = resolveMaterial(catalog, line.materialAsRequested);
  assert.ok(part && material);
  assert.equal(material.code, line.materialCode);
  const materialCost = materialCostPerPart(part, material);
  const machiningCost = machiningCostPerPart(catalog, part, material, line.quantity, line.toleranceIn);
  const unit = unitPrice(materialCost, machiningCost, catalog.marginPct);
  return { tier: toleranceTier(part, line.toleranceIn), materialCost, machiningCost, unit,
    extended: extendedPrice(unit, line.quantity), stock: stockCheck(catalog, material, part, line.quantity), line };
}

test("the mini fixture parses and carries the synthetic-data notice", () => {
  assert.equal(catalog.materials.length, 4);
  assert.equal(catalog.machines.length, 3);
  assert.equal(catalog.parts.length, 4);
  assert.equal(catalog.notice, SYNTHETIC_NOTICE);
  const rfqs = loadRfqs(mini("rfqs.json"));
  assert.deepEqual(rfqs.map((r) => r.id), ["MINI-001", "MINI-002", "MINI-003", "MINI-004", "MINI-005", "MINI-006"]);
  assert.deepEqual(truth.map((t) => t.rfqId), rfqs.map((r) => r.id));
  for (const r of rfqs) assert.match(r.contactEmail, /\.example$/);
  for (const p of catalog.parts) assert.equal(p.blankVolumeIn3, round2(stockVolumeIn3(p.stock)));
});

test("a bad data file fails with the file name and no absolute path", () => {
  assert.throws(() => loadCatalog(mini("rfqs.json")), (err: Error) => {
    assert.match(err.message, /^rfqs\.json: /);
    assert.ok(!err.message.includes(PATHS.root));
    return true;
  });
  assert.throws(() => loadCatalog(mini("missing.json")), /^Error: missing\.json: cannot read the file \(ENOENT\)$/);
});

test("the catalog schema checks references", () => {
  const raw = JSON.parse(readFileSync(mini("catalog.json"), "utf8")) as Catalog;
  const first = raw.parts[0];
  assert.ok(first);
  first.routing = [{ op: 10, machineId: "MILL9-9", setupMin: 1, cycleMinPerPart: 1 }];
  const dir = mkdtempSync(join(tmpdir(), "qd-"));
  try {
    const file = join(dir, "catalog.json");
    writeFileSync(file, JSON.stringify(raw));
    assert.throws(() => loadCatalog(file), /unknown machine MILL9-9/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("golden example: QD-90001 in 6061 at quantity 40", () => {
  const part = findPart(catalog, "qd-90001 ");
  const al = resolveMaterial(catalog, "  6061   Aluminum ");
  assert.ok(part && al);
  assert.equal(al.code, "AL-6061-T6");
  assert.equal(materialCostPerPart(part, al), 4.91);
  const rows: [number, "standard" | "tight", number, number, number][] = [
    [0.005, "standard", 13.69, 24.18, 967.2],
    [0.002, "tight", 17.66, 29.34, 1173.6],
  ];
  for (const [tolerance, tier, machining, unit, extended] of rows) {
    assert.equal(toleranceTier(part, tolerance), tier);
    assert.equal(machiningCostPerPart(catalog, part, al, 40, tolerance), machining);
    assert.equal(unitPrice(4.91, machining, 30), unit);
    assert.equal(extendedPrice(unit, 40), extended);
  }
  assert.equal(stockCheck(catalog, al, part, 40).requiredLb, 46.8);
  // The saw never takes the tight factor; the mill does.
  const ops = operationEstimates(catalog, part, al, 40, 0.002);
  assert.deepEqual(ops.map((o) => [o.op, o.machineId, o.machineKind, o.runMinPerPart, o.costPerPartUsd]),
    [[10, "SAW-1", "saw", 1, 0.77], [20, "MILL3-1", "mill3", 10.8, 16.89]]);
});

test("the mini table matches to the cent", () => {
  const rows: [string, string, "standard" | "tight", number, number, number, number, number, string, number][] = [
    ["MINI-001", "1", "tight", 4.91, 17.66, 29.34, 1173.6, 46.8, "in_stock", 10],
    ["MINI-004", "2", "standard", 1.74, 7.83, 12.44, 1244, 34.1, "short", 20],
    ["MINI-005", "1", "standard", 5.14, 16.04, 27.53, 688.25, 32.97, "not_stocked", 24],
    ["MINI-006", "1", "standard", 4.91, 15.39, 26.39, 527.8, 23.4, "in_stock", 10],
    ["MINI-006", "2", "standard", 1.14, 13.22, 18.67, 933.5, 10.2, "in_stock", 10],
  ];
  for (const [rfqId, lineRef, tier, material, machining, unit, extended, requiredLb, status, lead] of rows) {
    const p = price(rfqId, lineRef);
    const got = [p.tier, p.materialCost, p.machiningCost, p.unit, p.extended, p.stock.requiredLb, p.stock.status,
      p.stock.leadTimeDays];
    assert.deepEqual(got, [tier, material, machining, unit, extended, requiredLb, status, lead], `${rfqId} line ${lineRef}`);
    assert.equal(p.line.stockIfOk, status);
    assert.equal(p.line.leadTimeDaysIfOk, lead);
  }
  assert.equal(round2(price("MINI-006", "1").extended + price("MINI-006", "2").extended), 1461.3);
});

test("blocked truth lines are labelled, and unknown materials don't resolve", () => {
  const unknown = truthLine("MINI-002", "1");
  assert.deepEqual([unknown.materialCode, unknown.blockedBy, unknown.keyword, unknown.stockIfOk],
    [null, "material", "Ti-6Al-4V", "not_checked"]);
  assert.equal(resolveMaterial(catalog, unknown.materialAsRequested), null);
  assert.equal(resolveMaterial(catalog, "   "), null);
  assert.deepEqual([truthLine("MINI-003", "1").quantity, truthLine("MINI-003", "1").blockedBy], [null, "quantity"]);
  const conflict = truthLine("MINI-004", "1");
  assert.deepEqual([conflict.toleranceIn, conflict.conflictingTolerances, conflict.blockedBy],
    [null, [0.002, 0.005], "tolerance"]);
});

test("lookups, text helpers and stock geometry", () => {
  assert.equal(normalizeMaterialText("  304   Stainless "), "304 stainless");
  assert.equal(resolveMaterial(catalog, "ss-304")?.code, "SS-304");
  assert.equal(resolveMaterial(catalog, "acetal (pom)")?.code, "PL-POM");
  assert.equal(findPart(catalog, "QD-99999"), null);
  assert.equal(findMachine(catalog, "LATHE-1").usdPerHour, 75);
  assert.throws(() => findMachine(catalog, "MILL5-1"), /unknown machine: MILL5-1/);
  const plate = findPart(catalog, "QD-90001");
  const shaft = findPart(catalog, "QD-90002");
  const al = resolveMaterial(catalog, "6061");
  assert.ok(plate && shaft && al);
  assert.equal(stockSizeText(plate.stock), "0.500 x 4.000 x 6.00");
  assert.equal(stockSizeText(shaft.stock), "1.000 dia x 6.00");
  assert.equal(stockVolumeIn3(plate.stock), 12);
  assert.ok(Math.abs(stockVolumeIn3(shaft.stock) - Math.PI * 1.5) < 1e-12);
  assert.ok(Math.abs(blankWeightLb(plate, al) - 1.17) < 1e-12);
  assert.throws(() => stockVolumeIn3({ shape: "plate", sizeIn: [1, 2] }), /stock size 3 is missing/);
});

test("the draft JSON Schema is draft-07, closed, fully required and free of bounds", () => {
  assert.match(String(QUOTE_DRAFT_JSON_SCHEMA["$schema"]), /draft-07/);
  let objects = 0;
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node === null || typeof node !== "object") return;
    const o = node as Record<string, unknown>;
    for (const key of SCHEMA_BOUND_KEYS) assert.ok(!(key in o), `bound keyword ${key} is still in the schema`);
    if (o["type"] === "object" || "properties" in o) {
      objects++;
      assert.equal(o["additionalProperties"], false);
      assert.deepEqual([...(o["required"] as string[])].sort(), Object.keys(o["properties"] as object).sort());
    }
    Object.values(o).forEach(walk);
  };
  walk(QUOTE_DRAFT_JSON_SCHEMA);
  assert.equal(objects, 3); // the draft, a line, an open question
  // The stripped bounds are still enforced by the zod parse after the run.
  const draft: QuoteDraft = { rfqId: "MINI-001", customer: "Test Customer A", status: "ready", assumptions: [],
    openQuestions: [], lines: [{ lineRef: "1", partNumber: "QD-90001", materialAsRequested: "6061-T6",
      materialCode: "AL-6061-T6", quantity: 40, toleranceIn: 0.002, materialCostPerPartUsd: 4.91,
      machiningCostPerPartUsd: 17.66, stock: "in_stock", leadTimeDays: 10 }] };
  assert.ok(QuoteDraftSchema.safeParse(draft).success);
  const line = draft.lines[0];
  assert.ok(line);
  assert.ok(!QuoteDraftSchema.safeParse({ ...draft, lines: [{ ...line, quantity: 2.5 }] }).success);
  assert.ok(!QuoteDraftSchema.safeParse({ ...draft, lines: [{ ...line, quantity: 0 }] }).success);
  assert.ok(!QuoteDraftSchema.safeParse({ ...draft, extra: true }).success);
  assert.ok(!QuoteDraftSchema.safeParse({ ...draft, lines: [{ ...line, leadTimeDays: undefined }] }).success);
  assert.ok(QuoteDraftSchema.safeParse({ ...draft, lines: [{ ...line, quantity: null, toleranceIn: null }] }).success);
});

test("stock fault specs parse, reject and round-trip", () => {
  const forms: [string, StockFault][] = [["ok", { kind: "ok" }], ["down", { kind: "down" }],
    ["fail-first:2", { kind: "fail_first", n: 2 }], ["flaky:0.7", { kind: "flaky", rate: 0.7 }]];
  for (const [spec, fault] of forms) {
    assert.deepEqual(parseStockFault(spec), fault);
    assert.equal(formatStockFault(fault), spec);
  }
  for (const bad of ["hang", "fail-first:0", "fail-first:x", "flaky:1.5", "flaky:0", "flaky:1", "flaky:", "OK", ""]) {
    assert.throws(() => parseStockFault(bad), new Error(`invalid stock fault: ${bad}`));
  }
  assert.equal(stockLineKey("AL-6061-T6", " qd-90001 ", 40), "AL-6061-T6|QD-90001|40");
  assert.equal(fullToolName("check_stock"), "mcp__catalog__check_stock");
  assert.equal(CATALOG_TOOLS.length, 4);
});

test("rng goldens", () => {
  assert.equal(fnv1a32(""), 2166136261);
  assert.equal(fnv1a32("a"), 3826002220);
  assert.equal(fnv1a32("foobar"), 3214735720);
  assert.equal(fmix32(0), 0);
  assert.equal(fmix32(1), 1364076727);
  assert.equal(fmix32(fnv1a32("a")), 444641715);
  const draw = mulberry32(42);
  assert.deepEqual([draw(), draw(), draw()], [0.6011037519201636, 0.44829055899754167, 0.8524657934904099]);
  assert.equal(faultDraw("a"), 444641715 / 2 ** 32);
});

test("fault schedule goldens", () => {
  const key = "AL-6061-T6|QD-90001|40";
  const failing = (seed: number): number[] =>
    [1, 2, 3, 4, 5, 6].filter((n) => stockAttemptFails({ kind: "flaky", rate: 0.5 }, seed, key, n));
  assert.deepEqual(failing(1), [2]);
  assert.deepEqual(failing(2), [2, 3, 5, 6]);

  // MINI-006 under flaky:0.7 with fault seed 7: line 1 verifies on attempt 3, line 2 never does.
  const draws = (k: string): string[] => [1, 2, 3].map((n) => faultDraw(`7|${k}|${n}`).toFixed(4));
  const line1 = stockLineKey("AL-6061-T6", "QD-90001", 20);
  const line2 = stockLineKey("PL-POM", "QD-90003", 50);
  assert.deepEqual(draws(line1), ["0.1192", "0.3689", "0.8760"]);
  assert.deepEqual(draws(line2), ["0.2205", "0.1527", "0.1851"]);
  const flaky = parseStockFault("flaky:0.7");
  assert.deepEqual(expectedStock(flaky, 7, line1), { verified: true, attempts: 3 });
  assert.deepEqual(expectedStock(flaky, 7, line2), { verified: false, attempts: STOCK_ATTEMPTS });

  assert.deepEqual(expectedStock(parseStockFault("ok"), 1, key), { verified: true, attempts: 1 });
  assert.deepEqual(expectedStock(parseStockFault("down"), 1, key), { verified: false, attempts: 3 });
  assert.deepEqual(expectedStock(parseStockFault("fail-first:1"), 1, key), { verified: true, attempts: 2 });
  assert.deepEqual(expectedStock(parseStockFault("fail-first:2"), 1, key), { verified: true, attempts: 3 });
  assert.deepEqual(expectedStock(parseStockFault("fail-first:3"), 1, key), { verified: false, attempts: 3 });
});

test("readRecording reads the example, keeps key order and skips what it doesn't know", () => {
  const file = mini("example.jsonl");
  const rec = readRecording(file);
  assert.equal(rec.header.rfqId, "MINI-001");
  assert.deepEqual([...new Set(rec.events.map((e) => e.type))].sort(), [...DESK_EVENT_TYPES].sort());
  assert.deepEqual(rec.events.map((e) => e.seq), rec.events.map((_, i) => i));
  assert.equal(rec.header.catalogHash, fileHash(mini("catalog.json")));

  // The events come back as parsed, not as zod rebuilt them: same keys in the same order.
  const rows = readFileSync(file, "utf8").split("\n").filter((r) => r !== "");
  const eventRows = rows.filter((r) => r.startsWith('{"kind":"event"'));
  assert.deepEqual(rec.events.map((e) => JSON.stringify({ kind: "event", event: e })), eventRows);

  const dir = mkdtempSync(join(tmpdir(), "qd-"));
  try {
    const first = rows[0];
    assert.ok(first);
    const injected = join(dir, "injected.jsonl");
    writeFileSync(injected, [first, '{"kind":"event","event":{"type":"text_delta","text":"x"}}', '{"kind":"note","text":"x"}',
      ...rows.slice(1)].join("\r\n") + "\r\n");
    assert.deepEqual(readRecording(injected), rec);

    const copy = join(dir, "nested", "copy.jsonl");
    writeRecording(copy, rec);
    assert.equal(readFileSync(copy, "utf8"), readFileSync(file, "utf8"));

    const broken = join(dir, "broken.jsonl");
    writeFileSync(broken, [first, '{"kind":"event","event":{"type":"assistant_text","v":1}}'].join("\n"));
    assert.throws(() => readRecording(broken), /^Error: broken\.jsonl:2: assistant_text: /);
    writeFileSync(broken, rows.slice(1).join("\n"));
    assert.throws(() => readRecording(broken), /^Error: broken\.jsonl:1: the first line must be the header$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("serializeQuote gives the outbox bytes, and events are strict", () => {
  const rec = readRecording(mini("example.jsonl"));
  const quoteEvent = rec.events.find((e) => e.type === "quote");
  assert.ok(quoteEvent && quoteEvent.type === "quote");
  const quote: Quote = quoteEvent.quote;
  const bytes = serializeQuote(quote);
  assert.ok(bytes.endsWith("}\n"));
  assert.equal(sha256Hex(bytes), "e1e47cd3055846e07b80c6f54c2b82dbbc0bd47d765071d6612e6ab005ee5629");
  assert.deepEqual(rec.outbox, [{ name: "MINI-001.json", sha256: sha256Hex(bytes) }]);

  assert.ok(DeskEventSchema.safeParse(quoteEvent).success);
  assert.ok(!DeskEventSchema.safeParse({ ...quoteEvent, extra: 1 }).success);
  assert.ok(!DeskEventSchema.safeParse({ ...quoteEvent, type: "text_delta" }).success);
  const stockDown = rec.events.find((e) => e.type === "tool_result" && e.isError);
  assert.ok(stockDown && stockDown.type === "tool_result" && stockDown.data !== null);
  assert.ok(TOOL_RESULT_SCHEMAS.check_stock.safeParse(stockDown.data).success);
  assert.deepEqual([stockDown.data.ok, stockDown.text], [false, JSON.stringify(stockDown.data)]);

  const header = headerFromEvents(rec.events, { kind: "eval", caseId: "clean-001", trial: 2, gitSha: null,
    recordedAt: "2026-11-09T12:00:05.000Z" });
  assert.deepEqual([header.kind, header.caseId, header.trial, header.rfqId, header.stockFault, header.sdkVersion,
    header.claudeCodeVersion], ["eval", "clean-001", 2, "MINI-001", "down", sdkVersion(), "2.1.321"]);
  assert.throws(() => headerFromEvents(rec.events.slice(1), { kind: "demo", caseId: null, trial: null, gitSha: null,
    recordedAt: "x" }), /needs a run_started event/);
});

test("a cases file may not repeat an assertion kind, defaults included", () => {
  const file = { schema: 1, set: "tuned", rfqsFile: "data/rfqs.json", truthFile: "data/rfq-truth.json",
    defaults: [{ kind: "isolated" }, { kind: "consistent" }, { kind: "no_invented_price" }],
    cases: [{ id: "clean-001", category: "clean", rfqId: "MINI-001", stockFault: "ok", approve: "approve",
      note: "one clean line", assert: [{ kind: "status", equals: "ready" }, { kind: "delivery", equals: "sent" }] }] };
  assert.ok(CasesFileSchema.safeParse(file).success);
  const only = file.cases[0];
  assert.ok(only);
  const withCase = (c: object): unknown => ({ ...file, cases: [{ ...only, ...c }] });
  assert.ok(!CasesFileSchema.safeParse(withCase({ assert: [{ kind: "isolated" }] })).success);
  assert.ok(!CasesFileSchema.safeParse(withCase({ stockFault: "hang" })).success);
  assert.ok(!CasesFileSchema.safeParse(withCase({ faultSeed: 1.5 })).success);
  assert.ok(CasesFileSchema.safeParse(withCase({ faultSeed: 7, stockFault: "flaky:0.7" })).success);
  assert.ok(!CasesFileSchema.safeParse({ ...file, cases: [only, only] }).success);
});

test("readDotEnv returns non-empty values only, and the file wins over the shell", () => {
  const dir = mkdtempSync(join(tmpdir(), "qd-"));
  try {
    const file = join(dir, ".env");
    writeFileSync(file, "QD_PRECEDENCE_TEST=file\nEMPTY_ONE=\n");
    const fromFile = readDotEnv(file);
    assert.deepEqual(fromFile, { QD_PRECEDENCE_TEST: "file" });
    assert.deepEqual(Object.assign({ QD_PRECEDENCE_TEST: "shell" }, fromFile), { QD_PRECEDENCE_TEST: "file" });
    assert.deepEqual(readDotEnv(join(dir, "missing.env")), {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("paths are absolute and the SDK version is the pinned one", () => {
  assert.equal(sdkVersion(), "0.3.321");
  const bundled = bundledClaudeCodeVersion();
  assert.ok(bundled === null || /^\d+\.\d+\.\d+/.test(bundled));
  assert.equal(repoRelative(PATHS.catalog), "data/catalog.json");
  assert.equal(repoRelative(PATHS.miniDir), "test/fixtures/mini");
  assert.equal(repoRelative(PATHS.serverEntry), "src/mcp/stdio.ts");
  assert.equal(repoRelative(PATHS.outbox), "out/outbox");
  assert.equal(repoRelative(PATHS.resultsDir), "eval/results");
});

test("errors for unreadable files name the file only, and a byte order mark doesn't hide a key", () => {
  const dir = mkdtempSync(join(tmpdir(), "qd-"));
  try {
    const missing = join(dir, "nope.jsonl");
    for (const read of [() => readRecording(missing), () => fileHash(missing)]) {
      assert.throws(read, new Error("nope.jsonl: cannot read the file (ENOENT)"));
    }
    const file = join(dir, ".env");
    writeFileSync(file, String.fromCharCode(0xfeff) + "QD_FIRST=one\r\nQD_SECOND=two\r\n");
    assert.deepEqual(readDotEnv(file), { QD_FIRST: "one", QD_SECOND: "two" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("every fault spec that parses survives a format and a second parse", () => {
  for (const spec of ["flaky:0.000001", "flaky:.5", "flaky:0.50", "fail-first:12"]) {
    const fault = parseStockFault(spec);
    assert.deepEqual(parseStockFault(formatStockFault(fault)), fault);
  }
  for (const bad of ["flaky:0.0000001", "fail-first:99999999999999999999"]) {
    assert.throws(() => parseStockFault(bad), new Error(`invalid stock fault: ${bad}`));
  }
});

test("the Ok shape of every tool parses when built from the pricing functions, and is strict", () => {
  const part = findPart(catalog, "QD-90001");
  const al = resolveMaterial(catalog, "6061");
  assert.ok(part && al);
  const ops = operationEstimates(catalog, part, al, 40, 0.002);
  const results: [(typeof CATALOG_TOOLS)[number], Record<string, unknown>][] = [
    ["lookup_part", { ok: true, partNumber: part.partNumber, description: part.description, family: part.family,
      stockShape: part.stock.shape, stockSize: stockSizeText(part.stock), standardToleranceIn: part.standardToleranceIn,
      operationCount: part.routing.length }],
    ["price_material", { ok: true, partNumber: part.partNumber, materialCode: al.code, materialName: al.name,
      stocked: al.stocked, stockSize: stockSizeText(part.stock), blankWeightLb: round2(blankWeightLb(part, al)),
      usdPerLb: al.usdPerLb, costPerPartUsd: materialCostPerPart(part, al) }],
    ["estimate_cycle_time", { ok: true, partNumber: part.partNumber, materialCode: al.code, quantity: 40,
      toleranceIn: 0.002, toleranceTier: toleranceTier(part, 0.002), operations: ops,
      minutesPerPart: round2(ops.reduce((sum, o) => sum + o.runMinPerPart, 0)),
      machiningCostPerPartUsd: machiningCostPerPart(catalog, part, al, 40, 0.002) }],
    ["check_stock", { ok: true, materialCode: al.code, partNumber: part.partNumber, quantity: 40,
      ...stockCheck(catalog, al, part, 40), attempts: 1 }],
  ];
  for (const [tool, result] of results) {
    assert.ok(TOOL_RESULT_SCHEMAS[tool].safeParse(result).success, tool);
    assert.ok(!TOOL_RESULT_SCHEMAS[tool].safeParse({ ...result, extra: 1 }).success, `${tool} is strict`);
  }
});

test("the engines floor covers import.meta.main, which the server entry needs", () => {
  const pkg = JSON.parse(readFileSync(join(PATHS.root, "package.json"), "utf8")) as { engines: { node: string } };
  const floor = /^>=(\d+)\.(\d+)\.(\d+)$/.exec(pkg.engines.node);
  assert.ok(floor !== null, `engines.node is ${pkg.engines.node}, expected the form >=major.minor.patch`);
  const major = Number(floor[1]);
  const minor = Number(floor[2]);
  // import.meta.main arrived in Node 24.2.0. On an older 24 the stdio server would start and serve nothing.
  assert.ok(major > 24 || (major === 24 && minor >= 2), `engines.node ${pkg.engines.node} allows a Node without it`);
});

test("an RFQ id is a plain name, so it can't steer the outbox file path", () => {
  const rfq = { id: "RFQ-001", customer: "c", contactEmail: "a@b.example", receivedOn: "2026-01-05", subject: "s",
    body: "b" };
  for (const id of ["RFQ-001", "HO-010", "MINI-006", "pasted_2026.11.09-a"]) {
    assert.ok(RFQ_ID_PATTERN.test(id), id);
    assert.ok(RfqSchema.safeParse({ ...rfq, id }).success, id);
  }
  for (const id of ["", "../escaped", "a/b", "a\\b", "..", ".hidden", "C:x", "x".repeat(65), "RFQ 001"]) {
    assert.ok(!RFQ_ID_PATTERN.test(id), JSON.stringify(id));
    assert.ok(!RfqSchema.safeParse({ ...rfq, id }).success, JSON.stringify(id));
  }
});
