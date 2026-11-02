import type {
  Candle,
  Quote,
  TradeFlow,
  VolumeProfile,
  SourceIdentity,
} from "@darkfactory/api/vertex";
import type { DeepReadonly } from "@darkfactory/shared/vertex";
import type { VertexStudyId } from "./vertex-studies.ts";

// Presentation-only ports. These are not wire contracts, broker authority, or a BFF.
export interface ChartRecords {
  quotes: Quote;
  candles: Candle;
  "trade-flow": TradeFlow;
  "volume-profile": VolumeProfile;
}
export type ChartKind = keyof ChartRecords;
export type ExactChartRecord<K extends ChartKind = ChartKind> = DeepReadonly<
  ChartRecords[K]
>;
export type ChartSelection<K extends ChartKind = ChartKind> = Readonly<{
  kind: K;
  instrumentId: string;
  currency: string;
  provider: string;
  sourceId: string;
  // Required for candles; null for observations that do not have a bar interval.
  interval: Candle["interval"] | null;
  // Supplied by the authenticated data owner; never guessed from timestamps.
  calendar: string;
  sessionLabel: string;
  // Missing means unavailable. A human-readable label is never session proof.
  sessionMembership?: "verified" | "unavailable";
  // Host-projected current server policy, never inferred from read permission.
  derivationRights?: "granted" | "unavailable";
  derivationExpiresAt?: string | null;
  quantityUnit: string;
}>;
export type ChartPhase =
  | "loading"
  | "live"
  | "snapshot"
  | "empty"
  | "disconnected"
  | "gap"
  | "backpressure"
  | "error"
  | "unavailable";

export type ChartView<K extends ChartKind = ChartKind> = Readonly<{
  selection: ChartSelection<K>;
  phase: ChartPhase | "stale" | "rights-unavailable" | "unknown";
  reason: string;
  records: readonly ExactChartRecord<K>[];
  sources: readonly SourceIdentity[];
  transport: ChartPhase;
  freshness: "fresh" | "stale" | "unknown" | "missing";
  evaluatedAt: string;
  asOf: string | null;
  synthetic: boolean;
  retained: number;
  withheld: number;
  evicted: number;
  snapshotId: string | null;
  sequence: string | null;
  // False for every view. Numeric coordinates are never exact trading inputs.
  tradingAuthority: false;
}>;
export type DisplayCandle = Readonly<{
  id: string;
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}>;
export type ChartPalette = Readonly<{
  foreground: string;
  background: string;
  grid: string;
  rising: string;
  falling: string;
  accent: string;
}>;
export type CandleRendererOptions = Readonly<{
  palette: ChartPalette;
  pricePrecision: number;
  volumePrecision: number;
  signal: AbortSignal;
}>;
// Optional built-in studies drawn by the renderer itself (display only).
export type ChartStudies = Readonly<{
  volume: boolean;
  sma: readonly number[];
  ema: readonly number[];
  // Vertex-computed studies (indicator-math.ts). Missing means none.
  extra?: readonly VertexStudyId[];
}>;
// Point annotation at a candle time (ms) and price; text is short display copy.
export type ChartMarker = Readonly<{
  id: string;
  timestamp: number;
  value: number;
  text: string;
}>;
export type CandleRenderer = Readonly<{
  replace: (candles: readonly DisplayCandle[]) => void;
  resize: () => void;
  dispose: () => void;
  setStudies?: (studies: ChartStudies) => void;
  setMarkers?: (markers: readonly ChartMarker[]) => void;
}>;
export type CandleRendererFactory = (
  element: HTMLElement,
  options: CandleRendererOptions
) => Promise<CandleRenderer>;

export type IndicatorRequest = Readonly<{
  kind: "sma" | "ema" | "vwap" | "rsi";
  period: number;
}>;
export type IndicatorPoint = Readonly<{
  candleId: string;
  timestamp: string;
  // Derived decimal, rounded down at 18 places. Original candle remains untouched.
  value: string;
}>;
export type IndicatorSeries = Readonly<{
  request: IndicatorRequest;
  points: readonly IndicatorPoint[];
  warmup: number;
  method: string;
  inputSources: readonly SourceIdentity[];
  status: "available" | "unavailable";
  reason: string;
  tradingAuthority: false;
}>;
