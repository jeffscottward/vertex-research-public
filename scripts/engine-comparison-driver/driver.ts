// Daily engine comparison driver (step 4 of the Nautilus switch plan; research only, no orders).
// Owner choice 2026-11-10 ("Daily driver + 1 research campaign"): a rig timer runs a fixed set of
// instant backtests and one parameter sweep once a day through the API with an operator WRITE key,
// so each run is repeated on Nautilus by the rig research worker, and it ticks one research
// Autopilot campaign so the gate is compared too. The report page is rebuilt after it
// (infra/engine-comparison-driver). The client calls only instantBacktest.run,
// backtestRuns.sweep, backtestRuns.comparisons.list and autopilot.campaigns.tick on Vertex; it
// never calls a broker, order or deployment procedure, and the key is never printed.

import { z } from "zod";

export type DriverIo = Readonly<{
  env: Readonly<Record<string, string | undefined>>;
  post: (url: string, init: RequestInit) => Promise<Response>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  stdout: Readonly<{ write: (text: string) => unknown }>;
  stderr: Readonly<{ write: (text: string) => unknown }>;
}>;

type Rule =
  | Readonly<{ kind: "smaCross"; fast: number; slow: number }>
  | Readonly<{
      kind: "breakout";
      entryLookback: number;
      exitLookback: number;
      trendSma: number;
    }>;

export type InstantRequest = Readonly<{
  symbol: string;
  timeframe: "1d" | "1m";
  rule: Rule;
  stopLossPct: number;
  takeProfitPct: number;
  costBps: number;
}>;

/**
 * The fixed daily set: a moving-average cross on the Core 7 ETF twins and futures with stored
 * daily bars, plus one breakout. A series without stored bars is reported and skipped.
 */
export const DRIVER_INSTANT_SET: readonly InstantRequest[] = Object.freeze(
  ["SPY", "QQQ", "IWM", "GLD", "ES=F", "NQ=F", "GC=F", "CL=F"]
    .map(
      (symbol): InstantRequest => ({
        costBps: 1,
        rule: { fast: 20, kind: "smaCross", slow: 100 },
        stopLossPct: 0,
        symbol,
        takeProfitPct: 0,
        timeframe: "1d",
      })
    )
    .concat([
      {
        costBps: 1,
        rule: {
          entryLookback: 55,
          exitLookback: 20,
          kind: "breakout",
          trendSma: 200,
        },
        stopLossPct: 5,
        symbol: "SPY",
        takeProfitPct: 0,
        timeframe: "1d",
      },
    ])
);

/** The daily sweep: the 20-cell SPY grid of the first live sweep (2026-11-06), ending yesterday. */
export const driverSweepRequest = (nowMs: number) => ({
  costBps: 1,
  dimensions: [
    { from: 5, param: "fast", step: 5, to: 25 },
    { from: 40, param: "slow", step: 20, to: 100 },
  ],
  from: "2015-01-02",
  metric: "totalReturn",
  rule: { fast: 10, kind: "smaCross", slow: 60 },
  stopLossPct: 0,
  symbol: "SPY",
  takeProfitPct: 0,
  timeframe: "1d",
  to: new Date(nowMs - DAY_MS).toISOString().slice(0, 10),
});

const DAY_MS = 86_400_000;
/** The API reuses an identical group queued in the last 24 hours; wait past that once. */
export const REUSE_WINDOW_MS = DAY_MS;
export const REUSE_MARGIN_MS = 30_000;
const REUSE_WAIT_MAX_MS = 20 * 60_000;
/** A newer instant request of the same user supersedes still-queued runs: wait until claimed. */
export const CLAIM_POLL_MS = 15_000;
export const CLAIM_WAIT_MAX_MS = 15 * 60_000;
/** Budget of the whole instant phase (claim and reuse waits included); the unit allows 2 h. */
export const INSTANT_PHASE_MAX_MS = 45 * 60_000;
/** Per request; a hung connection fails the request instead of the unit timeout. */
const REQUEST_TIMEOUT_MS = 120_000;
export const DEFAULT_CAMPAIGN_TICKS = 3;
const MAX_CAMPAIGN_TICKS = 20;
/** Exit code for a configuration error: the wrapper then skips the report. */
export const CONFIG_ERROR_EXIT = 2;
const NO_STORED_BARS = "No stored bars for this series";

// Only the fields the driver reads; the API answers carry more.
const TimingSchema = z.object({
  dropped: z.number().optional(),
  error: z.string().optional(),
  groupId: z.string().nullable(),
  queued: z.number().optional(),
  reused: z.boolean().optional(),
});
const ComparedSchema = z.object({ comparison: TimingSchema.optional() });
const GroupRunsSchema = z.object({
  runs: z.array(
    z.object({
      createdAt: z.string(),
      error: z.string().nullable().optional(),
      status: z.string(),
    })
  ),
});
const TickSchema = z.object({
  results: z.array(
    z.object({
      comparison: z
        .object({
          dropped: z.number(),
          error: z.string().optional(),
          queued: z.number(),
        })
        .optional(),
      gated: z.number(),
      generation: z.number(),
      status: z.string(),
    })
  ),
});
const EnvelopeSchema = z.object({ json: z.unknown() });

class DriverApiError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, message: string, body: string) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

const required = (
  env: DriverIo["env"],
  name: "VERTEX_ORIGIN" | "VERTEX_AGENT_API_KEY"
): string => {
  const value = env[name]?.trim();
  if (value === undefined || value === "")
    throw new Error(`${name} is required`);
  return value;
};

/** Number of campaign ticks per run from VERTEX_DRIVER_CAMPAIGN_TICKS (default 3, 0..20). */
export const campaignTicks = (raw: string | undefined): number => {
  if (raw === undefined || raw.trim() === "") return DEFAULT_CAMPAIGN_TICKS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > MAX_CAMPAIGN_TICKS)
    throw new Error(
      `VERTEX_DRIVER_CAMPAIGN_TICKS must be an integer from 0 to ${MAX_CAMPAIGN_TICKS}`
    );
  return value;
};

/** The portal origin; https only, because the write key travels in a header. */
export const driverOrigin = (raw: string): string => {
  const url = new URL(raw);
  if (url.protocol !== "https:")
    throw new Error("VERTEX_ORIGIN must be an https:// origin");
  return url.origin;
};

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Writes each line as it happens (a killed unit still leaves its journal); FAIL lines exit 1. */
class RunLog {
  failures = 0;
  readonly #io: DriverIo;

  constructor(io: DriverIo) {
    this.#io = io;
  }

  ok(line: string): void {
    this.#io.stdout.write(`${line}\n`);
  }

  fail(line: string): void {
    this.failures += 1;
    this.#io.stdout.write(`FAIL ${line}\n`);
  }
}

type Client = ReturnType<typeof createClient>;
type ClaimOutcome = "claimed" | "superseded" | "timeout";

const createClient = (io: DriverIo, origin: string, apiKey: string) => {
  const call = async (path: string, json: unknown): Promise<unknown> => {
    const response = await io.post(`${origin}/api/orpc/${path}`, {
      body: JSON.stringify({ json }),
      headers: {
        "content-type": "application/json",
        origin,
        "x-api-key": apiKey,
      },
      method: "POST",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await response.text();
    if (!response.ok)
      throw new DriverApiError(
        response.status,
        `${path} returned HTTP ${response.status}: ${text.slice(0, 300)}`,
        text
      );
    return EnvelopeSchema.parse(JSON.parse(text)).json;
  };

  const groupRuns = async (groupId: string) =>
    GroupRunsSchema.parse(
      await call("backtestRuns/comparisons/list", { groupId, limit: 100 })
    ).runs;

  return {
    call,
    /** Milliseconds until the group's newest run leaves the 24-hour reuse window. */
    reuseWait: async (groupId: string): Promise<number> => {
      const runs = await groupRuns(groupId);
      const newest = Math.max(...runs.map((run) => Date.parse(run.createdAt)));
      return Math.max(0, newest + REUSE_WINDOW_MS + REUSE_MARGIN_MS - io.now());
    },
    /**
     * Waits until no run of the group is queued. A run another request of the same user
     * superseded meanwhile ends "failed" with "Superseded by a newer request".
     */
    waitClaimed: async (
      groupId: string,
      deadline: number
    ): Promise<ClaimOutcome> => {
      const end = Math.min(deadline, io.now() + CLAIM_WAIT_MAX_MS);
      for (;;) {
        const runs = await groupRuns(groupId);
        if (!runs.some((run) => run.status === "queued"))
          return runs.some(
            (run) =>
              run.status === "failed" &&
              (run.error ?? "").startsWith("Superseded")
          )
            ? "superseded"
            : "claimed";
        if (io.now() + CLAIM_POLL_MS > end) return "timeout";
        await io.sleep(CLAIM_POLL_MS);
      }
    },
  };
};

/** Asks for one instant run, waiting out the reuse window once when it is close. */
const requestInstant = async (
  io: DriverIo,
  client: Client,
  request: InstantRequest,
  deadline: number
) => {
  const first = ComparedSchema.parse(
    await client.call("instantBacktest/run", request)
  ).comparison;
  if (first?.reused !== true || first.groupId === null) return first;
  const wait = await client.reuseWait(first.groupId);
  if (wait > REUSE_WAIT_MAX_MS || io.now() + wait > deadline) return first;
  await io.sleep(wait);
  return ComparedSchema.parse(await client.call("instantBacktest/run", request))
    .comparison;
};

const instantName = (request: InstantRequest): string => {
  const { rule } = request;
  return `instant ${request.symbol} ${request.timeframe} ${
    rule.kind === "smaCross"
      ? `smaCross ${rule.fast}/${rule.slow}`
      : `breakout ${rule.entryLookback}/${rule.exitLookback}/${rule.trendSma}`
  }`;
};

type InstantStep = "next" | "stop";

/** One instant request: logs its outcome and says whether the phase goes on. */
const runInstant = async (
  io: DriverIo,
  client: Client,
  log: RunLog,
  request: InstantRequest,
  deadline: number
): Promise<{ step: InstantStep; queued: boolean }> => {
  const name = instantName(request);
  const next = { queued: false, step: "next" } as const;
  try {
    const timing = await requestInstant(io, client, request, deadline);
    if (timing === undefined) {
      log.fail(
        `${name}: no comparison (engine comparison off or read-only key)`
      );
      return next;
    }
    if (timing.error !== undefined || timing.groupId === null) {
      log.fail(`${name}: ${timing.error ?? "no comparison group"}`);
      return next;
    }
    if (timing.reused === true) {
      log.ok(`reused ${name}: ${timing.groupId} (queued <24 h ago)`);
      return next;
    }
    log.ok(`queued ${name}: ${timing.groupId}`);
    const outcome = await client.waitClaimed(timing.groupId, deadline);
    if (outcome === "superseded")
      log.fail(
        `${name}: superseded by a newer instant request of the same user`
      );
    if (outcome === "timeout") {
      log.fail(
        `${name}: still queued at the wait limit (research worker down or slow?); stopping instant runs`
      );
      return { queued: true, step: "stop" };
    }
    return { queued: true, step: "next" };
  } catch (error) {
    if (
      error instanceof DriverApiError &&
      error.status === 404 &&
      error.body.includes(NO_STORED_BARS)
    ) {
      log.ok(`skipped ${name}: no stored bars`);
      return next;
    }
    if (error instanceof DriverApiError && error.status === 403) {
      log.fail(
        `${name}: ${error.message}; the key may not call instantBacktest.run, stopping instant runs`
      );
      return { queued: false, step: "stop" };
    }
    log.fail(`${name}: ${messageOf(error)}`);
    return next;
  }
};

/** Instant backtests, one at a time so none supersedes the previous one's queued run. */
const runInstants = async (
  io: DriverIo,
  client: Client,
  log: RunLog
): Promise<number> => {
  const deadline = io.now() + INSTANT_PHASE_MAX_MS;
  let queued = 0;
  for (const [index, request] of DRIVER_INSTANT_SET.entries()) {
    const result =
      io.now() >= deadline
        ? undefined
        : await runInstant(io, client, log, request, deadline);
    if (result === undefined)
      log.fail(
        `${instantName(request)}: not requested (instant phase over ${INSTANT_PHASE_MAX_MS / 60_000} min)`
      );
    if (result?.queued === true) queued += 1;
    if (result?.step === "stop") {
      for (const skipped of DRIVER_INSTANT_SET.slice(index + 1))
        log.ok(`not requested ${instantName(skipped)}`);
      break;
    }
  }
  return queued;
};

/** One parameter sweep (its own group; its cells are queued together). */
const runSweep = async (
  io: DriverIo,
  client: Client,
  log: RunLog
): Promise<void> => {
  try {
    const timing = ComparedSchema.parse(
      await client.call("backtestRuns/sweep", driverSweepRequest(io.now()))
    ).comparison;
    if (
      timing === undefined ||
      timing.error !== undefined ||
      timing.groupId === null
    )
      log.fail(
        `sweep: ${timing?.error ?? (timing === undefined ? "no comparison (engine comparison off or read-only key)" : "no comparison group")}`
      );
    else
      log.ok(
        `${timing.reused === true ? "reused" : "queued"} sweep: ${timing.groupId} (${timing.queued ?? 0} cells, ${timing.dropped ?? 0} left out)`
      );
  } catch (error) {
    log.fail(`sweep: ${messageOf(error)}`);
  }
};

/** The research Autopilot campaign: a few tick slices, each gating candidates. */
const runCampaign = async (
  client: Client,
  log: RunLog,
  campaignId: string,
  ticks: number
): Promise<void> => {
  if (campaignId === "") {
    log.ok("campaign: none configured");
    return;
  }
  for (let tick = 1; tick <= ticks; tick += 1) {
    try {
      const [result] = TickSchema.parse(
        await client.call("autopilot/campaigns/tick", { id: campaignId })
      ).results;
      if (result === undefined) {
        log.fail(`campaign ${campaignId}: nothing ticked`);
        return;
      }
      const comparison = result.comparison;
      if (comparison?.error === undefined)
        log.ok(
          `campaign tick ${tick}: ${result.status}, generation ${result.generation}, gated ${result.gated}, gate runs queued ${comparison?.queued ?? 0}`
        );
      else log.fail(`campaign tick ${tick}: ${comparison.error}`);
      if (result.status !== "running") return;
    } catch (error) {
      log.fail(
        error instanceof DriverApiError && error.status === 409
          ? `campaign ${campaignId}: not running (stopped, completed or failed)`
          : `campaign tick ${tick}: ${messageOf(error)}`
      );
      return;
    }
  }
};

export const runEngineComparisonDriver = async (
  io: DriverIo
): Promise<number> => {
  let client: Client;
  let ticks: number;
  try {
    client = createClient(
      io,
      driverOrigin(required(io.env, "VERTEX_ORIGIN")),
      required(io.env, "VERTEX_AGENT_API_KEY")
    );
    ticks = campaignTicks(io.env["VERTEX_DRIVER_CAMPAIGN_TICKS"]);
  } catch (error) {
    io.stderr.write(`engine comparison driver: ${messageOf(error)}\n`);
    return CONFIG_ERROR_EXIT;
  }
  const log = new RunLog(io);
  const queued = await runInstants(io, client, log);
  await runSweep(io, client, log);
  await runCampaign(
    client,
    log,
    io.env["VERTEX_DRIVER_CAMPAIGN_ID"]?.trim() ?? "",
    ticks
  );
  log.ok(`summary: ${queued} instant groups queued, ${log.failures} failures`);
  return log.failures === 0 ? 0 : 1;
};
