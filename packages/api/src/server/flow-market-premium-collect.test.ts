import type {
  FlowMarketPremiumSessionRecord,
  FlowRepository,
} from "@darkfactory/db/server";
import { describe, expect, it, vi } from "vitest";

import {
  collectMarketPremium,
  MARKET_PREMIUM_HISTORY_DAYS,
  MARKET_PREMIUM_RETRY_SECONDS,
  type MarketPremiumDeps,
  marketPremiumCompletes,
  marketPremiumGapDate,
  nextMarketPremiumSession,
} from "./flow-market-premium-collect.ts";
import type { QuantDataClient, QuantDataResult } from "./quantdata-client.ts";

// November 2026 is EST (UTC-5). 2026-11-20 is a Friday.
const at = (iso: string) => new Date(iso);
const FRI_1000 = at("2026-11-20T15:00:00.000Z");
const FRI_1635 = at("2026-11-20T21:35:00.000Z");
const SAT_1200 = at("2026-11-21T17:00:00.000Z");
const HOUR = 3_600_000;

const totals = (premium = 3) => ({
  bearishPremium: 1,
  bullishPremium: 2,
  premium,
  tradeCount: 1,
  volume: 10,
});

const answer = (tickers: readonly string[]): QuantDataResult => ({
  body: {},
  data: Object.fromEntries(tickers.map((ticker) => [ticker, totals()])),
  ok: true,
});

const clientWith = (result: QuantDataResult) => {
  const request = vi.fn<QuantDataClient["request"]>(async () => result);
  return {
    client: { cooldownSeconds: () => 0, freeStarts: () => 24, request },
    request,
  };
};

const session = (
  sessionDate: string,
  overrides: Partial<FlowMarketPremiumSessionRecord> = {}
): FlowMarketPremiumSessionRecord => ({
  attempts: 1,
  capturedAt: at(`${sessionDate}T22:00:00.000Z`),
  lastAttemptAt: at(`${sessionDate}T22:00:00.000Z`),
  lastMessage: "stored",
  sessionDate,
  status: "complete",
  tickers: 700,
  ...overrides,
});

/** Every weekday from `today` minus the history window to the day before `today`, complete. */
const fullLedger = (today: string): FlowMarketPremiumSessionRecord[] => {
  const rows: FlowMarketPremiumSessionRecord[] = [];
  const start =
    Date.parse(`${today}T00:00:00Z`) - MARKET_PREMIUM_HISTORY_DAYS * 24 * HOUR;
  for (
    let time = start;
    time < Date.parse(`${today}T00:00:00Z`);
    time += 24 * HOUR
  ) {
    const day = new Date(time);
    if (day.getUTCDay() === 0 || day.getUTCDay() === 6) continue;
    rows.push(session(day.toISOString().slice(0, 10)));
  }
  return rows;
};

const depsWith = (
  overrides: Partial<MarketPremiumDeps> & {
    ledger?: FlowMarketPremiumSessionRecord[];
    result?: QuantDataResult;
  } = {}
) => {
  const { client, request } = clientWith(
    overrides.result ?? answer(["NVDA", "AAPL"])
  );
  const storeMarketPremium = vi.fn<FlowRepository["storeMarketPremium"]>(
    async ({ rows }) => rows.length
  );
  const marketPremiumLedger = vi.fn<FlowRepository["marketPremiumLedger"]>(
    async () => overrides.ledger ?? []
  );
  const deps: MarketPremiumDeps = {
    client,
    dryRun: false,
    now: FRI_1000,
    repository: {
      marketPremiumLedger,
      storeMarketPremium,
    } as unknown as FlowRepository,
    seed: false,
    sessionDate: "2026-11-20",
    ...overrides,
  };
  return { deps, marketPremiumLedger, request, storeMarketPremium };
};

describe("marketPremiumCompletes", () => {
  it("needs a fetch on a New York day after the session date", () => {
    expect(marketPremiumCompletes("2026-11-20", FRI_1635)).toBe(false);
    expect(
      marketPremiumCompletes("2026-11-20", at("2026-11-21T05:00:00.000Z"))
    ).toBe(true);
    expect(marketPremiumCompletes("2026-11-19", FRI_1000)).toBe(true);
  });
});

describe("marketPremiumGapDate", () => {
  const today = "2026-11-20";

  it("picks the oldest weekday of the history window without a ledger row", () => {
    expect(marketPremiumGapDate([], today, FRI_1000)).toBe("2025-10-16");
    const ledger = fullLedger(today).filter(
      (row) => row.sessionDate !== "2026-03-04"
    );
    expect(marketPremiumGapDate(ledger, today, FRI_1000)).toBe("2026-03-04");
  });

  it("retries partial and unavailable sessions after the retry time, with no attempt limit", () => {
    const old = new Date(
      FRI_1000.getTime() - MARKET_PREMIUM_RETRY_SECONDS * 1000
    );
    const recent = new Date(old.getTime() + 1000);
    const replace = (
      date: string,
      overrides: Partial<FlowMarketPremiumSessionRecord>
    ) =>
      fullLedger(today).map((row) =>
        row.sessionDate === date ? session(date, overrides) : row
      );
    expect(
      marketPremiumGapDate(
        replace("2026-06-01", { lastAttemptAt: old, status: "partial" }),
        today,
        FRI_1000
      )
    ).toBe("2026-06-01");
    expect(
      marketPremiumGapDate(
        replace("2026-06-01", {
          capturedAt: null,
          lastAttemptAt: old,
          status: "unavailable",
          tickers: 0,
        }),
        today,
        FRI_1000
      )
    ).toBe("2026-06-01");
    expect(
      marketPremiumGapDate(
        replace("2026-06-01", { lastAttemptAt: recent, status: "partial" }),
        today,
        FRI_1000
      )
    ).toBeNull();
    expect(
      marketPremiumGapDate(
        replace("2026-06-01", {
          attempts: 40,
          lastAttemptAt: old,
          status: "partial",
        }),
        today,
        FRI_1000
      )
    ).toBe("2026-06-01");
    expect(
      marketPremiumGapDate(
        replace("2026-06-01", {
          capturedAt: null,
          lastAttemptAt: old,
          status: "no_data",
          tickers: 0,
        }),
        today,
        FRI_1000
      )
    ).toBeNull();
  });
});

describe("nextMarketPremiumSession", () => {
  const stored = { kind: "stored", message: "m", tickers: 5 } as const;
  const failed = { kind: "failed", message: "x".repeat(400) } as const;

  it("counts attempts and marks a capture partial on the session date and complete after it", () => {
    expect(
      nextMarketPremiumSession(undefined, "2026-11-20", stored, FRI_1000)
    ).toEqual({
      attempts: 1,
      capturedAt: FRI_1000,
      lastAttemptAt: FRI_1000,
      lastMessage: "m",
      sessionDate: "2026-11-20",
      status: "partial",
      tickers: 5,
    });
    expect(
      nextMarketPremiumSession(
        session("2026-11-20", { attempts: 3, status: "partial" }),
        "2026-11-20",
        stored,
        SAT_1200
      )
    ).toMatchObject({ attempts: 4, status: "complete", tickers: 5 });
  });

  it("keeps the stored capture when an attempt fails or brings no rows", () => {
    const previous = session("2026-11-20", { status: "partial" });
    expect(
      nextMarketPremiumSession(previous, "2026-11-20", failed, FRI_1635)
    ).toMatchObject({
      attempts: 2,
      capturedAt: previous.capturedAt,
      lastMessage: "x".repeat(300),
      status: "partial",
      tickers: 700,
    });
    expect(
      nextMarketPremiumSession(
        previous,
        "2026-11-20",
        { ...stored, tickers: 0 },
        FRI_1635
      )
    ).toMatchObject({ status: "partial", tickers: 700 });
  });

  it("marks a session without rows no_data after the session date and unavailable before or on failure", () => {
    const empty = { ...stored, tickers: 0 };
    expect(
      nextMarketPremiumSession(undefined, "2026-11-20", empty, SAT_1200)
    ).toMatchObject({ capturedAt: null, status: "no_data", tickers: 0 });
    expect(
      nextMarketPremiumSession(undefined, "2026-11-20", empty, FRI_1000)
    ).toMatchObject({ capturedAt: null, status: "unavailable" });
    expect(
      nextMarketPremiumSession(
        session("2026-11-20", {
          capturedAt: null,
          status: "unavailable",
          tickers: 0,
        }),
        "2026-11-20",
        failed,
        FRI_1635
      )
    ).toMatchObject({ attempts: 2, capturedAt: null, status: "unavailable" });
  });
});

describe("collectMarketPremium", () => {
  it("does nothing without a QuantData client", async () => {
    const { deps, marketPremiumLedger } = depsWith({ client: null });
    await expect(collectMarketPremium(deps)).resolves.toEqual({
      items: 0,
      message: "QuantData not configured",
      record: false,
      status: "skipped",
    });
    expect(marketPremiumLedger).not.toHaveBeenCalled();
  });

  it("captures today's session live and stores the rows with a partial ledger row", async () => {
    const { deps, marketPremiumLedger, request, storeMarketPremium } =
      depsWith();
    await expect(collectMarketPremium(deps)).resolves.toEqual({
      items: 2,
      message: "live 2026-11-20: 2 tickers with trades >= $100k, 1 request",
      record: true,
      status: "ok",
    });
    expect(marketPremiumLedger).toHaveBeenCalledWith({
      from: "2025-10-16",
      to: "2026-11-20",
    });
    expect(request).toHaveBeenCalledWith(
      "gainersLosers",
      expect.objectContaining({ sessionDate: "2026-11-20" }),
      60_000
    );
    const [[stored]] = storeMarketPremium.mock.calls as [
      [Parameters<FlowRepository["storeMarketPremium"]>[0]],
    ];
    expect(stored.rows.map((row) => row.ticker)).toEqual(["AAPL", "NVDA"]);
    expect(stored.rows[0]).toEqual({
      ...totals(),
      capturedAt: FRI_1000,
      filterProfile: "premium-gte-100k.v1",
      sessionDate: "2026-11-20",
      ticker: "AAPL",
    });
    expect(stored.session).toMatchObject({
      attempts: 1,
      sessionDate: "2026-11-20",
      status: "partial",
    });
  });

  it("waits the live interval, then captures today's session again", async () => {
    const recent = session("2026-11-20", {
      lastAttemptAt: new Date(FRI_1000.getTime() - 60_000),
      status: "partial",
    });
    const waiting = depsWith({ ledger: [...fullLedger("2026-11-20"), recent] });
    await expect(collectMarketPremium(waiting.deps)).resolves.toMatchObject({
      message: "not due; the ledger holds every weekday of the last 400 days",
      record: false,
    });
    expect(waiting.request).not.toHaveBeenCalled();
    const due = depsWith({
      ledger: [
        ...fullLedger("2026-11-20"),
        session("2026-11-20", {
          lastAttemptAt: new Date(FRI_1000.getTime() - 840_000),
          status: "partial",
          tickers: 2,
        }),
      ],
    });
    await expect(collectMarketPremium(due.deps)).resolves.toMatchObject({
      status: "ok",
    });
    expect(due.storeMarketPremium.mock.calls[0]?.[0].session).toMatchObject({
      attempts: 2,
      status: "partial",
    });
  });

  it("fills the oldest gap after the live window closes at 16:15", async () => {
    const ledger = [
      ...fullLedger("2026-11-20").filter(
        (row) => row.sessionDate !== "2026-01-05"
      ),
      session("2026-11-20", {
        lastAttemptAt: new Date(FRI_1635.getTime() - 2 * HOUR),
      }),
    ];
    const { deps, request } = depsWith({ ledger, now: FRI_1635 });
    await expect(collectMarketPremium(deps)).resolves.toMatchObject({
      message: "gap fill 2026-01-05: 2 tickers with trades >= $100k, 1 request",
      status: "ok",
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[1]).toMatchObject({
      sessionDate: "2026-01-05",
    });
  });

  it("fills gaps outside the live window, also on a weekend", async () => {
    const { deps, storeMarketPremium } = depsWith({ now: SAT_1200 });
    await expect(collectMarketPremium(deps)).resolves.toMatchObject({
      message: expect.stringMatching(/^gap fill 2025-10-1[67]: /u),
      status: "ok",
    });
    expect(storeMarketPremium.mock.calls[0]?.[0].session.status).toBe(
      "complete"
    );
  });

  it("captures the newest session in a seed run, even on a weekend", async () => {
    const { deps, request } = depsWith({ now: SAT_1200, seed: true });
    await expect(collectMarketPremium(deps)).resolves.toMatchObject({
      message: expect.stringMatching(/^seed 2026-11-20: /u),
    });
    expect(request.mock.calls[0]?.[1]).toMatchObject({
      sessionDate: "2026-11-20",
    });
  });

  it("leaves the budget to other callers when the client reserves its starts", async () => {
    const { deps, storeMarketPremium } = depsWith({
      result: {
        message: "reserved",
        ok: false,
        reason: "reserved",
        retryAfterSeconds: null,
      },
    });
    await expect(collectMarketPremium(deps)).resolves.toEqual({
      items: 0,
      message: "budget: QuantData starts kept free for other callers",
      record: false,
      status: "skipped",
    });
    expect(storeMarketPremium).not.toHaveBeenCalled();
  });

  it("treats a client cooldown without a request as not due and keeps the ledger", async () => {
    const { deps, storeMarketPremium } = depsWith({
      result: {
        message: "QuantData gainersLosers: cooling down after HTTP 429.",
        ok: false,
        reason: "rate_limited",
        retryAfterSeconds: 30,
      },
    });
    await expect(collectMarketPremium(deps)).resolves.toEqual({
      items: 0,
      message:
        "QuantData paused: QuantData gainersLosers: cooling down after HTTP 429.",
      record: false,
      status: "skipped",
    });
    expect(storeMarketPremium).not.toHaveBeenCalled();
    const sent = depsWith({
      result: {
        httpStatus: 429,
        message: "QuantData gainersLosers: HTTP 429.",
        ok: false,
        reason: "rate_limited",
        retryAfterSeconds: 60,
      },
    });
    await expect(collectMarketPremium(sent.deps)).resolves.toMatchObject({
      record: true,
      status: "unavailable",
    });
  });

  it("records HTTP 422 as a session without data", async () => {
    const { deps, storeMarketPremium } = depsWith({
      now: SAT_1200,
      result: {
        httpStatus: 422,
        message: "QuantData gainersLosers: HTTP 422.",
        ok: false,
        reason: "http",
        retryAfterSeconds: null,
      },
    });
    await expect(collectMarketPremium(deps)).resolves.toMatchObject({
      items: 0,
      status: "empty",
    });
    expect(storeMarketPremium.mock.calls[0]?.[0]).toMatchObject({
      rows: [],
      session: { status: "no_data", tickers: 0 },
    });
  });

  it("records other failures and unreadable answers as unavailable", async () => {
    const failure = depsWith({
      result: {
        httpStatus: 503,
        message: "QuantData gainersLosers: HTTP 503.",
        ok: false,
        reason: "http",
        retryAfterSeconds: null,
      },
    });
    await expect(collectMarketPremium(failure.deps)).resolves.toEqual({
      items: 0,
      message: "live 2026-11-20: QuantData gainersLosers: HTTP 503.",
      record: true,
      status: "unavailable",
    });
    expect(failure.storeMarketPremium.mock.calls[0]?.[0].session).toMatchObject(
      { status: "unavailable" }
    );
    const unreadable = depsWith({
      result: { body: {}, data: [], ok: true },
    });
    await expect(collectMarketPremium(unreadable.deps)).resolves.toMatchObject({
      message:
        "live 2026-11-20: gainers-losers answer has an unexpected shape: (root)",
      status: "unavailable",
    });
  });

  it("keeps the stored totals when an answer shrinks below half of the stored tickers", async () => {
    const previous = session("2026-11-20", {
      lastAttemptAt: new Date(FRI_1000.getTime() - HOUR),
      status: "partial",
      tickers: 5,
    });
    const { deps, storeMarketPremium } = depsWith({
      ledger: [previous],
      result: answer(["AAPL", "NVDA"]),
    });
    await expect(collectMarketPremium(deps)).resolves.toMatchObject({
      message:
        "live 2026-11-20: answer shrank from 5 to 2 tickers; stored totals kept",
      status: "unavailable",
    });
    expect(storeMarketPremium.mock.calls[0]?.[0]).toMatchObject({
      rows: [],
      session: { attempts: 2, status: "partial", tickers: 5 },
    });
  });

  it("counts skipped keys and stores nothing in a dry run", async () => {
    const { deps, storeMarketPremium } = depsWith({
      dryRun: true,
      result: {
        body: {},
        data: { AAPL: totals(), "bad key": totals() },
        ok: true,
      },
    });
    await expect(collectMarketPremium(deps)).resolves.toEqual({
      items: 1,
      message:
        "live 2026-11-20: 1 tickers with trades >= $100k, 1 keys skipped, 1 request",
      record: true,
      status: "ok",
    });
    expect(storeMarketPremium).not.toHaveBeenCalled();
  });
});
