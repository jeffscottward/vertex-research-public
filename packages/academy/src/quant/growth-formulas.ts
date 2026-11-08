// What: Formulas of the growth quant lessons: MathML for the formula panel and a plain-text form.
import type { Formula } from "../formulas.ts";
import { frac, math, mi, mn, mo, paren, row, sub, sup } from "../mathml.ts";
import type { GrowthFormulaId } from "./growth-ids.ts";

const sigma = mi("σ");

export const GROWTH_FORMULAS: Readonly<Record<GrowthFormulaId, Formula>> = {
  logReturn: {
    id: "logReturn",
    mathml: math(
      row(
        sub(mi("r"), mi("t")),
        mo("="),
        mi("ln"),
        paren(
          frac(
            sub(mi("P"), mi("t")),
            sub(mi("P"), row(mi("t"), mo("−"), mn("1")))
          )
        )
      )
    ),
    text: "r = ln(P_t / P_(t−1)); log returns add up: Σ r = ln(P_T / P_0)",
    title: "Log return",
  },
  presentValue: {
    id: "presentValue",
    mathml: math(
      row(
        mi("PV"),
        mo("="),
        frac(mi("FV"), sup(paren(row(mn("1"), mo("+"), mi("r"))), mi("n")))
      )
    ),
    text: "PV = FV / (1 + r)^n, the mirror of FV = PV × (1 + r)^n",
    title: "Present value (discounting)",
  },
  volDrag: {
    id: "volDrag",
    mathml: math(
      row(
        mi("g"),
        mo("≈"),
        mi("μ"),
        mo("−"),
        frac(sup(sigma, mn("2")), mn("2"))
      )
    ),
    text: "g ≈ μ − σ² / 2: money compounds at the average return minus half the variance",
    title: "Volatility drag",
  },
};
