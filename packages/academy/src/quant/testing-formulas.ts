// What: Formulas of the testing quant lessons: MathML for the formula panel and a plain-text form.
import type { Formula } from "../formulas.ts";
import {
  accent,
  frac,
  math,
  mi,
  mn,
  mo,
  paren,
  row,
  space,
  sqrt,
  sub,
  sup,
} from "../mathml.ts";
import type { TestingFormulaId } from "./testing-ids.ts";

export const TESTING_FORMULAS: Readonly<Record<TestingFormulaId, Formula>> = {
  dataSnooping: {
    id: "dataSnooping",
    mathml: math(
      row(
        mi("E"),
        paren(row(mi("max"), space(), mi("SR"))),
        mo("≈"),
        sub(mi("σ"), mi("SR")),
        sup(mi("Φ"), row(mo("−"), mn("1"))),
        paren(
          frac(
            row(mi("N"), mo("−"), mn("0.375")),
            row(mi("N"), mo("+"), mn("0.25"))
          )
        ),
        mo("≤"),
        sub(mi("σ"), mi("SR")),
        sqrt(row(mn("2"), mi("ln"), space(), mi("N"))),
        mo(","),
        sub(mi("σ"), mi("SR")),
        mo("≈"),
        frac(mn("1"), sqrt(mi("T")))
      )
    ),
    text: "E[max SR] ≈ σ_SR · Φ⁻¹((N − 0.375)/(N + 0.25)) (Blom) ≤ σ_SR · √(2 ln N) (upper bound, large N), with σ_SR ≈ 1/√years",
    title: "Expected best Sharpe of N zero-edge rules",
  },
  tStat: {
    id: "tStat",
    mathml: math(
      row(
        mi("t"),
        mo("="),
        frac(accent(mi("r"), "¯"), row(mi("s"), mo("/"), sqrt(mi("n")))),
        mo("≈"),
        mi("SR"),
        mo("·"),
        sqrt(mi("T"))
      )
    ),
    text: "t = mean / standard error ≈ SR × √years; p = 2·(1 − Φ(|t|))",
    title: "t-statistic of a Sharpe ratio",
  },
};
