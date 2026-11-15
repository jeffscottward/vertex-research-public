// Writes one allocation plan to Postgres (golive_plans), read by goLiveDrafts.queue.
// Usage: bun run vertex:golive:seed-plan --plan funded-lower-bar-pie [--status proposed|approved]
//   [--basis owner_decision|owner_delegation] [--owner-link <discord message url>]
//   [--evidence-link <https url>] [--approved-by <text>] [--write] [--replace-approved]
// The plan document comes from scripts/golive/plans. The arguments are merged into it and the
// result is checked with GoLivePlanSeedSchema.
// Approval rule: an approved plan always needs --basis, --owner-link (the owner's Discord message)
// and --approved-by (not blank). --evidence-link is required for owner_delegation and optional for
// owner_decision, where the owner's message is the evidence.
// Without --write the plan is printed and nothing is stored. With --write (needs DATABASE_URL):
// - The plan in force is read first. The run prints what it retires (id, version, status) and what
//   it writes.
// - When the plan in force equals this document in every stored field (id, name, status, basis,
//   both links, approved-by, limits, sleeves), nothing is written and the exit code is 0. A repeat
//   of the same command changes nothing.
// - Replacing an APPROVED plan in force by a PROPOSED one is refused with exit 2 unless
//   --replace-approved is given.
// - Every real write makes a new version and retires the plan in force, whatever its id. Proposed
//   drafts of the retired version cannot be approved until the next collect stores drafts for the
//   new version. Drafts already approved under the retired version stay approved.
// - The read and the write are two database steps: run one seed at a time.
// DATABASE_URL is never printed: an error text that repeats it has it replaced.
// Exit codes: 0 printed, written or unchanged; 2 usage, input or a refused replacement; 1 other
// failure.
// RECORDS ONLY: a plan row places, stages and sizes no order.

import { isDeepStrictEqual } from "node:util";
import {
  createGoLiveDraftsRepository,
  createNodeDatabase,
  type GoLiveDraftsRepository,
  type GoLivePlanRecord,
} from "@darkfactory/db/server";
import { z } from "zod";

import {
  GOLIVE_PLAN_APPROVAL_BASIS_VALUES,
  type GoLivePlanSeed,
  GoLivePlanSeedSchema,
} from "../../packages/api/src/contracts/golive-drafts.ts";
import { FUNDED_LOWER_BAR_PIE } from "./plans/funded-lower-bar-pie.ts";

export const GOLIVE_SEED_PLAN_USAGE =
  "Usage: bun run vertex:golive:seed-plan --plan funded-lower-bar-pie [--status proposed|approved] [--basis owner_decision|owner_delegation] [--owner-link <discord message url>] [--evidence-link <https url>] [--approved-by <text>] [--write] [--replace-approved]  (an approved plan needs --basis, --owner-link and --approved-by; --evidence-link is required for owner_delegation and optional for owner_decision; --write needs DATABASE_URL, writes nothing when the plan in force is equal, and replaces an approved plan by a proposed one only with --replace-approved)";

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
  planInForce: GoLiveDraftsRepository["planInForce"];
  writePlan: GoLiveDraftsRepository["writePlan"];
}>;

/** Test seam: opens the plan store for a database URL. */
export type OpenGoLivePlanStore = (databaseUrl: string) => GoLivePlanStore;

export const openGoLivePlanStore: OpenGoLivePlanStore = (databaseUrl) => {
  const resource = createNodeDatabase({ connectionString: databaseUrl });
  const repository = createGoLiveDraftsRepository(resource.db);
  return {
    close: () => resource.close(),
    planInForce: repository.planInForce,
    writePlan: repository.writePlan,
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
  /** True with --replace-approved: an approved plan in force may be replaced by a proposed one. */
  replaceApproved: boolean;
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
  let replaceApproved = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] as string;
    if (argument === "--write") {
      write = true;
      continue;
    }
    if (argument === "--replace-approved") {
      replaceApproved = true;
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
  return { replaceApproved, values, write };
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
  const approvedBy = values["--approved-by"]?.trim();
  if (approvedBy === "") {
    throw new UsageError("--approved-by must name who approved; it is blank");
  }
  const parsed = GoLivePlanSeedSchema.safeParse({
    ...document,
    approvalBasis: values["--basis"] ?? document.approvalBasis,
    approvedBy: approvedBy ?? document.approvedBy,
    evidenceUrl: values["--evidence-link"] ?? document.evidenceUrl,
    ownerMessageUrl: values["--owner-link"] ?? document.ownerMessageUrl,
    status: values["--status"] ?? document.status,
  });
  if (!parsed.success) {
    throw new UsageError(
      `The plan is not valid (--basis is one of ${GOLIVE_PLAN_APPROVAL_BASIS_VALUES.join(", ")}; an approved plan needs --basis, --owner-link and --approved-by, and --evidence-link when the basis is owner_delegation):\n${z.prettifyError(parsed.error)}`
    );
  }
  return parsed.data;
};

/** The fields a plan row stores from a seed document, in one comparable form. */
const storedFieldsOf = (plan: GoLivePlanSeed | GoLivePlanRecord): unknown => ({
  approvalBasis: plan.approvalBasis,
  // The store keeps approvedBy for an approved plan only.
  approvedBy: plan.status === "approved" ? plan.approvedBy : null,
  evidenceUrl: plan.evidenceUrl,
  id: plan.id,
  limits: plan.limits,
  name: plan.name,
  ownerMessageUrl: plan.ownerMessageUrl,
  sleeves: plan.sleeves,
  status: plan.status,
});

const labelOf = (plan: GoLivePlanRecord): string =>
  `${plan.id} v${plan.version} (${plan.status})`;

const run = async (
  argv: readonly string[],
  io: CliIo,
  open: OpenGoLivePlanStore
): Promise<string> => {
  const { replaceApproved, values, write } = parseSeedPlanArguments(argv);
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
    const inForce = await store.planInForce();
    if (
      inForce !== null &&
      isDeepStrictEqual(storedFieldsOf(inForce), storedFieldsOf(plan))
    ) {
      io.stdout.write(
        `in force: ${labelOf(inForce)} equals this plan in every stored field; nothing is written\n`
      );
      return JSON.stringify({
        id: inForce.id,
        status: inForce.status,
        version: inForce.version,
        written: false,
      });
    }
    if (
      inForce?.status === "approved" &&
      plan.status === "proposed" &&
      !replaceApproved
    ) {
      throw new UsageError(
        `Refused: ${labelOf(inForce)} is in force and this write would retire it for a PROPOSED plan, under which no draft can be approved. Nothing was written. Give --replace-approved to do it.`
      );
    }
    io.stdout.write(
      inForce === null
        ? "retires: nothing (no plan is in force)\n"
        : `retires: ${labelOf(inForce)}\n`
    );
    io.stdout.write(`writes: ${plan.id} as ${plan.status}, a new version\n`);
    const stored = await store.writePlan(plan, {
      actor: GOLIVE_SEED_PLAN_ACTOR,
    });
    return JSON.stringify({
      id: stored.id,
      retired:
        inForce === null
          ? null
          : {
              id: inForce.id,
              status: inForce.status,
              version: inForce.version,
            },
      status: stored.status,
      version: stored.version,
      written: true,
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

/** Replaces the database URL and its password in a text: neither is ever printed. */
const withoutDatabaseUrl = (text: string, env: CliIo["env"]): string => {
  const databaseUrl = env["DATABASE_URL"];
  if (!databaseUrl) {
    return text;
  }
  const hidden = text.replaceAll(databaseUrl, "[DATABASE_URL hidden]");
  const password = URL.canParse(databaseUrl)
    ? new URL(databaseUrl).password
    : "";
  if (password === "") {
    return hidden;
  }
  // A driver error would carry the password decoded; a password that cannot be decoded is itself.
  let plain = password;
  try {
    plain = decodeURIComponent(password);
  } catch {
    // Kept as written.
  }
  return hidden
    .replaceAll(password, "[password hidden]")
    .replaceAll(plain, "[password hidden]");
};

/** Runs the seed and returns the process exit code: 0 ok, 2 usage or input error, 1 other failure. */
export const runGoLiveSeedPlan = async (
  argv: readonly string[],
  host: CliIo,
  open: OpenGoLivePlanStore = openGoLivePlanStore
): Promise<number> => {
  if (argv.includes("--help")) {
    host.stdout.write(`${GOLIVE_SEED_PLAN_USAGE}\n`);
    return 0;
  }
  const io: CliIo = {
    env: host.env,
    stderr: {
      write: (text: string) =>
        host.stderr.write(withoutDatabaseUrl(text, host.env)),
    },
    stdout: {
      write: (text: string) =>
        host.stdout.write(withoutDatabaseUrl(text, host.env)),
    },
  };
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
