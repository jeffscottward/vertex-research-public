// What: Formulas of the options quant lessons: MathML for the formula panel and a plain-text form.
import type { Formula } from "../formulas.ts";
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
} from "../mathml.ts";
import type { OptionsFormulaId } from "./options-ids.ts";

const sigma = mi("σ");
const dt = row(mi("Δ"), mi("t"));
const gap = mo("&#x2003;");

export const OPTIONS_FORMULAS: Readonly<Record<OptionsFormulaId, Formula>> = {
  binomialTree: {
    id: "binomialTree",
    mathml: math(
      row(
        mi("u"),
        mo("="),
        sup(mi("e"), row(sigma, sqrt(dt))),
        mo(","),
        gap,
        mi("d"),
        mo("="),
        frac(mn("1"), mi("u")),
        mo(","),
        gap,
        mi("p"),
        mo("="),
        frac(
          row(sup(mi("e"), row(mi("r"), dt)), mo("−"), mi("d")),
          row(mi("u"), mo("−"), mi("d"))
        ),
        mo(","),
        gap,
        mi("V"),
        mo("="),
        sup(mi("e"), row(mo("−"), mi("r"), dt)),
        paren(
          row(
            mi("p"),
            sub(mi("V"), mi("up")),
            mo("+"),
            paren(row(mn("1"), mo("−"), mi("p"))),
            sub(mi("V"), mi("down"))
          )
        )
      )
    ),
    text: "u = e^(σ√Δt), d = 1/u, p = (e^(rΔt) - d) / (u - d); each node V = e^(-rΔt) [p V_up + (1 - p) V_down], walking back from the payoffs at expiry",
    title: "Binomial tree (Cox-Ross-Rubinstein)",
  },
  gammaPnl: {
    id: "gammaPnl",
    mathml: math(
      row(
        mi("P&amp;L"),
        mo("≈"),
        frac(mn("1"), mn("2")),
        mi("Γ"),
        sup(mi("S"), mn("2")),
        paren(
          row(
            sup(sub(sigma, mi("imp")), mn("2")),
            mo("−"),
            sup(sub(sigma, mi("real")), mn("2"))
          )
        ),
        dt
      )
    ),
    text: "P&L per step of a delta-hedged short option ≈ ½ Γ S² (σ_imp² - σ_real²) Δt: theta income minus the gamma cost of rebalancing",
    title: "Gamma P&L of a delta-hedged short option",
  },
  impliedVol: {
    id: "impliedVol",
    mathml: math(
      row(
        sub(mi("C"), mi("BS")),
        paren(
          row(
            mi("S"),
            mo(","),
            mi("K"),
            mo(","),
            mi("r"),
            mo(","),
            mi("T"),
            mo(","),
            sub(sigma, mi("imp"))
          )
        ),
        mo("="),
        sub(mi("C"), mi("market")),
        mo(","),
        gap,
        sigma,
        mo("="),
        frac(
          row(sub(sigma, mi("low")), mo("+"), sub(sigma, mi("high"))),
          mn("2")
        )
      )
    ),
    text: "Find σ_imp with C_BS(S, K, r, T, σ_imp) = C_market. Bisection: try σ = (σ_low + σ_high) / 2; if C_BS(σ) is below the market price the answer is higher (σ_low = σ), else lower (σ_high = σ)",
    title: "Implied volatility (bisection)",
  },
};
