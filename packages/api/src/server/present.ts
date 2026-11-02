// Fail-closed replacement for TypeScript non-null assertions on values that a
// prior check, schema or fixed-arity structure already guarantees. A violated
// expectation throws instead of silently propagating `undefined`/`null`.
export const present = <T>(value: T | null | undefined): T => {
  if (value === null || value === undefined) {
    throw new TypeError("Expected value is absent");
  }
  return value;
};
