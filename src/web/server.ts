// The page's local server: static files from web/dist, live runs streamed as server-sent events, and the
// three demo recordings replayed with their recorded timing. node:http only. Everything it touches comes
// in through WebServerDeps, so tests inject a scripted runQuote and a fake clock and listen on port 0.
// It binds 127.0.0.1, answers only to a 127.0.0.1 or localhost Host header, and never writes a key or an
// environment value into a response.
import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { connect } from "node:net";
import { extname, join, resolve, sep } from "node:path";
import { DEFAULT_EFFORT, DEFAULT_MODEL, STOCK_DELAY_MS, SYNTHETIC_NOTICE, formatStockFault, parseStockFault }
  from "../contracts.ts";
import type { DeskEvent, Effort, KeySource, Rfq, RunOptions, RunQuote } from "../contracts.ts";
import { loadRfqs } from "../load.ts";
import { readRecording } from "../recording.ts";
import { LIMITS_WEB, REPLAYS, REPLAY_SPEEDS, SCENARIOS } from "./protocol.ts";
import type { MetaResponse, ReplayInfo, ReplayName, ScenarioInfo, ScenarioName } from "./protocol.ts";

/** Time and timers. Tests pass a fake one so the 120 s approval wait and the replay gaps run instantly. */
export type Clock = { now(): number; setTimeout(fn: () => void, ms: number): unknown; clearTimeout(timer: unknown): void };
export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

export type WebServerDeps = {
  runQuote: RunQuote;
  keySource: KeySource;
  recordingsDir: string;
  staticDir: string;
  clock: Clock;
  live?: boolean | undefined; // false for --no-live; live runs also need a key
  maxRuns?: number | undefined; // 20
  rfqsPath?: string | undefined; // PATHS.rfqs
  outboxDir?: string | undefined; // runQuote's default, PATHS.outbox
  model?: string | undefined; // DEFAULT_MODEL
  effort?: Effort | undefined; // DEFAULT_EFFORT
  approvalTimeoutMs?: number | undefined; // 120 s, then decline
  idleAbortMs?: number | undefined; // 10 s with no subscriber, then abort
  keepaliveMs?: number | undefined; // 15 s
};
export type WebServer = { server: Server; listen(port: number): Promise<number>; port(): number; close(): Promise<void> };

export const WEB_DEFAULTS = { port: 4310, maxRuns: 20, approvalTimeoutMs: 120_000, idleAbortMs: 10_000,
  keepaliveMs: 15_000 } as const;

type Decision = "approve" | "decline";
type PendingApproval = { settle: (d: Decision) => void; timer: unknown };
type Stream = { res: ServerResponse; keepalive: unknown; timer: unknown };
type LiveRun = { id: string; events: DeskEvent[]; done: boolean; streams: Set<Stream>; controller: AbortController;
  approval: PendingApproval | null; idleTimer: unknown };

class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const CONTENT_TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json; charset=utf-8",
  ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8" };
const BASE_HEADERS: Record<string, string> = { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'" };
const END_FRAME = "event: end\ndata: {}\n\n";

function frame(e: DeskEvent): string {
  return `id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { ...BASE_HEADERS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(text) });
  res.end(text);
}

function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { error: { code, message } });
}

function sendNoContent(res: ServerResponse): void {
  res.writeHead(204, { ...BASE_HEADERS, "Cache-Control": "no-store" });
  res.end();
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The Last-Event-ID a reconnecting EventSource sends, or -1 when there is none. */
function lastEventId(req: IncomingMessage): number {
  const raw = req.headers["last-event-id"];
  const v = Array.isArray(raw) ? raw[0] : raw;
  return v !== undefined && /^[0-9]{1,9}$/.test(v.trim()) ? Number(v.trim()) : -1;
}

/** True when something on 127.0.0.1:<port> accepts a TCP connection within timeoutMs. */
function portAnswers(port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((done) => {
    const socket = connect({ port, host: "127.0.0.1" });
    const finish = (taken: boolean): void => {
      socket.destroy();
      done(taken);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

/** Reads a JSON body of at most LIMITS_WEB.bodyBytes. */
function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((done, fail) => {
    const declared = Number(req.headers["content-length"] ?? "0");
    if (Number.isFinite(declared) && declared > LIMITS_WEB.bodyBytes) {
      fail(new HttpError(413, "too_large", `The body is over ${LIMITS_WEB.bodyBytes} bytes.`));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on("data", (chunk: Buffer) => {
      if (over) return;
      size += chunk.length;
      if (size > LIMITS_WEB.bodyBytes) {
        over = true;
        fail(new HttpError(413, "too_large", `The body is over ${LIMITS_WEB.bodyBytes} bytes.`));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (over) return;
      const text = Buffer.concat(chunks).toString("utf8");
      if (text.trim() === "") {
        fail(new HttpError(400, "bad_json", "The body is empty."));
        return;
      }
      try {
        done(JSON.parse(text));
      } catch {
        fail(new HttpError(400, "bad_json", "The body is not valid JSON."));
      }
    });
    req.on("error", () => fail(new HttpError(400, "bad_body", "The body could not be read.")));
  });
}

export function createWebServer(deps: WebServerDeps): WebServer {
  const clock = deps.clock;
  const maxRuns = deps.maxRuns ?? WEB_DEFAULTS.maxRuns;
  const approvalTimeoutMs = deps.approvalTimeoutMs ?? WEB_DEFAULTS.approvalTimeoutMs;
  const idleAbortMs = deps.idleAbortMs ?? WEB_DEFAULTS.idleAbortMs;
  const keepaliveMs = deps.keepaliveMs ?? WEB_DEFAULTS.keepaliveMs;
  const model = deps.model ?? DEFAULT_MODEL;
  const effort = deps.effort ?? DEFAULT_EFFORT;
  const live = deps.live !== false && deps.keySource !== "unset";
  const staticRoot = resolve(deps.staticDir);

  const runs = new Map<string, LiveRun>();
  let active: LiveRun | null = null;
  let started = 0;
  let pasted = 0;
  const openStreams = new Set<Stream>();
  let replayCache: ReplayInfo[] | null = null;
  let closing = false;

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (err instanceof HttpError) {
        sendError(res, err.status, err.code, err.message);
        if (err.status === 413) res.on("finish", () => req.destroy());
        return;
      }
      sendError(res, 500, "internal", "The server hit an error. Nothing was sent.");
    });
  });

  function boundPort(): number {
    const a = server.address();
    return a !== null && typeof a === "object" ? a.port : 0;
  }

  // ---- streams
  function armKeepalive(s: Stream): void {
    s.keepalive = clock.setTimeout(() => {
      if (s.res.writableEnded) return;
      s.res.write(": keepalive\n\n");
      armKeepalive(s);
    }, keepaliveMs);
  }

  function openStream(res: ServerResponse): Stream {
    res.writeHead(200, { ...BASE_HEADERS, "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" });
    res.write(": open\n\n");
    const s: Stream = { res, keepalive: null, timer: null };
    armKeepalive(s);
    openStreams.add(s);
    return s;
  }

  function closeStream(s: Stream, withEnd: boolean): void {
    clock.clearTimeout(s.keepalive);
    clock.clearTimeout(s.timer);
    openStreams.delete(s);
    if (!s.res.writableEnded) {
      if (withEnd) s.res.write(END_FRAME);
      s.res.end();
    }
  }

  // ---- live runs
  function settleApproval(run: LiveRun, d: Decision): boolean {
    const pending = run.approval;
    if (pending === null) return false;
    pending.settle(d);
    return true;
  }

  function armIdle(run: LiveRun): void {
    clock.clearTimeout(run.idleTimer);
    run.idleTimer = null;
    if (closing || run.done || run.streams.size > 0) return;
    run.idleTimer = clock.setTimeout(() => {
      run.idleTimer = null;
      if (run.done || run.streams.size > 0) return;
      run.controller.abort();
      settleApproval(run, "decline");
    }, idleAbortMs);
  }

  async function drain(run: LiveRun, rfq: Rfq, opts: RunOptions): Promise<void> {
    try {
      for await (const e of deps.runQuote(rfq, opts)) {
        run.events.push(e);
        // close() ends every stream while a run can still be yielding, so skip a response that has ended.
        for (const s of run.streams) if (!s.res.writableEnded) s.res.write(frame(e));
      }
    } catch {
      // runQuote promises never to throw. If it does, the stream still ends, and the page reads a run that
      // stopped before run_finished as failed.
    } finally {
      run.done = true;
      settleApproval(run, "decline");
      clock.clearTimeout(run.idleTimer);
      run.idleTimer = null;
      for (const s of [...run.streams]) closeStream(s, true);
      run.streams.clear();
      if (active === run) active = null;
    }
  }

  function startRun(rfq: Rfq, stockFault: string): LiveRun {
    const run: LiveRun = { id: randomUUID(), events: [], done: false, streams: new Set(), controller: new AbortController(),
      approval: null, idleTimer: null };
    const approver = (): Promise<Decision> => new Promise<Decision>((resolveDecision) => {
      const pending: PendingApproval = {
        settle: (d) => {
          if (run.approval !== pending) return;
          clock.clearTimeout(pending.timer);
          run.approval = null;
          resolveDecision(d);
        },
        timer: null,
      };
      run.approval = pending;
      pending.timer = clock.setTimeout(() => pending.settle("decline"), approvalTimeoutMs);
      if (run.controller.signal.aborted || closing) pending.settle("decline");
    });
    const opts: RunOptions = { model, effort, stockFault, stockDelayMs: STOCK_DELAY_MS.demo, approver,
      signal: run.controller.signal };
    if (deps.outboxDir !== undefined) opts.outboxDir = deps.outboxDir;
    runs.set(run.id, run);
    active = run;
    started++;
    armIdle(run);
    void drain(run, rfq, opts);
    return run;
  }

  function findRfq(id: string): Rfq {
    let rfqs: Rfq[];
    try {
      rfqs = loadRfqs(deps.rfqsPath);
    } catch {
      throw new HttpError(500, "data", "The RFQ file could not be read. Run npm run data:check.");
    }
    const rfq = rfqs.find((r) => r.id === id);
    if (rfq === undefined) throw new HttpError(500, "data", `${id} is not in the RFQ file.`);
    return rfq;
  }

  function parseStart(body: unknown): { rfq: Rfq; stockFault: string } {
    if (!isRecord(body)) throw new HttpError(400, "bad_input", "Send { scenario } or { rfq: { subject, body } }.");
    if ("scenario" in body) {
      const s = SCENARIOS.find((x) => x.name === body["scenario"]);
      if (s === undefined || Object.keys(body).length !== 1) {
        throw new HttpError(400, "bad_input", `scenario must be one of ${SCENARIOS.map((x) => x.name).join(", ")}.`);
      }
      return { rfq: findRfq(s.rfqId), stockFault: s.stockFault };
    }
    const extra = Object.keys(body).filter((k) => k !== "rfq" && k !== "stockFault");
    const r = body["rfq"];
    if (!isRecord(r) || extra.length > 0) throw new HttpError(400, "bad_input", "Send { scenario } or { rfq: { subject, body } }.");
    const subject = r["subject"];
    const text = r["body"];
    if (typeof subject !== "string" || subject.trim() === "") throw new HttpError(400, "bad_input", "The subject is empty.");
    if (typeof text !== "string" || text.trim() === "") throw new HttpError(400, "bad_input", "The RFQ text is empty.");
    if (subject.length > LIMITS_WEB.subjectChars) {
      throw new HttpError(400, "bad_input", `The subject is over ${LIMITS_WEB.subjectChars} characters.`);
    }
    if (text.length > LIMITS_WEB.rfqChars) {
      throw new HttpError(400, "bad_input", `The RFQ text is over ${LIMITS_WEB.rfqChars} characters.`);
    }
    let stockFault = "ok";
    const fault = body["stockFault"];
    if (fault !== undefined) {
      try {
        if (typeof fault !== "string") throw new Error("not a string");
        stockFault = formatStockFault(parseStockFault(fault));
      } catch {
        throw new HttpError(400, "bad_input", "stockFault must be ok, down, fail-first:<n> or flaky:<rate>.");
      }
    }
    // Today on this machine's calendar. toISOString would give the UTC date, a day ahead on a US evening.
    const today = new Date(clock.now());
    const receivedOn = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-`
      + String(today.getDate()).padStart(2, "0");
    // The id is assigned only once the run is sure to start, so a refused request doesn't use a number.
    return { rfq: { id: "PASTE-0", customer: "Pasted RFQ", contactEmail: "paste@example.invalid", receivedOn,
      subject, body: text }, stockFault };
  }

  // ---- replays
  function replayInfos(): ReplayInfo[] {
    if (replayCache !== null) return replayCache;
    const out: ReplayInfo[] = [];
    for (const r of REPLAYS) {
      try {
        const rec = readRecording(join(deps.recordingsDir, `${r.name}.jsonl`));
        const last = rec.events[rec.events.length - 1];
        const finished = rec.events.findLast((e) => e.type === "run_finished");
        const durationMs = finished !== undefined && finished.type === "run_finished" ? finished.durationMs : (last?.t ?? 0);
        out.push({ name: r.name, scenario: r.scenario, recordedAt: rec.header.recordedAt, rfqId: rec.header.rfqId,
          stockFault: rec.header.stockFault, durationMs, events: rec.events.length });
      } catch {
        // A recording that doesn't parse is left out of the list; the replay route answers 500 for it.
      }
    }
    replayCache = out;
    return out;
  }

  function streamReplay(req: IncomingMessage, res: ServerResponse, name: ReplayName, speed: number): void {
    let events: DeskEvent[];
    try {
      events = readRecording(join(deps.recordingsDir, `${name}.jsonl`)).events;
    } catch {
      throw new HttpError(500, "recording", `The recording ${name} could not be read.`);
    }
    const after = lastEventId(req);
    const sent = events.filter((e) => e.seq <= after);
    const queue = events.filter((e) => e.seq > after);
    let prevT = sent[sent.length - 1]?.t ?? 0;
    let i = 0;
    const s = openStream(res);
    const schedule = (): void => {
      const next = queue[i];
      const gap = next === undefined ? 0 : Math.max(0, next.t - prevT) / speed;
      s.timer = clock.setTimeout(step, gap);
    };
    const step = (): void => {
      s.timer = null;
      if (!openStreams.has(s)) return;
      const e = queue[i];
      if (e === undefined) {
        closeStream(s, true);
        return;
      }
      res.write(frame(e));
      prevT = e.t;
      i++;
      schedule();
    };
    res.on("close", () => closeStream(s, false));
    schedule();
  }

  // ---- routing
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const port = boundPort();
    const host = req.headers.host;
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      throw new HttpError(403, "bad_host", "This server answers only to 127.0.0.1 and localhost on its own port.");
    }
    const method = req.method ?? "GET";
    let url: URL;
    try {
      url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    } catch {
      throw new HttpError(400, "bad_url", "The URL could not be read.");
    }
    const path = url.pathname;

    if (method === "POST") {
      const origin = req.headers.origin;
      if (origin !== undefined && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) {
        throw new HttpError(403, "bad_origin", "A POST must come from this page.");
      }
      const type = (req.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
      if (type !== "application/json") throw new HttpError(415, "bad_content_type", "A POST needs Content-Type: application/json.");
    }

    if (path === "/api/meta") {
      if (method !== "GET") throw new HttpError(405, "method", "Use GET.");
      sendJson(res, 200, meta());
      return;
    }
    if (path === "/api/runs") {
      if (method !== "POST") throw new HttpError(405, "method", "Use POST.");
      await postRun(req, res);
      return;
    }
    const runRoute = /^\/api\/runs\/([^/]+)\/(events|approval|cancel)$/.exec(path);
    if (runRoute !== null) {
      const run = runs.get(runRoute[1] ?? "");
      const action = runRoute[2];
      if (action === "events") {
        if (method !== "GET") throw new HttpError(405, "method", "Use GET.");
        if (run === undefined) throw new HttpError(404, "no_run", "No run has that id.");
        subscribe(req, res, run);
        return;
      }
      if (method !== "POST") throw new HttpError(405, "method", "Use POST.");
      if (run === undefined) throw new HttpError(404, "no_run", "No run has that id.");
      if (action === "approval") {
        const body = await readJsonBody(req);
        const decision = isRecord(body) ? body["decision"] : undefined;
        if (decision !== "approve" && decision !== "decline") {
          throw new HttpError(400, "bad_input", "decision must be approve or decline.");
        }
        if (!settleApproval(run, decision)) throw new HttpError(409, "no_approval", "No approval is pending for this run.");
        sendNoContent(res);
        return;
      }
      run.controller.abort();
      settleApproval(run, "decline");
      sendNoContent(res);
      return;
    }
    const replayRoute = /^\/api\/replays\/([^/]+)\/events$/.exec(path);
    if (replayRoute !== null) {
      if (method !== "GET") throw new HttpError(405, "method", "Use GET.");
      const r = REPLAYS.find((x) => x.name === replayRoute[1]);
      if (r === undefined) throw new HttpError(404, "no_replay", `Replays are ${REPLAYS.map((x) => x.name).join(", ")}.`);
      const rawSpeed = url.searchParams.get("speed") ?? "1";
      const speed = Number(rawSpeed);
      if (!/^[0-9]$/.test(rawSpeed) || !REPLAY_SPEEDS.includes(speed)) {
        throw new HttpError(400, "bad_speed", `speed must be ${REPLAY_SPEEDS.join(", ")}.`);
      }
      streamReplay(req, res, r.name, speed);
      return;
    }
    if (path.startsWith("/api/")) throw new HttpError(404, "not_found", "No such route.");
    if (method !== "GET" && method !== "HEAD") throw new HttpError(405, "method", "Use GET.");
    serveStatic(path, method === "HEAD", res);
  }

  function meta(): MetaResponse {
    let scenarios: ScenarioInfo[];
    try {
      const rfqs = loadRfqs(deps.rfqsPath);
      scenarios = SCENARIOS.flatMap((s) => {
        const rfq = rfqs.find((r) => r.id === s.rfqId);
        return rfq === undefined ? [] : [{ name: s.name, label: s.label, stockFault: s.stockFault, rfq }];
      });
    } catch {
      scenarios = [];
    }
    return { live, keySource: deps.keySource, model, effort, notice: SYNTHETIC_NOTICE, scenarios, replays: replayInfos(),
      limits: { maxRuns, rfqMaxChars: LIMITS_WEB.rfqChars } };
  }

  async function postRun(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!live) {
      const why = deps.keySource === "unset"
        ? "No API key, so live runs are off. Recorded runs still play."
        : "Live runs are off (--no-live). Recorded runs still play.";
      throw new HttpError(403, "live_off", why);
    }
    const body = await readJsonBody(req);
    const { rfq, stockFault } = parseStart(body);
    if (active !== null) throw new HttpError(409, "busy", "A live run is already going. Wait for it or cancel it.");
    if (started >= maxRuns) {
      throw new HttpError(429, "run_cap", `This server has started its ${maxRuns} live runs. Restart it to run more.`);
    }
    const name = "scenario" in (body as Record<string, unknown>) ? null : `PASTE-${++pasted}`;
    const run = startRun(name === null ? rfq : { ...rfq, id: name }, stockFault);
    sendJson(res, 201, { runId: run.id });
  }

  function subscribe(req: IncomingMessage, res: ServerResponse, run: LiveRun): void {
    const after = lastEventId(req);
    const s = openStream(res);
    for (const e of run.events) if (e.seq > after) res.write(frame(e));
    if (run.done) {
      closeStream(s, true);
      return;
    }
    run.streams.add(s);
    armIdle(run);
    res.on("close", () => {
      run.streams.delete(s);
      closeStream(s, false);
      armIdle(run);
    });
  }

  function serveStatic(path: string, headOnly: boolean, res: ServerResponse): void {
    let rel: string;
    try {
      rel = decodeURIComponent(path);
    } catch {
      throw new HttpError(400, "bad_url", "The path could not be read.");
    }
    if (rel.includes("\0")) throw new HttpError(404, "not_found", "No such file.");
    if (rel === "/" || rel === "") rel = "/index.html";
    const file = resolve(staticRoot, `.${rel}`);
    if (!file.startsWith(staticRoot + sep)) throw new HttpError(404, "not_found", "No such file.");
    let bytes: Buffer;
    try {
      if (!statSync(file).isFile()) throw new Error("not a file");
      bytes = readFileSync(file);
    } catch {
      if (rel === "/index.html") throw new HttpError(404, "not_built", "The page isn't built. Run npm run web:build.");
      throw new HttpError(404, "not_found", "No such file.");
    }
    const type = CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
    res.writeHead(200, { ...BASE_HEADERS, "Content-Type": type, "Content-Length": bytes.length,
      "Cache-Control": rel === "/index.html" ? "no-cache" : "public, max-age=3600" });
    res.end(headOnly ? undefined : bytes);
  }

  return {
    server,
    port: boundPort,
    listen(port: number): Promise<number> {
      return new Promise((done, fail) => {
        const onError = (err: Error): void => {
          server.off("listening", onListening);
          fail(err);
        };
        const onListening = (): void => {
          server.off("error", onError);
          done(boundPort());
        };
        server.once("error", onError);
        server.once("listening", onListening);
        // On Windows a listener on 0.0.0.0:<port> doesn't stop a 127.0.0.1 bind, and ours would then shadow it
        // on loopback. So a fixed port that already accepts a connection counts as taken.
        if (port === 0) {
          server.listen({ port, host: "127.0.0.1", exclusive: true });
          return;
        }
        void portAnswers(port).then((taken) => {
          if (!taken) {
            server.listen({ port, host: "127.0.0.1", exclusive: true });
            return;
          }
          const err: NodeJS.ErrnoException = new Error(`127.0.0.1:${port} already accepts connections.`);
          err.code = "EADDRINUSE";
          server.off("error", onError);
          server.off("listening", onListening);
          fail(err);
        });
      });
    },
    close(): Promise<void> {
      closing = true;
      for (const run of runs.values()) {
        if (!run.done) run.controller.abort();
        settleApproval(run, "decline");
        clock.clearTimeout(run.idleTimer);
        run.idleTimer = null;
        for (const s of [...run.streams]) closeStream(s, false);
        run.streams.clear();
      }
      for (const s of [...openStreams]) closeStream(s, false);
      return new Promise((done) => {
        server.close(() => done());
        server.closeAllConnections();
      });
    },
  };
}
