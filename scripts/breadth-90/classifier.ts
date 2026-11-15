// Breadth-90 classifier (pure). See docs/vertex-rebuild/breadth-90.md.
// upPct = NYSE up volume / (up + down volume) (USI:UVOL, USI:DVOL); advPct = advancers / (advancers +
// decliners) (USI:ADV, USI:DECL), the proxy for Lowry's points component.
// - ARMED: a final 80% down day (upPct <= 20) in the last ARM_WINDOW_SESSIONS final sessions; "strict"
//   when a 90% down day (upPct <= 10) is in the window.
// - FIRED (buy the dip): ARMED and a final 90% up day (upPct >= 90), or the session and the prior final
//   session are both 80% up days (>= 80). Grade "major" when advPct also clears the bar (>= 90 for a 90%
//   day, >= 80 on both days for the back-to-back case), else "volume-only" (Desmond rule 7: a
//   one-component day is often short-lived).
// - A fire uses the arming up: a new 80% down day after the fire session is needed to arm again.
// - THRUST: a final 90% up day while not armed (a notice, not the all-in signal).
// - FORMING: the unfinished (intraday) session meets the FIRED rule while ARMED.

const THRESHOLDS = Object.freeze({
  down80: 20,
  down90: 10,
  up80: 80,
  up90: 90,
});
export const ARM_WINDOW_SESSIONS = 30;

export type DayKind = "UP_90" | "UP_80" | "NEUTRAL" | "DOWN_80" | "DOWN_90";
export type SignalState = "IDLE" | "ARMED" | "FORMING" | "FIRED";
export type FireTrigger = "UP_90" | "UP_80_X2";
export type Grade = "major" | "volume-only";
export type EventKind = "ARMED" | "FORMING" | "FIRED" | "THRUST";

export type BreadthDay = Readonly<{
  date: string;
  uvol: number;
  dvol: number;
  adv: number;
  decl: number;
  final: boolean;
  source: string;
  asOf: string;
}>;

export type SessionRow = Readonly<{
  date: string;
  upPct: number;
  advPct: number | null;
  kind: DayKind;
  final: boolean;
}>;

export type SignalEvent = Readonly<{
  kind: EventKind;
  date: string;
  upPct: number;
  advPct: number | null;
  /** Newest 80%+ down day in the window (the arming day); null for THRUST. */
  armedOn: string | null;
  strict: boolean;
  trigger: FireTrigger | null;
  grade: Grade | null;
  /** Dedupe tier: strict|standard for ARMED, the grade for FORMING/FIRED/THRUST. */
  tier: string;
}>;

export type Arming = Readonly<{
  armedOn: string;
  strict: boolean;
  strictOn: string | null;
}>;

export type Evaluation = Readonly<{
  state: SignalState;
  latest: SessionRow | null;
  armedOn: string | null;
  strict: boolean;
  /** Upcoming sessions that stay armed by the newest arming day (null when not armed). */
  sessionsLeft: number | null;
  lastFired: SignalEvent | null;
  events: readonly SignalEvent[];
  sessions: readonly SessionRow[];
}>;

const round2 = (value: number): number => Math.round(value * 100) / 100;

/** Share (0-100, two decimals) of the first value in the pair; null when both are zero or invalid. */
export const sharePct = (part: number, other: number): number | null => {
  const total = part + other;
  if (!(Number.isFinite(total) && total > 0 && part >= 0 && other >= 0)) {
    return null;
  }
  return round2((part / total) * 100);
};

export const classifyPct = (upPct: number): DayKind => {
  if (upPct >= THRESHOLDS.up90) {
    return "UP_90";
  }
  if (upPct >= THRESHOLDS.up80) {
    return "UP_80";
  }
  if (upPct <= THRESHOLDS.down90) {
    return "DOWN_90";
  }
  if (upPct <= THRESHOLDS.down80) {
    return "DOWN_80";
  }
  return "NEUTRAL";
};

/** Rows sorted by date; days without a valid up/down volume pair are dropped. */
export const toSessions = (days: readonly BreadthDay[]): SessionRow[] =>
  [...days]
    .sort((a, b) => a.date.localeCompare(b.date))
    .flatMap((day) => {
      const upPct = sharePct(day.uvol, day.dvol);
      if (upPct === null) {
        return [];
      }
      return [
        {
          advPct: sharePct(day.adv, day.decl),
          date: day.date,
          final: day.final,
          kind: classifyPct(upPct),
          upPct,
        },
      ];
    });

/**
 * Arming from the final sessions before index `end` (exclusive), looking back the window but never
 * before index `from` (the session after the last fire: a fire uses the arming up).
 */
export const armingBefore = (
  finals: readonly SessionRow[],
  end: number,
  from = 0
): Arming | null => {
  const window = finals.slice(Math.max(from, end - ARM_WINDOW_SESSIONS), end);
  const downs = window.filter((row) => row.upPct <= THRESHOLDS.down80);
  const newest = downs.at(-1);
  if (!newest) {
    return null;
  }
  const strictDay = downs
    .filter((row) => row.upPct <= THRESHOLDS.down90)
    .at(-1);
  return {
    armedOn: newest.date,
    strict: strictDay !== undefined,
    strictOn: strictDay?.date ?? null,
  };
};

const atLeast = (value: number | null, bar: number): boolean =>
  value !== null && value >= bar;

export type FireResult = Readonly<{ trigger: FireTrigger; grade: Grade }>;

/** The FIRED rule for one session given the prior final session (null when it does not fire). */
export const fireRule = (
  row: SessionRow,
  prior: SessionRow | undefined
): FireResult | null => {
  if (row.upPct >= THRESHOLDS.up90) {
    return {
      grade: atLeast(row.advPct, THRESHOLDS.up90) ? "major" : "volume-only",
      trigger: "UP_90",
    };
  }
  if (row.upPct >= THRESHOLDS.up80 && prior && prior.upPct >= THRESHOLDS.up80) {
    const major =
      atLeast(row.advPct, THRESHOLDS.up80) &&
      atLeast(prior.advPct, THRESHOLDS.up80);
    return { grade: major ? "major" : "volume-only", trigger: "UP_80_X2" };
  }
  return null;
};

const signalEvent = (
  kind: EventKind,
  row: SessionRow,
  arming: Arming | null,
  rule: FireResult | null
): SignalEvent => ({
  advPct: row.advPct,
  armedOn: arming?.armedOn ?? null,
  date: row.date,
  grade: rule?.grade ?? null,
  kind,
  strict: arming?.strict ?? false,
  // ARMED events carry no rule: their tier is the strict flag; the others carry their grade.
  tier: rule ? rule.grade : arming?.strict ? "strict" : "standard",
  trigger: rule?.trigger ?? null,
  upPct: row.upPct,
});

/**
 * Walks the final sessions in date order, then judges a trailing unfinished session. Only the last
 * session may be unfinished; an unfinished session earlier in the list is ignored.
 */
export const evaluate = (days: readonly BreadthDay[]): Evaluation => {
  const all = toSessions(days);
  const last = all.at(-1);
  const pending = last && !last.final ? last : null;
  const finals = all.filter((row) => row.final);
  const sessions = pending ? [...finals, pending] : finals;
  const events: SignalEvent[] = [];
  // Index of the first session that may arm again (the session after the last fire).
  let from = 0;
  finals.forEach((row, index) => {
    const before = armingBefore(finals, index, from);
    const rule = fireRule(row, finals[index - 1]);
    if (before && rule) {
      events.push(signalEvent("FIRED", row, before, rule));
      from = index + 1;
    } else if (!before && rule?.trigger === "UP_90") {
      events.push(signalEvent("THRUST", row, null, rule));
    }
    const after = armingBefore(finals, index + 1, from);
    // An arming event: armed from idle, or upgraded to strict by a new 90% down day.
    if (
      after &&
      after.armedOn === row.date &&
      (!before || (after.strict && !before.strict))
    ) {
      events.push(signalEvent("ARMED", row, after, null));
    }
  });
  const arming = armingBefore(finals, finals.length, from);
  let state: SignalState = arming ? "ARMED" : "IDLE";
  const pendingRule = pending ? fireRule(pending, finals.at(-1)) : null;
  if (arming && pending && pendingRule) {
    events.push(signalEvent("FORMING", pending, arming, pendingRule));
    state = "FORMING";
  }
  const lastFired =
    events.filter((event) => event.kind === "FIRED").at(-1) ?? null;
  // FIRED shows for the fire session and the session after it (unless that one is FORMING again).
  if (lastFired && state !== "FORMING") {
    const fireIndex = sessions.findIndex((row) => row.date === lastFired.date);
    if (fireIndex >= sessions.length - 2) {
      state = "FIRED";
    }
  }
  const armedIndex = arming
    ? finals.findIndex((row) => row.date === arming.armedOn)
    : -1;
  return {
    armedOn: arming?.armedOn ?? null,
    events,
    lastFired,
    latest: sessions.at(-1) ?? null,
    sessions,
    sessionsLeft: arming
      ? ARM_WINDOW_SESSIONS + 1 - (finals.length - armedIndex)
      : null,
    state,
    strict: arming?.strict ?? false,
  };
};
