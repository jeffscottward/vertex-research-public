// What: the QuantData net drift request bodies (filter profile otm-clean.v1) and the mapper of the
// answer into one-minute buckets. Pure; the collector (server/flow-collect.ts) sends the requests
// and stores the buckets in flow_net_drift. Vendor shape: the answer is keyed by the bucket start in
// epoch milliseconds, with per-bucket (not running) values.
// Doc: docs/vertex-rebuild/flow-pipeline.md.
import { z } from "zod";

import type {
  FlowExpiryPart,
  FlowIndexOptionTicker,
} from "./contracts/flow.ts";

const NET_DRIFT_MAX_BUCKETS = 1500;
const MINUTE_MS = 60_000;

/** The request body of one net drift part for one ticker and New York session date. */
export const netDriftRequest = (
  sessionDate: string,
  ticker: string,
  part: FlowExpiryPart
): Readonly<Record<string, unknown>> => ({
  sessionDate,
  aggregationPeriod: "1m",
  filter: { tickers: [ticker], moneyTypes: ["OTM"] },
  filterExpression: {
    conjunction: "AND",
    filters: [
      { field: "isComplex", operation: "=", value: false },
      { field: "isFloor", operation: "=", value: false },
      { field: "isTied", operation: "=", value: false },
      { field: "isCancelled", operation: "=", value: false },
      ...(part === "zero_dte"
        ? [{ field: "dte", operation: "<", value: 1 }]
        : []),
    ],
  },
});

const NetDriftBucketSchema = z.object({
  netCallPremium: z.number(),
  netPutPremium: z.number(),
  netCallVolume: z.number(),
  netPutVolume: z.number(),
  midMarketCallPremium: z.number().optional(),
  midMarketPutPremium: z.number().optional(),
  stockPrice: z.number().positive().optional(),
});

const NetDriftDataSchema = z
  .record(
    // The bucket start in epoch milliseconds, on a whole minute.
    z
      .string()
      .regex(/^\d{13}$/u)
      .refine((key) => Number(key) % MINUTE_MS === 0, {
        message: "bucket start is not a whole minute",
      }),
    NetDriftBucketSchema
  )
  .refine((data) => Object.keys(data).length <= NET_DRIFT_MAX_BUCKETS, {
    message: `more than ${NET_DRIFT_MAX_BUCKETS} buckets`,
  });

export type FlowNetDriftBucket = Readonly<{
  minute: Date;
  netCallPremium: number;
  netPutPremium: number;
  netCallVolume: number;
  netPutVolume: number;
  underlyingPrice: number | null;
}>;

/** One stored bucket; the property names and types equal those of the repository record. */
export type FlowNetDriftRow = FlowNetDriftBucket &
  Readonly<{
    ticker: FlowIndexOptionTicker;
    part: FlowExpiryPart;
    filterProfile: string;
  }>;

export type FlowNetDriftParse =
  | Readonly<{ ok: true; buckets: readonly FlowNetDriftBucket[] }>
  | Readonly<{ ok: false; message: string }>;

/** Maps a net drift answer to buckets in minute order; the message never holds payload text. */
export const parseNetDrift = (data: unknown): FlowNetDriftParse => {
  const parsed = NetDriftDataSchema.safeParse(data);
  if (!parsed.success) {
    const path = parsed.error.issues
      .slice(0, 1)
      .flatMap((issue) => issue.path.map(String))
      .join(".");
    return {
      message: `net drift answer has an unexpected shape: ${path === "" ? "(root)" : path}`,
      ok: false,
    };
  }
  const buckets = Object.entries(parsed.data)
    .map(([key, bucket]) => ({ bucket, start: Number(key) }))
    .sort((left, right) => left.start - right.start)
    .map(({ bucket, start }) => ({
      minute: new Date(start),
      netCallPremium: bucket.netCallPremium,
      netCallVolume: bucket.netCallVolume,
      netPutPremium: bucket.netPutPremium,
      netPutVolume: bucket.netPutVolume,
      underlyingPrice: bucket.stockPrice ?? null,
    }));
  return { buckets, ok: true };
};

/** Start time of the newest bucket, or null for no bucket. */
export const newestBucketAt = (
  buckets: readonly FlowNetDriftBucket[]
): Date | null => buckets.at(-1)?.minute ?? null;
