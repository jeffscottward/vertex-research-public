import type {
  AcceptedReview,
  PaperSimulationAdmission,
  StrategySpec,
  TradeIntent,
} from "@darkfactory/api/vertex";
import { timestampToEpochNanoseconds } from "@darkfactory/shared/vertex";
import type {
  ExperienceScope,
  ImmutableArtifact,
  ReviewDecisionCommand,
  SimulationProposalCommand,
  SimulationQueueReceipt,
} from "./ports.ts";

// Defensive presentation checks only. The server still verifies the immutable
// payload hashes, actor, policy, current predecessor and admission atomically.
export type StrategySelection = Readonly<{
  artifactId: string;
  sha256: string;
}>;
export type ReviewTarget = StrategySelection &
  Readonly<{ strategyVersion: string }>;
export type ReviewModel = Readonly<{
  status: "unreviewed" | "accepted" | "rejected" | "expired" | "invalid";
  latest: AcceptedReview | null;
  expectedReviewId: string | null;
  detail: string;
}>;
export type ReviewContext = Readonly<{
  scope: ExperienceScope;
  target: ReviewTarget;
  purpose: AcceptedReview["purpose"];
  reviews: readonly AcceptedReview[];
  now: string;
}>;

const identifier = (value: string): boolean =>
  /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value);
const digest = (value: string): boolean => /^[0-9a-f]{64}$/.test(value);
const time = (value: string): bigint | null => {
  try {
    return timestampToEpochNanoseconds(value);
  } catch {
    return null;
  }
};

const validTarget = (target: ReviewTarget): boolean =>
  identifier(target.artifactId) &&
  digest(target.sha256) &&
  identifier(target.strategyVersion);
const fail = (detail: string): never => {
  throw new Error(detail);
};
const invalidReview = (detail: string): ReviewModel => ({
  status: "invalid",
  latest: null,
  expectedReviewId: null,
  detail,
});

export const isExactStrategySelection = (
  selection: StrategySelection,
  strategy: ImmutableArtifact<StrategySpec>
): boolean => {
  return (
    identifier(selection.artifactId) &&
    digest(selection.sha256) &&
    selection.artifactId === strategy.artifactId &&
    selection.sha256 === strategy.sha256
  );
};

// React key includes every immutable identity and the private account scope.
// A changed version/hash/account/environment must unmount all pending actions.
export const strategySelectionKey = (
  scope: ExperienceScope,
  selection: StrategySelection
): string => {
  return JSON.stringify([
    scope.accountAlias,
    scope.environment,
    selection.artifactId,
    selection.sha256,
  ]);
};

export const buildReviewModel = ({
  scope,
  target,
  purpose,
  reviews,
  now,
}: ReviewContext): ReviewModel => {
  const clock = time(now);
  if (
    !(validTarget(target) && identifier(scope.accountAlias)) ||
    clock === null
  )
    return invalidReview(
      "The artifact identity or comparison time is invalid."
    );
  if (purpose === "paper-simulation" && scope.environment !== "paper")
    return invalidReview(
      "Paper-simulation review is available only in a paper scope."
    );
  const relevant = reviews.filter(
    (review) =>
      review.accountAlias === scope.accountAlias &&
      review.environment === scope.environment &&
      review.artifactId === target.artifactId &&
      review.purpose === purpose
  );
  if (relevant.length === 0)
    return {
      status: "unreviewed",
      latest: null,
      expectedReviewId: null,
      detail: "No server review for this exact artifact and purpose.",
    };
  const byId = new Map<string, AcceptedReview>();
  for (const review of relevant) {
    const reviewedAt = time(review.reviewedAt);
    const expiresAt = time(review.expiresAt);
    if (
      byId.has(review.reviewId) ||
      !identifier(review.reviewId) ||
      !identifier(review.actorId) ||
      !/^\d+\.\d+\.\d+$/.test(review.policyVersion) ||
      !/^\d+\.\d+\.\d+$/.test(review.reviewVersion)
    )
      return invalidReview(
        "The server review history has duplicate or invalid identities."
      );
    if (
      review.artifactSha256 !== target.sha256 ||
      review.strategyVersion !== target.strategyVersion ||
      review.executionAuthorized !== false
    )
      return invalidReview(
        "A review does not bind this exact immutable hash and strategyVersion."
      );
    if (
      reviewedAt === null ||
      expiresAt === null ||
      reviewedAt > clock ||
      expiresAt <= reviewedAt
    )
      return invalidReview("A review has an invalid or future chronology.");
    if (review.decision !== "accepted" && review.decision !== "rejected")
      return invalidReview("A review does not contain an explicit decision.");
    byId.set(review.reviewId, review);
  }
  const successors = new Set<string>();
  for (const review of relevant) {
    if (review.supersedesReviewId === null) continue;
    const previous = byId.get(review.supersedesReviewId);
    if (
      previous === undefined ||
      previous.reviewId === review.reviewId ||
      successors.has(previous.reviewId)
    )
      return invalidReview(
        "The review predecessor chain is missing, cyclic or branched. Reload authoritative history."
      );
    const previousAt = time(previous.reviewedAt);
    const currentAt = time(review.reviewedAt);
    if (previousAt === null || currentAt === null || currentAt < previousAt)
      return invalidReview("Review supersession chronology is inconsistent.");
    successors.add(previous.reviewId);
  }
  const roots = relevant.filter((review) => review.supersedesReviewId === null);
  const heads = relevant.filter((review) => !successors.has(review.reviewId));
  if (roots.length !== 1 || heads.length !== 1)
    return invalidReview(
      "There is no unique latest server review. Reload authoritative history."
    );
  const latest = heads[0];
  if (latest === undefined)
    return invalidReview(
      "There is no unique latest server review. Reload authoritative history."
    );
  const visited = new Set<string>();
  let cursor: AcceptedReview | undefined = latest;
  while (cursor !== undefined) {
    if (visited.has(cursor.reviewId))
      return invalidReview("The server review history contains a cycle.");
    visited.add(cursor.reviewId);
    cursor =
      cursor.supersedesReviewId === null
        ? undefined
        : byId.get(cursor.supersedesReviewId);
  }
  if (visited.size !== relevant.length)
    return invalidReview(
      "The review history contains disconnected supersession records."
    );
  const expiry = time(latest.expiresAt);
  if (expiry === null || expiry <= clock)
    return {
      status: "expired",
      latest,
      expectedReviewId: latest.reviewId,
      detail: "The latest review expired. Earlier acceptance is not restored.",
    };
  return {
    status: latest.decision,
    latest,
    expectedReviewId: latest.reviewId,
    detail:
      latest.decision === "accepted"
        ? "Accepted for this exact artifact and purpose only. No broker authority."
        : "The latest review rejects this artifact for this purpose. Earlier acceptance is superseded.",
  };
};

export const buildReviewDecisionCommand = (
  input: ReviewContext &
    Readonly<{
      decision: AcceptedReview["decision"] | null;
      acknowledged: boolean;
      acknowledgedTarget: ReviewTarget | null;
      expectedReviewId: string | null;
      idempotencyKey: string;
    }>
): ReviewDecisionCommand => {
  const model = buildReviewModel(input);
  if (model.status === "invalid") return fail(model.detail);
  if (input.scope.environment === "live")
    return fail(
      "Live scope is observation-only. No review mutation is available here."
    );
  if (input.decision !== "accepted" && input.decision !== "rejected")
    return fail("Choose accept or reject explicitly.");
  const acknowledged = input.acknowledgedTarget;
  if (
    !input.acknowledged ||
    acknowledged === null ||
    acknowledged.artifactId !== input.target.artifactId ||
    acknowledged.sha256 !== input.target.sha256 ||
    acknowledged.strategyVersion !== input.target.strategyVersion
  )
    return fail(
      "Confirm the exact selected artifact and hash before recording a decision."
    );
  if (input.expectedReviewId !== model.expectedReviewId)
    return fail("The latest review changed. Read it again before deciding.");
  if (!identifier(input.idempotencyKey))
    return fail("A valid request identity is required.");
  return {
    ...input.scope,
    artifactId: input.target.artifactId,
    artifactSha256: input.target.sha256,
    strategyVersion: input.target.strategyVersion,
    decision: input.decision,
    purpose: input.purpose,
    expectedReviewId: input.expectedReviewId,
    idempotencyKey: input.idempotencyKey,
  };
};

export const validateReviewResponse = (
  command: ReviewDecisionCommand,
  review: AcceptedReview,
  now: string
): AcceptedReview => {
  const clock = time(now);
  const reviewed = time(review.reviewedAt);
  const expiry = time(review.expiresAt);
  if (
    review.accountAlias !== command.accountAlias ||
    review.environment !== command.environment ||
    review.artifactId !== command.artifactId ||
    review.artifactSha256 !== command.artifactSha256 ||
    review.strategyVersion !== command.strategyVersion ||
    review.purpose !== command.purpose ||
    review.decision !== command.decision ||
    review.supersedesReviewId !== command.expectedReviewId ||
    review.reviewId === command.expectedReviewId ||
    review.executionAuthorized !== false
  )
    return fail(
      "The server response does not match the exact requested decision and predecessor. Reload the dossier."
    );
  if (
    clock === null ||
    reviewed === null ||
    expiry === null ||
    reviewed > clock ||
    expiry <= clock ||
    expiry <= reviewed ||
    !identifier(review.reviewId) ||
    !identifier(review.actorId) ||
    !/^\d+\.\d+\.\d+$/.test(review.policyVersion) ||
    !/^\d+\.\d+\.\d+$/.test(review.reviewVersion)
  )
    return fail(
      "The returned review is not a current server-bound record. Reload the dossier."
    );
  return review;
};

export const buildSimulationProposalCommand = (
  input: Readonly<{
    scope: ExperienceScope;
    strategy: StrategySelection;
    draft: ImmutableArtifact<TradeIntent>;
    reviews: readonly AcceptedReview[];
    admission: PaperSimulationAdmission | null;
    acknowledged: boolean;
    acknowledgedAdmissionId: string | null;
    now: string;
  }>
): SimulationProposalCommand => {
  const { scope, strategy, draft, admission } = input;
  if (
    scope.environment !== "paper" ||
    draft.value.environment !== "paper" ||
    draft.value.accountAlias !== scope.accountAlias
  )
    return fail(
      "Only a matching paper account draft can be queued for simulation."
    );
  if (
    !(identifier(strategy.artifactId) && digest(strategy.sha256)) ||
    draft.value.strategyVersion !== strategy.artifactId ||
    !identifier(draft.artifactId) ||
    !digest(draft.sha256) ||
    draft.value.proposalOnly !== true ||
    draft.value.executionAuthorized !== false
  )
    return fail(
      "The draft must remain proposal-only and bind the exact immutable StrategySpec artifactId."
    );
  const target: ReviewTarget = {
    artifactId: draft.artifactId,
    sha256: draft.sha256,
    strategyVersion: strategy.artifactId,
  };
  const review = buildReviewModel({
    scope,
    target,
    purpose: "paper-simulation",
    reviews: input.reviews,
    now: input.now,
  });
  if (review.status !== "accepted" || review.latest === null)
    return fail(
      "A current accepted paper-simulation review of this exact draft is required."
    );
  if (
    admission === null ||
    !input.acknowledged ||
    input.acknowledgedAdmissionId !== admission.admissionId
  )
    return fail(
      "Select and explicitly acknowledge a server-supplied paper-simulation admission."
    );
  const accepted = review.latest;
  if (
    admission.admissionKind !== "PAPER-SIMULATION" ||
    admission.environment !== "paper" ||
    admission.accountAlias !== scope.accountAlias ||
    admission.intentId !== draft.value.intentId ||
    admission.intentSha256 !== draft.sha256 ||
    admission.reviewedArtifactSha256 !== draft.sha256 ||
    admission.strategyVersion !== strategy.artifactId ||
    admission.reviewId !== accepted.reviewId ||
    admission.reviewVersion !== accepted.reviewVersion ||
    admission.actorId !== accepted.actorId ||
    admission.policyVersion !== accepted.policyVersion
  )
    return fail(
      "The admission does not bind the exact draft, latest review and server policy."
    );
  if (
    admission.simulationOnly !== true ||
    admission.brokerSubmissionAllowed !== false ||
    admission.liveAuthorization !== false ||
    admission.executionAuthorized !== false
  )
    return fail("Paper simulation cannot grant broker or live authority.");
  const clock = time(input.now);
  const admitted = time(admission.admittedAt);
  const expires = time(admission.expiresAt);
  const reviewed = time(accepted.reviewedAt);
  const reviewExpires = time(accepted.expiresAt);
  const proposed = time(draft.value.proposedAt);
  const draftExpires = time(draft.value.expiresAt);
  if (
    clock === null ||
    admitted === null ||
    expires === null ||
    reviewed === null ||
    reviewExpires === null ||
    proposed === null ||
    draftExpires === null ||
    proposed > admitted ||
    admitted < reviewed ||
    admitted > clock ||
    expires <= admitted ||
    expires <= clock ||
    draftExpires <= clock ||
    expires > reviewExpires ||
    expires > draftExpires
  )
    return fail(
      "The draft, review or admission is expired or has inconsistent chronology."
    );
  if (
    !(identifier(admission.admissionId) && identifier(admission.idempotencyKey))
  )
    return fail(
      "The server admission lacks a valid immutable request identity."
    );
  return {
    accountAlias: scope.accountAlias,
    environment: "paper",
    admissionId: admission.admissionId,
    reviewId: accepted.reviewId,
    reviewVersion: accepted.reviewVersion,
    intentId: draft.value.intentId,
    intentSha256: draft.sha256,
    strategyVersion: strategy.artifactId,
    idempotencyKey: admission.idempotencyKey,
    simulationOnly: true,
    brokerSubmissionAllowed: false,
    liveAuthorization: false,
  };
};

export const validateSimulationQueueReceipt = (
  command: SimulationProposalCommand,
  receipt: SimulationQueueReceipt
): SimulationQueueReceipt => {
  if (
    !identifier(receipt.jobId) ||
    receipt.admissionId !== command.admissionId ||
    receipt.status !== "queued" ||
    receipt.simulationOnly !== true ||
    receipt.brokerSubmissionAllowed !== false ||
    receipt.liveAuthorization !== false
  )
    return fail(
      "The queue receipt does not match this simulation-only admission. Inspect Audit before retrying."
    );
  return receipt;
};
