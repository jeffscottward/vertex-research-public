"use client";

import { alertTitleClassName, alertVariants, Button } from "@darkfactory/ui";

import {
  createContext,
  useContext,
  useEffect,
  useId,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  createReadResource,
  type ReadState,
} from "../../components/research/read-resource.ts";
import {
  useResearchReadScope,
  ResearchScopedWorkspace,
} from "../../components/research/read-scope.tsx";
import {
  ResearchHeading,
  ReadNotice,
} from "../../components/research/research-views.tsx";
import { VertexReadError } from "../../components/research/vertex-client.ts";
import type { ExperienceScope, ExperienceServices } from "./ports.ts";
import { guardExperienceServices } from "./guards.ts";
import "./experience.css";

const unavailable = (): Promise<never> =>
  Promise.reject(new VertexReadError("unavailable"));
export const createUnavailableExperienceServices = (): ExperienceServices => ({
  reads: {
    scopes: unavailable,
    gateways: unavailable,
    portfolio: unavailable,
    continuity: unavailable,
    inbox: unavailable,
    strategies: unavailable,
    dossier: unavailable,
    agents: unavailable,
    agent: unavailable,
    audit: unavailable,
    gateway: unavailable,
  },
  reviews: null,
  jobs: null,
  researchChat: null,
});
const ServicesContext = createContext<ExperienceServices | null>(null);
const ServicesProvider = ServicesContext.Provider;
export const ExperienceProvider = ({
  services,
  children,
}: {
  readonly services: ExperienceServices;
  readonly children: ReactNode;
}) => <ServicesProvider value={services}>{children}</ServicesProvider>;
export const useExperienceServices = (): ExperienceServices => {
  const supplied = useContext(ServicesContext);
  const [disabled] = useState(createUnavailableExperienceServices);
  return useMemo(
    () => (supplied === null ? disabled : guardExperienceServices(supplied)),
    [supplied, disabled]
  );
};

// Pass stable service methods directly. Each input/scope transition aborts and clears.
// The existing scope handles session expiry, logout, and late asynchronous deliveries.
export const useExperienceResource = <Input, Value>(
  read: (input: Input, signal: AbortSignal) => Promise<Value>
) => {
  const scope = useResearchReadScope();
  const resource = useMemo(
    () =>
      createReadResource<Input, Value>(
        (input, signal) => {
          if (scope === null) throw new VertexReadError("suspended");
          return read(input, signal);
        },
        12_000,
        scope ?? undefined
      ),
    [read, scope]
  );
  const state = useSyncExternalStore(
    resource.subscribe,
    resource.getSnapshot,
    resource.getSnapshot
  );
  useEffect(() => () => resource.clear(), [resource]);
  return { resource, state };
};

export const ExperienceFrame = ({
  title,
  children,
  level = 1,
}: {
  readonly title: string;
  readonly children: ReactNode;
  readonly level?: 1 | 2;
}) => (
  <div className="vx-experience">
    <ResearchHeading level={level} title={title} />
    <ResearchScopedWorkspace>{children}</ResearchScopedWorkspace>
  </div>
);

export const ResourcePanel = <Value,>({
  state,
  title,
  retry,
  children,
  action = false,
}: {
  readonly state: ReadState<Value>;
  readonly title: string;
  readonly retry?: () => void;
  readonly children: (value: Value) => ReactNode;
  readonly action?: boolean;
}) => {
  if (state.type === "ready") return children(state.value);
  if (state.type === "idle")
    return <ReadNotice title={`No ${title.toLowerCase()} selected`} />;
  if (state.type === "loading")
    return (
      <ReadNotice
        title={
          action
            ? "Waiting for server acknowledgement"
            : `Reading ${title.toLowerCase()}`
        }
        loading
      />
    );
  return (
    <section className={alertVariants({ variant: "destructive" })} role="alert">
      <h2 className={alertTitleClassName}>{state.failure.title}</h2>
      <p>{state.failure.detail}</p>
      {action ? (
        <p>
          The request outcome may be unknown after a timeout or disconnect.
          Inspect Agents & runs or Audit before retrying. A stopped browser
          request does not cancel a server job.
        </p>
      ) : null}
      {state.failure.kind === "unauthorized" ||
      state.failure.kind === "suspended" ? (
        <a className="vx-text-link" href="/dashboard">
          Verify the workspace session
        </a>
      ) : state.failure.kind === "denied" ? (
        <a className="vx-text-link" href="/account">
          Review account access
        </a>
      ) : !action && retry !== undefined ? (
        <Button variant="outline" type="button" onClick={retry}>
          Retry read
        </Button>
      ) : null}
    </section>
  );
};

const ENVIRONMENT_LABEL: Readonly<
  Record<ExperienceScope["environment"], string>
> = {
  research: "Research — no live NAV",
  paper: "Paper — simulation observations",
  live: "Live — observations only",
};
const scopeKey = (scope: ExperienceScope): string =>
  `${scope.accountAlias}/${scope.environment}`;

/**
 * Lists the account scopes this session may read and selects one, so a page
 * shows its data without typing (owner rule 2026-10-30): the first scope that
 * `prefer` accepts, else the first scope. With several scopes the person can
 * switch between them; nothing is typed.
 */
export const ScopeChooser = ({
  onSelect,
  onRetire,
  label = "Account scope",
  prefer,
}: {
  readonly onSelect: (scope: ExperienceScope) => void;
  readonly onRetire: () => void;
  readonly label?: string;
  readonly prefer?: (scope: ExperienceScope) => boolean;
}) => {
  const services = useExperienceServices();
  const { resource, state } = useExperienceResource(services.reads.scopes);
  const [selected, setSelected] = useState<string | null>(null);
  const id = useId();
  useEffect(() => {
    void resource.load(undefined);
    return;
  }, [resource]);
  const scopes = state.type === "ready" ? state.value : null;
  useEffect(() => {
    if (scopes === null) return;
    if (scopes.some((scope) => scopeKey(scope) === selected)) return;
    const first =
      (prefer === undefined ? undefined : scopes.find(prefer)) ?? scopes[0];
    if (first === undefined) return;
    setSelected(scopeKey(first));
    return onSelect(first);
  }, [scopes, selected, onSelect, prefer]);
  if (state.type === "idle" || state.type === "loading")
    return <ReadNotice title="Loading your account scopes" loading />;
  if (state.type === "error")
    return (
      <ResourcePanel
        state={state}
        title={label}
        retry={() => void resource.load(undefined)}
      >
        {() => null}
      </ResourcePanel>
    );
  if (state.value.length === 0)
    return (
      <EmptyCollection title="No account scopes yet">
        This page lists records for each account scope you may read. None is
        visible to this account right now. When a research, paper or live scope
        is granted and readable, its records appear here without any typing.
      </EmptyCollection>
    );
  if (state.value.length === 1)
    return (
      <p className="py-2 font-semibold text-sm leading-[1.7] [overflow-wrap:anywhere]">
        <span className="sr-only">{label}: </span>
        {state.value[0]?.accountAlias}
        {" / "}
        {state.value[0]?.environment}
        {" · no execution authority"}
      </p>
    );
  return (
    <div className="my-6 grid @min-[42rem]:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-end gap-4 border-border-strong border-y py-6 [&>:is(p,[role=alert])]:col-span-full">
      <label htmlFor={`${id}-scope`}>{label}</label>
      <select
        id={`${id}-scope`}
        name="scope"
        value={selected ?? ""}
        onChange={(event) => {
          const next = state.value.find(
            (scope) => scopeKey(scope) === event.target.value
          );
          if (next === undefined) return;
          onRetire();
          setSelected(scopeKey(next));
          return onSelect(next);
        }}
      >
        {state.value.map((scope) => (
          <option key={scopeKey(scope)} value={scopeKey(scope)}>
            {scope.accountAlias} — {ENVIRONMENT_LABEL[scope.environment]}
          </option>
        ))}
      </select>
    </div>
  );
};

export const ScopeLabel = ({ scope }: { readonly scope: ExperienceScope }) => (
  <p className="py-2 font-semibold text-sm leading-[1.7] [overflow-wrap:anywhere]">
    {scope.accountAlias}
    {" / "}
    {scope.environment}
    {" · no execution authority"}
  </p>
);

export const EmptyCollection = ({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) => <ReadNotice title={title}>{children}</ReadNotice>;
