// The tool allowlist and the one-check_stock-per-line cap (spec 5.11).
// Hook denials don't show in the SDK's permission-denied stream (A8), so every denial reports itself
// through onDeny.
import type { CanUseTool, HookCallback, HookInput, HookJSONOutput, Options, PermissionResult }
  from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { CATALOG_TOOLS, CheckStockInputShape, STOCK_CALLS_PER_LINE_CAP, STRUCTURED_OUTPUT_TOOL, fullToolName,
  stockLineKey } from "../contracts.ts";
import type { Catalog, DeskEventBody } from "../contracts.ts";
import { normalizeMaterialText, resolveMaterial } from "../pricing.ts";
import { displayToolName } from "./events.ts";

export type GuardDenied = Extract<DeskEventBody, { type: "guard_denied" }>;

/** What the model reads when a second check_stock for the same line is denied (spec 5.7). */
export const RETRY_CAP_REASON =
  "check_stock already ran for this line. If it failed, mark the line unverified and continue.";

export function allowlistReason(toolName: string): string {
  return `Not available at the quote desk: ${toolName}`;
}

export type Guards = {
  canUseTool: CanUseTool;
  hooks: NonNullable<Options["hooks"]>;
  /** The first effort.level a PreToolUse hook input carried, else null. */
  effortApplied: () => string | null;
};

const CheckStockInput = z.object(CheckStockInputShape);

export function createGuards(catalog: Catalog, onDeny: (e: GuardDenied) => void): Guards {
  const allowed = new Set<string>([...CATALOG_TOOLS.map(fullToolName), STRUCTURED_OUTPUT_TOOL]);
  const stockCalls = new Map<string, number>();
  let effort: string | null = null;

  // Declared to return a PermissionResult, so tsc refuses a stray null (which would block the tool forever).
  const canUseTool = async (toolName: string, input: Record<string, unknown>, options: { toolUseID: string }):
    Promise<PermissionResult> => {
    if (allowed.has(toolName)) return { behavior: "allow", updatedInput: input };
    const reason = allowlistReason(toolName);
    onDeny({ type: "guard_denied", tool: displayToolName(toolName), toolUseId: options.toolUseID, by: "allowlist",
      reason });
    return { behavior: "deny", message: reason };
  };

  // Registered with no matcher, because the installed types don't document matcher syntax (A7), so it
  // filters by itself.
  const preToolUse: HookCallback = async (input: HookInput): Promise<HookJSONOutput> => {
    if (input.hook_event_name !== "PreToolUse") return {};
    if (effort === null && input.effort?.level !== undefined) effort = input.effort.level;
    if (input.tool_name !== fullToolName("check_stock")) return {};
    const parsed = CheckStockInput.safeParse(input.tool_input);
    if (!parsed.success) return {}; // the server answers INVALID_INPUT
    const { material, partNumber, quantity } = parsed.data;
    const code = resolveMaterial(catalog, material)?.code ?? normalizeMaterialText(material);
    const key = stockLineKey(code, partNumber, quantity);
    const count = (stockCalls.get(key) ?? 0) + 1;
    stockCalls.set(key, count);
    if (count <= STOCK_CALLS_PER_LINE_CAP) return {};
    onDeny({ type: "guard_denied", tool: displayToolName(input.tool_name), toolUseId: input.tool_use_id,
      by: "retry_cap", reason: RETRY_CAP_REASON });
    return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny",
      permissionDecisionReason: RETRY_CAP_REASON } };
  };

  return {
    canUseTool,
    hooks: { PreToolUse: [{ hooks: [preToolUse] }] },
    effortApplied: () => effort,
  };
}
