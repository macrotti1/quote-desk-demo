// Composition root. This is the only file that imports the real query from the Agent SDK.
// Every other module takes it as a dependency, so no test can start a model by accident.
import { query } from "@anthropic-ai/claude-agent-sdk";
import { createRunQuote } from "./agent/run.ts";
import type { RunQuote } from "./contracts.ts";
import { loadCatalog } from "./load.ts";
import { finalizeQuote } from "./quote/finalize.ts";
import { approveAndSend } from "./quote/gate.ts";

export const runQuote: RunQuote = createRunQuote({ query, finalizeQuote, approveAndSend, loadCatalog, env: process.env });

export * from "./contracts.ts";
