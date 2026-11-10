// Recordings: one JSONL file per run. Line 1 is a header, then one line per event, then an
// optional line listing the outbox files the run wrote. A replay re-renders or re-scores a
// recording without calling a model.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { z } from "zod";
import { DESK_EVENT_TYPES, DeskEventSchema, OutboxFileSchema, RecordingHeaderSchema } from "./contracts.ts";
import type { DeskEvent, OutboxFile, Quote, Recording, RecordingHeader, RecordingLine } from "./contracts.ts";
import { bundledClaudeCodeVersion, sdkVersion } from "./paths.ts";

/** The exact bytes the outbox file holds for a quote. */
export function serializeQuote(q: Quote): string {
  return JSON.stringify(q, null, 2) + "\n";
}

/** Writes header, events and the optional outbox line, creating the folder. LF line endings. */
export function writeRecording(path: string, rec: Recording): void {
  const lines: RecordingLine[] = [{ kind: "header", header: rec.header }];
  for (const event of rec.events) lines.push({ kind: "event", event });
  if (rec.outbox !== null) lines.push({ kind: "outbox", files: rec.outbox });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, lines.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf8");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) return "invalid";
  const where = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
  return `${where}${issue.message}`;
}

/**
 * Reads a recording. The header must be version 1. Events of a known type are validated; lines and
 * event types this version doesn't know are skipped, so an older reader survives a newer recording.
 * The returned events are the original parsed objects, never zod's output: zod rebuilds objects in
 * schema key order, which would change the bytes serializeQuote produces and break the outbox
 * checksum on replay. Errors read "<file>:<line>: ...".
 */
export function readRecording(path: string): Recording {
  const file = basename(path);
  const known = new Set<string>(DESK_EVENT_TYPES);
  let header: RecordingHeader | null = null;
  const events: DeskEvent[] = [];
  let outbox: OutboxFile[] | null = null;

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`${file}: cannot read the file (${(err as NodeJS.ErrnoException).code ?? "read error"})`);
  }
  const rows = raw.split("\n");
  for (let i = 0; i < rows.length; i++) {
    const row = (rows[i] ?? "").trim();
    if (row === "") continue;
    const at = `${file}:${i + 1}`;
    let line: unknown;
    try {
      line = JSON.parse(row);
    } catch {
      throw new Error(`${at}: not valid JSON`);
    }
    if (!isRecord(line)) throw new Error(`${at}: expected an object`);

    if (header === null) {
      if (line["kind"] !== "header") throw new Error(`${at}: the first line must be the header`);
      const parsed = RecordingHeaderSchema.safeParse(line["header"]);
      if (!parsed.success) throw new Error(`${at}: header: ${firstIssue(parsed.error)}`);
      header = line["header"] as RecordingHeader;
      continue;
    }
    if (line["kind"] === "header") throw new Error(`${at}: a second header`);
    if (line["kind"] === "event") {
      const event = line["event"];
      if (!isRecord(event) || typeof event["type"] !== "string") throw new Error(`${at}: an event needs a type`);
      if (!known.has(event["type"])) continue;
      const parsed = DeskEventSchema.safeParse(event);
      if (!parsed.success) throw new Error(`${at}: ${event["type"]}: ${firstIssue(parsed.error)}`);
      events.push(event as DeskEvent);
      continue;
    }
    if (line["kind"] === "outbox") {
      const parsed = z.array(OutboxFileSchema).safeParse(line["files"]);
      if (!parsed.success) throw new Error(`${at}: outbox: ${firstIssue(parsed.error)}`);
      outbox = line["files"] as OutboxFile[];
      continue;
    }
    // Any other kind of line is from a newer writer; skip it.
  }
  if (header === null) throw new Error(`${file}:1: the recording has no header`);
  return { header, events, outbox };
}

/**
 * Builds the header for a run from its own events. It needs the run_started event; the Claude Code
 * version comes from session_init when the run got that far, else from the installed SDK.
 */
export function headerFromEvents(events: DeskEvent[], extra: { kind: "demo" | "eval"; caseId: string | null;
  trial: number | null; gitSha: string | null; recordedAt: string }): RecordingHeader {
  let started: Extract<DeskEvent, { type: "run_started" }> | undefined;
  let init: Extract<DeskEvent, { type: "session_init" }> | undefined;
  for (const e of events) {
    if (e.type === "run_started" && started === undefined) started = e;
    if (e.type === "session_init" && init === undefined) init = e;
  }
  if (started === undefined) throw new Error("headerFromEvents needs a run_started event");
  return { v: 1, kind: extra.kind, recordedAt: extra.recordedAt, rfqId: started.rfqId, caseId: extra.caseId,
    trial: extra.trial, model: started.model, effort: started.effort, sdkVersion: sdkVersion(),
    claudeCodeVersion: init?.claudeCodeVersion ?? bundledClaudeCodeVersion(), stockFault: started.stockFault,
    faultSeed: started.faultSeed, promptHash: started.promptHash, catalogHash: started.catalogHash,
    gitSha: extra.gitSha };
}
