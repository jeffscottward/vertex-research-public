import {
  DatabasePersistenceError,
  type QuantLabReadModel,
} from "@darkfactory/db/server";
import { implement } from "@orpc/server";

import { appContract } from "../contract.ts";
import {
  type QuantLabListOutput,
  QuantLabListOutputSchema,
} from "../contracts/quant-lab.ts";
import type { ApiContext } from "./context.ts";
import { requireOperator } from "./operator-access.ts";

// quantLab.list: read-only, operator-only (same gate as agentOps.backtests.list). Stored JSON
// columns (paper_claims, our_reading) and joined rows are validated with Zod here, at the boundary.

export class QuantLabRecordShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuantLabRecordShapeError";
  }
}

export const toQuantLabListOutput = (
  model: QuantLabReadModel
): QuantLabListOutput => {
  const parsed = QuantLabListOutputSchema.safeParse(model);
  if (parsed.success) return parsed.data;
  const where = parsed.error.issues
    .slice(0, 3)
    .map((issue) => issue.path.join("."))
    .join(", ");
  throw new QuantLabRecordShapeError(
    `A Quant Lab record has an unexpected shape at ${where}`
  );
};

const api = implement(appContract).$context<ApiContext>();

const quantLabList = api.quantLab.list
  .use(requireOperator)
  .handler(async ({ context, errors }) => {
    const repository = context.repositories.quantLab;
    if (repository === undefined) throw errors.STORAGE_ERROR();
    try {
      return toQuantLabListOutput(await repository.list());
    } catch (error) {
      if (error instanceof QuantLabRecordShapeError)
        throw errors.STORAGE_ERROR({ message: error.message });
      if (error instanceof DatabasePersistenceError)
        throw errors.STORAGE_ERROR();
      throw error;
    }
  });

export const quantLabRouter = { list: quantLabList };
