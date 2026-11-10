import { stockServiceWords } from "../format.ts";

export type TopStripProps = {
  notice: string;
  modeChip: string;
  modeKind: "live" | "replay" | "off";
  model: string;
  effort: string;
  keySource: string;
  stockFault: string;
};

export function TopStrip(p: TopStripProps) {
  const stock = stockServiceWords(p.stockFault);
  return (
    <header className="top">
      <div className="top-title">
        <h1>Quote Desk</h1>
        <p className="notice">All data is synthetic. {p.notice}</p>
      </div>
      <ul className="chips" aria-label="Run settings">
        <li className={`chip chip-${p.modeKind}`}>{p.modeChip}</li>
        <li className="chip">{p.model}, effort {p.effort}</li>
        <li className="chip">API key: {p.keySource}</li>
        <li className={`chip ${p.stockFault === "ok" ? "" : "chip-warn"}`}>Stock service: {stock}</li>
      </ul>
    </header>
  );
}
