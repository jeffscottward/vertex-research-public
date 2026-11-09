// What: Tiny MathML builders for the formula library (formulas.ts and the quant formula files).

export const mi = (value: string): string => `<mi>${value}</mi>`;
export const mo = (value: string): string => `<mo>${value}</mo>`;
export const mn = (value: string): string => `<mn>${value}</mn>`;
/** Words inside a formula ("if", "otherwise"): upright text, not italic variables. */
export const mtext = (value: string): string => `<mtext>${value}</mtext>`;
/** Horizontal gap between formula parts (in place of an operator holding a blank). */
export const space = (width = "0.25em"): string =>
  `<mspace width="${width}"></mspace>`;
/** Accent over a symbol (hat for an estimate, bar for a mean). */
export const accent = (base: string, mark: string): string =>
  `<mover accent="true">${base}<mo>${mark}</mo></mover>`;
export const sub = (base: string, index: string): string =>
  `<msub>${base}${index}</msub>`;
export const sup = (base: string, power: string): string =>
  `<msup>${base}${power}</msup>`;
export const frac = (top: string, bottom: string): string =>
  `<mfrac><mrow>${top}</mrow><mrow>${bottom}</mrow></mfrac>`;
export const row = (...parts: string[]): string =>
  `<mrow>${parts.join("")}</mrow>`;
export const sqrt = (value: string): string => `<msqrt>${value}</msqrt>`;
export const paren = (value: string): string => row(mo("("), value, mo(")"));
export const math = (body: string): string =>
  `<math display="block">${body}</math>`;
