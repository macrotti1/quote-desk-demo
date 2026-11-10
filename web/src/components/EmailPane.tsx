import type { ScenarioInfo, ScenarioName } from "../../../src/web/protocol.ts";

export type EmailPaneProps = {
  scenarios: ScenarioInfo[];
  selected: ScenarioName | null;
  onSelect: (name: ScenarioName) => void;
  customer: string;
  contactEmail: string;
  subject: string;
  body: string;
  onSubject: (s: string) => void;
  onBody: (s: string) => void;
  readOnly: boolean;
  busy: boolean; // a run is streaming, so the scenario buttons wait
  edited: boolean;
  subjectMax: number;
  bodyMax: number;
  liveBlocked: string | null; // why Run live is disabled, or null
  playBlocked: string | null; // why Play recording is disabled, or null
  onRunLive: () => void;
  onPlay: () => void;
  speed: number;
  onSpeed: (n: number) => void;
  canCancel: boolean;
  onCancel: () => void;
  startError: string | null;
};

export function EmailPane(p: EmailPaneProps) {
  return (
    <section className="pane pane-email" aria-labelledby="email-h">
      <h2 id="email-h">Request for quote</h2>
      <div className="scenarios" role="group" aria-label="Scenarios">
        {p.scenarios.map((s) => (
          <button key={s.name} type="button" className="scenario" aria-pressed={p.selected === s.name}
            disabled={p.busy} onClick={() => p.onSelect(s.name)}>
            {s.label}
          </button>
        ))}
      </div>
      <p className="from">
        From: {p.edited ? "Pasted RFQ" : p.customer}
        {!p.edited && p.contactEmail !== "" ? <span className="muted"> &lt;{p.contactEmail}&gt;</span> : null}
        {p.edited ? <span className="muted"> (edited, so it runs as a pasted RFQ)</span> : null}
      </p>
      <label className="field">
        <span>Subject</span>
        <input type="text" value={p.subject} maxLength={p.subjectMax} readOnly={p.readOnly}
          onChange={(e) => p.onSubject(e.target.value)} />
      </label>
      <label className="field field-grow">
        <span>Email</span>
        <textarea value={p.body} maxLength={p.bodyMax} readOnly={p.readOnly} rows={14}
          onChange={(e) => p.onBody(e.target.value)} />
      </label>
      <div className="actions">
        <div className="action">
          <button type="button" className="primary" disabled={p.liveBlocked !== null} onClick={p.onRunLive}
            aria-describedby={p.liveBlocked !== null ? "live-why" : undefined}>
            Run live
          </button>
          {p.liveBlocked !== null ? <span id="live-why" className="why">{p.liveBlocked}</span> : null}
        </div>
        <div className="action">
          <button type="button" disabled={p.playBlocked !== null} onClick={p.onPlay}
            aria-describedby={p.playBlocked !== null ? "play-why" : undefined}>
            Play recording
          </button>
          <label className="speed">
            <span>Speed</span>
            <select value={p.speed} disabled={p.playBlocked !== null} onChange={(e) => p.onSpeed(Number(e.target.value))}>
              <option value={1}>1x</option>
              <option value={2}>2x</option>
              <option value={4}>4x</option>
            </select>
          </label>
          {p.playBlocked !== null ? <span id="play-why" className="why">{p.playBlocked}</span> : null}
        </div>
        {p.canCancel ? (
          <div className="action">
            <button type="button" onClick={p.onCancel}>Stop the run</button>
          </div>
        ) : null}
      </div>
      {p.startError !== null ? <p className="error-line" role="alert">{p.startError}</p> : null}
    </section>
  );
}
