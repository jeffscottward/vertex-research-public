// What: Assistant side panel on every portal page: a right column from lg, a modal bottom sheet with a floating toggle below lg. One open state, shared with the topbar toggle, saved in the "vx.assistantPanel" cookie so the server renders it.
// Used by: apps/web/src/components/portal-shell.tsx.
// See: apps/web/src/components/portal/assistant-workspace.tsx (variant "panel"); apps/web/src/lib/assistant-panel-cookie.ts; apps/web/src/lib/portal-page-title.ts; apps/web/src/features/charts/chart-bus.ts (what the chart shows on /charts).
"use client";

import {
  type AssistantPageChart,
  AssistantPageChartSchema,
  type AssistantPageContext,
  AssistantPageContextSchema,
} from "@darkfactory/api";
import { Button, IconButton } from "@darkfactory/ui";
import { Maximize2, PanelRight, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { serializeAssistantPanelCookie } from "../../lib/assistant-panel-cookie.ts";
import {
  isNavigationItemActive,
  isRouteExposed,
} from "../../lib/navigation.ts";
import { portalPageTitle } from "../../lib/portal-page-title.ts";
import {
  type ChartContext,
  currentChartContext,
} from "../../features/charts/chart-bus.ts";
import { isChartsPath } from "./assistant-artifacts.tsx";
import type { AssistantGateway } from "./assistant-client.ts";
import { AssistantWorkspace } from "./assistant-workspace.tsx";

const ASSISTANT_PANEL_ID = "assistant-panel";
const ASSISTANT_HREF = "/assistant";
/** From lg the panel is a column beside the page; below it is a modal bottom sheet. */
export const ASSISTANT_PANEL_DOCKED_QUERY = "(min-width: 1024px)";

const mediaMatches = (query: string): boolean =>
  typeof window.matchMedia === "function" && window.matchMedia(query).matches;

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The page the panel sends as context; a pathname the contract does not accept sends none. */
export const assistantPageContext = (
  pathname: string
): AssistantPageContext | undefined => {
  const parsed = AssistantPageContextSchema.safeParse({
    path: pathname,
    title: portalPageTitle(pathname),
  });
  return parsed.success ? parsed.data : undefined;
};

/** What the chart workstation shows, as the contract's page chart; none when it does not fit. */
export const assistantPageChart = (
  chart: ChartContext | null
): AssistantPageChart | undefined => {
  if (chart === null) return undefined;
  const parsed = AssistantPageChartSchema.safeParse({
    bars: chart.bars,
    firstTimestamp: chart.firstTimestamp,
    lastClose: chart.lastClose,
    lastTimestamp: chart.lastTimestamp,
    symbol: chart.symbol.trim().toUpperCase(),
  });
  return parsed.success ? parsed.data : undefined;
};

// Read at send time: the chart publishes its context without rendering the panel.
const readPageChart = (): AssistantPageChart | undefined =>
  assistantPageChart(currentChartContext());

type AssistantPanelState = Readonly<{
  /** The operator may use the assistant and this is not the /assistant page itself. */
  shown: boolean;
  /** The operator may use the assistant (the chat stays mounted on /assistant, hidden). */
  available: boolean;
  open: boolean;
  /** Counts operator opens (clicks), so only those move focus into the sheet, not a saved open. */
  openRequests: number;
  setOpen: (open: boolean) => void;
}>;

const AssistantPanelContext = createContext<AssistantPanelState | null>(null);

const useAssistantPanel = (): AssistantPanelState => {
  const state = useContext(AssistantPanelContext);
  if (state === null)
    throw new Error("The assistant panel needs an AssistantPanelProvider.");
  return state;
};

export interface AssistantPanelProviderProps {
  readonly availableRoutes: readonly string[];
  readonly children: ReactNode;
  /** The saved choice the server read from the cookie; no cookie (undefined) means closed. */
  readonly initialOpen?: boolean | undefined;
}

/**
 * Owns the open state. The server render and the first client render use the saved cookie; without
 * one the panel is closed, and nothing changes it after paint. Only an operator choice is saved.
 * Closing returns focus to the control that opened the panel when focus was in the panel or its
 * backdrop (after the commit, so a control shown again on close can take it).
 */
export const AssistantPanelProvider = ({
  availableRoutes,
  children,
  initialOpen,
}: AssistantPanelProviderProps) => {
  const pathname = usePathname() ?? "";
  const available = isRouteExposed(ASSISTANT_HREF, availableRoutes);
  const shown =
    available && !isNavigationItemActive(pathname, { href: ASSISTANT_HREF });
  const [open, setOpenState] = useState(initialOpen ?? false);
  const [openRequests, setOpenRequests] = useState(0);
  const opener = useRef<HTMLElement | null>(null);
  const restoreFocus = useRef(false);
  useEffect(() => {
    if (open || !restoreFocus.current) return;
    restoreFocus.current = false;
    opener.current?.focus();
  }, [open]);
  const setOpen = useCallback((next: boolean) => {
    const focused = document.activeElement;
    if (next) {
      opener.current = focused instanceof HTMLElement ? focused : null;
      setOpenRequests((count) => count + 1);
    } else
      restoreFocus.current =
        focused === document.body ||
        focused?.closest(
          `#${ASSISTANT_PANEL_ID}, [data-assistant-panel-backdrop]`
        ) !== null;
    setOpenState(next);
    // biome-ignore lint/suspicious/noDocumentCookie: the Cookie Store API is unavailable in supported Firefox/Safari versions; the server reads this cookie to render the saved state.
    document.cookie = serializeAssistantPanelCookie(next);
  }, []);
  const state = useMemo(
    () => ({ available, open, openRequests, setOpen, shown }),
    [available, open, openRequests, setOpen, shown]
  );
  return (
    <AssistantPanelContext.Provider value={state}>
      {children}
    </AssistantPanelContext.Provider>
  );
};

/**
 * Topbar control next to the command palette, at every width (the only launcher, so nothing floats
 * over page content); absent where the panel is not offered.
 */
export const AssistantPanelToggle = () => {
  const panel = useAssistantPanel();
  if (!panel.shown) return null;
  return (
    <IconButton
      aria-controls={ASSISTANT_PANEL_ID}
      aria-label="Toggle assistant panel"
      aria-pressed={panel.open}
      onClick={() => panel.setOpen(!panel.open)}
    >
      <PanelRight aria-hidden="true" />
    </IconButton>
  );
};

export interface AssistantPanelProps {
  readonly gateway?: AssistantGateway;
}

/**
 * The dock. The chat mounts on the first open and then stays mounted (hidden while closed, and on
 * /assistant), so a streaming reply and the open thread survive closing and client navigation.
 */
export const AssistantPanel = ({ gateway }: AssistantPanelProps) => {
  const panel = useAssistantPanel();
  const pathname = usePathname() ?? "";
  const visible = panel.shown && panel.open;
  // A server render that is open mounts the chat at once (it shows its loading state).
  const [mounted, setMounted] = useState(visible);
  // Docked (a column) until the first effect measures the screen: the server cannot know it.
  const [docked, setDocked] = useState(true);
  const sheet = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const pageContext = useMemo(() => assistantPageContext(pathname), [pathname]);
  const { openRequests, setOpen } = panel;
  const modal = visible && !docked;
  const handledRequests = useRef(openRequests);
  useEffect(() => {
    if (visible) setMounted(true);
  }, [visible]);
  useEffect(() => {
    const measure = () => setDocked(mediaMatches(ASSISTANT_PANEL_DOCKED_QUERY));
    measure();
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(ASSISTANT_PANEL_DOCKED_QUERY);
    query.addEventListener("change", measure);
    return () => query.removeEventListener("change", measure);
  }, []);
  // An operator open moves focus into the sheet. A panel open from the saved cookie at load, or a
  // column that becomes the sheet when the window narrows, leaves focus where it is.
  useEffect(() => {
    if (openRequests === handledRequests.current) return;
    handledRequests.current = openRequests;
    if (modal) closeButton.current?.focus();
  }, [modal, openRequests]);
  // The sheet is modal: Tab stays inside (skipping hidden controls) and Escape closes it.
  useEffect(() => {
    const element = sheet.current;
    if (!modal || element === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === "Escape") return setOpen(false);
      if (event.key !== "Tab") return;
      const focusable = [
        ...element.querySelectorAll<HTMLElement>(FOCUSABLE),
      ].filter((node) => node.closest("[hidden]") === null);
      const first = focusable[0];
      const last = focusable.at(-1);
      const active = document.activeElement;
      const inside = element.contains(active);
      if (event.shiftKey && (!inside || active === first)) {
        event.preventDefault();
        return last?.focus();
      }
      if (!event.shiftKey && (!inside || active === last)) {
        event.preventDefault();
        return first?.focus();
      }
      return;
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [modal, setOpen]);
  if (!(panel.available && (panel.shown || mounted))) return null;
  return (
    <>
      {visible ? (
        <button
          aria-label="Dismiss assistant panel"
          className="fixed inset-0 z-overlay bg-black/50 lg:hidden"
          data-assistant-panel-backdrop=""
          onClick={() => setOpen(false)}
          tabIndex={-1}
          type="button"
        />
      ) : null}
      <aside
        aria-label="Assistant panel"
        className="fixed inset-x-0 bottom-0 z-popover flex h-[85dvh] flex-col rounded-t-xl border-sidebar-border border-t bg-sidebar text-sidebar-foreground shadow-lg lg:sticky lg:top-0 lg:z-auto lg:h-svh lg:w-88 lg:shrink-0 lg:self-start lg:rounded-none lg:border-t-0 lg:border-l lg:shadow-none 2xl:w-96"
        data-assistant-panel=""
        hidden={!visible}
        id={ASSISTANT_PANEL_ID}
        ref={sheet}
        // Below lg the open panel is a modal sheet; docked it stays a complementary landmark.
        {...(modal ? { "aria-modal": true, role: "dialog" } : {})}
      >
        <div className="flex min-h-12 shrink-0 items-center gap-1 border-sidebar-border border-b px-3">
          <h2 className="min-w-0 flex-1 truncate font-semibold text-sm">
            Assistant
          </h2>
          <Button asChild size="icon" variant="ghost">
            <Link
              aria-label="Open full assistant"
              href={ASSISTANT_HREF}
              prefetch={false}
            >
              <Maximize2 aria-hidden="true" />
            </Link>
          </Button>
          <IconButton
            aria-label="Close assistant panel"
            onClick={() => setOpen(false)}
            ref={closeButton}
          >
            <X aria-hidden="true" />
          </IconButton>
        </div>
        <div className="flex min-h-0 flex-1 flex-col px-3 pt-2 pb-3">
          {mounted ? (
            <AssistantWorkspace
              {...(gateway === undefined ? {} : { gateway })}
              {...(pageContext === undefined ? {} : { pageContext })}
              {...(isChartsPath(pathname) ? { pageChart: readPageChart } : {})}
              variant="panel"
            />
          ) : null}
        </div>
      </aside>
    </>
  );
};
