import {
  type ModelBudgetAdmission,
  type ModelBudgetReservation,
  type ModelUseBoundary,
  type ModelUseGrantRecord,
  type ModelUseRequestRecord,
  modelUseHash,
  PolicyRegistryError,
} from "@darkfactory/config/vertex";
import { sql } from "drizzle-orm";
import type { Transaction } from "./client.ts";

const fail: (code: PolicyRegistryError["code"]) => never = (code) => {
  throw new PolicyRegistryError(code);
};
const units = (value: unknown): bigint => {
  if (typeof value !== "string" || !/^(0|[1-9]\d{0,29})$/.test(value))
    return fail("integrity");
  return BigInt(value);
};
const boundedNumber = (value: number): bigint => {
  if (!Number.isSafeInteger(value) || value < 0) return fail("invalid");
  return BigInt(value);
};
const exact = (value: bigint): string => {
  if (value < 0n || value.toString().length > 30) return fail("invalid");
  return value.toString();
};
const json = (value: unknown) => sql`${JSON.stringify(value)}::jsonb`;

export const proposedModelBudgetReservation = (
  request: ModelUseRequestRecord,
  admission: ModelBudgetAdmission
): ModelBudgetReservation => ({
  reservationId: `model-budget:${request.requestSha256}`,
  requestSha256: request.requestSha256,
  operation: request.operation,
  inputBytes: request.inputBytes,
  inputTokens: request.inputTokens,
  maximumOutputTokens: request.maximumOutputTokens,
  maximumCostUsd: request.maximumCostUsd,
  expiresAt: admission.expiresAt,
});

// Called only after current grant/lease/selection/read/review/privacy preflight,
// under the enclosing auth-global + model-use scope transaction locks. No API
// writer can issue reservations; no process-local or expiring-credit fallback.
export const reserveModelUseBudget = async (
  tx: Transaction,
  boundary: ModelUseBoundary,
  request: ModelUseRequestRecord,
  grant: ModelUseGrantRecord,
  admission: ModelBudgetAdmission,
  now: string
): Promise<
  Readonly<{
    reservation: ModelBudgetReservation;
    externalDispatchAllowed: boolean;
  }>
> => {
  if (
    admission.chargeProfile !== "approved-grant-ceiling-v1" ||
    admission.unknownOutcome !== "retain-charge"
  )
    return fail("invalid");
  if (
    grant.status !== "granted" ||
    grant.grantId !== request.grantId ||
    grant.grantVersion !== request.grantVersion ||
    grant.accountAlias !== request.accountAlias ||
    grant.environment !== request.environment ||
    grant.selectionId !== request.selectionId ||
    grant.selectionSha256 !== request.selectionSha256
  )
    return fail("integrity");
  const at = boundary.epochNanoseconds(now);
  if (
    boundary.epochNanoseconds(admission.startsAt) > at ||
    boundary.epochNanoseconds(admission.expiresAt) <= at
  )
    return fail("stale");
  // Debit independently privileged CURRENT grant ceilings, not caller-reported
  // token counts, byte heuristics or claimed prices. This intentionally retains
  // conservative full charge until a separate future actual-usage authority.
  const tokenCharge =
    boundedNumber(grant.maximumInputTokens) +
    (request.operation === "model-completion"
      ? boundedNumber(grant.maximumOutputTokens)
      : 0n);
  const costCharge = boundary.decimalUnits(grant.maximumCostUsd);
  const maximumTokens = boundedNumber(admission.maximumTokens);
  const maximumCost = boundary.decimalUnits(admission.maximumCostUsd);
  const jobMaximumTokens = boundedNumber(admission.jobMaximumTokens);
  const jobMaximumCost = boundary.decimalUnits(admission.jobMaximumCostUsd);
  for (const value of [
    tokenCharge,
    costCharge,
    maximumTokens,
    maximumCost,
    jobMaximumTokens,
    jobMaximumCost,
  ])
    exact(value);
  const reservation = proposedModelBudgetReservation(request, admission);
  const windowIdentity = {
    accountAlias: request.accountAlias,
    environment: request.environment,
    selectionId: request.selectionId,
    selectionSha256: request.selectionSha256,
    policyId: admission.policyId,
    policyVersion: admission.policyVersion,
    policyArtifactId: admission.policyArtifactId,
    policyArtifactSha256: admission.policyArtifactSha256,
    periodId: admission.periodId,
    startsAt: admission.startsAt,
    expiresAt: admission.expiresAt,
    maximumTokens: exact(maximumTokens),
    maximumCostUnits: exact(maximumCost),
  };
  const windowId = `model-window:${await modelUseHash(boundary, windowIdentity)}`;
  const scope = sql`account_alias = ${request.accountAlias} and environment = ${request.environment}`;
  const prior = (
    await tx.execute(
      sql`select * from vertex_model_use_budget_reservations where ${scope} and job_id = ${request.jobId} and selection_id = ${request.selectionId} and request_sha256 = ${request.requestSha256} limit 1`
    )
  ).rows[0] as Record<string, unknown> | undefined;
  if (prior) {
    const value = prior["payload"] as {
      request: ModelUseRequestRecord;
      grant: ModelUseGrantRecord;
      reservation: ModelBudgetReservation;
      admission: ModelBudgetAdmission;
      tokenCharge: string;
      costChargeUnits: string;
      windowId: string;
      windowRevision: string;
    };
    if (
      !value?.grant ||
      (await modelUseHash(boundary, value.grant)) !==
        (await modelUseHash(boundary, grant))
    )
      return fail("conflict");
    if (
      !value ||
      (await modelUseHash(boundary, value)) !== prior["record_hash"] ||
      (await modelUseHash(boundary, value.request)) !==
        (await modelUseHash(boundary, request)) ||
      (await modelUseHash(boundary, value.admission)) !==
        (await modelUseHash(boundary, admission)) ||
      value.windowId !== windowId ||
      prior["window_id"] !== windowId ||
      prior["request_id"] !== request.requestId ||
      prior["grant_id"] !== request.grantId ||
      prior["grant_version"] !== request.grantVersion ||
      prior["lease_id"] !== request.leaseId ||
      prior["lease_epoch"] !== request.leaseEpoch ||
      prior["selection_sha256"] !== request.selectionSha256 ||
      prior["token_charge"] !== exact(tokenCharge) ||
      prior["cost_charge_units"] !== exact(costCharge) ||
      prior["reservation_id"] !== reservation.reservationId ||
      (await modelUseHash(boundary, value.reservation)) !==
        (await modelUseHash(boundary, reservation))
    )
      return fail("conflict");
    return Object.freeze({ reservation, externalDispatchAllowed: false });
  }
  // Per-job ceilings include ALL prior model grants and periods for the exact
  // selection. Unknown external outcomes and expired rows remain fully charged.
  const job = (
    await tx.execute(
      sql`select coalesce(sum(token_charge),0)::text as tokens, coalesce(sum(cost_charge_units),0)::text as cost from vertex_model_use_budget_reservations where ${scope} and job_id = ${request.jobId} and selection_id = ${request.selectionId}`
    )
  ).rows[0] as { tokens: string; cost: string };
  if (
    units(job.tokens) + tokenCharge > jobMaximumTokens ||
    units(job.cost) + costCharge > jobMaximumCost
  )
    return fail("denied");
  const existing = (
    await tx.execute(
      sql`select * from vertex_model_use_budget_windows where ${scope} and window_id = ${windowId} for update`
    )
  ).rows[0] as Record<string, unknown> | undefined;
  let reservedTokens = 0n;
  let reservedCost = 0n;
  let revision = 0n;
  if (existing) {
    const body = existing["payload"] as {
      identity: typeof windowIdentity;
      reservedTokens: string;
      reservedCostUnits: string;
      revision: string;
    };
    if (
      !body ||
      (await modelUseHash(boundary, body)) !== existing["record_hash"] ||
      (await modelUseHash(boundary, body.identity)) !==
        (await modelUseHash(boundary, windowIdentity)) ||
      body.reservedTokens !== existing["reserved_tokens"] ||
      body.reservedCostUnits !== existing["reserved_cost_units"] ||
      body.revision !== existing["revision"] ||
      existing["maximum_tokens"] !== exact(maximumTokens) ||
      existing["maximum_cost_units"] !== exact(maximumCost)
    )
      return fail("integrity");
    reservedTokens = units(body.reservedTokens);
    reservedCost = units(body.reservedCostUnits);
    revision = units(body.revision);
  }
  if (
    reservedTokens + tokenCharge > maximumTokens ||
    reservedCost + costCharge > maximumCost
  )
    return fail("denied");
  const next = {
    identity: windowIdentity,
    reservedTokens: exact(reservedTokens + tokenCharge),
    reservedCostUnits: exact(reservedCost + costCharge),
    revision: exact(revision + 1n),
  };
  const updated = (
    await tx.execute(
      sql`insert into vertex_model_use_budget_windows (account_alias, environment, window_id, selection_id, selection_sha256, policy_id, policy_version, policy_artifact_sha256, period_id, starts_at_ns, expires_at_ns, maximum_tokens, maximum_cost_units, reserved_tokens, reserved_cost_units, revision, record_hash, payload) values (${request.accountAlias}, ${request.environment}, ${windowId}, ${request.selectionId}, ${request.selectionSha256}, ${admission.policyId}, ${admission.policyVersion}, ${admission.policyArtifactSha256}, ${admission.periodId}, ${boundary.epochNanoseconds(admission.startsAt).toString()}, ${boundary.epochNanoseconds(admission.expiresAt).toString()}, ${exact(maximumTokens)}, ${exact(maximumCost)}, ${next.reservedTokens}, ${next.reservedCostUnits}, ${next.revision}, ${await modelUseHash(boundary, next)}, ${json(next)}) on conflict (account_alias, environment, window_id) do update set reserved_tokens = excluded.reserved_tokens, reserved_cost_units = excluded.reserved_cost_units, revision = excluded.revision, record_hash = excluded.record_hash, payload = excluded.payload where vertex_model_use_budget_windows.revision = ${exact(revision)} returning revision`
    )
  ).rows;
  if (updated.length !== 1) return fail("conflict");
  const body = {
    request,
    grant,
    reservation,
    admission,
    tokenCharge: exact(tokenCharge),
    costChargeUnits: exact(costCharge),
    windowId,
    windowRevision: next.revision,
  };
  await tx.execute(
    sql`insert into vertex_model_use_budget_reservations (account_alias, environment, job_id, selection_id, selection_sha256, request_sha256, reservation_id, operation, input_bytes, input_tokens, maximum_output_tokens, maximum_cost_usd, token_charge, cost_charge_units, expires_at_ns, record_hash, payload, window_id, request_id, grant_id, grant_version, lease_id, lease_epoch, window_revision) values (${request.accountAlias}, ${request.environment}, ${request.jobId}, ${request.selectionId}, ${request.selectionSha256}, ${request.requestSha256}, ${reservation.reservationId}, ${request.operation}, ${request.inputBytes.toString()}, ${request.inputTokens === null ? null : request.inputTokens.toString()}, ${request.maximumOutputTokens.toString()}, ${request.maximumCostUsd}, ${exact(tokenCharge)}, ${exact(costCharge)}, ${boundary.epochNanoseconds(admission.expiresAt).toString()}, ${await modelUseHash(boundary, body)}, ${json(body)}, ${windowId}, ${request.requestId}, ${request.grantId}, ${request.grantVersion}, ${request.leaseId}, ${request.leaseEpoch}, ${next.revision})`
  );
  return Object.freeze({ reservation, externalDispatchAllowed: true });
};
