// What: UI lab pages: the index (every entry by group) and one entry rendered inside the lab frame.
// Used by: apps/web/src/app/lab/page.tsx, apps/web/src/app/lab/[entry]/page.tsx.
"use client";

import { EmptyState, PageHeader, Panel } from "@darkfactory/ui";

import { LAB_ENTRIES } from "./entries/index.ts";
import { LabFrame } from "./lab-frame.tsx";
import { readLabTheme, withLabParam } from "./params.ts";
import {
  findLabEntry,
  groupLabEntries,
  type LabEntry,
  labEntryHref,
} from "./registry.ts";

export interface LabIndexProps {
  readonly entries?: readonly LabEntry[];
  /** The page's query string without "?", e.g. "theme=light". */
  readonly search: string;
}

export const LabIndex = ({ entries = LAB_ENTRIES, search }: LabIndexProps) => {
  const params = new URLSearchParams(search);
  const theme = readLabTheme(params);
  const keep = theme === "dark" ? {} : { theme };
  return (
    <LabFrame
      entries={entries}
      theme={theme}
      themeToggleHref={withLabParam(
        "/lab",
        params,
        "theme",
        theme === "dark" ? "light" : "dark"
      )}
      title="UI lab"
    >
      <PageHeader title="UI lab" />
      <p
        className="text-muted-foreground text-sm"
        data-lab-count={entries.length}
      >
        {entries.length} portal pages with dummy data (fictional account "Demo
        Capital"). Add query params such as ?symbol=NVDA or ?theme=light.
      </p>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {groupLabEntries(entries).map(({ group, entries: items }) => (
          <Panel flush key={group} title={group}>
            <ul className="divide-y" data-lab-group={group}>
              {items.map((entry) => (
                <li key={entry.id}>
                  <a
                    className="flex min-h-11 items-center justify-between gap-3 px-4 py-2 text-sm hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-ring"
                    data-lab-entry={entry.id}
                    href={labEntryHref(entry.id, keep)}
                  >
                    <span className="font-medium">{entry.title}</span>
                    <span className="truncate font-mono text-muted-foreground text-xs">
                      {entry.route ?? entry.id}
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          </Panel>
        ))}
      </div>
    </LabFrame>
  );
};

export interface LabEntryViewProps {
  readonly entries?: readonly LabEntry[];
  readonly id: string;
  readonly search: string;
}

export const LabEntryView = ({
  entries = LAB_ENTRIES,
  id,
  search,
}: LabEntryViewProps) => {
  const params = new URLSearchParams(search);
  const theme = readLabTheme(params);
  const entry = findLabEntry(entries, id);
  const path = `/lab/${encodeURIComponent(id)}`;
  return (
    <LabFrame
      activeRoute={entry?.route}
      entries={entries}
      theme={theme}
      themeToggleHref={withLabParam(
        path,
        params,
        "theme",
        theme === "dark" ? "light" : "dark"
      )}
      title={entry?.title ?? "UI lab"}
    >
      {entry === undefined ? (
        <EmptyState
          description="No lab entry has this name. Open the lab index for the list."
          title="Unknown lab entry"
        />
      ) : (
        <div className="contents" data-lab-entry-view={entry.id}>
          {entry.render(params)}
        </div>
      )}
    </LabFrame>
  );
};
