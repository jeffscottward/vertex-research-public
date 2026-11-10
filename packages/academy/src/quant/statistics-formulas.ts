// What: Formulas of the statistics quant lessons: MathML for the formula panel and a plain-text form.
import type { Formula } from "../formulas.ts";
import { accent, frac, math, mi, mo, row, sub, sup } from "../mathml.ts";
import type { StatisticsFormulaId } from "./statistics-ids.ts";

const excess = (asset: string): string =>
  row(sub(mi("R"), mi(asset)), mo("−"), sub(mi("R"), mi("f")));

export const STATISTICS_FORMULAS: Readonly<
  Record<StatisticsFormulaId, Formula>
> = {
  beta: {
    id: "beta",
    mathml: math(
      row(
        mi("β"),
        mo("="),
        frac(
          row(
            mi("Cov"),
            mo("("),
            sub(mi("R"), mi("i")),
            mo(","),
            sub(mi("R"), mi("m")),
            mo(")")
          ),
          row(mi("Var"), mo("("), sub(mi("R"), mi("m")), mo(")"))
        )
      )
    ),
    text: "beta = Cov(R_i, R_m) / Var(R_m)",
    title: "Market beta",
  },
  factorModel: {
    id: "factorModel",
    mathml: math(
      row(
        excess("i"),
        mo("="),
        mi("α"),
        mo("+"),
        mi("b"),
        mi("MKT"),
        mo("+"),
        mi("s"),
        mi("SMB"),
        mo("+"),
        mi("h"),
        mi("HML"),
        mo("+"),
        mi("m"),
        mi("MOM"),
        mo("+"),
        mi("ε")
      )
    ),
    text: "R_i - R_f = alpha + b MKT + s SMB + h HML (+ m MOM) + e",
    title: "Fama-French and Carhart factor model",
  },
  longShort: {
    id: "longShort",
    mathml: math(
      row(
        sub(mi("F"), mi("t")),
        mo("="),
        sub(accent(mi("R"), "¯"), mi("top")),
        mo("−"),
        sub(accent(mi("R"), "¯"), mi("bottom"))
      )
    ),
    text: "F_t = mean return of the top bucket - mean return of the bottom bucket",
    title: "Long-short factor return",
  },
  regression: {
    id: "regression",
    mathml: math(
      row(
        excess("i"),
        mo("="),
        mi("α"),
        mo("+"),
        mi("β"),
        mo("("),
        excess("m"),
        mo(")"),
        mo("+"),
        mi("ε"),
        mo(","),
        sup(mi("R"), mi("2")),
        mo("="),
        mi("1"),
        mo("−"),
        frac(sub(mi("SS"), mi("res")), sub(mi("SS"), mi("tot")))
      )
    ),
    text: "R_i - R_f = alpha + beta (R_m - R_f) + e; R² = 1 - SS_res / SS_tot",
    title: "Linear regression, alpha and R²",
  },
};
