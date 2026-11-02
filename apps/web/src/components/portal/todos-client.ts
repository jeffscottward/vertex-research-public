"use client";

import {
  type ApiClient,
  createApiClient,
  type TodoItemOutput,
} from "@darkfactory/api";

export type TodoFields = Readonly<{
  title: string;
  note: string | null;
  dueDate: string | null;
  tags: string[];
  sourceUrl: string | null;
}>;

export type TodoEditInput = Partial<TodoFields> &
  Readonly<{ status?: "open" | "done" }>;

export interface TodosGateway {
  readonly create: (input: TodoFields) => Promise<TodoItemOutput>;
  readonly list: () => Promise<TodoItemOutput[]>;
  readonly remove: (id: string) => Promise<void>;
  readonly update: (
    id: string,
    input: TodoEditInput
  ) => Promise<TodoItemOutput>;
}

const createTodosGateway = (client: ApiClient): TodosGateway => ({
  create: (input) => client.todos.create({ ...input }),
  list: async () => (await client.todos.list({})).items,
  remove: async (id) => {
    await client.todos.remove({ id });
    return;
  },
  update: (id, input) => client.todos.update({ id, ...input }),
});

export const createBrowserTodosGateway = (): TodosGateway => {
  let gateway: TodosGateway | undefined;
  const current = (): TodosGateway => {
    gateway ??= createTodosGateway(
      createApiClient({ baseUrl: window.location.origin })
    );
    return gateway;
  };
  return Object.freeze({
    create: (input: TodoFields) => current().create(input),
    list: () => current().list(),
    remove: (id: string) => current().remove(id),
    update: (id: string, input: TodoEditInput) => current().update(id, input),
  });
};

const errorField = (error: unknown, field: string): string | null => {
  if (typeof error !== "object" || error === null) return null;
  const value = Reflect.get(error, field);
  return typeof value === "string" && value.length > 0 ? value : null;
};

export const describeTodoFailure = (error: unknown): string => {
  switch (errorField(error, "code")) {
    case "UNAUTHORIZED": {
      return "Session expired. Sign in again.";
    }
    case "FORBIDDEN": {
      return "Not permitted for this session.";
    }
    case "NOT_FOUND": {
      return "To-do no longer exists. Reload the list.";
    }
    case "VALIDATION_ERROR":
    case "BAD_REQUEST": {
      return `Rejected: ${errorField(error, "message") ?? "invalid input"}`;
    }
    case "STORAGE_ERROR": {
      return "To-do storage unavailable (503).";
    }
    default: {
      return "Request failed. Retry.";
    }
  }
};

// Same order as the server: open first, earliest due date (none last), newest first.
export const sortTodos = (
  items: readonly TodoItemOutput[]
): TodoItemOutput[] => {
  return [...items].sort((a, b) => {
    if (a.status !== b.status) return a.status === "open" ? -1 : 1;
    if (a.dueDate !== b.dueDate) {
      if (a.dueDate === null) return 1;
      if (b.dueDate === null) return -1;
      return a.dueDate < b.dueDate ? -1 : 1;
    }
    return b.createdAt.getTime() - a.createdAt.getTime();
  });
};

export const upsertTodo = (
  items: readonly TodoItemOutput[],
  next: TodoItemOutput
): TodoItemOutput[] => {
  const found = items.some((item) => item.id === next.id);
  return sortTodos(
    found
      ? items.map((item) => (item.id === next.id ? next : item))
      : [...items, next]
  );
};

export const parseTagText = (text: string): string[] => {
  const tags: string[] = [];
  for (const token of text.split(/[\s,;]+/u)) {
    const tag = token.trim().toLowerCase().replace(/^#/u, "");
    if (tag !== "" && !tags.includes(tag)) tags.push(tag);
  }
  return tags;
};

export const allTags = (items: readonly TodoItemOutput[]): string[] => {
  return [...new Set(items.flatMap((item) => item.tags))].sort();
};

// Overdue only for open to-dos; `today` is YYYY-MM-DD in the viewer's time zone.
export const isOverdue = (item: TodoItemOutput, today: string): boolean => {
  return (
    item.status === "open" && item.dueDate !== null && item.dueDate < today
  );
};

export const localToday = (now: Date = new Date()): string => {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
};
