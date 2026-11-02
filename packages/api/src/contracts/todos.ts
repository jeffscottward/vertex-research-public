import { oc } from "@orpc/contract";
import { z } from "zod";

// Private per-user to-do list. Plain notes only: no orders, intents or trading linkage.
// Agent API keys (write access, operator owner) may call these procedures for their owner.

export const TODO_TITLE_MAX_LENGTH = 200;
export const TODO_NOTE_MAX_LENGTH = 2000;
export const TODO_MAX_TAGS = 10;
export const TODO_TAG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const TODO_STATUS_VALUES = ["open", "done"] as const;
const TODO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const TitleSchema = z.string().trim().min(1).max(TODO_TITLE_MAX_LENGTH);
const NoteSchema = z
  .union([z.string().max(TODO_NOTE_MAX_LENGTH), z.null()])
  .transform((value) => {
    if (value === null) return null;
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
  });
const DueDateSchema = z
  .union([z.string().trim(), z.null()])
  .transform((value) => (value === null || value === "" ? null : value))
  .refine((value) => value === null || TODO_DATE_PATTERN.test(value), {
    message: "Expected a date as YYYY-MM-DD",
  });
const TagsSchema = z
  .array(
    z
      .string()
      .trim()
      .toLowerCase()
      .regex(TODO_TAG_PATTERN, "Tags use a-z, 0-9, - and _ (max 32)")
  )
  .max(TODO_MAX_TAGS)
  .transform((tags) => [...new Set(tags)]);
const SourceUrlSchema = z
  .union([z.string().trim().max(2000), z.null()])
  .transform((value) => (value === null || value === "" ? null : value))
  .refine((value) => value === null || /^https?:\/\/\S+$/u.test(value), {
    message: "Expected an http(s) URL",
  });

export const TodoItemSchema = z.object({
  createdAt: z.date(),
  dueDate: z.string().nullable(),
  id: z.string().min(1),
  note: z.string().nullable(),
  sourceUrl: z.string().nullable(),
  status: z.enum(TODO_STATUS_VALUES),
  tags: z.array(z.string()),
  title: z.string(),
  updatedAt: z.date(),
});

export const TODOS_API_ERRORS = {
  BAD_REQUEST: { message: "Invalid request", status: 400 },
  FORBIDDEN: { message: "Forbidden", status: 403 },
  NOT_FOUND: { message: "To-do not found", status: 404 },
  STORAGE_ERROR: { message: "To-do storage unavailable", status: 503 },
  TOO_MANY_REQUESTS: { message: "Rate limit exceeded", status: 429 },
  UNAUTHORIZED: { message: "Authentication required", status: 401 },
  VALIDATION_ERROR: { message: "To-do validation failed", status: 422 },
} as const;

const todosBase = oc.errors(TODOS_API_ERRORS);

export const TodoListInputSchema = z
  .object({ tag: z.string().trim().toLowerCase().max(32).optional() })
  .strict();
export const TodoListOutputSchema = z.object({
  items: z.array(TodoItemSchema),
});

export const TodoCreateInputSchema = z
  .object({
    dueDate: DueDateSchema.optional(),
    note: NoteSchema.optional(),
    sourceUrl: SourceUrlSchema.optional(),
    tags: TagsSchema.optional(),
    title: TitleSchema,
  })
  .strict();

export const TodoUpdateInputSchema = z
  .object({
    dueDate: DueDateSchema.optional(),
    id: z.string().min(1).max(128),
    note: NoteSchema.optional(),
    sourceUrl: SourceUrlSchema.optional(),
    status: z.enum(TODO_STATUS_VALUES).optional(),
    tags: TagsSchema.optional(),
    title: TitleSchema.optional(),
  })
  .strict()
  .refine((input) => Object.keys(input).some((key) => key !== "id"), {
    message: "Change at least one field",
  });

export const TodoRemoveInputSchema = z
  .object({ id: z.string().min(1).max(128) })
  .strict();
export const TodoRemoveOutputSchema = z.object({
  id: z.string().min(1),
  removed: z.literal(true),
});

const list = todosBase
  .route({
    method: "GET",
    operationId: "todos.list",
    path: "/todos",
    summary: "List to-dos (open first, by due date)",
    tags: ["Todos"],
  })
  .input(TodoListInputSchema)
  .output(TodoListOutputSchema);

const create = todosBase
  .route({
    method: "POST",
    operationId: "todos.create",
    path: "/todos",
    summary: "Add a to-do",
    tags: ["Todos"],
  })
  .input(TodoCreateInputSchema)
  .output(TodoItemSchema);

const update = todosBase
  .route({
    method: "PATCH",
    operationId: "todos.update",
    path: "/todos/{id}",
    summary: "Edit a to-do or mark it done",
    tags: ["Todos"],
  })
  .input(TodoUpdateInputSchema)
  .output(TodoItemSchema);

const remove = todosBase
  .route({
    method: "DELETE",
    operationId: "todos.remove",
    path: "/todos/{id}",
    summary: "Delete a to-do",
    tags: ["Todos"],
  })
  .input(TodoRemoveInputSchema)
  .output(TodoRemoveOutputSchema);

export const todosContract = { create, list, remove, update };

export type TodoItemOutput = z.infer<typeof TodoItemSchema>;
export type TodoListOutput = z.infer<typeof TodoListOutputSchema>;
export type TodoCreateInput = z.input<typeof TodoCreateInputSchema>;
export type TodoUpdateInput = z.input<typeof TodoUpdateInputSchema>;
export type TodoRemoveOutput = z.infer<typeof TodoRemoveOutputSchema>;
