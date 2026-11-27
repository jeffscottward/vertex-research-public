// What: Request database admission per isolate: a cap, FIFO waiters, and leases that end at a maximum age.
// Used by: packages/db/src/server/client.ts#createRequestDatabase.
// See: docs/debugging.md#symptom--where-to-look (DATABASE_CAPACITY, request-database.slot-reclaimed);
// docs/vertex-rebuild/designs/vertex-web-request-slot-leak-cancel/plan.md (Fix D).

/** Concurrent request database clients per isolate. */
export const REQUEST_DATABASE_POOL_MAX_CONNECTIONS = 8;

/** How long a request waits for a released slot before RequestDatabaseCapacityError. */
export const REQUEST_DATABASE_CAPACITY_WAIT_MILLISECONDS = 2000;

/**
 * A request holds its slot at most this long: then it ends its own client (client.ts). Longer
 * than every live request seen on QuantVPS (sectorRotation/collect 299 s) and than an order
 * placement (two order-bridge calls of 160 s each plus 30 s, `vertex-orders.ts#PLACEMENT_LEASE_MS`
 * = 350 s).
 */
export const REQUEST_DATABASE_SLOT_MAX_AGE_MILLISECONDS = 420_000;

/**
 * Another request takes a slot back when it is this old: its owner did not end it at the
 * maximum age, so the owner's request context has ended (its timers never run). In workerd a
 * request cannot end another request's socket; a context that ended takes its sockets with it.
 */
export const REQUEST_DATABASE_SLOT_RECLAIM_AFTER_MILLISECONDS =
  REQUEST_DATABASE_SLOT_MAX_AGE_MILLISECONDS + 10_000;

// A waiter whose own wait timer is this late has a request context that ended: skip it.
const STALE_WAITER_MARGIN_MILLISECONDS = 1000;

/** One taken slot. */
export interface RequestSlotLease {
  readonly route: string;
  readonly acquiredAt: number;
  released: boolean;
}

/** What a reclaim reports: the route of the lease and how old it was. */
export type RequestSlotReclaim = Readonly<{
  route: string;
  ageSeconds: number;
}>;

export type AcquireRequestSlotOptions = Readonly<{
  /** URL path of the request (no query); reported when its lease is reclaimed. */
  route: string;
  /** Receives each reclaim this acquisition makes; runs in the acquiring request. Must not throw. */
  onReclaim: (reclaim: RequestSlotReclaim) => void;
}>;

interface Waiter {
  readonly route: string;
  readonly since: number;
  settled: boolean;
  readonly grant: (lease: RequestSlotLease) => void;
  /** Ends the wait without a slot (the request then answers DATABASE_CAPACITY). */
  readonly expire: () => void;
}

const leases = new Set<RequestSlotLease>();
const waiters: Waiter[] = [];

const takeSlot = (route: string, now: number): RequestSlotLease => {
  const lease: RequestSlotLease = { acquiredAt: now, released: false, route };
  leases.add(lease);
  return lease;
};

// A freed slot goes to the first waiter whose request still runs; with none, it stays free.
const handOff = (now: number): void => {
  for (;;) {
    const next = waiters.shift();
    if (next === undefined) return;
    next.settled = true;
    const late =
      now - next.since >
      REQUEST_DATABASE_CAPACITY_WAIT_MILLISECONDS +
        STALE_WAITER_MARGIN_MILLISECONDS;
    // Its own timer did not run: in workerd its request context ended and could never use the
    // slot. A live request whose timer only ran late gets null (DATABASE_CAPACITY) instead of
    // waiting for good; for an ended context the resolution is dropped.
    if (late) {
      next.expire();
      continue;
    }
    next.grant(takeSlot(next.route, now));
    return;
  }
};

/** Frees the slot once; a later call (for example a late close of a reclaimed lease) does nothing. */
export const releaseRequestSlot = (lease: RequestSlotLease): void => {
  if (lease.released) return;
  lease.released = true;
  leases.delete(lease);
  handOff(Date.now());
};

// Takes back every lease that its owner did not end in time (see
// REQUEST_DATABASE_SLOT_RECLAIM_AFTER_MILLISECONDS).
const reclaimStale = (
  now: number,
  onReclaim: AcquireRequestSlotOptions["onReclaim"]
): void => {
  for (const lease of leases) {
    const age = now - lease.acquiredAt;
    if (age < REQUEST_DATABASE_SLOT_RECLAIM_AFTER_MILLISECONDS) continue;
    // `onReclaim` must not throw (client.ts reports through a guarded diagnostic sink).
    onReclaim({ ageSeconds: Math.floor(age / 1000), route: lease.route });
    releaseRequestSlot(lease);
  }
};

/**
 * Takes a slot, or waits FIFO for one up to REQUEST_DATABASE_CAPACITY_WAIT_MILLISECONDS.
 * Resolves the lease, or null when the wait ended without a slot. Stale leases are reclaimed
 * first, and again when the wait ends.
 */
export const acquireRequestSlot = (
  options: AcquireRequestSlotOptions
): Promise<RequestSlotLease | null> => {
  const now = Date.now();
  reclaimStale(now, options.onReclaim);
  // A free slot means no waiter: a release hands its slot straight to the first one.
  if (leases.size < REQUEST_DATABASE_POOL_MAX_CONNECTIONS) {
    return Promise.resolve(takeSlot(options.route, now));
  }
  // Executor form: the ES2023 lib has no Promise.withResolvers.
  return new Promise((resolve) => {
    const waiter: Waiter = {
      expire: () => {
        clearTimeout(timer);
        resolve(null);
      },
      grant: (lease) => {
        // From another request this clearTimeout does nothing in workerd; `settled` covers it.
        clearTimeout(timer);
        resolve(lease);
      },
      route: options.route,
      settled: false,
      since: now,
    };
    const timer = setTimeout(() => {
      if (waiter.settled) return;
      // A lease may have passed the maximum age while this request waited.
      reclaimStale(Date.now(), options.onReclaim);
      if (waiter.settled) return;
      waiter.settled = true;
      const index = waiters.indexOf(waiter);
      if (index !== -1) waiters.splice(index, 1);
      resolve(null);
    }, REQUEST_DATABASE_CAPACITY_WAIT_MILLISECONDS);
    waiters.push(waiter);
  });
};

/** Test seam: forgets every lease and waiter of this isolate. */
export const resetRequestSlotsForTesting = (): void => {
  leases.clear();
  waiters.length = 0;
};
