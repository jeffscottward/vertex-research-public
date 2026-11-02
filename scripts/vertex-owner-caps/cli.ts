// Compare the owner risk caps snapshot (packages/api/src/risk-allocator.ts) with a local
// market-watch-bot checkout, the source of truth. Read-only: it changes no file.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { OWNER_RISK_CAPS } from "../../packages/api/src/risk-allocator.ts";

type CheckedCaps = Pick<
  typeof OWNER_RISK_CAPS,
  | "copyBookNamePct"
  | "copyBookTotalPct"
  | "leapsMinDte"
  | "leapsPremiumPct"
  | "leapsPremiumPending"
  | "optionsOnly"
  | "shortPremiumPct"
>;

interface Output {
  write: (line: string) => unknown;
}

const pick = (text: string, pattern: RegExp, name: string): string => {
  const match = pattern.exec(text)?.[1];
  if (match === undefined) throw new Error(`${name} not found`);
  return match;
};

/** Read the cap constants from a market-watch-bot checkout. */
export const readMarketWatchCaps = (
  root: string
): Omit<CheckedCaps, "leapsPremiumPending"> => {
  const read = (file: string): string => readFileSync(join(root, file), "utf8");
  const premium = read("market_watch/premium_caps.py");
  const copybook = read("market_watch/copyrot/copybook.py");
  const runner = read("market_watch/reentry/runner.py");
  return {
    copyBookNamePct: Number(
      pick(copybook, /^\s+name_pct: float = ([\d.]+)/mu, "name_pct")
    ),
    copyBookTotalPct: Number(
      pick(copybook, /total_pct: float = ([\d.]+)/u, "total_pct")
    ),
    leapsMinDte: Number(
      pick(premium, /^LEAPS_MIN_DTE = (\d+)/mu, "LEAPS_MIN_DTE")
    ),
    leapsPremiumPct: Number(
      pick(premium, /^LEAPS_PREMIUM_PCT = ([\d.]+)/mu, "LEAPS_PREMIUM_PCT")
    ),
    optionsOnly:
      pick(runner, /^OPTIONS_ONLY = (True|False)/mu, "OPTIONS_ONLY") === "True",
    shortPremiumPct: Number(
      pick(premium, /^SHORT_PREMIUM_PCT = ([\d.]+)/mu, "SHORT_PREMIUM_PCT")
    ),
  };
};

/** Exit code 0 when the snapshot matches, 1 on drift or an unreadable checkout. */
export const runOwnerCapsCheck = (
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  out: Output,
  snapshot: CheckedCaps = OWNER_RISK_CAPS
): number => {
  const root =
    argv[2] ??
    env["MARKET_WATCH_BOT_DIR"] ??
    join(homedir(), "Github/trading/market-watch-bot");
  let source: Omit<CheckedCaps, "leapsPremiumPending">;
  try {
    source = readMarketWatchCaps(root);
  } catch (error) {
    out.write(
      `cannot read market-watch-bot caps in ${root}: ${String(error)}\n`
    );
    return 1;
  }
  // market-watch-bot source holds the decided LEAPS cap, which may still await deployment.
  const expected: CheckedCaps = {
    ...snapshot,
    leapsPremiumPct:
      snapshot.leapsPremiumPending?.pct ?? snapshot.leapsPremiumPct,
  };
  const drift = (Object.keys(source) as (keyof typeof source)[]).filter(
    (key) => expected[key] !== source[key]
  );
  for (const key of drift)
    out.write(
      `drift: ${key} snapshot=${String(expected[key])} market-watch-bot=${String(source[key])}\n`
    );
  out.write(
    drift.length === 0
      ? "owner caps snapshot matches market-watch-bot\n"
      : `${drift.length} cap(s) differ\n`
  );
  return drift.length === 0 ? 0 : 1;
};
