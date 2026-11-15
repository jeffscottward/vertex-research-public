// What: Scene and table builders of the trading quant modes (trading rules and market microstructure). Seeded, computed data only.
import type { ParamValues } from "../position.ts";
import {
  clamp01,
  type DataTable,
  type Marker,
  nth,
  type Point,
  type SceneCtx,
  type SceneData,
  span,
  withZero,
} from "../scene-kit.ts";
import type { TradingMode } from "./trading-ids.ts";
import {
  type Book,
  LANDSCAPE_ENTRIES,
  LANDSCAPE_LOOKBACKS,
  LANDSCAPE_WINDOWS,
  landscape,
  losingCells,
  orderBook,
  PAIR_HEDGE,
  PAIR_UNITS,
  type PairsPath,
  pairsPath,
  type RoundTrip,
  sharpe,
  slippage,
  sweep,
} from "./trading-models.ts";

const fixed = (value: number, digits = 2): string => value.toFixed(digits);
const dollars = (value: number): string =>
  `${value < 0 ? "-" : ""}$${Math.abs(value).toFixed(0)}`;

/** Day the scrubber shows: at least day 1 so a series always has a segment. */
const pairsNow = (path: PairsPath, t: number): number =>
  Math.max(Math.round(path.inputs.days * clamp01(t)), 1);

/** Exit of a round trip if it happened by day `now` (null while open at `now`). */
const exitBy = (trip: RoundTrip, now: number): RoundTrip["exit"] =>
  trip.exit !== null && trip.exit.day <= now ? trip.exit : null;

const pairsScene = (values: ParamValues, t: number): SceneData => {
  const path = pairsPath(values);
  const { days, entryZ, exitZ } = path.inputs;
  const now = pairsNow(path, t);
  const series = (data: readonly number[]): Point[] =>
    data.flatMap((value, day) =>
      Number.isNaN(value) ? [] : [[day, value] as const]
    );
  const trips = path.trips.filter((trip) => trip.entryDay <= now);
  const bands: Marker[] = trips.map((trip) => ({
    element: "trades",
    kind: "band",
    label: "",
    x: trip.entryDay,
    x2: exitBy(trip, now)?.day ?? now,
  }));
  const dots: Marker[] = trips.flatMap((trip) => {
    const exit = exitBy(trip, now);
    const entry: Marker = {
      element: "trades",
      kind: "dot",
      label: trip.side > 0 ? "Buy" : "Sell",
      x: trip.entryDay,
      y: trip.entryZ,
    };
    return exit === null
      ? [entry]
      : [
          entry,
          { element: "trades", kind: "dot", label: "", x: exit.day, y: exit.z },
        ];
  });
  const position = nth(path.position, now);
  const zPoints = series(path.z);
  const zReach = Math.max(
    entryZ + 0.5,
    ...zPoints.map((point) => Math.abs(point[1]) * 1.08)
  );
  const pnlPoints = series(path.pnl);
  return {
    horizon: days,
    layout: "stack",
    now,
    panels: [
      {
        bars: [],
        elements: ["axes", "a", "b", "trades"],
        id: "prices",
        markers: bands,
        series: [
          {
            element: "a",
            label: "Stock a",
            points: series(path.a),
            revealTo: now,
            width: 2,
          },
          {
            element: "b",
            label: `Stock b = ${PAIR_HEDGE}·a + spread`,
            points: series(path.b),
            revealTo: now,
            width: 2,
          },
        ],
        title: "Two stocks with a common trend (shaded: open positions)",
        xDomain: [0, days],
        xFormat: "day",
        xLabel: "Trading day",
        yDomain: span([...path.a, ...path.b]),
        yFormat: "price",
        yLabel: "Price",
      },
      {
        bars: [],
        elements: ["zscore", "entry", "exit", "trades"],
        id: "zscore",
        markers: [
          {
            element: "entry",
            kind: "hline",
            label: `+${fixed(entryZ, 1)}σ: sell the spread`,
            y: entryZ,
          },
          {
            element: "entry",
            kind: "hline",
            label: `-${fixed(entryZ, 1)}σ: buy the spread`,
            y: -entryZ,
          },
          {
            element: "exit",
            kind: "hline",
            label: `Exit ${fixed(exitZ, 1)}σ`,
            y: exitZ,
          },
          ...(exitZ === 0
            ? []
            : [
                {
                  element: "exit",
                  kind: "hline",
                  label: "",
                  y: -exitZ,
                } as const,
              ]),
          ...dots,
          {
            element: "trades",
            kind: "vline",
            label: `Day ${now}: ${position === 0 ? "flat" : position > 0 ? "long spread" : "short spread"}`,
            x: now,
          },
        ],
        series: [
          {
            element: "zscore",
            label: `Spread z-score (${path.inputs.lookback}-day)`,
            points: zPoints,
            revealTo: now,
            width: 1.75,
          },
        ],
        title: "Spread z-score: how stretched the rubber band is",
        xDomain: [0, days],
        xFormat: "day",
        xLabel: "Trading day",
        yDomain: [-zReach, zReach],
        yFormat: "num",
        yLabel: "z (σ)",
      },
      {
        bars: [],
        elements: ["pnl"],
        id: "pnl",
        markers: [],
        series: [
          {
            element: "pnl",
            label: `Cumulative P&L after ${path.inputs.costBps} bps costs`,
            points: pnlPoints,
            revealTo: now,
            signFill: true,
            width: 2,
          },
        ],
        title: `Strategy P&L (one unit: ${PAIR_UNITS} b vs ${PAIR_UNITS * PAIR_HEDGE} a)`,
        xDomain: [0, days],
        xFormat: "day",
        xLabel: "Trading day",
        yDomain: withZero(span(pnlPoints.map((point) => point[1]))),
        yFormat: "usd",
        yLabel: "P&L ($)",
      },
    ],
    timeLabel: "Trading day",
    timeUnit: "days",
  };
};

const pairsTables = (values: ParamValues, t: number): DataTable[] => {
  const path = pairsPath(values);
  const now = pairsNow(path, t);
  const position = nth(path.position, now);
  const z = nth(path.z, now);
  const closed = path.trips.filter((trip) => exitBy(trip, now) !== null);
  const wins = closed.filter((trip) => trip.pnl > 0).length;
  const shown = path.trips.filter((trip) => trip.entryDay <= now);
  return [
    {
      columns: ["Measure", "Value"],
      id: "pairs",
      note: "The hedge ratio is known here; in practice it is estimated (for example by regressing b on a) and drifts. One unit of the spread is 100 shares of b against 120 shares of a.",
      rows: [
        ["Price a", fixed(nth(path.a, now))],
        ["Price b", fixed(nth(path.b, now))],
        [`Spread b - ${PAIR_HEDGE}·a`, fixed(nth(path.spread, now))],
        ["Spread z-score", Number.isNaN(z) ? "Lookback filling" : fixed(z)],
        [
          "Position",
          position === 0
            ? "Flat"
            : position > 0
              ? "Long spread (buy b, sell a)"
              : "Short spread (sell b, buy a)",
        ],
        ["Round trips closed", String(closed.length)],
        [
          "Win rate",
          closed.length === 0
            ? "None closed yet"
            : `${((wins / closed.length) * 100).toFixed(0)}%`,
        ],
        ["Costs paid", dollars(nth(path.costs, now))],
        ["Cumulative P&L after costs", dollars(nth(path.pnl, now))],
        ["Spread half-life", `${fixed(path.inputs.halfLife, 1)} days`],
      ],
      title: `Pair on day ${now}`,
    },
    {
      columns: ["Side", "Entry day", "Entry z", "Exit day", "Exit z", "P&L"],
      id: "trades",
      note: "P&L per round trip includes the entry and exit costs. An open trip is marked to market on the current day.",
      rows: shown.map((trip) => {
        const exit = exitBy(trip, now);
        return [
          trip.side > 0 ? "Long spread" : "Short spread",
          String(trip.entryDay),
          fixed(trip.entryZ),
          exit === null ? "Open" : String(exit.day),
          exit === null ? "" : fixed(exit.z),
          dollars(
            exit === null
              ? nth(path.pnl, now) - nth(path.pnl, trip.entryDay - 1)
              : trip.pnl
          ),
        ];
      }),
      title: "Trades so far",
    },
  ];
};

const windowOf = (t: number): number =>
  Math.min(Math.floor(clamp01(t) * LANDSCAPE_WINDOWS), LANDSCAPE_WINDOWS - 1);

const cellName = (cell: { lookback: number; entry: number }): string =>
  `${cell.lookback}-day lookback, |z| ≥ ${fixed(cell.entry)}`;

const landscapeScene = (values: ParamValues, t: number): SceneData => {
  const model = landscape(values);
  const current = nth(model.windows, windowOf(t));
  const optimum: Point[] = model.windows.map((window) => [
    window.end,
    window.best.lookback,
  ]);
  const lagging: Point[] = model.windows.flatMap((window) =>
    window.model === null ? [] : [[window.end, window.model.lookback] as const]
  );
  return {
    horizon: model.horizon,
    layout: "grid",
    now: current.end,
    panels: [
      {
        bars: [],
        elements: ["axes", "surface"],
        id: "landscape",
        markers: [],
        series: [],
        surface: {
          element: "surface",
          legend: `Sharpe after ${model.inputs.costBps} bps costs: green = profit, red = loss (the sea); blue = row of the best cell`,
          sliceY: current.best.entry,
          xLabel: "Lookback (days)",
          xs: LANDSCAPE_LOOKBACKS,
          yLabel: "Entry |z|",
          ys: LANDSCAPE_ENTRIES,
          z: current.surface,
          zLabel: "Sharpe",
        },
        title: `Sharpe landscape, days ${current.start}-${current.end} (half-life ${fixed(current.halfLife, 0)}d)`,
        xDomain: [nth(LANDSCAPE_LOOKBACKS, 0), nth(LANDSCAPE_LOOKBACKS, -1)],
        xFormat: "count",
        xLabel: "Lookback (days)",
        yDomain: [nth(LANDSCAPE_ENTRIES, 0), nth(LANDSCAPE_ENTRIES, -1)],
        yFormat: "num",
        yLabel: "Entry |z|",
      },
      {
        bars: [],
        elements: ["optimum", "model"],
        id: "walkforward",
        markers: [
          {
            element: "optimum",
            kind: "dot",
            label: `Best: ${current.best.lookback}d${current.model?.lookback === current.best.lookback ? " (model on it)" : ""}`,
            x: current.end,
            y: current.best.lookback,
          },
          ...(current.model === null
            ? []
            : [
                {
                  element: "model",
                  kind: "dot",
                  label:
                    current.model.lookback === current.best.lookback
                      ? ""
                      : "Model",
                  x: current.end,
                  y: current.model.lookback,
                } as const,
              ]),
        ],
        series: [
          {
            element: "optimum",
            label: "Best lookback on the window (hindsight)",
            points: optimum,
            revealTo: current.end,
            width: 2,
          },
          {
            dashed: true,
            element: "model",
            label: "Model: previous window's best",
            points: lagging,
            revealTo: current.end,
            width: 2,
          },
        ],
        title: "The optimum migrates; the model follows one refit behind",
        xDomain: [0, model.horizon],
        xFormat: "day",
        xLabel: "Walk-forward day (window end)",
        yDomain: [0, nth(LANDSCAPE_LOOKBACKS, -1) + 5],
        yFormat: "num",
        yLabel: "Lookback (days)",
      },
    ],
    timeLabel: "Walk-forward day",
    timeUnit: "days",
  };
};

const landscapeTables = (values: ParamValues, t: number): DataTable[] => {
  const model = landscape(values);
  const index = windowOf(t);
  const current = nth(model.windows, index);
  const cells = current.surface.flat();
  // A cell with Sharpe exactly 0 (a rule that never traded) did not lose money.
  const sea = losingCells(cells);
  return [
    {
      columns: ["Measure", "Value"],
      id: "landscape",
      note: "Best in hindsight is the peak of this window's landscape, which nobody knows in advance. The model's out-of-sample Sharpe chains only the days after each refit, so it is the honest walk-forward number.",
      rows: [
        [
          "Window",
          `${index + 1} of ${LANDSCAPE_WINDOWS} (days ${current.start}-${current.end})`,
        ],
        ["Refit every", `${model.step} days`],
        ["Spread half-life now", `${fixed(current.halfLife, 1)} days`],
        ["Best cell (hindsight)", cellName(current.best)],
        ["Best Sharpe", fixed(current.best.sharpe)],
        [
          "Model cell (previous window's best)",
          current.model === null
            ? "None yet (first window)"
            : cellName(current.model),
        ],
        [
          "Model Sharpe on this window",
          current.model === null ? "None yet" : fixed(current.model.sharpe),
        ],
        [
          "Walk-forward Sharpe out of sample",
          current.outOfSample.length === 0
            ? "None yet"
            : fixed(sharpe(current.outOfSample)),
        ],
        ["Cells losing after costs (the sea)", `${sea} of ${cells.length}`],
      ],
      title: "Walk-forward optimization",
    },
    {
      columns: [
        "Window",
        "Days",
        "Best lookback",
        "Best |z|",
        "Best Sharpe",
        "Model lookback",
        "Model Sharpe",
      ],
      id: "walkforward",
      rows: model.windows
        .slice(0, index + 1)
        .map((window) => [
          String(window.index + 1),
          `${window.start}-${window.end}`,
          String(window.best.lookback),
          fixed(window.best.entry),
          fixed(window.best.sharpe),
          window.model === null ? "" : String(window.model.lookback),
          window.model === null ? "" : fixed(window.model.sharpe),
        ]),
      title: "Optimum and model by window",
    },
  ];
};

/** Decimals that show a price on the tick grid (at least cents). */
const priceDigits = (book: Book): number =>
  Math.max(2, Math.ceil(-Math.log10(book.inputs.tickSize) - 1e-9));

/** Shares of the order filled at time fraction t (the book's depth caps it). */
const filledAt = (book: Book, t: number): number =>
  Math.round(Math.min(book.inputs.orderSize, book.askDepth) * clamp01(t));

const orderbookScene = (values: ParamValues, t: number): SceneData => {
  const book = orderBook(values);
  const { tickSize, orderSize } = book.inputs;
  const digits = priceDigits(book);
  const fill = sweep(book, filledAt(book, t));
  const width = tickSize * 0.8;
  const largest = Math.max(...book.asks.map((level) => level.size));
  const sizes = Array.from({ length: 121 }, (_, index) =>
    Math.round((book.askDepth * index) / 120)
  );
  const curve: Point[] = sizes.map((shares) => [
    shares,
    slippage(book, shares) * 100,
  ]);
  const chosen = Math.min(orderSize, book.askDepth);
  const chosenSlip = slippage(book, chosen) * 100;
  return {
    horizon: 100,
    layout: "stack",
    now: Math.round(clamp01(t) * 100),
    panels: [
      {
        bars: [
          ...book.bids.map((level) => ({
            element: "bids",
            width,
            x: level.price,
            y: level.size,
          })),
          // A consumed level keeps an amber ghost of its original size behind what is left.
          ...book.asks.flatMap((level, index) => {
            const taken = nth(fill.taken, index);
            const left = level.size - taken;
            return [
              ...(taken > 0
                ? [
                    {
                      element: "sweep",
                      tone: true,
                      width,
                      x: level.price,
                      y: -level.size,
                    },
                  ]
                : []),
              ...(left > 0
                ? [{ element: "asks", width, x: level.price, y: -left }]
                : []),
            ];
          }),
        ],
        elements: ["axes", "bids", "asks", "sweep", "avg"],
        id: "book",
        markers: [
          // Levels consumed so far; before the first fill, the best ask the order starts at.
          {
            element: "sweep",
            kind: "band",
            label: "",
            x: book.bestAsk - tickSize / 2,
            x2: fill.lastPrice + tickSize / 2,
          },
          {
            element: "avg",
            kind: "vline",
            label: `Avg fill ${fixed(fill.average, digits + 2)}`,
            x: fill.average,
          },
        ],
        series: [],
        title: `Order book: market buy of ${orderSize.toLocaleString("en-US")} shares (${fill.filled.toLocaleString("en-US")} filled, ${fill.levelsTouched} level${fill.levelsTouched === 1 ? "" : "s"} swept)`,
        xDomain: [
          nth(book.bids, -1).price - tickSize,
          nth(book.asks, -1).price + tickSize,
        ],
        xFormat: "price",
        xLabel: "Price",
        yDomain: [-largest * 1.15, largest * 1.15],
        yFormat: "num",
        yLabel: "Shares (bids +, asks -)",
      },
      {
        bars: [],
        elements: ["curve", "marker"],
        id: "slippage",
        markers: [
          {
            element: "marker",
            kind: "dot",
            label: `${chosen.toLocaleString("en-US")} sh: +${fixed(chosenSlip)}¢${orderSize > book.askDepth ? " (book exhausted)" : ""}`,
            x: chosen,
            y: chosenSlip,
          },
        ],
        series: [
          {
            element: "curve",
            label: "Average fill minus best ask",
            points: curve,
            width: 2,
          },
        ],
        title: "Slippage grows with order size",
        xDomain: [0, book.askDepth],
        xFormat: "count",
        xLabel: "Order size (shares)",
        yDomain: withZero(span(curve.map((point) => point[1]))),
        yFormat: "num",
        yLabel: "Slippage (cents per share)",
      },
    ],
    timeLabel: "Order filled",
    timeUnit: "pct",
  };
};

const orderbookTables = (values: ParamValues, t: number): DataTable[] => {
  const book = orderBook(values);
  const digits = priceDigits(book);
  const price = (value: number): string => fixed(value, digits);
  const fill = sweep(book, filledAt(book, t));
  const whole = sweep(book, book.inputs.orderSize);
  const cents = (value: number): string => `${fixed(value * 100)}¢`;
  return [
    {
      columns: ["Measure", "Value"],
      id: "orderbook",
      note:
        whole.unfilled > 0
          ? `The order is larger than the ${book.askDepth.toLocaleString("en-US")} shares on the ask side: ${whole.unfilled.toLocaleString("en-US")} shares stay unfilled.`
          : "A static book: in a live market other traders cancel, add and react while the order fills.",
      rows: [
        ["Best bid", price(book.bestBid)],
        ["Best ask", price(book.bestAsk)],
        [
          "Spread",
          `${cents(book.bestAsk - book.bestBid)} (${book.inputs.spreadTicks} ticks)`,
        ],
        ["Mid", fixed(book.mid, digits + 1)],
        [
          "Shares filled",
          `${fill.filled.toLocaleString("en-US")} of ${book.inputs.orderSize.toLocaleString("en-US")}`,
        ],
        ["Levels swept", String(fill.levelsTouched)],
        ["Average fill price", fixed(fill.average, digits + 2)],
        ["Slippage vs best ask", cents(fill.average - book.bestAsk)],
        ["Slippage vs mid", cents(fill.average - book.mid)],
        [
          "Best ask after the order",
          fill.newBestAsk === null ? "Ask side empty" : price(fill.newBestAsk),
        ],
        [
          "Price impact",
          fill.newBestAsk === null
            ? "Book exhausted"
            : `+${cents(fill.newBestAsk - book.bestAsk)}`,
        ],
        [
          "Cost of slippage",
          `$${fixed((fill.average - book.bestAsk) * fill.filled)}`,
        ],
      ],
      title: "Market buy against the book",
    },
    {
      columns: ["Level", "Bid size", "Bid", "Ask", "Ask size", "Taken"],
      id: "ladder",
      rows: book.asks.map((ask, index) => {
        const bid = nth(book.bids, index);
        return [
          String(index + 1),
          bid.size.toLocaleString("en-US"),
          price(bid.price),
          price(ask.price),
          ask.size.toLocaleString("en-US"),
          nth(fill.taken, index).toLocaleString("en-US"),
        ];
      }),
      title: "Depth ladder",
    },
  ];
};

/** Scene of one trading mode at param values and time fraction ctx.t. */
export const tradingScene = (mode: TradingMode, ctx: SceneCtx): SceneData => {
  if (mode === "pairs") return pairsScene(ctx.values, ctx.t);
  if (mode === "landscape") return landscapeScene(ctx.values, ctx.t);
  return orderbookScene(ctx.values, ctx.t);
};

/** Mode-specific data tables (the inputs and constants tables are added by tables.ts). */
export const tradingTables = (
  mode: TradingMode,
  values: ParamValues,
  t: number
): DataTable[] => {
  if (mode === "pairs") return pairsTables(values, t);
  if (mode === "landscape") return landscapeTables(values, t);
  return orderbookTables(values, t);
};
