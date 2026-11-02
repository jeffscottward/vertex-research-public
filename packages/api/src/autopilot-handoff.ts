// Autopilot hand-off (pure): the paper Nautilus config of a verified candidate, the library
// strategy that carries it into the existing deployment-request flow, and the live-readiness
// checklist. The checklist always ends "not allowed": Autopilot never requests or arms live trading.

import {
  AUTOPILOT_NAUTILUS_FORMAT,
  type AutopilotCandidateDetailOutput,
} from "./contracts/autopilot.ts";
import type { StrategyDefinition } from "./strategy-dsl.ts";

export const AUTOPILOT_LIBRARY_SECTION = "Autopilot";
const AUTOPILOT_NAUTILUS_ENGINE = "nautilus_trader 2.0.0rc5 on the Quant VPS";
const AUTOPILOT_NAUTILUS_ADAPTER = "vertex-dsl-v1";
const AUTOPILOT_NAUTILUS_NOTE =
  "Paper hand-off input only. The Quant VPS Nautilus adapter that runs DSL definitions is not deployed yet, and nothing is armed: the owner approves the paper request, and Quant VPS operators arm it separately.";

type HandoffCandidate = Readonly<{
  id: string;
  campaignId: string;
  label: string;
}>;
type HandoffCampaign = Readonly<{
  symbol: string;
  timeframe: string;
  gateVersion: string;
}>;

export const autopilotDefinitionId = (candidateId: string): string =>
  `autopilot-${candidateId}`;

export const nautilusPaperConfig = (
  candidate: HandoffCandidate,
  campaign: HandoffCampaign,
  definition: StrategyDefinition,
  definitionSha256: string
): NonNullable<AutopilotCandidateDetailOutput["nautilus"]> => ({
  armed: false,
  autopilot: {
    campaignId: candidate.campaignId,
    candidateId: candidate.id,
    gateVersion: campaign.gateVersion,
  },
  engine: AUTOPILOT_NAUTILUS_ENGINE,
  format: AUTOPILOT_NAUTILUS_FORMAT,
  instrument: { symbol: campaign.symbol, timeframe: campaign.timeframe },
  mode: "paper",
  note: AUTOPILOT_NAUTILUS_NOTE,
  strategy: {
    adapter: AUTOPILOT_NAUTILUS_ADAPTER,
    definition,
    definitionSha256,
  },
});

const fixed = (name: string, title: string, value: string) => ({
  default: value,
  name,
  options: [value],
  title,
  type: "choice",
});

/** Library strategy for the hand-off: fixed parameters pin the exact definition revision. */
export const autopilotLibraryStrategy = (
  candidate: HandoffCandidate,
  campaign: HandoffCampaign,
  definitionSha256: string
) => ({
  description:
    `Autopilot candidate ${candidate.id} (campaign ${candidate.campaignId}), verified by ${campaign.gateVersion}: ${candidate.label}`.slice(
      0,
      2000
    ),
  kind: "external" as const,
  name: `Autopilot ${campaign.symbol} ${candidate.label}`.slice(0, 200),
  params: [
    fixed(
      "definitionId",
      "Strategy definition",
      autopilotDefinitionId(candidate.id)
    ),
    fixed("definitionSha256", "Definition SHA-256", definitionSha256),
    fixed("autopilotCandidate", "Autopilot candidate", candidate.id),
    fixed(
      "nautilusFormat",
      "Nautilus hand-off format",
      AUTOPILOT_NAUTILUS_FORMAT
    ),
  ],
  section: AUTOPILOT_LIBRARY_SECTION,
  // One library strategy per candidate, whatever its label.
  slug: `autopilot-${candidate.id}`,
  status: "paper" as const,
  tags: ["autopilot"],
});

/**
 * Live readiness: the master-rule and approval checks a live request would need. Long-only DSL
 * strategies trade the underlying, which the owner's options-only rule blocks, so live is never
 * allowed from here.
 */
export const autopilotLiveReadiness = (
  input: Readonly<{ verified: boolean; paperRequestId: string | null }>
): AutopilotCandidateDetailOutput["liveReadiness"] => ({
  allowed: false,
  checks: [
    {
      detail: input.verified
        ? "Every gate check passed, including the parameter neighbourhood."
        : "The candidate did not pass the verification gate.",
      id: "gate",
      label: "Verification gate",
      status: input.verified ? "pass" : "conflict",
    },
    {
      detail:
        input.paperRequestId === null
          ? "No paper deployment request exists. Send the candidate to paper first."
          : `Paper request ${input.paperRequestId} exists; it needs the owner's approval and a forward paper record.`,
      id: "paper",
      label: "Paper record first",
      status: "conflict",
    },
    {
      detail:
        "The strategy holds the underlying (long shares). The owner's options-only rule blocks new share positions in live accounts.",
      id: "optionsOnly",
      label: "Master rule: options only",
      status: "conflict",
    },
    {
      detail:
        "Live trading needs the existing deployment approval and the owner's password. Autopilot never requests or arms live trading.",
      id: "ownerApproval",
      label: "Owner approval",
      status: "conflict",
    },
  ],
});
