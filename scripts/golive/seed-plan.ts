// Writes one allocation plan to Postgres (golive_plans), read by goLiveDrafts.queue.
// Usage: bun run vertex:golive:seed-plan --plan funded-lower-bar-pie [--status proposed|approved]
//   [--basis owner_decision|owner_delegation] [--owner-link <discord message url>]
//   [--evidence-link <https url>] [--approved-by <text>] [--write]
// The plan document comes from scripts/golive/plans. The arguments are merged into it and the
// result is checked with GoLivePlanSeedSchema, so an approved plan without its links is refused.
// Without --write the plan is printed and nothing is stored. With --write (needs DATABASE_URL) the
// plan in force is retired and this one becomes the next version.
// RECORDS ONLY: a plan row places, stages and sizes no order.
import {
  createGoLiveDraftsRepository,
  createNodeDatabase,
  type GoLiveDraftsRepository,
} from "@darkfactory/db/server";
import { z } from "zod";

import {
  GOLIVE_PLAN_APPROVAL_BASIS_VALUES,
  type GoLivePlanSeed,
  GoLivePlanSeedSchema,
} from "../../packages/api/src/contracts/golive-drafts.ts";
import { FUNDED_LOWER_BAR_PIE } from "./plans/funded-lower-bar-pie.ts";

export const GOLIVE_SEED_PLAN_USAGE =
  "Usage: bun run vertex:golive:seed-plan --plan funded-lower-bar-pie [--status proposed|approved] [--basis owner_decision|owner_delegation] [--owner-link <discord message url>] [--evidence-link <https url>] [--approved-by <text>] [--write]  (--write needs DATABASE_URL)";

/** Who the repository records as the writer of the plan row. */
export const GOLIVE_SEED_PLAN_ACTOR = "scripts/golive/seed-plan";

/** The plan documents this script can write, by id. */
export const GOLIVE_PLAN_DOCUMENTS: Readonly<Record<string, GoLivePlanSeed>> = {
  [FUNDED_LOWER_BAR_PIE.id]: FUNDED_LOWER_BAR_PIE,
};

export type CliIo = Readonly<{
  env: NodeJS.ProcessEnv;
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
}>;

export type GoLivePlanStore = Readonly<{
  close: () => Promise<void>;
  writePlan: GoLiveDraftsRepository["writePlan"];
}>;

/** Test seam: opens the plan store for a database URL. */
export type OpenGoLivePlanStore = (databaseUrl: string) => GoLivePlanStore;

export const openGoLivePlanStore: OpenGoLivePlanStore = (databaseUrl) => {
  const resource = createNodeDatabase({ connectionString: databaseUrl });
  return {
    close: () => resource.close(),
    writePlan: createGoLiveDraftsRepository(resource.db).writePlan,
  };
};

/** A usage or input problem; the CLI exits with code 2. */
class UsageError extends Error {}

const VALUE_FLAGS = [
  "--plan",
  "--status",
  "--basis",
  "--owner-link",
  "--evidence-link",
  "--approved-by",
] as const;
type ValueFlag = (typeof VALUE_FLAGS)[number];

export type SeedPlanArguments = Readonly<{
  values: Readonly<Partial<Record<ValueFlag, string>>>;
  write: boolean;
}>;

const isValueFlag = (argument: string): argument is ValueFlag =>
  (VALUE_FLAGS as readonly string[]).includes(argument);

/** Reads the flags; an unknown flag, a repeated flag or a flag without its value is refused. */
export const parseSeedPlanArguments = (
  argv: readonly string[]
): SeedPlanArguments => {
  const values: Partial<Record<ValueFlag, string>> = {};
  let write = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] as string;
    if (argument === "--write") {
      write = true;
      continue;
    }
    if (!isValueFlag(argument)) {
      throw new UsageError(
        `Unknown argument ${argument}.\n${GOLIVE_SEED_PLAN_USAGE}`
      );
    }
    if (values[argument] !== undefined) {
      throw new UsageError(`${argument} is given twice`);
    }
    const value = argv[index + 1];
    if (value === undefined || value === "" || value.startsWith("--")) {
      throw new UsageError(`${argument} needs a value`);
    }
    values[argument] = value;
    index += 1;
  }
  return { values, write };
};

/**
 * The plan document with the arguments merged in, checked with GoLivePlanSeedSchema. A flag that
 * is not given leaves the document's own value (null approval fields, status proposed).
 */
export const buildSeedPlan = (
  values: SeedPlanArguments["values"]
): GoLivePlanSeed => {
  const planId = values["--plan"];
  if (planId === undefined) {
    throw new UsageError(`--plan is required.\n${GOLIVE_SEED_PLAN_USAGE}`);
  }
  const document = Object.hasOwn(GOLIVE_PLAN_DOCUMENTS, planId)
    ? GOLIVE_PLAN_DOCUMENTS[planId]
    : undefined;
  if (document === undefined) {
    throw new UsageError(
      `Unknown plan ${planId}. Known plans: ${Object.keys(GOLIVE_PLAN_DOCUMENTS).join(", ")}`
    );
  }
  const parsed = GoLivePlanSeedSchema.safeParse({
    ...document,
    approvalBasis: values["--basis"] ?? document.approvalBasis,
    approvedBy: values["--approved-by"] ?? document.approvedBy,
    evidenceUrl: values["--evidence-link"] ?? document.evidenceUrl,
    ownerMessageUrl: values["--owner-link"] ?? document.ownerMessageUrl,
    status: values["--status"] ?? document.status,
  });
  if (!parsed.success) {
    throw new UsageError(
      `The plan is not valid (--basis is one of ${GOLIVE_PLAN_APPROVAL_BASIS_VALUES.join(", ")}):\n${z.prettifyError(parsed.error)}`
    );
  }
  return parsed.data;
};

const run = async (
  argv: readonly string[],
  io: CliIo,
  open: OpenGoLivePlanStore
): Promise<string> => {
  const { values, write } = parseSeedPlanArguments(argv);
  const plan = buildSeedPlan(values);
  if (!write) {
    return JSON.stringify({ plan, written: false }, null, 2);
  }
  const databaseUrl = io.env["DATABASE_URL"];
  if (databaseUrl === undefined || databaseUrl === "") {
    throw new UsageError("DATABASE_URL is required with --write");
  }
  const store = open(databaseUrl);
  try {
    const stored = await store.writePlan(plan, {
      actor: GOLIVE_SEED_PLAN_ACTOR,
    });
    return JSON.stringify({
      id: stored.id,
      status: stored.status,
      version: stored.version,
    });
  } finally {
    // A failed close must not hide the write's own result or error.
    await store.close().catch((error: unknown) => {
      io.stderr.write(
        `warning: closing the database connection failed: ${error instanceof Error ? error.message : String(error)}\n`
      );
    });
  }
};

/** Runs the seed and returns the process exit code: 0 ok, 2 usage or input error, 1 other failure. */
export const runGoLiveSeedPlan = async (
  argv: readonly string[],
  io: CliIo,
  open: OpenGoLivePlanStore = openGoLivePlanStore
): Promise<number> => {
  if (argv.includes("--help")) {
    io.stdout.write(`${GOLIVE_SEED_PLAN_USAGE}\n`);
    return 0;
  }
  try {
    io.stdout.write(`${await run(argv, io, open)}\n`);
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr.write(`${error.message}\n`);
      return 2;
    }
    io.stderr.write(
      `plan seed failed: ${error instanceof Error ? error.message : String(error)}\n`
    );
    return 1;
  }
};
