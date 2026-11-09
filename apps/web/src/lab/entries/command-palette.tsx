// What: UI lab entry for the Cmd+K command palette: the real palette with every portal page;
// ?q= opens it with that text ("chart NVDA 1D"), and a jump shows its link instead of leaving.
// Used by: apps/web/src/lab/entries/index.ts.
"use client";

import { PageHeader } from "@darkfactory/ui";
import { useState } from "react";

import {
  CommandPalette,
  toPaletteItems,
} from "../../components/command-palette.tsx";
import {
  PORTAL_SIDEBAR_GROUPS,
  SETTINGS_NAVIGATION,
} from "../../lib/navigation.ts";
import type { LabEntry } from "../registry.ts";

const LAB_PALETTE_ITEMS = toPaletteItems([
  ...PORTAL_SIDEBAR_GROUPS.map((group) => ({
    group: group.label,
    items: group.items,
  })),
  { group: "Settings", items: SETTINGS_NAVIGATION },
]);

const EXAMPLES = [
  "chart NVDA 1D",
  "options AAPL 2026-12-19",
  "NVDA 1W",
  "bkt",
] as const;

const CommandPaletteLab = ({ query }: { readonly query: string | null }) => {
  const [jump, setJump] = useState<string | null>(null);
  return (
    <div className="space-y-6">
      <PageHeader title="Command palette" />
      <div className="flex items-center gap-3">
        <CommandPalette
          {...(query === null ? {} : { initialQuery: query })}
          items={LAB_PALETTE_ITEMS}
          navigate={setJump}
          trigger="search"
        />
      </div>
      <p className="text-muted-foreground text-sm" data-slot="lab-palette-jump">
        {jump === null ? "No jump yet." : `Would open ${jump}`}
      </p>
      <ul className="flex flex-wrap gap-2 text-sm">
        {EXAMPLES.map((example) => (
          <li key={example}>
            <a
              className="inline-flex min-h-11 items-center rounded-md border border-border px-3 font-mono hover:bg-muted"
              href={`?q=${encodeURIComponent(example)}`}
            >
              {example}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
};

export const COMMAND_PALETTE_LAB_ENTRIES: readonly LabEntry[] = [
  {
    group: "Linked pages",
    id: "command-palette",
    render: (params) => <CommandPaletteLab query={params.get("q")} />,
    title: "Command palette",
  },
];
