// The page's calls to its own server. Relative URLs only, so nothing goes to another host.
import type { DeskEvent } from "../../src/contracts.ts";
import type { ErrorBody, MetaResponse, ReplayName, StartRunBody, StartRunResponse } from "../../src/web/protocol.ts";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

async function failure(res: Response): Promise<ApiError> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // not JSON; fall through to the status line
  }
  const err = isRecord(body) && isRecord(body["error"]) ? (body as ErrorBody).error : null;
  return new ApiError(res.status, err?.code ?? "http", err?.message ?? `The server answered ${res.status}.`);
}

async function post(path: string, body: unknown): Promise<Response> {
  const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body) });
  if (!res.ok) throw await failure(res);
  return res;
}

export async function getMeta(): Promise<MetaResponse> {
  const res = await fetch("api/meta");
  if (!res.ok) throw await failure(res);
  return (await res.json()) as MetaResponse;
}

export async function startRun(body: StartRunBody): Promise<string> {
  const res = await post("api/runs", body);
  return ((await res.json()) as StartRunResponse).runId;
}

export async function sendApproval(runId: string, decision: "approve" | "decline"): Promise<void> {
  await post(`api/runs/${encodeURIComponent(runId)}/approval`, { decision });
}

export async function cancelRun(runId: string): Promise<void> {
  await post(`api/runs/${encodeURIComponent(runId)}/cancel`, {});
}

export function liveEventsUrl(runId: string): string {
  return `api/runs/${encodeURIComponent(runId)}/events`;
}

export function replayEventsUrl(name: ReplayName, speed: number): string {
  return `api/replays/${encodeURIComponent(name)}/events?speed=${speed}`;
}

export type StreamHandle = { close(): void };

/**
 * Opens an event stream. Each message carries one desk event; anything that doesn't look like one is skipped.
 * The stream is closed on the end event. Between drops the browser reconnects with Last-Event-ID, and the
 * server resumes after it.
 */
export function openEvents(url: string, on: { event: (e: DeskEvent) => void; end: () => void; error: (message: string) => void }):
  StreamHandle {
  const source = new EventSource(url);
  let closed = false;
  source.onmessage = (m: MessageEvent<string>) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(m.data);
    } catch {
      return;
    }
    if (isRecord(parsed) && typeof parsed["type"] === "string" && typeof parsed["seq"] === "number") {
      on.event(parsed as DeskEvent);
    }
  };
  source.addEventListener("end", () => {
    closed = true;
    source.close();
    on.end();
  });
  source.onerror = () => {
    if (!closed && source.readyState === EventSource.CLOSED) {
      closed = true;
      on.error("The event stream closed before the run finished.");
    }
  };
  return {
    close: () => {
      closed = true;
      source.close();
    },
  };
}
