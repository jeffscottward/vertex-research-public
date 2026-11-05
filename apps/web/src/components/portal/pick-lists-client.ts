"use client";

import {
  type ApiClient,
  createApiClient,
  type PickListImportMethod,
  type PickListOutput,
  type PickListScreenOutput,
  type PickListScreenStatus,
} from "@darkfactory/api";

/** Output of pickLists.syncBucket (packages/api/src/contracts/pick-lists.ts). */
export type PickListBucketResult = Readonly<{
  list: PickListOutput;
  basketId: string;
  memberCount: number;
  omitted: readonly string[];
}>;

export interface PickListGateway {
  readonly list: () => Promise<PickListOutput[]>;
  readonly screen: (id: string) => Promise<PickListScreenOutput>;
  readonly syncBucket: (
    id: string,
    bucketSymbol: string
  ) => Promise<PickListBucketResult>;
}

export const createPickListGateway = (client: ApiClient): PickListGateway => ({
  list: async () => (await client.pickLists.list({})).items,
  screen: (id) => client.pickLists.screen({ id }),
  syncBucket: (id, bucketSymbol) =>
    client.pickLists.syncBucket({ id, bucketSymbol }),
});

export const createBrowserPickListGateway = (): PickListGateway => {
  let gateway: PickListGateway | undefined;
  const current = (): PickListGateway => {
    gateway ??= createPickListGateway(
      createApiClient({ baseUrl: window.location.origin })
    );
    return gateway;
  };
  return Object.freeze({
    list: () => current().list(),
    screen: (id: string) => current().screen(id),
    syncBucket: (id: string, bucketSymbol: string) =>
      current().syncBucket(id, bucketSymbol),
  });
};

export const describePickListFailure = (error: unknown): string => {
  const code =
    typeof error === "object" && error !== null
      ? Reflect.get(error, "code")
      : null;
  switch (code) {
    case "UNAUTHORIZED": {
      return "Session expired. Sign in again.";
    }
    case "FORBIDDEN": {
      return "Operator access required.";
    }
    case "NOT_FOUND": {
      return "Pick list no longer exists. Reload the page.";
    }
    case "CONFLICT": {
      return "Another basket already uses this symbol. Choose another.";
    }
    case "VALIDATION_ERROR":
    case "BAD_REQUEST": {
      return "Rejected: invalid input.";
    }
    case "STORAGE_ERROR": {
      return "Pick list storage unavailable (503).";
    }
    default: {
      return "Request failed. Retry.";
    }
  }
};

/** Default bucket symbol: the slug's letters and digits, uppercased, at most 10. */
export const defaultBucketSymbol = (slug: string): string =>
  slug
    .toUpperCase()
    .replaceAll(/[^A-Z0-9]/gu, "")
    .slice(0, 10);

export const METHOD_LABELS: Readonly<Record<PickListImportMethod, string>> = {
  adapter: "Adapter import",
  manual: "Manual import",
};

export const STATUS_LABELS: Readonly<Record<PickListScreenStatus, string>> = {
  fail: "Fail",
  pass: "Pass",
  unknown: "Unknown",
};
