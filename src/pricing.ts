// Quoting arithmetic. This is the only implementation: the tools, the data generator, the
// host's finalize step and the eval scorers all call these functions, so a number can only
// be computed one way.
//
//   weight        = blankVolumeIn3 * density                       (raw)
//   materialCost  = round2(weight * usdPerLb)
//   tier          = tolerance < part standard ? "tight" : "standard"
//   per operation = (cycle * machinability * tolFactor + setup / quantity) * rate / 60
//                   tolFactor is the tight factor on a tight line, except on the saw
//   machiningCost = round2(sum of the raw operation costs)          (rounded once)
//   unitPrice     = round2((materialCost + machiningCost) * (1 + margin / 100))
//   extended      = round2(unitPrice * quantity)
import type { Catalog, Machine, Material, OperationEstimate, Part, PartStock } from "./contracts.ts";

export function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/** Lower-case, trim, collapse runs of whitespace. */
export function normalizeMaterialText(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, " ");
}

/** Finds a material by exact code, name or alias after normalizing. Returns null when nothing matches. */
export function resolveMaterial(c: Catalog, text: string): Material | null {
  const wanted = normalizeMaterialText(text);
  if (wanted === "") return null;
  for (const m of c.materials) {
    const names = [m.code, m.name, ...m.aliases];
    if (names.some((n) => normalizeMaterialText(n) === wanted)) return m;
  }
  return null;
}

/** Finds a part by number, trimmed and case-insensitive. */
export function findPart(c: Catalog, partNumber: string): Part | null {
  const wanted = partNumber.trim().toUpperCase();
  return c.parts.find((p) => p.partNumber.toUpperCase() === wanted) ?? null;
}

export function findMachine(c: Catalog, id: string): Machine {
  const machine = c.machines.find((m) => m.id === id);
  if (machine === undefined) throw new Error(`unknown machine: ${id}`);
  return machine;
}

function dimension(s: PartStock, index: number): number {
  const value = s.sizeIn[index];
  if (value === undefined) throw new Error(`stock size ${index + 1} is missing for shape ${s.shape}`);
  return value;
}

/** Raw volume of the blank: PI * d * d / 4 * L for round bar, t * w * L for flat bar and plate. */
export function stockVolumeIn3(s: PartStock): number {
  if (s.shape === "round_bar") {
    const d = dimension(s, 0);
    return Math.PI * d * d / 4 * dimension(s, 1);
  }
  return dimension(s, 0) * dimension(s, 1) * dimension(s, 2);
}

/** "1.000 dia x 6.00" for round bar, "0.500 x 4.000 x 6.00" for flat bar and plate. */
export function stockSizeText(s: PartStock): string {
  if (s.shape === "round_bar") return `${dimension(s, 0).toFixed(3)} dia x ${dimension(s, 1).toFixed(2)}`;
  return `${dimension(s, 0).toFixed(3)} x ${dimension(s, 1).toFixed(3)} x ${dimension(s, 2).toFixed(2)}`;
}

/** Raw weight of one blank in pounds. */
export function blankWeightLb(p: Part, m: Material): number {
  return p.blankVolumeIn3 * m.densityLbPerIn3;
}

export function materialCostPerPart(p: Part, m: Material): number {
  return round2(blankWeightLb(p, m) * m.usdPerLb);
}

export function toleranceTier(p: Part, toleranceIn: number): "standard" | "tight" {
  return toleranceIn < p.standardToleranceIn ? "tight" : "standard";
}

type OperationCost = { estimate: OperationEstimate; rawCost: number };

function operationCosts(c: Catalog, p: Part, m: Material, quantity: number, toleranceIn: number): OperationCost[] {
  const tight = toleranceTier(p, toleranceIn) === "tight";
  return p.routing.map((o) => {
    const machine = findMachine(c, o.machineId);
    const tolFactor = tight && machine.kind !== "saw" ? c.tightToleranceFactor : 1;
    const runMinPerPart = o.cycleMinPerPart * m.machinability * tolFactor;
    const rawCost = (runMinPerPart + o.setupMin / quantity) * machine.usdPerHour / 60;
    return {
      rawCost,
      estimate: { op: o.op, machineId: machine.id, machineKind: machine.kind, usdPerHour: machine.usdPerHour,
        setupMin: o.setupMin, runMinPerPart: round2(runMinPerPart), costPerPartUsd: round2(rawCost) },
    };
  });
}

/** One estimate per routing step, in routing order. The per-step costs are rounded and informational. */
export function operationEstimates(c: Catalog, p: Part, m: Material, quantity: number, toleranceIn: number): OperationEstimate[] {
  return operationCosts(c, p, m, quantity, toleranceIn).map((o) => o.estimate);
}

/** The machining cost the quote uses: the raw step costs summed, then rounded once. */
export function machiningCostPerPart(c: Catalog, p: Part, m: Material, quantity: number, toleranceIn: number): number {
  return round2(operationCosts(c, p, m, quantity, toleranceIn).reduce((sum, o) => sum + o.rawCost, 0));
}

export function unitPrice(materialCost: number, machiningCost: number, marginPct: number): number {
  return round2((materialCost + machiningCost) * (1 + marginPct / 100));
}

export function extendedPrice(unit: number, quantity: number): number {
  return round2(unit * quantity);
}

/**
 * Stock for one line. Each line is checked on its own and on-hand is never decremented,
 * so two lines in one RFQ can both draw on the same bar stock.
 */
export function stockCheck(c: Catalog, m: Material, p: Part, quantity: number):
  { requiredLb: number; onHandLb: number; status: "in_stock" | "short" | "not_stocked"; leadTimeDays: number } {
  const requiredLb = round2(blankWeightLb(p, m) * quantity);
  const status = !m.stocked ? "not_stocked" : m.onHandLb >= requiredLb ? "in_stock" : "short";
  const leadTimeDays = c.shopLeadDays + (status === "in_stock" ? 0 : m.procurementLeadDays);
  return { requiredLb, onHandLb: m.onHandLb, status, leadTimeDays };
}
