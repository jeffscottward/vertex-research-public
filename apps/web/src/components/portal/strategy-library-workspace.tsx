"use client";

import {
  STRATEGY_KIND_VALUES,
  STRATEGY_SORT_VALUES,
  STRATEGY_SOURCE_TAGS,
  STRATEGY_STATUS_VALUES,
  type StrategyGetOutput,
  type StrategyKindValue,
  type StrategySortValue,
  type StrategyStatusValue,
  type StrategySummaryOutput,
} from "@darkfactory/api";
import {
  Button,
  Input,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@darkfactory/ui";
import { LayoutGrid, Plus, Rows3, Star } from "lucide-react";
import {
  type MouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";

import {
  createBrowserStrategyLibraryGateway,
  describeAgentOpsFailure,
  formatTimestamp,
  InfoGlyph,
  isOperatorAccessDenied,
  OperatorAccessRequired,
  type StrategyLibraryGateway,
} from "./agent-ops-client.tsx";
import { formatPercent } from "./backtests-workspace.tsx";
import {
  StrategyBadges,
  StrategyDetail,
  StrategyLinks,
} from "./strategy-library-detail.tsx";
import {
  formatRatio,
  formatSignedPercent,
  groupBySection,
  isStrategyTab,
  STRATEGY_KIND_LABELS,
  STRATEGY_SORT_LABELS,
  STRATEGY_STATUS_LABELS,
  type StrategyTab,
} from "./strategy-library-model.ts";
import { selectClass } from "./strategy-param-field.tsx";

export interface StrategyLibraryWorkspaceProps {
  readonly gateway?: StrategyLibraryGateway;
  // undefined reads ?id= from the address bar; null opens nothing.
  readonly initialStrategyId?: string | null;
}

type ListState =
  | Readonly<{ type: "loading" }>
  | Readonly<{ type: "ready"; rows: StrategySummaryOutput[] }>
  | Readonly<{ type: "error"; message: string }>
  | Readonly<{ type: "forbidden" }>;

type DetailState =
  | Readonly<{ type: "closed" }>
  | Readonly<{ type: "loading"; id: string }>
  | Readonly<{ type: "ready"; detail: StrategyGetOutput }>
  | Readonly<{ type: "error"; id: string; message: string }>;

type ViewMode = "rows" | "cards";

export const SEARCH_DEBOUNCE_MS = 250;

const describeStrategyFailure = (error: unknown): string => {
  if (
    typeof error === "object" &&
    error !== null &&
    Reflect.get(error, "code") === "STORAGE_ERROR"
  ) {
    return "Strategy library storage unavailable (503). Apply migration 0019 if the tables are missing.";
  }
  return describeAgentOpsFailure(error);
};

const readInitialId = (): string | null => {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get("id");
};

const readInitialTab = (): StrategyTab => {
  if (typeof window === "undefined") return "overview";
  const value = new URLSearchParams(window.location.search).get("tab");
  return isStrategyTab(value) ? value : "overview";
};

// Keeps ?id= and ?tab= in the address bar so a detail view can be linked and restored.
const writeLocation = (id: string | null, tab: StrategyTab): void => {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (id === null) {
    url.searchParams.delete("id");
    url.searchParams.delete("tab");
  } else {
    url.searchParams.set("id", id);
    if (tab === "overview") {
      url.searchParams.delete("tab");
    } else url.searchParams.set("tab", tab);
  }
  window.history.replaceState(
    window.history.state,
    "",
    `${url.pathname}${url.search}${url.hash}`
  );
};

const toggleClass = (pressed: boolean): string => {
  return `inline-flex min-h-11 items-center gap-2 rounded-md border px-3 text-sm ${pressed ? "border-primary bg-primary/10 text-foreground" : "border-border text-muted-foreground hover:text-foreground"}`;
};

const FavoriteButton = ({
  row,
  busy,
  onToggle,
}: {
  readonly row: StrategySummaryOutput;
  readonly busy: boolean;
  readonly onToggle: (row: StrategySummaryOutput) => void;
}) => (
  <button
    aria-label={`Favorite ${row.name}`}
    aria-pressed={row.favorite}
    className="inline-flex size-11 items-center justify-center rounded-md text-muted-foreground hover:text-foreground disabled:opacity-50"
    data-favorite={row.favorite ? "true" : "false"}
    disabled={busy}
    onClick={() => onToggle(row)}
    type="button"
  >
    <Star
      aria-hidden="true"
      className={`size-5 ${row.favorite ? "fill-current text-primary" : ""}`}
    />
  </button>
);

const NameLink = ({
  row,
  onOpen,
}: {
  readonly row: StrategySummaryOutput;
  readonly onOpen: (id: string) => void;
}) => (
  <a
    className="inline-flex min-h-11 items-center font-medium underline-offset-2 hover:underline"
    href={`/library?id=${encodeURIComponent(row.id)}`}
    onClick={(event: MouseEvent<HTMLAnchorElement>) => {
      if (
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.button !== 0
      )
        return;
      event.preventDefault();
      return onOpen(row.id);
    }}
  >
    {row.name}
  </a>
);

const latestText = (row: StrategySummaryOutput) => ({
  maxDrawdown: formatPercent(row.latestBacktest?.maxDrawdown ?? null),
  sharpe: formatRatio(row.latestBacktest?.sharpe),
  totalReturn: formatSignedPercent(row.latestBacktest?.totalReturn),
});

const RowsView = ({
  rows,
  label,
  busy,
  onToggle,
  onOpen,
}: {
  readonly rows: readonly StrategySummaryOutput[];
  readonly label: string;
  readonly busy: boolean;
  readonly onToggle: (row: StrategySummaryOutput) => void;
  readonly onOpen: (id: string) => void;
}) => (
  <div className="relative overflow-x-auto">
    <Table
      className="w-full min-w-[60rem] text-sm"
      containerClassName="overflow-visible"
      data-click-private=""
    >
      <TableCaption className="sr-only">{label} strategies</TableCaption>
      <TableHeader>
        <TableRow className="border-border border-b text-left text-muted-foreground text-xs">
          <TableHead
            className="w-11 py-1 font-normal text-muted-foreground"
            scope="col"
          >
            <span className="sr-only">Favorite</span>
          </TableHead>
          <TableHead
            className="py-1 pr-3 font-normal text-muted-foreground"
            scope="col"
          >
            Name
          </TableHead>
          <TableHead
            className="py-1 pr-3 font-normal text-muted-foreground"
            scope="col"
          >
            Status
          </TableHead>
          <TableHead
            className="py-1 pr-3 font-normal text-muted-foreground"
            scope="col"
          >
            Kind
          </TableHead>
          <TableHead
            className="py-1 pr-3 font-normal text-muted-foreground"
            scope="col"
          >
            Tags
          </TableHead>
          <TableHead
            className="py-1 pr-3 text-right font-normal text-muted-foreground"
            scope="col"
          >
            Sharpe
            <InfoGlyph text="Derived by the server from the latest linked backtest's reported equity (annualized, risk-free rate 0)." />
          </TableHead>
          <TableHead
            className="py-1 pr-3 text-right font-normal text-muted-foreground"
            scope="col"
          >
            Return
            <InfoGlyph text="Total return of the latest linked backtest's reported equity." />
          </TableHead>
          <TableHead
            className="py-1 pr-3 text-right font-normal text-muted-foreground"
            scope="col"
          >
            Max DD
          </TableHead>
          <TableHead
            className="py-1 pr-3 text-right font-normal text-muted-foreground"
            scope="col"
          >
            Backtests
          </TableHead>
          <TableHead
            className="py-1 pr-3 text-right font-normal text-muted-foreground"
            scope="col"
          >
            Presets
          </TableHead>
          <TableHead
            className="py-1 pr-3 font-normal text-muted-foreground"
            scope="col"
          >
            Updated (UTC)
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => {
          return (
            <TableRow
              className="border-border border-b align-middle"
              data-strategy-row={row.id}
              key={row.id}
            >
              <TableCell className="whitespace-normal py-0">
                <FavoriteButton busy={busy} onToggle={onToggle} row={row} />
              </TableCell>
              <TableHead
                className="whitespace-normal py-0 pr-3 font-normal"
                scope="row"
              >
                <span className="flex flex-wrap items-center gap-x-2">
                  <NameLink onOpen={onOpen} row={row} />
                  <StrategyBadges strategy={row} />
                </span>
              </TableHead>
              <TableCell
                className="whitespace-normal py-1 pr-3 text-xs"
                data-col="status"
              >
                {STRATEGY_STATUS_LABELS[row.status]}
              </TableCell>
              <TableCell className="whitespace-normal py-1 pr-3 text-xs">
                {STRATEGY_KIND_LABELS[row.kind] ?? row.kind}
              </TableCell>
              <TableCell className="whitespace-normal py-1 pr-3 text-xs">
                {row.tags.length === 0 ? "—" : row.tags.join(", ")}
              </TableCell>
              <TableCell
                className="whitespace-normal py-1 pr-3 text-right font-mono text-xs"
                data-col="sharpe"
              >
                {latestText(row).sharpe}
              </TableCell>
              <TableCell
                className="whitespace-normal py-1 pr-3 text-right font-mono text-xs"
                data-col="return"
              >
                {latestText(row).totalReturn}
              </TableCell>
              <TableCell className="whitespace-normal py-1 pr-3 text-right font-mono text-xs">
                {latestText(row).maxDrawdown}
              </TableCell>
              <TableCell className="whitespace-normal py-1 pr-3 text-right font-mono text-xs">
                {row.backtestCount}
              </TableCell>
              <TableCell className="whitespace-normal py-1 pr-3 text-right font-mono text-xs">
                {row.presetCount}
              </TableCell>
              <TableCell className="whitespace-normal py-1 pr-3 font-mono text-muted-foreground text-xs">
                {formatTimestamp(row.updatedAt)}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  </div>
);

const CardsView = ({
  rows,
  busy,
  onToggle,
  onOpen,
}: {
  readonly rows: readonly StrategySummaryOutput[];
  readonly busy: boolean;
  readonly onToggle: (row: StrategySummaryOutput) => void;
  readonly onOpen: (id: string) => void;
}) => (
  <ul
    className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3"
    data-click-private=""
  >
    {rows.map((row) => {
      return (
        <li
          className="space-y-1 rounded-md border border-border p-3"
          data-strategy-card={row.id}
          key={row.id}
        >
          <div className="flex items-start justify-between gap-2">
            <NameLink onOpen={onOpen} row={row} />
            <FavoriteButton busy={busy} onToggle={onToggle} row={row} />
          </div>
          <StrategyBadges strategy={row} />
          <p className="text-muted-foreground text-xs">
            {STRATEGY_STATUS_LABELS[row.status]} ·{" "}
            {STRATEGY_KIND_LABELS[row.kind] ?? row.kind}
            {row.tags.length === 0 ? "" : ` · ${row.tags.join(", ")}`}
          </p>
          <p className="font-mono text-xs">
            Sharpe {latestText(row).sharpe} · return{" "}
            {latestText(row).totalReturn} · {row.backtestCount} backtests ·{" "}
            {row.presetCount} presets
          </p>
          {row.description === null ? null : (
            <p className="line-clamp-2 text-muted-foreground text-xs">
              {row.description}
            </p>
          )}
          <StrategyLinks description={row.description} />
        </li>
      );
    })}
  </ul>
);

const CreateForm = ({
  gateway,
  onCreated,
}: {
  readonly gateway: StrategyLibraryGateway;
  readonly onCreated: (id: string) => Promise<void>;
}) => {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<StrategyKindValue>("python");
  const [description, setDescription] = useState("");
  const [section, setSection] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{
    text: string;
    tone: "status" | "alert";
  }>({ text: "", tone: "status" });

  const create = async (): Promise<void> => {
    if (name.trim() === "") {
      setMessage({ text: "Name is required.", tone: "alert" });
      return;
    }
    setBusy(true);
    try {
      const created = await gateway.create({
        description,
        kind,
        name,
        section,
      });
      setName("");
      setDescription("");
      setSection("");
      setMessage({ text: `Created ${created.name}.`, tone: "status" });
      await onCreated(created.id);
    } catch (error) {
      setMessage({ text: describeStrategyFailure(error), tone: "alert" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="strategy-create-heading" className="space-y-2">
      <h2 className="font-medium text-sm" id="strategy-create-heading">
        New strategy
        <InfoGlyph text="The slug is derived from the name and must be unique. Status starts as Idea." />
      </h2>
      <form
        className="grid gap-2 sm:grid-cols-2 lg:grid-cols-[2fr_1fr_2fr_1fr_auto] lg:items-end"
        data-strategy-create=""
        onSubmit={(event) => {
          event.preventDefault();
          return void create();
        }}
      >
        <label className="text-xs">
          Name
          <Input
            aria-label="Strategy name"
            maxLength={200}
            onChange={(event) => setName(event.target.value)}
            value={name}
          />
        </label>
        <label className="text-xs">
          Kind
          <select
            aria-label="Strategy kind"
            className={selectClass}
            onChange={(event) =>
              setKind(event.target.value as StrategyKindValue)
            }
            value={kind}
          >
            {STRATEGY_KIND_VALUES.map((value) => {
              return (
                <option key={value} value={value}>
                  {STRATEGY_KIND_LABELS[value]}
                </option>
              );
            })}
          </select>
        </label>
        <label className="text-xs">
          Description
          <Input
            aria-label="Strategy description"
            maxLength={2000}
            onChange={(event) => setDescription(event.target.value)}
            value={description}
          />
        </label>
        <label className="text-xs">
          Section
          <Input
            aria-label="Strategy section"
            maxLength={80}
            onChange={(event) => setSection(event.target.value)}
            value={section}
          />
        </label>
        <Button disabled={busy} type="submit">
          <Plus aria-hidden="true" className="size-4" />
          Create strategy
        </Button>
      </form>
      {message.text === "" ? null : (
        <p
          className={`text-sm ${message.tone === "alert" ? "text-destructive" : ""}`}
          role={message.tone}
        >
          {message.text}
        </p>
      )}
    </section>
  );
};

export const StrategyLibraryWorkspace = ({
  gateway: suppliedGateway,
  initialStrategyId,
}: StrategyLibraryWorkspaceProps) => {
  const [gateway] = useState(
    () => suppliedGateway ?? createBrowserStrategyLibraryGateway()
  );
  const [state, setState] = useState<ListState>({ type: "loading" });
  const [detail, setDetail] = useState<DetailState>({ type: "closed" });
  const [tab, setTab] = useState<StrategyTab>(readInitialTab);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StrategyStatusValue | "">("");
  const [source, setSource] = useState("");
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [sort, setSort] = useState<StrategySortValue>("updated");
  const [view, setView] = useState<ViewMode>("rows");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search]);

  const load = useCallback(async () => {
    try {
      const rows = await gateway.list({
        ...(query === "" ? {} : { search: query }),
        ...(status === "" ? {} : { status }),
        ...(source === "" ? {} : { tag: source }),
        ...(favoritesOnly ? { favorite: true } : {}),
        sort,
      });
      return setState({ rows, type: "ready" });
    } catch (error) {
      return setState(
        isOperatorAccessDenied(error)
          ? { type: "forbidden" }
          : { message: describeStrategyFailure(error), type: "error" }
      );
    }
  }, [gateway, query, status, source, favoritesOnly, sort]);

  useEffect(() => {
    void load();
    return;
  }, [load]);

  const open = useCallback(
    async (id: string, fromLink = false) => {
      if (!fromLink) {
        setTab("overview");
        writeLocation(id, "overview");
      }
      setDetail({ id, type: "loading" });
      try {
        return setDetail({ detail: await gateway.get(id), type: "ready" });
      } catch (error) {
        return setDetail({
          id,
          message: describeStrategyFailure(error),
          type: "error",
        });
      }
    },
    [gateway]
  );

  useEffect(() => {
    const id =
      initialStrategyId === undefined ? readInitialId() : initialStrategyId;
    if (id !== null && id !== "") void open(id, true);
    return;
  }, [open, initialStrategyId]);

  const close = useCallback(() => {
    setDetail({ type: "closed" });
    setTab("overview");
    return writeLocation(null, "overview");
  }, []);

  const selectTab = useCallback(
    (next: StrategyTab) => {
      setTab(next);
      if (detail.type === "ready")
        return writeLocation(detail.detail.strategy.id, next);
      return;
    },
    [detail]
  );

  const refreshDetail = useCallback(async (): Promise<void> => {
    if (detail.type !== "ready") return;
    try {
      setDetail({
        detail: await gateway.get(detail.detail.strategy.id),
        type: "ready",
      });
    } catch (error) {
      setDetail({
        id: detail.detail.strategy.id,
        message: describeStrategyFailure(error),
        type: "error",
      });
    }
    await load();
  }, [detail, gateway, load]);

  const toggleFavorite = useCallback(
    async (row: StrategySummaryOutput): Promise<void> => {
      setBusy(true);
      try {
        const updated = await gateway.update({
          favorite: !row.favorite,
          id: row.id,
        });
        setFeedback(
          updated.favorite
            ? `Favorited ${updated.name}.`
            : `Unfavorited ${updated.name}.`
        );
        await load();
        if (detail.type === "ready" && detail.detail.strategy.id === row.id) {
          setDetail({ detail: await gateway.get(row.id), type: "ready" });
        }
      } catch (error) {
        setFeedback(describeStrategyFailure(error));
      } finally {
        setBusy(false);
      }
    },
    [detail, gateway, load]
  );

  const created = useCallback(
    async (id: string): Promise<void> => {
      await load();
      await open(id);
    },
    [load, open]
  );

  const groups = useMemo(
    () => (state.type === "ready" ? groupBySection(state.rows) : []),
    [state]
  );

  if (state.type === "forbidden")
    return <OperatorAccessRequired feature="strategy-library" />;

  return (
    <div className="space-y-6">
      {detail.type === "loading" ? (
        <p aria-busy="true" className="text-muted-foreground text-sm">
          Loading strategy…
        </p>
      ) : detail.type === "error" ? (
        <div className="space-y-2" role="alert">
          <p className="text-sm">{detail.message}</p>
          <Button onClick={close} type="button" variant="secondary">
            Close
          </Button>
        </div>
      ) : detail.type === "ready" ? (
        <StrategyDetail
          describeFailure={describeStrategyFailure}
          detail={detail.detail}
          gateway={gateway}
          onChanged={refreshDetail}
          onClose={close}
          onTab={selectTab}
          tab={tab}
        />
      ) : null}
      <CreateForm gateway={gateway} onCreated={created} />
      <section aria-labelledby="strategy-board-heading" className="space-y-3">
        <h2 className="sr-only" id="strategy-board-heading">
          Strategies
        </h2>
        <div
          className="flex flex-wrap items-end gap-2"
          data-strategy-toolbar=""
        >
          <label className="min-w-56 flex-1 text-xs">
            Search
            <Input
              aria-label="Search strategies"
              maxLength={100}
              onChange={(event) => setSearch(event.target.value)}
              type="search"
              value={search}
            />
          </label>
          <label className="w-44 text-xs">
            Status
            <select
              aria-label="Status filter"
              className={selectClass}
              onChange={(event) =>
                setStatus(event.target.value as StrategyStatusValue | "")
              }
              value={status}
            >
              <option value="">All statuses</option>
              {STRATEGY_STATUS_VALUES.map((value) => {
                return (
                  <option key={value} value={value}>
                    {STRATEGY_STATUS_LABELS[value]}
                  </option>
                );
              })}
            </select>
          </label>
          <label className="w-48 text-xs">
            Source
            <select
              aria-label="Source filter"
              className={selectClass}
              onChange={(event) => setSource(event.target.value)}
              value={source}
            >
              <option value="">All sources</option>
              {Object.entries(STRATEGY_SOURCE_TAGS).map(([tag, label]) => {
                return (
                  <option key={tag} value={tag}>
                    {label}
                  </option>
                );
              })}
            </select>
          </label>
          <label className="w-56 text-xs">
            Sort
            <select
              aria-label="Sort strategies"
              className={selectClass}
              onChange={(event) =>
                setSort(event.target.value as StrategySortValue)
              }
              value={sort}
            >
              {STRATEGY_SORT_VALUES.map((value) => {
                return (
                  <option key={value} value={value}>
                    {STRATEGY_SORT_LABELS[value]}
                  </option>
                );
              })}
            </select>
          </label>
          <button
            aria-pressed={favoritesOnly}
            className={toggleClass(favoritesOnly)}
            onClick={() => setFavoritesOnly((current) => !current)}
            type="button"
          >
            <Star
              aria-hidden="true"
              className={`size-4 ${favoritesOnly ? "fill-current" : ""}`}
            />
            Favorites only
          </button>
          <div aria-label="View" className="flex gap-1" role="group">
            <button
              aria-pressed={view === "rows"}
              className={toggleClass(view === "rows")}
              onClick={() => setView("rows")}
              type="button"
            >
              <Rows3 aria-hidden="true" className="size-4" />
              Rows
            </button>
            <button
              aria-pressed={view === "cards"}
              className={toggleClass(view === "cards")}
              onClick={() => setView("cards")}
              type="button"
            >
              <LayoutGrid aria-hidden="true" className="size-4" />
              Cards
            </button>
          </div>
        </div>
        <div aria-live="polite" className="min-h-5 text-sm" role="status">
          {feedback}
        </div>
        {state.type === "loading" ? (
          <p aria-busy="true" className="text-muted-foreground text-sm">
            Loading strategies…
          </p>
        ) : state.type === "error" ? (
          <div className="space-y-2" role="alert">
            <p className="text-sm">{state.message}</p>
            <Button
              onClick={() => void load()}
              type="button"
              variant="secondary"
            >
              Retry
            </Button>
          </div>
        ) : state.rows.length === 0 ? (
          <p className="text-muted-foreground text-sm">No strategies match.</p>
        ) : (
          <div className="space-y-5">
            {groups.map((group, index) => {
              return (
                <section
                  aria-labelledby={`strategy-section-${index}`}
                  className="space-y-2"
                  data-section={group.label}
                  key={group.key}
                >
                  <h3
                    className="font-medium text-sm"
                    id={`strategy-section-${index}`}
                  >
                    {group.label}{" "}
                    <span className="font-normal text-muted-foreground">
                      ({group.rows.length})
                    </span>
                  </h3>
                  {view === "rows" ? (
                    <RowsView
                      busy={busy}
                      label={group.label}
                      onOpen={(id) => void open(id)}
                      onToggle={(row) => void toggleFavorite(row)}
                      rows={group.rows}
                    />
                  ) : (
                    <CardsView
                      busy={busy}
                      onOpen={(id) => void open(id)}
                      onToggle={(row) => void toggleFavorite(row)}
                      rows={group.rows}
                    />
                  )}
                </section>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
};
