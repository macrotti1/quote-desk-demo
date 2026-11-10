// The catalog server over stdio. stdout carries only MCP; one start line goes to stderr.
//   node src/mcp/stdio.ts [--catalog <file>] [--stock-fault <spec>] [--fault-seed <int>] [--stock-delay-ms <0..2500>]
// A bad flag, or a catalog that won't load, exits 2.
import { basename } from "node:path";
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DEFAULT_FAULT_SEED, STOCK_DELAY_MS, parseStockFault } from "../contracts.ts";
import type { Catalog, StockFault } from "../contracts.ts";
import { loadCatalog } from "../load.ts";
import { PATHS } from "../paths.ts";
import { SERVER_INFO, createCatalogServer } from "./server.ts";

// Run standalone, the server is the deliberately flaky tool from the plan.
export const STANDALONE_STOCK_FAULT = "flaky:0.3";

export type ServerFlags = { catalogPath: string; stockFault: string; fault: StockFault; faultSeed: number;
  stockDelayMs: number };

/** Parses and checks every flag. Returns the flags, or an error line for stderr. */
export function parseServerFlags(argv: string[]): { ok: true; flags: ServerFlags } | { ok: false; error: string } {
  let values: { catalog?: string | undefined; "stock-fault"?: string | undefined; "fault-seed"?: string | undefined;
    "stock-delay-ms"?: string | undefined };
  try {
    values = parseArgs({ args: argv, strict: true, allowPositionals: false, options: {
      catalog: { type: "string" }, "stock-fault": { type: "string" }, "fault-seed": { type: "string" },
      "stock-delay-ms": { type: "string" } } }).values;
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  const stockFault = values["stock-fault"] ?? STANDALONE_STOCK_FAULT;
  let fault: StockFault;
  try {
    fault = parseStockFault(stockFault);
  } catch (err) {
    return { ok: false, error: `--stock-fault: ${(err as Error).message}` };
  }
  const seedText = values["fault-seed"];
  const faultSeed = seedText === undefined ? DEFAULT_FAULT_SEED : Number(seedText);
  if (seedText !== undefined && (!/^-?[0-9]+$/.test(seedText) || !Number.isSafeInteger(faultSeed))) {
    return { ok: false, error: `--fault-seed must be an integer (got ${seedText})` };
  }
  const delayText = values["stock-delay-ms"];
  const stockDelayMs = delayText === undefined ? STOCK_DELAY_MS.demo : Number(delayText);
  if (delayText !== undefined && (!/^[0-9]+$/.test(delayText) || stockDelayMs > STOCK_DELAY_MS.max)) {
    return { ok: false, error: `--stock-delay-ms must be a whole number from 0 to ${STOCK_DELAY_MS.max} (got ${delayText})` };
  }
  const catalogPath = values.catalog ?? PATHS.catalog;
  if (catalogPath.trim() === "") return { ok: false, error: "--catalog must name a file" };
  return { ok: true, flags: { catalogPath, stockFault, fault, faultSeed, stockDelayMs } };
}

async function main(argv: string[]): Promise<void> {
  const parsed = parseServerFlags(argv);
  if (!parsed.ok) {
    process.stderr.write(`${SERVER_INFO.name}: ${parsed.error}\n`);
    process.exitCode = 2;
    return;
  }
  const { flags } = parsed;
  let catalog: Catalog;
  try {
    catalog = loadCatalog(flags.catalogPath);
  } catch (err) {
    // loadCatalog names the file by its base name only.
    process.stderr.write(`${SERVER_INFO.name}: ${(err as Error).message}\n`);
    process.exitCode = 2;
    return;
  }
  const server = createCatalogServer({ catalog, fault: flags.fault, faultSeed: flags.faultSeed,
    stockDelayMs: flags.stockDelayMs });
  const transport = new StdioServerTransport();
  // The client closes the server by ending stdin; close the server then so the process exits on its own.
  process.stdin.once("end", () => {
    void server.close();
  });
  await server.connect(transport);
  process.stderr.write(`${SERVER_INFO.name} ${SERVER_INFO.version} on stdio: catalog ${basename(flags.catalogPath)} ` +
    `(${catalog.parts.length} parts), stock fault ${flags.stockFault}, fault seed ${flags.faultSeed}, ` +
    `stock delay ${flags.stockDelayMs} ms\n`);
}

if (import.meta.main) await main(process.argv.slice(2));
