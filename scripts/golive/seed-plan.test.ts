import type { GoLivePlanRecord } from "@darkfactory/db/server";
import { describe, expect, it, vi } from "vitest";

import { GoLivePlanSeedSchema } from "../../packages/api/src/contracts/golive-drafts.ts";
import { FUNDED_LOWER_BAR_PIE } from "./plans/funded-lower-bar-pie.ts";
import {
  buildSeedPlan,
  type CliIo,
  GOLIVE_PLAN_DOCUMENTS,
  GOLIVE_SEED_PLAN_ACTOR,
  GOLIVE_SEED_PLAN_USAGE,
  type GoLivePlanStore,
  type OpenGoLivePlanStore,
  openGoLivePlanStore,
  parseSeedPlanArguments,
  runGoLiveSeedPlan,
} from "./seed-plan.ts";

const OWNER_LINK = "https://discord.com/channels/111/222/333";
const EVIDENCE_LINK = "https://example.com/evidence/1";
const PLAN = ["--plan", "funded-lower-bar-pie"] as const;
const APPROVED = [
  ...PLAN,
  "--status",
  "approved",
  "--basis",
  "owner_decision",
  "--owner-link",
  OWNER_LINK,
  "--approved-by",
  "Owner",
] as const;

type CliRun = Readonly<{ err: string[]; io: CliIo; out: string[] }>;

const cli = (
  env: NodeJS.ProcessEnv = { DATABASE_URL: "postgres://golive.test/db" }
): CliRun => {
  const out: string[] = [];
  const err: string[] = [];
  return {
    err,
    io: {
      env,
      stderr: { write: (text: string) => err.push(text) > 0 },
      stdout: { write: (text: string) => out.push(text) > 0 },
    },
    out,
  };
};

const storeDouble = (
  writePlan: GoLivePlanStore["writePlan"] = async (seed) =>
    ({ id: seed.id, status: seed.status, version: 7 }) as GoLivePlanRecord,
  close: GoLivePlanStore["close"] = async () => undefined
) => {
  const store = { close: vi.fn(close), writePlan: vi.fn(writePlan) };
  const open = vi.fn<OpenGoLivePlanStore>(() => store);
  return { open, store };
};

describe("funded-lower-bar-pie plan document", () => {
  it("is a valid proposal without approval fields", () => {
    expect(GoLivePlanSeedSchema.parse(FUNDED_LOWER_BAR_PIE)).toEqual(
      FUNDED_LOWER_BAR_PIE
    );
    expect(FUNDED_LOWER_BAR_PIE).toMatchObject({
      approvalBasis: null,
      approvedBy: null,
      evidenceUrl: null,
      id: "funded-lower-bar-pie",
      name: "Funded lower-bar pie",
      ownerMessageUrl: null,
      status: "proposed",
    });
    expect(GOLIVE_PLAN_DOCUMENTS).toEqual({
      "funded-lower-bar-pie": FUNDED_LOWER_BAR_PIE,
    });
  });

  // research/backtests/allocation/funded_pie.py: POSITION_RISK_PCT, OPEN_RISK_CAP_PCT,
  // NAME_RISK_CAP_PCT and POOL. maxPositions is the open risk cap over the position risk.
  it("carries the limits and sleeve budgets of funded_pie.py", () => {
    expect(FUNDED_LOWER_BAR_PIE.limits).toEqual({
      maxPositions: 4,
      nameRiskCapPct: 2,
      openRiskCapPct: 4,
      positionRiskPct: 1,
    });
    expect(
      FUNDED_LOWER_BAR_PIE.sleeves.map((sleeve) => [
        sleeve.key,
        sleeve.name,
        sleeve.runKey,
        sleeve.definitionVariant,
        sleeve.budgetPct,
      ])
    ).toEqual([
      [
        "long-index",
        "Long index",
        "oil-predicts-equity/B",
        "always_on_entry",
        2,
      ],
      ["rotation", "Momentum rotation", "momentum-rotation/A", "top_1", 1],
      ["vol-premium", "Put credit, gated", "regime-put-vrp/A", "as_studied", 1],
    ]);
    const budget = FUNDED_LOWER_BAR_PIE.sleeves.reduce(
      (sum, sleeve) => sum + sleeve.budgetPct,
      0
    );
    expect(budget).toBe(FUNDED_LOWER_BAR_PIE.limits.openRiskCapPct);
  });

  // services/research/strategies/qc_ports/ideas.py: MONTHLY_CALL, PUT_CREDIT, CORE7.
  it("carries the option blocks and symbols of ideas.py", () => {
    expect(
      FUNDED_LOWER_BAR_PIE.sleeves.map((sleeve) => ({
        anchorDelta: sleeve.anchorDelta,
        dteMin: sleeve.dteMin,
        dteTarget: sleeve.dteTarget,
        structure: sleeve.structure,
        symbols: sleeve.symbols,
        widthSigma: sleeve.widthSigma,
      }))
    ).toEqual([
      {
        anchorDelta: 0.5,
        dteMin: 45,
        dteTarget: 60,
        structure: "callDebitVertical",
        symbols: ["SPY", "QQQ"],
        widthSigma: 1,
      },
      {
        anchorDelta: 0.5,
        dteMin: 45,
        dteTarget: 60,
        structure: "callDebitVertical",
        symbols: ["SPY", "QQQ", "DIA", "IWM", "GLD", "SLV", "USO"],
        widthSigma: 1,
      },
      {
        anchorDelta: 0.25,
        dteMin: 30,
        dteTarget: 45,
        structure: "putCreditVertical",
        symbols: ["SPY"],
        widthSigma: 0.5,
      },
    ]);
  });
});

describe("parseSeedPlanArguments", () => {
  it("reads every flag and --write in any position", () => {
    expect(
      parseSeedPlanArguments([
        "--write",
        ...APPROVED,
        "--evidence-link",
        EVIDENCE_LINK,
      ])
    ).toEqual({
      values: {
        "--approved-by": "Owner",
        "--basis": "owner_decision",
        "--evidence-link": EVIDENCE_LINK,
        "--owner-link": OWNER_LINK,
        "--plan": "funded-lower-bar-pie",
        "--status": "approved",
      },
      write: true,
    });
    expect(parseSeedPlanArguments([])).toEqual({ values: {}, write: false });
  });

  it.each([
    [["--plan", "a", "--force"], "Unknown argument --force."],
    [["funded-lower-bar-pie"], "Unknown argument funded-lower-bar-pie."],
    [["--plan", "a", "--plan", "b"], "--plan is given twice"],
    [["--plan"], "--plan needs a value"],
    [["--plan", ""], "--plan needs a value"],
    [["--status", "--write"], "--status needs a value"],
  ])("refuses %j", (argv, message) => {
    expect(() => parseSeedPlanArguments(argv)).toThrow(message);
  });
});

describe("buildSeedPlan", () => {
  it("returns the plan document unchanged when only the plan is named", () => {
    expect(buildSeedPlan({ "--plan": "funded-lower-bar-pie" })).toEqual(
      FUNDED_LOWER_BAR_PIE
    );
  });

  it("merges an owner decision into the document", () => {
    expect(buildSeedPlan(parseSeedPlanArguments(APPROVED).values)).toEqual({
      ...FUNDED_LOWER_BAR_PIE,
      approvalBasis: "owner_decision",
      approvedBy: "Owner",
      ownerMessageUrl: OWNER_LINK,
      status: "approved",
    });
  });

  it("merges a delegation with its evidence link", () => {
    expect(
      buildSeedPlan({
        ...parseSeedPlanArguments(APPROVED).values,
        "--basis": "owner_delegation",
        "--evidence-link": EVIDENCE_LINK,
      })
    ).toMatchObject({
      approvalBasis: "owner_delegation",
      evidenceUrl: EVIDENCE_LINK,
      status: "approved",
    });
  });

  it.each([
    [{}, "--plan is required."],
    [
      { "--plan": "other-plan" },
      "Unknown plan other-plan. Known plans: funded-lower-bar-pie",
    ],
    // A name every object has is not a plan.
    [{ "--plan": "constructor" }, "Unknown plan constructor."],
    [
      { "--plan": "funded-lower-bar-pie", "--status": "approved" },
      "approvalBasis is set exactly when the plan is approved",
    ],
    [
      {
        "--basis": "owner_decision",
        "--plan": "funded-lower-bar-pie",
        "--status": "approved",
      },
      "An approved plan needs the owner message link and approvedBy",
    ],
    [
      {
        "--approved-by": "Owner",
        "--basis": "owner_delegation",
        "--owner-link": OWNER_LINK,
        "--plan": "funded-lower-bar-pie",
        "--status": "approved",
      },
      "A plan approved by delegation needs the evidence link",
    ],
    [
      { "--basis": "owner_decision", "--plan": "funded-lower-bar-pie" },
      "approvalBasis is set exactly when the plan is approved",
    ],
    [
      {
        "--approved-by": "Owner",
        "--basis": "owner_decision",
        // A channel link, not a message link.
        "--owner-link": "https://discord.com/channels/111/222",
        "--plan": "funded-lower-bar-pie",
        "--status": "approved",
      },
      "Owner link must be a Discord message link",
    ],
    [
      {
        "--evidence-link": "http://example.com/evidence",
        "--plan": "funded-lower-bar-pie",
      },
      "The plan is not valid",
    ],
    [
      { "--plan": "funded-lower-bar-pie", "--status": "retired" },
      "The plan is not valid",
    ],
    [
      {
        "--approved-by": "Owner",
        "--basis": "owner_word",
        "--owner-link": OWNER_LINK,
        "--plan": "funded-lower-bar-pie",
        "--status": "approved",
      },
      "--basis is one of owner_decision, owner_delegation",
    ],
  ])("refuses %j", (values, message) => {
    expect(() => buildSeedPlan(values)).toThrow(message);
  });
});

describe("runGoLiveSeedPlan", () => {
  it("prints the usage for --help", async () => {
    const run = cli();
    const { open } = storeDouble();
    await expect(
      runGoLiveSeedPlan(["--help", "--write"], run.io, open)
    ).resolves.toBe(0);
    expect(run.out).toEqual([`${GOLIVE_SEED_PLAN_USAGE}\n`]);
    expect(open).not.toHaveBeenCalled();
  });

  it("prints the plan and writes nothing without --write", async () => {
    const run = cli({});
    const { open } = storeDouble();
    await expect(runGoLiveSeedPlan(APPROVED, run.io, open)).resolves.toBe(0);
    expect(open).not.toHaveBeenCalled();
    expect(run.err).toEqual([]);
    expect(JSON.parse(run.out.join(""))).toEqual({
      plan: {
        ...FUNDED_LOWER_BAR_PIE,
        approvalBasis: "owner_decision",
        approvedBy: "Owner",
        ownerMessageUrl: OWNER_LINK,
        status: "approved",
      },
      written: false,
    });
  });

  it("writes the plan with --write and prints only id, version and status", async () => {
    const run = cli();
    const { open, store } = storeDouble();
    await expect(
      runGoLiveSeedPlan([...APPROVED, "--write"], run.io, open)
    ).resolves.toBe(0);
    expect(open).toHaveBeenCalledExactlyOnceWith("postgres://golive.test/db");
    expect(store.writePlan).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        approvalBasis: "owner_decision",
        id: "funded-lower-bar-pie",
        ownerMessageUrl: OWNER_LINK,
        status: "approved",
      }),
      { actor: GOLIVE_SEED_PLAN_ACTOR }
    );
    expect(store.close).toHaveBeenCalledOnce();
    expect(run.out).toEqual([
      '{"id":"funded-lower-bar-pie","status":"approved","version":7}\n',
    ]);
    expect(run.err).toEqual([]);
  });

  it.each([[{}], [{ DATABASE_URL: "" }]])(
    "needs DATABASE_URL with --write (%j)",
    async (env) => {
      const run = cli(env);
      const { open } = storeDouble();
      await expect(
        runGoLiveSeedPlan([...PLAN, "--write"], run.io, open)
      ).resolves.toBe(2);
      expect(open).not.toHaveBeenCalled();
      expect(run.out).toEqual([]);
      expect(run.err).toEqual(["DATABASE_URL is required with --write\n"]);
    }
  );

  it("refuses an approved plan without its links before any database is opened", async () => {
    const run = cli();
    const { open } = storeDouble();
    await expect(
      runGoLiveSeedPlan(
        [
          ...PLAN,
          "--status",
          "approved",
          "--basis",
          "owner_decision",
          "--write",
        ],
        run.io,
        open
      )
    ).resolves.toBe(2);
    expect(open).not.toHaveBeenCalled();
    expect(run.out).toEqual([]);
    expect(run.err.join("")).toContain(
      "An approved plan needs the owner message link and approvedBy"
    );
  });

  it("exits 2 on a usage error", async () => {
    const run = cli();
    await expect(
      runGoLiveSeedPlan(["--nope"], run.io, storeDouble().open)
    ).resolves.toBe(2);
    expect(run.err.join("")).toContain("Unknown argument --nope.");
  });

  it("exits 1 when the write fails and still closes the connection", async () => {
    const run = cli();
    const { open, store } = storeDouble(async () => {
      throw new Error("connection refused");
    });
    await expect(
      runGoLiveSeedPlan([...PLAN, "--write"], run.io, open)
    ).resolves.toBe(1);
    expect(store.close).toHaveBeenCalledOnce();
    expect(run.out).toEqual([]);
    expect(run.err).toEqual(["plan seed failed: connection refused\n"]);
  });

  it("reports a failure that is not an Error", async () => {
    const run = cli();
    const { open } = storeDouble(async () => {
      throw "boom";
    });
    await expect(
      runGoLiveSeedPlan([...PLAN, "--write"], run.io, open)
    ).resolves.toBe(1);
    expect(run.err).toEqual(["plan seed failed: boom\n"]);
  });

  it.each([
    [new Error("socket hung up"), "socket hung up"],
    ["closed twice", "closed twice"],
  ])(
    "keeps the result when closing the connection fails (%s)",
    async (failure, text) => {
      const run = cli();
      const { open } = storeDouble(undefined, async () => {
        throw failure;
      });
      await expect(
        runGoLiveSeedPlan([...PLAN, "--write"], run.io, open)
      ).resolves.toBe(0);
      expect(run.out).toEqual([
        '{"id":"funded-lower-bar-pie","status":"proposed","version":7}\n',
      ]);
      expect(run.err).toEqual([
        `warning: closing the database connection failed: ${text}\n`,
      ]);
    }
  );

  it("opens the real store lazily: no connection is made before a query", async () => {
    const store = openGoLivePlanStore("postgres://u:p@127.0.0.1:1/x");
    expect(typeof store.writePlan).toBe("function");
    await expect(store.close()).resolves.toBeUndefined();
  });
});
