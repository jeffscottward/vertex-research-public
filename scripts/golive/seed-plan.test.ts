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
  close: GoLivePlanStore["close"] = async () => undefined,
  planInForce: GoLivePlanStore["planInForce"] = async () => null
) => {
  const store = {
    close: vi.fn(close),
    planInForce: vi.fn(planInForce),
    writePlan: vi.fn(writePlan),
  };
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

/** The row the store holds after `argv` was written as version `version`. */
const recordOf = (
  argv: readonly string[],
  version = 3,
  changes: Partial<GoLivePlanRecord> = {}
): GoLivePlanRecord => {
  const seed = buildSeedPlan(parseSeedPlanArguments(argv).values);
  const at = new Date("2026-11-12T15:00:00Z");
  return {
    ...seed,
    approvedAt: seed.status === "approved" ? at : null,
    approvedBy: seed.status === "approved" ? seed.approvedBy : null,
    createdAt: at,
    exitRule: "owner_standing_rule_v1",
    retiredAt: null,
    // The store returns the sleeves in another key order than the document.
    sleeves: seed.sleeves.map(
      (sleeve) =>
        Object.fromEntries(
          Object.entries(sleeve).reverse()
        ) as unknown as (typeof seed.sleeves)[number]
    ),
    updatedAt: at,
    version,
    ...changes,
  };
};

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
      replaceApproved: false,
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
    expect(parseSeedPlanArguments([])).toEqual({
      replaceApproved: false,
      values: {},
      write: false,
    });
    expect(
      parseSeedPlanArguments([...PLAN, "--replace-approved", "--write"])
    ).toEqual({
      replaceApproved: true,
      values: { "--plan": "funded-lower-bar-pie" },
      write: true,
    });
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

  it("accepts an owner decision without an evidence link and with one", () => {
    const values = parseSeedPlanArguments(APPROVED).values;
    expect(buildSeedPlan(values).evidenceUrl).toBeNull();
    expect(
      buildSeedPlan({ ...values, "--evidence-link": EVIDENCE_LINK }).evidenceUrl
    ).toBe(EVIDENCE_LINK);
  });

  it("stores --approved-by without the spaces around it", () => {
    expect(
      buildSeedPlan({
        ...parseSeedPlanArguments(APPROVED).values,
        "--approved-by": "  Owner ",
      }).approvedBy
    ).toBe("Owner");
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
    // An owner decision without the owner message link: the evidence link does not replace it.
    [
      {
        "--approved-by": "Owner",
        "--basis": "owner_decision",
        "--evidence-link": EVIDENCE_LINK,
        "--plan": "funded-lower-bar-pie",
        "--status": "approved",
      },
      "An approved plan needs the owner message link and approvedBy",
    ],
    // A delegation with its evidence link and without the owner message link.
    [
      {
        "--approved-by": "Owner",
        "--basis": "owner_delegation",
        "--evidence-link": EVIDENCE_LINK,
        "--plan": "funded-lower-bar-pie",
        "--status": "approved",
      },
      "An approved plan needs the owner message link and approvedBy",
    ],
    // An approved plan without --approved-by.
    [
      {
        "--basis": "owner_decision",
        "--owner-link": OWNER_LINK,
        "--plan": "funded-lower-bar-pie",
        "--status": "approved",
      },
      "An approved plan needs the owner message link and approvedBy",
    ],
    ...[" ", "   ", "\t", "\n "].map(
      (blank): [Record<string, string>, string] => [
        {
          "--approved-by": blank,
          "--basis": "owner_decision",
          "--owner-link": OWNER_LINK,
          "--plan": "funded-lower-bar-pie",
          "--status": "approved",
        },
        "--approved-by must name who approved; it is blank",
      ]
    ),
    [
      { "--approved-by": " ", "--plan": "funded-lower-bar-pie" },
      "--approved-by must name who approved; it is blank",
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
    expect(store.planInForce).toHaveBeenCalledOnce();
    expect(store.close).toHaveBeenCalledOnce();
    expect(run.out).toEqual([
      "retires: nothing (no plan is in force)\n",
      "writes: funded-lower-bar-pie as approved, a new version\n",
      '{"id":"funded-lower-bar-pie","retired":null,"status":"approved","version":7,"written":true}\n',
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
    expect(run.out).toEqual([
      "retires: nothing (no plan is in force)\n",
      "writes: funded-lower-bar-pie as proposed, a new version\n",
    ]);
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
      expect(run.out.at(-1)).toBe(
        '{"id":"funded-lower-bar-pie","retired":null,"status":"proposed","version":7,"written":true}\n'
      );
      expect(run.err).toEqual([
        `warning: closing the database connection failed: ${text}\n`,
      ]);
    }
  );

  it("exits 1 when the read of the plan in force fails: nothing is written", async () => {
    const run = cli();
    const { open, store } = storeDouble(undefined, undefined, async () => {
      throw new Error("relation golive_plans does not exist");
    });
    await expect(
      runGoLiveSeedPlan([...PLAN, "--write"], run.io, open)
    ).resolves.toBe(1);
    expect(store.writePlan).not.toHaveBeenCalled();
    expect(store.close).toHaveBeenCalledOnce();
    expect(run.out).toEqual([]);
    expect(run.err).toEqual([
      "plan seed failed: relation golive_plans does not exist\n",
    ]);
  });

  it("a second run with the same arguments writes nothing and exits 0", async () => {
    // A store that keeps what was written, as the table does.
    let inForce: GoLivePlanRecord | null = null;
    let version = 0;
    const { open, store } = storeDouble(
      async (seed) => {
        version += 1;
        inForce = {
          ...recordOf(PLAN, version),
          ...(seed as Partial<GoLivePlanRecord>),
        };
        return inForce;
      },
      undefined,
      async () => inForce
    );
    const argv = [...APPROVED, "--write"];
    const first = cli();
    await expect(runGoLiveSeedPlan(argv, first.io, open)).resolves.toBe(0);
    expect(store.writePlan).toHaveBeenCalledOnce();
    const second = cli();
    await expect(runGoLiveSeedPlan(argv, second.io, open)).resolves.toBe(0);
    const third = cli();
    await expect(runGoLiveSeedPlan(argv, third.io, open)).resolves.toBe(0);
    expect(store.writePlan).toHaveBeenCalledOnce();
    expect(version).toBe(1);
    expect(store.close).toHaveBeenCalledTimes(3);
    expect(second.err).toEqual([]);
    expect(second.out).toEqual([
      "in force: funded-lower-bar-pie v1 (approved) equals this plan in every stored field; nothing is written\n",
      '{"id":"funded-lower-bar-pie","status":"approved","version":1,"written":false}\n',
    ]);
    expect(third.out).toEqual(second.out);
  });

  it("writes nothing for an equal proposed plan, whatever the key order of the stored row", async () => {
    const run = cli();
    const { open, store } = storeDouble(undefined, undefined, async () =>
      recordOf(PLAN, 5)
    );
    await expect(
      runGoLiveSeedPlan([...PLAN, "--write"], run.io, open)
    ).resolves.toBe(0);
    expect(store.writePlan).not.toHaveBeenCalled();
    expect(run.out.at(-1)).toBe(
      '{"id":"funded-lower-bar-pie","status":"proposed","version":5,"written":false}\n'
    );
  });

  const DELEGATED = [
    ...PLAN,
    "--status",
    "approved",
    "--basis",
    "owner_delegation",
    "--owner-link",
    OWNER_LINK,
    "--evidence-link",
    EVIDENCE_LINK,
    "--approved-by",
    "Owner",
  ];
  it.each<[string, Partial<GoLivePlanRecord>, readonly string[]]>([
    ["another id", { id: "other-plan" }, APPROVED],
    ["another name", { name: "Older name" }, APPROVED],
    ["another basis", {}, DELEGATED],
    [
      "another owner link",
      { ownerMessageUrl: "https://discord.com/channels/111/222/444" },
      APPROVED,
    ],
    [
      "an evidence link the new one lacks",
      { evidenceUrl: EVIDENCE_LINK },
      APPROVED,
    ],
    ["another approver", { approvedBy: "Delegate" }, APPROVED],
    [
      "other limits",
      {
        limits: {
          maxPositions: 3,
          nameRiskCapPct: 1,
          openRiskCapPct: 4,
          positionRiskPct: 1,
        },
      },
      APPROVED,
    ],
    ["other sleeves", { sleeves: [] }, APPROVED],
  ])(
    "writes a new version when the plan in force has %s",
    async (_name, changes, argv) => {
      const run = cli();
      const { open, store } = storeDouble(undefined, undefined, async () =>
        recordOf(APPROVED, 3, changes)
      );
      await expect(
        runGoLiveSeedPlan([...argv, "--write"], run.io, open)
      ).resolves.toBe(0);
      expect(store.writePlan).toHaveBeenCalledOnce();
      const id = changes.id ?? "funded-lower-bar-pie";
      expect(run.out).toEqual([
        `retires: ${id} v3 (approved)\n`,
        "writes: funded-lower-bar-pie as approved, a new version\n",
        `{"id":"funded-lower-bar-pie","retired":{"id":"${id}","status":"approved","version":3},"status":"approved","version":7,"written":true}\n`,
      ]);
    }
  );

  it("refuses to replace an approved plan in force by a proposed one without --replace-approved", async () => {
    const run = cli();
    const { open, store } = storeDouble(undefined, undefined, async () =>
      recordOf(APPROVED, 3)
    );
    await expect(
      runGoLiveSeedPlan([...PLAN, "--write"], run.io, open)
    ).resolves.toBe(2);
    expect(store.writePlan).not.toHaveBeenCalled();
    expect(store.close).toHaveBeenCalledOnce();
    expect(run.out).toEqual([]);
    expect(run.err).toEqual([
      "Refused: funded-lower-bar-pie v3 (approved) is in force and this write would retire it for a PROPOSED plan, under which no draft can be approved. Nothing was written. Give --replace-approved to do it.\n",
    ]);
  });

  it("replaces an approved plan in force by a proposed one with --replace-approved", async () => {
    const run = cli();
    const { open, store } = storeDouble(undefined, undefined, async () =>
      recordOf(APPROVED, 3)
    );
    await expect(
      runGoLiveSeedPlan(
        [...PLAN, "--write", "--replace-approved"],
        run.io,
        open
      )
    ).resolves.toBe(0);
    expect(store.writePlan).toHaveBeenCalledOnce();
    expect(run.out).toEqual([
      "retires: funded-lower-bar-pie v3 (approved)\n",
      "writes: funded-lower-bar-pie as proposed, a new version\n",
      '{"id":"funded-lower-bar-pie","retired":{"id":"funded-lower-bar-pie","status":"approved","version":3},"status":"proposed","version":7,"written":true}\n',
    ]);
  });

  it("replaces a proposed plan in force by an approved one without any extra flag", async () => {
    const run = cli();
    const { open, store } = storeDouble(undefined, undefined, async () =>
      recordOf(PLAN, 2)
    );
    await expect(
      runGoLiveSeedPlan([...APPROVED, "--write"], run.io, open)
    ).resolves.toBe(0);
    expect(store.writePlan).toHaveBeenCalledOnce();
    expect(run.out[0]).toBe("retires: funded-lower-bar-pie v2 (proposed)\n");
  });

  it("prints no DATABASE_URL and no password in any outcome", async () => {
    const url = "postgres://seed:s3cr%40t-pw@db.internal:5432/vertex";
    const leak = `connect failed for ${url} (password s3cr@t-pw, raw s3cr%40t-pw)`;
    const outcomes: [readonly string[], ReturnType<typeof storeDouble>][] = [
      [[...APPROVED, "--write"], storeDouble()],
      [[...PLAN], storeDouble()],
      [["--help"], storeDouble()],
      [["--nope"], storeDouble()],
      [
        [...APPROVED, "--write"],
        storeDouble(undefined, undefined, async () => recordOf(APPROVED)),
      ],
      [
        [...PLAN, "--write"],
        storeDouble(undefined, undefined, async () => recordOf(APPROVED)),
      ],
      [
        [...PLAN, "--write"],
        storeDouble(async () => {
          throw new Error(leak);
        }),
      ],
      [
        [...PLAN, "--write"],
        storeDouble(undefined, async () => {
          throw new Error(leak);
        }),
      ],
    ];
    const codes: number[] = [];
    let all = "";
    for (const [argv, { open }] of outcomes) {
      const run = cli({ DATABASE_URL: url });
      codes.push(await runGoLiveSeedPlan(argv, run.io, open));
      all += run.out.join("") + run.err.join("");
    }
    expect(codes).toEqual([0, 0, 0, 2, 0, 2, 1, 0]);
    expect(all).toContain(
      "plan seed failed: connect failed for [DATABASE_URL hidden] (password [password hidden], raw [password hidden])"
    );
    for (const secret of [url, "s3cr%40t-pw", "s3cr@t-pw", "db.internal"]) {
      expect(all).not.toContain(secret);
    }
  });

  it.each([
    ["not a URL", "not a url with spaces", "x"],
    ["a URL without a password", "postgres://db.test/vertex", "x"],
    ["a password that cannot be decoded", "postgres://u:%zz@db.test/v", "%zz"],
  ])("hides a DATABASE_URL that is %s", async (_name, url, secret) => {
    const run = cli({ DATABASE_URL: url });
    const { open } = storeDouble(async () => {
      throw new Error(`cannot use ${url} or ${secret}`);
    });
    await expect(
      runGoLiveSeedPlan([...PLAN, "--write"], run.io, open)
    ).resolves.toBe(1);
    expect(run.err.join("")).not.toContain(url);
    expect(run.err.join("")).toContain("[DATABASE_URL hidden]");
  });

  it("opens the real store lazily: no connection is made before a query", async () => {
    const store = openGoLivePlanStore("postgres://u:p@127.0.0.1:1/x");
    expect(typeof store.writePlan).toBe("function");
    expect(typeof store.planInForce).toBe("function");
    await expect(store.close()).resolves.toBeUndefined();
  });
});
