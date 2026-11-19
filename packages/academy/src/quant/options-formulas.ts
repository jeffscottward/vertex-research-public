// What: Formulas of the options quant lessons: MathML for the formula panel and a plain-text form.
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
  sup,
} from "../mathml.ts";
import type { OptionsFormulaId } from "./options-ids.ts";

const sigma = mi("σ");
const dt = row(mi("Δ"), mi("t"));
const gap = space("1em");

const zi = sub(mi("z"), mi("i"));
const payoffOf = (draw: string): string => row(mi("Y"), paren(draw));

export const OPTIONS_FORMULAS: Readonly<Record<OptionsFormulaId, Formula>> = {
  antithetic: {
    id: "antithetic",
    mathml: math(
      row(
        sub(mi("P"), mi("i")),
        mo("="),
        frac(row(payoffOf(zi), mo("+"), payoffOf(row(mo("−"), zi))), mn("2")),
        mo(","),
        gap,
        mtext("SE"),
        mo("="),
        frac(sub(mi("s"), mi("P")), sqrt(row(mi("N"), mo("/"), mn("2"))))
      )
    ),
    text: "P_i = (Y(z_i) + Y(-z_i)) / 2; estimate = average of the N/2 pair averages P_i; error bar = stdev(P) / √(N/2)",
    title: "Mirrored paths (antithetic variates)",
  },
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
            sub(mi("V"), mtext("up")),
            mo("+"),
            paren(row(mn("1"), mo("−"), mi("p"))),
            sub(mi("V"), mtext("down"))
          )
        )
      )
    ),
    text: "u = e^(σ√Δt), d = 1/u, p = (e^(rΔt) - d) / (u - d); each node V = e^(-rΔt) [p V_up + (1 - p) V_down], walking back from the payoffs at expiry. Valid only while d < e^(rΔt) < u, i.e. σ > |r|√Δt: otherwise p falls outside 0-1 and the tree allows arbitrage",
    title: "Binomial tree (Cox-Ross-Rubinstein)",
  },
  controlVariate: {
    id: "controlVariate",
    mathml: math(
      row(
        sub(mi("C"), mi("i")),
        mo("="),
        sub(mi("Y"), mi("i")),
        mo("−"),
        mi("β"),
        paren(
          row(
            sub(mi("X"), mi("i")),
            mo("−"),
            row(mi("E"), mo("["), mi("X"), mo("]"))
          )
        ),
        mo(","),
        gap,
        mi("β"),
        mo("="),
        frac(
          row(mtext("cov"), paren(row(mi("Y"), mo(","), mi("X")))),
          row(mtext("var"), paren(mi("X")))
        )
      )
    ),
    text: "C_i = Y_i - β (X_i - E[X]), β = cov(Y, X) / var(X); estimate = average of C_i; error bar = stdev(C) / √N; here X = discounted stock price and E[X] = today's price",
    title: "Control variate",
  },
  gammaPnl: {
    id: "gammaPnl",
    mathml: math(
      row(
        mtext("P&amp;L"),
        mo("≈"),
        frac(mn("1"), mn("2")),
        mi("Γ"),
        sup(mi("S"), mn("2")),
        paren(
          row(
            sup(sub(sigma, mtext("imp")), mn("2")),
            mo("−"),
            sup(sub(sigma, mtext("real")), mn("2"))
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
        sub(mi("C"), mtext("BS")),
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
            sub(sigma, mtext("imp"))
          )
        ),
        mo("="),
        sub(mi("C"), mtext("market")),
        mo(","),
        gap,
        sigma,
        mo("="),
        frac(
          row(sub(sigma, mtext("low")), mo("+"), sub(sigma, mtext("high"))),
          mn("2")
        )
      )
    ),
    text: "Find σ_imp with C_BS(S, K, r, T, σ_imp) = C_market. Bisection: try σ = (σ_low + σ_high) / 2; if C_BS(σ) is below the market price the answer is higher (σ_low = σ), else lower (σ_high = σ). Defined only for prices inside the no-arbitrage bounds max(S - Ke^(-rT), 0) ≤ C_market < S",
    title: "Implied volatility (bisection)",
  },
};
