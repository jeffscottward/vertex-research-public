// What: Bounds a wait on a promise that another request may own, with a timer of the waiting request.
// Used by: quantdata-client.ts (step turn), options-chain-yahoo.ts (shared session), options-chain.ts (shared chain
// read and shared Nasdaq open-interest read), instant-backtest.ts (shared column load).
// See: docs/vertex-rebuild/designs/vertex-web-request-slot-leak-cancel/plan.md (Design, Layer 1).

/**
 * The outcome of `waitAtMost`: the settled value, or `timedOut` when the wait ended first.
 */
export type BoundedWait<Value> =
  | Readonly<{ timedOut: false; value: Value }>
  | Readonly<{ timedOut: true }>;

/**
 * Waits for `promise` for at most `ms`. The timer belongs to the caller: in workerd a promise that
 * another request started can stay pending for good when that request's context ends (its
 * continuations are dropped and its own timers never fire), so only the waiter's timer is sure to
 * run. A rejection of `promise` inside the time rejects the wait.
 */
export const waitAtMost = <Value>(
  promise: PromiseLike<Value>,
  ms: number
): Promise<BoundedWait<Value>> =>
  // Executor form: the ES2023 lib has no Promise.withResolvers.
  new Promise<BoundedWait<Value>>((resolve, reject) => {
    const timer = setTimeout(() => resolve({ timedOut: true }), ms);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve({ timedOut: false, value });
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
