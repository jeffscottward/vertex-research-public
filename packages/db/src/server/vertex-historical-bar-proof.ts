import { required as requirePresent } from "./required.ts";
import {
  array,
  digestString,
  fail,
  object,
  type PersistenceContext,
  string,
  time,
} from "./vertex-persistence-core.ts";
import type { VertexRecord } from "./vertex-ports.ts";

// Private v3 result reconstruction only. No schema registration, runtime,
// execution, accepted-review synthesis or extension of the lab's v2 gate path.
const researchClass =
  "limited-retrospective-adjusted-bar-simulation-nonpromotion";
const modeled = [
  "commission",
  "slippage",
  "bar-path",
  "bar-volume",
  "replay-availability",
  "adjusted-share-basis",
];
const restrictions = [
  "historical-vintage-unavailable",
  "point-in-time-unavailable",
  "market-coverage-unqualified",
  "survivorship-unqualified",
  "corporate-action-cash-accounting-unavailable",
  "independent-oos-unavailable",
  "modeled-liquidity-not-observed-executable-pnl",
  "retrospective-result-not-promotion-evidence",
] as const;
const assumptions = {
  format: "vertex-rc5-adjusted-bar-round-trip-assumptions-v1",
  barExecution: "rc5-external-LAST-L1_MBP",
  path: "native-O-H-L-C-adaptive-disabled",
  decisionTiming: "on_bar-after-current-bar-path-native-command-drain",
  fill: "native-FOK-market-default-limit-probability-1-slippage-probability-0-seed-0",
  fee: "reviewed-fixed-USD-per-fill-charge-each-fill",
  slippage: "explicit-zero-additional-slippage-not-calibrated",
  volume:
    "rc5-BarTickSizes-quarter-remainder-instrument-increments-liquidity-consumption",
  participation: "reviewed-source-bar-volume-cap-before-FOK-not-path-liquidity",
  latency: "explicit-native-static-zero-base-insert-update-cancel-nanoseconds",
  ledgerPrecision: "whole-adjusted-share-units-USD-cent-native-prices-and-fees",
  shareBasis:
    "fixed-hypothetical-retrieval-adjusted-share-units-no-old-share-cash-accounting",
  adjustments: "provider-retrieval-adjustment-not-PIT-not-total-return",
  coverage: "preserve-nonobserved-gaps-no-completeness-inference",
  revisions: "originals-retained-overlapping-or-reordered-replay-unavailable",
} as const;
const keys = (value: VertexRecord, expected: string): void => {
  if (Object.keys(value).sort().join(",") !== expected) fail("integrity");
};
const ns = (value: unknown): bigint => {
  const text = string(value);
  if (!/^(0|[1-9][0-9]{0,19})$/.test(text) || BigInt(text) >= 2n ** 64n)
    return fail("integrity");
  return BigInt(text);
};
const decode = (value: unknown, maximum = 1_048_576): Uint8Array => {
  const text = string(value);
  if (
    text.length === 0 ||
    text.length > Math.ceil(maximum / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      text
    )
  )
    return fail("integrity");
  let raw: string;
  try {
    raw = atob(text);
  } catch {
    return fail("integrity");
  }
  if (raw.length === 0 || raw.length > maximum || btoa(raw) !== text)
    return fail("integrity");
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
};
const canonical = async (
  ctx: PersistenceContext,
  bytes: Uint8Array,
  expected?: string
): Promise<VertexRecord> => {
  let result: VertexRecord;
  try {
    result = object(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
    );
  } catch {
    return fail("integrity");
  }
  const encoded = ctx.encode(result);
  if (
    encoded.byteLength !== bytes.byteLength ||
    !bytes.every((byte, index) => byte === encoded[index]) ||
    (expected !== undefined && (await ctx.digest(bytes)) !== expected)
  )
    return fail("integrity");
  return result;
};
const embedded = async (
  ctx: PersistenceContext,
  raw: unknown
): Promise<{ value: VertexRecord; digest: string }> => {
  const ref = object(raw);
  keys(ref, "bytesBase64,sha256");
  const digest = digestString(ref["sha256"]);
  return {
    value: await canonical(ctx, decode(ref["bytesBase64"]), digest),
    digest,
  };
};
const gcd = (leftInput: bigint, rightInput: bigint): bigint => {
  let left = leftInput;
  let right = rightInput;
  while (right !== 0n) {
    const next = left % right;
    left = right;
    right = next;
  }
  return left;
};
const transformed = (
  raw: unknown,
  scaleRaw: unknown,
  precisionRaw: unknown,
  volume: boolean
): VertexRecord => {
  const bits = string(raw);
  if (!/^[0-9a-f]{16}$/.test(bits)) return fail("integrity");
  const binary = BigInt(`0x${bits}`);
  // binary is a non-negative 64-bit BigInt, so division/modulo by powers of two
  // are exactly the IEEE-754 field shifts and masks.
  const exponent = Number((binary / 2n ** 52n) % 2048n);
  const mantissa = binary % 2n ** 52n;
  if (
    binary / 2n ** 63n !== 0n ||
    exponent === 2047 ||
    (!volume && exponent === 0 && mantissa === 0n)
  )
    return fail("integrity");
  const scale = object(scaleRaw);
  keys(scale, "denominator,numerator");
  if (
    !(
      /^[1-9][0-9]{0,11}$/.test(string(scale["numerator"])) &&
      /^[1-9][0-9]{0,11}$/.test(string(scale["denominator"]))
    ) ||
    typeof precisionRaw !== "number" ||
    !Number.isInteger(precisionRaw) ||
    precisionRaw < 0 ||
    precisionRaw > 9
  )
    return fail("integrity");
  const precision = precisionRaw;
  const shift = exponent === 0 ? -1074 : exponent - 1023 - 52;
  let numerator =
    (exponent === 0 ? mantissa : 2n ** 52n + mantissa) *
    BigInt(string(scale["numerator"]));
  let denominator = BigInt(string(scale["denominator"]));
  if (shift >= 0) {
    numerator *= 2n ** BigInt(shift);
  } else denominator *= 2n ** BigInt(-shift);
  const divisor = gcd(numerator, denominator);
  numerator /= divisor;
  denominator /= divisor;
  if (numerator > denominator * 1_000_000_000_000n) return fail("integrity");
  const quantum = 10n ** BigInt(precision);
  const scaled = numerator * quantum;
  let units = scaled / denominator;
  const remainder = scaled % denominator;
  if (
    remainder * 2n > denominator ||
    (remainder * 2n === denominator && units % 2n === 1n)
  )
    units += 1n;
  if (!volume && units === 0n) return fail("integrity");
  const text =
    (units / quantum).toString() +
    (precision === 0
      ? ""
      : `.${(units % quantum).toString().padStart(precision, "0")}`);
  return {
    sourceF64Bits: bits,
    modeledDecimal: text,
    scaledExactNumerator: numerator.toString(),
    scaledExactDenominator: denominator.toString(),
    roundingChanged: units * denominator !== numerator * quantum,
  };
};
const decimal = (value: unknown): bigint => {
  const text = string(value);
  if (!/^-?(0|[1-9][0-9]{0,23})(\.[0-9]{1,12})?$/.test(text))
    return fail("integrity");
  const negative = text.startsWith("-");
  const [whole, fraction = ""] = (negative ? text.slice(1) : text).split(".");
  return (
    (negative ? -1n : 1n) *
    (BigInt(requirePresent(whole, "whole")) * 1_000_000_000_000n +
      BigInt(fraction.padEnd(12, "0")))
  );
};
const normalizedTimestamp = (value: unknown): string => {
  const raw = string(value).replace(/\+00:00$/, "Z");
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/.exec(
    raw
  );
  if (!match) return fail("integrity");
  time(raw);
  const fraction = (match[2] ?? "").padEnd(6, "0");
  return `${match[1]}${fraction === "000000" ? "" : `.${fraction}`}Z`;
};

type HistoricalBarQualifications = Readonly<{
  currency: "USD";
  metricScope: "limited-retrospective";
  researchClass: typeof researchClass;
  shareBasis: typeof assumptions.shareBasis;
  promotionEligible: false;
  pointInTimeEnforced: false;
  dataComplete: false;
  restrictions: typeof restrictions;
}>;
export type HistoricalBarModeledOutcome = HistoricalBarQualifications &
  (
    | Readonly<{
        availability: "available";
        closedRoundTrip: true;
        metrics: Readonly<{
          "modeled-adjusted-unit-gross-pnl": string;
          "modeled-adjusted-unit-net-pnl": string;
          "modeled-total-commission": string;
        }>;
      }>
    | Readonly<{
        availability: "unavailable";
        reason: "round-trip-not-closed";
        closedRoundTrip: false;
      }>
  );
interface HistoricalResultInputs {
  admittedAt: string;
  budget: VertexRecord;
  dataset: {
    manifest: VertexRecord;
    manifestSha256: string;
    content: VertexRecord;
    capture: VertexRecord;
    captureSha256: string;
    requestSha256: string;
  };
  descriptor: VertexRecord;
  evidence: { artifactSha256: string; evidence: VertexRecord }[];
  lineage: VertexRecord;
  planned: VertexRecord;
  plannedSha256: string;
  recipe: VertexRecord;
  result: VertexRecord;
  strategy: VertexRecord;
  strategySha256: string;
}
export const verifyHistoricalBarResult = async (
  ctx: PersistenceContext,
  input: HistoricalResultInputs
): Promise<HistoricalBarModeledOutcome> => {
  const {
    recipe,
    lineage,
    budget,
    descriptor,
    result,
    planned,
    strategy,
    dataset,
    evidence,
  } = input;
  const same = async (a: unknown, b: unknown): Promise<boolean> =>
    (await ctx.hash(a)) === (await ctx.hash(b));
  const model = object(recipe["model"]);
  keys(
    model,
    "assumptions_digest,commission_per_fill,engine_digest,enter_not_before_ns,evidence_template_bytes,exit_not_before_ns,initial_cash,instrument_id,native_configuration_bytes,quantity,review_digest,slippage_per_unit,strategy_code_digest,strategy_digest"
  );
  const engine = object(descriptor["pin"]);
  const economics = object(result["economics"]);
  const nativeBytes = decode(model["native_configuration_bytes"]);
  const native = await canonical(ctx, nativeBytes);
  keys(
    native,
    "distribution,expiresNs,format,instrument,interpretation,issuedNs"
  );
  if (
    native["format"] !== "vertex-nautilus-historical-bars-v1" ||
    ns(native["issuedNs"]) >= ns(native["expiresNs"])
  )
    fail("integrity");
  const parsed = await embedded(ctx, native["interpretation"]);
  const rules = parsed.value;
  keys(
    rules,
    "assumptions,availability,calendar,captureSha256,contentSha256,format,instrumentId,interval,labelConvention,manifestSha256,numericTransform,qualificationSha256,requestSha256"
  );
  const calendar = await embedded(ctx, rules["calendar"]);
  const qualified = object(dataset.capture["qualified_contract"]);
  const units = object(qualified["semantics"]);
  const contract = object(qualified["decoded_contract"]);
  const instrument = object(native["instrument"]);
  const kind = object(object(dataset.capture["request"])["kind"]);
  if (
    rules["format"] !== "vertex-historical-bar-interpretation-v1" ||
    rules["manifestSha256"] !== dataset.manifestSha256 ||
    rules["contentSha256"] !== dataset.manifest["contentHash"] ||
    rules["captureSha256"] !== dataset.captureSha256 ||
    rules["requestSha256"] !== dataset.requestSha256 ||
    rules["qualificationSha256"] !==
      object(qualified["qualification_capture"])["sha256"]
  )
    fail("integrity");
  if (
    model["instrument_id"] !==
      `ibkr-conid-${contract["contract_id"]}.RESEARCH` ||
    rules["instrumentId"] !== model["instrument_id"] ||
    instrument["id"] !== model["instrument_id"] ||
    instrument["rawSymbol"] !== contract["symbol"] ||
    instrument["currency"] !== "USD" ||
    contract["currency"] !== "USD" ||
    instrument["lotSize"] !== "1" ||
    instrument["pricePrecision"] !== 2 ||
    instrument["priceIncrement"] !== "0.01"
  )
    fail("integrity");
  const nativeHash = await ctx.digest(nativeBytes);
  const core = {
    format: "vertex-historical-bar-scientific-core-v1",
    ...Object.fromEntries(
      Object.entries(model).filter(
        ([key]) =>
          ![
            "review_digest",
            "evidence_template_bytes",
            "native_configuration_bytes",
          ].includes(key)
      )
    ),
    nativeConfigurationSha256: nativeHash,
  };
  const coreHash = await ctx.hash(core);
  if (
    !(
      (await same(rules["assumptions"], assumptions)) &&
      (await same(economics["assumptions"], assumptions))
    ) ||
    model["assumptions_digest"] !== (await ctx.hash(assumptions))
  )
    fail("integrity");
  const required = new Set([
    dataset.manifestSha256,
    string(dataset.manifest["contentHash"]),
    dataset.captureSha256,
    parsed.digest,
    calendar.digest,
    string(engine["digest"]),
    string(object(lineage["codePin"])["digest"]),
    nativeHash,
    coreHash,
  ]);
  const covered = new Set(
    evidence.map((item) => string(item.evidence["contentHash"]))
  );
  const pins = array(recipe["reviewPins"], 32).map(object);
  if (
    pins.length !== evidence.length ||
    new Set(pins.map((pin) => pin["evidenceId"])).size !== pins.length ||
    covered.size !== required.size ||
    [...required].some((hash) => !covered.has(hash)) ||
    evidence.some(
      (item) => time(item.evidence["capturedAt"]) > time(recipe["plannedAt"])
    ) ||
    !evidence.some(
      (item) =>
        item.artifactSha256 === model["review_digest"] &&
        item.evidence["contentHash"] === coreHash
    )
  )
    fail("denied");
  if (
    !(await same(lineage["reviewPins"], recipe["reviewPins"])) ||
    lineage["modelDigest"] !== (await ctx.hash(model)) ||
    lineage["interpretationDigest"] !== parsed.digest ||
    lineage["format"] !== "vertex-historical-bar-lineage-inputs-v1" ||
    lineage["researchClass"] !== researchClass ||
    lineage["promotionEligible"] !== false
  )
    fail("integrity");
  const sourceEntry = object(array(recipe["datasets"], 1)[0]);
  const sourcePins = array(sourceEntry["reviewPins"], 16).map(object);
  if (
    sourcePins.length !== 1 ||
    !evidence.some(
      (item) =>
        item.evidence["evidenceId"] ===
          requirePresent(sourcePins[0], "sourcePins[0]")["evidenceId"] &&
        item.artifactSha256 ===
          requirePresent(sourcePins[0], "sourcePins[0]")["artifactSha256"] &&
        item.evidence["contentHash"] === dataset.captureSha256
    )
  )
    fail("integrity");
  const sourceEvidence = requirePresent(
    evidence.find(
      (item) =>
        item.evidence["evidenceId"] ===
        requirePresent(sourcePins[0], "sourcePins[0]")["evidenceId"]
    ),
    'evidence.find( (item) => item.evidence["evidenceId"] === sourcePins[0]!["evid...'
  );
  if (
    !(
      (await same(
        sourceEvidence.evidence["sourceIdentity"],
        dataset.content["source"]
      )) &&
      (
        await Promise.all(
          pins.map(async (pin) => await same(pin, sourcePins[0]))
        )
      ).some(Boolean)
    )
  )
    fail("integrity");
  const checks = array(planned["leakageChecks"], 5).map(object);
  if (
    !(await same(checks.map((check) => check["kind"]).sort(), [
      "look-ahead",
      "multiple-testing",
      "overlap",
      "point-in-time",
      "survivorship",
    ])) ||
    checks.some(
      (check) =>
        !["unknown", "not-run"].includes(string(check["status"])) ||
        check["evidenceId"] !== null
    )
  )
    fail("integrity");
  if (
    engine["identity"] !== "vertex-nautilus-historical-bar-research" ||
    engine["version"] !== "1.0.0" ||
    planned["engineVersion"] !== engine["version"] ||
    model["engine_digest"] !== engine["digest"] ||
    model["strategy_digest"] !== input.strategySha256 ||
    model["strategy_code_digest"] !== strategy["codeDigest"] ||
    object(lineage["codePin"])["digest"] !== strategy["codeDigest"] ||
    lineage["strategyVersionId"] !== planned["strategyVersion"] ||
    !(await same(lineage["enginePin"], engine)) ||
    !(await same(descriptor["supported_formats"], [
      "vertex-ibkr-historical-bars-v1",
    ])) ||
    !(await same(descriptor["modeled_assumptions"], modeled)) ||
    descriptor["simulation_only"] !== true ||
    budget["network_allowed"] !== false ||
    budget["execution_allowed"] !== false ||
    time(recipe["plannedAt"]) > time(input.admittedAt)
  )
    fail("integrity");
  keys(
    result,
    "assumptionDigest,dataComplete,datasetContentDigests,economics,economicsOrigin,economicsSimulated,enginePin,evidenceDigests,executionAuthorized,format,forwardAssessment,incidentCodes,lineageDigest,pointInTimeEnforced,promotionEligible,researchClass,restrictions,sandbox,strategyDigest"
  );
  if (
    result["format"] !== "vertex-historical-bar-results-v1" ||
    result["researchClass"] !== researchClass ||
    result["economicsOrigin"] !==
      "native-retrospective-adjusted-bar-simulation" ||
    result["promotionEligible"] !== false ||
    result["pointInTimeEnforced"] !== false ||
    result["dataComplete"] !== false ||
    result["executionAuthorized"] !== false ||
    result["forwardAssessment"] !== null ||
    !(await same(result["restrictions"], restrictions)) ||
    result["strategyDigest"] !== input.strategySha256 ||
    !(await same(result["enginePin"], engine)) ||
    !(await same(result["datasetContentDigests"], [
      dataset.manifest["contentHash"],
    ])) ||
    result["assumptionDigest"] !== model["assumptions_digest"]
  )
    fail("integrity");
  if (
    economics["format"] !== "vertex-nautilus-historical-bar-economics-v1" ||
    economics["researchClass"] !== researchClass ||
    economics["metricScope"] !== "limited-retrospective" ||
    economics["promotionEligible"] !== false ||
    economics["pointInTime"] !== false ||
    economics["executionAuthorized"] !== false ||
    economics["model"] !== engine["identity"] ||
    economics["modelVersion"] !== engine["version"] ||
    economics["reviewDigest"] !== model["review_digest"] ||
    economics["scientificCoreSha256"] !== coreHash ||
    economics["nativeConfigurationSha256"] !== nativeHash ||
    economics["distributionBuildSha256"] !==
      object(native["distribution"])["buildSha256"] ||
    economics["runnerSha256"] !== engine["digest"]
  )
    fail("integrity");
  keys(
    calendar.value,
    "calendarId,dateLabelConvention,format,sessions,timezone,version"
  );
  if (
    calendar.value["format"] !== "vertex-qualified-dated-sessions-v1" ||
    calendar.value["dateLabelConvention"] !== "session-close-local-date" ||
    object(strategy["signalSchedule"])["calendar"] !==
      calendar.value["calendarId"]
  )
    fail("integrity");
  const sessions = array(calendar.value["sessions"], 5000).map(object);
  if (
    sessions.length === 0 ||
    new Set(sessions.map((s) => s["sessionDate"])).size !== sessions.length
  )
    fail("integrity");
  let previousSessionEnd = -1n;
  for (const session of sessions) {
    keys(session, "endNs,sessionDate,sourceLocator,startNs");
    if (
      ns(session["startNs"]) < previousSessionEnd ||
      ns(session["startNs"]) >= ns(session["endNs"]) ||
      string(session["sourceLocator"]).length === 0
    )
      fail("integrity");
    previousSessionEnd = ns(session["endNs"]);
    let date: string;
    try {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: string(calendar.value["timezone"]),
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).formatToParts(new Date(Number(ns(session["endNs"]) / 1_000_000n)));
      date = ["year", "month", "day"]
        .map(
          (type) =>
            requirePresent(
              parts.find((part) => part.type === type),
              "parts.find((part) => part.type === type)"
            ).value
        )
        .join("-");
    } catch {
      return fail("integrity");
    }
    if (date !== session["sessionDate"]) fail("integrity");
  }
  const transform = object(rules["numericTransform"]);
  keys(
    transform,
    "format,pricePrecision,priceScale,sourcePriceMagnifier,sourceVolumeUnit,targetVolumeUnit,volumePrecision,volumeScale"
  );
  if (
    transform["format"] !== "ieee754-exact-rational-half-even-fixed-v1" ||
    transform["sourcePriceMagnifier"] !== units["price_magnifier"] ||
    transform["sourceVolumeUnit"] !== units["volume_unit"] ||
    !["shares", "lots"].includes(string(units["volume_unit"])) ||
    units["size_unit"] !== "shares" ||
    transform["targetVolumeUnit"] !== "retrieval-adjusted-share-units" ||
    transform["volumePrecision"] !== 0 ||
    transform["pricePrecision"] !== instrument["pricePrecision"]
  )
    fail("integrity");
  const availability = object(rules["availability"]);
  keys(availability, "delayNs,format");
  if (
    availability["format"] !== "modeled-interval-close-plus-delay-v1" ||
    ns(availability["delayNs"]) > 86_400_000_000_000n ||
    !(
      (rules["interval"] === "1m" &&
        kind["bar_size"] === "1 min" &&
        rules["labelConvention"] === "interval-start") ||
      (rules["interval"] === "1d" &&
        kind["bar_size"] === "1 day" &&
        rules["labelConvention"] === "dated-session")
    )
  )
    fail("integrity");
  const terminal = object(dataset.capture["provider_window"]);
  const terminalStart = ns(object(terminal["start"])["unix_ns"]);
  const terminalEnd = ns(object(terminal["end"])["unix_ns"]);
  const originalRows = array(dataset.capture["records"], 5000).map(object);
  const rows = array(economics["modeledBars"], 5000).map(object);
  if (
    rows.length === 0 ||
    rows.length !== originalRows.length ||
    rows.length !== sourceEntry["declaredEvents"]
  )
    fail("integrity");
  const gaps: VertexRecord[] = [];
  let previousEnd = -1n;
  let previousAvailable = -1n;
  for (const [ordinal, original] of originalRows.entries()) {
    const stamp = object(original["provider_timestamp"]);
    let start: bigint;
    let end: bigint;
    let session: VertexRecord;
    if (rules["interval"] === "1d") {
      const matches = sessions.filter(
        (s) => s["sessionDate"] === stamp["sdk_decoded_label"]
      );
      if (stamp["kind"] !== "date" || matches.length !== 1) fail("integrity");
      session = requirePresent(matches[0], "matches[0]");
      start = ns(session["startNs"]);
      end = ns(session["endNs"]);
    } else {
      if (stamp["kind"] !== "datetime") fail("integrity");
      start = ns(object(stamp["value"])["unix_ns"]);
      end = start + 60_000_000_000n;
      const matches = sessions.filter(
        (s) => ns(s["startNs"]) <= start && end <= ns(s["endNs"])
      );
      if (matches.length !== 1) fail("integrity");
      session = requirePresent(matches[0], "matches[0]");
    }
    if (start < terminalStart || end > terminalEnd) fail("integrity");
    const available = end + ns(availability["delayNs"]);
    if (
      previousEnd > start ||
      previousAvailable >= available ||
      available >= 2n ** 64n ||
      end > ns(object(dataset.capture["acquisition"])["finished_unix_ns"]) ||
      end < time(object(planned["testWindow"])["startAtInclusive"]) ||
      available >= time(object(planned["testWindow"])["endAtExclusive"])
    )
      fail("integrity");
    if (previousEnd >= 0n && start > previousEnd)
      gaps.push({
        afterOrdinal: ordinal - 1,
        startNs: previousEnd.toString(),
        endNs: start.toString(),
        classification: "nonobserved-time-not-certified-missing-bars",
      });
    const values: Record<string, unknown> = {};
    for (const field of ["open", "high", "low", "close", "volume"]) {
      values[field] = transformed(
        original[`${field}_f64_bits`],
        field === "volume" ? transform["volumeScale"] : transform["priceScale"],
        field === "volume"
          ? transform["volumePrecision"]
          : transform["pricePrecision"],
        field === "volume"
      );
    }
    const expected = {
      ordinal,
      sourceRowSha256: await ctx.hash(original),
      captureSha256: dataset.captureSha256,
      providerTimestamp: stamp,
      acquiredNs: original["acquired_unix_ns"],
      qualifiedStartNs: start.toString(),
      qualifiedEndNs: end.toString(),
      modeledAvailableNs: available.toString(),
      sessionDate: session["sessionDate"],
      values,
      originalWapF64Bits: original["wap_f64_bits"],
      originalTradeCount: original["trade_count"],
      availabilityIsObserved: false,
    };
    if (!(await same(rows[ordinal], expected))) fail("integrity");
    previousEnd = end;
    previousAvailable = available;
  }
  const qualification = {
    interpretationSha256: parsed.digest,
    calendarSha256: calendar.digest,
    adjustment:
      kind["what_to_show"] === "TRADES"
        ? "split-adjusted-not-dividend-adjusted"
        : "split-and-dividend-adjusted",
    sourceTimezoneLabel: units["timezone"],
    qualifiedTimezone: calendar.value["timezone"],
    gaps,
    originalLimitations: dataset.capture["limitations"],
    marketCoverage: "unqualified",
    historicalVintage: "unavailable",
    sourceResponseComplete: true,
    captureComplete: true,
  };
  if (!(await same(economics["sourceQualification"], qualification)))
    fail("integrity");
  const expectedLineage = {
    format: "vertex-historical-bar-lineage-v1",
    researchClass,
    strategyDigest: input.strategySha256,
    runDigest: input.plannedSha256,
    datasetManifestDigests: [dataset.manifestSha256],
    evidenceDigests: evidence.map((item) => item.artifactSha256),
    lineage,
    budget,
    engineDescriptor: descriptor,
    originalCaptureSha256: dataset.captureSha256,
    qualification,
    plannedAt: normalizedTimestamp(recipe["plannedAt"]),
    promotionEligible: false,
    executionAuthorized: false,
  };
  if (result["lineageDigest"] !== (await ctx.hash(expectedLineage)))
    fail("integrity");
  // Check native result/fill joins without recomputing hypothetical fills as if
  // they were source prices. Native account fields stay modeled, not cash proof.
  const fills = array(economics["simulatedFills"], 2).map(object);
  const decisions = array(economics["decisions"], 2).map(object);
  const closed = fills.length === 2;
  if (
    economics["closedRoundTrip"] !== closed ||
    result["economicsSimulated"] !== closed ||
    !(await same(result["incidentCodes"], [
      ...restrictions,
      ...(closed ? [] : ["historical-native-round-trip-unfilled"]),
    ])) ||
    object(economics["nativeResult"])["iterations"] !== String(rows.length) ||
    object(economics["nativeResult"])["totalOrders"] !==
      String(decisions.length) ||
    object(economics["nativeResult"])["totalPositions"] !==
      (fills.length === 0 ? "0" : "1")
  )
    fail("integrity");
  const cost = object(strategy["costModel"]);
  const quantity = decimal(model["quantity"]);
  if (
    quantity <= 0n ||
    quantity % 1_000_000_000_000n !== 0n ||
    decimal(model["slippage_per_unit"]) !== 0n ||
    decimal(cost["commissionPerUnit"]) * quantity !==
      decimal(model["commission_per_fill"]) * 1_000_000_000_000n ||
    ["spreadBps", "slippageBps", "borrowAnnualBps"].some(
      (key) => decimal(cost[key]) !== 0n
    ) ||
    cost["impactModel"] !== "participation-capped" ||
    decimal(cost["maximumParticipationBps"]) <= 0n ||
    decimal(cost["maximumParticipationBps"]) > 10_000_000_000_000_000n
  )
    fail("integrity");
  if (
    planned["validationMode"] !== "historical" ||
    planned["forwardSampleCount"] !== 0 ||
    planned["gammaProvenance"] !== null ||
    !(await same(planned["transactionCosts"], strategy["costModel"])) ||
    planned["slippageModel"] !== cost["impactModel"] ||
    !(await same(strategy["universe"], dataset.manifest["instrumentUniverse"]))
  )
    fail("integrity");
  if (
    !(await same(lineage["codePin"], {
      identity: "vertex-adjusted-bar-round-trip",
      version: "1.0.0",
      digest: engine["digest"],
    }))
  )
    fail("integrity");
  for (const side of ["entry", "exit"]) {
    const threshold =
      side === "entry"
        ? model["enter_not_before_ns"]
        : model["exit_not_before_ns"];
    if (
      !(await same(strategy[`${side}Rules`], [
        {
          ruleId: `historical-${side}`,
          featureId: "modeled-bar-available-ns",
          operator: "gte",
          threshold,
          lookbackBars: 1,
        },
      ]))
    )
      fail("integrity");
  }
  const requirements = array(strategy["requiredData"], 1).map(object);
  const requirement = requirements.length === 1 ? requirements[0] : undefined;
  const maximumAgeMs = requirement?.["maximumAgeMs"];
  if (
    requirement?.["kind"] !== "candles" ||
    requirement["pointInTimeRequired"] !== false ||
    requirement["entitlementPolicyId"] !==
      dataset.manifest["entitlementPolicyId"] ||
    typeof maximumAgeMs !== "number" ||
    ns(availability["delayNs"]) > BigInt(maximumAgeMs) * 1_000_000n ||
    object(strategy["signalSchedule"])["interval"] !==
      (rules["interval"] === "1d" ? "session-close" : "bar-close")
  )
    fail("integrity");
  const risk = object(strategy["riskLimits"]);
  const high = rows
    .map((row) =>
      decimal(object(object(row["values"])["high"])["modeledDecimal"])
    )
    .reduce((a, b) => (a > b ? a : b));
  const notional = (quantity * high) / 1_000_000_000_000n;
  const modeledFees = decimal(model["commission_per_fill"]) * 2n;
  if (
    risk["maximumPositions"] !== 1 ||
    notional > decimal(risk["maximumNotional"]) ||
    decimal(risk["maximumNotional"]) + modeledFees >
      decimal(risk["maximumLoss"]) ||
    notional + modeledFees > decimal(model["initial_cash"])
  )
    fail("integrity");
  for (const [index, decision] of decisions.entries()) {
    const orderId = index === 0 ? "VERTEX-ENTRY" : "VERTEX-EXIT";
    const row = rows.find((r) => r["ordinal"] === decision["ordinal"]);
    if (!row) return fail("integrity");
    if (
      decision["clientOrderId"] !== orderId ||
      decision["barEventId"] !==
        `bar-${row["ordinal"]}-${row["sourceRowSha256"]}` ||
      decision["sourceRowSha256"] !== row["sourceRowSha256"] ||
      decision["modeledDecisionNs"] !== row["modeledAvailableNs"] ||
      decision["timing"] !== assumptions.decisionTiming ||
      decision["side"] !== (index === 0 ? "buy" : "sell") ||
      decision["quantity"] !== model["quantity"] ||
      decision["shareBasis"] !== assumptions.shareBasis
    )
      fail("integrity");
    if (
      quantity * 10_000_000_000_000_000n >
      decimal(object(object(row["values"])["volume"])["modeledDecimal"]) *
        decimal(cost["maximumParticipationBps"])
    )
      fail("integrity");
    if (
      index === 0
        ? ns(decision["modeledDecisionNs"]) <
            ns(model["enter_not_before_ns"]) ||
          ns(decision["modeledDecisionNs"]) >= ns(model["exit_not_before_ns"])
        : ns(decision["modeledDecisionNs"]) < ns(model["exit_not_before_ns"])
    )
      fail("integrity");
  }
  if (new Set(fills.map((fill) => fill["tradeId"])).size !== fills.length)
    fail("integrity");
  for (const [index, fill] of fills.entries()) {
    const row = rows.find((r) => r["ordinal"] === fill["ordinal"]);
    const decision = decisions[index];
    if (
      !(row && decision) ||
      fill["clientOrderId"] !== decision["clientOrderId"] ||
      fill["barEventId"] !==
        `bar-${row["ordinal"]}-${row["sourceRowSha256"]}` ||
      fill["sourceRowSha256"] !== row["sourceRowSha256"] ||
      fill["modeledFillEventNs"] !== row["modeledAvailableNs"] ||
      ns(fill["modeledFillEventNs"]) < ns(decision["modeledDecisionNs"]) ||
      fill["sourceAcquiredNs"] !== row["acquiredNs"] ||
      !(await same(
        fill["sourceProviderTimestamp"],
        row["providerTimestamp"]
      )) ||
      fill["sourceObservation"] !== false ||
      fill["shareBasis"] !== assumptions.shareBasis ||
      fill["side"] !== (index === 0 ? "buy" : "sell") ||
      decimal(fill["quantity"]) !== quantity ||
      decimal(fill["commission"]) !== decimal(model["commission_per_fill"]) ||
      fill["currency"] !== "USD"
    )
      fail("integrity");
    ns(fill["nativeFillInitNs"]);
    string(fill["tradeId"]);
  }
  const metrics = object(economics["metrics"]);
  if (closed) {
    keys(
      metrics,
      "modeled-adjusted-unit-gross-pnl,modeled-adjusted-unit-net-pnl,modeled-total-commission"
    );
    const gross =
      ((decimal(requirePresent(fills[1], "fills[1]")["price"]) -
        decimal(requirePresent(fills[0], "fills[0]")["price"])) *
        quantity) /
      1_000_000_000_000n;
    const fees =
      decimal(requirePresent(fills[0], "fills[0]")["commission"]) +
      decimal(requirePresent(fills[1], "fills[1]")["commission"]);
    if (
      decimal(metrics["modeled-adjusted-unit-gross-pnl"]) !== gross ||
      decimal(metrics["modeled-adjusted-unit-net-pnl"]) !== gross - fees ||
      decimal(metrics["modeled-total-commission"]) !== fees ||
      decimal(
        object(economics["nativeResult"])["modeledLedgerEndingBalance"]
      ) !==
        decimal(model["initial_cash"]) + gross - fees
    )
      fail("integrity");
  } else if (Object.keys(metrics).length !== 0) fail("integrity");
  const qualifications = {
    currency: "USD",
    metricScope: "limited-retrospective",
    researchClass,
    shareBasis: assumptions.shareBasis,
    promotionEligible: false,
    pointInTimeEnforced: false,
    dataComplete: false,
    restrictions: Object.freeze([...restrictions] as const),
  } as const;
  if (!closed) {
    return Object.freeze({
      ...qualifications,
      availability: "unavailable",
      reason: "round-trip-not-closed",
      closedRoundTrip: false,
    });
  }
  return Object.freeze({
    ...qualifications,
    availability: "available",
    closedRoundTrip: true,
    metrics: Object.freeze({
      "modeled-adjusted-unit-gross-pnl": string(
        metrics["modeled-adjusted-unit-gross-pnl"]
      ),
      "modeled-adjusted-unit-net-pnl": string(
        metrics["modeled-adjusted-unit-net-pnl"]
      ),
      "modeled-total-commission": string(metrics["modeled-total-commission"]),
    }),
  });
};
