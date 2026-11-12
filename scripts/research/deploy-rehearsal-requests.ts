// Deployability rehearsal, deployment-request step (paper only, card vertex-deploy-readiness-dryrun).
//
// Runs candidate paper deployment requests through the real rules in one process: the API contract
// (DeploymentRequestCreateInputSchema), the repository field rules (symbol, timeframe, limits) and the
// status lifecycle (submit, approve). No database, no network, no row: the strategy lookup, the preset
// lookup and the Postgres check constraints are NOT rehearsed here.
//
// Used by research/backtests/allocation/deploy_rehearsal.py:
//   bun --no-env-file scripts/research-deploy-rehearsal-requests.ts < requests.json
// stdin: a JSON array of create inputs. stdout: one JSON document (RehearsalReport).
import {
  DEPLOYMENT_NOT_DISPATCHED_REASON,
  DeploymentLockSchema,
  DeploymentRequestCreateInputSchema,
} from "../../packages/api/src/contracts/deployment-requests.ts";
import {
  checkDeploymentTransition,
  normalizeDeploymentLimits,
  normalizeDeploymentSymbol,
  normalizeDeploymentTimeframe,
} from "../../packages/db/src/server/deployment-requests.ts";

type RequestStep = "contract" | "fields" | "submit" | "approve" | "dispatch";

interface RequestOutcome {
  index: number;
  // The last step that passed, in chain order; "approve" means the record would read "approved".
  reached: RequestStep | null;
  refusal: string | null;
  refusedAt: RequestStep | null;
  status: "draft" | "requested" | "approved" | null;
  symbol: string | null;
}

interface RehearsalReport {
  // What every approved request carries. Literal values of the API contract.
  lock: {
    executionAuthorized: false;
    brokerSubmissionAllowed: false;
    dispatchState: "not-dispatched";
    dispatchReason: string;
  };
  notRehearsed: string[];
  requests: RequestOutcome[];
}

const rehearseOne = (input: unknown, index: number): RequestOutcome => {
  const outcome: RequestOutcome = {
    index,
    reached: null,
    refusal: null,
    refusedAt: null,
    status: null,
    symbol: null,
  };
  const parsed = DeploymentRequestCreateInputSchema.safeParse(input);
  if (!parsed.success) {
    outcome.refusedAt = "contract";
    outcome.refusal = parsed.error.issues
      .map((issue) => `${["input", ...issue.path].join(".")}: ${issue.message}`)
      .join("; ");
    return outcome;
  }
  outcome.reached = "contract";
  try {
    outcome.symbol = normalizeDeploymentSymbol(parsed.data.symbol);
    normalizeDeploymentTimeframe(parsed.data.timeframe);
    normalizeDeploymentLimits(parsed.data.limits);
  } catch (error) {
    outcome.refusedAt = "fields";
    outcome.refusal = String((error as Error).message);
    return outcome;
  }
  outcome.reached = "fields";
  outcome.status = "draft";
  outcome.status = checkDeploymentTransition("submit", "draft") as "requested";
  outcome.reached = "submit";
  outcome.status = checkDeploymentTransition(
    "approve",
    "requested"
  ) as "approved";
  outcome.reached = "approve";
  // An approved request stops here: the contract has no dispatched state.
  outcome.refusedAt = "dispatch";
  outcome.refusal = DEPLOYMENT_NOT_DISPATCHED_REASON;
  return outcome;
};

export const rehearseRequests = (
  inputs: readonly unknown[]
): RehearsalReport => {
  const lock = DeploymentLockSchema.parse({
    brokerSubmissionAllowed: false,
    dispatch: {
      reason: DEPLOYMENT_NOT_DISPATCHED_REASON,
      state: "not-dispatched",
    },
    executionAuthorized: false,
  });
  return {
    lock: {
      brokerSubmissionAllowed: lock.brokerSubmissionAllowed,
      dispatchReason: lock.dispatch.reason,
      dispatchState: lock.dispatch.state,
      executionAuthorized: lock.executionAuthorized,
    },
    notRehearsed: [
      "strategy and preset lookup (needs the strategy library rows)",
      "params against the strategy schema",
      "operator session check (API keys are refused)",
      "Postgres check constraints of deployment_requests",
    ],
    requests: inputs.map(rehearseOne),
  };
};

interface CliIo {
  readInput: () => string;
  stderr: { write: (text: string) => unknown };
  stdout: { write: (text: string) => unknown };
}

// stdin: a JSON array of create inputs. stdout: one JSON report. Exit code 1 when stdin is not an array.
export const runDeployRehearsalRequestsCli = (io: CliIo): number => {
  const inputs: unknown = JSON.parse(io.readInput());
  if (!Array.isArray(inputs)) {
    io.stderr.write("stdin must be a JSON array\n");
    return 1;
  }
  io.stdout.write(`${JSON.stringify(rehearseRequests(inputs))}\n`);
  return 0;
};
