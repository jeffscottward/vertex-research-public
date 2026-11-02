// Paper deployment request rules: fields, limits, params against a strategy schema and the status
// lifecycle. Pure functions; the repository maps DeploymentRequestInputError to
// InvalidRepositoryInputError. Requests are records only: nothing here (or in the repository) starts,
// routes or submits anything, and an approval never authorizes execution.
import {
  DEPLOYMENT_REQUEST_STATUSES,
  type DeploymentRequestLimits,
  type DeploymentRequestStatus,
  type StrategyParam,
  type StrategyPresetValues,
} from "../schema/index.ts";
import { required as requirePresent } from "./required.ts";
import {
  checkStrategyParamValue,
  StrategyInputError,
} from "./strategy-library.ts";

const DEPLOYMENT_SYMBOL_PATTERN = /^[A-Z0-9][A-Z0-9._/:-]{0,31}$/;
const DEPLOYMENT_TIMEFRAME_PATTERN = /^[1-9][0-9]{0,2}(s|m|h|d|w)$/;
const DEPLOYMENT_NOTE_MAX_LENGTH = 1000;
const DEPLOYMENT_MAX_ORDERS_PER_MINUTE = 1000;
export const DEPLOYMENT_LIMIT_KEYS = [
  "maxOrderSize",
  "maxPosition",
  "maxOrdersPerMinute",
  "dailyLossLimit",
] as const;

export const DEPLOYMENT_REQUEST_ACTIONS = [
  "submit",
  "approve",
  "reject",
  "withdraw",
] as const;
export type DeploymentRequestAction =
  (typeof DEPLOYMENT_REQUEST_ACTIONS)[number];

// Allowed source statuses per action. rejected and withdrawn are terminal.
export const DEPLOYMENT_REQUEST_TRANSITIONS: Readonly<
  Record<
    DeploymentRequestAction,
    Readonly<{
      from: readonly DeploymentRequestStatus[];
      to: DeploymentRequestStatus;
    }>
  >
> = Object.freeze({
  submit: { from: ["draft"], to: "requested" },
  approve: { from: ["requested"], to: "approved" },
  reject: { from: ["requested"], to: "rejected" },
  withdraw: { from: ["draft", "requested", "approved"], to: "withdrawn" },
});

const CONTROL_CHARACTER_PATTERN = /\p{Cc}/u;

export class DeploymentRequestInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeploymentRequestInputError";
  }
}

const fail: (message: string) => never = (message) => {
  throw new DeploymentRequestInputError(message);
};

// The action is not allowed from the request's current status (maps to a conflict, not bad input).
export class DeploymentRequestStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeploymentRequestStateError";
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

export const normalizeDeploymentStatus = (
  value: unknown
): DeploymentRequestStatus => {
  if (
    typeof value !== "string" ||
    !(DEPLOYMENT_REQUEST_STATUSES as readonly string[]).includes(value)
  ) {
    fail(`status must be one of ${DEPLOYMENT_REQUEST_STATUSES.join(", ")}`);
  }
  return value as DeploymentRequestStatus;
};

// Upper-cased; letters, digits and . _ / : - (at most 32), e.g. ES, MESZ5, BTC/USD.
export const normalizeDeploymentSymbol = (value: unknown): string => {
  if (typeof value !== "string") fail("symbol must be a string");
  const symbol = (value as string).trim().toUpperCase();
  if (!DEPLOYMENT_SYMBOL_PATTERN.test(symbol))
    fail(
      "symbol must be 1-32 letters, digits or . _ / : - starting with a letter or digit"
    );
  return symbol;
};

// A count and a unit: s, m, h, d or w (1m, 15m, 4h, 1d).
export const normalizeDeploymentTimeframe = (value: unknown): string => {
  if (typeof value !== "string") fail("timeframe must be a string");
  const timeframe = (value as string).trim();
  if (!DEPLOYMENT_TIMEFRAME_PATTERN.test(timeframe))
    fail("timeframe must be a count and unit such as 1m, 15m, 4h or 1d");
  return timeframe;
};

const positive = (record: Record<string, unknown>, key: string): number => {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    fail(`limits.${key} must be a number greater than 0`);
  return value as number;
};

// All four limits are required and positive; maxOrderSize may not exceed maxPosition.
export const normalizeDeploymentLimits = (
  value: unknown
): DeploymentRequestLimits => {
  if (!isRecord(value)) fail("limits must be an object");
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(DEPLOYMENT_LIMIT_KEYS as readonly string[]).includes(key))
      fail(`limits.${key.slice(0, 40)} is not a recognized limit`);
  }
  const limits = {
    maxOrderSize: positive(record, "maxOrderSize"),
    maxPosition: positive(record, "maxPosition"),
    maxOrdersPerMinute: positive(record, "maxOrdersPerMinute"),
    dailyLossLimit: positive(record, "dailyLossLimit"),
  };
  if (
    !Number.isSafeInteger(limits.maxOrdersPerMinute) ||
    limits.maxOrdersPerMinute > DEPLOYMENT_MAX_ORDERS_PER_MINUTE
  ) {
    fail(
      `limits.maxOrdersPerMinute must be a whole number from 1 to ${DEPLOYMENT_MAX_ORDERS_PER_MINUTE}`
    );
  }
  if (limits.maxOrderSize > limits.maxPosition)
    fail("limits.maxOrderSize must not exceed limits.maxPosition");
  return limits;
};

const paramFailure = <T>(operation: () => T): T => {
  try {
    return operation();
  } catch (error) {
    if (error instanceof StrategyInputError) fail(error.message);
    throw error;
  }
};

// Resolves a complete params map against the strategy schema: defaults, then each layer in order
// (preset values, then explicit params). Unknown names, wrong types and out-of-bounds values fail.
export const resolveDeploymentParams = (
  schema: readonly StrategyParam[],
  ...layers: readonly unknown[]
): StrategyPresetValues => {
  const byName = new Map(schema.map((param) => [param.name, param]));
  const result: StrategyPresetValues = Object.fromEntries(
    schema.map((param) => [param.name, param.default])
  );
  for (const layer of layers) {
    if (layer === undefined || layer === null) continue;
    if (!isRecord(layer)) fail("params must be an object");
    for (const [name, entry] of Object.entries(
      layer as Record<string, unknown>
    )) {
      const param = byName.get(name);
      if (param === undefined)
        fail(`params.${name.slice(0, 64)} is not a parameter of this strategy`);
      result[name] = paramFailure(() =>
        checkStrategyParamValue(
          requirePresent(param, "param"),
          entry,
          `params.${name}`
        )
      );
    }
  }
  return result;
};

// Stored params must still match the current schema exactly (same names, valid values).
export const checkDeploymentParamsFit = (
  schema: readonly StrategyParam[],
  params: unknown
): void => {
  const resolved = resolveDeploymentParams(schema, params);
  const stored = isRecord(params) ? params : {};
  const missing = Object.keys(resolved).filter(
    (name) => !Object.hasOwn(stored, name)
  );
  if (missing.length > 0)
    fail(
      `params are missing ${missing.slice(0, 5).join(", ")}; the strategy schema changed, update the draft`
    );
};

export const normalizeDeploymentNote = (
  value: unknown,
  required: boolean
): string | null => {
  if (
    value === undefined ||
    value === null ||
    (typeof value === "string" && value.trim() === "")
  ) {
    if (required) fail("note is required");
    return null;
  }
  if (typeof value !== "string") fail("note must be a string");
  const note = (value as string).trim();
  if (note.length > DEPLOYMENT_NOTE_MAX_LENGTH)
    fail(`note must not exceed ${DEPLOYMENT_NOTE_MAX_LENGTH} characters`);
  if (CONTROL_CHARACTER_PATTERN.test(note.replace(/[\n\t]/gu, "")))
    fail("note must not contain control characters");
  return note;
};

// Throws when the action is not allowed from the current status.
export const checkDeploymentTransition = (
  action: DeploymentRequestAction,
  status: DeploymentRequestStatus
): DeploymentRequestStatus => {
  const transition = DEPLOYMENT_REQUEST_TRANSITIONS[action];
  if (!transition.from.includes(status))
    throw new DeploymentRequestStateError(
      `Cannot ${action} a request that is ${status}`
    );
  return transition.to;
};
