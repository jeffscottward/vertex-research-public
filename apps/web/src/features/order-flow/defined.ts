/**
 * Array reads the caller has already bounded (noUncheckedIndexedAccess). Throws instead of
 * carrying a fallback value that can never be used.
 */
export const defined = <T>(value: T | undefined, what: string): T => {
  if (value === undefined) throw new Error(`Order flow: missing ${what}`);
  return value;
};
