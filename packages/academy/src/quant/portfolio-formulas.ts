// What: Formulas of the portfolio quant lessons: MathML for the formula panel and a plain-text form.
import type { Formula } from "../formulas.ts";
import {
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
import type { PortfolioFormulaId } from "./portfolio-ids.ts";

const sigma = mi("σ");
const rho = mi("ρ");
const rf = sub(mi("r"), mi("f"));
const sum = (index: string): string => sub(mo("∑"), mi(index));
const expected = (body: string): string => row(mi("E"), mo("["), body, mo("]"));
const Ri = sub(mi("R"), mi("i"));
const Sigma = mi("Σ");
const w = mi("w");
const wT = sup(w, mi("T"));
const gap = space("1em");

export const PORTFOLIO_FORMULAS: Readonly<Record<PortfolioFormulaId, Formula>> =
  {
    apt: {
      id: "apt",
      mathml: math(
        row(
          expected(Ri),
          mo("="),
          rf,
          mo("+"),
          sum("k"),
          sub(mi("β"), mi("ik")),
          sub(mi("λ"), mi("k"))
        )
      ),
      text: "E[R_i] = r_f + Σ_k β_ik λ_k (same exposures β, same expected return: otherwise long one, short the other is an arbitrage)",
      title: "Arbitrage pricing theory",
    },
    blackLitterman: {
      id: "blackLitterman",
      mathml: math(
        row(
          mi("Π"),
          mo("="),
          mi("δ"),
          Sigma,
          w,
          mo(","),
          gap,
          mi("μ"),
          mo("="),
          mi("Π"),
          mo("+"),
          mi("τ"),
          Sigma,
          sup(mi("P"), mi("T")),
          sup(
            paren(
              row(
                mi("P"),
                mi("τ"),
                Sigma,
                sup(mi("P"), mi("T")),
                mo("+"),
                mi("Ω")
              )
            ),
            row(mo("−"), mn("1"))
          ),
          paren(row(mi("Q"), mo("−"), mi("P"), mi("Π")))
        )
      ),
      text: "Π = δΣw; μ = Π + τΣPᵀ(PτΣPᵀ + Ω)⁻¹(Q − PΠ)",
      title: "Black-Litterman implied and posterior returns",
    },
    capm: {
      id: "capm",
      mathml: math(
        row(
          expected(Ri),
          mo("="),
          rf,
          mo("+"),
          sub(mi("β"), mi("i")),
          paren(row(expected(sub(mi("R"), mi("m"))), mo("−"), rf))
        )
      ),
      text: "E[R_i] = r_f + β_i (E[R_m] - r_f)",
      title: "CAPM security market line",
    },
    correlation: {
      id: "correlation",
      mathml: math(
        row(
          sub(rho, mi("XY")),
          mo("="),
          frac(
            row(mi("Cov"), paren(row(mi("X"), mo(","), mi("Y")))),
            row(sub(sigma, mi("X")), sub(sigma, mi("Y")))
          )
        )
      ),
      text: "ρ_XY = Cov(X, Y) / (σ_X σ_Y), always between -1 and +1",
      title: "Correlation",
    },
    diversification: {
      id: "diversification",
      mathml: math(
        row(
          sub(sigma, mi("N")),
          mo("="),
          sigma,
          sqrt(row(rho, mo("+"), frac(row(mn("1"), mo("−"), rho), mi("N")))),
          gap,
          mo("≥"),
          sigma,
          sqrt(rho)
        )
      ),
      text: "σ_N = σ √(ρ + (1 - ρ)/N) ≥ σ √ρ (N equal-weight assets with volatility σ and pairwise correlation ρ)",
      title: "Diversification and the systematic floor",
    },
    portfolioVariance: {
      id: "portfolioVariance",
      mathml: math(
        row(
          sup(sub(sigma, mi("p")), mn("2")),
          mo("="),
          wT,
          Sigma,
          w,
          mo("="),
          sum("i"),
          sum("j"),
          sub(w, mi("i")),
          sub(w, mi("j")),
          sub(sigma, mi("i")),
          sub(sigma, mi("j")),
          sub(rho, mi("ij"))
        )
      ),
      text: "σ_p² = wᵀΣw = Σ_i Σ_j w_i w_j σ_i σ_j ρ_ij",
      title: "Portfolio variance",
    },
    riskParity: {
      id: "riskParity",
      mathml: math(
        row(
          sub(mi("RC"), mi("i")),
          mo("="),
          frac(
            row(sub(w, mi("i")), sub(paren(row(Sigma, w)), mi("i"))),
            sup(sub(sigma, mi("p")), mn("2"))
          ),
          mo(","),
          gap,
          sub(w, mi("i")),
          mo("="),
          frac(
            frac(mn("1"), sub(sigma, mi("i"))),
            row(sum("j"), frac(mn("1"), sub(sigma, mi("j"))))
          )
        )
      ),
      text: "RC_i = w_i (Σw)_i / σ_p² (shares add to 100%); inverse volatility: w_i = (1/σ_i) / Σ_j (1/σ_j)",
      title: "Risk contribution and risk parity",
    },
    sharpe: {
      id: "sharpe",
      mathml: math(
        row(
          mi("S"),
          mo("="),
          frac(row(sub(mi("R"), mi("p")), mo("−"), rf), sub(sigma, mi("p")))
        )
      ),
      text: "S = (R_p - r_f) / σ_p, the slope of the line from the risk-free rate through the portfolio",
      title: "Sharpe ratio",
    },
  };
