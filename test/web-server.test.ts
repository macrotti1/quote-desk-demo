// The page's server (src/web/server.ts) on port 0 with a scripted runQuote and a fake clock. No model, no
// network beyond 127.0.0.1, no environment reads. One test runs the real createRunQuote with the scripted
// agent and a marker in place of a key, and checks that no response carries the marker.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import type { DeskEvent, KeySource, Quote, Rfq, RunOptions, RunQuote } from "../src/contracts.ts";
import { createRunQuote } from "../src/agent/run.ts";
import { loadCatalog, loadTruth } from "../src/load.ts";
import { PATHS } from "../src/paths.ts";
import { finalizeQuote } from "../src/quote/finalize.ts";
import { approveAndSend } from "../src/quote/gate.ts";
import { readRecording } from "../src/recording.ts";
import type { MetaResponse, ReplayName } from "../src/web/protocol.ts";
import { createWebServer } from "../src/web/server.ts";
import type { Clock, WebServer, WebServerDeps } from "../src/web/server.ts";
import { scriptedAgent } from "./helpers/scripted-agent.ts";

const KEY_MARKER = "qd-scripted-key-marker-7f3a91";
const STATIC_DIR = join(PATHS.root, "test", "fixtures", "web", "static");
const temps: string[] = [];
after(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});

// ---- a fake clock: timers under autoBelowMs fire on the next turn, longer ones wait for fire(ms)
class FakeClock implements Clock {
  readonly delays: number[] = [];
  private readonly timers = new Map<number, { fn: () => void; ms: number }>();
  private next = 1;
  private readonly autoBelowMs: number;
  constructor(autoBelowMs: number) {
    this.autoBelowMs = autoBelowMs;
  }
  now(): number {
    return Date.parse("2026-11-10T15:00:00Z");
  }
  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.next++;
    this.delays.push(ms);
    this.timers.set(id, { fn, ms });
    if (ms < this.autoBelowMs) {
      setImmediate(() => {
        if (this.timers.delete(id)) fn();
      });
    }
    return id;
  }
  clearTimeout(timer: unknown): void {
    if (typeof timer === "number") this.timers.delete(timer);
  }
  /** Fires every waiting timer set for exactly ms. Returns how many fired. */
  fire(ms: number): number {
    let n = 0;
    for (const [id, t] of [...this.timers]) {
      if (t.ms !== ms) continue;
      this.timers.delete(id);
      t.fn();
      n++;
    }
    return n;
  }
}

// ---- a runQuote that plays a recording, asks the real approver, and honors the abort signal
function eventsOf(name: ReplayName): DeskEvent[] {
  return readRecording(join(PATHS.recordingsDir, `${name}.jsonl`)).events;
}

type Seen = { rfq: Rfq; opts: RunOptions; decision: "approve" | "decline" | null };
function recordedRunQuote(name: ReplayName): { runQuote: RunQuote; seen: Seen[] } {
  const events = eventsOf(name);
  const seen: Seen[] = [];
  const runQuote: RunQuote = async function* (rfq, opts = {}) {
    const me: Seen = { rfq, opts, decision: null };
    seen.push(me);
    let quote: Quote | null = null;
    for (const e of events) {
      if (e.type === "quote") quote = e.quote;
      if (e.type === "approval_resolved") {
        assert.ok(quote !== null && opts.approver !== undefined);
        me.decision = await opts.approver(quote);
        yield { ...e, decision: me.decision };
        continue;
      }
      if (e.type === "delivery" && me.decision !== null) {
        yield me.decision === "approve" ? { ...e, outcome: "sent", file: `${rfq.id}.json` } : e;
        continue;
      }
      if (e.type === "run_finished" && opts.signal?.aborted === true) {
        yield { ...e, ok: false, failure: "aborted", detail: "aborted by the caller" };
        continue;
      }
      yield e;
    }
  };
  return { runQuote, seen };
}

// ---- HTTP helpers. Every response body is kept, so the last test can scan them all for the key marker.
const bodies: string[] = [];
type Res = { status: number; headers: IncomingHttpHeaders; text: string };
function call(port: number, method: string, path: string, o: { headers?: Record<string, string>; body?: string } = {}):
  Promise<Res> {
  return new Promise((done, fail) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers: { Host: `127.0.0.1:${port}`, ...o.headers } },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (text += c));
        res.on("end", () => {
          bodies.push(text);
          done({ status: res.statusCode ?? 0, headers: res.headers, text });
        });
      });
    req.on("error", fail);
    if (o.body !== undefined) req.write(o.body);
    req.end();
  });
}
function postJson(port: number, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Res> {
  return call(port, "POST", path, { headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
}

type Frame = { id: string | null; event: string | null; data: string | null };
function parseFrames(raw: string): Frame[] {
  const out: Frame[] = [];
  for (const block of raw.split("\n\n")) {
    const f: Frame = { id: null, event: null, data: null };
    let any = false;
    for (const line of block.split("\n")) {
      const m = /^(id|event|data): (.*)$/.exec(line);
      if (m === null) continue;
      any = true;
      f[m[1] as "id" | "event" | "data"] = m[2] ?? "";
    }
    if (any) out.push(f);
  }
  return out;
}
function deskEvents(frames: Frame[]): DeskEvent[] {
  return frames.filter((f) => f.event === null && f.data !== null).map((f) => JSON.parse(f.data ?? "") as DeskEvent);
}

/** An open event stream. waitFor resolves once the frames so far satisfy the predicate. */
class Sse {
  raw = "";
  status = 0;
  readonly ended: Promise<void>;
  private listeners: (() => void)[] = [];
  private destroy: () => void = () => {};
  constructor(port: number, path: string, headers: Record<string, string> = {}) {
    this.ended = new Promise((done, fail) => {
      const req = request({ host: "127.0.0.1", port, method: "GET", path,
        headers: { Host: `127.0.0.1:${port}`, Accept: "text/event-stream", ...headers } }, (res) => {
        this.status = res.statusCode ?? 0;
        res.setEncoding("utf8");
        res.on("data", (c: string) => {
          this.raw += c;
          for (const l of this.listeners) l();
        });
        res.on("end", () => {
          bodies.push(this.raw);
          for (const l of this.listeners) l();
          done();
        });
        res.on("error", () => done());
      });
      req.on("error", fail);
      req.end();
      this.destroy = () => req.destroy();
    });
  }
  frames(): Frame[] {
    return parseFrames(this.raw);
  }
  waitFor(pred: (frames: Frame[]) => boolean, ms = 5000): Promise<void> {
    return new Promise((done, fail) => {
      const check = (): void => {
        if (pred(this.frames())) {
          clearTimeout(timer);
          this.listeners = this.listeners.filter((l) => l !== check);
          done();
        }
      };
      const timer = setTimeout(() => fail(new Error(`timed out waiting; frames so far:\n${this.raw.slice(-800)}`)), ms);
      this.listeners.push(check);
      check();
    });
  }
  close(): void {
    this.destroy();
  }
}
const hasType = (type: string) => (frames: Frame[]): boolean => deskEvents(frames).some((e) => e.type === type);
const hasEnd = (frames: Frame[]): boolean => frames.some((f) => f.event === "end");

// ---- server setup
type Setup = { web: WebServer; port: number; clock: FakeClock; seen: Seen[] };
async function start(over: Partial<WebServerDeps> & { recording?: ReplayName; keySource?: KeySource } = {}): Promise<Setup> {
  const clock = new FakeClock(10_000);
  const fake = recordedRunQuote(over.recording ?? "demo-clean");
  const { recording: _ignored, ...rest } = over;
  const web = createWebServer({ runQuote: fake.runQuote, keySource: "environment", recordingsDir: PATHS.recordingsDir,
    staticDir: STATIC_DIR, clock, ...rest });
  const port = await web.listen(0);
  return { web, port, clock, seen: fake.seen };
}
async function withServer(over: Parameters<typeof start>[0], fn: (s: Setup) => Promise<void>): Promise<void> {
  const s = await start(over);
  try {
    await fn(s);
  } finally {
    await s.web.close();
  }
}
async function startScenario(s: Setup, scenario = "clean"): Promise<string> {
  const r = await postJson(s.port, "/api/runs", { scenario });
  assert.equal(r.status, 201, r.text);
  const { runId } = JSON.parse(r.text) as { runId: string };
  assert.match(runId, /^[A-Za-z0-9-]+$/);
  return runId;
}

describe("web server: meta and static files", () => {
  test("meta lists 3 scenarios and 3 replays and never a key", async () => {
    await withServer({}, async (s) => {
      const r = await call(s.port, "GET", "/api/meta");
      assert.equal(r.status, 200);
      const meta = JSON.parse(r.text) as MetaResponse;
      assert.equal(meta.live, true);
      assert.equal(meta.keySource, "environment");
      assert.deepEqual(meta.scenarios.map((x) => [x.name, x.rfq.id, x.stockFault]),
        [["clean", "RFQ-001", "ok"], ["stock-down", "RFQ-001", "down"], ["unknown-material", "RFQ-019", "ok"]]);
      assert.deepEqual(meta.replays.map((x) => [x.name, x.events, x.stockFault]),
        [["demo-clean", 23, "ok"], ["demo-stock-down", 21, "down"], ["demo-unknown-material", 13, "ok"]]);
      assert.match(meta.notice, /synthetic/i);
      assert.deepEqual(meta.limits, { maxRuns: 20, rfqMaxChars: 8000 });
    });
  });

  test("a fixed port that already accepts connections on any address is taken", async () => {
    // On Windows a holder on 0.0.0.0 doesn't make a 127.0.0.1 bind fail, so listen() probes first.
    const holder = createNetServer((sock) => sock.destroy());
    await new Promise<void>((done) => holder.listen({ port: 0, host: "0.0.0.0" }, () => done()));
    const a = holder.address();
    const held = a !== null && typeof a === "object" ? a.port : 0;
    const web = createWebServer({ runQuote: recordedRunQuote("demo-clean").runQuote, keySource: "environment",
      recordingsDir: PATHS.recordingsDir, staticDir: STATIC_DIR, clock: new FakeClock(10_000) });
    try {
      await assert.rejects(web.listen(held), (err: NodeJS.ErrnoException) => err.code === "EADDRINUSE");
      assert.equal(web.server.listening, false);
    } finally {
      await new Promise<void>((done) => holder.close(() => done()));
    }
  });

  test("serves index.html at / and refuses paths outside the static folder", async () => {
    await withServer({}, async (s) => {
      const r = await call(s.port, "GET", "/");
      assert.equal(r.status, 200);
      assert.match(String(r.headers["content-type"]), /text\/html/);
      assert.match(r.text, /fixture page/);
      assert.equal((await call(s.port, "GET", "/%2e%2e/web-server.test.ts")).status, 404);
      assert.equal((await call(s.port, "GET", "/..%2f..%2fpackage.json")).status, 404);
      assert.equal((await call(s.port, "GET", "/nope.js")).status, 404);
    });
  });
});

describe("web server: guards", () => {
  test("403 for a foreign Host, on any route", async () => {
    await withServer({}, async (s) => {
      for (const path of ["/api/meta", "/", "/api/replays/demo-clean/events"]) {
        const r = await call(s.port, "GET", path, { headers: { Host: "evil.example" } });
        assert.equal(r.status, 403, path);
        assert.equal((JSON.parse(r.text) as { error: { code: string } }).error.code, "bad_host");
      }
      assert.equal((await call(s.port, "GET", "/api/meta", { headers: { Host: `localhost:${s.port}` } })).status, 200);
      assert.equal((await call(s.port, "GET", "/api/meta", { headers: { Host: `127.0.0.1:${s.port + 1}` } })).status, 403);
    });
  });

  test("403 for a foreign Origin and 415 for a wrong content type", async () => {
    await withServer({}, async (s) => {
      const foreign = await postJson(s.port, "/api/runs", { scenario: "clean" }, { Origin: "http://evil.example" });
      assert.equal(foreign.status, 403);
      const plain = await call(s.port, "POST", "/api/runs", { headers: { "Content-Type": "text/plain" }, body: "{}" });
      assert.equal(plain.status, 415);
      const none = await call(s.port, "POST", "/api/runs", { body: "{}" });
      assert.equal(none.status, 415);
      assert.equal(s.seen.length, 0);
      const own = await postJson(s.port, "/api/runs", { scenario: "stock-down" }, { Origin: `http://127.0.0.1:${s.port}` });
      assert.equal(own.status, 201);
    });
  });

  test("403 on POST /api/runs when the key source is unset, and with --no-live", async () => {
    await withServer({ keySource: "unset" }, async (s) => {
      const r = await postJson(s.port, "/api/runs", { scenario: "clean" });
      assert.equal(r.status, 403);
      assert.equal(s.seen.length, 0);
      const meta = JSON.parse((await call(s.port, "GET", "/api/meta")).text) as MetaResponse;
      assert.equal(meta.live, false);
      assert.equal(meta.keySource, "unset");
    });
    await withServer({ live: false }, async (s) => {
      assert.equal((await postJson(s.port, "/api/runs", { scenario: "clean" })).status, 403);
      assert.equal(s.seen.length, 0);
    });
  });

  test("400 on bad input, 413 on a body over 16 KB", async () => {
    await withServer({}, async (s) => {
      const bad = [{}, { scenario: "nope" }, { scenario: "clean", extra: 1 }, { rfq: { subject: "", body: "x" } },
        { rfq: { subject: "s", body: " " } }, { rfq: { subject: "s".repeat(201), body: "x" } },
        { rfq: { subject: "s", body: "x".repeat(8001) } }, { rfq: { subject: "s", body: "x" }, stockFault: "sometimes" }];
      for (const b of bad) assert.equal((await postJson(s.port, "/api/runs", b)).status, 400, JSON.stringify(b).slice(0, 80));
      const notJson = await call(s.port, "POST", "/api/runs", { headers: { "Content-Type": "application/json" }, body: "{" });
      assert.equal(notJson.status, 400);
      const big = await call(s.port, "POST", "/api/runs", { headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rfq: { subject: "s", body: "x".repeat(17_000) } }) });
      assert.equal(big.status, 413);
      assert.equal(s.seen.length, 0);
    });
  });
});

describe("web server: live runs", () => {
  test("framing: one id and data per event, then event: end, and the stream closes", async () => {
    await withServer({ recording: "demo-stock-down" }, async (s) => {
      const runId = await startScenario(s, "stock-down");
      const sse = new Sse(s.port, `/api/runs/${runId}/events`);
      await sse.ended;
      assert.equal(sse.status, 200);
      const frames = sse.frames();
      const last = frames[frames.length - 1];
      assert.deepEqual(last, { id: null, event: "end", data: "{}" });
      const events = frames.slice(0, -1);
      assert.equal(events.length, 21);
      events.forEach((f, i) => {
        assert.equal(f.id, String(i));
        assert.equal((JSON.parse(f.data ?? "") as DeskEvent).seq, i);
      });
      assert.equal(deskEvents(frames).at(-1)?.type, "run_finished");
      assert.equal(s.seen[0]?.opts.stockFault, "down");
      assert.equal(s.seen[0]?.rfq.id, "RFQ-001");
    });
  });

  test("resume with Last-Event-ID sends only the events after it", async () => {
    await withServer({ recording: "demo-stock-down" }, async (s) => {
      const runId = await startScenario(s, "stock-down");
      await new Sse(s.port, `/api/runs/${runId}/events`).ended;
      const resumed = new Sse(s.port, `/api/runs/${runId}/events`, { "Last-Event-ID": "10" });
      await resumed.ended;
      const ids = resumed.frames().filter((f) => f.event === null).map((f) => f.id);
      assert.deepEqual(ids, ["11", "12", "13", "14", "15", "16", "17", "18", "19", "20"]);
      assert.ok(hasEnd(resumed.frames()));
    });
  });

  test("a GET never starts a run", async () => {
    await withServer({}, async (s) => {
      assert.equal((await call(s.port, "GET", "/api/runs")).status, 405);
      assert.equal((await call(s.port, "GET", "/api/runs/abc/events")).status, 404);
      assert.equal((await call(s.port, "GET", "/api/runs/abc/approval")).status, 405);
      assert.equal(s.seen.length, 0);
    });
  });

  test("the approval POST resolves the approver, and a second one is 409", async () => {
    await withServer({}, async (s) => {
      const runId = await startScenario(s);
      const sse = new Sse(s.port, `/api/runs/${runId}/events`);
      await sse.waitFor(hasType("approval_requested"));
      const bad = await postJson(s.port, `/api/runs/${runId}/approval`, { decision: "maybe" });
      assert.equal(bad.status, 400);
      const r = await postJson(s.port, `/api/runs/${runId}/approval`, { decision: "approve" });
      assert.equal(r.status, 204);
      await sse.ended;
      assert.equal(s.seen[0]?.decision, "approve");
      const events = deskEvents(sse.frames());
      assert.ok(events.some((e) => e.type === "approval_resolved" && e.decision === "approve"));
      assert.ok(events.some((e) => e.type === "delivery" && e.outcome === "sent" && e.file === "RFQ-001.json"));
      assert.equal((await postJson(s.port, `/api/runs/${runId}/approval`, { decision: "approve" })).status, 409);
    });
  });

  test("120 s with no answer declines", async () => {
    await withServer({}, async (s) => {
      const runId = await startScenario(s);
      const sse = new Sse(s.port, `/api/runs/${runId}/events`);
      await sse.waitFor(hasType("approval_requested"));
      assert.equal(s.clock.fire(120_000), 1);
      await sse.ended;
      assert.equal(s.seen[0]?.decision, "decline");
      assert.ok(deskEvents(sse.frames()).some((e) => e.type === "approval_resolved" && e.decision === "decline"));
    });
  });

  test("409 for a second live run while one is active", async () => {
    await withServer({}, async (s) => {
      const runId = await startScenario(s);
      const sse = new Sse(s.port, `/api/runs/${runId}/events`);
      await sse.waitFor(hasType("approval_requested"));
      const second = await postJson(s.port, "/api/runs", { scenario: "stock-down" });
      assert.equal(second.status, 409);
      assert.equal(s.seen.length, 1);
      assert.equal((await postJson(s.port, `/api/runs/${runId}/approval`, { decision: "decline" })).status, 204);
      await sse.ended;
      assert.equal((await postJson(s.port, "/api/runs", { scenario: "stock-down" })).status, 201);
    });
  });

  test("429 past the run cap", async () => {
    await withServer({ recording: "demo-stock-down", maxRuns: 2 }, async (s) => {
      for (let i = 0; i < 2; i++) {
        const runId = await startScenario(s, "stock-down");
        await new Sse(s.port, `/api/runs/${runId}/events`).ended;
      }
      const third = await postJson(s.port, "/api/runs", { scenario: "stock-down" });
      assert.equal(third.status, 429);
      assert.equal(s.seen.length, 2);
    });
  });

  test("a pasted RFQ becomes PASTE-<n> with today's date", async () => {
    await withServer({ recording: "demo-stock-down" }, async (s) => {
      const r = await postJson(s.port, "/api/runs", { rfq: { subject: "Brackets", body: "Please quote 10 of QD-10001." },
        stockFault: "down" });
      assert.equal(r.status, 201);
      const { runId } = JSON.parse(r.text) as { runId: string };
      await new Sse(s.port, `/api/runs/${runId}/events`).ended;
      assert.deepEqual(s.seen[0]?.rfq, { id: "PASTE-1", customer: "Pasted RFQ", contactEmail: "paste@example.invalid",
        receivedOn: "2026-11-10", subject: "Brackets", body: "Please quote 10 of QD-10001." });
      assert.equal(s.seen[0]?.opts.stockFault, "down");
    });
  });

  test("cancel aborts through the signal, and no subscriber for 10 s aborts too", async () => {
    await withServer({}, async (s) => {
      const runId = await startScenario(s);
      const sse = new Sse(s.port, `/api/runs/${runId}/events`);
      await sse.waitFor(hasType("approval_requested"));
      assert.equal((await postJson(s.port, `/api/runs/${runId}/cancel`, {})).status, 204);
      await sse.ended;
      assert.equal(s.seen[0]?.opts.signal?.aborted, true);
      const finished = deskEvents(sse.frames()).at(-1);
      assert.ok(finished?.type === "run_finished" && finished.failure === "aborted");
    });
    await withServer({}, async (s) => {
      await startScenario(s);
      await new Promise((r) => setImmediate(r));
      assert.equal(s.seen[0]?.opts.signal?.aborted, false);
      assert.equal(s.clock.fire(10_000), 1);
      assert.equal(s.seen[0]?.opts.signal?.aborted, true);
    });
  });

  test("an open stream gets a keepalive comment every 15 s", async () => {
    await withServer({}, async (s) => {
      const runId = await startScenario(s);
      const sse = new Sse(s.port, `/api/runs/${runId}/events`);
      await sse.waitFor(hasType("approval_requested"));
      assert.ok(s.clock.fire(15_000) >= 1);
      await sse.waitFor(() => sse.raw.includes(": keepalive\n\n"));
      await postJson(s.port, `/api/runs/${runId}/approval`, { decision: "decline" });
      await sse.ended;
    });
  });

  test("closing the server while a run waits for approval ends the run without writing to a closed stream", async () => {
    // Ctrl+C in bin/web.ts calls close() while the page shows Approve and Decline. The gate then resolves
    // decline and the run yields its last events after every stream has ended. node:test fails the file on
    // the uncaught ERR_STREAM_WRITE_AFTER_END that a write to an ended response raises.
    const fake = recordedRunQuote("demo-clean");
    let finish: () => void = () => {};
    const drained = new Promise<void>((r) => (finish = r));
    const runQuote: RunQuote = async function* (rfq, opts) {
      try {
        yield* fake.runQuote(rfq, opts);
      } finally {
        finish();
      }
    };
    const clock = new FakeClock(10_000);
    const web = createWebServer({ runQuote, keySource: "environment", recordingsDir: PATHS.recordingsDir,
      staticDir: STATIC_DIR, clock });
    const port = await web.listen(0);
    const r = await postJson(port, "/api/runs", { scenario: "clean" });
    assert.equal(r.status, 201, r.text);
    const { runId } = JSON.parse(r.text) as { runId: string };
    const sse = new Sse(port, `/api/runs/${runId}/events`);
    await sse.waitFor(hasType("approval_requested"));
    await web.close();
    await drained;
    await new Promise((done) => setTimeout(done, 50));
    assert.equal(fake.seen[0]?.decision, "decline");
    assert.equal(fake.seen[0]?.opts.signal?.aborted, true);
    assert.ok(!hasType("approval_resolved")(sse.frames()));
  });
});

describe("web server: replays", () => {
  test("replay timing honors speed, and the framing matches a live run", async () => {
    for (const speed of [1, 4]) {
      await withServer({ keepaliveMs: 999_999 }, async (s) => {
        const sse = new Sse(s.port, `/api/replays/demo-stock-down/events?speed=${speed}`);
        await sse.ended;
        const recorded = eventsOf("demo-stock-down");
        const events = deskEvents(sse.frames());
        assert.equal(events.length, 21);
        assert.equal(events.at(-1)?.type, "run_finished");
        assert.ok(hasEnd(sse.frames()));
        const gaps = recorded.map((e, i) => (e.t - (i === 0 ? 0 : (recorded[i - 1]?.t ?? 0))) / speed);
        const delays = s.clock.delays.filter((d) => d !== 999_999);
        assert.deepEqual(delays, [...gaps, 0]);
      });
    }
  });

  test("speed must be 1, 2 or 4; the default is 1", async () => {
    await withServer({ keepaliveMs: 999_999 }, async (s) => {
      for (const q of ["3", "0", "2.0", "x", "8"]) {
        assert.equal((await call(s.port, "GET", `/api/replays/demo-clean/events?speed=${q}`)).status, 400, q);
      }
      const sse = new Sse(s.port, "/api/replays/demo-unknown-material/events");
      await sse.ended;
      assert.equal(deskEvents(sse.frames()).length, 13);
      const first = eventsOf("demo-unknown-material")[0];
      assert.equal(s.clock.delays.filter((d) => d !== 999_999)[0], first?.t);
    });
  });

  test("the replay name allowlist rejects anything else, including ..", async () => {
    await withServer({}, async (s) => {
      for (const name of ["..", "%2e%2e", "..%2Frecordings%2Fdemo-clean", "demo-clean.jsonl", "eval-k3", "DEMO-CLEAN",
        "demo-clean%00", "..%5Cpackage"]) {
        const r = await call(s.port, "GET", `/api/replays/${name}/events`);
        assert.equal(r.status, 404, name);
        assert.doesNotMatch(r.text, /^data:/m);
      }
    });
  });

  test("a replay resumes after Last-Event-ID", async () => {
    await withServer({ keepaliveMs: 999_999 }, async (s) => {
      const sse = new Sse(s.port, "/api/replays/demo-unknown-material/events?speed=4", { "Last-Event-ID": "9" });
      await sse.ended;
      assert.deepEqual(deskEvents(sse.frames()).map((e) => e.seq), [10, 11, 12]);
    });
  });
});

describe("web server: no key in any response", () => {
  test("a full run through the real createRunQuote never echoes the key marker", async () => {
    const outbox = mkdtempSync(join(tmpdir(), "qd-web-"));
    temps.push(outbox);
    const truth = new Map(loadTruth().map((t) => [t.rfqId, t]));
    const agent = scriptedAgent("ideal", truth);
    const runQuote = createRunQuote({ query: agent.query, finalizeQuote, approveAndSend, loadCatalog,
      env: { ANTHROPIC_API_KEY: KEY_MARKER, PATH: "" } });
    const clock = new FakeClock(10_000);
    const web = createWebServer({ runQuote, keySource: "environment", recordingsDir: PATHS.recordingsDir,
      staticDir: STATIC_DIR, clock, outboxDir: outbox });
    const port = await web.listen(0);
    try {
      await call(port, "GET", "/api/meta");
      const r = await postJson(port, "/api/runs", { scenario: "clean" });
      assert.equal(r.status, 201, r.text);
      const { runId } = JSON.parse(r.text) as { runId: string };
      const sse = new Sse(port, `/api/runs/${runId}/events`);
      await sse.waitFor((f) => hasType("approval_requested")(f) || hasEnd(f), 20_000);
      assert.ok(hasType("approval_requested")(sse.frames()), sse.raw.slice(-1500));
      assert.equal((await postJson(port, `/api/runs/${runId}/approval`, { decision: "approve" })).status, 204);
      await sse.ended;
      const events = deskEvents(sse.frames());
      assert.ok(events.some((e) => e.type === "delivery" && e.outcome === "sent"));
      assert.ok(existsSync(join(outbox, "RFQ-001.json")));
      assert.equal(agent.seen.length, 1);
    } finally {
      await web.close();
    }
    assert.ok(bodies.length > 20);
    for (const b of bodies) assert.ok(!b.includes(KEY_MARKER), "a response carried the key marker");
  });
});
