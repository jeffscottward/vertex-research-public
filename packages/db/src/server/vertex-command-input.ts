import {
  array,
  digestString,
  fail,
  identifier,
  object,
  type PersistenceContext,
  string,
} from "./vertex-persistence-core.ts";
import type {
  VertexCommandKey,
  VertexPrincipal,
  VertexRecord,
  VertexScope,
} from "./vertex-ports.ts";

const exact = (value: VertexRecord, keys: readonly string[]): void => {
  if (
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    fail("invalid");
};
const semanticVersion = (value: unknown): void => {
  if (
    typeof value !== "string" ||
    value.length > 64 ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)
  )
    fail("invalid");
};
const backtestExpectation = (raw: unknown): void => {
  const value = object(raw);
  exact(value, [
    "operation",
    "taskContract",
    "bindingId",
    "strategy",
    "plannedRun",
    "recipe",
    "policy",
  ]);
  if (value["operation"] !== "request-backtest") fail("invalid");
  identifier(value["taskContract"]);
  identifier(value["bindingId"]);
  for (const field of ["strategy", "plannedRun", "recipe"]) {
    const pin = object(value[field]);
    exact(pin, ["artifactId", "sha256"]);
    identifier(pin["artifactId"]);
    digestString(pin["sha256"]);
  }
  const policy = object(value["policy"]);
  exact(policy, ["selectionId", "selectionSha256", "selectionRevision"]);
  identifier(policy["selectionId"]);
  digestString(policy["selectionSha256"]);
  if (
    typeof policy["selectionRevision"] !== "string" ||
    !/^(0|[1-9]\d{0,29})$/.test(policy["selectionRevision"])
  )
    fail("invalid");
};

// Internal checks mirror the exact frozen API command shapes. Domain records
// still require injected authoritative validators. No executable payload exists.
export const validateVertexCommand = async (
  ctx: PersistenceContext,
  principal: VertexPrincipal,
  scope: VertexScope,
  key: VertexCommandKey
): Promise<VertexRecord> => {
  identifier(principal.actorId);
  identifier(scope.accountAlias);
  const value = object(ctx.capture(key.command));
  if (!["review", "research", "simulation"].includes(key.kind)) fail("invalid");
  if (
    value["accountAlias"] !== scope.accountAlias ||
    value["environment"] !== scope.environment ||
    !["research", "paper"].includes(scope.environment)
  )
    fail("denied");
  identifier(value["accountAlias"]);
  identifier(key.idempotencyKey);
  if (value["idempotencyKey"] !== key.idempotencyKey) fail("conflict");
  if (key.kind === "review") {
    exact(value, [
      "accountAlias",
      "environment",
      "artifactId",
      "artifactSha256",
      "strategyVersion",
      "decision",
      "purpose",
      "expectedReviewId",
      "idempotencyKey",
    ]);
    identifier(value["artifactId"]);
    digestString(value["artifactSha256"]);
    identifier(value["strategyVersion"]);
    if (
      !(
        ["accepted", "rejected"].includes(string(value["decision"])) &&
        ["research", "paper-simulation"].includes(string(value["purpose"]))
      ) ||
      (value["purpose"] === "paper-simulation" && scope.environment !== "paper")
    )
      fail("invalid");
    if (value["expectedReviewId"] !== null)
      identifier(value["expectedReviewId"]);
  }
  if (key.kind === "research") {
    const explicit = Object.hasOwn(value, "backtestExpectation");
    exact(value, [
      "accountAlias",
      "environment",
      "question",
      "collectionId",
      "evidenceIds",
      "role",
      "idempotencyKey",
      "proposalOnly",
      "executionAuthorized",
      ...(explicit ? ["backtestExpectation"] : []),
    ]);
    if (explicit) {
      backtestExpectation(value["backtestExpectation"]);
      if (scope.environment !== "research" || value["role"] !== "research")
        fail("denied");
    }
    identifier(value["collectionId"]);
    // Authoritative z.string min/max count UTF-16 units, not codepoints.
    if (
      typeof value["question"] !== "string" ||
      value["question"].length < 10 ||
      value["question"].length > 2000 ||
      /[\u0000-\u001f\u007f]/u.test(value["question"])
    )
      fail("invalid");
    const ids = array(value["evidenceIds"], 32).map(identifier);
    if (
      new Set(ids).size !== ids.length ||
      ![
        "research",
        "paper-to-strategy",
        "backtest-review",
        "knowledge-import",
      ].includes(string(value["role"])) ||
      value["proposalOnly"] !== true ||
      value["executionAuthorized"] !== false
    )
      fail("invalid");
  }
  if (key.kind === "simulation") {
    exact(value, [
      "accountAlias",
      "environment",
      "admissionId",
      "reviewId",
      "reviewVersion",
      "intentId",
      "intentSha256",
      "strategyVersion",
      "idempotencyKey",
      "simulationOnly",
      "brokerSubmissionAllowed",
      "liveAuthorization",
    ]);
    for (const field of [
      "admissionId",
      "reviewId",
      "intentId",
      "strategyVersion",
    ])
      identifier(value[field]);
    semanticVersion(value["reviewVersion"]);
    digestString(value["intentSha256"]);
    if (
      scope.environment !== "paper" ||
      value["simulationOnly"] !== true ||
      value["brokerSubmissionAllowed"] !== false ||
      value["liveAuthorization"] !== false
    )
      fail("denied");
  }
  digestString(key.requestHash);
  if (
    (await ctx.hash({
      actorId: principal.actorId,
      kind: key.kind,
      input: value,
    })) !== key.requestHash
  )
    fail("integrity");
  return value;
};
