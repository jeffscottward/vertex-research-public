// What: Tiny MathML builders for the formula library (formulas.ts and the quant formula files).

export const mi = (value: string): string => `<mi>${value}</mi>`;
export const mo = (value: string): string => `<mo>${value}</mo>`;
export const mn = (value: string): string => `<mn>${value}</mn>`;
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
