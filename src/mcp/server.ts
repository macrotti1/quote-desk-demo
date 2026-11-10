// The catalog MCP server: four read-only tools over one catalog and one simulated stock backend.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  CheckStockInputShape, CheckStockOkSchema, EstimateCycleTimeInputShape, EstimateCycleTimeOkSchema,
  LookupPartInputShape, LookupPartOkSchema, PriceMaterialInputShape, PriceMaterialOkSchema,
} from "../contracts.ts";
import type { Catalog, StockFault, ToolResult } from "../contracts.ts";
import { createStockBackend } from "./faults.ts";
import { checkStock, estimateCycleTime, lookupPart, priceMaterial } from "./tools.ts";

export const SERVER_INFO = { name: "quote-desk-catalog", version: "0.1.0" } as const;

export type CatalogServerOptions = { catalog: Catalog; fault: StockFault; faultSeed: number;
  stockDelayMs: number; sleep?: (ms: number) => Promise<void> };

function realSleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The MCP result for a tool result. content[0].text is the JSON of the result. An Ok result also carries
 * the same object as structuredContent; an error sets isError and carries no structuredContent.
 */
export function toCallToolResult(result: ToolResult): CallToolResult {
  const content: CallToolResult["content"] = [{ type: "text", text: JSON.stringify(result) }];
  if (result.ok) return { content, structuredContent: result };
  return { content, isError: true };
}

const readOnly = { readOnlyHint: true } as const;

export function createCatalogServer(o: CatalogServerOptions): McpServer {
  const sleep = o.sleep ?? realSleep;
  const backend = createStockBackend({ fault: o.fault, faultSeed: o.faultSeed, delayMs: o.stockDelayMs, sleep });
  const { catalog } = o;
  const server = new McpServer({ ...SERVER_INFO });

  server.registerTool("lookup_part", {
    description: "Looks up a catalog part by part number and returns its stock blank and standard tolerance in " +
      "positive inches. The other tools take a quantity that is a whole number of at least 1 and give costs in USD per part.",
    inputSchema: LookupPartInputShape, outputSchema: LookupPartOkSchema, annotations: readOnly,
  }, (args) => toCallToolResult(lookupPart(catalog, args)));

  server.registerTool("price_material", {
    description: "Prices the material (a code, name or alias) for one part and returns the material cost in USD " +
      "per part. Quantities in the other tools are whole numbers of at least 1 and tolerances are positive inches.",
    inputSchema: PriceMaterialInputShape, outputSchema: PriceMaterialOkSchema, annotations: readOnly,
  }, (args) => toCallToolResult(priceMaterial(catalog, args)));

  server.registerTool("estimate_cycle_time", {
    description: "Estimates machining minutes and the machining cost in USD per part, for a quantity that is a whole " +
      "number of at least 1. toleranceIn is optional, in positive inches, and defaults to the part's standard tolerance.",
    inputSchema: EstimateCycleTimeInputShape, outputSchema: EstimateCycleTimeOkSchema, annotations: readOnly,
  }, (args) => toCallToolResult(estimateCycleTime(catalog, args)));

  server.registerTool("check_stock", {
    description: "Checks material stock and lead time in days for one line, where quantity is a whole number of at " +
      "least 1 and the simulated inventory service can time out. Costs come from the pricing tools in USD per part, " +
      "and tolerances are positive inches.",
    inputSchema: CheckStockInputShape, outputSchema: CheckStockOkSchema, annotations: readOnly,
  }, async (args) => toCallToolResult(await checkStock(catalog, args, backend, sleep)));

  return server;
}
