import { useCallback, useEffect, useRef, useState } from "react";
import type { MetaResponse, ReplayInfo, ScenarioName } from "../../src/web/protocol.ts";
import { cancelRun, getMeta, liveEventsUrl, openEvents, replayEventsUrl, sendApproval, startRun } from "./api.ts";
import type { StreamHandle } from "./api.ts";
import { ActivityPane } from "./components/ActivityPane.tsx";
import { EmailPane } from "./components/EmailPane.tsx";
import { QuotePane } from "./components/QuotePane.tsx";
import { TopStrip } from "./components/TopStrip.tsx";
import { isoDate } from "./format.ts";
import { initialState, reduce, startingState } from "./state.ts";
import type { ViewState } from "./state.ts";

type Mode = { kind: "none" } | { kind: "live"; runId: string | null; pasted: boolean }
  | { kind: "replay"; replay: ReplayInfo; speed: number };

// The drafting line waits before it shows (scaled by replay speed), so it doesn't flicker between tool calls.
// In the three demo recordings every gap between a result and the next call is under 0.9 s. In the 117 eval
// trials, 11 of 644 such gaps ran past 1.2 s (the longest 4.3 s), while the final draft took 3.7 to 9.8 s,
// so no wait separates the two: about 1 live run in 10 shows the line once before another tool call.
const DRAFTING_SHOW_AFTER_MS = 1200;
const SUBJECT_MAX = 200;

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function App() {
  const [meta, setMeta] = useState<MetaResponse | null>(null);
  const [metaError, setMetaError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ScenarioName | null>(null);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [mode, setMode] = useState<Mode>({ kind: "none" });
  const [view, setView] = useState<ViewState>(initialState);
  const [speed, setSpeed] = useState(2);
  const [streaming, setStreaming] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [approvalSent, setApprovalSent] = useState(false);
  const [draftingMs, setDraftingMs] = useState(0);
  const streamRef = useRef<StreamHandle | null>(null);
  const finishedRef = useRef(false);

  const scenario = meta?.scenarios.find((s) => s.name === selected);
  const replayFor = (name: ScenarioName | null): ReplayInfo | undefined =>
    meta?.replays.find((r) => r.scenario === name);

  const fill = useCallback((m: MetaResponse, name: ScenarioName) => {
    const s = m.scenarios.find((x) => x.name === name);
    setSelected(name);
    setSubject(s?.rfq.subject ?? "");
    setBody(s?.rfq.body ?? "");
  }, []);

  useEffect(() => {
    let alive = true;
    getMeta().then((m) => {
      if (!alive) return;
      setMeta(m);
      const first = m.scenarios[0];
      if (first !== undefined) fill(m, first.name);
    }, (err: unknown) => {
      if (alive) setMetaError(message(err));
    });
    return () => {
      alive = false;
      streamRef.current?.close();
    };
  }, [fill]);

  // The drafting counter: wall time since the run entered drafting.
  useEffect(() => {
    setDraftingMs(0);
    if (view.phase !== "drafting") return;
    const started = performance.now();
    const timer = window.setInterval(() => setDraftingMs(performance.now() - started), 200);
    return () => window.clearInterval(timer);
  }, [view.phase, view.draftingSince]);

  const closeStream = (): void => {
    streamRef.current?.close();
    streamRef.current = null;
  };

  const listen = (url: string): void => {
    finishedRef.current = false;
    streamRef.current = openEvents(url, {
      event: (e) => {
        if (e.type === "run_finished") finishedRef.current = true;
        setView((v) => reduce(v, e));
      },
      end: () => {
        streamRef.current = null;
        setStreaming(false);
        if (!finishedRef.current) setStreamError("The stream ended before the run finished.");
      },
      error: (text) => {
        streamRef.current = null;
        setStreaming(false);
        setStreamError(text);
      },
    });
  };

  const reset = (): void => {
    closeStream();
    setStartError(null);
    setStreamError(null);
    setApprovalSent(false);
    setView(startingState);
    setStreaming(true);
  };

  const edited = scenario !== undefined && (subject !== scenario.rfq.subject || body !== scenario.rfq.body);
  const busy = streaming;

  const runLive = async (): Promise<void> => {
    if (scenario === undefined) return;
    reset();
    const pasted = edited;
    setMode({ kind: "live", runId: null, pasted });
    try {
      const runId = await startRun(pasted
        ? { rfq: { subject, body }, stockFault: scenario.stockFault }
        : { scenario: scenario.name });
      setMode({ kind: "live", runId, pasted });
      listen(liveEventsUrl(runId));
    } catch (err) {
      setStartError(message(err));
      setStreaming(false);
      setView(initialState);
      setMode({ kind: "none" });
    }
  };

  const play = (name: ScenarioName | null): void => {
    const replay = replayFor(name);
    if (replay === undefined || meta === null || name === null) return;
    reset();
    fill(meta, name);
    setMode({ kind: "replay", replay, speed });
    listen(replayEventsUrl(replay.name, speed));
  };

  const decide = (d: "approve" | "decline"): void => {
    if (mode.kind !== "live" || mode.runId === null) return;
    setApprovalSent(true);
    sendApproval(mode.runId, d).catch((err: unknown) => setStreamError(message(err)));
  };

  const cancel = (): void => {
    if (mode.kind !== "live" || mode.runId === null) return;
    cancelRun(mode.runId).catch((err: unknown) => setStreamError(message(err)));
  };

  let liveBlocked: string | null = null;
  if (meta === null) liveBlocked = "Loading";
  else if (!meta.live) {
    liveBlocked = meta.keySource === "unset"
      ? "No API key, so live runs are off. Recorded runs still play."
      : "Live runs are off (--no-live). Recorded runs still play.";
  } else if (busy) liveBlocked = "A run is going.";
  else if (scenario === undefined) liveBlocked = "Pick a scenario.";
  else if (subject.trim() === "" || body.trim() === "") liveBlocked = "The subject and the email can't be empty.";

  let playBlocked: string | null = null;
  if (meta === null) playBlocked = "Loading";
  else if (busy) playBlocked = "A run is going.";
  else if (replayFor(selected) === undefined) playBlocked = "No recording for this scenario.";
  else if (edited) playBlocked = "A recording plays the scenario's own email. Pick the scenario again to restore it.";

  const replayMode = mode.kind === "replay";
  const showDrafting = draftingMs >= DRAFTING_SHOW_AFTER_MS / (replayMode ? mode.speed : 1);
  const draftingSeconds = Math.floor((draftingMs * (replayMode ? mode.speed : 1)) / 1000);

  let modeChip: string;
  let modeKind: "live" | "replay" | "off";
  if (mode.kind === "replay") {
    modeChip = `Replay ${mode.speed}x, recorded ${isoDate(mode.replay.recordedAt)}`;
    modeKind = "replay";
  } else if (mode.kind === "live" || meta?.live === true) {
    modeChip = "Live";
    modeKind = "live";
  } else {
    modeChip = "Replays only";
    modeKind = "off";
  }
  const stockFault = view.run?.stockFault
    ?? (mode.kind === "replay" ? mode.replay.stockFault : undefined)
    ?? scenario?.stockFault ?? "ok";

  // A pasted RFQ has no recorded run of its own, so its failure panel offers none.
  const failedReplay = mode.kind === "live" && !mode.pasted && view.finish !== null && !view.finish.ok
    && replayFor(selected) !== undefined
    ? () => play(selected)
    : null;

  if (metaError !== null) {
    return (
      <main className="page">
        <p className="error-line" role="alert">The page could not reach its server: {metaError}</p>
      </main>
    );
  }

  return (
    <main className="page">
      <TopStrip notice={meta?.notice ?? ""} modeChip={modeChip} modeKind={modeKind}
        model={view.run?.model ?? meta?.model ?? ""} effort={view.run?.effort ?? meta?.effort ?? ""}
        keySource={meta?.keySource ?? "unknown"} stockFault={stockFault} />
      <div className="columns">
        <EmailPane scenarios={meta?.scenarios ?? []} selected={selected}
          onSelect={(name) => {
            if (meta === null) return;
            fill(meta, name);
            setMode({ kind: "none" });
            setView(initialState);
            setStartError(null);
            setStreamError(null);
          }}
          customer={scenario?.rfq.customer ?? ""} contactEmail={scenario?.rfq.contactEmail ?? ""}
          subject={subject} body={body} onSubject={setSubject} onBody={setBody}
          readOnly={busy || replayMode} busy={busy} edited={edited && !replayMode}
          subjectMax={SUBJECT_MAX} bodyMax={meta?.limits.rfqMaxChars ?? 8000}
          liveBlocked={liveBlocked} playBlocked={playBlocked}
          onRunLive={() => void runLive()} onPlay={() => play(selected)}
          speed={speed} onSpeed={setSpeed}
          canCancel={busy && mode.kind === "live" && mode.runId !== null} onCancel={cancel}
          startError={startError} />
        <ActivityPane view={view} showDrafting={showDrafting} draftingSeconds={draftingSeconds} />
        <QuotePane view={view} live={mode.kind === "live"} approvalSent={approvalSent} onDecide={decide}
          failedReplay={failedReplay} streamError={streamError} />
      </div>
    </main>
  );
}
