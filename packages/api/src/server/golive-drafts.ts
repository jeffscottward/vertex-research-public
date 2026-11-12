import type {
  GoLiveDraftRecord,
  GoLiveDraftsRepository,
  GoLivePlanRecord,
} from "@darkfactory/db/server";
import { call, implement } from "@orpc/server";

import { appContract } from "../contract.ts";
import type {
  GoLiveDraftOutput,
  GoLiveQueueOutput,
  GoLiveQuote,
} from "../contracts/golive-drafts.ts";
import type { JevVerdictOutput } from "../contracts/jev-verdict.ts";
import type { ApiContext } from "./context.ts";
import { evaluateFinalOrderGate } from "./final-order-gate.ts";
import {
  notApprovableReasons,
  orderFor,
  orderSessionDay,
  sameCombo,
  sizeDrafts,
} from "./golive-drafts-sizing.ts";
import { readCachedJevVerdict } from "./jev-verdict.ts";
import { nautilusArmRouter } from "./nautilus-arm.ts";
import { requireOperator } from "./operator-access.ts";
import {
  type FetchPortfolioMonitorOptions,
  fetchPortfolioMonitor,
} from "./portfolio-monitor.ts";

// Go-live draft queue (goLiveDrafts.*). RECORDS ONLY: this module imports no order gateway and
// no order route, and an approval is a stored owner decision (golive-drafts-server.test.ts reads
// this file and fails on such an import).
// queue: operator session, agent viewer or a read key. A key caller never gets the account
// value: the account is not read for it, so its drafts come back unsized (nlv_unavailable).
// collect: the rig generator's write key.
// approve and reject: the owner (operator and admin role) in a browser session; API keys refused.
// Quantity, limit, max loss and the pre-check are computed at read time and never stored.

const api = implement(appContract).$context<ApiContext>();

type NodeBadge = NonNullable<GoLiveDraftOutput["nodeBadgeAtDecision"]>;
type DraftNote = GoLiveDraftOutput["notes"][number];

/** What this service uses of the store (context.repositories.goLiveDrafts): never writePlan. */
export type GoLiveDraftsRepositoryPort = Pick<
  GoLiveDraftsRepository,
  "collect" | "decide" | "lastRun" | "listDrafts" | "planInForce"
>;

export type GoLiveAccountReading = GoLiveQueueOutput["account"];
type GoLiveNodeReading = Readonly<{
  armedAt: string | null;
  badge: NodeBadge;
}>;
/** Market notes by symbol. No reader exists on this branch, so the default is "not deployed". */
type GoLiveMarketNotesPort = (
  symbols: readonly string[]
) => Promise<ReadonlyMap<string, readonly DraftNote[]>>;

export type GoLiveDraftsDependencies = Readonly<{
  account?: (context: ApiContext, now: Date) => Promise<GoLiveAccountReading>;
  // Cached P5 JEV verdict for the dry final gate; defaults to the shared verdict store.
  jevVerdict?: (symbol: string) => JevVerdictOutput | null;
  marketNotes?: GoLiveMarketNotesPort;
  node?: (context: ApiContext) => Promise<GoLiveNodeReading>;
  now?: () => Date;
  // The fetch of the default account reader.
  portfolioFetch?: FetchPortfolioMonitorOptions;
}>;

let dependencies: GoLiveDraftsDependencies = {};
export const setGoLiveDraftsDependenciesForTesting = (
  next: GoLiveDraftsDependencies
): void => {
  dependencies = next;
};

const clock = (): Date => (dependencies.now ?? (() => new Date()))();

// The freshness rule of academy.ts (liveAccount, not exported there): connected, data time at
// most 15 minutes old and at most 60 s in the future, NLV above 0.
const NLV_MAX_AGE_MS = 15 * 60_000;
const NLV_MAX_FUTURE_SKEW_MS = 60_000;

const noAccount = (
  asOf: Date | null,
  unavailableReason: string
): GoLiveAccountReading => ({ asOf, netLiquidation: null, unavailableReason });

// No key-reachable procedure returns account data; the queue keeps it that way.
const KEY_ACCOUNT: GoLiveAccountReading = noAccount(
  null,
  "account value is not shown to API keys"
);

/** NLV from the portfolio monitor (the feed academy.ts reads); null with the cause when unusable. */
const readAccount = async (
  context: ApiContext,
  now: Date
): Promise<GoLiveAccountReading> => {
  try {
    const snapshot = await fetchPortfolioMonitor(
      context.portfolioMonitor ?? null,
      dependencies.portfolioFetch ?? {}
    );
    const time =
      snapshot.status.dataAsOf === null
        ? Number.NaN
        : Date.parse(snapshot.status.dataAsOf);
    if (!Number.isFinite(time))
      return noAccount(null, "Portfolio monitor data has no time");
    const asOf = new Date(time);
    const age = now.getTime() - time;
    if (!snapshot.status.connected)
      return noAccount(asOf, "Portfolio monitor is not connected to IBKR");
    if (!(age >= -NLV_MAX_FUTURE_SKEW_MS && age <= NLV_MAX_AGE_MS))
      return noAccount(asOf, "Portfolio monitor data is not fresh");
    const nlv = snapshot.summary.netLiquidation;
    if (nlv === null || !(nlv > 0))
      return noAccount(asOf, "Portfolio monitor has no net liquidation value");
    return { asOf, netLiquidation: nlv, unavailableReason: null };
  } catch {
    return noAccount(
      null,
      "Portfolio monitor did not answer or is not configured"
    );
  }
};

/**
 * The node badge through the read-only nautilusArm.status procedure, with its own access rules:
 * it refuses agent API keys, so a key caller gets "unknown". Any failure is "unknown".
 */
const readNode = async (context: ApiContext): Promise<GoLiveNodeReading> => {
  try {
    const status = await call(nautilusArmRouter.status, {}, { context });
    return { armedAt: status.arm?.armedAt ?? null, badge: status.badge };
  } catch {
    return { armedAt: null, badge: "unknown" };
  }
};

type Fail = (options?: { message?: string }) => Error;
type Failures = Readonly<{
  CONFLICT: Fail;
  FORBIDDEN: Fail;
  NOT_FOUND: Fail;
  STORAGE_ERROR: Fail;
  VALIDATION_ERROR: Fail;
}>;

const repositoryFor = (
  context: ApiContext,
  failures: Failures
): GoLiveDraftsRepositoryPort => {
  const repository: GoLiveDraftsRepositoryPort | undefined =
    context.repositories.goLiveDrafts;
  if (repository === undefined) throw failures.STORAGE_ERROR();
  return repository;
};

const PLAN_MISMATCH_MESSAGE =
  "The batch was built for a plan that is not the plan in force";

// Store errors by class name (the classes live in @darkfactory/db).
const STORE_ERRORS: ReadonlyMap<
  string,
  Readonly<{ code: "CONFLICT" | "NOT_FOUND"; message: string }>
> = new Map([
  [
    "GoLiveDraftConflictError",
    { code: "CONFLICT", message: "The draft is no longer proposed" },
  ],
  [
    "GoLiveDraftNotFoundError",
    { code: "NOT_FOUND", message: "Draft not found" },
  ],
  [
    "GoLivePlanMismatchError",
    { code: "CONFLICT", message: PLAN_MISMATCH_MESSAGE },
  ],
]);

const storeCall = async <T>(
  failures: Failures,
  run: () => Promise<T>
): Promise<T> => {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    const known = STORE_ERRORS.get(error.name);
    if (known === undefined) throw error;
    throw failures[known.code]({ message: known.message });
  }
};

type Loaded = Readonly<{
  account: GoLiveAccountReading;
  generatedAt: Date | null;
  node: GoLiveQueueOutput["node"];
  // null: no market-notes reader is wired.
  notes: ReadonlyMap<string, readonly DraftNote[]> | null;
  now: Date;
  plan: GoLivePlanRecord | null;
  records: readonly GoLiveDraftRecord[];
}>;

const load = async (
  context: ApiContext,
  repository: GoLiveDraftsRepositoryPort,
  tradingDay: string,
  now: Date
): Promise<Loaded> => {
  const [plan, records, run, account, node] = await Promise.all([
    repository.planInForce(),
    repository.listDrafts({ tradingDay }),
    repository.lastRun(tradingDay),
    context.agentApiKeyPresented === true
      ? KEY_ACCOUNT
      : (dependencies.account ?? readAccount)(context, now),
    (dependencies.node ?? readNode)(context),
  ]);
  const notes =
    dependencies.marketNotes === undefined
      ? null
      : await dependencies.marketNotes([
          ...new Set(records.map((record) => record.symbol)),
        ]);
  return {
    account,
    generatedAt: run?.generatedAt ?? null,
    node: { ...node, checkedAt: now },
    notes,
    now,
    plan,
    records,
  };
};

// The stored quote time is ISO-8601 text (jsonb). A time that does not parse means "no quote".
const quoteOf = (stored: GoLiveDraftRecord["quote"]): GoLiveQuote | null => {
  if (stored === null) return null;
  const asOf = new Date(stored.asOf);
  return Number.isNaN(asOf.getTime()) ? null : { ...stored, asOf };
};

/**
 * Each record with its size, exact order, dry pre-check and the reasons it cannot be approved.
 * The web final gate runs dry: nothing is sent. Inputs this module does not read: held positions
 * ([]: the order is checked as a new position, never as a risk-reducing one) and the account
 * gates (kill switch, OPTIONS_ONLY: not evaluated here; the order screen checks them at send).
 */
const viewsOf = (
  loaded: Loaded,
  records: readonly GoLiveDraftRecord[]
): GoLiveDraftOutput[] => {
  const nlv = loaded.account.netLiquidation;
  const drafts = records.map((record) => ({
    ...record,
    quote: quoteOf(record.quote),
  }));
  return sizeDrafts(loaded.plan, drafts, nlv).map(({ draft, sizing }) => {
    const order = orderFor(draft, sizing);
    const gate =
      order === null
        ? null
        : evaluateFinalOrderGate({
            accountValue: nlv,
            jev: (dependencies.jevVerdict ?? readCachedJevVerdict)(
              order.symbol
            ),
            now: loaded.now,
            order: {
              engine: "golive-draft-queue",
              legs: order.legs.map((leg) => ({ ...leg, secType: "OPT" })),
              limitPrice: order.limitPrice,
              quantity: order.quantity,
              reason: "dry pre-check, nothing is sent",
              symbol: order.symbol,
            },
            positions: [],
          });
    return {
      ...draft,
      notApprovable: notApprovableReasons({
        draft,
        nlv,
        now: loaded.now,
        plan: loaded.plan,
        quantity: sizing.quantity,
        webFinalGate: gate?.decision ?? null,
      }),
      notes: [...(loaded.notes?.get(draft.symbol) ?? [])],
      order,
      preCheck: {
        enginePolicy: "not_evaluated_not_in_web_order_path",
        webFinalGate:
          gate === null ? null : { ...gate, reasons: [...gate.reasons] },
      },
      sizing,
    };
  });
};

// The decided record goes in first, so its view comes out first.
const decidedView = (
  loaded: Loaded,
  record: GoLiveDraftRecord
): GoLiveDraftOutput => {
  const [view] = viewsOf(loaded, [
    record,
    ...loaded.records.filter((other) => other.id !== record.id),
  ]) as [GoLiveDraftOutput, ...GoLiveDraftOutput[]];
  return view;
};

const SESSION_REQUIRED_MESSAGE =
  "A draft decision needs the owner's browser session";

const refuseApiKeys = api.middleware(async ({ context, next, errors }) => {
  if (context.agentApiKeyPresented === true)
    throw (errors as unknown as Failures).FORBIDDEN({
      message: SESSION_REQUIRED_MESSAGE,
    });
  return await next();
});

// Owner only: operator allow-list (requireOperator) AND the admin role. The same two-line rule
// as requireOwner in vertex-orders.ts, repeated here because this module must not import it.
const requireOwner = api.middleware(async ({ context, next, errors }) => {
  try {
    await context.requireRole("admin");
  } catch {
    throw (errors as unknown as Failures).FORBIDDEN({
      message: "Owner (admin) access required",
    });
  }
  return await next();
});

const queue = api.goLiveDrafts.queue
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const repository = repositoryFor(context, errors as unknown as Failures);
    const now = clock();
    const tradingDay = input.tradingDay ?? orderSessionDay(now);
    const loaded = await load(context, repository, tradingDay, now);
    const drafts = viewsOf(loaded, loaded.records);
    let marketNotes: GoLiveQueueOutput["marketNotes"] = "feature_not_deployed";
    if (loaded.notes !== null)
      marketNotes = drafts.some((draft) => draft.notes.length > 0)
        ? "attached"
        : "none_active";
    return {
      account: loaded.account,
      drafts,
      generatedAt: loaded.generatedAt,
      marketNotes,
      node: loaded.node,
      plan: loaded.plan,
      sendsOrders: false as const,
      tradingDay,
    };
  });

const collect = api.goLiveDrafts.collect
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const failures = errors as unknown as Failures;
    // Rig generator only: one push per run stores the candidates for the whole deployment.
    if (context.agentApiKeyPresented !== true)
      throw failures.FORBIDDEN({
        message: "goLiveDrafts.collect needs an agent API key",
      });
    const repository = repositoryFor(context, failures);
    // Only the session in which an order would be placed. A late run for a past day would
    // bring that day's expired drafts back in the store.
    const accepted = orderSessionDay(clock());
    if (input.tradingDay !== accepted)
      throw failures.VALIDATION_ERROR({
        message: `collect accepts only trading day ${accepted}, the session in which an order would be placed`,
      });
    const plan = await repository.planInForce();
    if (
      plan === null ||
      plan.id !== input.planId ||
      plan.version !== input.planVersion
    )
      throw failures.CONFLICT({ message: PLAN_MISMATCH_MESSAGE });
    // One foreign candidate refuses the whole batch: nothing is stored.
    for (const candidate of input.candidates) {
      const sleeve = plan.sleeves.find(
        (entry) => entry.key === candidate.sleeveKey
      );
      if (sleeve === undefined)
        throw failures.VALIDATION_ERROR({
          message: `Sleeve ${candidate.sleeveKey} is not in the plan in force`,
        });
      if (!sleeve.symbols.includes(candidate.symbol))
        throw failures.VALIDATION_ERROR({
          message: `${candidate.symbol} is not a symbol of sleeve ${sleeve.key}`,
        });
      if (sleeve.structure !== candidate.structure)
        throw failures.VALIDATION_ERROR({
          message: `Sleeve ${sleeve.key} trades ${sleeve.structure}, not ${candidate.structure}`,
        });
    }
    const { created, expired, unchanged } = await storeCall(failures, () =>
      repository.collect({
        candidates: input.candidates,
        generatedAt: input.generatedAt,
        planId: input.planId,
        planVersion: input.planVersion,
        tradingDay: input.tradingDay,
      })
    );
    return { created, expired, unchanged };
  });

// Records the decision and nothing else. The store has no lookup by id, so the draft must be in
// the queue of the order session day (orderSessionDay); a draft of another day is NOT_FOUND.
const approve = api.goLiveDrafts.approve
  .use(refuseApiKeys)
  .use(requireOperator)
  .use(requireOwner)
  .handler(async ({ context, input, errors }) => {
    const failures = errors as unknown as Failures;
    const repository = repositoryFor(context, failures);
    const now = clock();
    const tradingDay = orderSessionDay(now);
    const loaded = await load(context, repository, tradingDay, now);
    const draft = viewsOf(loaded, loaded.records).find(
      (entry) => entry.id === input.id
    );
    if (draft === undefined)
      throw failures.NOT_FOUND({
        message: `Draft is not in the queue of trading day ${tradingDay}`,
      });
    if (draft.notApprovable.length > 0)
      throw failures.CONFLICT({
        message: `Draft cannot be approved: ${draft.notApprovable.join(", ")}`,
      });
    // The owner must have seen the exact order: one cent or one contract of difference refuses.
    if (!sameCombo(input.order, draft.order))
      throw failures.CONFLICT({
        message:
          "The order is not the order the server sized; reload the queue",
      });
    const record = await storeCall(failures, () =>
      repository.decide({
        decidedBy: context.principal.userId,
        decision: "approved",
        id: input.id,
        nodeBadge: loaded.node.badge,
        note: input.note ?? null,
      })
    );
    return decidedView(loaded, record);
  });

const reject = api.goLiveDrafts.reject
  .use(refuseApiKeys)
  .use(requireOperator)
  .use(requireOwner)
  .handler(async ({ context, input, errors }) => {
    const failures = errors as unknown as Failures;
    const repository = repositoryFor(context, failures);
    const record = await storeCall(failures, () =>
      repository.decide({
        decidedBy: context.principal.userId,
        decision: "rejected",
        id: input.id,
        nodeBadge: null,
        note: input.note,
      })
    );
    return decidedView(
      await load(context, repository, record.tradingDay, clock()),
      record
    );
  });

export const goLiveDraftsRouter = { approve, collect, queue, reject };
