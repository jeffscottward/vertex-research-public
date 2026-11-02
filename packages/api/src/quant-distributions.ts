// Probability distributions for the backtest statistics (Student t, chi-square, standard normal).
// Pure functions with no dependencies. Accuracy targets: about 1e-10 relative for the special
// functions (Numerical Recipes, 3rd ed., sections 6.1, 6.2 and 6.4) and 1e-9 for the normal quantile.

const ITERATIONS = 300;
const EPSILON = 1e-15;
const TINY = 1e-300;

// Lentz guard: replaces a value whose magnitude is below TINY to avoid division by zero.
export const avoidZero = (value: number): number =>
  Math.abs(value) < TINY ? TINY : value;

// Lanczos approximation (g = 7, n = 9) of ln Gamma(x) for x > 0.
const LANCZOS = [
  0.999_999_999_999_809_9, 676.520_368_121_885_1, -1259.139_216_722_402_8,
  771.323_428_777_653_1, -176.615_029_162_140_6, 12.507_343_278_686_905,
  -0.138_571_095_265_720_12, 9.984_369_578_019_572e-6,
  1.505_632_735_149_311_6e-7,
] as const;

export const logGamma = (x: number): number => {
  if (x < 0.5) {
    // Reflection formula.
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  }
  const shifted = x - 1;
  const series = LANCZOS.slice(1).reduce<number>(
    (total, coefficient, index) => total + coefficient / (shifted + index + 1),
    LANCZOS[0]
  );
  const t = shifted + 7.5;
  return (
    0.5 * Math.log(2 * Math.PI) +
    (shifted + 0.5) * Math.log(t) -
    t +
    Math.log(series)
  );
};

// Continued fraction for the incomplete beta function (modified Lentz method).
const betaContinuedFraction = (x: number, a: number, b: number): number => {
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 / avoidZero(1 - (qab * x) / qap);
  let h = d;
  for (let m = 1; m <= ITERATIONS; m += 1) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 / avoidZero(1 + aa * d);
    c = avoidZero(1 + aa / c);
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 / avoidZero(1 + aa * d);
    c = avoidZero(1 + aa / c);
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < EPSILON) break;
  }
  return h;
};

// Regularized incomplete beta I_x(a, b) for 0 <= x <= 1 and a, b > 0.
export const regularizedBeta = (x: number, a: number, b: number): number => {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(
    logGamma(a + b) -
      logGamma(a) -
      logGamma(b) +
      a * Math.log(x) +
      b * Math.log(1 - x)
  );
  return x < (a + 1) / (a + b + 2)
    ? (front * betaContinuedFraction(x, a, b)) / a
    : 1 - (front * betaContinuedFraction(1 - x, b, a)) / b;
};

// Regularized upper incomplete gamma Q(a, x) = 1 - P(a, x) for a > 0 and x >= 0.
export const regularizedGammaQ = (a: number, x: number): number => {
  if (x <= 0) return 1;
  const logFront = -x + a * Math.log(x) - logGamma(a);
  if (x < a + 1) {
    // Series for P(a, x).
    let term = 1 / a;
    let total = term;
    for (let n = 1; n <= ITERATIONS; n += 1) {
      term *= x / (a + n);
      total += term;
      if (Math.abs(term) < Math.abs(total) * EPSILON) break;
    }
    return 1 - total * Math.exp(logFront);
  }
  // Continued fraction for Q(a, x) (modified Lentz method).
  let b = x + 1 - a;
  let c = 1 / TINY;
  let d = 1 / b;
  let h = d;
  for (let n = 1; n <= ITERATIONS; n += 1) {
    const an = -n * (n - a);
    b += 2;
    d = 1 / avoidZero(an * d + b);
    c = avoidZero(b + an / c);
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < EPSILON) break;
  }
  return Math.exp(logFront) * h;
};

// Student t cumulative distribution with df > 0 degrees of freedom.
export const studentTCdf = (t: number, df: number): number => {
  const tail = 0.5 * regularizedBeta(df / (df + t * t), df / 2, 0.5);
  return t >= 0 ? 1 - tail : tail;
};

// Student t quantile by bisection on the CDF (monotone); 0 < p < 1.
export const studentTQuantile = (p: number, df: number): number => {
  if (!(p > 0 && p < 1))
    throw new RangeError("Quantile probability must be in (0, 1)");
  let low = -1e6;
  let high = 1e6;
  for (let step = 0; step < 200; step += 1) {
    const middle = (low + high) / 2;
    if (studentTCdf(middle, df) < p) {
      low = middle;
    } else high = middle;
    if (high - low < 1e-12 * Math.max(1, Math.abs(middle))) break;
  }
  return (low + high) / 2;
};

// Chi-square upper tail P(X >= x) with k > 0 degrees of freedom.
export const chiSquareSurvival = (x: number, k: number): number =>
  regularizedGammaQ(k / 2, x / 2);

// Standard normal CDF through the complementary error function: erfc(z) = Q(1/2, z^2) for z >= 0.
export const normalCdfPrecise = (x: number): number => {
  const tail = 0.5 * regularizedGammaQ(0.5, (x * x) / 2);
  return x >= 0 ? 1 - tail : tail;
};

// Standard normal quantile (Acklam's rational approximation, relative error below 1.15e-9).
const A = [
  -39.696_830_286_653_76, 220.946_098_424_520_5, -275.928_510_446_968_7,
  138.357_751_867_269, -30.664_798_066_147_16, 2.506_628_277_459_239,
] as const;
const B = [
  -54.476_098_798_224_06, 161.585_836_858_040_9, -155.698_979_859_886_6,
  66.801_311_887_719_72, -13.280_681_552_885_72,
] as const;
const C = [
  -0.007_784_894_002_430_293, -0.322_396_458_041_136_4, -2.400_758_277_161_838,
  -2.549_732_539_343_734, 4.374_664_141_464_968, 2.938_163_982_698_783,
] as const;
const D = [
  0.007_784_695_709_041_462, 0.322_467_129_070_039_8, 2.445_134_137_142_996,
  3.754_408_661_907_416,
] as const;
const P_LOW = 0.024_25;

export const normalQuantile = (p: number): number => {
  if (!(p > 0 && p < 1))
    throw new RangeError("Quantile probability must be in (0, 1)");
  if (p < P_LOW) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((C[0] * q + C[1]) * q + C[2]) * q + C[3]) * q + C[4]) * q + C[5]) /
      ((((D[0] * q + D[1]) * q + D[2]) * q + D[3]) * q + 1)
    );
  }
  if (p > 1 - P_LOW) return -normalQuantile(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return (
    ((((((A[0] * r + A[1]) * r + A[2]) * r + A[3]) * r + A[4]) * r + A[5]) *
      q) /
    (((((B[0] * r + B[1]) * r + B[2]) * r + B[3]) * r + B[4]) * r + 1)
  );
};
