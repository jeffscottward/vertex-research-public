// What: Formulas of the trading quant lessons: MathML for the formula panel and a plain-text form.
import type { Formula } from "../formulas.ts";
import { frac, math, mi, mn, mo, paren, row, sqrt, sub } from "../mathml.ts";
import type { TradingFormulaId } from "./trading-ids.ts";

const t = mi("t");
const s = (index: string): string => sub(mi("s"), index);
const theta = mi("θ");
const sep = mo("&#x2003;");

export const TRADING_FORMULAS: Readonly<Record<TradingFormulaId, Formula>> = {
  slippage: {
    id: "slippage",
    mathml: math(
      row(
        mi("VWAP"),
        paren(mi("Q")),
        mo("="),
        frac(
          row(mo("∑"), sub(mi("p"), mi("i")), sub(mi("q"), mi("i"))),
          mi("Q")
        ),
        mo(","),
        sep,
        mi("slippage"),
        paren(mi("Q")),
        mo("="),
        mi("VWAP"),
        paren(mi("Q")),
        mo("−"),
        sub(mi("a"), mn("0"))
      )
    ),
    text: "VWAP(Q) = Σ p_i q_i / Q over the ask levels the order takes (q_i shares at price p_i, Σ q_i = Q); slippage(Q) = VWAP(Q) - a_0, the best ask before the order",
    title: "Average fill price and slippage of a market buy",
  },
  walkForward: {
    id: "walkForward",
    mathml: math(
      row(
        sub(mi("θ*"), mi("k")),
        mo("="),
        sub(mi("argmax"), theta),
        sub(mi("SR"), mi("k")),
        paren(theta),
        mo(","),
        sep,
        mi("SR"),
        mo("="),
        sqrt(mn("252")),
        frac(mi("mean(r)"), mi("sd(r)")),
        mo(","),
        sep,
        mi("model in window "),
        mi("k"),
        mo(":"),
        sub(mi("θ*"), row(mi("k"), mo("−"), mn("1")))
      )
    ),
    text: "θ*_k = argmax over θ = (lookback, entry |z|) of SR_k(θ), the annualized Sharpe √252 · mean(r) / sd(r) of daily returns after costs on window k; the model trades θ*_(k-1) in window k, one refit behind the optimum",
    title: "Walk-forward optimization",
  },
  zScore: {
    id: "zScore",
    mathml: math(
      row(
        s(t),
        mo("="),
        sub(mi("b"), t),
        mo("−"),
        mi("β"),
        sub(mi("a"), t),
        mo(","),
        sep,
        sub(mi("z"), t),
        mo("="),
        frac(row(s(t), mo("−"), sub(mi("μ"), t)), sub(mi("σ"), t)),
        mo(","),
        sep,
        mi("enter at "),
        mo("|"),
        mi("z"),
        mo("|"),
        mo("≥"),
        sub(mi("z"), mi("in")),
        mo(","),
        mi(" exit at "),
        mo("|"),
        mi("z"),
        mo("|"),
        mo("≤"),
        sub(mi("z"), mi("out"))
      )
    ),
    text: "s_t = b_t - β·a_t; z_t = (s_t - μ_t) / σ_t with μ_t and σ_t the mean and sd of the spread over the last L days; short the spread at z ≥ z_in, buy it at z ≤ -z_in, close when it returns inside ±z_out",
    title: "Spread z-score and the pairs rule",
  },
};
