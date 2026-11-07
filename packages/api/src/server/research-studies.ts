import {
  DatabasePersistenceError,
  type ResearchStudyRecord,
} from "@darkfactory/db/server";
import { implement } from "@orpc/server";

import { appContract } from "../contract.ts";
import {
  type ResearchStudy,
  ResearchStudySchema,
} from "../contracts/research-studies.ts";
import type { ApiContext } from "./context.ts";
import { requireOperator } from "./operator-access.ts";

// researchStudies.get: read-only, operator-only (the same gate as quantLab.list, which the /backtests
// page shows beside it). The stored study document is validated with FilterStudySchema here, at the
// boundary, so a row that no longer matches the contract is a storage error, never a broken page.

export class ResearchStudyShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResearchStudyShapeError";
  }
}

export const toResearchStudy = (record: ResearchStudyRecord): ResearchStudy => {
  const parsed = ResearchStudySchema.safeParse({
    id: record.id,
    study: record.summary,
    updatedAt: record.updatedAt,
  });
  if (parsed.success) return parsed.data;
  const where = parsed.error.issues
    .slice(0, 3)
    .map((issue) => issue.path.join("."))
    .join(", ");
  throw new ResearchStudyShapeError(
    `Research study ${record.id} has an unexpected shape at ${where}`
  );
};

const api = implement(appContract).$context<ApiContext>();

const researchStudyGet = api.researchStudies.get
  .use(requireOperator)
  .handler(async ({ context, errors, input }) => {
    const repository = context.repositories.researchStudies;
    if (repository === undefined) throw errors.STORAGE_ERROR();
    try {
      const record = await repository.get(input.id);
      if (record === null) throw errors.NOT_FOUND();
      return toResearchStudy(record);
    } catch (error) {
      if (error instanceof ResearchStudyShapeError)
        throw errors.STORAGE_ERROR({ message: error.message });
      if (error instanceof DatabasePersistenceError)
        throw errors.STORAGE_ERROR();
      throw error;
    }
  });

export const researchStudiesRouter = { get: researchStudyGet };
