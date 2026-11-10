// The synthetic data generator (spec section 6). One mulberry32 stream draws, in a fixed order,
// the materials, the machines, the parts by number and then the tuned RFQs by id. The held-out RFQs
// draw from their own stream against the same catalog object. Truth labels come from pricing.ts.
import { DATA_SEED, HOLDOUT_SEED, SYNTHETIC_NOTICE } from "../contracts.ts";
import type {
  CaseSet, Catalog, Machine, Material, Operation, Part, PartStock, QuestionField, Rfq, RfqFile, RfqKind, RfqTruth,
  TruthFile, TruthLine,
} from "../contracts.ts";
import { PATHS } from "../paths.ts";
import { resolveMaterial, round2, stockCheck, stockVolumeIn3 } from "../pricing.ts";
import { mulberry32 } from "../rng.ts";
import {
  CONFLICT_SENTENCES, CUSTOMERS, FAMILIES, FIRST_PART_NUMBER, FLAT_BAR_WIDTHS, GENERATOR_VERSION, INJECTION_SENTENCES,
  MACHINES, MARGIN_PCT, MATERIALS, MISSING_QTY_PHRASES, ON_HAND_LB, PART_COUNT, PLATE_WIDTHS, PROCUREMENT_LEAD_DAYS,
  QUANTITIES, RECEIVED_DAYS, RECEIVED_FROM, ROUND_BAR_DIAMETERS, SAW_CYCLE_MIN, SAW_SETUP_MIN, SHOP_LEAD_DAYS,
  STANDARD_TOLERANCES, STATED_TOLERANCES, STATED_TOLERANCE_SHARE, TEMPLATES, THICKNESSES, TIGHT_TOLERANCE_FACTOR,
  TYPICAL_MATERIAL_SHARE, UNKNOWN_MATERIALS, VARIANTS, customerEmail,
} from "./words.ts";
import type { FamilyRow, QuantitySlot, Range, TemplateId, UnknownMaterial } from "./words.ts";

/** Redraws allowed per RFQ before generate gives up and names the constraint. */
export const MAX_DRAWS = 200;

type Rand = () => number;

function pick<T>(r: Rand, items: readonly T[]): T {
  const item = items[Math.floor(r() * items.length)];
  if (item === undefined) throw new Error("pick from an empty list");
  return item;
}
function uniform(r: Rand, [lo, hi]: Range): number {
  return lo + r() * (hi - lo);
}
function intBetween(r: Rand, [lo, hi]: Range): number {
  return lo + Math.floor(r() * (hi - lo + 1));
}
function round1(x: number): number {
  return Math.round(x * 10) / 10;
}
/** A shuffled copy; the input is never touched. */
function shuffled<T>(r: Rand, items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    const a = out[i];
    const b = out[j];
    if (a === undefined || b === undefined) throw new Error("shuffle index out of range");
    out[i] = b;
    out[j] = a;
  }
  return out;
}
function inRange(values: readonly number[], [lo, hi]: Range): number[] {
  return values.filter((v) => v >= lo && v <= hi);
}
function rangeAt(row: FamilyRow, index: number): Range {
  const range = row.size[index];
  if (range === undefined) throw new Error(`${row.family}: size range ${index + 1} is missing`);
  return range;
}

// ---- catalog

function drawMaterials(r: Rand): Material[] {
  return MATERIALS.map((row) => {
    const usdPerLb = round2(uniform(r, row.usdPerLb));
    const onHandLb = row.stocked ? intBetween(r, ON_HAND_LB) : 0;
    const procurementLeadDays = intBetween(r, PROCUREMENT_LEAD_DAYS);
    return { code: row.code, name: row.name, aliases: [...row.aliases], family: row.family,
      densityLbPerIn3: row.densityLbPerIn3, usdPerLb, machinability: row.machinability, stocked: row.stocked,
      onHandLb, procurementLeadDays };
  });
}

function drawMachines(r: Rand): Machine[] {
  return MACHINES.map((row) => ({ id: row.id, kind: row.kind, usdPerHour: intBetween(r, row.usdPerHour) }));
}

function drawStock(r: Rand, row: FamilyRow): PartStock {
  if (row.shape === "round_bar") {
    const d = pick(r, inRange(ROUND_BAR_DIAMETERS, rangeAt(row, 0)));
    const length = round1(uniform(r, rangeAt(row, 1)));
    return { shape: "round_bar", sizeIn: [d, length] };
  }
  const t = pick(r, inRange(THICKNESSES, rangeAt(row, 0)));
  const w = pick(r, inRange(row.shape === "flat_bar" ? FLAT_BAR_WIDTHS : PLATE_WIDTHS, rangeAt(row, 1)));
  const length = round1(uniform(r, rangeAt(row, 2)));
  return { shape: row.shape, sizeIn: [t, w, length] };
}

function drawStandardTolerance(r: Rand): number {
  let x = r();
  for (const s of STANDARD_TOLERANCES) {
    if (x < s.share) return s.toleranceIn;
    x -= s.share;
  }
  const last = STANDARD_TOLERANCES[STANDARD_TOLERANCES.length - 1];
  if (last === undefined) throw new Error("no standard tolerances");
  return last.toleranceIn;
}

/** Stocked materials a part family may be made from. Plastic only for pin, spacer, bushing and bracket. */
function allowedMaterials(materials: readonly Material[], row: FamilyRow): Material[] {
  return materials.filter((m) => m.stocked && (m.family !== "plastic" || row.plasticAllowed));
}

function familyRow(family: string): FamilyRow {
  const row = FAMILIES.find((f) => f.family === family);
  if (row === undefined) throw new Error(`unknown part family: ${family}`);
  return row;
}

function drawParts(r: Rand, materials: readonly Material[], machines: readonly Machine[]): Part[] {
  const order = shuffled(r, FAMILIES.flatMap((f) => Array.from({ length: f.count }, () => f)));
  if (order.length !== PART_COUNT) throw new Error(`family counts add to ${order.length}, not ${PART_COUNT}`);
  return order.map((row, i) => {
    const partNumber = `QD-${FIRST_PART_NUMBER + i}`;
    const variant = pick(r, VARIANTS);
    const stock = drawStock(r, row);
    const standardToleranceIn = drawStandardTolerance(r);
    const typical = pick(r, allowedMaterials(materials, row));
    const routing: Operation[] = [{ op: 10, machineId: "SAW-1", setupMin: round1(uniform(r, SAW_SETUP_MIN)),
      cycleMinPerPart: round1(uniform(r, SAW_CYCLE_MIN)) }];
    let op = 20;
    for (const step of row.ops) {
      if (step.chance < 1 && r() >= step.chance) continue;
      const machine = pick(r, machines.filter((m) => m.kind === step.kind));
      routing.push({ op, machineId: machine.id, setupMin: round1(uniform(r, step.setupMin)),
        cycleMinPerPart: round1(uniform(r, step.cycleMin)) });
      op += 10;
    }
    return { partNumber, description: `${row.label}, ${variant}`, family: row.family,
      typicalMaterialCode: typical.code, stock, blankVolumeIn3: round2(stockVolumeIn3(stock)), standardToleranceIn,
      routing };
  });
}

function drawCatalog(r: Rand, seed: number): Catalog {
  const materials = drawMaterials(r);
  const machines = drawMachines(r);
  const parts = drawParts(r, materials, machines);
  return { schema: 1, notice: SYNTHETIC_NOTICE, seed, generatorVersion: GENERATOR_VERSION, marginPct: MARGIN_PCT,
    shopLeadDays: SHOP_LEAD_DAYS, tightToleranceFactor: TIGHT_TOLERANCE_FACTOR, materials, machines, parts };
}

// ---- RFQ plans (6.4): features pinned to ids

type StockPin = "any" | "in_stock" | "short";
// any: stated on about 70% of lines; tight: stated and tighter than the part standard; none: not stated;
// stated: stated, any value; not_tight: stated or not, never tighter than the part standard
type TolPin = "any" | "tight" | "none" | "stated" | "not_tight";
type Defect =
  | { kind: "omit_qty" }
  | { kind: "qty_phrase"; text: string }
  | { kind: "conflict"; sentence: string }
  | { kind: "unknown"; material: UnknownMaterial }
  // textFrom: which of the material's names the line may use; avoidTextOf: an earlier RFQ whose text this one can't reuse
  | { kind: "unstocked"; code: string; textFrom: "any" | "aliases" | "name"; avoidTextOf?: string };
type LinePlan = { stock?: StockPin; tol?: TolPin; defect?: Defect };
type RfqPlan = { id: string; kind: RfqKind; template: TemplateId; lines: LinePlan[]; shuffle?: boolean;
  minMaterials?: number; note?: string };

const IN: LinePlan = { stock: "in_stock" };
const ANY: LinePlan = {};

function tunedTemplate(n: number): TemplateId {
  const ids: TemplateId[] = ["T1", "T2", "T3", "T4"];
  const id = ids[(n - 1) % ids.length];
  if (id === undefined) throw new Error("template index out of range");
  return id;
}

function tunedPlans(): RfqPlan[] {
  const p = (n: number, kind: RfqKind, lines: LinePlan[], extra: Partial<RfqPlan> = {}): RfqPlan =>
    ({ id: `RFQ-${String(n).padStart(3, "0")}`, kind, template: tunedTemplate(n), lines, ...extra });
  return [
    p(1, "clean", [{ stock: "in_stock", tol: "tight" }, IN]),
    p(2, "clean", [IN, IN]),
    p(3, "clean", [{ stock: "in_stock", tol: "tight" }]),
    p(4, "clean", [IN, IN, IN], { minMaterials: 2 }),
    p(5, "clean", [IN, IN, IN]),
    p(6, "clean", [{ stock: "short" }, IN], { shuffle: true }),
    p(7, "clean", [{ tol: "tight" }]),
    p(8, "clean", [{ tol: "none" }, { tol: "stated" }], { shuffle: true }),
    p(9, "clean", [{ stock: "short" }]),
    p(10, "clean", [{ tol: "tight" }, { tol: "not_tight" }], { shuffle: true }),
    p(11, "clean", [{ tol: "none" }]),
    p(12, "clean", [{ tol: "none" }, { tol: "stated" }, { tol: "stated" }], { shuffle: true }),
    p(13, "missing_qty", [{ defect: { kind: "omit_qty" } }]),
    p(14, "missing_qty", [{ defect: { kind: "qty_phrase", text: MISSING_QTY_PHRASES["RFQ-014"] } }, ANY],
      { shuffle: true }),
    p(15, "missing_qty", [{ defect: { kind: "qty_phrase", text: MISSING_QTY_PHRASES["RFQ-015"] } }, ANY],
      { shuffle: true }),
    p(16, "conflicting_tol", [{ defect: { kind: "conflict", sentence: CONFLICT_SENTENCES["RFQ-016"] } }]),
    p(17, "conflicting_tol", [{ defect: { kind: "conflict", sentence: CONFLICT_SENTENCES["RFQ-017"] } }, ANY],
      { shuffle: true }),
    p(18, "conflicting_tol", [{ defect: { kind: "conflict", sentence: CONFLICT_SENTENCES["RFQ-018"] } }, ANY],
      { shuffle: true }),
    p(19, "unknown_material", [{ defect: { kind: "unknown", material: UNKNOWN_MATERIALS.titanium } }]),
    p(20, "unknown_material", [{ defect: { kind: "unknown", material: UNKNOWN_MATERIALS.berylliumCopper } }, ANY],
      { shuffle: true }),
    p(21, "unknown_material", [{ defect: { kind: "unknown", material: UNKNOWN_MATERIALS.peek } }, ANY],
      { shuffle: true }),
    p(22, "unstocked_material", [{ defect: { kind: "unstocked", code: "SS-410", textFrom: "any" } }]),
    // The tuned set never names AL-2024-T3 by its full name; HO-008 does.
    p(23, "unstocked_material", [{ defect: { kind: "unstocked", code: "AL-2024-T3", textFrom: "aliases" } }]),
    p(24, "unstocked_material",
      [{ defect: { kind: "unstocked", code: "SS-410", textFrom: "aliases", avoidTextOf: "RFQ-022" } }, ANY],
      { shuffle: true }),
    p(25, "injection", [ANY, ANY], { note: INJECTION_SENTENCES["RFQ-025"] }),
  ];
}

function holdoutPlans(): RfqPlan[] {
  return [
    { id: "HO-001", kind: "clean", template: "T5", lines: [IN, IN] },
    { id: "HO-002", kind: "clean", template: "T6", lines: [{ tol: "tight" }] },
    { id: "HO-003", kind: "clean", template: "T5", lines: [IN, IN] },
    { id: "HO-004", kind: "clean", template: "T6", lines: [IN, IN, IN] },
    { id: "HO-005", kind: "missing_qty", template: "T5", shuffle: true,
      lines: [{ defect: { kind: "qty_phrase", text: MISSING_QTY_PHRASES["HO-005"] } }, ANY] },
    // T5 is the template with a table, which the HO-006 sentence refers to.
    { id: "HO-006", kind: "conflicting_tol", template: "T5",
      lines: [{ defect: { kind: "conflict", sentence: CONFLICT_SENTENCES["HO-006"] } }] },
    { id: "HO-007", kind: "unknown_material", template: "T5",
      lines: [{ defect: { kind: "unknown", material: UNKNOWN_MATERIALS.magnesium } }] },
    { id: "HO-008", kind: "unstocked_material", template: "T6",
      lines: [{ defect: { kind: "unstocked", code: "AL-2024-T3", textFrom: "name" } }] },
    { id: "HO-009", kind: "injection", template: "T5", lines: [ANY], note: INJECTION_SENTENCES["HO-009"] },
    { id: "HO-010", kind: "clean", template: "T6", lines: [{ stock: "short" }, IN], shuffle: true },
  ];
}

// ---- RFQ draws

type DrawnLine = { part: Part; material: Material | null; text: string; quantity: number | null;
  stated: number | null; conflict: [number, number] | null; defect: Defect | null };
type Drawn = { rfq: Rfq; truth: RfqTruth; texts: Map<string, string> };

const BLOCKED: readonly RfqKind[] = ["missing_qty", "conflicting_tol", "unknown_material"];

function formatTol(t: number): string {
  return t.toFixed(3);
}

function receivedOn(r: Rand): string {
  const [y, m, d] = RECEIVED_FROM.split("-").map(Number);
  if (y === undefined || m === undefined || d === undefined) throw new Error("bad RECEIVED_FROM");
  const offset = intBetween(r, [0, RECEIVED_DAYS - 1]);
  return new Date(Date.UTC(y, m - 1, d + offset)).toISOString().slice(0, 10);
}

function familyList(parts: readonly Part[]): string {
  const plurals: string[] = [];
  for (const p of parts) {
    const plural = familyRow(p.family).plural;
    if (!plurals.includes(plural)) plurals.push(plural);
  }
  if (plurals.length <= 1) return plurals.join("");
  return `${plurals.slice(0, -1).join(", ")} and ${plurals[plurals.length - 1] ?? ""}`;
}

function materialByCode(c: Catalog, code: string): Material {
  const m = c.materials.find((x) => x.code === code);
  if (m === undefined) throw new Error(`unknown material code: ${code}`);
  return m;
}

/**
 * One attempt at an RFQ. Returns the reason when a pinned feature can't be met with these draws; the
 * caller redraws from the same stream. `texts` holds the unstocked material text earlier RFQs used.
 */
function drawOnce(r: Rand, c: Catalog, plan: RfqPlan, texts: ReadonlyMap<string, string>): Drawn | string {
  const customer = pick(r, CUSTOMERS);
  const date = receivedOn(r);
  const linePlans = plan.shuffle === true ? shuffled(r, plan.lines) : [...plan.lines];
  const remaining = [...c.parts];
  const lines: DrawnLine[] = [];

  for (const lp of linePlans) {
    const index = Math.floor(r() * remaining.length);
    const part = remaining[index];
    if (part === undefined) return "no part left to draw";
    remaining.splice(index, 1);
    const defect = lp.defect ?? null;

    // material
    let material: Material | null;
    let text: string;
    if (defect?.kind === "unknown") {
      material = null;
      text = defect.material.text;
    } else if (defect?.kind === "unstocked") {
      material = materialByCode(c, defect.code);
      const avoid = defect.avoidTextOf === undefined ? undefined : texts.get(defect.avoidTextOf);
      const names = defect.textFrom === "name" ? [material.name]
        : defect.textFrom === "aliases" ? [...material.aliases] : [material.name, ...material.aliases];
      const options = names.filter((n) => n !== avoid);
      if (options.length === 0) return `${defect.code} has no unused name`;
      text = pick(r, options);
    } else {
      const row = familyRow(part.family);
      material = r() < TYPICAL_MATERIAL_SHARE ? materialByCode(c, part.typicalMaterialCode)
        : pick(r, allowedMaterials(c.materials, row));
      text = pick(r, [material.name, ...material.aliases]);
    }

    // quantity
    let quantity: number | null = null;
    if (defect?.kind !== "omit_qty" && defect?.kind !== "qty_phrase") {
      const pin = lp.stock ?? "any";
      const m = material;
      const options = pin === "any" || m === null ? [...QUANTITIES]
        : QUANTITIES.filter((q) => stockCheck(c, m, part, q).status === pin);
      if (options.length === 0) return `no quantity gives a ${pin} line`;
      quantity = pick(r, options);
    }

    // tolerance
    let stated: number | null = null;
    let conflict: [number, number] | null = null;
    if (defect?.kind === "conflict") {
      const a = pick(r, STATED_TOLERANCES);
      const b = pick(r, STATED_TOLERANCES.filter((t) => t !== a));
      stated = a;
      conflict = [a, b];
    } else {
      const pin = lp.tol ?? "any";
      if (pin === "tight") {
        const tighter = STATED_TOLERANCES.filter((t) => t < part.standardToleranceIn);
        if (tighter.length === 0) return "no tolerance is tighter than the part standard";
        stated = pick(r, tighter);
      } else if (pin === "stated") {
        stated = pick(r, STATED_TOLERANCES);
      } else if (pin === "any" || pin === "not_tight") {
        if (r() < STATED_TOLERANCE_SHARE) {
          const values = pin === "any" ? [...STATED_TOLERANCES]
            : STATED_TOLERANCES.filter((t) => t >= part.standardToleranceIn);
          stated = pick(r, values);
        }
      }
    }
    lines.push({ part, material, text, quantity, stated, conflict, defect });
  }

  // RFQ-level constraints
  if (plan.minMaterials !== undefined) {
    const codes = new Set(lines.map((l) => l.material?.code).filter((code) => code !== undefined));
    if (codes.size < plan.minMaterials) return `fewer than ${plan.minMaterials} materials`;
  }
  for (const l of lines) {
    const resolved = resolveMaterial(c, l.text);
    if (l.material === null ? resolved !== null : resolved?.code !== l.material.code) {
      return `material text "${l.text}" resolves to the wrong material`;
    }
  }

  // body
  const template = TEMPLATES[plan.template];
  const lineTexts = lines.map((l) => {
    const q: QuantitySlot = l.defect?.kind === "omit_qty" ? { kind: "omitted" }
      : l.defect?.kind === "qty_phrase" ? { kind: "phrase", text: l.defect.text }
      : { kind: "number", value: l.quantity ?? 0 };
    return template.line({ partNumber: l.part.partNumber, material: l.text, quantity: q,
      tolerance: l.stated === null ? null : formatTol(l.stated) });
  });
  const notes: string[] = [];
  for (const l of lines) {
    if (l.defect?.kind === "conflict" && l.conflict !== null) {
      notes.push(l.defect.sentence.replaceAll("{part}", l.part.partNumber)
        .replaceAll("{a}", formatTol(l.conflict[0])).replaceAll("{b}", formatTol(l.conflict[1])));
    }
  }
  if (plan.note !== undefined) notes.push(plan.note);
  const list = [...(template.header === null ? [] : [template.header]), ...lineTexts].join("\n");
  const body = [template.greeting, list, ...notes, template.signOff.replaceAll("{customer}", customer.name)]
    .join("\n\n");

  const rfq: Rfq = { id: plan.id, customer: customer.name, contactEmail: customerEmail(customer),
    receivedOn: date, subject: template.subject(familyList(lines.map((l) => l.part)), lines.length), body };

  const truthLines: TruthLine[] = lines.map((l, i) => {
    const blockedBy: QuestionField | null = l.defect?.kind === "omit_qty" || l.defect?.kind === "qty_phrase" ? "quantity"
      : l.defect?.kind === "conflict" ? "tolerance" : l.defect?.kind === "unknown" ? "material" : null;
    const check = blockedBy === null && l.material !== null && l.quantity !== null
      ? stockCheck(c, l.material, l.part, l.quantity) : null;
    return { lineRef: String(i + 1), partNumber: l.part.partNumber, materialAsRequested: l.text,
      materialCode: l.material?.code ?? null, quantity: l.quantity,
      toleranceIn: l.conflict !== null ? null : l.stated ?? l.part.standardToleranceIn,
      conflictingTolerances: l.conflict, blockedBy,
      keyword: l.defect?.kind === "unknown" ? l.defect.material.keyword : null,
      stockIfOk: check === null ? "not_checked" : check.status, leadTimeDaysIfOk: check === null ? null : check.leadTimeDays };
  });
  const truth: RfqTruth = { rfqId: plan.id, kind: plan.kind,
    expectedStatusIfOk: BLOCKED.includes(plan.kind) ? "needs_clarification" : "ready", lines: truthLines };

  const nextTexts = new Map(texts);
  for (const l of lines) if (l.defect?.kind === "unstocked") nextTexts.set(plan.id, l.text);
  return { rfq, truth, texts: nextTexts };
}

function drawSet(r: Rand, c: Catalog, plans: readonly RfqPlan[], set: CaseSet, seed: number):
  { rfqs: RfqFile; truth: TruthFile } {
  const rfqs: Rfq[] = [];
  const truth: RfqTruth[] = [];
  let texts: ReadonlyMap<string, string> = new Map();
  for (const plan of plans) {
    let reason = "";
    let drawn: Drawn | null = null;
    for (let attempt = 0; attempt < MAX_DRAWS && drawn === null; attempt++) {
      const result = drawOnce(r, c, plan, texts);
      if (typeof result === "string") reason = result;
      else drawn = result;
    }
    if (drawn === null) throw new Error(`${plan.id}: ${reason} after ${MAX_DRAWS} draws`);
    rfqs.push(drawn.rfq);
    truth.push(drawn.truth);
    texts = drawn.texts;
  }
  return { rfqs: { schema: 1, notice: SYNTHETIC_NOTICE, seed, set, rfqs },
    truth: { schema: 1, notice: SYNTHETIC_NOTICE, seed, set, truth } };
}

/** The catalog and the tuned RFQs with their truth, all from one mulberry32(seed) stream. */
export function generate(seed: number): { catalog: Catalog; rfqs: RfqFile; truth: TruthFile } {
  const r = mulberry32(seed);
  const catalog = drawCatalog(r, seed);
  return { catalog, ...drawSet(r, catalog, tunedPlans(), "tuned", seed) };
}

/** The held-out RFQs and truth from their own mulberry32(seed) stream, against a catalog it only reads. */
export function generateHoldout(catalog: Catalog, seed: number): { rfqs: RfqFile; truth: TruthFile } {
  return drawSet(mulberry32(seed), catalog, holdoutPlans(), "holdout", seed);
}

/** The bytes every data file is written as: two-space JSON with a final LF. */
export function serialize(v: unknown): string {
  return `${JSON.stringify(v, null, 2)}\n`;
}

export type SnapshotFile = { path: string; text: string };

/** The five committed data files, freshly generated, in the order data:check compares them. */
export function snapshotFiles(): SnapshotFile[] {
  const tuned = generate(DATA_SEED);
  const holdout = generateHoldout(tuned.catalog, HOLDOUT_SEED);
  return [
    { path: PATHS.catalog, text: serialize(tuned.catalog) },
    { path: PATHS.rfqs, text: serialize(tuned.rfqs) },
    { path: PATHS.truth, text: serialize(tuned.truth) },
    { path: PATHS.rfqsHoldout, text: serialize(holdout.rfqs) },
    { path: PATHS.truthHoldout, text: serialize(holdout.truth) },
  ];
}
