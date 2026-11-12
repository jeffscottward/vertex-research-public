import type {
  GoLiveDraftRecord,
  GoLiveDraftsRepository,
  GoLivePlanRecord,
} from "@darkfactory/db/server";
import { call, implement } from "@orpc/server";

import { appContract } from "../contract.ts";
import {
  GOLIVE_DRAFT_LIST_MAX,
  type GoLiveDraftOutput,
  GoLiveDraftSchema,
  GoLivePlanSchema,
  type GoLiveQueueOutput,
  type GoLiveQuote,
  goLiveStrikesFitStructure,
} from "../contracts/golive-drafts.ts";
import type { JevVerdictOutput } from "../contracts/jev-verdict.ts";
import type { ApiContext } from "./context.ts";
import { evaluateFinalOrderGate } from "./final-order-gate.ts";
import {
  approvedOrderFitsDraft,
  GOLIVE_QUOTE_MAX_FUTURE_SKEW_MS,
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
// collect: the rig generator's write key. A quote labelled ibkr_live is refused while no live
// IBKR option quote source exists (dependencies.liveQuoteSource, false by default), and so is a
// quote dated more than 60 s after the server clock. A later run of the day refreshes the stored
// drafts that have no decision; a trading day holds at most GOLIVE_DRAFT_LIST_MAX drafts.
// approve and reject: the owner (operator and admin role) in a browser session; API keys refused.
// queue.canDecide tells the caller whether it is that owner, by the same check (decisionRefusal).
// Quantity, limit, max loss and the pre-check are computed at read time and never stored. The
// one stored order is approvedOrder: the order this server sized, written with the approval.

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
  // true: a live IBKR option quote source exists, so collect accepts a quote labelled ibkr_live.
  // None exists in this version, so the default refuses the label. Not an environment setting.
  liveQuoteSource?: boolean;
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
  BAD_REQUEST: Fail;
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
  Readonly<{
    code: "CONFLICT" | "NOT_FOUND" | "VALIDATION_ERROR";
    message: string;
  }>
> = new Map([
  [
    "GoLiveDraftChangedError",
    {
      code: "CONFLICT",
      message:
        "The draft changed after the queue was read (a later generator run); reload the queue",
    },
  ],
  [
    "GoLiveDraftConflictError",
    { code: "CONFLICT", message: "The draft is no longer proposed" },
  ],
  [
    "GoLiveDraftLimitError",
    {
      code: "VALIDATION_ERROR",
      message: `The batch would take the trading day above ${GOLIVE_DRAFT_LIST_MAX} drafts; nothing was stored`,
    },
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
  // true: an API key asked. It gets no account value and no order that was sized from one.
  forKey: boolean;
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
  const forKey = context.agentApiKeyPresented === true;
  const [plan, records, run, account, node] = await Promise.all([
    repository.planInForce(),
    repository.listDrafts({ tradingDay }),
    repository.lastRun(tradingDay),
    forKey ? KEY_ACCOUNT : (dependencies.account ?? readAccount)(context, now),
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
    forKey,
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
 * What is wrong with the stored plan, or null. The output schema accepts only an https evidence
 * link and a Discord message link as the owner link. A stored plan that fails it is refused here
 * by name, so it is never sent to the page as a link and never fails the answer as an
 * unexplained 500. The message names the fields and never repeats a stored value.
 */
const planProblem = (plan: GoLivePlanRecord | null): string | null => {
  if (plan === null) return null;
  const parsed = GoLivePlanSchema.safeParse(plan);
  if (parsed.success) return null;
  const fields = [
    ...new Set(parsed.error.issues.map((issue) => issue.path.join("."))),
  ];
  return `The stored plan ${plan.id} version ${plan.version} is not valid (${fields.join(", ")}). Write the plan again with scripts/golive/seed-plan.ts`;
};

const StoredOrderSchema = GoLiveDraftSchema.shape.approvedOrder.unwrap();

/**
 * The first approved draft whose stored order is missing, is not an order, or is not the order of
 * that draft (approvedOrderFitsDraft), or null. The room an approved draft holds is computed
 * from its stored order, so the sizing refuses such a draft; it is named here first. Call it
 * after strikesProblem: the order of a draft with wrong strikes cannot be compared.
 */
const approvedOrderProblem = (
  records: readonly GoLiveDraftRecord[]
): string | null => {
  const broken = records.find(
    (record) =>
      record.state === "approved" &&
      !(
        StoredOrderSchema.safeParse(record.approvedOrder).success &&
        approvedOrderFitsDraft(record, record.approvedOrder)
      )
  );
  return broken === undefined
    ? null
    : `Draft ${broken.id} is approved and its stored approved order is missing or is not the order of that draft`;
};

/**
 * The first draft whose strikes are the wrong way round for its structure, or null. collect
 * refuses such a candidate, so this can only be a row stored before that rule or changed by
 * hand. The sizing refuses it (it throws: no sizing reason says this), so it is named here first.
 */
const strikesProblem = (
  records: readonly GoLiveDraftRecord[]
): string | null => {
  const broken = records.find(
    (record) =>
      !goLiveStrikesFitStructure(
        record.structure,
        record.longStrike,
        record.shortStrike
      )
  );
  return broken === undefined
    ? null
    : `Draft ${broken.id} has strikes that are the wrong way round for ${broken.structure} and cannot be sized`;
};

// The stored drafts that the sizing would refuse, by name: wrong strikes first.
const draftsProblem = (records: readonly GoLiveDraftRecord[]): string | null =>
  strikesProblem(records) ?? approvedOrderProblem(records);

// What the store holds is checked before it is sized and returned: a problem is named, so it
// never fails the answer as an unexplained 500 and never reaches the page.
const storedProblem = (loaded: Loaded): string | null =>
  planProblem(loaded.plan) ??
  draftsProblem(loaded.records) ??
  // collect keeps a day at or below the limit, so more can only follow a manual change. The
  // answer never lists a part of a day.
  (loaded.records.length > GOLIVE_DRAFT_LIST_MAX
    ? `The trading day holds ${loaded.records.length} stored drafts, more than the ${GOLIVE_DRAFT_LIST_MAX} the queue lists`
    : null);

/**
 * Each record with its size, exact order, dry pre-check and the reasons it cannot be approved.
 * approvedOrder is the stored order of an approved draft and null for every other state; sizing
 * and order are computed now, also for an approved draft, so they can differ from it. An API key
 * gets no approvedOrder: its quantity was sized from the account value, which a key never gets.
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
      approvedOrder:
        draft.state === "approved" && !loaded.forKey
          ? draft.approvedOrder
          : null,
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
const OWNER_REQUIRED_MESSAGE = "Owner (admin) access required";

type DecisionCaller = Pick<
  ApiContext,
  "agentApiKeyPresented" | "callerCanWrite" | "requireRole"
>;

// An API key never decides, whoever owns it.
const keyRefusal = (context: DecisionCaller): string | null =>
  context.agentApiKeyPresented === true ? SESSION_REQUIRED_MESSAGE : null;

/**
 * Why this caller may not decide a draft, or null when it may. The one rule behind approve,
 * reject and queue.canDecide: a browser session (no API key) of a caller on the operator list
 * who has the admin role. callerCanWrite is set by requireOperator and is false for an agent
 * viewer, who is admitted to the queue without being on the list. The same owner rule as
 * requireOwner in vertex-orders.ts, repeated here because this module must not import it.
 */
const decisionRefusal = async (
  context: DecisionCaller
): Promise<string | null> => {
  const key = keyRefusal(context);
  if (key !== null) return key;
  if (context.callerCanWrite !== true) return OWNER_REQUIRED_MESSAGE;
  try {
    await context.requireRole("admin");
  } catch {
    return OWNER_REQUIRED_MESSAGE;
  }
  return null;
};

// Before requireOperator, so a key is refused without being looked up.
const refuseApiKeys = api.middleware(async ({ context, next, errors }) => {
  const message = keyRefusal(context);
  if (message !== null)
    throw (errors as unknown as Failures).FORBIDDEN({ message });
  return await next();
});

// After requireOperator, which sets callerCanWrite.
const requireOwner = api.middleware(async ({ context, next, errors }) => {
  const message = await decisionRefusal(context);
  if (message !== null)
    throw (errors as unknown as Failures).FORBIDDEN({ message });
  return await next();
});

const queue = api.goLiveDrafts.queue
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const failures = errors as unknown as Failures;
    const repository = repositoryFor(context, failures);
    const now = clock();
    const tradingDay = input.tradingDay ?? orderSessionDay(now);
    const [loaded, refusal] = await Promise.all([
      load(context, repository, tradingDay, now),
      decisionRefusal(context),
    ]);
    const problem = storedProblem(loaded);
    if (problem !== null) throw failures.STORAGE_ERROR({ message: problem });
    const drafts = viewsOf(loaded, loaded.records);
    let marketNotes: GoLiveQueueOutput["marketNotes"] = "feature_not_deployed";
    if (loaded.notes !== null)
      marketNotes = drafts.some((draft) => draft.notes.length > 0)
        ? "attached"
        : "none_active";
    return {
      account: loaded.account,
      canDecide: refusal === null,
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
    // No live IBKR option quote source exists in this version, and the approval rule trusts the
    // label ibkr_live. A batch that carries the label is refused whole, before anything is read
    // or stored.
    if (
      dependencies.liveQuoteSource !== true &&
      input.candidates.some(
        (candidate) => candidate.quote?.source === "ibkr_live"
      )
    )
      throw failures.BAD_REQUEST({
        message:
          "A quote labelled ibkr_live is not accepted: no live IBKR option quote source exists in this version",
      });
    const repository = repositoryFor(context, failures);
    // Only the session in which an order would be placed. A late run for a past day would
    // bring that day's expired drafts back in the store.
    const now = clock();
    const accepted = orderSessionDay(now);
    if (input.tradingDay !== accepted)
      throw failures.VALIDATION_ERROR({
        message: `collect accepts only trading day ${accepted}, the session in which an order would be placed`,
      });
    // A quote dated ahead of the server clock would count as live later, without being read
    // again. The same 60 s that the approval rule allows.
    const latest = now.getTime() + GOLIVE_QUOTE_MAX_FUTURE_SKEW_MS;
    const ahead = input.candidates.find(
      (candidate) =>
        candidate.quote !== null && candidate.quote.asOf.getTime() > latest
    );
    if (ahead !== undefined)
      throw failures.VALIDATION_ERROR({
        message: `The quote of ${ahead.symbol} is dated more than ${GOLIVE_QUOTE_MAX_FUTURE_SKEW_MS / 1000} s after the server clock`,
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
    const { created, expired, unchanged, updated } = await storeCall(
      failures,
      () =>
        repository.collect({
          candidates: input.candidates,
          generatedAt: input.generatedAt,
          maxDrafts: GOLIVE_DRAFT_LIST_MAX,
          planId: input.planId,
          planVersion: input.planVersion,
          tradingDay: input.tradingDay,
        })
    );
    return { created, expired, unchanged, updated };
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
    // Nothing is approved while a stored record of the day cannot be shown.
    const problem = storedProblem(loaded);
    if (problem !== null) throw failures.STORAGE_ERROR({ message: problem });
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
    const sized = draft.order;
    if (sized === null || !sameCombo(input.order, sized))
      throw failures.CONFLICT({
        message:
          "The order is not the order the server sized; reload the queue",
      });
    const record = await storeCall(failures, () =>
      repository.decide({
        // The order this server sized just now. The request body is only compared with it.
        approvedOrder: sized,
        decidedBy: context.principal.userId,
        decision: "approved",
        // The draft as this request read it: a collect that changed it since refuses the write.
        expectedUpdatedAt: draft.updatedAt,
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
    const loaded = await load(context, repository, record.tradingDay, clock());
    // The rejection is stored. Its answer sizes the whole day, which a draft with wrong strikes
    // or an approved draft without its order would fail without a name.
    const problem = draftsProblem(loaded.records);
    if (problem !== null)
      throw failures.STORAGE_ERROR({
        message: `The rejection of draft ${record.id} was stored. ${problem}`,
      });
    return decidedView(loaded, record);
  });

export const goLiveDraftsRouter = { approve, collect, queue, reject };
