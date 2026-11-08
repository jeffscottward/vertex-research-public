// What: Scene and table builders of the portfolio quant modes (portfolio construction and asset pricing). Seeded, computed data only.
import { gaussian, mulberry32 } from "../math.ts";
import { num, type ParamValues } from "../position.ts";
import {
  type Bar,
  clamp01,
  type DataTable,
  grid,
  type Marker,
  nth,
  type Panel,
  type Point,
  type SceneCtx,
  type SceneData,
  span,
  withZero,
} from "../scene-kit.ts";
import type { PortfolioMode } from "./portfolio-ids.ts";

const clamp = (value: number, low: number, high: number): number =>
  Math.min(Math.max(value, low), high);
const pct = (value: number, digits = 1): string => `${value.toFixed(digits)}%`;
const signedPct = (value: number, digits = 1): string =>
  `${value >= 0 ? "+" : ""}${value.toFixed(digits)}%`;

/** Every portfolio scene runs its scrubber from 0 to 100 % of t. */
const scrubber = (t: number, timeLabel: string) => ({
  horizon: 100,
  now: clamp01(t) * 100,
  timeLabel,
  timeUnit: "pct" as const,
});

const dot = (element: string, label: string, x: number, y: number): Marker => ({
  element,
  kind: "dot",
  label,
  x,
  y,
});

/** Bar panel range: from zero (or the lowest bar) to the highest bar (at least 1), with room for labels. */
const barDomain = (bars: readonly Bar[]): [number, number] => {
  const heights = bars.map((bar) => bar.y);
  return [Math.min(0, ...heights) * 1.15, Math.max(1, ...heights) * 1.15];
};

// ---------------------------------------------------------------- frontier

type Mix = Readonly<{ weights: readonly number[]; ret: number; vol: number }>;

const ASSETS = [
  { name: "A", ret: 4, vol: 6 },
  { name: "B", ret: 7, vol: 18 },
  { name: "C", ret: 11, vol: 25 },
] as const;
const PAIRS = { AB: 0, AC: 0, BC: 0.5 } as const;
/** Weight grid step 1/GRID for the frontier search (20,301 long-only mixes). */
const GRID = 200;
/** Most random mixes the cloud can draw, and the default (modest, so the frontier stays visible). */
export const CLOUD_SIZE = 300;
const CLOUD_DEFAULT = 150;
/** Below this volatility (% a year; the lowest asset volatility is 0.5) a mix counts as riskless: no Sharpe ratio is shown. */
const RISKLESS_VOL = 0.25;

/** Determinant of a 3 × 3 correlation matrix with off-diagonals ab, ac, bc. */
const correlationDet = (ab: number, ac: number, bc: number): number =>
  1 + 2 * ab * ac * bc - ab * ab - ac * ac - bc * bc;

/**
 * Three correlations are only possible together when the matrix is positive semidefinite
 * (determinant ≥ 0, since each pair is in [−1, 1]). An impossible set is shrunk toward zero by the
 * largest factor that makes it valid: the nearest valid set with the same signs and proportions.
 */
const validCorrelations = (
  entered: Readonly<{ AB: number; AC: number; BC: number }>
): Readonly<{
  AB: number;
  AC: number;
  BC: number;
  scale: number;
  valid: boolean;
}> => {
  const { AB, AC, BC } = entered;
  if (correlationDet(AB, AC, BC) >= -1e-12)
    return { AB, AC, BC, scale: 1, valid: true };
  // det(0) = 1 > 0 and det(1) < 0: bisect for the largest valid factor, keeping the valid side.
  let low = 0;
  let high = 1;
  for (let step = 0; step < 60; step += 1) {
    const middle = (low + high) / 2;
    if (correlationDet(middle * AB, middle * AC, middle * BC) >= 0)
      low = middle;
    else high = middle;
  }
  return { AB: low * AB, AC: low * AC, BC: low * BC, scale: low, valid: false };
};

/** Three-asset mean-variance model: assets, correlations, risk-free rate, grid and random mixes. */
export const frontierModel = (values: ParamValues, t = 1) => {
  const assets = ASSETS.map((asset) => ({
    name: asset.name,
    ret: clamp(num(values, `ret${asset.name}`, asset.ret), -50, 100),
    vol: clamp(num(values, `vol${asset.name}`, asset.vol), 0.5, 100),
  }));
  // One shared `rho` param sets every pair; pairwise params override it.
  const shared = num(values, "rho", Number.NaN);
  const pair = (key: keyof typeof PAIRS): number =>
    clamp(
      num(values, `rho${key}`, Number.isFinite(shared) ? shared : PAIRS[key]),
      -1,
      1
    );
  const entered = { AB: pair("AB"), AC: pair("AC"), BC: pair("BC") };
  const checked = validCorrelations(entered);
  const correlations = { AB: checked.AB, AC: checked.AC, BC: checked.BC };
  const rho = [
    [1, correlations.AB, correlations.AC],
    [correlations.AB, 1, correlations.BC],
    [correlations.AC, correlations.BC, 1],
  ];
  const rf = clamp(num(values, "rf", 3), -10, 50);
  const mix = (weights: readonly number[]): Mix => {
    let variance = 0;
    let ret = 0;
    for (const [i, wi] of weights.entries()) {
      ret += wi * nth(assets, i).ret;
      for (const [j, wj] of weights.entries())
        variance +=
          wi *
          wj *
          nth(nth(rho, i), j) *
          nth(assets, i).vol *
          nth(assets, j).vol;
    }
    return { ret, vol: Math.sqrt(Math.max(variance, 0)), weights };
  };
  const sharpe = (point: Readonly<{ ret: number; vol: number }>): number =>
    (point.ret - rf) / Math.max(point.vol, RISKLESS_VOL);
  /** Sharpe ratio as text: a riskless mix has none (its return over the safe rate has no risk). */
  const sharpeText = (point: Readonly<{ ret: number; vol: number }>): string =>
    point.vol < RISKLESS_VOL ? "riskless" : sharpe(point).toFixed(2);
  const mixes: Mix[] = [];
  for (let a = 0; a <= GRID; a += 1)
    for (let b = 0; a + b <= GRID; b += 1)
      mixes.push(mix([a / GRID, b / GRID, (GRID - a - b) / GRID]));
  const byVol = [...mixes].sort((left, right) => left.vol - right.vol);
  // Upper edge (as in the lesson): keep a mix only if it earns more than every mix with less risk.
  const frontier: Mix[] = [];
  for (const candidate of byVol)
    if (candidate.ret > (frontier.at(-1)?.ret ?? Number.NEGATIVE_INFINITY))
      frontier.push(candidate);
  const minVar = nth(byVol, 0);
  const tangency = mixes.reduce((best, candidate) =>
    sharpe(candidate) > sharpe(best) ? candidate : best
  );
  const random = mulberry32(Math.round(num(values, "seed", 13)));
  const cloud = Array.from({ length: CLOUD_SIZE }, () => {
    const draws = assets.map(() => -Math.log(Math.max(random(), 1e-12)));
    const total = draws.reduce((sum, value) => sum + value, 0);
    return mix(draws.map((value) => value / total));
  });
  // `mixes` sets the cloud size; t reveals it: 10 % of it at t = 0, all of it at t = 1.
  const mixCount = clamp(
    Math.round(num(values, "mixes", CLOUD_DEFAULT)),
    10,
    CLOUD_SIZE
  );
  const shown = Math.round(mixCount * (0.1 + 0.9 * clamp01(t)));
  return {
    assets,
    cloud: cloud.slice(0, shown),
    correlationScale: checked.scale,
    correlations,
    correlationsValid: checked.valid,
    entered,
    frontier,
    minVar,
    rf,
    sharpe,
    sharpeText,
    tangency,
  };
};

const frontierScene = (ctx: SceneCtx): SceneData => {
  const model = frontierModel(ctx.values, ctx.t);
  const { assets, rf, sharpe, sharpeText, tangency, minVar } = model;
  const xMax = span([0, ...assets.map((asset) => asset.vol)], 0.15)[1];
  const ray = (slope: number): Point[] => [
    [0, rf],
    [xMax, rf + slope * xMax],
  ];
  const panel: Panel = {
    bars: [],
    elements: [
      "axes",
      "assets",
      "rf",
      "lines",
      "cloud",
      "frontier",
      "cml",
      "tangency",
      "minVar",
    ],
    id: "frontier",
    markers: [
      ...model.cloud.map((point) => dot("cloud", "", point.vol, point.ret)),
      dot("rf", `Risk-free ${pct(rf)}`, 0, rf),
      ...assets.map((asset) =>
        dot(
          "assets",
          `${asset.name} ${pct(asset.ret)} at ${pct(asset.vol)}`,
          asset.vol,
          asset.ret
        )
      ),
      dot("minVar", `Min variance ${pct(minVar.vol)}`, minVar.vol, minVar.ret),
      dot(
        "tangency",
        `Tangency, Sharpe ${sharpeText(tangency)}`,
        tangency.vol,
        tangency.ret
      ),
    ],
    series: [
      ...assets.map((asset) => ({
        dashed: true,
        element: "lines",
        label: `${asset.name}: Sharpe ${sharpeText(asset)}`,
        points: ray(sharpe(asset)),
      })),
      {
        element: "frontier",
        label: "Efficient frontier (long-only)",
        points: model.frontier.map((point): Point => [point.vol, point.ret]),
        width: 3,
      },
      {
        element: "cml",
        label: `Capital market line, Sharpe ${sharpeText(tangency)}`,
        points: ray(sharpe(tangency)),
        width: 2.5,
      },
    ],
    title: model.correlationsValid
      ? `Risk and return of ${model.cloud.length} random mixes of A, B and C`
      : `Invalid correlations: scaled ×${model.correlationScale.toFixed(2)} to a possible set`,
    // A sliver left of 0 keeps the risk-free dot and its label inside the plot.
    xDomain: [-xMax * 0.04, xMax],
    xFormat: "pct",
    xLabel: "Risk (volatility, % a year)",
    yDomain: span([
      rf,
      ...assets.map((asset) => asset.ret),
      ...model.cloud.map((point) => point.ret),
    ]),
    yFormat: "pct",
    yLabel: "Expected return (% a year)",
  };
  return {
    layout: "stack",
    panels: [panel],
    ...scrubber(ctx.t, "Random mixes drawn"),
  };
};

const weightsText = (weights: readonly number[]): string =>
  weights.map((weight) => pct(weight * 100, 0)).join(" / ");

const frontierTables = (values: ParamValues, t: number): DataTable[] => {
  const model = frontierModel(values, t);
  const { sharpeText } = model;
  const row = (name: string, point: Mix): string[] => [
    name,
    weightsText(point.weights),
    pct(point.ret, 2),
    pct(point.vol, 2),
    sharpeText(point),
  ];
  const { AB, AC, BC } = model.correlations;
  const entered = model.entered;
  const invalid = model.correlationsValid
    ? ""
    : `Invalid correlations: A-B ${entered.AB.toFixed(2)}, A-C ${entered.AC.toFixed(2)}, B-C ${entered.BC.toFixed(2)} cannot all hold at once (the matrix is not positive semidefinite); scaled ×${model.correlationScale.toFixed(2)} toward 0. Used: `;
  return [
    {
      columns: ["Asset", "Expected return", "Volatility", "Sharpe ratio"],
      id: "frontier-assets",
      note: `${invalid}${model.correlationsValid ? "Correlations: " : ""}A-B ${AB.toFixed(2)}, A-C ${AC.toFixed(2)}, B-C ${BC.toFixed(2)}. Risk-free rate ${pct(model.rf)}.`,
      rows: model.assets.map((asset) => [
        asset.name,
        pct(asset.ret),
        pct(asset.vol),
        sharpeText(asset),
      ]),
      title: "Assets",
    },
    {
      columns: ["Portfolio", "Weights A / B / C", "Return", "Risk", "Sharpe"],
      id: "frontier-portfolios",
      note: `${model.frontier.length} of ${((GRID + 1) * (GRID + 2)) / 2} grid mixes lie on the upper edge. ${model.cloud.length} random mixes drawn.`,
      rows: [
        row("Minimum variance", model.minVar),
        row("Tangency (max Sharpe)", model.tangency),
      ],
      title: "Optimal portfolios (long-only)",
    },
  ];
};

// ---------------------------------------------------------------- diversify

const DAYS = 250;

/** One-factor model of equal assets: scatter of two of them, a 50/50 mix and N equal weights. */
export const diversifyModel = (values: ParamValues, t = 1) => {
  const rho = clamp(num(values, "rho", 0.3), -1, 1);
  const vol = clamp(num(values, "vol", 20), 0.5, 100);
  const assets = clamp(Math.round(num(values, "assets", 100)), 2, 1000);
  const random = mulberry32(Math.round(num(values, "seed", 10)));
  const daily = vol / Math.sqrt(252);
  const market = Math.sqrt(Math.abs(rho));
  const own = Math.sqrt(1 - Math.abs(rho));
  const points = Array.from({ length: DAYS }, (): Point => {
    const push = gaussian(random);
    return [
      daily * (market * push + own * gaussian(random)),
      daily * (Math.sign(rho) * market * push + own * gaussian(random)),
    ];
  });
  const shown = points.slice(0, Math.round(DAYS * (0.1 + 0.9 * clamp01(t))));
  const mean = (index: 0 | 1): number =>
    shown.reduce((sum, point) => sum + point[index], 0) / shown.length;
  const [mx, my] = [mean(0), mean(1)];
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (const [x, y] of shown) {
    sxy += (x - mx) * (y - my);
    sxx += (x - mx) ** 2;
    syy += (y - my) ** 2;
  }
  // N assets can share one correlation ρ < 0 only while N ≤ 1 + 1/|ρ| (there the variance of the
  // equal mix reaches 0); beyond that such a set of assets cannot exist. ρ ≥ 0 allows any N.
  const maxValidN =
    rho < 0
      ? Math.floor(1 + 1 / Math.abs(rho) + 1e-9)
      : Number.POSITIVE_INFINITY;
  const floorRho = Math.max(rho, 0);
  return {
    assets,
    /** Equal-weight volatility of N assets; the same ρ as the 50/50 mix (N = 2). */
    countVol: (n: number): number =>
      vol * Math.sqrt(Math.max(rho + (1 - rho) / n, 0)),
    floor: vol * Math.sqrt(floorRho),
    floorRho,
    maxValidN,
    mixVol: (r: number): number => vol * Math.sqrt((1 + r) / 2),
    rho,
    sample: sxy / Math.sqrt(sxx * syy),
    shown,
    validCount: Math.min(assets, maxValidN),
    vol,
  };
};

const diversifyScene = (ctx: SceneCtx): SceneData => {
  const model = diversifyModel(ctx.values, ctx.t);
  const { rho, vol } = model;
  const reach =
    Math.max(...model.shown.flatMap((point) => point.map(Math.abs))) * 1.1;
  const volDomain: [number, number] = [0, vol * 1.1];
  const counts = Array.from(
    { length: model.validCount },
    (_, index) => index + 1
  );
  return {
    layout: "grid",
    panels: [
      {
        bars: [],
        elements: ["axes", "points"],
        id: "scatter",
        markers: model.shown.map(([x, y]) => dot("points", "", x, y)),
        series: [],
        title: `Daily returns of two assets: ρ ${rho.toFixed(2)}, measured ${model.sample.toFixed(2)} over ${model.shown.length} days`,
        xDomain: [-reach, reach],
        xFormat: "pct",
        xLabel: "Asset A daily return (%)",
        yDomain: [-reach, reach],
        yFormat: "pct",
        yLabel: "Asset B daily return (%)",
      },
      {
        bars: [],
        elements: ["axes", "mix", "marker"],
        id: "mix",
        markers: [
          dot(
            "marker",
            `ρ ${rho.toFixed(2)}: ${pct(model.mixVol(rho))}`,
            rho,
            model.mixVol(rho)
          ),
        ],
        series: [
          {
            element: "mix",
            label: "50/50 mix",
            points: grid(-1, 1, 81).map((r): Point => [r, model.mixVol(r)]),
            width: 3,
          },
          {
            dashed: true,
            element: "mix",
            label: "One asset alone",
            points: [
              [-1, vol],
              [1, vol],
            ],
          },
        ],
        title: `Risk of a 50/50 mix of two ${pct(vol, 0)} assets by correlation`,
        xDomain: [-1, 1],
        xFormat: "count",
        xLabel: "Correlation ρ",
        yDomain: volDomain,
        yFormat: "pct",
        yLabel: "Volatility (% a year)",
      },
      {
        bars: [],
        elements: ["axes", "count", "floor"],
        id: "count",
        markers: [
          {
            element: "floor",
            kind: "hline",
            label: `Systematic floor σ√ρ = ${pct(model.floor)}`,
            y: model.floor,
          },
        ],
        series: [
          {
            element: "count",
            label: "Equal weights",
            points: counts.map((n): Point => [n, model.countVol(n)]),
            width: 3,
          },
        ],
        title:
          model.validCount < model.assets
            ? `Risk of N equal assets: ρ ${rho.toFixed(2)} is only possible for N ≤ ${model.maxValidN}`
            : `Risk of N equal assets: ${pct(model.countVol(model.assets))} at N = ${model.assets}`,
        xDomain: [1, model.assets],
        xFormat: "count",
        xLabel: "Number of assets N",
        yDomain: volDomain,
        yFormat: "pct",
        yLabel: "Volatility (% a year)",
      },
    ],
    ...scrubber(ctx.t, "Days drawn"),
  };
};

const diversifyTables = (values: ParamValues, t: number): DataTable[] => {
  const model = diversifyModel(values, t);
  const counts = [
    ...new Set([1, 2, 5, 10, 20, 50, 100, 500, model.validCount]),
  ].filter((n) => n <= model.validCount);
  const rhos = [...new Set([-0.5, 0, 0.3, 0.8, model.rho])].sort(
    (a, b) => a - b
  );
  return [
    {
      columns: ["Assets N", "Portfolio volatility", "Diversified away"],
      id: "diversify-count",
      note:
        model.validCount < model.assets
          ? `With ρ ${model.rho.toFixed(2)} at most ${model.maxValidN} assets can all share it; the mix volatility falls toward 0 there.`
          : `Floor σ√ρ = ${pct(model.floor, 2)} with ρ ${model.floorRho.toFixed(2)}: the market push hits every asset the same way.`,
      rows: counts.map((n) => [
        String(n),
        pct(model.countVol(n), 2),
        pct(model.vol - model.countVol(n), 2),
      ]),
      title: "Equal weights across N assets",
    },
    {
      columns: ["Correlation ρ", "50/50 mix volatility"],
      id: "diversify-mix",
      note: `Measured correlation of the ${model.shown.length} drawn days: ${model.sample.toFixed(3)}.`,
      rows: rhos.map((r) => [r.toFixed(2), pct(model.mixVol(r), 2)]),
      title: "Two assets, half the money in each",
    },
  ];
};

// ---------------------------------------------------------------- sml

const BETAS = [0, 0.2, 0.4, 0.6, 0.8, 1, 1.2, 1.4] as const;
const ALPHA_BETA = 0.5;
const PAIR_BETA = 1.1;

/** CAPM line, eight fairly priced stocks with sampling noise, one mispriced stock and an APT pair. */
export const smlModel = (values: ParamValues) => {
  const rf = clamp(num(values, "rf", 3), -10, 50);
  const market = clamp(num(values, "marketReturn", 8), -50, 100);
  const alpha = clamp(
    num(values, "alpha", num(values, "mispricing", 2)),
    -50,
    50
  );
  const gap = clamp(
    num(values, "gap", Math.max(Math.abs(alpha), 0.5)),
    -50,
    50
  );
  const capm = (beta: number): number => rf + beta * (market - rf);
  const random = mulberry32(Math.round(num(values, "seed", 15)));
  const stocks = BETAS.map((beta) => ({
    beta,
    expected: capm(beta) + 0.4 * gaussian(random),
  }));
  return {
    alpha,
    alphaStock: { beta: ALPHA_BETA, expected: capm(ALPHA_BETA) + alpha },
    capm,
    gap,
    market,
    pair: {
      beta: PAIR_BETA,
      high: capm(PAIR_BETA) + gap / 2,
      low: capm(PAIR_BETA) - gap / 2,
    },
    rf,
    stocks,
  };
};

const smlScene = (ctx: SceneCtx): SceneData => {
  const model = smlModel(ctx.values);
  const { alpha, alphaStock, capm, pair, rf, market } = model;
  const premium = market - rf;
  const fair = capm(alphaStock.beta);
  const panel: Panel = {
    bars: [],
    elements: ["axes", "line", "assets", "alpha", "pair"],
    id: "sml",
    markers: [
      dot("line", `Market ${pct(market)}`, 1, market),
      ...model.stocks.map((stock) =>
        dot("assets", "", stock.beta, stock.expected)
      ),
      dot(
        "alpha",
        `α ${signedPct(alpha)}: ${alpha >= 0 ? "above the line, underpriced" : "below the line, overpriced"}`,
        alphaStock.beta,
        alphaStock.expected
      ),
      dot("pair", `Buy X ${pct(pair.high)}`, pair.beta, pair.high),
      dot("pair", `Sell Y ${pct(pair.low)}`, pair.beta, pair.low),
    ],
    series: [
      {
        element: "line",
        label: `SML: ${pct(rf)} + β × ${pct(premium)}`,
        points: [
          [0, rf],
          [1.6, capm(1.6)],
        ],
        width: 3,
      },
      {
        dashed: true,
        element: "alpha",
        label: "",
        points: [
          [alphaStock.beta, fair],
          [alphaStock.beta, alphaStock.expected],
        ],
      },
      {
        dashed: true,
        element: "pair",
        label: `Same β ${pair.beta.toFixed(1)}: long X, short Y earns ${pct(model.gap)} with no factor risk`,
        points: [
          [pair.beta, pair.low],
          [pair.beta, pair.high],
        ],
      },
    ],
    title: "Security market line: expected return by beta",
    xDomain: [0, 1.6],
    xFormat: "count",
    xLabel: "Beta β",
    yDomain: withZero(
      span([
        rf,
        capm(1.6),
        alphaStock.expected,
        pair.high,
        pair.low,
        ...model.stocks.map((stock) => stock.expected),
      ])
    ),
    yFormat: "pct",
    yLabel: "Expected return (% a year)",
  };
  return {
    layout: "stack",
    panels: [panel],
    ...scrubber(ctx.t, "Progress"),
  };
};

const smlTables = (values: ParamValues): DataTable[] => {
  const model = smlModel(values);
  const row = (name: string, beta: number, expected: number): string[] => [
    name,
    beta.toFixed(1),
    pct(model.capm(beta), 2),
    pct(expected, 2),
    signedPct(expected - model.capm(beta), 2),
  ];
  return [
    {
      columns: ["Stock", "Beta", "CAPM return", "Expected return", "Alpha"],
      id: "sml-stocks",
      note: `Market premium ${pct(model.market - model.rf, 2)}. X and Y have the same beta, so long X and short Y cancels the market and keeps ${pct(model.gap, 2)}.`,
      rows: [
        ...model.stocks.map((stock, index) =>
          row(`S${index + 1}`, stock.beta, stock.expected)
        ),
        row("Mispriced", model.alphaStock.beta, model.alphaStock.expected),
        row("X", model.pair.beta, model.pair.high),
        row("Y", model.pair.beta, model.pair.low),
      ],
      title: "Stocks against the CAPM line",
    },
  ];
};

// ---------------------------------------------------------------- riskparity

/** Stock and bond volatilities (% a year), their correlation and the stock weight (0-1) of the chosen mix. */
export type TwoAssets = Readonly<{
  bondVol: number;
  rho: number;
  stockVol: number;
  stockWeight: number;
}>;

/** Money and risk shares (0-1) of a stock/bond mix and its volatility (% a year). */
export type RiskSplit = Readonly<{
  bondRisk: number;
  bondWeight: number;
  stockRisk: number;
  stockWeight: number;
  vol: number;
}>;

const twoAssets = (values: ParamValues): TwoAssets => ({
  bondVol: clamp(num(values, "bondVol", 5), 0.5, 100),
  rho: clamp(num(values, "rho", 0.2), -0.99, 0.99),
  stockVol: clamp(num(values, "stockVol", 15), 0.5, 100),
  stockWeight: clamp(num(values, "stockWeight", 60), 0, 100) / 100,
});

/** Volatility and risk shares w_i(Σw)_i / σ² of a stock/bond mix. */
const riskSplit = (stockWeight: number, input: TwoAssets): RiskSplit => {
  const { bondVol, rho, stockVol } = input;
  const bondWeight = 1 - stockWeight;
  const covariance = rho * stockVol * bondVol;
  const stock =
    stockWeight * (stockWeight * stockVol ** 2 + bondWeight * covariance);
  const bond =
    bondWeight * (bondWeight * bondVol ** 2 + stockWeight * covariance);
  const variance = stock + bond;
  return {
    bondRisk: bond / variance,
    bondWeight,
    stockRisk: stock / variance,
    stockWeight,
    vol: Math.sqrt(variance),
  };
};

export const riskParityModel = (values: ParamValues) => {
  const input = twoAssets(values);
  return {
    ...input,
    classic: riskSplit(input.stockWeight, input),
    parity: riskSplit(input.bondVol / (input.stockVol + input.bondVol), input),
  };
};

const riskPanel = (id: string, title: string, split: RiskSplit): Panel => {
  const columns = [
    { capital: split.stockWeight, risk: split.stockRisk, x: 1 },
    { capital: split.bondWeight, risk: split.bondRisk, x: 2 },
  ];
  const bars: Bar[] = columns.flatMap((column) => [
    {
      element: "capital",
      tone: true,
      width: 0.3,
      x: column.x - 0.17,
      y: column.capital * 100,
    },
    {
      element: "risk",
      tone: true,
      width: 0.3,
      x: column.x + 0.17,
      y: column.risk * 100,
    },
  ]);
  return {
    bars,
    elements: ["axes", "capital", "risk"],
    id,
    markers: bars.map((bar) =>
      dot(
        bar.element,
        `${bar.element === "capital" ? "Money" : "Risk"} ${pct(bar.y, 0)}`,
        bar.x,
        bar.y
      )
    ),
    series: [],
    title,
    xDomain: [0.4, 2.6],
    xFormat: "count",
    xLabel: "1 = stocks, 2 = bonds",
    yDomain: barDomain(bars),
    yFormat: "pct",
    yLabel: "Share of money or risk (%)",
  };
};

const riskParityScene = (ctx: SceneCtx): SceneData => {
  const { classic, parity } = riskParityModel(ctx.values);
  const split = (mix: RiskSplit): string =>
    `${pct(mix.stockWeight * 100, 0)}/${pct(mix.bondWeight * 100, 0)}`;
  return {
    layout: "grid",
    panels: [
      riskPanel(
        "classic",
        `${split(classic)} by money: stocks carry ${pct(classic.stockRisk * 100)} of the risk`,
        classic
      ),
      riskPanel(
        "parity",
        `Inverse-volatility risk parity ${split(parity)}: each carries ${pct(parity.stockRisk * 100)}`,
        parity
      ),
    ],
    ...scrubber(ctx.t, "Progress"),
  };
};

const riskParityTables = (values: ParamValues): DataTable[] => {
  const model = riskParityModel(values);
  const rows = (name: string, mix: RiskSplit): string[][] => [
    [
      name,
      "Stocks",
      pct(mix.stockWeight * 100),
      pct(mix.stockRisk * 100),
      pct(mix.vol, 2),
    ],
    [
      name,
      "Bonds",
      pct(mix.bondWeight * 100),
      pct(mix.bondRisk * 100),
      pct(mix.vol, 2),
    ],
  ];
  return [
    {
      columns: [
        "Portfolio",
        "Asset",
        "Money",
        "Risk share",
        "Portfolio volatility",
      ],
      id: "riskparity-split",
      note: `Stocks ${pct(model.stockVol)}, bonds ${pct(model.bondVol)}, correlation ${model.rho.toFixed(2)}. Risk share = w_i(Σw)_i / σ_p².`,
      rows: [
        ...rows("Chosen mix", model.classic),
        ...rows("Risk parity", model.parity),
      ],
      title: "Money versus risk",
    },
  ];
};

// ---------------------------------------------------------------- blend

/** Black-Litterman with one absolute view on stocks over a stock/bond market portfolio. */
export const blendModel = (values: ParamValues) => {
  const input = twoAssets(values);
  const stockVol = input.stockVol / 100;
  const bondVol = input.bondVol / 100;
  const covariance = input.rho * stockVol * bondVol;
  const delta = clamp(num(values, "riskAversion", 2.5), 0, 20);
  const tau = clamp(num(values, "tau", 0.05), 1e-4, 1);
  const view = clamp(num(values, "view", 6), -50, 100);
  const confidence = clamp(num(values, "confidence", 50), 0, 100);
  const stockWeight = input.stockWeight;
  const bondWeight = 1 - stockWeight;
  const prior = {
    bond: 100 * delta * (covariance * stockWeight + bondVol ** 2 * bondWeight),
    stock:
      100 * delta * (stockVol ** 2 * stockWeight + covariance * bondWeight),
  };
  // Trust c = τσ²/(τσ² + Ω): with Ω = τσ²(1 − c)/c the posterior moves the share c toward the view,
  // and bonds follow through their covariance with stocks.
  const posterior = (weight: number) => ({
    bond:
      prior.bond + weight * (covariance / stockVol ** 2) * (view - prior.stock),
    stock: prior.stock + weight * (view - prior.stock),
  });
  const trust = confidence / 100;
  return {
    bondWeight,
    confidence,
    delta,
    omega:
      trust > 0
        ? (tau * stockVol ** 2 * (1 - trust)) / trust
        : Number.POSITIVE_INFINITY,
    posterior,
    prior,
    stockWeight,
    tau,
    trust,
    view,
  };
};

const blendScene = (ctx: SceneCtx): SceneData => {
  const model = blendModel(ctx.values);
  const { prior, view } = model;
  const chosen = model.posterior(model.trust);
  const bars: Bar[] = [
    { element: "prior", tone: true, width: 0.22, x: 0.75, y: prior.stock },
    { element: "view", tone: true, width: 0.22, x: 1, y: view },
    { element: "posterior", tone: true, width: 0.22, x: 1.25, y: chosen.stock },
    { element: "prior", tone: true, width: 0.22, x: 1.85, y: prior.bond },
    { element: "posterior", tone: true, width: 0.22, x: 2.15, y: chosen.bond },
  ];
  const names: Record<string, string> = {
    posterior: "Posterior",
    prior: "Implied",
    view: "View",
  };
  const confidences = grid(0, 100, 51);
  const curve = confidences.map(
    (c): Point => [c, model.posterior(c / 100).stock]
  );
  return {
    layout: "grid",
    panels: [
      {
        bars,
        elements: ["axes", "prior", "view", "posterior"],
        id: "returns",
        markers: bars.map((bar) =>
          dot(bar.element, `${names[bar.element]} ${pct(bar.y)}`, bar.x, bar.y)
        ),
        series: [],
        title: `Implied, view and posterior returns (1 = stocks, 2 = bonds; δ ${model.delta.toFixed(1)})`,
        xDomain: [0.4, 2.6],
        xFormat: "count",
        xLabel: "1 = stocks, 2 = bonds",
        yDomain: barDomain(bars),
        yFormat: "pct",
        yLabel: "Expected excess return (% a year)",
      },
      {
        bars: [],
        elements: ["axes", "curve", "marker"],
        id: "confidence",
        markers: [
          dot(
            "marker",
            `${pct(model.confidence, 0)} sure: ${pct(chosen.stock, 2)}`,
            model.confidence,
            chosen.stock
          ),
        ],
        series: [
          {
            element: "curve",
            label: "Posterior stock return",
            points: curve,
            width: 3,
          },
        ],
        title: "Posterior stock return by confidence in the view",
        xDomain: [0, 100],
        xFormat: "pct",
        xLabel: "Confidence in the view (%)",
        yDomain: withZero(span([prior.stock, view])),
        yFormat: "pct",
        yLabel: "Expected excess return (% a year)",
      },
    ],
    ...scrubber(ctx.t, "Progress"),
  };
};

const blendTables = (values: ParamValues): DataTable[] => {
  const model = blendModel(values);
  const chosen = model.posterior(model.trust);
  return [
    {
      columns: ["Asset", "Market weight", "Implied Π", "View", "Posterior"],
      id: "blend-returns",
      note: `δ ${model.delta.toFixed(2)}, τ ${model.tau.toFixed(3)}, Ω ${Number.isFinite(model.omega) ? model.omega.toFixed(5) : "∞"}: the posterior moves ${pct(model.confidence, 0)} of the way from Π to the view.`,
      rows: [
        [
          "Stocks",
          pct(model.stockWeight * 100, 0),
          pct(model.prior.stock, 3),
          pct(model.view, 2),
          pct(chosen.stock, 3),
        ],
        [
          "Bonds",
          pct(model.bondWeight * 100, 0),
          pct(model.prior.bond, 3),
          "none",
          pct(chosen.bond, 3),
        ],
      ],
      title: "Black-Litterman blend (returns above the risk-free rate)",
    },
  ];
};

// ---------------------------------------------------------------- dispatch

/** Scene of one portfolio mode at param values and time fraction ctx.t. */
export const portfolioScene = (
  mode: PortfolioMode,
  ctx: SceneCtx
): SceneData => {
  switch (mode) {
    case "frontier":
      return frontierScene(ctx);
    case "diversify":
      return diversifyScene(ctx);
    case "sml":
      return smlScene(ctx);
    case "riskparity":
      return riskParityScene(ctx);
    case "blend":
      return blendScene(ctx);
  }
};

/** Mode-specific data tables (the inputs and constants tables are added by tables.ts). */
export const portfolioTables = (
  mode: PortfolioMode,
  values: ParamValues,
  t: number
): DataTable[] => {
  switch (mode) {
    case "frontier":
      return frontierTables(values, t);
    case "diversify":
      return diversifyTables(values, t);
    case "sml":
      return smlTables(values);
    case "riskparity":
      return riskParityTables(values);
    case "blend":
      return blendTables(values);
  }
};
