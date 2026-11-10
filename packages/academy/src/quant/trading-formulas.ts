// What: Formulas of the trading quant lessons: MathML for the formula panel and a plain-text form.
import type { Formula } from "../formulas.ts";
import {
  frac,
  math,
  mi,
  mn,
  mo,
  mtext,
  paren,
  row,
  space,
  sqrt,
  sub,
} from "../mathml.ts";
import type { TradingFormulaId } from "./trading-ids.ts";

const t = mi("t");
const s = (index: string): string => sub(mi("s"), index);
const theta = mi("θ");
const sep = space("1em");
const zIn = sub(mi("z"), mtext("in"));
const zOut = sub(mi("z"), mtext("out"));

export const TRADING_FORMULAS: Readonly<Record<TradingFormulaId, Formula>> = {
  slippage: {
    id: "slippage",
    mathml: math(
      row(
        mtext("VWAP"),
        paren(mi("Q")),
        mo("="),
        frac(
          row(mo("∑"), sub(mi("p"), mi("i")), sub(mi("q"), mi("i"))),
          mi("Q")
        ),
        mo(","),
        sep,
        mtext("slippage"),
        paren(mi("Q")),
        mo("="),
        mtext("VWAP"),
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
        sub(row(mi("θ"), mo("*")), mi("k")),
        mo("="),
        sub(mtext("argmax"), theta),
        sub(mtext("SR"), mi("k")),
        paren(theta),
        mo(","),
        sep,
        mtext("SR"),
        mo("="),
        sqrt(mn("252")),
        frac(mtext("mean(r)"), mtext("sd(r)")),
        mo(","),
        sep,
        mtext("model in window"),
        space(),
        mi("k"),
        mo(":"),
        sub(row(mi("θ"), mo("*")), row(mi("k"), mo("−"), mn("1")))
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
        mtext("short at"),
        space(),
        sub(mi("z"), t),
        mo("≥"),
        zIn,
        mo(","),
        space(),
        mtext("long at"),
        space(),
        sub(mi("z"), t),
        mo("≤"),
        mo("−"),
        zIn,
        mo(","),
        sep,
        mtext("exit short at"),
        space(),
        sub(mi("z"), t),
        mo("≤"),
        zOut,
        mo(","),
        space(),
        mtext("exit long at"),
        space(),
        sub(mi("z"), t),
        mo("≥"),
        mo("−"),
        zOut
      )
    ),
    text: "s_t = b_t - β·a_t; z_t = (s_t - μ_t) / σ_t with μ_t and σ_t the mean and sample sd (n - 1) of the spread over the previous L days, not counting today; short the spread at z ≥ z_in, buy it at z ≤ -z_in; exit a short once z falls to z_out or below, exit a long once z rises to -z_out or above (z crosses back through the exit band on its own side)",
    title: "Spread z-score and the pairs rule",
  },
};
