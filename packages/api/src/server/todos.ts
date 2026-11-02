import {
  AgentApiKeyRateLimitedError,
  AuthAuthorizationError,
  type SafePrincipal,
} from "@darkfactory/auth/server";
import type { Todo } from "@darkfactory/db/schema";
import {
  DatabasePersistenceError,
  InvalidRepositoryInputError,
  type TodoRepository,
} from "@darkfactory/db/server";
import { implement } from "@orpc/server";

import { appContract } from "../contract.ts";
import type { TodoItemOutput } from "../contracts/todos.ts";
import type { ApiContext } from "./context.ts";
import { agentKeyOwnerPrincipal } from "./operator-access.ts";

// Owner is always the authenticated user: the session user, or the owner of an agent
// API key (operator only; write key for changes). Inputs never carry a user id.

const api = implement(appContract).$context<ApiContext>();

type TodoErrorCode =
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "VALIDATION_ERROR"
  | "TOO_MANY_REQUESTS"
  | "STORAGE_ERROR";

type TodoErrorFactories = Readonly<
  Record<TodoErrorCode, (options?: { message?: string }) => Error>
>;

const factories = (errors: unknown): TodoErrorFactories => {
  return errors as TodoErrorFactories;
};

const requireTodoOwner = api.middleware(
  async ({ context, next, errors, path }) => {
    const failures = factories(errors);
    let principal: SafePrincipal;
    try {
      if (context.agentApiKeyPresented === true) {
        principal = await agentKeyOwnerPrincipal(context, path, errors);
      } else {
        principal = (await context.requireSession()).principal;
      }
    } catch (error) {
      if (error instanceof AgentApiKeyRateLimitedError) {
        throw failures.TOO_MANY_REQUESTS();
      }
      if (!(error instanceof AuthAuthorizationError)) throw error;
      if (error.status === 401) throw failures.UNAUTHORIZED();
      throw failures.FORBIDDEN();
    }
    return next({ context: { principal } });
  }
);

const repositoryFor = (
  context: ApiContext,
  errors: unknown
): TodoRepository => {
  const repository = context.repositories.todos;
  if (repository === undefined) throw factories(errors).STORAGE_ERROR();
  return repository;
};

const mapTodoError = (error: unknown, errors: unknown): never => {
  const failures = factories(errors);
  if (error instanceof InvalidRepositoryInputError) {
    throw failures.VALIDATION_ERROR({ message: error.message });
  }
  if (error instanceof DatabasePersistenceError) throw failures.STORAGE_ERROR();
  throw error;
};

const toTodoItemOutput = (item: Todo): TodoItemOutput => ({
  createdAt: item.createdAt,
  dueDate: item.dueDate ?? null,
  id: item.id,
  note: item.note ?? null,
  sourceUrl: item.sourceUrl ?? null,
  status: item.status,
  tags: [...item.tags],
  title: item.title,
  updatedAt: item.updatedAt,
});

const todosList = api.todos.list
  .use(requireTodoOwner)
  .handler(async ({ context, input, errors }) => {
    const repository = repositoryFor(context, errors);
    try {
      const items = await repository.listByUser(
        context.principal.userId,
        input.tag
      );
      return { items: items.map(toTodoItemOutput) };
    } catch (error) {
      return mapTodoError(error, errors);
    }
  });

const todosCreate = api.todos.create
  .use(requireTodoOwner)
  .handler(async ({ context, input, errors }) => {
    const repository = repositoryFor(context, errors);
    try {
      const item = await repository.create(context.principal.userId, {
        dueDate: input.dueDate ?? null,
        note: input.note ?? null,
        sourceUrl: input.sourceUrl ?? null,
        tags: input.tags ?? [],
        title: input.title,
      });
      return toTodoItemOutput(item);
    } catch (error) {
      return mapTodoError(error, errors);
    }
  });

const todosUpdate = api.todos.update
  .use(requireTodoOwner)
  .handler(async ({ context, input, errors }) => {
    const repository = repositoryFor(context, errors);
    let item: Todo | null;
    try {
      item = await repository.update({
        id: input.id,
        userId: context.principal.userId,
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.note === undefined ? {} : { note: input.note }),
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.dueDate === undefined ? {} : { dueDate: input.dueDate }),
        ...(input.tags === undefined ? {} : { tags: input.tags }),
        ...(input.sourceUrl === undefined
          ? {}
          : { sourceUrl: input.sourceUrl }),
      });
    } catch (error) {
      return mapTodoError(error, errors);
    }
    if (item === null) throw factories(errors).NOT_FOUND();
    return toTodoItemOutput(item);
  });

const todosRemove = api.todos.remove
  .use(requireTodoOwner)
  .handler(async ({ context, input, errors }) => {
    const repository = repositoryFor(context, errors);
    let removed: boolean;
    try {
      removed = await repository.remove(input.id, context.principal.userId);
    } catch (error) {
      return mapTodoError(error, errors);
    }
    if (!removed) throw factories(errors).NOT_FOUND();
    return { id: input.id, removed: true as const };
  });

export const todosRouter = {
  create: todosCreate,
  list: todosList,
  remove: todosRemove,
  update: todosUpdate,
};
