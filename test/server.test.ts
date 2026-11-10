// The catalog MCP server over an in-memory pair and one real stdio spawn. No model, no network.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CATALOG_TOOLS, DEFAULT_FAULT_SEED, STOCK_DELAY_MS, TOOL_RESULT_SCHEMAS, ToolErrorSchema, parseStockFault } from "../src/contracts.ts";
import type { CatalogToolName, ToolError } from "../src/contracts.ts";
import { loadCatalog } from "../src/load.ts";
import { PATHS } from "../src/paths.ts";
import { SERVER_INFO, createCatalogServer } from "../src/mcp/server.ts";
import { STANDALONE_STOCK_FAULT, parseServerFlags } from "../src/mcp/stdio.ts";

const miniCatalogPath = join(PATHS.miniDir, "catalog.json");
const catalog = loadCatalog(miniCatalogPath);
const instant = (): Promise<void> => Promise.resolve();

/** A server and a connected client over an in-memory pair. close() shuts both. */
async function connectInMemory(fault = "ok") {
  const server = createCatalogServer({ catalog, fault: parseStockFault(fault), faultSeed: DEFAULT_FAULT_SEED,
    stockDelayMs: 0, sleep: instant });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "server-test", version: "0.0.0" });
  await client.connect(clientTransport);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

type CallResult = Awaited<ReturnType<Client["callTool"]>>;

function textOf(r: CallResult): string {
  const content = r.content as { type: string; text?: string }[];
  assert.equal(content.length, 1);
  const first = content[0];
  assert.ok(first !== undefined && first.type === "text" && typeof first.text === "string");
  return first.text;
}

function assertToolError(r: CallResult, code: ToolError["code"]): ToolError {
  assert.equal(r.isError, true);
  assert.equal(r.structuredContent, undefined);
  const e = ToolErrorSchema.parse(JSON.parse(textOf(r)));
  assert.equal(e.code, code);
  return e;
}

const OK_CALLS: Record<CatalogToolName, Record<string, unknown>> = {
  lookup_part: { partNumber: "QD-90001" },
  price_material: { partNumber: "QD-90001", material: "6061-T6" },
  estimate_cycle_time: { partNumber: "QD-90001", material: "6061-T6", quantity: 40, toleranceIn: 0.002 },
  check_stock: { material: "6061-T6", partNumber: "QD-90001", quantity: 40 },
};

test("in memory: listTools shows exactly the 4 catalog tools, described, read-only, with strict output schemas", async () => {
  const { client, close } = await connectInMemory();
  try {
    assert.deepEqual(client.getServerVersion(), { ...SERVER_INFO });
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), [...CATALOG_TOOLS].sort());
    for (const t of tools) {
      assert.ok(typeof t.description === "string" && t.description.length > 0, `${t.name} has a description`);
      assert.match(t.description, /USD per part/, `${t.name} says costs are USD per part`);
      assert.match(t.description, /whole numbers? of at least 1/, `${t.name} says quantity is a whole number`);
      assert.match(t.description, /positive inches/, `${t.name} says tolerances are positive inches`);
      assert.equal(t.inputSchema.type, "object");
      assert.ok(t.inputSchema.properties !== undefined && Object.keys(t.inputSchema.properties).length > 0);
      assert.equal(t.annotations?.readOnlyHint, true);
      assert.ok(t.outputSchema !== undefined, `${t.name} has an output schema`);
      assert.equal(t.outputSchema.additionalProperties, false, `${t.name} output rejects extra keys`);
    }
    const estimate = tools.find((t) => t.name === "estimate_cycle_time");
    const ops = (estimate?.outputSchema?.properties as Record<string, { items?: { additionalProperties?: unknown } }>)
      ["operations"];
    assert.equal(ops?.items?.additionalProperties, false, "each operation rejects extra keys");
  } finally {
    await close();
  }
});

test("in memory: every tool's Ok path passes the client's output check, and content text is the structuredContent JSON", async () => {
  const { client, close } = await connectInMemory();
  try {
    await client.listTools(); // the client caches the output validators from this list
    for (const name of CATALOG_TOOLS) {
      const r = await client.callTool({ name, arguments: OK_CALLS[name] });
      assert.notEqual(r.isError, true, `${name}: ${JSON.stringify(r.content)}`);
      assert.ok(r.structuredContent !== undefined, `${name} returns structuredContent`);
      assert.equal(textOf(r), JSON.stringify(r.structuredContent));
      const parsed = TOOL_RESULT_SCHEMAS[name].parse(r.structuredContent);
      assert.equal(parsed.ok, true);
    }
  } finally {
    await close();
  }
});

test("in memory: errors set isError, carry no structuredContent and parse as ToolError", async () => {
  const { client, close } = await connectInMemory("down");
  try {
    await client.listTools();
    assertToolError(await client.callTool({ name: "lookup_part", arguments: { partNumber: "QD-00000" } }), "NOT_FOUND");
    const unknown = assertToolError(await client.callTool({ name: "price_material",
      arguments: { partNumber: "QD-90002", material: "Ti-6Al-4V titanium" } }), "UNKNOWN_MATERIAL");
    assert.ok(unknown.suggestions.length > 0);
    const down = assertToolError(await client.callTool({ name: "check_stock", arguments: OK_CALLS.check_stock }),
      "STOCK_UNAVAILABLE");
    assert.equal(down.attempts, 3);
  } finally {
    await close();
  }
});

test("in memory: quantity 0, quantity 2.5, toleranceIn -1 and material \"\" come back as INVALID_INPUT", async () => {
  const { client, close } = await connectInMemory();
  try {
    await client.listTools();
    const base = { partNumber: "QD-90001", material: "AL-6061-T6" };
    const calls: { name: CatalogToolName; arguments: Record<string, unknown>; field: string }[] = [
      { name: "estimate_cycle_time", arguments: { ...base, quantity: 0 }, field: "quantity" },
      { name: "estimate_cycle_time", arguments: { ...base, quantity: 2.5 }, field: "quantity" },
      { name: "check_stock", arguments: { ...base, quantity: 0 }, field: "quantity" },
      { name: "check_stock", arguments: { ...base, quantity: 2.5 }, field: "quantity" },
      { name: "estimate_cycle_time", arguments: { ...base, quantity: 10, toleranceIn: -1 }, field: "toleranceIn" },
      { name: "price_material", arguments: { ...base, material: "" }, field: "material" },
      { name: "check_stock", arguments: { ...base, material: "", quantity: 10 }, field: "material" },
    ];
    for (const c of calls) {
      const e = assertToolError(await client.callTool({ name: c.name, arguments: c.arguments }), "INVALID_INPUT");
      assert.ok(e.message.includes(c.field), `${c.name}: "${e.message}" names ${c.field}`);
      assert.deepEqual(e.suggestions, []);
      assert.equal(e.attempts, null);
    }
  } finally {
    await close();
  }
});

test("in memory: toleranceIn 0 comes back as INVALID_INPUT", async () => {
  const { client, close } = await connectInMemory();
  try {
    await client.listTools();
    const e = assertToolError(await client.callTool({ name: "estimate_cycle_time",
      arguments: { partNumber: "QD-90001", material: "AL-6061-T6", quantity: 10, toleranceIn: 0 } }), "INVALID_INPUT");
    assert.ok(e.message.includes("toleranceIn"), `"${e.message}" names toleranceIn`);
    assert.deepEqual(e.suggestions, []);
    assert.equal(e.attempts, null);
  } finally {
    await close();
  }
});

test("in memory: the server passes faultSeed, stockDelayMs and sleep through to the stock backend", async () => {
  // Under flaky:0.7, seed 7 verifies MINI-006 line 1 on attempt 3 and fails line 2; the default seed 1 gives
  // attempt 2 and attempt 3, so a dropped seed changes both. The 7 ms delay tells the delay apart from the backoff.
  const waits: number[] = [];
  const server = createCatalogServer({ catalog, fault: parseStockFault("flaky:0.7"), faultSeed: 7, stockDelayMs: 7,
    sleep: (ms: number) => { waits.push(ms); return Promise.resolve(); } });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "server-test", version: "0.0.0" });
  await client.connect(clientTransport);
  try {
    await client.listTools();
    const line1 = await client.callTool({ name: "check_stock",
      arguments: { material: "6061 aluminum", partNumber: "QD-90001", quantity: 20 } });
    assert.notEqual(line1.isError, true, JSON.stringify(line1.content));
    assert.equal((line1.structuredContent as { attempts?: unknown }).attempts, 3);
    assert.deepEqual(waits, [7, 200, 7, 400, 7]);
    const line2 = assertToolError(await client.callTool({ name: "check_stock",
      arguments: { material: "POM", partNumber: "QD-90003", quantity: 50 } }), "STOCK_UNAVAILABLE");
    assert.equal(line2.attempts, 3);
    assert.deepEqual(waits, [7, 200, 7, 400, 7, 7, 200, 7, 400, 7]);
  } finally {
    await client.close();
    await server.close();
  }
});

test("in memory: one server keeps its stock counters across calls", async () => {
  const server = createCatalogServer({ catalog, fault: parseStockFault("fail-first:3"), faultSeed: DEFAULT_FAULT_SEED,
    stockDelayMs: 0, sleep: instant });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "server-test", version: "0.0.0" });
  await client.connect(clientTransport);
  try {
    await client.listTools();
    assertToolError(await client.callTool({ name: "check_stock", arguments: OK_CALLS.check_stock }), "STOCK_UNAVAILABLE");
    const second = await client.callTool({ name: "check_stock", arguments: OK_CALLS.check_stock });
    assert.notEqual(second.isError, true);
    assert.equal((second.structuredContent as { attempts?: unknown }).attempts, 1);
  } finally {
    await client.close();
    await server.close();
  }
});

test("stdio: a real spawn lists 4 tools, check_stock is STOCK_UNAVAILABLE under down, and it closes cleanly", { timeout: 30_000 }, async (t) => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [PATHS.serverEntry, "--catalog", miniCatalogPath, "--stock-fault", "down", "--stock-delay-ms", "10"],
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  const client = new Client({ name: "server-test", version: "0.0.0" });
  const started = performance.now();
  await client.connect(transport);
  const connectMs = Math.round(performance.now() - started);
  t.diagnostic(`stdio connect took ${connectMs} ms`);
  let closeMs = Number.POSITIVE_INFINITY;
  try {
    assert.ok(transport.pid !== null, "the child is running");
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), [...CATALOG_TOOLS].sort());
    const down = assertToolError(await client.callTool({ name: "check_stock", arguments: OK_CALLS.check_stock }),
      "STOCK_UNAVAILABLE");
    assert.equal(down.attempts, 3);
  } finally {
    const closing = performance.now();
    await client.close();
    closeMs = Math.round(performance.now() - closing);
  }
  t.diagnostic(`stdio close took ${closeMs} ms`);
  assert.equal(transport.pid, null, "the child has exited");
  assert.ok(closeMs < 10_000, `closed within 10 s (${closeMs} ms)`);
  // The transport sends SIGTERM only after waiting 2 s, so a close under 2 s means the child left on stdin end.
  assert.ok(closeMs < 2_000, `the child exited on stdin end (${closeMs} ms)`);
  assert.match(stderr, /^quote-desk-catalog 0\.1\.0 on stdio: catalog catalog\.json \(4 parts\), stock fault down, fault seed 1, stock delay 10 ms\n$/);
  assert.ok(!stderr.includes(PATHS.root), "the start line names no absolute path");
});

test("stdio: --stock-delay-ms 3000 exits 2 without starting the server", { timeout: 30_000 }, () => {
  const r = spawnSync(process.execPath, [PATHS.serverEntry, "--catalog", miniCatalogPath, "--stock-delay-ms", "3000"],
    { encoding: "utf8", input: "", timeout: 20_000, env: getDefaultEnvironment(), windowsHide: true });
  assert.equal(r.error, undefined);
  assert.equal(r.status, 2);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /--stock-delay-ms must be a whole number from 0 to 2500 \(got 3000\)/);
});

test("stdio flags: defaults, limits and refusals", () => {
  const defaults = parseServerFlags([]);
  assert.ok(defaults.ok);
  assert.deepEqual(defaults.flags, { catalogPath: PATHS.catalog, stockFault: STANDALONE_STOCK_FAULT,
    fault: parseStockFault("flaky:0.3"), faultSeed: 1, stockDelayMs: STOCK_DELAY_MS.demo });
  const max = parseServerFlags(["--stock-delay-ms", "2500", "--fault-seed", "7", "--stock-fault", "fail-first:2"]);
  assert.ok(max.ok);
  assert.equal(max.flags.stockDelayMs, 2500);
  assert.equal(max.flags.faultSeed, 7);
  assert.deepEqual(max.flags.fault, { kind: "fail_first", n: 2 });
  assert.equal(parseServerFlags(["--stock-delay-ms", "0"]).ok, true);
  // A negative seed is an integer and is accepted when written with "=".
  const negative = parseServerFlags(["--fault-seed=-3"]);
  assert.ok(negative.ok);
  assert.equal(negative.flags.faultSeed, -3);
  for (const bad of [["--stock-delay-ms", "3000"], ["--stock-delay-ms", "1.5"], ["--stock-delay-ms", "-1"],
    ["--stock-fault", "sometimes"], ["--fault-seed", "x"], ["--fault-seed", "1.5"], ["--fault-seed", "-3"], ["--colour"], ["extra"]]) {
    assert.equal(parseServerFlags(bad).ok, false, `${bad.join(" ")} is refused`);
  }
});

test("stdio flags: the joined forms S3 passes, --fault-seed=<n> and --stock-delay-ms=<n>", () => {
  const negative = parseServerFlags(["--fault-seed=-3"]);
  assert.ok(negative.ok);
  assert.equal(negative.flags.faultSeed, -3);
  const zero = parseServerFlags(["--stock-delay-ms=0"]);
  assert.ok(zero.ok);
  assert.equal(zero.flags.stockDelayMs, 0);
  const both = parseServerFlags(["--fault-seed=7", "--stock-delay-ms=2500"]);
  assert.ok(both.ok);
  assert.equal(both.flags.faultSeed, 7);
  assert.equal(both.flags.stockDelayMs, 2500);
  const refusals: { argv: string[]; message: string }[] = [
    { argv: ["--fault-seed=1.5"], message: "--fault-seed must be an integer (got 1.5)" },
    { argv: ["--fault-seed=x"], message: "--fault-seed must be an integer (got x)" },
    { argv: ["--stock-delay-ms=1.5"], message: "--stock-delay-ms must be a whole number from 0 to 2500 (got 1.5)" },
    { argv: ["--stock-delay-ms=-1"], message: "--stock-delay-ms must be a whole number from 0 to 2500 (got -1)" },
  ];
  for (const r of refusals) {
    const parsed = parseServerFlags(r.argv);
    assert.equal(parsed.ok, false, `${r.argv.join(" ")} is refused`);
    if (!parsed.ok) assert.equal(parsed.error, r.message);
  }
});
