import type { TapePrint } from "./flow-trade-signing.ts";

// Tape speed counts (docs/vertex-rebuild/flow-pipeline.md, "Tape speed (ES, NQ)"): the prints and
// the contracts of each exchange second of the complete minutes of one tape read, and which
// seconds were covered. Pure. The collector stores the rows after its other writes, in a guarded
// step; a failure becomes a note in the sample message (tapeSecondsFailureNote). Research only.

/** One stored minute of counts; the same shape as FlowTapeSecondsRecord of the flow repository. */
export type FlowTapeSecondsRow = Readonly<{
  symbol: "ES" | "NQ";
  minute: Date;
  /** The local symbol of the contract that the stream followed (at most 20 characters). */
  contract: string;
  /** Prints per second, 60 elements. Every print of the minute is counted. */
  trades: number[];
  /** Contracts per second (the size sum as a whole number), 60 elements. */
  contracts: number[];
  /** 60 characters: `1` for a covered second, `0` for a second that is not covered. */
  covered: string;
  totalTrades: number;
}>;

export type TapeSecondsInput = Readonly<{
  symbol: "ES" | "NQ";
  contract: string;
  prints: readonly TapePrint[];
  /** Inclusive pairs [from, to] of covered exchange seconds. */
  covered: readonly (readonly [number, number])[];
  /** The read range in exchange seconds, whole minutes: since <= second < end. */
  since: number;
  end: number;
}>;

const MINUTE_SECONDS = 60;
const CONTRACT_MAX = 20;

/**
 * One row per minute of [since, end) that has a covered second or a print, ascending by minute.
 * A covered minute without a print gives zeros; a minute with neither gives no row. A print
 * outside the range is ignored. A print of a second that is not covered is counted: the service
 * ends a covered span at a late print, so the reader uses covered seconds for rates.
 */
export const countTapeSeconds = (
  input: TapeSecondsInput
): FlowTapeSecondsRow[] => {
  const { since, end } = input;
  const minutes = Math.max(0, Math.floor((end - since) / MINUTE_SECONDS));
  const seconds = minutes * MINUTE_SECONDS;
  const trades = new Array<number>(seconds).fill(0);
  const sizes = new Array<number>(seconds).fill(0);
  const covered = new Array<boolean>(seconds).fill(false);
  for (const [t, , size] of input.prints) {
    if (t < since || t >= since + seconds) continue;
    trades[t - since] = (trades[t - since] as number) + 1;
    sizes[t - since] = (sizes[t - since] as number) + size;
  }
  for (const [from, to] of input.covered)
    for (
      let t = Math.max(from, since);
      t <= Math.min(to, since + seconds - 1);
      t += 1
    )
      covered[t - since] = true;
  // An empty contract name would fail the check of the table: the symbol names the tape then.
  const contract = input.contract.slice(0, CONTRACT_MAX) || input.symbol;
  const rows: FlowTapeSecondsRow[] = [];
  for (let index = 0; index < minutes; index += 1) {
    const from = index * MINUTE_SECONDS;
    const minuteTrades = trades.slice(from, from + MINUTE_SECONDS);
    const mask = covered
      .slice(from, from + MINUTE_SECONDS)
      .map((seen) => (seen ? "1" : "0"))
      .join("");
    const totalTrades = minuteTrades.reduce((sum, count) => sum + count, 0);
    if (totalTrades === 0 && !mask.includes("1")) continue;
    rows.push({
      contract,
      contracts: sizes.slice(from, from + MINUTE_SECONDS).map(Math.round),
      covered: mask,
      minute: new Date((since + from) * 1000),
      symbol: input.symbol,
      totalTrades,
      trades: minuteTrades,
    });
  }
  return rows;
};

/** The start of the note that a failed per-second write adds to the tape sample message. */
export const TAPE_SECONDS_FAILURE_PREFIX = "; per-second counts not stored";

const NAME_MAX = 40;
const CAUSE_DEPTH = 5;
const SQLSTATE = /^[0-9A-Z]{5}$/;

const errorName = (error: unknown): string => {
  if (typeof error === "object" && error !== null) {
    const { causeName } = error as { causeName?: unknown };
    // The collector wraps a repository error; `causeName` is the name of the driver error.
    if (typeof causeName === "string") return causeName;
    if (error instanceof Error) return error.name;
  }
  return typeof error;
};

/** The SQLSTATE code of the error or of one of its causes (at most five links), or null. */
const sqlState = (error: unknown): string | null => {
  let link = error;
  for (let depth = 0; depth <= CAUSE_DEPTH; depth += 1) {
    if (typeof link !== "object" || link === null) return null;
    const { code, cause } = link as { code?: unknown; cause?: unknown };
    if (typeof code === "string" && SQLSTATE.test(code)) return code;
    link = cause;
  }
  return null;
};

/**
 * `; per-second counts not stored (<name>)`, with ` <SQLSTATE>` after the name when the error or
 * a cause has one (42P01: no table; 42501: no grant; 23514: check constraint). At most 80
 * characters, with no SQL text and no row data.
 */
export const tapeSecondsFailureNote = (error: unknown): string => {
  const code = sqlState(error);
  const name = errorName(error).slice(0, NAME_MAX);
  return `${TAPE_SECONDS_FAILURE_PREFIX} (${name}${code === null ? "" : ` ${code}`})`;
};
