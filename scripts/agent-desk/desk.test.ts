import { describe, expect, it } from "vitest";
import {
  assertWritable,
  type DeskInput,
  type DeskRun,
  emptyBook,
  MAX_OPEN_PAPER_POSITIONS,
  type PaperPosition,
  renderSummary,
  runDesk,
  VEHICLE_POLICY,
} from "./desk.ts";
import {
  bars,
  dateAt,
  deskInput,
  resetCloses,
  signalCloses,
} from "./fixtures.test-support.ts";

const history = bars(signalCloses());
const signalDate = dateAt(history.length - 1);
const last = signalCloses().at(-1) as number;

/** The signal history followed by extra bars; each extra is [close, open]. */
const extended = (extra: readonly (readonly [number, number])[]) =>
  bars(
    [...signalCloses(), ...extra.map(([close]) => close)],
    [...signalCloses(), ...extra.map(([, open]) => open)]
  );

const processOf = (result: DeskRun, index = 0) =>
  result.report.tickers[index]?.agents.process;

const position = (overrides: Partial<PaperPosition>): PaperPosition => ({
  entry: null,
  exit: null,
  heldSessions: 0,
  id: "AAA-x",
  mark: null,
  openedOnRun: signalDate,
  reportId: "AAA",
  signalDate,
  status: "pending-entry",
  ...overrides,
});

const bookWith = (positions: PaperPosition[]) => ({
  ...emptyBook(),
  lastRunAsOf: signalDate,
  positions,
});

describe("runDesk paper journal", () => {
  it("records a signal, fills at the next open, holds and exits after a close below the SMA", () => {
    const book = emptyBook();
    const opened = runDesk({
      asOf: signalDate,
      book,
      reports: [deskInput("AAA", history)],
    });
    expect(book).toEqual(emptyBook());
    expect(processOf(opened)?.decision).toBe("paper-open");
    expect(opened.book.positions).toEqual([
      position({ id: `AAA-${signalDate}` }),
    ]);
    expect(opened.report).toMatchObject({
      mode: "paper",
      orders: "none",
      vehiclePolicy: VEHICLE_POLICY,
    });

    const rerun = runDesk({
      asOf: signalDate,
      book: opened.book,
      reports: [deskInput("AAA", history)],
    });
    expect(processOf(rerun)?.decision).toBe("paper-pending-entry");
    expect(rerun.book.positions).toHaveLength(1);

    const held = extended([[last * 1.001, last]]);
    const hold = runDesk({
      asOf: dateAt(history.length),
      book: opened.book,
      reports: [deskInput("AAA", held)],
    });
    expect(processOf(hold)?.decision).toBe("paper-hold");
    expect(hold.book.positions[0]).toMatchObject({
      entry: { basis: "open", date: dateAt(history.length), price: last },
      heldSessions: 1,
      status: "open",
    });

    const dipped = extended([
      [last * 1.001, last],
      [10, last],
    ]);
    const pending = runDesk({
      asOf: dateAt(history.length + 1),
      book: hold.book,
      reports: [deskInput("AAA", dipped)],
    });
    expect(processOf(pending)?.decision).toBe("paper-exit-pending");
    expect(processOf(pending)?.reasons.join(" ")).toContain(
      `Close below the SMA on ${dateAt(history.length + 1)}`
    );

    const exited = extended([
      [last * 1.001, last],
      [10, last],
      [10, 9],
    ]);
    const closed = runDesk({
      asOf: dateAt(history.length + 2),
      book: pending.book,
      reports: [deskInput("AAA", exited)],
    });
    expect(processOf(closed)?.decision).toBe("paper-close");
    expect(closed.book.positions[0]?.exit).toMatchObject({
      basis: "open",
      closedOnRun: dateAt(history.length + 2),
      date: dateAt(history.length + 2),
      price: 9,
      reason: "close-below-sma",
    });
    expect(closed.report.paperBook).toMatchObject({ active: 0, closed: 1 });
  });

  it("finds exits that happened between runs", () => {
    const opened = runDesk({
      asOf: signalDate,
      reports: [deskInput("AAA", history)],
    });
    const rising = Array.from(
      { length: 70 },
      (_, index) => [last * (1 + 0.001 * (index + 1)), last] as const
    );
    const hold = extended(rising);
    const holdExit = runDesk({
      asOf: dateAt(hold.length - 1),
      book: opened.book,
      reports: [deskInput("AAA", hold)],
    });
    expect(holdExit.book.positions[0]?.exit).toMatchObject({
      date: dateAt(history.length + 62),
      reason: "hold-period",
    });
    expect(holdExit.book.positions[0]?.heldSessions).toBe(63);

    const dip = extended([
      [last, last],
      [10, last],
      [last, 11],
      [last, last],
    ]);
    const dipExit = runDesk({
      asOf: dateAt(dip.length - 1),
      book: opened.book,
      reports: [deskInput("AAA", dip)],
    });
    expect(dipExit.book.positions[0]?.exit).toMatchObject({
      date: dateAt(history.length + 2),
      price: 11,
      reason: "close-below-sma",
    });
  });

  it("does not reuse a signal or reopen on or before a recorded exit", () => {
    const closedSame = position({
      exit: {
        basis: "close",
        closedOnRun: signalDate,
        date: signalDate,
        price: 1,
        reason: "hold-period",
        returnPct: 0,
      },
      signalDate: dateAt(500),
      status: "closed",
    });
    const result = runDesk({
      asOf: signalDate,
      book: bookWith([closedSame]),
      reports: [deskInput("AAA", history)],
    });
    expect(processOf(result)?.decision).toBe("watch");
    expect(processOf(result)?.reasons).toContain(
      `Paper book already holds the signal or an exit on or after ${signalDate}.`
    );
  });

  it("hides positions opened on later runs from an earlier dry run", () => {
    const opened = runDesk({
      asOf: signalDate,
      reports: [deskInput("AAA", history)],
    });
    const earlier = runDesk({
      asOf: dateAt(850),
      book: opened.book,
      reports: [deskInput("AAA", history)],
    });
    expect(earlier.report.paperBook.active).toBe(0);
    expect(earlier.book.positions).toEqual(opened.book.positions);
    expect(earlier.book.lastRunAsOf).toBe(signalDate);
  });

  it("replays a position closed on a later run when an earlier date is dry-run", () => {
    const opened = runDesk({
      asOf: signalDate,
      reports: [deskInput("AAA", history)],
    });
    const rising = Array.from(
      { length: 70 },
      (_, index) => [last * (1 + 0.001 * (index + 1)), last] as const
    );
    const hold = extended(rising);
    const closed = runDesk({
      asOf: dateAt(hold.length - 1),
      book: opened.book,
      reports: [deskInput("AAA", hold)],
    });
    expect(closed.book.positions[0]?.status).toBe("closed");
    const midway = runDesk({
      asOf: dateAt(history.length + 30),
      book: closed.book,
      reports: [deskInput("AAA", hold)],
    });
    expect(processOf(midway)?.decision).toBe("paper-hold");
    expect(midway.report.paperBook).toMatchObject({ active: 1, closed: 0 });
    expect(midway.book.positions[0]).toMatchObject({
      exit: null,
      heldSessions: 31,
      status: "open",
    });
  });

  it("reads a book saved with older policy text and saves the current text", () => {
    const result = runDesk({
      asOf: signalDate,
      book: { ...emptyBook(), vehiclePolicy: "older wording" },
      reports: [deskInput("AAA", history)],
    });
    expect(result.book.vehiclePolicy).toBe(VEHICLE_POLICY);
  });

  it("asks for review when the signal bar is no longer in the market data", () => {
    const result = runDesk({
      asOf: signalDate,
      book: bookWith([position({ signalDate: "2023-01-02" })]),
      reports: [deskInput("AAA", history)],
    });
    expect(processOf(result)).toEqual({
      agent: "process",
      decision: "paper-review",
      reasons: [
        "Signal bar 2023-01-02 is missing from the market data; the position is unchanged.",
      ],
    });
  });
});

describe("runDesk entry gates", () => {
  const reasonsOf = (result: DeskRun) => processOf(result)?.reasons.join(" ");

  it("blocks stale data, futures, missing fundamentals and weak backtests", () => {
    const stale = runDesk({
      asOf: "2030-01-01",
      reports: [deskInput("AAA", history)],
    });
    expect(processOf(stale)?.decision).toBe("watch");
    expect(reasonsOf(stale)).toContain("Technical: latest bar");
    expect(
      reasonsOf(
        runDesk({
          asOf: signalDate,
          reports: [
            deskInput("FUT", history, {
              metadata: { assetType: "future", id: "FUT", name: null },
            }),
          ],
        })
      )
    ).toContain("Futures are excluded");
    expect(
      reasonsOf(
        runDesk({
          asOf: signalDate,
          reports: [deskInput("AAA", history, { fundamentals: null })],
        })
      )
    ).toContain("Fundamental: Fundamentals dataset is missing.");
    expect(
      reasonsOf(
        runDesk({
          asOf: signalDate,
          backtest: { minClosedTrades: 1000 },
          reports: [deskInput("AAA", history)],
        })
      )
    ).toMatch(/Backtest: \d+ closed trades \(minimum 1000\)/u);
    expect(
      reasonsOf(
        runDesk({
          asOf: signalDate,
          backtest: { costBpsPerSide: 5000, minClosedTrades: 1 },
          reports: [deskInput("AAA", history)],
        })
      )
    ).toContain("is not positive");
  });

  it("opens at most the position cap in one run", () => {
    const ids = ["AAA", "BBB", "CCC", "DDD", "EEE", "FFF"];
    const result = runDesk({
      asOf: signalDate,
      reports: ids.map((id) => deskInput(id, history)),
    });
    expect(
      result.report.tickers.map((ticker) => ticker.agents.process.decision)
    ).toEqual([
      ...Array.from({ length: MAX_OPEN_PAPER_POSITIONS }, () => "paper-open"),
      "watch",
    ]);
    expect(
      reasonsOf({
        ...result,
        report: { ...result.report, tickers: result.report.tickers.slice(5) },
      })
    ).toContain(
      `Paper book already holds ${MAX_OPEN_PAPER_POSITIONS} active positions.`
    );
  });

  it("explains which rule check failed", () => {
    const rising = bars(resetCloses().slice(0, 330));
    expect(
      processOf(
        runDesk({ asOf: dateAt(329), reports: [deskInput("AAA", rising)] })
      )?.reasons[0]
    ).toBe("Uptrend confirmed; reset not met: ROC is outside the reset band.");
    const falling = bars(
      Array.from({ length: 300 }, (_, index) => 300 - index)
    );
    expect(
      processOf(
        runDesk({ asOf: dateAt(299), reports: [deskInput("AAA", falling)] })
      )?.reasons[0]
    ).toBe(
      "Trend filter not met: close is not above the SMA; SMA is not rising; ROC is outside the reset band; no prior ROC reading reached the minimum peak."
    );
    const short = bars(Array.from({ length: 10 }, (_, index) => 100 + index));
    expect(
      processOf(
        runDesk({ asOf: dateAt(9), reports: [deskInput("AAA", short)] })
      )?.decision
    ).toBe("no-action");
    const empty = deskInput("AAA", history, { fundamentals: null, news: null });
    expect(
      processOf(
        runDesk({ asOf: signalDate, reports: [{ ...empty, history: [] }] })
      )
    ).toEqual({
      agent: "process",
      decision: "no-action",
      reasons: [
        "Technical: No completed daily bars at or before the run date.",
      ],
    });
  });

  it("rejects invalid runs and books", () => {
    expect(() =>
      runDesk({ asOf: "2026-02-31", reports: [deskInput("AAA", history)] })
    ).toThrow("asOf must be a YYYY-MM-DD date");
    expect(() => runDesk({ asOf: signalDate, reports: [] })).toThrow(
      "Supply 1-10 reports"
    );
    expect(() =>
      runDesk({
        asOf: signalDate,
        reports: Array.from({ length: 11 }, (_, index) =>
          deskInput(`T${index}`, history)
        ),
      })
    ).toThrow("Supply 1-10 reports");
    expect(() =>
      runDesk({
        asOf: signalDate,
        reports: [deskInput("AAA", history), deskInput("AAA", history)],
      })
    ).toThrow("duplicate IDs");
    expect(() =>
      runDesk({
        asOf: signalDate,
        book: { ...emptyBook(), mode: "live" },
        reports: [deskInput("AAA", history)],
      })
    ).toThrow();
  });
});

describe("runDesk pitch agent", () => {
  const rich = (id: string) => {
    const plain = deskInput(id, history);
    return {
      ...plain,
      fundamentals: {
        asOf: signalDate,
        financialFacts: [{ asOf: signalDate }],
        valuation: {
          scenarios: [
            { id: "bear", upsidePct: -30 },
            { id: "base", upsidePct: 12 },
            { id: "bull", upsidePct: 40 },
          ],
        },
      },
      news: {
        asOf: signalDate,
        catalysts: [{ date: dateAt(history.length + 20), title: "Dev day" }],
        items: [{ category: "earnings", date: signalDate, title: "results" }],
        risks: [],
      },
      sentiment: {
        asOf: signalDate,
        posts: [{ date: signalDate, stance: "bull" as const }],
        source: "test labels",
      },
    };
  };

  it("reports a pitch for each ticker", () => {
    const result = runDesk({
      asOf: signalDate,
      reports: [
        deskInput("AAA", history),
        rich("BBB"),
        deskInput("ETF", history, {
          metadata: { assetType: "etf", id: "ETF", name: null },
        }),
      ],
    });
    const pitches = result.report.tickers.map((ticker) => ticker.agents.pitch);
    expect(pitches[0]).toMatchObject({
      agent: "pitch",
      direction: "long-supported",
      posture: "screen-grade",
      status: "evaluated",
    });
    expect(pitches[1]).toMatchObject({
      direction: "long-supported",
      exits: { timeStop: { date: dateAt(history.length + 20) } },
      posture: "decision-grade",
      postureReasons: [],
    });
    expect(pitches[1]?.scenarios.map((scenario) => scenario.case)).toEqual([
      "bear",
      "base",
      "bull",
    ]);
    expect(pitches[2]).toMatchObject({
      posture: "blocked",
      status: "not-applicable",
    });
    const stop = pitches[1]?.exits.priceStop;
    const lines = renderSummary(result.report).split("\n");
    expect(lines).toContain(
      "  Pitch (analysis only): screen-grade | long-supported | " +
        `price stop ${stop?.level} (${stop?.distancePct}% from close) | next catalyst none dated`
    );
    expect(lines).toContain(
      "  Pitch (analysis only): decision-grade | long-supported | " +
        `price stop ${stop?.level} (${stop?.distancePct}% from close) | next catalyst ${dateAt(history.length + 20)} Dev day`
    );
    expect(lines).toContain(
      "  Pitch (analysis only): blocked | unknown | price stop n/a | next catalyst none dated"
    );
  });

  it("leaves the process decision and the paper book unchanged", () => {
    const run = (report: DeskInput) =>
      runDesk({ asOf: signalDate, book: emptyBook(), reports: [report] });
    const thin = run(deskInput("AAA", history));
    const full = run(rich("AAA"));
    // The two inputs differ only in what the pitch reads: bear and bull cases, a dated
    // catalyst and sentiment labels. The pitch changes; the decision and the book do not.
    expect(full.report.tickers[0]?.agents.pitch.posture).toBe("decision-grade");
    expect(thin.report.tickers[0]?.agents.pitch.posture).toBe("screen-grade");
    expect(processOf(full)).toEqual(processOf(thin));
    expect(processOf(full)?.decision).toBe("paper-open");
    expect(full.book).toEqual(thin.book);
    expect(Object.keys(full.book).sort()).toEqual(
      Object.keys(emptyBook()).sort()
    );
    expect(full.report.paperBook).toEqual(thin.report.paperBook);
  });
});

describe("assertWritable and renderSummary", () => {
  it("refuses future and out-of-order journal writes", () => {
    expect(() =>
      assertWritable(emptyBook(), "2026-10-19", "2026-10-18")
    ).toThrow("after today 2026-10-18");
    expect(() =>
      assertWritable(
        { ...emptyBook(), lastRunAsOf: "2026-10-10" },
        "2026-10-09",
        "2026-10-18"
      )
    ).toThrow("refusing to save an earlier date 2026-10-09");
    expect(() =>
      assertWritable(
        { ...emptyBook(), lastRunAsOf: "2026-10-10" },
        "2026-10-10",
        "2026-10-18"
      )
    ).not.toThrow();
  });

  it("states the options-only policy and lists positions left out of the run", () => {
    const book = bookWith([position({ id: "ZZZ-1", reportId: "ZZZ" })]);
    const falling = bars(
      Array.from({ length: 300 }, (_, index) => 300 - index)
    );
    const result = runDesk({
      asOf: signalDate,
      book,
      reports: [
        deskInput("AAA", history),
        deskInput("BBB", falling, { fundamentals: null }),
        { ...deskInput("CCC", history), history: [] },
      ],
    });
    const text = renderSummary(result.report);
    expect(text.split("\n").slice(0, 2)).toEqual([
      `Paper agent desk ${signalDate}: paper only, no orders.`,
      VEHICLE_POLICY,
    ]);
    expect(text).toContain("AAA: paper-open | ROC");
    expect(text).toContain("close above SMA200: yes");
    expect(text).toContain("close above SMA200: no");
    expect(text).toContain("close above SMA200: unknown");
    expect(text).toContain("fundamentals unavailable (blocking)");
    expect(text).toContain("mean underlying reference return");
    expect(text).toContain(
      "Paper book: 2 active, 0 closed. Not in this run: ZZZ-1."
    );
    const quiet = renderSummary(
      runDesk({ asOf: signalDate, reports: [deskInput("BBB", falling)] }).report
    );
    expect(quiet).toMatch(/Paper book: 0 active, 0 closed\.$/u);
  });
});
