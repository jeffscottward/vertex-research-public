import { Button } from "@darkfactory/ui";
import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StrategySpec } from "@darkfactory/api/vertex";
import type {
  ExperienceScope,
  ImmutableArtifact,
  StrategyDossier,
} from "./ports.ts";

// Synthetic records only; no read port, review command or simulation is executed.
const hooks = vi.hoisted(() => {
  const states: Array<{ value: unknown }> = [];
  let index = 0;
  return {
    begin: () => {
      index = 0;
    },
    clear: () => {
      states.length = 0;
      index = 0;
    },
    useId: () => `synthetic-strategy-heading-${index++}`,
    useState: <Value,>(initial: Value | (() => Value)) => {
      const slot = index++;
      states[slot] ??= {
        value:
          typeof initial === "function" ? (initial as () => Value)() : initial,
      };
      return [
        states[slot]!.value as Value,
        (next: Value) => {
          return (states[slot]!.value = next);
        },
      ] as const;
    },
  };
});
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useState: hooks.useState,
  useMemo: <Value,>(factory: () => Value) => factory(),
  useId: hooks.useId,
  useEffect: () => undefined,
}));

import {
  ReplayLineage,
  StrategyCatalog,
  StrategyDossierView,
} from "./strategies.tsx";
import { experienceTableScroll } from "./experience-table.tsx";
import {
  ExperienceProvider,
  createUnavailableExperienceServices,
} from "./shared.tsx";

const hash = "a".repeat(64);
const scope: ExperienceScope = {
  accountAlias: "synthetic-account",
  environment: "live",
};
const artifact: ImmutableArtifact<StrategySpec> = {
  artifactId: "synthetic-strategy-artifact",
  sha256: hash,
  value: {
    schemaVersion: "1.0.0",
    strategyId: "synthetic-strategy",
    version: "1.0.0",
    sleeve: "quant",
    hypothesis: "Synthetic threshold <script>not executable</script>",
    universe: ["SYNTHETIC"],
    signalSchedule: {
      calendar: "synthetic-calendar",
      timezone: "UTC",
      interval: "bar-close",
    },
    entryRules: [
      {
        ruleId: "entry",
        featureId: "synthetic-feature",
        operator: "gte",
        threshold: "0.000000001",
        lookbackBars: 1,
      },
    ],
    exitRules: [
      {
        ruleId: "exit",
        featureId: "synthetic-feature",
        operator: "lt",
        threshold: "9007199254740993.000000001",
        lookbackBars: 2,
      },
    ],
    riskLimits: {
      maximumLoss: "1",
      maximumNotional: "10",
      maximumPositions: 1,
    },
    requiredData: [
      {
        kind: "quotes",
        maximumAgeMs: 60_000,
        pointInTimeRequired: true,
        entitlementPolicyId: "synthetic-policy",
      },
      {
        kind: "candles",
        maximumAgeMs: 120_000,
        pointInTimeRequired: false,
        entitlementPolicyId: "synthetic-bars-policy",
      },
    ],
    costModel: {
      commissionPerUnit: "0",
      spreadBps: "1",
      slippageBps: "1",
      borrowAnnualBps: "0",
      impactModel: "fixed-bps",
      maximumParticipationBps: "1",
    },
    codeDigest: hash,
  },
};
const withoutHelp = (html: string): string =>
  html.replace(/<aside\b[^>]*popover="auto"[^>]*>[\s\S]*?<\/aside>/g, "");
type Interactive = ReactElement<{
  readonly children?: ReactNode;
  readonly type?: string;
  readonly onClick?: () => void;
  readonly onChange?: (event: { target: { value: string } }) => void;
}>;
const elements = (node: ReactNode): Interactive[] => {
  if (!isValidElement<Interactive["props"]>(node)) return [];
  const children: Interactive[] = [];
  Children.forEach(node.props.children, (child) =>
    children.push(...elements(child))
  );
  return [node, ...children];
};
const onSelect = vi.fn();
const onRetire = vi.fn();
const catalog = (
  items: readonly ImmutableArtifact<StrategySpec>[] = [artifact]
): ReactNode => {
  hooks.begin();
  return StrategyCatalog({
    catalog: items,
    selected: { artifactId: artifact.artifactId, sha256: hash },
    onSelect,
    onRetire,
  });
};

afterEach(() => {
  hooks.clear();
  return vi.clearAllMocks();
});

describe("Strategies data-first immutable records", () => {
  it("names the catalog table and keeps exact identity, hypothesis and version visible without help", () => {
    const html = renderToStaticMarkup(catalog());
    const visible = withoutHelp(html);
    expect(html).toContain('aria-label="About Immutable strategy catalog"');
    expect(visible).toContain(
      'data-slot="table" aria-labelledby="synthetic-strategy-heading-0-catalog">'
    );
    expect(visible).toContain(
      `class="${experienceTableScroll}" role="region" aria-labelledby="synthetic-strategy-heading-0-catalog" tabindex="0"`
    );
    expect(visible).toContain('tabindex="0"');
    for (const text of [
      artifact.artifactId,
      hash,
      "synthetic-strategy",
      "1.0.0",
      "quant",
      "SYNTHETIC",
      "&lt;script&gt;not executable&lt;/script&gt;",
      "Changing a filter clears the selected dossier",
      'aria-pressed="true"',
    ]) {
      expect(visible).toContain(text);
    }
    return expect(visible).not.toContain("<script>");
  });
  it("selects the exact artifact hash and retires the dossier when either filter changes", () => {
    let tree = catalog();
    elements(tree)
      .find(
        (node) =>
          (node.type === "button" || node.type === Button) &&
          node.props.children === "Read exact dossier"
      )
      ?.props.onClick?.();
    expect(onSelect).toHaveBeenCalledExactlyOnceWith({
      artifactId: artifact.artifactId,
      sha256: hash,
    });
    elements(tree)
      .find((node) => node.type === "input" && node.props.type === "search")
      ?.props.onChange?.({ target: { value: "absent" } });
    expect(onRetire).toHaveBeenCalledTimes(1);
    expect(renderToStaticMarkup(catalog())).toContain(
      "No strategy matches these filters"
    );
    tree = catalog();
    elements(tree)
      .find((node) => node.type === "input")
      ?.props.onChange?.({ target: { value: "" } });
    elements(catalog())
      .find((node) => node.type === "select")
      ?.props.onChange?.({ target: { value: "wheel" } });
    expect(onRetire).toHaveBeenCalledTimes(3);
    return expect(renderToStaticMarkup(catalog())).toContain(
      "No strategy matches these filters"
    );
  });
  it("keeps matching version labels separate and selects only the exact row hash", () => {
    const alternate = { ...artifact, sha256: "b".repeat(64) };
    const tree = catalog([artifact, alternate]);
    const html = renderToStaticMarkup(tree);
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(html.match(/aria-pressed="false"/g)).toHaveLength(1);
    const buttons = elements(tree).filter(
      (node) =>
        (node.type === "button" || node.type === Button) &&
        node.props.children === "Read exact dossier"
    );
    expect(buttons).toHaveLength(2);
    buttons[1]?.props.onClick?.();
    return expect(onSelect).toHaveBeenCalledExactlyOnceWith({
      artifactId: artifact.artifactId,
      sha256: alternate.sha256,
    });
  });
  it("does not fabricate a table or readiness for an empty catalog", () => {
    const html = renderToStaticMarkup(catalog([]));
    expect(html).toContain("No stored strategies in this scope");
    return expect(html).not.toContain("<table");
  });
  it("labels replay lineage as a Vertex replay, not an outside source", () => {
    const manifestHash = "b".repeat(64);
    const html = renderToStaticMarkup(
      <ReplayLineage
        provenance={{
          schemaVersion: "1.0.0",
          replaySchemaVersion: 2,
          sourceTradeRunId: "synthetic-trade-run",
          replayManifestId: `replay-manifest-${manifestHash.slice(0, 24)}`,
          manifestHash,
          inputHash: "c".repeat(64),
          outputHash: "d".repeat(64),
        }}
      />
    );
    expect(html).toContain("Replay source trade run");
    expect(html).toContain("synthetic-trade-run");
    expect(renderToStaticMarkup(<ReplayLineage provenance={null} />)).toContain(
      "No replay provenance supplied."
    );
    return expect(html).not.toMatch(/gamma/iu);
  });
  it("keeps deterministic rules and source requirements exact while live reviews remain blocked", () => {
    const dossier: StrategyDossier = {
      strategy: artifact,
      drafts: [],
      datasets: [],
      evidence: [],
      backtests: [],
      reviews: [],
      admissions: [],
    };
    const html = renderToStaticMarkup(
      <ExperienceProvider services={createUnavailableExperienceServices()}>
        <StrategyDossierView scope={scope} dossier={dossier} />
      </ExperienceProvider>
    );
    const visible = withoutHelp(html);
    for (const title of [
      "Deterministic entry rules",
      "Deterministic exit rules",
      "Required source data",
    ]) {
      expect(html).toContain(`aria-label="About ${title}"`);
    }
    expect(visible.match(/<table\b/g)).toHaveLength(3);
    for (const text of [
      "0.000000001",
      "9007199254740993.000000001",
      "60000",
      "120000",
      "synthetic-bars-policy",
      ">required<",
      ">not required<",
      "do not reserve capital or authorize risk",
      "No dataset manifests were supplied",
      "No source evidence records were supplied",
      "No backtest artifacts were supplied",
      "No draft selected",
      "Live observation only",
      "cannot record reviews or request simulations",
      "Research review does not grant paper-simulation admission",
      "does not cancel an already queued server job",
    ]) {
      expect(visible).toContain(text);
    }
    expect(visible).not.toContain('aria-label="Exact artifact review"');
    return expect(visible).not.toContain(
      'aria-label="Queue admitted paper simulation"'
    );
  });
  return it("marks only numeric rule and data-age columns while preserving complete decimal chunks", () => {
    const longThreshold = "12345678901234567890.12345678901";
    const numericArtifact: ImmutableArtifact<StrategySpec> = {
      ...artifact,
      value: {
        ...artifact.value,
        exitRules: [
          { ...artifact.value.exitRules[0]!, threshold: longThreshold },
        ],
      },
    };
    const dossier: StrategyDossier = {
      strategy: numericArtifact,
      drafts: [],
      datasets: [],
      evidence: [],
      backtests: [],
      reviews: [],
      admissions: [],
    };
    const html = renderToStaticMarkup(
      <ExperienceProvider services={createUnavailableExperienceServices()}>
        <StrategyDossierView scope={scope} dossier={dossier} />
      </ExperienceProvider>
    );
    const marked = Array.from(
      html.matchAll(/<(th|td)\b([^>]*)>([\s\S]*?)<\/\1>/g)
    )
      .filter((match) => match[2]!.includes("data-numeric"))
      .map((match) => [match[1], match[3]]);
    expect(marked).toEqual([
      ["th", "Threshold"],
      ["th", "Lookback bars"],
      ["td", "0.000000001"],
      ["td", "1"],
      ["th", "Threshold"],
      ["th", "Lookback bars"],
      ["td", longThreshold],
      ["td", "2"],
      ["th", "Maximum age (ms)"],
      ["td", "60000"],
      ["td", "120000"],
    ]);
    expect(html.match(/data-numeric=""/g)).toHaveLength(marked.length);
    expect(html).toContain(`data-numeric="">${longThreshold}</td>`);
    expect(html).toContain('data-numeric="">0.000000001</td>');
    expect(
      html.split(`class="${experienceTableScroll}" role="region"`)
    ).toHaveLength(4);
    hooks.clear();
    return expect(renderToStaticMarkup(catalog())).not.toContain(
      "data-numeric"
    );
  });
});
