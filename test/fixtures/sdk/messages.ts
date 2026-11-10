// SDK message fixtures in the shapes the live probe saw on 2026-11-09 (PROBE-FINDINGS.md) and sdk.d.ts
// declares. Each carries every field src/agent/events.ts and src/agent/run.ts read. Ids, paths and
// numbers are invented; paths are relative placeholders, never a real machine path.
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { CATALOG_SERVER, CATALOG_TOOLS, DEFAULT_MODEL, EXPECTED_INIT_PLUGINS, EXPECTED_INIT_SKILLS,
  STRUCTURED_OUTPUT_TOOL, fullToolName } from "../../../src/contracts.ts";

export const SESSION_ID = "5e551000-0000-4000-8000-000000000001";
let uuidCounter = 0;
function uuid(): string {
  uuidCounter += 1;
  return `0000f1c7-0000-4000-8000-${String(uuidCounter).padStart(12, "0")}`;
}
function sdk(m: Record<string, unknown>): SDKMessage {
  return m as unknown as SDKMessage;
}

// ---- tool_result content strings the probe recorded (U11)

/** What the model reads after the StructuredOutput call. */
export const STRUCTURED_OUTPUT_ACK = "Structured output provided successfully";
/** A PreToolUse hook denial, as the CLI words it. */
export function hookDenialText(reason: string): string {
  return `PreToolUse:${fullToolName("check_stock")} hook error: ${reason}`;
}
/** The MCP SDK's own input validation error (A23). */
export const MCP_VALIDATION_TEXT =
  "MCP error -32602: Input validation error: Invalid arguments for tool check_stock: expected number to be >=1 at quantity";
/** The server timeout notice the probe saw with a 3 s timeout. */
export const SERVER_TIMEOUT_TEXT = `MCP server "${CATALOG_SERVER}" tool "check_stock" timed out after 3s`;

// ---- system messages

export type InitFixture = { model?: string; catalogStatus?: string; permissionMode?: string };

export function init(o: InitFixture = {}): SDKMessage {
  return sdk({
    type: "system", subtype: "init",
    apiKeySource: "ANTHROPIC_API_KEY",
    claude_code_version: "2.1.321",
    cwd: "workdir",
    tools: [STRUCTURED_OUTPUT_TOOL, ...CATALOG_TOOLS.map(fullToolName)],
    // The probe saw a third key, source, on each server entry.
    mcp_servers: [{ name: CATALOG_SERVER, status: o.catalogStatus ?? "connected", source: "dynamic" }],
    model: o.model ?? DEFAULT_MODEL,
    permissionMode: o.permissionMode ?? "default",
    slash_commands: [],
    output_style: "default",
    skills: [...EXPECTED_INIT_SKILLS],
    plugins: EXPECTED_INIT_PLUGINS.map((name) => ({ name, path: `plugins/${name}` })),
    uuid: uuid(), session_id: SESSION_ID,
  });
}

/** Seen between turns in the probe; the mapper skips it. */
export function thinkingTokens(): SDKMessage {
  return sdk({ type: "system", subtype: "thinking_tokens", estimated_tokens: 120, estimated_tokens_delta: 40,
    uuid: uuid(), session_id: SESSION_ID });
}

export function refusalFallback(o: { scope?: "session" | "local"; category?: string } = {}): SDKMessage {
  const m: Record<string, unknown> = {
    type: "system", subtype: "model_refusal_fallback", trigger: "refusal", direction: "retry",
    original_model: DEFAULT_MODEL, fallback_model: "claude-sonnet-5-5", request_id: "req_fixture_01",
    retracted_message_uuids: [], content: "The model declined; retrying on the fallback model.",
    uuid: uuid(), session_id: SESSION_ID,
  };
  if (o.scope !== undefined) m["scope"] = o.scope;
  if (o.category !== undefined) m["api_refusal_category"] = o.category;
  return sdk(m);
}

export function refusalNoFallback(o: { category?: string } = {}): SDKMessage {
  const m: Record<string, unknown> = {
    type: "system", subtype: "model_refusal_no_fallback", original_model: DEFAULT_MODEL,
    request_id: "req_fixture_02", content: "The model declined.", uuid: uuid(), session_id: SESSION_ID,
  };
  if (o.category !== undefined) m["api_refusal_category"] = o.category;
  return sdk(m);
}

// ---- assistant and user messages

function assistant(content: Record<string, unknown>[], error?: string): SDKMessage {
  const m: Record<string, unknown> = {
    type: "assistant",
    message: { id: "msg_fixture", type: "message", role: "assistant", model: DEFAULT_MODEL, content,
      stop_reason: null, stop_sequence: null },
    parent_tool_use_id: null, uuid: uuid(), session_id: SESSION_ID,
  };
  if (error !== undefined) m["error"] = error;
  return sdk(m);
}

export function assistantText(text: string): SDKMessage {
  return assistant([{ type: "text", text }]);
}

export function assistantThinking(thinking: string): SDKMessage {
  return assistant([{ type: "thinking", thinking, signature: "sig_fixture" }]);
}

export function assistantToolUse(id: string, name: string, input: unknown): SDKMessage {
  return assistant([{ type: "tool_use", id, name, input }]);
}

/** An assistant message carrying only an error code, as an API failure turn does (A22). */
export function assistantError(code: string): SDKMessage {
  return assistant([{ type: "text", text: "API Error" }], code);
}

export type TextBlock = { type: "text"; text: string };

/**
 * A user message with one tool_result block. The probe saw string content every time; block content is
 * the other form the types allow. tool_use_result carries the "Error: " prefix on errors, and the mapper
 * never reads it.
 */
export function userToolResult(toolUseId: string, content: string | TextBlock[], isError = false): SDKMessage {
  const block: Record<string, unknown> = { type: "tool_result", tool_use_id: toolUseId, content };
  if (isError) block["is_error"] = true;
  const text = typeof content === "string" ? content : content.map((b) => b.text).join("\n");
  return sdk({
    type: "user",
    message: { role: "user", content: [block] },
    parent_tool_use_id: null,
    tool_use_result: isError ? `Error: ${text}` : text,
    uuid: uuid(), session_id: SESSION_ID,
  });
}

// ---- results

/** modelUsage as the probe saw it: the requested model plus a small Haiku side call. */
export function modelUsage(): Record<string, Record<string, number>> {
  return {
    [DEFAULT_MODEL]: { inputTokens: 6, outputTokens: 528, cacheReadInputTokens: 4533, cacheCreationInputTokens: 2582,
      webSearchRequests: 0, costUSD: 0.0237, contextWindow: 200000, maxOutputTokens: 64000 },
    "claude-haiku-5-5": { inputTokens: 1400, outputTokens: 30, cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
      webSearchRequests: 0, costUSD: 0.0007, contextWindow: 200000, maxOutputTokens: 8192 },
  };
}
export const TOTAL_COST_USD = 0.0244;
export const NUM_TURNS = 4;

function usage(): Record<string, number> {
  return { input_tokens: 1406, output_tokens: 558, cache_read_input_tokens: 4533, cache_creation_input_tokens: 2582 };
}

export type SuccessFixture = { structuredOutput?: unknown; isError?: boolean; apiErrorStatus?: number; result?: string };

export function resultSuccess(o: SuccessFixture = {}): SDKMessage {
  const m: Record<string, unknown> = {
    type: "result", subtype: "success", duration_ms: 9100, duration_api_ms: 8200,
    is_error: o.isError ?? false, num_turns: NUM_TURNS, result: o.result ?? "Quote ready for review.",
    stop_reason: "end_turn", total_cost_usd: TOTAL_COST_USD, usage: usage(), modelUsage: modelUsage(),
    permission_denials: [], uuid: uuid(), session_id: SESSION_ID,
  };
  if (o.apiErrorStatus !== undefined) m["api_error_status"] = o.apiErrorStatus;
  if (o.structuredOutput !== undefined) m["structured_output"] = o.structuredOutput;
  return sdk(m);
}

export type ErrorSubtype = "error_during_execution" | "error_max_turns" | "error_max_budget_usd"
  | "error_max_structured_output_retries";

export function resultError(subtype: ErrorSubtype, errors: string[]): SDKMessage {
  return sdk({
    type: "result", subtype, duration_ms: 30100, duration_api_ms: 28000, is_error: true, num_turns: 20,
    stop_reason: null, total_cost_usd: TOTAL_COST_USD, usage: usage(), modelUsage: modelUsage(),
    permission_denials: [], errors, uuid: uuid(), session_id: SESSION_ID,
  });
}

/** A message type this version of the mapper doesn't know. */
export function unknownType(): SDKMessage {
  return sdk({ type: "future_kind", detail: "x", uuid: uuid(), session_id: SESSION_ID });
}
