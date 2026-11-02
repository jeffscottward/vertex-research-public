import type {
  AcceptedReview,
  AgentRun,
  BacktestRun,
  BrokerRecoveryStatus,
  DatasetManifest,
  ExecutionProjection,
  NativeFactProjection,
  PaperSimulationAdmission,
  ResearchEvidence,
  StrategySpec,
  TradeIntent,
  VertexContinuityGetInput,
  VertexContinuityRead,
  VertexPortfolioGetInput,
  VertexPortfolioRead,
  VertexResearchChatCreateThreadInput,
  VertexResearchChatListMessagesInput,
  VertexResearchChatListMessagesOutput,
  VertexResearchChatListThreadsInput,
  VertexResearchChatListThreadsOutput,
  VertexResearchChatReadThreadInput,
  VertexResearchChatReadThreadOutput,
  VertexResearchChatRosterInput,
  VertexResearchChatRosterOutput,
  VertexResearchChatSendMessageInput,
  VertexResearchChatSendMessageOutput,
  VertexResearchChatThread,
  VertexResearchChatReadTranscriptPageInput,
  VertexResearchChatReadTranscriptPageOutput,
  VertexResearchChatPrepareResponseInput,
  VertexResearchChatPrepareResponseOutput,
  VertexResearchChatApproveAndRequestResponseInput,
  VertexResearchChatApproveAndRequestResponseOutput,
  VertexResearchChatReadResponseInput,
  VertexResearchChatReadResponseOutput,
  VertexResearchChatAppendResponseInput,
  VertexResearchChatAppendResponseOutput,
  VertexResearchChatReadResponseContentInput,
  VertexResearchChatReadResponseContentOutput,
  VertexResearchChatDebateStepInput,
  VertexResearchChatDebateApproveInput,
  VertexResearchChatDebatePrepareOutput,
  VertexResearchChatReadDebateRunInput,
  VertexResearchChatReadDebateRunOutput,
  VertexResearchChatNativeEvidenceRequest,
  VertexResearchChatNativeEvidenceApproveInput,
  VertexResearchChatNativeEvidencePrepareOutput,
  VertexGatewayBinding,
} from "@darkfactory/api/vertex";

// UI composition ports, not a parallel wire schema, auth service, or execution authority.
// The authenticated adapter must validate every artifact and authorize every scope.
export type ExperienceScope = VertexPortfolioGetInput;
export type AuditProjection = ExecutionProjection | NativeFactProjection;
export type ScopedArtifactInput = ExperienceScope &
  Readonly<{ artifactId: string }>;
export type ImmutableArtifact<T> = Readonly<{
  artifactId: string;
  sha256: string;
  value: T;
}>;
export type StrategyDossier = Readonly<{
  strategy: ImmutableArtifact<StrategySpec>;
  drafts: readonly ImmutableArtifact<TradeIntent>[];
  evidence: readonly ResearchEvidence[];
  datasets: readonly DatasetManifest[];
  backtests: readonly ImmutableArtifact<BacktestRun>[];
  reviews: readonly AcceptedReview[];
  admissions: readonly PaperSimulationAdmission[];
}>;
export type DecisionInbox = Readonly<{
  strategies: readonly ImmutableArtifact<StrategySpec>[];
  agents: readonly ImmutableArtifact<AgentRun>[];
  reviews: readonly AcceptedReview[];
  continuity: VertexContinuityRead;
}>;
export type ReviewDecisionCommand = ExperienceScope &
  Readonly<{
    artifactId: string;
    artifactSha256: string;
    strategyVersion: string;
    decision: AcceptedReview["decision"];
    purpose: AcceptedReview["purpose"];
    expectedReviewId: string | null;
    idempotencyKey: string;
  }>;
export type ResearchProposalCommand = ExperienceScope &
  Readonly<{
    question: string;
    collectionId: string;
    evidenceIds: readonly string[];
    role: AgentRun["agentRole"];
    idempotencyKey: string;
    proposalOnly: true;
    executionAuthorized: false;
  }>;
export type SimulationProposalCommand = Readonly<{
  accountAlias: string;
  environment: "paper";
  admissionId: string;
  reviewId: string;
  reviewVersion: string;
  intentId: string;
  intentSha256: string;
  strategyVersion: string;
  idempotencyKey: string;
  simulationOnly: true;
  brokerSubmissionAllowed: false;
  liveAuthorization: false;
}>;
export type SimulationQueueReceipt = Readonly<{
  jobId: string;
  admissionId: string;
  status: "queued";
  simulationOnly: true;
  brokerSubmissionAllowed: false;
  liveAuthorization: false;
}>;
export interface ExperienceReadPort {
  // The account scopes this session may read, so pages can list data by
  // default (owner rule 2026-10-30: no page needs a typed ID or scope).
  readonly scopes: (
    input: undefined,
    signal: AbortSignal
  ) => Promise<readonly ExperienceScope[]>;
  readonly portfolio: (
    input: ExperienceScope,
    signal: AbortSignal
  ) => Promise<VertexPortfolioRead>;
  readonly continuity: (
    input: VertexContinuityGetInput,
    signal: AbortSignal
  ) => Promise<VertexContinuityRead>;
  readonly inbox: (
    input: ExperienceScope,
    signal: AbortSignal
  ) => Promise<DecisionInbox>;
  readonly strategies: (
    input: ExperienceScope,
    signal: AbortSignal
  ) => Promise<readonly ImmutableArtifact<StrategySpec>[]>;
  readonly dossier: (
    input: ScopedArtifactInput,
    signal: AbortSignal
  ) => Promise<StrategyDossier>;
  readonly agents: (
    input: ExperienceScope,
    signal: AbortSignal
  ) => Promise<readonly ImmutableArtifact<AgentRun>[]>;
  readonly agent: (
    input: ScopedArtifactInput,
    signal: AbortSignal
  ) => Promise<ImmutableArtifact<AgentRun>>;
  readonly audit: (
    input: ExperienceScope,
    signal: AbortSignal
  ) => Promise<readonly AuditProjection[]>;
  // Configured gateways this session may observe (no typed gateway ID).
  readonly gateways: (
    input: undefined,
    signal: AbortSignal
  ) => Promise<readonly VertexGatewayBinding[]>;
  readonly gateway: (
    input: Readonly<{ gatewayId: string; environment: "paper" | "live" }>,
    signal: AbortSignal
  ) => Promise<BrokerRecoveryStatus>;
}
export interface ExperienceReviewPort {
  // Server binds actor, current policy, expiry and optimistic predecessor atomically.
  // Acceptance NEVER changes TradeIntent's strict proposalOnly/executionAuthorized flags.
  readonly decide: (
    input: ReviewDecisionCommand,
    signal: AbortSignal
  ) => Promise<AcceptedReview>;
}
export interface ExperienceJobPort {
  readonly proposeResearch: (
    input: ResearchProposalCommand,
    signal: AbortSignal
  ) => Promise<ImmutableArtifact<AgentRun>>;
  readonly proposeSimulation: (
    input: SimulationProposalCommand,
    signal: AbortSignal
  ) => Promise<SimulationQueueReceipt>;
}
export interface ExperienceResearchChatPort {
  readonly roster: (
    input: VertexResearchChatRosterInput,
    signal: AbortSignal
  ) => Promise<VertexResearchChatRosterOutput>;
  readonly listThreads: (
    input: VertexResearchChatListThreadsInput,
    signal: AbortSignal
  ) => Promise<VertexResearchChatListThreadsOutput>;
  readonly createThread: (
    input: VertexResearchChatCreateThreadInput,
    signal: AbortSignal
  ) => Promise<VertexResearchChatThread>;
  readonly readThread: (
    input: VertexResearchChatReadThreadInput,
    signal: AbortSignal
  ) => Promise<VertexResearchChatReadThreadOutput>;
  readonly listMessages: (
    input: VertexResearchChatListMessagesInput,
    signal: AbortSignal
  ) => Promise<VertexResearchChatListMessagesOutput>;
  readonly readTranscriptPage: (
    input: VertexResearchChatReadTranscriptPageInput,
    signal: AbortSignal
  ) => Promise<VertexResearchChatReadTranscriptPageOutput>;
  readonly sendMessage: (
    input: VertexResearchChatSendMessageInput,
    signal: AbortSignal
  ) => Promise<VertexResearchChatSendMessageOutput>;
  readonly prepareResponse: (
    input: VertexResearchChatPrepareResponseInput,
    signal: AbortSignal
  ) => Promise<VertexResearchChatPrepareResponseOutput>;
  readonly approveAndRequestResponse: (
    input: VertexResearchChatApproveAndRequestResponseInput,
    signal: AbortSignal
  ) => Promise<VertexResearchChatApproveAndRequestResponseOutput>;
  readonly prepareNativeEvidence: (
    input: VertexResearchChatNativeEvidenceRequest,
    signal: AbortSignal
  ) => Promise<VertexResearchChatNativeEvidencePrepareOutput>;
  readonly approveAndRequestNativeEvidence: (
    input: VertexResearchChatNativeEvidenceApproveInput,
    signal: AbortSignal
  ) => Promise<VertexResearchChatApproveAndRequestResponseOutput>;
  readonly prepareDebateStep: (
    input: VertexResearchChatDebateStepInput,
    signal: AbortSignal
  ) => Promise<VertexResearchChatDebatePrepareOutput>;
  readonly approveAndRequestDebateStep: (
    input: VertexResearchChatDebateApproveInput,
    signal: AbortSignal
  ) => Promise<VertexResearchChatApproveAndRequestResponseOutput>;
  readonly readDebateRun: (
    input: VertexResearchChatReadDebateRunInput,
    signal: AbortSignal
  ) => Promise<VertexResearchChatReadDebateRunOutput>;
  readonly readResponse: (
    input: VertexResearchChatReadResponseInput,
    signal: AbortSignal
  ) => Promise<VertexResearchChatReadResponseOutput>;
  readonly appendResponse: (
    input: VertexResearchChatAppendResponseInput,
    signal: AbortSignal
  ) => Promise<VertexResearchChatAppendResponseOutput>;
  readonly readResponseContent: (
    input: VertexResearchChatReadResponseContentInput,
    signal: AbortSignal
  ) => Promise<VertexResearchChatReadResponseContentOutput>;
}
export type ExperienceServices = Readonly<{
  reads: ExperienceReadPort;
  reviews: ExperienceReviewPort | null;
  jobs: ExperienceJobPort | null;
  researchChat?: ExperienceResearchChatPort | null;
}>;
