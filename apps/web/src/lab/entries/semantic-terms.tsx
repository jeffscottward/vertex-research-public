// What: UI lab entry for /semantic-terms: the real semantic terms workspace with a fake catalog.
// Used by: apps/web/src/lab/entries/index.ts.
"use client";

import { PageHeader } from "@darkfactory/ui";

import type {
  SemanticCatalog,
  SemanticTermsGateway,
} from "../../components/portal/semantic-terms-workspace.tsx";
import { SemanticTermsWorkspace } from "../../components/portal/semantic-terms-workspace.tsx";
import type { LabEntry } from "../registry.ts";

const AT = "2026-01-02T03:04:05.000Z";

/** Visibly fictional catalog: one certified Postgres term, one uncertified feed term. */
export const LAB_SEMANTIC_CATALOG: SemanticCatalog = {
  attributes: [
    {
      certificationNote: "Demo note (fake)",
      certified: true,
      certifiedAt: AT,
      certifiedBy: "demo-operator@example.test",
      description: "Demo SQL for the fake widget count.",
      id: "demo_widget_count_sql",
      sql: "select count(*) as value from demo_widgets",
      termId: "demo_widget_count",
      updatedAt: AT,
      updatedBy: "demo-operator@example.test",
    },
  ],
  canWrite: true,
  relationships: [
    {
      cardinality: "many_to_one",
      certificationNote: null,
      certified: false,
      certifiedAt: null,
      certifiedBy: null,
      description: "Demo widgets belong to a demo shelf.",
      fromColumn: "shelf_id",
      fromTable: "demo_widgets",
      id: "demo_widgets_shelf",
      toColumn: "id",
      toTable: "demo_shelves",
      updatedAt: AT,
      updatedBy: null,
    },
  ],
  terms: [
    {
      certificationNote: "Demo note (fake)",
      certified: true,
      certifiedAt: AT,
      certifiedBy: "demo-operator@example.test",
      description: "How many fake widgets the demo shelf holds.",
      feedPath: null,
      id: "demo_widget_count",
      label: "Demo widget count (fake)",
      mappedColumns: ["demo_widgets.id"],
      params: [],
      source: "postgres",
      synonyms: ["demo widgets"],
      unit: "count",
      updatedAt: AT,
      updatedBy: "demo-operator@example.test",
    },
    {
      certificationNote: null,
      certified: false,
      certifiedAt: null,
      certifiedBy: null,
      description: "A fake feed value that is not certified yet.",
      feedPath: "demo.feed.value",
      id: "demo_feed_value",
      label: "Demo feed value (fake)",
      mappedColumns: [],
      params: [],
      source: "feed",
      synonyms: [],
      unit: "USD",
      updatedAt: AT,
      updatedBy: null,
    },
  ],
};

/** Edits and certifications succeed without changing the fake catalog. */
export const labSemanticTermsGateway: SemanticTermsGateway = {
  catalog: () => Promise.resolve(LAB_SEMANTIC_CATALOG),
  certify: () => Promise.resolve({ ok: true }),
  update: () => Promise.resolve({ ok: true }),
};

export const SEMANTIC_TERMS_LAB_ENTRIES: readonly LabEntry[] = [
  {
    group: "Agents & Automation",
    id: "semantic-terms",
    render: () => (
      <div className="space-y-8">
        <PageHeader title="Semantic terms" />
        <SemanticTermsWorkspace gateway={labSemanticTermsGateway} />
      </div>
    ),
    route: "/semantic-terms",
    title: "Semantic terms",
  },
];
