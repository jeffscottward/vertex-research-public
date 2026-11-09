// What: Formula library for lesson pages. Each formula has a MathML rendering (shown in the data
// tables; MathML renders natively in current browsers) and a plain-text form for captions and tests.
import {
  frac,
  math,
  mi,
  mn,
  mo,
  paren,
  row,
  sqrt,
  sub,
  sup,
} from "./mathml.ts";
import { GROWTH_FORMULAS } from "./quant/growth-formulas.ts";
import { OPTIONS_FORMULAS } from "./quant/options-formulas.ts";
import { PORTFOLIO_FORMULAS } from "./quant/portfolio-formulas.ts";
import { PROCESS_FORMULAS } from "./quant/process-formulas.ts";
import { STATISTICS_FORMULAS } from "./quant/statistics-formulas.ts";
import { TESTING_FORMULAS } from "./quant/testing-formulas.ts";
import { TRADING_FORMULAS } from "./quant/trading-formulas.ts";
import { VOLATILITY_FORMULAS } from "./quant/volatility-formulas.ts";
import type { BaseFormulaId, FormulaId } from "./schema.ts";

export type Formula = Readonly<{
  id: FormulaId;
  title: string;
  text: string;
  mathml: string;
}>;

const N = (value: string): string => row(mi("N"), paren(value));
const d1 = sub(mi("d"), mn("1"));
const d2 = sub(mi("d"), mn("2"));
const sigma = mi("σ");
const T = mi("T");

const BASE_FORMULAS: Readonly<Record<BaseFormulaId, Formula>> = {
  blackScholes: {
    id: "blackScholes",
    title: "Black-Scholes call price",
    text: "C = S N(d1) - K e^(-rT) N(d2); d1 = [ln(S/K) + (r + σ²/2)T] / (σ√T); d2 = d1 - σ√T",
    mathml: math(
      row(
        mi("C"),
        mo("="),
        mi("S"),
        N(d1),
        mo("−"),
        mi("K"),
        sup(mi("e"), row(mo("−"), mi("r"), T)),
        N(d2),
        mo(","),
        mo("&#x2003;"),
        d1,
        mo("="),
        frac(
          row(
            mi("ln"),
            paren(frac(mi("S"), mi("K"))),
            mo("+"),
            paren(row(mi("r"), mo("+"), frac(sup(sigma, mn("2")), mn("2")))),
            T
          ),
          row(sigma, sqrt(T))
        )
      )
    ),
  },
  delta: {
    id: "delta",
    title: "Delta",
    text: "Δ_call = N(d1); Δ_put = N(d1) - 1",
    mathml: math(
      row(
        sub(mi("Δ"), mi("call")),
        mo("="),
        N(d1),
        mo(","),
        mo("&#x2003;"),
        sub(mi("Δ"), mi("put")),
        mo("="),
        N(d1),
        mo("−"),
        mn("1")
      )
    ),
  },
  gamma: {
    id: "gamma",
    title: "Gamma",
    text: "Γ = φ(d1) / (S σ √T)",
    mathml: math(
      row(
        mi("Γ"),
        mo("="),
        frac(row(mi("φ"), paren(d1)), row(mi("S"), sigma, sqrt(T)))
      )
    ),
  },
  theta: {
    id: "theta",
    title: "Theta (per day)",
    text: "Θ_call = [-S φ(d1) σ / (2√T) - r K e^(-rT) N(d2)] / 365",
    mathml: math(
      row(
        sub(mi("Θ"), mi("call")),
        mo("="),
        frac(
          row(
            mo("−"),
            frac(
              row(mi("S"), mi("φ"), paren(d1), sigma),
              row(mn("2"), sqrt(T))
            ),
            mo("−"),
            mi("r"),
            mi("K"),
            sup(mi("e"), row(mo("−"), mi("r"), T)),
            N(d2)
          ),
          mn("365")
        )
      )
    ),
  },
  vega: {
    id: "vega",
    title: "Vega (per IV point)",
    text: "ν = S φ(d1) √T / 100",
    mathml: math(
      row(
        mi("ν"),
        mo("="),
        frac(row(mi("S"), mi("φ"), paren(d1), sqrt(T)), mn("100"))
      )
    ),
  },
  putCallParity: {
    id: "putCallParity",
    title: "Put-call parity",
    text: "C - P = S - K e^(-rT)",
    mathml: math(
      row(
        mi("C"),
        mo("−"),
        mi("P"),
        mo("="),
        mi("S"),
        mo("−"),
        mi("K"),
        sup(mi("e"), row(mo("−"), mi("r"), T))
      )
    ),
  },
  breakevenCall: {
    id: "breakevenCall",
    title: "Long call breakeven",
    text: "BE = K + premium paid",
    mathml: math(row(mi("BE"), mo("="), mi("K"), mo("+"), mi("premium"))),
  },
  breakevenPut: {
    id: "breakevenPut",
    title: "Short put breakeven",
    text: "BE = K - premium received",
    mathml: math(row(mi("BE"), mo("="), mi("K"), mo("−"), mi("premium"))),
  },
  verticalMaxProfit: {
    id: "verticalMaxProfit",
    title: "Debit spread max profit",
    text: "Max profit = (K2 - K1) x 100 - debit; max loss = debit",
    mathml: math(
      row(
        mi("max"),
        mo("="),
        paren(row(sub(mi("K"), mn("2")), mo("−"), sub(mi("K"), mn("1")))),
        mo("×"),
        mn("100"),
        mo("−"),
        mi("debit")
      )
    ),
  },
  expectedMove: {
    id: "expectedMove",
    title: "Expected move (1σ)",
    text: "EM = S σ √(days / 365)",
    mathml: math(
      row(mi("EM"), mo("="), mi("S"), sigma, sqrt(frac(mi("days"), mn("365"))))
    ),
  },
  probabilityOfProfit: {
    id: "probabilityOfProfit",
    title: "Probability of profit",
    text: "POP = P(P&L at expiry > 0) under a lognormal price with volatility σ",
    mathml: math(
      row(
        mi("POP"),
        mo("="),
        mi("P"),
        paren(row(mi("P&amp;L"), paren(sub(mi("S"), T)), mo("&gt;"), mn("0")))
      )
    ),
  },
  expectedValue: {
    id: "expectedValue",
    title: "Expected value",
    text: "EV = ∫ P&L(S_T) f(S_T) dS_T",
    mathml: math(
      row(
        mi("EV"),
        mo("="),
        mo("∫"),
        mi("P&amp;L"),
        paren(sub(mi("S"), T)),
        mi("f"),
        paren(sub(mi("S"), T)),
        mi("d"),
        sub(mi("S"), T)
      )
    ),
  },
  realizedVol: {
    id: "realizedVol",
    title: "Realized volatility (20-day)",
    text: "RV = stdev(ln(P_t / P_t-1)) x √252",
    mathml: math(
      row(
        mi("RV"),
        mo("="),
        mi("stdev"),
        paren(
          row(
            mi("ln"),
            frac(
              sub(mi("P"), mi("t")),
              sub(mi("P"), row(mi("t"), mo("−"), mn("1")))
            )
          )
        ),
        mo("×"),
        sqrt(mn("252"))
      )
    ),
  },
  vrp: {
    id: "vrp",
    title: "Volatility risk premium",
    text: "VRP = IV - RV; IV/RV > 1 means option sellers are paid more than recent movement",
    mathml: math(row(mi("VRP"), mo("="), mi("IV"), mo("−"), mi("RV"))),
  },
  gex: {
    id: "gex",
    title: "Gamma exposure per strike",
    text: "GEX = Γ x OI x 100 x S² x 1% (calls +, puts -)",
    mathml: math(
      row(
        mi("GEX"),
        mo("="),
        mi("Γ"),
        mo("×"),
        mi("OI"),
        mo("×"),
        mn("100"),
        mo("×"),
        sup(mi("S"), mn("2")),
        mo("×"),
        mn("0.01")
      )
    ),
  },
  kelly: {
    id: "kelly",
    title: "Kelly fraction",
    text: "f* = W - (1 - W) / R",
    mathml: math(
      row(
        sup(mi("f"), mo("*")),
        mo("="),
        mi("W"),
        mo("−"),
        frac(row(mn("1"), mo("−"), mi("W")), mi("R"))
      )
    ),
  },
  recovery: {
    id: "recovery",
    title: "Gain needed after a loss",
    text: "G = 1 / (1 - L) - 1",
    mathml: math(
      row(
        mi("G"),
        mo("="),
        frac(mn("1"), row(mn("1"), mo("−"), mi("L"))),
        mo("−"),
        mn("1")
      )
    ),
  },
  positionSize: {
    id: "positionSize",
    title: "Position size from risk budget",
    text: "contracts = floor(NLV x risk% / max loss per contract)",
    mathml: math(
      row(
        mi("n"),
        mo("="),
        mo("⌊"),
        frac(row(mi("NLV"), mo("×"), mi("risk%")), mi("max loss per contract")),
        mo("⌋")
      )
    ),
  },
  extrinsic: {
    id: "extrinsic",
    title: "Extrinsic value",
    text: "extrinsic = option price - intrinsic value",
    mathml: math(
      row(mi("extrinsic"), mo("="), mi("price"), mo("−"), mi("intrinsic"))
    ),
  },
  annualizedYield: {
    id: "annualizedYield",
    title: "Annualized premium yield",
    text: "yield = premium / capital x 365 / days",
    mathml: math(
      row(
        mi("yield"),
        mo("="),
        frac(mi("premium"), mi("capital")),
        mo("×"),
        frac(mn("365"), mi("days"))
      )
    ),
  },
};

export const FORMULAS: Readonly<Record<FormulaId, Formula>> = {
  ...BASE_FORMULAS,
  ...PROCESS_FORMULAS,
  ...GROWTH_FORMULAS,
  ...PORTFOLIO_FORMULAS,
  ...STATISTICS_FORMULAS,
  ...TESTING_FORMULAS,
  ...VOLATILITY_FORMULAS,
  ...TRADING_FORMULAS,
  ...OPTIONS_FORMULAS,
};
