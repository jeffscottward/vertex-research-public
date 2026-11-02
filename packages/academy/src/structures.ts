// What: Tradeable option structures used by the modeled backtest and the deploy gates. Each structure
// lists its legs as rules (strike by delta, days to expiry) plus default rule values.
import { DAYS_PER_YEAR, strikeForDelta } from "./math.ts";
import type { ResolvedLeg } from "./position.ts";
import { blackScholes } from "./math.ts";
import type { StructureId } from "./schema.ts";

export type LegRule = Readonly<{
  kind: "call" | "put" | "stock";
  side: "long" | "short";
  qty: number;
  /** core legs stay across cycles (stock, LEAPS); cycle legs are reopened each cycle. */
  role: "core" | "cycle";
  /** Rule key holding the target delta (calls positive, puts negative); "atm" for at the money. */
  delta?: string | "atm";
  /** Rule key holding days to expiry. */
  dte?: string;
}>;

export type StructureDef = Readonly<{
  id: StructureId;
  label: string;
  legs: readonly LegRule[];
  defaults: Readonly<Record<string, number>>;
  /** Short option exposure not covered by a long option, stock or cash. */
  undefinedRisk: boolean;
  /** Opens or holds a share position. */
  usesShares: boolean;
  credit: boolean;
}>;

const common = {
  profitTakePct: 50,
  stopLossPct: 100,
  exitDte: 7,
  riskPct: 10,
  ivMult: 1.1,
  costPerContract: 0.65,
  slippagePct: 2,
  slipCap: 0.1,
} as const;

const call = (
  side: "long" | "short",
  delta: string,
  role: "core" | "cycle" = "cycle",
  dte = "dte",
  qty = 1
): LegRule => ({ kind: "call", side, qty, role, delta, dte });
const put = (
  side: "long" | "short",
  delta: string,
  role: "core" | "cycle" = "cycle",
  dte = "dte",
  qty = 1
): LegRule => ({ kind: "put", side, qty, role, delta, dte });
const stock: LegRule = { kind: "stock", side: "long", qty: 1, role: "core" };

const def = (
  id: StructureId,
  label: string,
  legs: readonly LegRule[],
  defaults: Record<string, number>,
  flags: Partial<
    Pick<StructureDef, "undefinedRisk" | "usesShares" | "credit">
  > = {}
): StructureDef => ({
  id,
  label,
  legs,
  defaults: { ...common, ...defaults },
  undefinedRisk: flags.undefinedRisk ?? false,
  usesShares: flags.usesShares ?? legs.some((leg) => leg.kind === "stock"),
  credit: flags.credit ?? false,
});

export const STRUCTURE_DEFS: Readonly<Record<StructureId, StructureDef>> = {
  long_call: def("long_call", "Long call", [call("long", "longDelta")], {
    dte: 60,
    longDelta: 0.5,
    exitDte: 21,
    stopLossPct: 50,
    profitTakePct: 100,
  }),
  long_put: def("long_put", "Long put", [put("long", "longDelta")], {
    dte: 60,
    longDelta: -0.5,
    exitDte: 21,
    stopLossPct: 50,
    profitTakePct: 100,
  }),
  call_debit_spread: def(
    "call_debit_spread",
    "Call debit spread",
    [call("long", "longDelta"), call("short", "shortDelta")],
    {
      dte: 45,
      longDelta: 0.65,
      shortDelta: 0.35,
      exitDte: 10,
      profitTakePct: 60,
      stopLossPct: 50,
    }
  ),
  put_debit_spread: def(
    "put_debit_spread",
    "Put debit spread",
    [put("long", "longDelta"), put("short", "shortDelta")],
    {
      dte: 45,
      longDelta: -0.65,
      shortDelta: -0.35,
      exitDte: 10,
      profitTakePct: 60,
      stopLossPct: 50,
    }
  ),
  put_credit_spread: def(
    "put_credit_spread",
    "Put credit spread",
    [put("short", "shortDelta"), put("long", "longDelta")],
    {
      dte: 45,
      shortDelta: -0.3,
      longDelta: -0.15,
      exitDte: 14,
      profitTakePct: 50,
      stopLossPct: 200,
    },
    { credit: true }
  ),
  call_credit_spread: def(
    "call_credit_spread",
    "Call credit spread",
    [call("short", "shortDelta"), call("long", "longDelta")],
    {
      dte: 45,
      shortDelta: 0.3,
      longDelta: 0.15,
      exitDte: 14,
      profitTakePct: 50,
      stopLossPct: 200,
    },
    { credit: true }
  ),
  iron_condor: def(
    "iron_condor",
    "Iron condor",
    [
      put("long", "longPutDelta"),
      put("short", "shortPutDelta"),
      call("short", "shortCallDelta"),
      call("long", "longCallDelta"),
    ],
    {
      dte: 45,
      shortPutDelta: -0.16,
      longPutDelta: -0.08,
      shortCallDelta: 0.16,
      longCallDelta: 0.08,
      exitDte: 14,
      profitTakePct: 50,
      stopLossPct: 200,
    },
    { credit: true }
  ),
  iron_butterfly: def(
    "iron_butterfly",
    "Iron butterfly",
    [
      put("long", "wingPutDelta"),
      put("short", "atmPut"),
      call("short", "atmCall"),
      call("long", "wingCallDelta"),
    ],
    {
      dte: 30,
      atmPut: -0.5,
      atmCall: 0.5,
      wingPutDelta: -0.15,
      wingCallDelta: 0.15,
      exitDte: 7,
      profitTakePct: 25,
      stopLossPct: 100,
    },
    { credit: true }
  ),
  long_straddle: def(
    "long_straddle",
    "Long straddle",
    [call("long", "callDelta"), put("long", "putDelta")],
    {
      dte: 45,
      callDelta: 0.5,
      putDelta: -0.5,
      exitDte: 14,
      profitTakePct: 50,
      stopLossPct: 40,
    }
  ),
  short_strangle: def(
    "short_strangle",
    "Short strangle",
    [put("short", "shortPutDelta"), call("short", "shortCallDelta")],
    {
      dte: 45,
      shortPutDelta: -0.16,
      shortCallDelta: 0.16,
      exitDte: 21,
      profitTakePct: 50,
      stopLossPct: 200,
      riskPct: 5,
    },
    { undefinedRisk: true, credit: true }
  ),
  covered_call: def(
    "covered_call",
    "Covered call",
    [stock, call("short", "shortDelta")],
    {
      dte: 30,
      shortDelta: 0.3,
      exitDte: 0,
      profitTakePct: 80,
      stopLossPct: 1000,
    },
    { credit: true }
  ),
  cash_secured_put: def(
    "cash_secured_put",
    "Cash-secured put",
    [put("short", "shortDelta")],
    {
      dte: 30,
      shortDelta: -0.3,
      exitDte: 0,
      profitTakePct: 80,
      stopLossPct: 1000,
    },
    { credit: true }
  ),
  collar: def(
    "collar",
    "Collar",
    [stock, put("long", "putDelta"), call("short", "callDelta")],
    {
      dte: 60,
      putDelta: -0.25,
      callDelta: 0.25,
      exitDte: 0,
      profitTakePct: 1000,
      stopLossPct: 1000,
    }
  ),
  protective_put: def(
    "protective_put",
    "Protective put",
    [stock, put("long", "putDelta")],
    {
      dte: 90,
      putDelta: -0.25,
      exitDte: 21,
      profitTakePct: 1000,
      stopLossPct: 1000,
    }
  ),
  pmcc: def(
    "pmcc",
    "Poor man's covered call (diagonal)",
    [call("long", "coreDelta", "core", "coreDte"), call("short", "shortDelta")],
    {
      coreDte: 365,
      coreDelta: 0.8,
      coreExitDte: 120,
      dte: 30,
      shortDelta: 0.3,
      exitDte: 0,
      profitTakePct: 80,
      stopLossPct: 1000,
    }
  ),
  deep_itm_call: def(
    "deep_itm_call",
    "Deep ITM call (stock replacement)",
    [call("long", "coreDelta", "core", "coreDte")],
    {
      coreDte: 180,
      coreDelta: 0.85,
      coreExitDte: 60,
      profitTakePct: 1000,
      stopLossPct: 1000,
      riskPct: 30,
    }
  ),
  synthetic_long: def(
    "synthetic_long",
    "Synthetic long stock",
    [call("long", "atmCall"), put("short", "atmPut")],
    {
      dte: 60,
      atmCall: 0.5,
      atmPut: -0.5,
      exitDte: 14,
      profitTakePct: 1000,
      stopLossPct: 1000,
      riskPct: 5,
    },
    { undefinedRisk: true }
  ),
  ratio_call_spread: def(
    "ratio_call_spread",
    "1x2 call ratio spread",
    [call("long", "longDelta"), call("short", "shortDelta", "cycle", "dte", 2)],
    {
      dte: 45,
      longDelta: 0.5,
      shortDelta: 0.25,
      exitDte: 10,
      profitTakePct: 80,
      stopLossPct: 200,
      riskPct: 5,
    },
    { undefinedRisk: true }
  ),
  calendar_call: def(
    "calendar_call",
    "Call calendar",
    [call("long", "atmCall", "core", "coreDte"), call("short", "atmCall")],
    {
      coreDte: 60,
      coreExitDte: 30,
      dte: 30,
      atmCall: 0.5,
      exitDte: 0,
      profitTakePct: 1000,
      stopLossPct: 1000,
    }
  ),
};

export const STRUCTURE_RULE_KEYS = (structure: StructureId): string[] =>
  Object.keys(STRUCTURE_DEFS[structure].defaults);

/** Resolved rules: every structure carries the common rule keys, so those are always numbers. */
export type ResolvedRules = Record<string, number> &
  Record<keyof typeof common, number>;

/** Rule values = structure defaults overlaid by preset/user values; unknown keys throw. */
export const resolveRules = (
  structure: StructureId,
  ...layers: readonly (Readonly<Record<string, number>> | undefined)[]
): ResolvedRules => {
  const defaults = STRUCTURE_DEFS[structure].defaults;
  // def() already merged `common` into defaults; spreading it first only informs the type.
  const rules: ResolvedRules = { ...common, ...defaults };
  for (const layer of layers) {
    for (const [key, value] of Object.entries(layer ?? {})) {
      if (!(key in defaults))
        throw new Error(`${key} is not a rule of ${structure}`);
      if (!Number.isFinite(value))
        throw new Error(`${key} must be a finite number`);
      rules[key] = value;
    }
  }
  return rules;
};

/** Price a structure's legs at one market state into resolved legs (entry = price now). */
export const structureLegs = (
  structure: StructureId,
  rules: Readonly<Record<string, number>>,
  spot: number,
  vol: number,
  rate: number,
  roles: readonly ("core" | "cycle")[] = ["core", "cycle"]
): (ResolvedLeg & Readonly<{ role: LegRule["role"] }>)[] => {
  const increment = spot >= 200 ? 5 : spot >= 50 ? 1 : 0.5;
  const chosen = STRUCTURE_DEFS[structure].legs.filter((leg) =>
    roles.includes(leg.role)
  );
  const planned = chosen.map((leg) => {
    const dte = Math.max(rules[leg.dte ?? "dte"] ?? 30, 1);
    const target = rules[leg.delta ?? ""] ?? (leg.kind === "call" ? 0.5 : -0.5);
    return { leg, dte, target, strike: 0 };
  });
  // Different deltas must give different strikes: rounding can merge two strikes of one expiry,
  // which would turn a spread into nothing. The leg nearer the money keeps its strike and the
  // wing (smaller |delta|) moves one increment further out, whatever the leg order.
  const used = new Map<string, number[]>();
  for (const plan of [...planned].sort(
    (a, b) => Math.abs(b.target) - Math.abs(a.target)
  )) {
    if (plan.leg.kind === "stock") continue;
    const raw = strikeForDelta(
      plan.leg.kind,
      plan.target,
      spot,
      plan.dte / DAYS_PER_YEAR,
      rate,
      vol
    );
    let strike = Math.max(Math.round(raw / increment) * increment, increment);
    const key = `${plan.leg.kind}:${plan.dte}`;
    const taken = used.get(key) ?? [];
    const outward = plan.leg.kind === "call" ? increment : -increment;
    while (taken.includes(strike)) strike += outward;
    used.set(key, [...taken, strike]);
    plan.strike = strike;
  }
  return planned.map(({ leg, dte, strike }) => {
    if (leg.kind === "stock")
      return {
        kind: "stock",
        side: leg.side,
        qty: leg.qty,
        strike: 0,
        dte: Number.POSITIVE_INFINITY,
        vol,
        label: "Long 100 shares",
        entry: spot,
        role: leg.role,
      };
    const entry = blackScholes({
      kind: leg.kind,
      spot,
      strike,
      years: dte / DAYS_PER_YEAR,
      rate,
      vol,
    }).price;
    return {
      kind: leg.kind,
      side: leg.side,
      qty: leg.qty,
      strike,
      dte,
      vol,
      label: `${leg.side === "long" ? "Long" : "Short"} ${leg.qty > 1 ? `${leg.qty}x ` : ""}${strike} ${leg.kind} ${dte}d`,
      entry,
      role: leg.role,
    };
  });
};
