// What: Formulas of the volatility quant lessons: MathML for the formula panel and a plain-text form.
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
import type { VolatilityFormulaId } from "./volatility-ids.ts";

const sigma = mi("σ");
const alpha = mi("α");
const beta = mi("β");
const gamma = mi("γ");
const omega = mi("ω");
const nu = mi("ν");
const gap = mo("&#x2003;");
const sigmaToday = sup(sub(sigma, mi("t")), mn("2"));
/** Hat accent (estimate) over a symbol. */
const hat = (base: string): string => `<mover>${base}<mo>^</mo></mover>`;
const rSq = sup(sub(mi("r"), mi("t")), mn("2"));
const sigmaNext = sup(sub(sigma, row(mi("t"), mo("+"), mn("1"))), mn("2"));
const zAlpha = sub(mi("z"), alpha);
const varAlpha = sub(mi("VaR"), alpha);

export const VOLATILITY_FORMULAS: Readonly<
  Record<VolatilityFormulaId, Formula>
> = {
  expectedShortfall: {
    id: "expectedShortfall",
    mathml: math(
      row(
        sub(mi("ES"), alpha),
        mo("="),
        mo("−"),
        mi("E"),
        paren(row(mi("r"), mo("|"), mi("r"), mo("≤"), mo("−"), varAlpha)),
        mo(","),
        gap,
        mi("bell curve:"),
        sub(mi("ES"), alpha),
        mo("="),
        frac(row(sigma, mi("φ"), paren(zAlpha)), row(mn("1"), mo("−"), alpha))
      )
    ),
    text: "ES_α = −E[r | r ≤ −VaR_α]: the average loss on the days beyond the VaR line; bell curve: ES_α = σ φ(z_α) / (1 − α)",
    title: "Expected shortfall (average loss beyond VaR)",
  },
  garch: {
    id: "garch",
    mathml: math(
      row(
        sigmaNext,
        mo("="),
        omega,
        mo("+"),
        alpha,
        rSq,
        mo("+"),
        beta,
        sigmaToday,
        mo(","),
        gap,
        sup(sigma, mn("2")),
        mo("="),
        frac(omega, row(mn("1"), mo("−"), alpha, mo("−"), beta))
      )
    ),
    text: "σ²_(t+1) = ω + α r_t² + β σ_t²; long-run variance σ² = ω / (1 − α − β); extra variance decays by (α + β) each day",
    title: "GARCH(1,1) variance forecast",
  },
  gjrGarch: {
    id: "gjrGarch",
    mathml: math(
      row(
        sigmaNext,
        mo("="),
        omega,
        mo("+"),
        paren(row(alpha, mo("+"), gamma, sub(mi("I"), mi("t")))),
        rSq,
        mo("+"),
        beta,
        sigmaToday,
        mo(","),
        gap,
        sub(mi("I"), mi("t")),
        mo("="),
        mn("1"),
        mi("if"),
        sub(mi("r"), mi("t")),
        mo("<"),
        mn("0")
      )
    ),
    text: "σ²_(t+1) = ω + (α + γ I_t) r_t² + β σ_t², I_t = 1 after a down day and 0 otherwise; stable when α + β + γ/2 < 1",
    title: "GJR-GARCH (down days raise volatility more)",
  },
  kalman: {
    id: "kalman",
    mathml: math(
      row(
        sub(hat(mi("x")), mi("t")),
        mo("="),
        sub(hat(mi("x")), row(mi("t"), mo("−"), mn("1"))),
        mo("+"),
        sub(mi("K"), mi("t")),
        paren(
          row(
            sub(mi("y"), mi("t")),
            mo("−"),
            sub(hat(mi("x")), row(mi("t"), mo("−"), mn("1")))
          )
        ),
        mo(","),
        gap,
        sub(mi("K"), mi("t")),
        mo("="),
        frac(
          row(sub(mi("P"), row(mi("t"), mo("−"), mn("1"))), mo("+"), mi("Q")),
          row(
            sub(mi("P"), row(mi("t"), mo("−"), mn("1"))),
            mo("+"),
            mi("Q"),
            mo("+"),
            mi("R")
          )
        )
      )
    ),
    text: "x̂_t = x̂_(t−1) + K_t (y_t − x̂_(t−1)), K_t = (P_(t−1) + Q) / (P_(t−1) + Q + R), P_t = (1 − K_t)(P_(t−1) + Q); Q = process noise variance, R = measurement noise variance",
    title: "Kalman filter (local level)",
  },
  studentT: {
    id: "studentT",
    mathml: math(
      row(
        mi("f"),
        paren(mi("x")),
        mo("="),
        frac(
          row(mi("Γ"), paren(frac(row(nu, mo("+"), mn("1")), mn("2")))),
          row(sqrt(row(nu, mi("π"))), mi("Γ"), paren(frac(nu, mn("2"))))
        ),
        sup(
          paren(row(mn("1"), mo("+"), frac(sup(mi("x"), mn("2")), nu))),
          row(mo("−"), frac(row(nu, mo("+"), mn("1")), mn("2")))
        ),
        mo(","),
        gap,
        mi("Var"),
        mo("="),
        frac(nu, row(nu, mo("−"), mn("2")))
      )
    ),
    text: "f(x) = Γ((ν+1)/2) / (√(νπ) Γ(ν/2)) · (1 + x²/ν)^(−(ν+1)/2); variance ν / (ν − 2), so x is scaled by σ √((ν − 2)/ν) to match a daily vol σ",
    title: "Student t density (fat tails)",
  },
  valueAtRisk: {
    id: "valueAtRisk",
    mathml: math(
      row(
        mi("P"),
        paren(row(mi("r"), mo("<"), mo("−"), varAlpha)),
        mo("="),
        mn("1"),
        mo("−"),
        alpha,
        mo(","),
        gap,
        mi("bell curve:"),
        varAlpha,
        mo("="),
        zAlpha,
        sigma
      )
    ),
    text: "P(r < −VaR_α) = 1 − α: only a share 1 − α of days lose more than VaR_α; bell curve: VaR_α = z_α σ (z_99% = 2.33)",
    title: "Value at risk",
  },
  volTarget: {
    id: "volTarget",
    mathml: math(
      row(
        sub(mi("w"), mi("t")),
        mo("="),
        mi("min"),
        paren(
          row(
            frac(sub(sigma, mi("target")), sub(hat(sigma), mi("t"))),
            mo(","),
            sub(mi("L"), mi("max"))
          )
        ),
        mo(","),
        gap,
        sub(mi("r"), row(mi("t"), mo(","), mi("targeted"))),
        mo("="),
        sub(mi("w"), mi("t")),
        sub(mi("r"), mi("t"))
      )
    ),
    text: "exposure w_t = min(σ_target / σ̂_t, L_max), set before the day from the forecast σ̂_t; the targeted return is w_t r_t (10% target / 20% forecast = 50%)",
    title: "Volatility targeting exposure",
  },
};
