// Paper path rehearsal, deployment-request step (paper only, card vertex-paper-deploy-path).
//
// Runs paper deployment requests WITH an options block through the real rules in one process: the API
// contract (create and createGroup inputs), the repository field rules (symbol, timeframe, limits,
// options with the 2% ceiling) and the status lifecycle (submit, approve). It returns the approved
// requests as records for the python paper strategy. No database, no network, no row: the strategy
// lookup, the preset lookup and the Postgres check constraints are NOT rehearsed here.
//
// Used by research/backtests/allocation/paper_path_rehearsal.py:
//   bun --no-env-file scripts/research-paper-path-requests.ts < items.json
// stdin: {items, probes}; each entry is {kind: "single" | "group", input}. stdout: one JSON report.
import {
  DEPLOYMENT_NOT_DISPATCHED_REASON,
  DeploymentLockSchema,
  DeploymentRequestCreateGroupInputSchema,
  DeploymentRequestCreateInputSchema,
} from "../../packages/api/src/contracts/deployment-requests.ts";
import {
  checkDeploymentTransition,
  type DeploymentRequestOptions,
  normalizeDeploymentLimits,
  normalizeDeploymentOptions,
  normalizeDeploymentSymbol,
  normalizeDeploymentTimeframe,
} from "../../packages/db/src/server/deployment-requests.ts";

export interface PaperPathItem {
  kind: "single" | "group";
  input: unknown;
  probe?: string;
  sleeve?: string;
}

export interface PaperPathRecord {
  id: string;
  strategyId: string;
  presetId: null;
  params: Record<string, never>;
  symbol: string;
  timeframe: string;
  mode: "paper";
  limits: ReturnType<typeof normalizeDeploymentLimits>;
  options: DeploymentRequestOptions | null;
  status: "approved";
  executionAuthorized: false;
  brokerSubmissionAllowed: false;
  dispatch: { state: "not-dispatched"; reason: string };
}

export interface PaperPathRefusal {
  index: number;
  kind: string;
  probe: string | null;
  refusedAt: "contract" | "fields";
  refusal: string;
}

export interface PaperPathReport {
  lock: {
    executionAuthorized: false;
    brokerSubmissionAllowed: false;
    dispatchState: "not-dispatched";
    dispatchReason: string;
  };
  notRehearsed: string[];
  records: PaperPathRecord[];
  refusals: PaperPathRefusal[];
  probes: Array<{
    probe: string | null;
    approved: number;
    refusal: string | null;
    options: boolean;
  }>;
}

interface Outcome {
  records: PaperPathRecord[];
  refusal: Omit<PaperPathRefusal, "index" | "kind" | "probe"> | null;
}

const issuesText = (
  issues: readonly { path: PropertyKey[]; message: string }[]
) =>
  issues
    .map((issue) => `${["input", ...issue.path].join(".")}: ${issue.message}`)
    .join("; ");

const rehearseItem = (item: PaperPathItem, prefix: string): Outcome => {
  const group = item.kind === "group";
  const parsed = group
    ? DeploymentRequestCreateGroupInputSchema.safeParse(item.input)
    : DeploymentRequestCreateInputSchema.safeParse(item.input);
  if (!parsed.success)
    return {
      records: [],
      refusal: {
        refusal: issuesText(parsed.error.issues),
        refusedAt: "contract",
      },
    };
  const input = parsed.data as {
    limits?: unknown;
    options?: unknown;
    strategyId?: unknown;
    symbol?: unknown;
    symbols?: unknown[];
    timeframe?: unknown;
  };
  const lock = DeploymentLockSchema.parse({
    brokerSubmissionAllowed: false,
    dispatch: {
      reason: DEPLOYMENT_NOT_DISPATCHED_REASON,
      state: "not-dispatched",
    },
    executionAuthorized: false,
  });
  try {
    const symbols = (group ? (input.symbols ?? []) : [input.symbol]).map(
      normalizeDeploymentSymbol
    );
    const timeframe = normalizeDeploymentTimeframe(input.timeframe);
    const limits = normalizeDeploymentLimits(input.limits);
    const records = symbols.map((symbol, at): PaperPathRecord => {
      // createGroup: the server fills the group (its key and the symbols of the input).
      const options = normalizeDeploymentOptions(
        group
          ? {
              ...(input.options as object),
              group: { key: `${prefix}-group`, symbols },
            }
          : input.options,
        symbol
      );
      if (group && options === null)
        throw new Error("a group needs an options block");
      checkDeploymentTransition(
        "approve",
        checkDeploymentTransition("submit", "draft")
      );
      return {
        id: `${prefix}-${at + 1}`,
        strategyId: String(input.strategyId),
        presetId: null,
        params: {},
        symbol,
        timeframe,
        mode: "paper",
        limits,
        options,
        status: "approved",
        ...lock,
      };
    });
    return { records, refusal: null };
  } catch (error) {
    return {
      records: [],
      refusal: {
        refusal: String((error as Error).message),
        refusedAt: "fields",
      },
    };
  }
};

export const rehearsePaperPathRequests = (
  items: readonly PaperPathItem[],
  probes: readonly PaperPathItem[] = []
): PaperPathReport => {
  const lock = DeploymentLockSchema.parse({
    brokerSubmissionAllowed: false,
    dispatch: {
      reason: DEPLOYMENT_NOT_DISPATCHED_REASON,
      state: "not-dispatched",
    },
    executionAuthorized: false,
  });
  const records: PaperPathRecord[] = [];
  const refusals: PaperPathRefusal[] = [];
  items.forEach((item, index) => {
    const outcome = rehearseItem(item, `rehearsal-request-${index + 1}`);
    records.push(...outcome.records);
    if (outcome.refusal !== null)
      refusals.push({
        index,
        kind: item.kind,
        probe: null,
        ...outcome.refusal,
      });
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
    probes: probes.map((item, index) => {
      const outcome = rehearseItem(item, `rehearsal-probe-${index + 1}`);
      return {
        approved: outcome.records.length,
        options: outcome.records.some((record) => record.options !== null),
        probe: item.probe ?? null,
        refusal: outcome.refusal?.refusal ?? null,
      };
    }),
    records,
    refusals,
  };
};

interface CliIo {
  readInput: () => string;
  stderr: { write: (text: string) => unknown };
  stdout: { write: (text: string) => unknown };
}

// stdin: {items, probes} of create inputs. stdout: one JSON report. Exit code 1 when items is not an array.
export const runPaperPathRequestsCli = (io: CliIo): number => {
  const input = JSON.parse(io.readInput()) as {
    items?: PaperPathItem[];
    probes?: PaperPathItem[];
  } | null;
  if (!Array.isArray(input?.items)) {
    io.stderr.write("stdin needs an items array\n");
    return 1;
  }
  io.stdout.write(
    `${JSON.stringify(rehearsePaperPathRequests(input.items, input.probes ?? []))}\n`
  );
  return 0;
};
