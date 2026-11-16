"use client";

import {
  createApiClient,
  type ApiClient,
  type BasketCreateInput,
  type BasketOutput,
  type BasketUpdateInput,
  type BasketValuationOutput,
} from "@darkfactory/api";

export interface BasketGateway {
  readonly list: () => Promise<BasketOutput[]>;
  readonly create: (input: BasketCreateInput) => Promise<BasketOutput>;
  readonly update: (input: BasketUpdateInput) => Promise<BasketOutput>;
  readonly remove: (id: string) => Promise<void>;
  readonly valuation: (id: string) => Promise<BasketValuationOutput>;
}

export const createBasketGateway = (client: ApiClient): BasketGateway => ({
  list: async () => (await client.baskets.list({})).items,
  create: (input) => client.baskets.create(input),
  update: (input) => client.baskets.update(input),
  remove: async (id) => {
    await client.baskets.remove({ id });
    return;
  },
  valuation: (id) => client.baskets.valuation({ id }),
});

export const createBrowserBasketGateway = (): BasketGateway => {
  let gateway: BasketGateway | undefined;
  const current = (): BasketGateway => {
    gateway ??= createBasketGateway(
      createApiClient({ baseUrl: window.location.origin })
    );
    return gateway;
  };
  return Object.freeze({
    list: () => current().list(),
    create: (input: BasketCreateInput) => current().create(input),
    update: (input: BasketUpdateInput) => current().update(input),
    remove: (id: string) => current().remove(id),
    valuation: (id: string) => current().valuation(id),
  });
};

export const describeBasketFailure = (
  error: unknown,
  nowMs: number = Date.now()
): string => {
  const code =
    typeof error === "object" && error !== null
      ? Reflect.get(error, "code")
      : null;
  const message =
    typeof error === "object" && error !== null
      ? Reflect.get(error, "message")
      : null;
  switch (code) {
    case "UNAUTHORIZED": {
      return "Session expired. Sign in again.";
    }
    case "FORBIDDEN": {
      return "Operator access required.";
    }
    case "NOT_FOUND": {
      return "Basket no longer exists. Reload the list.";
    }
    case "CONFLICT": {
      return "A basket with this symbol already exists.";
    }
    case "VALIDATION_ERROR":
    case "BAD_REQUEST": {
      return `Rejected: ${typeof message === "string" && message !== "" ? message : "invalid input"}`;
    }
    case "STORAGE_ERROR": {
      // The server names the cause and time; the fallback covers a bare 503.
      if (typeof message === "string" && message !== "") return message;
      return `Basket storage error (503) at ${clockTime(nowMs)}. Reload to check whether the change was saved.`;
    }
    default: {
      return "Request failed. Retry.";
    }
  }
};

// Equal weights with 8 decimals; the last member takes the rounding remainder so the sum is exactly 1.
export const equalWeights = (count: number): string[] => {
  if (count <= 0) return [];
  const each = Math.floor(100_000_000 / count);
  const last = 100_000_000 - each * (count - 1);
  return Array.from({ length: count }, (_, index) =>
    ((index === count - 1 ? last : each) / 100_000_000).toFixed(8)
  );
};

// Missing values name their cause; callers pass it because only they know why the value is null.
export const formatIndex = (
  value: number | null,
  missing = "no value"
): string => {
  return value === null ? missing : value.toFixed(2);
};

export const formatPct = (
  value: number | null,
  missing = "no previous close"
): string => {
  if (value === null) return missing;
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
};

// "14:05" local clock time for status lines.
export const clockTime = (ms: number): string =>
  new Date(ms).toLocaleTimeString("en-US", {
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
  });

// Index cell text for a basket valuation. latest null: failed request, or no member prices yet.
export const basketValueText = (
  latest: BasketValuationOutput["latest"],
  failed: boolean
): string => {
  if (latest === null)
    return failed
      ? "valuation failed · reload to retry"
      : "no value · no prices for members yet";
  return `${formatIndex(latest.value)} (${formatPct(latest.changePct)})`;
};

const FAILURE_CAUSE: Readonly<Record<string, string>> = {
  FORBIDDEN: "operator access required",
  STORAGE_ERROR: "storage error (503)",
  UNAUTHORIZED: "session expired",
};

// Short cause for a status badge; the full sentence comes from describeBasketFailure.
export const basketFailureCause = (error: unknown): string => {
  const code =
    typeof error === "object" && error !== null
      ? Reflect.get(error, "code")
      : null;
  if (typeof code !== "string") return "request failed";
  return FAILURE_CAUSE[code] ?? code.toLowerCase().replaceAll("_", " ");
};

type ValuationMember = BasketValuationOutput["members"][number];

// Why a member has no last close, return or contribution.
export const memberMissingText = (member: ValuationMember): string => {
  if (member.lastDate === null) return "no close";
  if (member.stale) return `stale since ${member.lastDate}`;
  return "no base close";
};

// Return needs a base close; without one, say so before any last-close cause.
export const memberReturnMissingText = (member: ValuationMember): string =>
  member.basePrice === null ? "no base close" : memberMissingText(member);

// Contribution also needs a valued basket.
export const memberContributionMissingText = (
  member: ValuationMember,
  basketValued: boolean
): string => {
  if (member.basePrice === null) return "no base close";
  if (!basketValued) return "basket not valued yet";
  return memberMissingText(member);
};

// "Last close 2026-11-13." or why there is none yet.
export const lastCloseText = (data: BasketValuationOutput): string => {
  if (data.latest !== null) return `Last close ${data.latest.date}.`;
  if (data.unavailable.length > 0)
    return `No daily close: history request failed for ${data.unavailable
      .map((entry) => entry.symbol)
      .join(", ")}. Reload to retry.`;
  if (data.staleSymbols.length > 0)
    return `No daily close: no close yet for ${data.staleSymbols.join(", ")}.`;
  return "No daily close received yet.";
};
