import { rowTime } from "../state.ts";
import type { ActivityRow, ViewState } from "../state.ts";

export type ActivityPaneProps = { view: ViewState; showDrafting: boolean; draftingSeconds: number };

const STATUS_WORDS: Record<ActivityRow["status"], string> = { pending: "pending", ok: "ok", error: "error" };

function Row({ r }: { r: ActivityRow }) {
  const warn = r.code === "STOCK_UNAVAILABLE";
  const cls = r.status === "error" ? (warn ? "row row-warn" : "row row-error") : `row row-${r.status}`;
  return (
    <li className={cls}>
      <span className="row-tool">{r.tool}</span>
      <span className="row-status">{STATUS_WORDS[r.status]}</span>
      <span className="row-ms num">{rowTime(r)}</span>
      <span className="row-summary">
        {r.code !== null ? <span className="row-code">{r.code} </span> : null}
        {r.summary}
      </span>
    </li>
  );
}

export function ActivityPane({ view, showDrafting, draftingSeconds }: ActivityPaneProps) {
  const calls = view.groups.reduce((n, g) => n + g.rows.length, 0);
  return (
    <section className="pane pane-activity" aria-labelledby="activity-h">
      <h2 id="activity-h">Activity {calls > 0 ? <span className="muted">({calls} tool calls)</span> : null}</h2>
      <div aria-live="polite" className="activity">
        {view.phase === "idle" ? (
          <p className="muted">Pick a scenario, then Run live or Play recording. Tool calls show here as they happen.</p>
        ) : null}
        {view.phase === "starting" && view.groups.length === 0 ? (
          <p className="muted">{view.run === null ? "Starting the run" : `Agent session starting for ${view.run.rfqId}`}</p>
        ) : null}
        {view.groups.map((g) => (
          <div className="group" key={g.partNumber ?? "(none)"}>
            <h3>{g.partNumber ?? "Calls that named no part"}</h3>
            <ul className="rows">
              {g.rows.map((r) => <Row key={r.toolUseId} r={r} />)}
            </ul>
          </div>
        ))}
        {view.notices.length > 0 ? (
          <div className="group">
            <h3>Guard and refusals</h3>
            <ul className="rows">
              {view.notices.map((n, i) => (
                <li key={i} className="row row-error">
                  <span className="row-tool">{n.kind === "guard" ? n.tool : "model"}</span>
                  <span className="row-status">{n.kind === "guard" ? `denied (${n.by})` : "refused"}</span>
                  <span className="row-ms" />
                  <span className="row-summary">{n.text}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {view.phase === "drafting" && showDrafting ? (
          <p className="drafting">Model is writing the draft <span className="num" aria-hidden="true">{draftingSeconds} s</span></p>
        ) : null}
      </div>
    </section>
  );
}
