// biome-ignore-all lint/suspicious/noBitwiseOperators: IEEE 754 bit work (exponent scaling and integer splits) of the correctly rounded exp, log and erf.
/**
 * The floating-point primitives the options engine needs to match the Python reference
 * (services/research/strategies/qc_ports) bit for bit.
 *
 * - `exp`, `log`, `erf`, `erfc`: correctly rounded, evaluated in double-double arithmetic
 *   (about 100 bits) and rounded once. CPython calls the C library: glibc 2.41+ erf and erfc are
 *   correctly rounded (CORE-MATH), so these agree with it on every input; glibc exp and log are
 *   accurate to about 0.51 ulp, so these agree except on the rare inputs (under 0.1%) where glibc
 *   itself is not correctly rounded, and then differ by one ulp. V8's Math.exp and Math.log
 *   (fdlibm) differ from glibc on about 10% of inputs, so they are not used.
 * - `pyRound`: CPython round(x, ndigits) (correctly rounded decimal, ties to even).
 * - `roundHalfEven`: CPython round(x) of a float (ties to even; -0 becomes 0, an int in Python).
 * - `pySum`: CPython 3.12+ sum() of floats (Neumaier compensated summation from the int 0).
 *
 * The double-double operations write their result to the module registers H + L (no
 * allocation: erfc runs hundreds of them per call). They assume operands below 2^996 in
 * magnitude (no overflow in Dekker's split); every caller here stays far below.
 */

const SPLITTER = 134_217_729; // 2^27 + 1
const LN2_HI = Math.LN2;
const LN2_MID = 2.319_046_813_846_299_6e-17;
const LN2_LO = 5.707_708_438_416_212e-34;
const INV_LN2 = Math.LOG2E;
const INV_SQRT_PI_HI = 0.564_189_583_547_756_3;
const INV_SQRT_PI_LO = 7.667_729_806_582_94e-18;
const TWO_OVER_SQRT_PI_HI = 1.128_379_167_095_512_6;
const TWO_OVER_SQRT_PI_LO = 1.533_545_961_316_588e-17;
/** Above this |x| erf and erfc use the continued fraction instead of the Taylor series. */
const SERIES_LIMIT = 2.5;
const EXP_HALVINGS = 9; // exp reduces its argument by 2^9 before the Taylor series
const EXP_TERMS = 9;
const ATANH_TERMS = 22;
const TINY_TERM = 2 ** -110;
const MIN_NORMAL_EXPONENT = -1022;

/** Result registers of the double-double operations: the value is H + L, |L| <= ulp(H) / 2. */
let H = 0;
let L = 0;

/** Low part of a * b (Dekker): a * b = fl(a * b) + productError(a, b) exactly. */
const productError = (a: number, b: number, p: number): number => {
  const ca = SPLITTER * a;
  const ah = ca - (ca - a);
  const al = a - ah;
  const cb = SPLITTER * b;
  const bh = cb - (cb - b);
  const bl = b - bh;
  return ah * bh - p + ah * bl + al * bh + al * bl;
};

/** H + L = round-to-double-double of s + e, given |s| >= |e| or s = 0. */
const normalize = (s: number, e: number): void => {
  H = s + e;
  L = e - (H - s);
};

const add = (ah: number, al: number, bh: number, bl: number): void => {
  const s = ah + bh;
  let v = s - ah;
  const e = ah - (s - v) + (bh - v);
  const t = al + bl;
  v = t - al;
  const f = al - (t - v) + (bl - v);
  normalize(s, e + t);
  normalize(H, L + f);
};

const mul = (ah: number, al: number, bh: number, bl: number): void => {
  const p = ah * bh;
  normalize(p, productError(ah, bh, p) + (ah * bl + al * bh));
};

const divD = (ah: number, al: number, d: number): void => {
  const q = ah / d;
  const p = q * d;
  normalize(q, (ah - p - productError(q, d, p) + al) / d);
};

const div = (ah: number, al: number, bh: number, bl: number): void => {
  const q = ah / bh;
  const p = q * bh;
  normalize(q, (ah - p - productError(q, bh, p) + al - q * bl) / bh);
};

const bits = new DataView(new ArrayBuffer(8));

/** 2^k for an integer k in [-1022, 1023]. */
const pow2 = (k: number): number => {
  bits.setUint32(0, (k + 1023) << 20);
  bits.setUint32(4, 0);
  return bits.getFloat64(0);
};

/** x * 2^k without intermediate overflow or underflow, for a result in the normal range. */
const scale = (x: number, k: number): number => {
  if (k > 1023) return x * pow2(1023) * pow2(k - 1023);
  if (k < MIN_NORMAL_EXPONENT)
    return x * pow2(MIN_NORMAL_EXPONENT) * pow2(k - MIN_NORMAL_EXPONENT);
  return x * pow2(k);
};

/** Unbiased binary exponent of a positive normal double. */
const exponentOf = (x: number): number => {
  bits.setFloat64(0, x);
  return ((bits.getUint32(0) >>> 20) & 0x7_ff) - 1023;
};

/**
 * Rounds the positive value (hi + lo) * 2^k (hi + lo normalized) to the nearest double, ties to
 * even, rounding once also in the subnormal range. Exported for its tests (exact ties).
 */
export const ldexpRound = (hi: number, lo: number, k: number): number => {
  if (exponentOf(hi) + k >= MIN_NORMAL_EXPONENT) return scale(hi, k);
  // Subnormal: count in units of 2^-1074 (both scaled parts stay normal, so exact).
  const shift = k + 1074;
  const wh = scale(hi, shift);
  const wl = scale(lo, shift);
  const whole = Math.floor(wh);
  const above = wh - whole - 0.5; // exact; |wl| is below half an ulp of wh
  const up =
    above > 0 || (above === 0 && (wl > 0 || (wl === 0 && whole % 2 === 1)));
  return (whole + (up ? 1 : 0)) * Number.MIN_VALUE;
};

/** 1/n! as double-doubles (hi at 2n, lo at 2n + 1). */
const INV_FACTORIALS = new Float64Array(2 * (EXP_TERMS + 1));
/** 1/(2n + 1) as double-doubles. */
const ATANH_COEFFICIENTS = new Float64Array(2 * (ATANH_TERMS + 1));
for (let n = 0, factorial = 1; n <= EXP_TERMS; n++) {
  factorial *= Math.max(n, 1);
  divD(1, 0, factorial);
  INV_FACTORIALS[2 * n] = H;
  INV_FACTORIALS[2 * n + 1] = L;
}
for (let n = 0; n <= ATANH_TERMS; n++) {
  divD(1, 0, 2 * n + 1);
  ATANH_COEFFICIENTS[2 * n] = H;
  ATANH_COEFFICIENTS[2 * n + 1] = L;
}

/**
 * e^(xh + xl) = (H + L) * 2^k with H + L in [0.7, 1.5], for |xh| below 746; returns k.
 * Reduction x = k ln2 + r with ln2 in three parts, then e^(r / 512) by its Taylor series and
 * nine squarings in the e^s - 1 form (no cancellation near 0).
 */
const expScaled = (xh: number, xl: number): number => {
  const k = Math.round(xh * INV_LN2);
  let p = k * LN2_HI;
  add(xh, xl, -p, -productError(k, LN2_HI, p));
  p = k * LN2_MID;
  add(H, L, -p, -productError(k, LN2_MID, p));
  add(H, L, -k * LN2_LO, 0);
  const sh = H / 2 ** EXP_HALVINGS;
  const sl = L / 2 ** EXP_HALVINGS;
  H = INV_FACTORIALS[2 * EXP_TERMS] as number;
  L = INV_FACTORIALS[2 * EXP_TERMS + 1] as number;
  for (let n = EXP_TERMS - 1; n >= 1; n--) {
    mul(H, L, sh, sl);
    add(
      H,
      L,
      INV_FACTORIALS[2 * n] as number,
      INV_FACTORIALS[2 * n + 1] as number
    );
  }
  mul(H, L, sh, sl); // e^s - 1
  for (let n = 0; n < EXP_HALVINGS; n++) {
    const mh = H;
    const ml = L;
    add(mh, ml, 2, 0);
    mul(mh, ml, H, L); // e^2s - 1 = (e^s - 1)(e^s + 1)
  }
  add(1, 0, H, L);
  return k;
};

/** Correctly rounded e^x. */
export const exp = (x: number): number => {
  if (Number.isNaN(x)) return Number.NaN;
  if (x > 709.8) return Number.POSITIVE_INFINITY;
  if (x < -745.2) return 0;
  const k = expScaled(x, 0);
  return ldexpRound(H, L, k);
};

/** Correctly rounded natural logarithm; -Infinity at 0, NaN below 0. */
export const log = (x: number): number => {
  if (!(x > 0)) return x === 0 ? Number.NEGATIVE_INFINITY : Number.NaN;
  if (x === Number.POSITIVE_INFINITY) return x;
  let m = x;
  let e = 0;
  if (m < pow2(MIN_NORMAL_EXPONENT)) {
    m *= 2 ** 54;
    e = -54;
  }
  const exponent = exponentOf(m);
  m = scale(m, -exponent);
  e += exponent;
  if (m > Math.SQRT2) {
    m /= 2;
    e += 1;
  }
  // log(m) = 2 atanh(s), s = (m - 1) / (m + 1), |s| <= 0.172; m - 1 is exact, m + 1 exact as H + L.
  add(m, 0, 1, 0);
  div(m - 1, 0, H, L);
  const sh = H;
  const sl = L;
  mul(sh, sl, sh, sl);
  const s2h = H;
  const s2l = L;
  H = ATANH_COEFFICIENTS[2 * ATANH_TERMS] as number;
  L = ATANH_COEFFICIENTS[2 * ATANH_TERMS + 1] as number;
  for (let n = ATANH_TERMS - 1; n >= 0; n--) {
    mul(H, L, s2h, s2l);
    add(
      H,
      L,
      ATANH_COEFFICIENTS[2 * n] as number,
      ATANH_COEFFICIENTS[2 * n + 1] as number
    );
  }
  mul(H, L, sh, sl);
  const logH = 2 * H;
  const logL = 2 * L;
  let p = e * LN2_HI;
  const eh = p;
  const el = productError(e, LN2_HI, p);
  p = e * LN2_MID;
  add(eh, el, p, productError(e, LN2_MID, p));
  add(H, L, e * LN2_LO, 0);
  add(H, L, logH, logL);
  return H;
};

/** H + L = erf(x) for 0 < |x| <= 2.5 by its Taylor series (cancellation costs at most 20 bits). */
const erfSeries = (x: number): void => {
  const p = x * x;
  const x2h = -p;
  const x2l = -productError(x, x, p);
  let th = x;
  let tl = 0;
  let sh = x;
  let sl = 0;
  for (let n = 1; ; n++) {
    mul(th, tl, x2h, x2l);
    divD(H, L, n);
    th = H;
    tl = L;
    divD(th, tl, 2 * n + 1);
    const term = H;
    add(sh, sl, H, L);
    sh = H;
    sl = L;
    if (Math.abs(term) <= Math.abs(sh) * TINY_TERM) break;
  }
  mul(TWO_OVER_SQRT_PI_HI, TWO_OVER_SQRT_PI_LO, sh, sl);
};

/**
 * erfc(x) = (H + L) * 2^k for 2.5 < x < 28; returns k. e^-x^2 / sqrt(pi) times the continued
 * fraction 1 / (x + (1/2) / (x + 1 / (x + (3/2) / (x + ...)))), evaluated backwards from enough
 * terms (about 130 at x = 2.5, fewer further out).
 */
const erfcTail = (x: number): number => {
  let th = 0;
  let tl = 0;
  for (let n = Math.ceil(340 / x) + 10; n >= 1; n--) {
    add(x, 0, th, tl);
    div(n / 2, 0, H, L);
    th = H;
    tl = L;
  }
  add(x, 0, th, tl);
  div(1, 0, H, L);
  const fh = H;
  const fl = L;
  const p = x * x;
  const k = expScaled(-p, -productError(x, x, p));
  mul(H, L, fh, fl);
  mul(H, L, INV_SQRT_PI_HI, INV_SQRT_PI_LO);
  return k;
};

/** H + L = erfc(x) for 2.5 < x <= 10 (no underflow). */
const erfcTailUnscaled = (x: number): void => {
  const k = erfcTail(x);
  H = scale(H, k);
  L = scale(L, k);
};

/** Correctly rounded complementary error function. */
export const erfc = (x: number): number => {
  if (Number.isNaN(x)) return Number.NaN;
  if (x >= 28) return 0; // erfc(27.3) is below 2^-1075
  if (x <= -10) return 2; // erfc(-6) already rounds to 2
  if (x === 0) return 1;
  if (Math.abs(x) <= SERIES_LIMIT) {
    erfSeries(x);
    add(1, 0, -H, -L);
    return H;
  }
  if (x > 0) {
    const k = erfcTail(x);
    return ldexpRound(H, L, k);
  }
  erfcTailUnscaled(-x);
  add(2, 0, -H, -L);
  return H;
};

/** Correctly rounded error function. */
export const erf = (x: number): number => {
  if (Number.isNaN(x)) return Number.NaN;
  if (x === 0) return x;
  const size = Math.abs(x);
  if (size >= 10) return Math.sign(x);
  if (size <= SERIES_LIMIT) {
    erfSeries(x);
    return H;
  }
  erfcTailUnscaled(size);
  add(1, 0, -H, -L);
  return Math.sign(x) * H;
};

/** CPython round(x) of a float: nearest integer, ties to even (a Python int, so never -0). */
export const roundHalfEven = (x: number): number => {
  const nearest = Math.round(x);
  return (nearest - x === 0.5 && nearest % 2 !== 0 ? nearest - 1 : nearest) + 0;
};

/** CPython round(x, ndigits) for ndigits >= 0: the correctly rounded decimal (ties to even) parsed back. */
export const pyRound = (x: number, ndigits: number): number => {
  if (!Number.isFinite(x) || x === 0) return x;
  bits.setFloat64(0, Math.abs(x));
  const high = bits.getUint32(0);
  const biased = high >>> 20;
  const fraction =
    (BigInt(high & 0xf_ff_ff) << 32n) | BigInt(bits.getUint32(4));
  const mantissa = biased === 0 ? fraction : fraction | (1n << 52n);
  const shift = (biased === 0 ? 1 : biased) - 1075; // |x| = mantissa * 2^shift
  if (shift >= 0) return x; // an integer: nothing to round
  const numerator = mantissa * 10n ** BigInt(ndigits);
  const denominator = 1n << BigInt(-shift);
  let quotient = numerator / denominator;
  const twice = 2n * (numerator - quotient * denominator);
  if (twice > denominator || (twice === denominator && quotient % 2n === 1n))
    quotient += 1n;
  return Number(`${x < 0 ? "-" : ""}${quotient}e-${ndigits}`);
};

/** CPython 3.12+ sum(values) of floats: 0 + first, then Neumaier compensated summation. */
export const pySum = (values: Iterable<number>): number => {
  let total = 0;
  let compensation = 0;
  let first = true;
  for (const value of values) {
    if (first) {
      total = 0 + value;
      first = false;
      continue;
    }
    const next = total + value;
    if (Math.abs(total) >= Math.abs(value))
      compensation += total - next + value;
    else compensation += value - next + total;
    total = next;
  }
  if (compensation !== 0 && Number.isFinite(compensation))
    total += compensation;
  return total;
};
