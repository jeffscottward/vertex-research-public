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

export const describeBasketFailure = (error: unknown): string => {
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
      return "Basket storage unavailable (503).";
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

export const formatIndex = (value: number | null): string => {
  return value === null ? "—" : value.toFixed(2);
};

export const formatPct = (value: number | null): string => {
  if (value === null) return "—";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
};
