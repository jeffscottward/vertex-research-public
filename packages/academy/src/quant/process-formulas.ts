// What: Formulas of the process quant lessons: MathML for the formula panel and a plain-text form.
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
import type { ProcessFormulaId } from "./process-ids.ts";

const sigma = mi("σ");
const mu = mi("μ");
const theta = mi("θ");
const S0 = sub(mi("S"), mn("0"));
const St = sub(mi("S"), mi("t"));
const Xt = sub(mi("X"), mi("t"));
const E = (value: string): string => row(mi("E"), paren(value));

export const PROCESS_FORMULAS: Readonly<Record<ProcessFormulaId, Formula>> = {
  gbm: {
    id: "gbm",
    mathml: math(
      row(
        St,
        mo("="),
        S0,
        sup(
          mi("e"),
          row(
            paren(row(mu, mo("−"), frac(sup(sigma, mn("2")), mn("2")))),
            mi("t"),
            mo("+"),
            sigma,
            sub(mi("W"), mi("t"))
          )
        ),
        mo(","),
        mo(" "),
        E(St),
        mo("="),
        S0,
        sup(mi("e"), row(mu, mi("t")))
      )
    ),
    text: "S_t = S_0 · e^((μ - σ²/2)t + σW_t); mean S_0·e^(μt), median S_0·e^((μ - σ²/2)t)",
    title: "Geometric Brownian motion",
  },
  normalPdf: {
    id: "normalPdf",
    mathml: math(
      row(
        mi("f"),
        paren(mi("x")),
        mo("="),
        frac(mn("1"), row(sigma, sqrt(row(mn("2"), mi("π"))))),
        sup(
          mi("e"),
          row(
            mo("−"),
            frac(
              sup(paren(row(mi("x"), mo("−"), mi("m"))), mn("2")),
              row(mn("2"), sup(sigma, mn("2")))
            )
          )
        )
      )
    ),
    text: "f(x) = 1/(σ√(2π)) · e^(-(x - m)² / (2σ²)); about 68% within 1σ, 95% within 2σ, 99.7% within 3σ",
    title: "Normal (bell curve) density",
  },
  ornsteinUhlenbeck: {
    id: "ornsteinUhlenbeck",
    mathml: math(
      row(
        mi("dX"),
        mo("="),
        mo("−"),
        theta,
        mi("X"),
        mi("dt"),
        mo("+"),
        sigma,
        mi("dW"),
        mo(","),
        mo(" "),
        E(Xt),
        mo("="),
        sub(mi("X"), mn("0")),
        sup(mi("e"), row(mo("−"), theta, mi("t"))),
        mo(","),
        mo(" "),
        sub(mi("t"), frac(mn("1"), mn("2"))),
        mo("="),
        frac(row(mi("ln"), mn("2")), theta)
      )
    ),
    text: "dX = -θ·X·dt + σ·dW (X = distance from the long-run mean); E[X_t] = X_0·e^(-θt); half-life = ln 2 / θ",
    title: "Ornstein-Uhlenbeck mean reversion",
  },
  randomWalk: {
    id: "randomWalk",
    mathml: math(
      row(
        sub(mi("S"), mi("n")),
        mo("="),
        S0,
        mo("+"),
        sub(mi("X"), mn("1")),
        mo("+"),
        mo("…"),
        mo("+"),
        sub(mi("X"), mi("n")),
        mo(","),
        mo(" "),
        E(sub(mi("S"), mi("n"))),
        mo("="),
        S0,
        mo("+"),
        mi("n"),
        mu
      )
    ),
    text: "S_n = S_0 + X_1 + ... + X_n; E[S_n] = S_0 + n·μ (μ = expected value of one step, the drift or edge)",
    title: "Random walk and its drift",
  },
  sqrtTime: {
    id: "sqrtTime",
    mathml: math(
      row(
        sub(sigma, mi("n")),
        mo("="),
        sigma,
        sqrt(mi("n")),
        mo(","),
        mo(" "),
        sub(sigma, mi("year")),
        mo("="),
        sub(sigma, mi("day")),
        sqrt(mn("252"))
      )
    ),
    text: "σ(n) = σ·√n: the spread of a sum of n independent steps grows with √n; yearly vol = daily vol × √252",
    title: "Square-root-of-time rule",
  },
};
