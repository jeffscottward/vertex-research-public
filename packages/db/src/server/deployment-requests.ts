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

// Optional options block of a request (migration 0069). A request without it is the old format.
export const DEPLOYMENT_OPTION_STRUCTURES = [
  "callDebitVertical",
  "putDebitVertical",
  "putCreditVertical",
  "callCreditVertical",
] as const;
export type DeploymentOptionStructure =
  (typeof DEPLOYMENT_OPTION_STRUCTURES)[number];
export type DeploymentOptionRight = "call" | "put";
export type DeploymentOptionLeg = Readonly<{
  role: "anchor" | "wing";
  action: "buy" | "sell";
  right: DeploymentOptionRight;
}>;
export type DeploymentOptionGroup = Readonly<{
  key: string;
  symbols: readonly string[];
}>;
const DEPLOYMENT_WIDTH_UNITS = ["sigma", "price"] as const;
type DeploymentOptionWidthUnit = (typeof DEPLOYMENT_WIDTH_UNITS)[number];
type DeploymentOptionWidth = Readonly<{
  unit: DeploymentOptionWidthUnit;
  value: number;
}>;
export type DeploymentRequestOptions = Readonly<{
  structure: DeploymentOptionStructure;
  // Calendar days to expiry: the target and the smallest accepted value.
  dte: Readonly<{ target: number; min: number }>;
  // Strike distance between the anchor and the wing: in sigma (the unit the research sleeves use)
  // or in price units.
  width: DeploymentOptionWidth;
  // Absolute delta of the anchor leg, between 0 and 1.
  anchorDelta: number;
  legs: readonly [DeploymentOptionLeg, DeploymentOptionLeg];
  // Both in percent of the account; the budget may not exceed the max loss.
  budgetPctOfAccount: number;
  maxLossPctOfAccount: number;
  // Set when the request is one of several created together (one per symbol).
  group: DeploymentOptionGroup | null;
}>;

// Hard ceiling for options.maxLossPctOfAccount (percent of the account). Also in the 0069 CHECK.
export const DEPLOYMENT_MAX_LOSS_PCT_CEILING = 2;
export const DEPLOYMENT_GROUP_MIN_SYMBOLS = 2;
export const DEPLOYMENT_GROUP_MAX_SYMBOLS = 16;
const DEPLOYMENT_MAX_DTE = 730;
const DEPLOYMENT_MAX_WIDTH = 10_000;
const DEPLOYMENT_GROUP_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const DEPLOYMENT_OPTION_KEYS = [
  "structure",
  "dte",
  "width",
  "anchorDelta",
  "legs",
  "budgetPctOfAccount",
  "maxLossPctOfAccount",
  "group",
] as const;
const DEPLOYMENT_STRUCTURE_SHAPES: Readonly<
  Record<
    DeploymentOptionStructure,
    readonly [DeploymentOptionRight, "debit" | "credit"]
  >
> = {
  callDebitVertical: ["call", "debit"],
  putDebitVertical: ["put", "debit"],
  putCreditVertical: ["put", "credit"],
  callCreditVertical: ["call", "credit"],
};

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

// The two legs a structure means: a debit vertical buys the anchor and sells the wing, a credit
// vertical sells the anchor and buys the wing; both legs have the structure's right.
export const deploymentOptionLegs = (
  structure: DeploymentOptionStructure
): readonly [DeploymentOptionLeg, DeploymentOptionLeg] => {
  const [right, kind] = DEPLOYMENT_STRUCTURE_SHAPES[structure];
  return [
    { role: "anchor", action: kind === "debit" ? "buy" : "sell", right },
    { role: "wing", action: kind === "debit" ? "sell" : "buy", right },
  ];
};

const onlyKeys = (
  record: Record<string, unknown>,
  allowed: readonly string[],
  path: string
): void => {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key))
      fail(`${path}.${key.slice(0, 40)} is not a recognized field`);
  }
};

const finite = (value: unknown, path: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value))
    fail(`${path} must be a number`);
  return value as number;
};

const checkDeploymentLegs = (
  value: unknown,
  expected: readonly [DeploymentOptionLeg, DeploymentOptionLeg],
  structure: DeploymentOptionStructure
): void => {
  if (!Array.isArray(value) || value.length !== expected.length)
    fail("options.legs must list exactly the anchor leg and the wing leg");
  (value as unknown[]).forEach((leg, index) => {
    if (!isRecord(leg)) fail(`options.legs[${index}] must be an object`);
    onlyKeys(
      leg as Record<string, unknown>,
      ["role", "action", "right"],
      `options.legs[${index}]`
    );
    const { role, action, right } = leg as Partial<
      Record<keyof DeploymentOptionLeg, unknown>
    >;
    const want = requirePresent(expected[index], "leg");
    if (role !== want.role || action !== want.action || right !== want.right) {
      fail(
        `options.legs do not agree with ${structure}: the ${want.role} leg must ${want.action} a ${want.right}`
      );
    }
  });
};

const normalizeDeploymentGroup = (
  value: unknown,
  symbol: string
): DeploymentOptionGroup | null => {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) fail("options.group must be an object");
  onlyKeys(
    value as Record<string, unknown>,
    ["key", "symbols"],
    "options.group"
  );
  const { key, symbols: listed } = value as Partial<
    Record<keyof DeploymentOptionGroup, unknown>
  >;
  if (typeof key !== "string" || !DEPLOYMENT_GROUP_KEY_PATTERN.test(key)) {
    fail(
      "options.group.key must be 1-64 letters, digits, _ or - starting with a letter or digit"
    );
  }
  if (
    !Array.isArray(listed) ||
    listed.length < DEPLOYMENT_GROUP_MIN_SYMBOLS ||
    listed.length > DEPLOYMENT_GROUP_MAX_SYMBOLS
  ) {
    fail(
      `options.group.symbols must list ${DEPLOYMENT_GROUP_MIN_SYMBOLS} to ${DEPLOYMENT_GROUP_MAX_SYMBOLS} symbols`
    );
  }
  const symbols = (listed as unknown[]).map(normalizeDeploymentSymbol);
  if (new Set(symbols).size !== symbols.length)
    fail("options.group.symbols must not repeat a symbol");
  if (!symbols.includes(symbol))
    fail(`options.group.symbols must include the request symbol ${symbol}`);
  return { key: key as string, symbols };
};

// width is { unit, value }: a bare number is refused because it does not say which unit it is in.
const normalizeDeploymentWidth = (value: unknown): DeploymentOptionWidth => {
  if (!isRecord(value))
    fail("options.width must be an object with unit and value");
  onlyKeys(
    value as Record<string, unknown>,
    ["unit", "value"],
    "options.width"
  );
  const { unit, value: amount } = value as Partial<
    Record<keyof DeploymentOptionWidth, unknown>
  >;
  if (
    typeof unit !== "string" ||
    !(DEPLOYMENT_WIDTH_UNITS as readonly string[]).includes(unit)
  ) {
    fail(
      `options.width.unit must be one of ${DEPLOYMENT_WIDTH_UNITS.join(", ")}`
    );
  }
  const size = finite(amount, "options.width.value");
  if (size <= 0 || size > DEPLOYMENT_MAX_WIDTH)
    fail(
      `options.width.value must be greater than 0 and at most ${DEPLOYMENT_MAX_WIDTH}`
    );
  return { unit: unit as DeploymentOptionWidthUnit, value: size };
};

// null or undefined is the old format (no options block) and stays valid. Otherwise every field is
// checked and the result is the stored form: legs filled in from the structure, group or null.
// `symbol` is the request's symbol; a group must contain it.
export const normalizeDeploymentOptions = (
  value: unknown,
  symbol: string
): DeploymentRequestOptions | null => {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) fail("options must be an object");
  onlyKeys(value as Record<string, unknown>, DEPLOYMENT_OPTION_KEYS, "options");
  const record = value as Partial<
    Record<(typeof DEPLOYMENT_OPTION_KEYS)[number], unknown>
  >;
  if (
    typeof record.structure !== "string" ||
    !(DEPLOYMENT_OPTION_STRUCTURES as readonly string[]).includes(
      record.structure
    )
  ) {
    fail(
      `options.structure must be one of ${DEPLOYMENT_OPTION_STRUCTURES.join(", ")}`
    );
  }
  const structure = record.structure as DeploymentOptionStructure;

  if (!isRecord(record.dte)) fail("options.dte must be an object");
  onlyKeys(record.dte, ["target", "min"], "options.dte");
  const dteRecord = record.dte as Partial<Record<"target" | "min", unknown>>;
  const dte = {
    target: finite(dteRecord.target, "options.dte.target"),
    min: finite(dteRecord.min, "options.dte.min"),
  };
  if (
    !Number.isSafeInteger(dte.target) ||
    dte.target < 1 ||
    dte.target > DEPLOYMENT_MAX_DTE
  ) {
    fail(
      `options.dte.target must be a whole number from 1 to ${DEPLOYMENT_MAX_DTE}`
    );
  }
  if (!Number.isSafeInteger(dte.min) || dte.min < 0 || dte.min > dte.target)
    fail("options.dte.min must be a whole number from 0 to options.dte.target");

  const width = normalizeDeploymentWidth(record.width);
  const anchorDelta = finite(record.anchorDelta, "options.anchorDelta");
  if (anchorDelta <= 0 || anchorDelta >= 1)
    fail("options.anchorDelta must be between 0 and 1 (absolute delta)");

  const legs = deploymentOptionLegs(structure);
  if (record.legs !== undefined && record.legs !== null)
    checkDeploymentLegs(record.legs, legs, structure);

  const maxLossPctOfAccount = finite(
    record.maxLossPctOfAccount,
    "options.maxLossPctOfAccount"
  );
  if (
    maxLossPctOfAccount <= 0 ||
    maxLossPctOfAccount > DEPLOYMENT_MAX_LOSS_PCT_CEILING
  ) {
    fail(
      `options.maxLossPctOfAccount must be greater than 0 and at most ${DEPLOYMENT_MAX_LOSS_PCT_CEILING}`
    );
  }
  const budgetPctOfAccount = finite(
    record.budgetPctOfAccount,
    "options.budgetPctOfAccount"
  );
  if (budgetPctOfAccount <= 0)
    fail("options.budgetPctOfAccount must be greater than 0");
  if (budgetPctOfAccount > maxLossPctOfAccount)
    fail(
      "options.budgetPctOfAccount must not exceed options.maxLossPctOfAccount"
    );

  return {
    structure,
    dte,
    width,
    anchorDelta,
    legs,
    budgetPctOfAccount,
    maxLossPctOfAccount,
    group: normalizeDeploymentGroup(
      record.group,
      normalizeDeploymentSymbol(symbol)
    ),
  };
};

// Options for an edit of a draft. undefined: neither the block nor the symbol changes, keep the
// stored value. Otherwise the new block (or the stored one, when only the symbol changes) is checked
// against the symbol the row will have, so a stored group must still contain it.
export const resolveDeploymentOptionsEdit = (
  edit: Readonly<{ options: unknown; symbol: string | undefined }>,
  stored: Readonly<{ options: unknown; symbol: string }>
): DeploymentRequestOptions | null | undefined => {
  if (edit.options === undefined && edit.symbol === undefined) return undefined;
  return normalizeDeploymentOptions(
    edit.options === undefined ? stored.options : edit.options,
    edit.symbol ?? stored.symbol
  );
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
