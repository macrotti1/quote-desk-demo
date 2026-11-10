// The page's HTTP API shapes, shared by src/web/server.ts and the client in web/src. This file imports types
// only, so the client can import its values without pulling Node code or zod into the bundle.
import type { KeySource, Rfq } from "../contracts.ts";

export type ScenarioName = "clean" | "stock-down" | "unknown-material";
/** The CLI's three scenarios (src/cli/demo.ts), in the order the page shows them. */
export const SCENARIOS: readonly { name: ScenarioName; label: string; rfqId: string; stockFault: string }[] = [
  { name: "clean", label: "Clean", rfqId: "RFQ-001", stockFault: "ok" },
  { name: "stock-down", label: "Stock service down", rfqId: "RFQ-001", stockFault: "down" },
  { name: "unknown-material", label: "Unknown material", rfqId: "RFQ-019", stockFault: "ok" },
];

export type ReplayName = "demo-clean" | "demo-stock-down" | "demo-unknown-material";
/** The only recordings the replay route serves: an allowlist of names, never a path. */
export const REPLAYS: readonly { name: ReplayName; scenario: ScenarioName }[] = [
  { name: "demo-clean", scenario: "clean" },
  { name: "demo-stock-down", scenario: "stock-down" },
  { name: "demo-unknown-material", scenario: "unknown-material" },
];
export const REPLAY_SPEEDS: readonly number[] = [1, 2, 4];

export const LIMITS_WEB = { bodyBytes: 16 * 1024, subjectChars: 200, rfqChars: 8000 } as const;

export type ScenarioInfo = { name: ScenarioName; label: string; stockFault: string; rfq: Rfq };
export type ReplayInfo = { name: ReplayName; scenario: ScenarioName; recordedAt: string; rfqId: string;
  stockFault: string; durationMs: number; events: number };
export type MetaResponse = { live: boolean; keySource: KeySource; model: string; effort: string; notice: string;
  scenarios: ScenarioInfo[]; replays: ReplayInfo[]; limits: { maxRuns: number; rfqMaxChars: number } };
export type StartRunBody = { scenario: ScenarioName }
  | { rfq: { subject: string; body: string }; stockFault?: string };
export type StartRunResponse = { runId: string };
export type ApprovalBody = { decision: "approve" | "decline" };
export type ErrorBody = { error: { code: string; message: string } };
