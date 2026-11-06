// What: typed repository errors, Postgres error-detail lookup and shared input guards.
// Used by: packages/db/src/server/repositories.ts and every feature repository beside it; re-exported by index.ts.
// See: docs/debugging.md#symptom--where-to-look.
export class DatabaseConflictError extends Error {
  constructor(entity: string) {
    super(`${entity} conflicts with an existing record`);
    this.name = "DatabaseConflictError";
  }
}

export class OptimisticConcurrencyError extends DatabaseConflictError {
  constructor(entity: string) {
    super(entity);
    this.name = "OptimisticConcurrencyError";
  }
}

export class DatabasePersistenceError extends Error {
  constructor(operation: string) {
    super(`Database operation failed: ${operation}`);
    this.name = "DatabasePersistenceError";
  }
}

export class InvalidRepositoryInputError extends Error {
  constructor(message: string) {
    super(`Invalid repository input: ${message}`);
    this.name = "InvalidRepositoryInputError";
  }
}

export type RepositoryDependencies = Readonly<{
  now?: () => Date;
  generateId?: () => string;
}>;

export const databaseErrorDetails = (
  error: unknown
): Readonly<{ code?: unknown; constraint?: unknown }> => {
  const visited = new Set<object>();
  let current = error;

  while (typeof current === "object" && current !== null) {
    if (visited.has(current)) break;
    visited.add(current);

    const candidate = current as {
      cause?: unknown;
      code?: unknown;
      constraint?: unknown;
    };
    if (typeof candidate.code === "string") {
      return {
        code: candidate.code,
        constraint: candidate.constraint,
      };
    }
    current = candidate.cause;
  }

  return {};
};

export const requireNonBlank = (value: string, field: string): void => {
  if (value.trim().length === 0) {
    throw new InvalidRepositoryInputError(`${field} must not be blank`);
  }
};
