import type { Quote, QuoteStatus } from "../../../src/contracts.ts";
import { dollars, leadTime, num, seconds, stockWords, tolerance } from "../format.ts";
import type { ViewState } from "../state.ts";

export type QuotePaneProps = {
  view: ViewState;
  live: boolean; // a live run, so the gate buttons can answer
  approvalSent: boolean;
  onDecide: (d: "approve" | "decline") => void;
  failedReplay: (() => void) | null; // plays the recorded run of the same scenario
  streamError: string | null;
};

const BANNERS: Record<QuoteStatus, { text: string; cls: string }> = {
  ready: { text: "Ready", cls: "banner-ok" },
  pending_stock_check: { text: "Held: pending stock check", cls: "banner-warn" },
  needs_clarification: { text: "Held: needs clarification", cls: "banner-warn" },
};

function LinesTable({ q }: { q: Quote }) {
  return (
    <div className="table-wrap">
      <table className="lines">
        <thead>
          <tr>
            <th scope="col">Line</th>
            <th scope="col">Part</th>
            <th scope="col">Material</th>
            <th scope="col" className="num">Qty</th>
            <th scope="col">Tolerance</th>
            <th scope="col" className="num">Unit price</th>
            <th scope="col" className="num">Extended</th>
            <th scope="col">Stock</th>
            <th scope="col">Lead time</th>
          </tr>
        </thead>
        <tbody>
          {q.lines.map((l) => (
            <tr key={l.lineRef}>
              <td>{l.lineRef}</td>
              <td>{l.partNumber}</td>
              <td>
                {l.materialAsRequested}
                {q.openQuestions.some((oq) => oq.lineRef === l.lineRef && oq.field === "material")
                  ? <span className="tag-warn"> not in catalog</span>
                  : null}
              </td>
              <td className="num">{l.quantity === null ? "missing" : num(l.quantity)}</td>
              <td>{tolerance(l.toleranceIn)}</td>
              <td className="num">{dollars(l.unitPriceUsd)}</td>
              <td className="num">{dollars(l.extendedUsd)}</td>
              <td className={l.stock === "unverified" ? "warn-text" : ""}>{stockWords(l.stock)}</td>
              <td>{leadTime(l.leadTimeDays)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Gate(p: QuotePaneProps) {
  const { view } = p;
  const d = view.delivery;
  if (d !== null) {
    switch (d.outcome) {
      case "sent":
        return <p className="gate gate-ok">Sent: out/outbox/{d.file ?? "?"}</p>;
      case "declined":
        return <p className="gate">Declined. Nothing was sent.</p>;
      case "not_ready":
        return (
          <div className="gate gate-held">
            <p>The gate held this quote. Nothing was sent.</p>
            {d.reason !== null ? <p className="muted">Reason: {d.reason}</p> : null}
          </div>
        );
      case "not_attempted":
        return <p className="gate">Not offered for approval. Nothing was sent.</p>;
    }
  }
  if (view.approval === "requested") {
    if (!p.live) return <p className="gate">Approval requested (recorded run).</p>;
    const file = view.quote === null ? "" : `out/outbox/${view.quote.rfqId}.json`;
    return (
      <div className="gate gate-ask">
        <p>Approve writes {file}. Decline sends nothing.</p>
        <div className="gate-buttons">
          <button type="button" className="primary" disabled={p.approvalSent} onClick={() => p.onDecide("approve")}>
            Approve
          </button>
          <button type="button" disabled={p.approvalSent} onClick={() => p.onDecide("decline")}>Decline</button>
        </div>
      </div>
    );
  }
  return null;
}

export function QuotePane(p: QuotePaneProps) {
  const { view } = p;
  const q = view.quote;
  const f = view.finish;
  return (
    <section className="pane pane-quote" aria-labelledby="quote-h">
      <h2 id="quote-h">Quote {q !== null ? <span className="muted">{q.rfqId}, {q.customer}</span> : null}</h2>
      {f !== null && !f.ok ? (
        <div className="failed" role="alert">
          <p><strong>Run failed: {f.failure ?? "unknown"}</strong></p>
          {f.detail !== null && f.detail !== "" ? <p>{f.detail}</p> : null}
          {p.failedReplay !== null ? (
            <button type="button" onClick={p.failedReplay}>Play the recorded run instead</button>
          ) : null}
        </div>
      ) : null}
      {p.streamError !== null && f === null ? <p className="error-line" role="alert">{p.streamError}</p> : null}
      {q === null ? (
        <p className="muted">{view.phase === "idle" ? "The quote shows here when the agent finishes." : "No quote yet."}</p>
      ) : (
        <>
          <p className={`banner ${BANNERS[q.status].cls}`}>{BANNERS[q.status].text}</p>
          <LinesTable q={q} />
          <p className="total num">
            {q.totalUsd === null ? "Total: not priced while a line is blocked" : `Total ${dollars(q.totalUsd)}`}
            <span className="muted">, margin {num(q.marginPct)}%</span>
          </p>
          {q.openQuestions.length > 0 ? (
            <div className="block">
              <h3>Questions for the customer</h3>
              <ul>
                {q.openQuestions.map((oq, i) => (
                  <li key={i}>
                    <span className="muted">
                      {oq.lineRef === null ? "General" : `Line ${oq.lineRef}`}, {oq.field}{oq.blocking ? ", blocking" : ""}:
                    </span>{" "}
                    {oq.question}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {q.assumptions.length > 0 ? (
            <div className="block">
              <h3>Assumptions</h3>
              <ul>
                {q.assumptions.map((a, i) => <li key={i}>{a}</li>)}
              </ul>
            </div>
          ) : null}
          {q.consistencyErrors.length > 0 ? (
            <div className="block block-error">
              <h3>Consistency errors</h3>
              <ul>
                {q.consistencyErrors.map((c, i) => <li key={i}>{c}</li>)}
              </ul>
            </div>
          ) : null}
        </>
      )}
      <Gate {...p} />
      {f !== null ? (
        <p className="footer muted">
          Cost {f.costUsd === null ? "unreported" : `$${f.costUsd.toFixed(2)} (SDK estimate)`}, {f.turns === null ? "turns unreported" : `${f.turns} turns`},{" "}
          {seconds(f.durationMs)}{f.modelsUsed.length > 0 ? `, models ${f.modelsUsed.join(", ")}` : ""}
        </p>
      ) : null}
    </section>
  );
}
