// What: UI lab entries for the Strategies & Backtests pages: library, Academy, Strategy reviews,
// backtests and optimizations, each the real workspace with fake gateways.
// The library, backtests and optimizations workspaces read ?id= (and ?tab=) themselves.
"use client";

import {
  ACADEMY_LESSONS,
  ACADEMY_MEDIA,
  ACADEMY_SOURCES,
  lessonSummaries,
  sourceCounts,
  withAcademyMediaBaseUrl,
} from "@darkfactory/academy/lessons";
import { PageHeader } from "@darkfactory/ui";
import { GraduationCap } from "lucide-react";
import Link from "next/link";
import type { AcademyGateway } from "../../components/portal/academy/academy-client.ts";
import {
  AcademyGallery,
  type AcademyMediaEntry,
} from "../../components/portal/academy/academy-gallery.tsx";
import { readAcademyGalleryQuery } from "../../components/portal/academy/academy-gallery-query.ts";
import { AcademyLesson } from "../../components/portal/academy/academy-lesson.tsx";
import type {
  BacktestsGateway,
  OptimizationsGateway,
  StrategyLibraryGateway,
} from "../../components/portal/agent-ops-client.tsx";
import { BacktestsWorkspace } from "../../components/portal/backtests-workspace.tsx";
import {
  FilterStudiesSection,
  type ResearchStudyGateway,
} from "../../components/portal/filter-studies-section.tsx";
import { OptimizationsWorkspace } from "../../components/portal/optimizations-workspace.tsx";
import {
  type QuantLabGateway,
  QuantLabPanel,
} from "../../components/portal/quant-lab-panel.tsx";
import { StrategyLibraryWorkspace } from "../../components/portal/strategy-library-workspace.tsx";
import {
  createResearchReadScope,
  ResearchReadScopeProvider,
} from "../../components/research/read-scope.tsx";
import type { ExperienceServices } from "../../features/experience/ports.ts";
import {
  createUnavailableExperienceServices,
  ExperienceProvider,
} from "../../features/experience/shared.tsx";
import { StrategiesWorkspace } from "../../features/experience/strategies.tsx";
import { labReadOnly } from "../fixtures/core.ts";
import {
  LAB_ACADEMY_TICKERS,
  LAB_BACKTEST_ROWS,
  LAB_EXPERIENCE_SCOPES,
  LAB_FILTER_STUDY,
  LAB_OPTIMIZATION_ROWS,
  LAB_QUANT_LAB,
  LAB_STRATEGY_ROWS,
  labAcademyGate,
  labBacktestDetail,
  labOptimizationDetail,
  labStrategyArtifacts,
  labStrategyDetail,
} from "../fixtures/strategies.ts";
import type { LabEntry } from "../registry.ts";

const GROUP = "Strategies & Backtests";

const labStrategyLibraryGateway: StrategyLibraryGateway = {
  create: labReadOnly,
  get: (id) => Promise.resolve(labStrategyDetail(id)),
  list: () => Promise.resolve([...LAB_STRATEGY_ROWS]),
  removePreset: labReadOnly,
  savePreset: labReadOnly,
  update: labReadOnly,
};

const labBacktestsGateway: BacktestsGateway = {
  get: (id) => Promise.resolve(labBacktestDetail(id)),
  list: () => Promise.resolve([...LAB_BACKTEST_ROWS]),
};

const labQuantLabGateway: QuantLabGateway = {
  list: () => Promise.resolve(LAB_QUANT_LAB),
};

const labResearchStudyGateway: ResearchStudyGateway = {
  get: () => Promise.resolve(LAB_FILTER_STUDY),
};

const labOptimizationsGateway: OptimizationsGateway = {
  get: (id) => Promise.resolve(labOptimizationDetail(id)),
  list: () => Promise.resolve([...LAB_OPTIMIZATION_ROWS]),
};

export const labAcademyGateway: AcademyGateway = {
  backtest: labReadOnly,
  deployPreview: (input) => Promise.resolve(labAcademyGate(input)),
  deployRequest: labReadOnly,
  tickers: () => Promise.resolve(LAB_ACADEMY_TICKERS),
};

const unavailable = createUnavailableExperienceServices();
const labExperienceServices: ExperienceServices = {
  ...unavailable,
  reads: {
    ...unavailable.reads,
    scopes: () => Promise.resolve(LAB_EXPERIENCE_SCOPES),
    strategies: labStrategyArtifacts,
  },
};

const academyMedia = Object.fromEntries(
  Object.entries(ACADEMY_MEDIA).map(([slug, entry]) => [
    slug,
    withAcademyMediaBaseUrl(entry, undefined),
  ])
);

/** A lesson's rendered media, as the real lesson page resolves it (null when not rendered). */
export const labAcademyMediaFor = (slug: string): AcademyMediaEntry | null => {
  const entry = ACADEMY_MEDIA[slug];
  return entry === undefined ? null : withAcademyMediaBaseUrl(entry, undefined);
};

/** ?slug= picks the lesson; unknown or absent slugs open the first one. */
const renderLesson = (params: URLSearchParams) => {
  const found = ACADEMY_LESSONS.findIndex(
    (entry) => entry.slug === params.get("slug")
  );
  const index = Math.max(found, 0);
  const neighbour = (offset: number) => {
    const entry = ACADEMY_LESSONS[index + offset];
    return entry === undefined
      ? null
      : { slug: entry.slug, title: entry.title };
  };
  // slice keeps the lookup total: the lesson list is static repo content.
  return ACADEMY_LESSONS.slice(index, index + 1).map((lesson) => (
    <AcademyLesson
      gateway={labAcademyGateway}
      key={lesson.slug}
      lesson={lesson}
      media={labAcademyMediaFor(lesson.slug)}
      next={neighbour(1)}
      previous={neighbour(-1)}
    />
  ));
};

export const STRATEGIES_LAB_ENTRIES: readonly LabEntry[] = [
  {
    group: GROUP,
    id: "library",
    render: () => (
      <div className="space-y-8">
        <PageHeader
          actions={
            <Link
              className="inline-flex min-h-11 items-center gap-2 rounded-md border border-border px-3 text-sm hover:bg-muted"
              data-academy-link
              href="/academy"
              prefetch={false}
            >
              <GraduationCap aria-hidden className="size-4" /> Academy lessons
            </Link>
          }
          title="Strategy library"
        />
        <StrategyLibraryWorkspace gateway={labStrategyLibraryGateway} />
      </div>
    ),
    route: "/library",
    title: "Strategy library",
  },
  {
    group: GROUP,
    id: "academy",
    render: (params) => (
      <AcademyGallery
        initialQuery={readAcademyGalleryQuery(Object.fromEntries(params))}
        lessons={lessonSummaries()}
        media={academyMedia}
        sourceCount={
          ACADEMY_SOURCES.filter((source) => source.duplicateOf === undefined)
            .length
        }
      />
    ),
    route: "/academy",
    title: "Academy",
  },
  {
    group: GROUP,
    id: "academy-course",
    // One course's gallery: Define Your Risk. QuantFinanceToGo lessons live in Postgres (read through
    // academy.lessons), out of the lab's reach; the lab shows the packaged course.
    render: (params) => (
      <AcademyGallery
        course="dyr"
        initialQuery={readAcademyGalleryQuery(Object.fromEntries(params))}
        lessons={lessonSummaries().filter((lesson) => lesson.course === "dyr")}
        media={academyMedia}
        sourceCount={sourceCounts().dyr}
      />
    ),
    route: "/academy/c/[course]",
    title: "Academy course",
  },
  {
    group: GROUP,
    id: "academy-lesson",
    render: renderLesson,
    route: "/academy/[slug]",
    title: "Academy lesson",
  },
  {
    group: GROUP,
    id: "strategies",
    render: () => (
      <ResearchReadScopeProvider scope={createResearchReadScope()}>
        <ExperienceProvider services={labExperienceServices}>
          <StrategiesWorkspace />
        </ExperienceProvider>
      </ResearchReadScopeProvider>
    ),
    route: "/strategies",
    title: "Strategy reviews",
  },
  {
    group: GROUP,
    id: "backtests",
    render: () => (
      <div className="space-y-8">
        <PageHeader title="Backtests" />
        <BacktestsWorkspace gateway={labBacktestsGateway} />
        <QuantLabPanel gateway={labQuantLabGateway} />
        <FilterStudiesSection gateway={labResearchStudyGateway} />
      </div>
    ),
    route: "/backtests",
    title: "Backtests",
  },
  {
    group: GROUP,
    id: "optimizations",
    render: () => (
      <div className="space-y-8">
        <PageHeader title="Optimizations" />
        <OptimizationsWorkspace gateway={labOptimizationsGateway} />
      </div>
    ),
    route: "/optimizations",
    title: "Optimizations",
  },
];
