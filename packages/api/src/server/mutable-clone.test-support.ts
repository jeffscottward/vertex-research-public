// Test-only: deep-frozen Vertex artifacts are typed DeepReadonly. Fixtures that
// deliberately corrupt or re-derive a copy need a writable structured clone.
export type DeepMutable<T> = T extends
  | ((...args: never[]) => unknown)
  | Date
  | RegExp
  | Uint8Array
  | Map<unknown, unknown>
  | Set<unknown>
  ? T
  : T extends ReadonlyArray<infer U>
    ? DeepMutable<U>[]
    : T extends object
      ? { -readonly [K in keyof T]: DeepMutable<T[K]> }
      : T;

export const mutableClone = <T>(value: T): DeepMutable<T> =>
  structuredClone(value) as unknown as DeepMutable<T>;
