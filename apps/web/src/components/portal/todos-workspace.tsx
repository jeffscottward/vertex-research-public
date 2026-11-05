"use client";

import {
  TODO_NOTE_MAX_LENGTH,
  TODO_TITLE_MAX_LENGTH,
  type TodoItemOutput,
} from "@darkfactory/api";
import { Button, Input, KpiCard, KpiRow, Panel } from "@darkfactory/ui";
import {
  CalendarClock,
  Check,
  CircleCheck,
  ExternalLink,
  ListTodo,
  Pencil,
  Plus,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import {
  allTags,
  createBrowserTodosGateway,
  describeTodoFailure,
  isOverdue,
  localToday,
  parseTagText,
  sortTodos,
  type TodoFields,
  type TodosGateway,
  upsertTodo,
} from "./todos-client.ts";

export interface TodosWorkspaceProps {
  readonly gateway?: TodosGateway;
  readonly today?: string;
}

type ListState =
  | Readonly<{ type: "loading" }>
  | Readonly<{ type: "ready" }>
  | Readonly<{ type: "error"; message: string }>;

type Draft = Readonly<{
  title: string;
  note: string;
  dueDate: string;
  tags: string;
  sourceUrl: string;
}>;

const EMPTY_DRAFT: Draft = {
  dueDate: "",
  note: "",
  sourceUrl: "",
  tags: "",
  title: "",
};

const blankToNull = (value: string): string | null => {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
};

const draftFields = (draft: Draft): TodoFields => ({
  dueDate: blankToNull(draft.dueDate),
  note: blankToNull(draft.note),
  sourceUrl: blankToNull(draft.sourceUrl),
  tags: parseTagText(draft.tags),
  title: draft.title.trim(),
});

const fieldClass =
  "w-full rounded-md border border-border bg-background p-2 text-sm";

const DraftForm = ({
  draft,
  idPrefix,
  onChange,
}: Readonly<{
  draft: Draft;
  idPrefix: string;
  onChange: (draft: Draft) => void;
}>) => (
  <div className="grid gap-2 sm:grid-cols-2">
    <label className="space-y-1 text-xs sm:col-span-2">
      <span className="text-muted-foreground">Title</span>
      <Input
        id={`${idPrefix}-title`}
        maxLength={TODO_TITLE_MAX_LENGTH}
        onChange={(event) => onChange({ ...draft, title: event.target.value })}
        placeholder="What needs doing"
        value={draft.title}
      />
    </label>
    <label className="space-y-1 text-xs sm:col-span-2">
      <span className="text-muted-foreground">Note</span>
      <textarea
        className={`${fieldClass} min-h-16`}
        id={`${idPrefix}-note`}
        maxLength={TODO_NOTE_MAX_LENGTH}
        onChange={(event) => onChange({ ...draft, note: event.target.value })}
        value={draft.note}
      />
    </label>
    <label className="space-y-1 text-xs">
      <span className="text-muted-foreground">Due date</span>
      <Input
        id={`${idPrefix}-due`}
        onChange={(event) =>
          onChange({ ...draft, dueDate: event.target.value })
        }
        type="date"
        value={draft.dueDate}
      />
    </label>
    <label className="space-y-1 text-xs">
      <span className="text-muted-foreground">Tags (comma or space)</span>
      <Input
        id={`${idPrefix}-tags`}
        onChange={(event) => onChange({ ...draft, tags: event.target.value })}
        placeholder="research, broker"
        value={draft.tags}
      />
    </label>
    <label className="space-y-1 text-xs sm:col-span-2">
      <span className="text-muted-foreground">Source URL</span>
      <Input
        id={`${idPrefix}-url`}
        inputMode="url"
        onChange={(event) =>
          onChange({ ...draft, sourceUrl: event.target.value })
        }
        placeholder="https://…"
        type="url"
        value={draft.sourceUrl}
      />
    </label>
  </div>
);

type TodoRowProps = Readonly<{
  item: TodoItemOutput;
  busy: boolean;
  overdue: boolean;
  confirmingRemove: boolean;
  editDraft: Draft | null;
  onDraftChange: (draft: Draft) => void;
  onEdit: () => void;
  onSave: (draft: Draft) => void;
  onCancelEdit: () => void;
  onToggle: () => void;
  onRequestRemove: () => void;
  onRemove: () => void;
  onCancelRemove: () => void;
}>;

const TodoRow = ({
  item,
  busy,
  overdue,
  confirmingRemove,
  editDraft,
  onDraftChange,
  onEdit,
  onSave,
  onCancelEdit,
  onToggle,
  onRequestRemove,
  onRemove,
  onCancelRemove,
}: TodoRowProps) => (
  <li
    className="rounded-lg border border-border p-3"
    data-status={item.status}
    data-todo-id={item.id}
  >
    {editDraft === null ? (
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
        <div className="min-w-0 flex-1 space-y-1">
          <p
            className={`break-words font-medium text-sm ${item.status === "done" ? "text-muted-foreground line-through" : ""}`}
          >
            {item.title}
          </p>
          {item.note !== null && (
            <p className="whitespace-pre-wrap break-words text-muted-foreground text-sm">
              {item.note}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2 text-xs">
            {item.dueDate !== null && (
              <span
                className={
                  overdue
                    ? "font-medium text-destructive"
                    : "text-muted-foreground"
                }
              >
                {overdue ? "Overdue: " : "Due "}
                {item.dueDate}
              </span>
            )}
            {item.tags.map((tag) => (
              <span
                className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground"
                key={tag}
              >
                #{tag}
              </span>
            ))}
            {item.sourceUrl !== null && (
              <a
                className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline"
                href={item.sourceUrl}
                rel="noopener noreferrer"
                target="_blank"
              >
                <ExternalLink aria-hidden="true" className="size-3" />
                Source
              </a>
            )}
          </div>
        </div>
        <div className="flex flex-wrap gap-1">
          <Button
            aria-label={
              item.status === "open"
                ? `Mark done: ${item.title}`
                : `Reopen: ${item.title}`
            }
            disabled={busy}
            onClick={onToggle}
            size="sm"
            type="button"
          >
            {item.status === "open" ? (
              <Check aria-hidden="true" className="size-4" />
            ) : (
              <RotateCcw aria-hidden="true" className="size-4" />
            )}
            {item.status === "open" ? "Done" : "Reopen"}
          </Button>
          <Button
            aria-label={`Edit: ${item.title}`}
            onClick={onEdit}
            size="sm"
            type="button"
            variant="secondary"
          >
            <Pencil aria-hidden="true" className="size-4" />
            Edit
          </Button>
          {confirmingRemove ? (
            <>
              <Button
                aria-label={`Confirm delete: ${item.title}`}
                disabled={busy}
                onClick={onRemove}
                size="sm"
                type="button"
                variant="destructive"
              >
                <Trash2 aria-hidden="true" className="size-4" />
                Confirm delete
              </Button>
              <Button
                onClick={onCancelRemove}
                size="sm"
                type="button"
                variant="secondary"
              >
                Keep
              </Button>
            </>
          ) : (
            <Button
              aria-label={`Delete: ${item.title}`}
              disabled={busy}
              onClick={onRequestRemove}
              size="sm"
              type="button"
              variant="secondary"
            >
              <Trash2 aria-hidden="true" className="size-4" />
              Delete
            </Button>
          )}
        </div>
      </div>
    ) : (
      <div className="space-y-3">
        <DraftForm
          draft={editDraft}
          idPrefix={`todo-${item.id}`}
          onChange={onDraftChange}
        />
        <div className="flex gap-2">
          <Button
            disabled={busy}
            onClick={() => onSave(editDraft)}
            type="button"
          >
            Save
          </Button>
          <Button onClick={onCancelEdit} type="button" variant="secondary">
            Cancel
          </Button>
        </div>
      </div>
    )}
  </li>
);

export const TodosWorkspace = ({
  gateway: suppliedGateway,
  today: suppliedToday,
}: TodosWorkspaceProps) => {
  const [gateway] = useState(
    () => suppliedGateway ?? createBrowserTodosGateway()
  );
  const today = suppliedToday ?? localToday();
  const [state, setState] = useState<ListState>({ type: "loading" });
  const [items, setItems] = useState<TodoItemOutput[]>([]);
  const [newDraft, setNewDraft] = useState<Draft>(EMPTY_DRAFT);
  const [adding, setAdding] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [editing, setEditing] = useState<Readonly<{
    id: string;
    draft: Draft;
  }> | null>(null);
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());
  // Each row tracks its own request so one finishing never unlocks another.
  const markBusy = (id: string, busy: boolean): void => {
    setBusyIds((current) => {
      const next = new Set(current);
      if (busy) next.add(id);
      else next.delete(id);
      return next;
    });
  };
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [showDone, setShowDone] = useState(true);

  const load = useCallback(async () => {
    setState({ type: "loading" });
    try {
      setItems(sortTodos(await gateway.list()));
      return setState({ type: "ready" });
    } catch (error) {
      return setState({ message: describeTodoFailure(error), type: "error" });
    }
  }, [gateway]);

  useEffect(() => {
    void load();
    return;
  }, [load]);

  const apply = (item: TodoItemOutput): void => {
    setItems((current) => upsertTodo(current, item));
  };

  const add = async (): Promise<void> => {
    const fields = draftFields(newDraft);
    if (fields.title === "") {
      setFeedback("Enter a title.");
      return;
    }
    setAdding(true);
    try {
      const item = await gateway.create(fields);
      apply(item);
      setNewDraft(EMPTY_DRAFT);
      setFeedback(`Added "${item.title}"`);
    } catch (error) {
      setFeedback(describeTodoFailure(error));
    } finally {
      setAdding(false);
    }
  };

  const save = async (
    target: Readonly<{ id: string; draft: Draft }>
  ): Promise<void> => {
    const fields = draftFields(target.draft);
    if (fields.title === "") {
      setFeedback("Enter a title.");
      return;
    }
    markBusy(target.id, true);
    try {
      const item = await gateway.update(target.id, fields);
      apply(item);
      setEditing(null);
      setFeedback(`Saved "${item.title}"`);
    } catch (error) {
      setFeedback(describeTodoFailure(error));
    } finally {
      markBusy(target.id, false);
    }
  };

  const toggle = async (item: TodoItemOutput): Promise<void> => {
    markBusy(item.id, true);
    try {
      const next = await gateway.update(item.id, {
        status: item.status === "open" ? "done" : "open",
      });
      apply(next);
      setFeedback(
        next.status === "done"
          ? `Done: "${next.title}"`
          : `Reopened "${next.title}"`
      );
    } catch (error) {
      setFeedback(describeTodoFailure(error));
    } finally {
      markBusy(item.id, false);
    }
  };

  const remove = async (item: TodoItemOutput): Promise<void> => {
    setConfirmRemoveId(null);
    markBusy(item.id, true);
    try {
      await gateway.remove(item.id);
      setItems((current) => current.filter((row) => row.id !== item.id));
      setFeedback(`Deleted "${item.title}"`);
    } catch (error) {
      setFeedback(describeTodoFailure(error));
    } finally {
      markBusy(item.id, false);
    }
  };

  const tags = allTags(items);
  // A tag that no row carries any more stops filtering, so the list never gets stuck empty.
  const activeTag =
    tagFilter !== null && tags.includes(tagFilter) ? tagFilter : null;
  const visible = items.filter(
    (item) =>
      (activeTag === null || item.tags.includes(activeTag)) &&
      (showDone || item.status === "open")
  );
  const openCount = items.filter((item) => item.status === "open").length;

  return (
    <div className="space-y-6">
      {state.type === "ready" ? (
        <KpiRow label="To-do summary">
          <KpiCard
            hint="Still to do"
            icon={<ListTodo />}
            label="Open"
            value={openCount}
          />
          <KpiCard
            hint="Open and past the due date"
            icon={<CalendarClock />}
            label="Overdue"
            value={items.filter((item) => isOverdue(item, today)).length}
          />
          <KpiCard
            hint="Marked done"
            icon={<CircleCheck />}
            label="Done"
            value={items.length - openCount}
          />
        </KpiRow>
      ) : null}
      <Panel headingId="todos-add-heading" title="Add a to-do">
        <div className="space-y-3">
          <DraftForm
            draft={newDraft}
            idPrefix="todo-new"
            onChange={setNewDraft}
          />
          <Button disabled={adding} onClick={() => void add()} type="button">
            <Plus aria-hidden="true" className="size-4" />
            Add to-do
          </Button>
        </div>
      </Panel>

      <div aria-live="polite" className="min-h-5 text-sm" role="status">
        {feedback}
      </div>

      {state.type === "loading" ? (
        <p aria-busy="true" className="text-muted-foreground text-sm">
          Loading to-dos…
        </p>
      ) : state.type === "error" ? (
        <div className="space-y-2" role="alert">
          <p className="text-sm">{state.message}</p>
          <Button onClick={() => void load()} type="button" variant="secondary">
            Retry
          </Button>
        </div>
      ) : (
        <Panel
          actions={
            <label className="inline-flex min-h-11 items-center gap-1 text-muted-foreground text-xs">
              <input
                checked={showDone}
                onChange={(event) => setShowDone(event.target.checked)}
                type="checkbox"
              />
              Show done
            </label>
          }
          contentClassName="space-y-3"
          headingId="todos-list-heading"
          title={`${openCount} open · ${items.length - openCount} done`}
        >
          {tags.length > 0 && (
            <nav
              aria-label="Filter by tag"
              className="flex flex-wrap gap-1"
              data-click-private=""
            >
              <Button
                aria-pressed={activeTag === null}
                onClick={() => setTagFilter(null)}
                size="sm"
                type="button"
                variant={activeTag === null ? "default" : "secondary"}
              >
                All
              </Button>
              {tags.map((tag) => (
                <Button
                  aria-pressed={activeTag === tag}
                  key={tag}
                  onClick={() => setTagFilter(tag)}
                  size="sm"
                  type="button"
                  variant={activeTag === tag ? "default" : "secondary"}
                >
                  #{tag}
                </Button>
              ))}
            </nav>
          )}
          {visible.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              {items.length === 0
                ? "No to-dos. Add one above."
                : "No to-dos match this filter."}
            </p>
          ) : (
            <ul aria-label="To-dos" className="space-y-2" data-click-private="">
              {visible.map((item) => (
                <TodoRow
                  busy={busyIds.has(item.id)}
                  confirmingRemove={confirmRemoveId === item.id}
                  editDraft={
                    editing !== null && editing.id === item.id
                      ? editing.draft
                      : null
                  }
                  item={item}
                  key={item.id}
                  onCancelEdit={() => setEditing(null)}
                  onCancelRemove={() => setConfirmRemoveId(null)}
                  onDraftChange={(draft) => setEditing({ draft, id: item.id })}
                  onEdit={() => {
                    setConfirmRemoveId(null);
                    return setEditing({
                      draft: {
                        dueDate: item.dueDate ?? "",
                        note: item.note ?? "",
                        sourceUrl: item.sourceUrl ?? "",
                        tags: item.tags.join(", "),
                        title: item.title,
                      },
                      id: item.id,
                    });
                  }}
                  onRemove={() => void remove(item)}
                  onRequestRemove={() => setConfirmRemoveId(item.id)}
                  onSave={(draft) => void save({ draft, id: item.id })}
                  onToggle={() => void toggle(item)}
                  overdue={isOverdue(item, today)}
                />
              ))}
            </ul>
          )}
        </Panel>
      )}
    </div>
  );
};
