"use client";

import { Button } from "@darkfactory/ui";

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import type {
  AcceptedReview,
  DatasetManifest,
  PaperSimulationAdmission,
  StrategySpec,
  TradeIntent,
} from "@darkfactory/api/vertex";
import {
  ArtifactFacts,
  ReadNotice,
} from "../../components/research/research-views.tsx";
import { ResearchTableHeading } from "../../components/research/research-table-heading.tsx";
import {
  ExperienceFrame,
  EmptyCollection,
  ResourcePanel,
  ScopeLabel,
  ScopeChooser,
  useExperienceResource,
  useExperienceServices,
} from "./shared.tsx";
import type {
  ExperienceJobPort,
  ExperienceReviewPort,
  ExperienceScope,
  ImmutableArtifact,
  ReviewDecisionCommand,
  SimulationProposalCommand,
  StrategyDossier,
} from "./ports.ts";
import {
  buildReviewDecisionCommand,
  buildReviewModel,
  buildSimulationProposalCommand,
  isExactStrategySelection,
  strategySelectionKey,
  validateReviewResponse,
  validateSimulationQueueReceipt,
  type ReviewTarget,
  type StrategySelection,
} from "./review-model.ts";

const useCurrentTime = (): string => {
  const [now, setNow] = useState(() => new Date().toISOString());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date().toISOString()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
};

const failureText = (error: unknown): string =>
  error instanceof Error
    ? error.message
    : "The exact artifact could not be confirmed. Reload the dossier.";

export const StrategiesWorkspace = () => {
  const [scope, setScope] = useState<ExperienceScope | null>(null);
  return (
    <ExperienceFrame title="Strategy reviews">
      <h2 id="review-queue" tabIndex={-1}>
        Review queue
      </h2>
      <ScopeChooser onSelect={setScope} onRetire={() => setScope(null)} />
      {scope === null ? null : (
        <ScopedStrategies key={JSON.stringify(scope)} scope={scope} />
      )}
    </ExperienceFrame>
  );
};

const ScopedStrategies = ({ scope }: { readonly scope: ExperienceScope }) => {
  const services = useExperienceServices();
  const { resource, state } = useExperienceResource(services.reads.strategies);
  const [selected, setSelected] = useState<StrategySelection | null>(null);
  useEffect(() => {
    return void resource.load(scope);
  }, [resource, scope]);
  const reload = () => {
    setSelected(null);
    return void resource.load(scope);
  };
  return (
    <div className="vx-ex-stack">
      <ScopeLabel scope={scope} />
      <div className="vx-ex-toolbar">
        <Button variant="outline" type="button" onClick={reload}>
          Refresh catalog
        </Button>
      </div>
      <ResourcePanel
        state={state}
        title="Strategy catalog"
        retry={reload}
        children={(catalog) => (
          <div className="vx-ex-stack">
            <StrategyCatalog
              catalog={catalog}
              selected={selected}
              onSelect={setSelected}
              onRetire={() => setSelected(null)}
            />
            {selected === null ? (
              <EmptyCollection title="Select an immutable strategy">
                Each row is one stored StrategySpec artifact. The version label
                is descriptive. The strategyVersion field identifies the exact
                artifact ID.
              </EmptyCollection>
            ) : (
              <DossierRead
                key={strategySelectionKey(scope, selected)}
                scope={scope}
                selected={selected}
              />
            )}
          </div>
        )}
      />
    </div>
  );
};

export const StrategyCatalog = ({
  catalog,
  selected,
  onSelect,
  onRetire,
}: {
  readonly catalog: readonly ImmutableArtifact<StrategySpec>[];
  readonly selected: StrategySelection | null;
  readonly onSelect: (selection: StrategySelection) => void;
  readonly onRetire: () => void;
}) => {
  const headingId = `${useId()}-catalog`;
  const [query, setQuery] = useState("");
  const [sleeve, setSleeve] = useState("all");
  const visible = useMemo(() => {
    const search = query.trim().toLocaleLowerCase();
    return catalog.filter(
      (item) =>
        (sleeve === "all" || item.value.sleeve === sleeve) &&
        [
          item.artifactId,
          item.sha256,
          item.value.strategyId,
          item.value.version,
          item.value.hypothesis,
          ...item.value.universe,
        ]
          .join(" ")
          .toLocaleLowerCase()
          .includes(search)
    );
  }, [catalog, query, sleeve]);
  if (catalog.length === 0)
    return (
      <EmptyCollection title="No stored strategies in this scope">
        Use the separate research workflow to publish a reviewed source
        artifact. An authorized catalog connection is required to read it.
      </EmptyCollection>
    );
  return (
    <section className="vx-ex-stack" aria-label="Search strategy catalog">
      <ResearchTableHeading id={headingId} title="Immutable strategy catalog">
        <p>
          Each row is one stored StrategySpec artifact. The version label is
          descriptive; strategyVersion identifies the exact immutable artifact
          ID.
        </p>
      </ResearchTableHeading>
      <div className="vx-ex-filters">
        <label>
          Search identity, hypothesis or instrument
          <input
            type="search"
            value={query}
            maxLength={200}
            onChange={(event) => {
              onRetire();
              return setQuery(event.target.value);
            }}
          />
        </label>
        <label>
          Strategy sleeve
          <select
            value={sleeve}
            onChange={(event) => {
              onRetire();
              return setSleeve(event.target.value);
            }}
          >
            <option value="all">All sleeves</option>
            <option value="wheel">Wheel</option>
            <option value="fundamental">Fundamental</option>
            <option value="swing">Swing</option>
            <option value="macro">Macro</option>
            <option value="quant">Quant</option>
          </select>
        </label>
      </div>
      <p className="vx-caption" role="status">
        {visible.length} of {catalog.length} stored artifacts. Changing a filter
        clears the selected dossier and stops pending browser requests.
      </p>
      {visible.length === 0 ? (
        <EmptyCollection title="No strategy matches these filters">
          Broaden the search or choose another sleeve. The source catalog is
          unchanged.
        </EmptyCollection>
      ) : (
        <div
          className="vx-ex-table-scroll"
          role="region"
          aria-labelledby={headingId}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: axe scrollable-region-focusable: keyboard users must be able to focus and scroll this overflow region.
          tabIndex={0}
        >
          <table className="vx-ex-table" aria-labelledby={headingId}>
            <thead>
              <tr>
                <th scope="col">Strategy / version</th>
                <th scope="col">Sleeve / universe</th>
                <th scope="col">Hypothesis</th>
                <th scope="col">Immutable artifact ID / strategyVersion</th>
                <th scope="col">SHA-256</th>
                <th scope="col">Dossier</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((item) => (
                <tr key={`${item.artifactId}:${item.sha256}`}>
                  <th scope="row">
                    {item.value.strategyId}
                    <br />
                    <span className="vx-caption">{item.value.version}</span>
                  </th>
                  <td>
                    {item.value.sleeve}
                    <br />
                    {item.value.universe.join(", ")}
                  </td>
                  <td>{item.value.hypothesis}</td>
                  <td>{item.artifactId}</td>
                  <td>{item.sha256}</td>
                  <td>
                    <Button
                      variant="outline"
                      type="button"
                      aria-pressed={
                        selected?.artifactId === item.artifactId &&
                        selected.sha256 === item.sha256
                      }
                      onClick={() =>
                        onSelect({
                          artifactId: item.artifactId,
                          sha256: item.sha256,
                        })
                      }
                    >
                      Read exact dossier
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
};

const DossierRead = ({
  scope,
  selected,
}: {
  readonly scope: ExperienceScope;
  readonly selected: StrategySelection;
}) => {
  const services = useExperienceServices();
  const { resource, state } = useExperienceResource(services.reads.dossier);
  const reload = () =>
    void resource.load({ ...scope, artifactId: selected.artifactId });
  useEffect(() => {
    return void resource.load({ ...scope, artifactId: selected.artifactId });
  }, [resource, scope, selected.artifactId]);
  return (
    <section className="vx-ex-stack" aria-label="Selected strategy dossier">
      <div className="vx-ex-toolbar">
        <h2>Strategy dossier</h2>
        <Button variant="outline" type="button" onClick={reload}>
          Reload dossier and reviews
        </Button>
      </div>
      <ResourcePanel
        state={state}
        title="Strategy dossier"
        retry={reload}
        children={(dossier) =>
          isExactStrategySelection(selected, dossier.strategy) ? (
            <StrategyDossierView scope={scope} dossier={dossier} />
          ) : (
            <ReadNotice title="Immutable selection mismatch">
              The returned artifact ID or SHA-256 differs from the selected
              catalog row. No review or simulation controls are available.
              Refresh the catalog.
            </ReadNotice>
          )
        }
      />
    </section>
  );
};

const Rules = ({
  title,
  rules,
}: {
  readonly title: string;
  readonly rules: StrategySpec["entryRules"];
}) => {
  const headingId = `${useId()}-rules`;
  return (
    <section className="vx-ex-section">
      <ResearchTableHeading id={headingId} title={title}>
        <p>
          Rules remain in source order. Operators, thresholds and lookback bars
          are shown as supplied.
        </p>
      </ResearchTableHeading>
      <div
        className="vx-ex-table-scroll"
        role="region"
        aria-labelledby={headingId}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: axe scrollable-region-focusable: keyboard users must be able to focus and scroll this overflow region.
        tabIndex={0}
      >
        <table className="vx-ex-table" aria-labelledby={headingId}>
          <thead>
            <tr>
              <th scope="col">Rule</th>
              <th scope="col">Feature</th>
              <th scope="col">Operator</th>
              <th scope="col" className="vx-ex-numeric">
                Threshold
              </th>
              <th scope="col" className="vx-ex-numeric">
                Lookback bars
              </th>
            </tr>
          </thead>
          <tbody>
            {rules.map((rule) => (
              <tr key={rule.ruleId}>
                <th scope="row">{rule.ruleId}</th>
                <td>{rule.featureId}</td>
                <td>{rule.operator}</td>
                <td className="vx-ex-numeric">{rule.threshold}</td>
                <td className="vx-ex-numeric">{rule.lookbackBars}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
};

export const StrategyDossierView = ({
  scope,
  dossier,
}: {
  readonly scope: ExperienceScope;
  readonly dossier: StrategyDossier;
}) => {
  const strategy = dossier.strategy.value;
  const requirementsId = `${useId()}-requirements`;
  const [draftKey, setDraftKey] = useState("");
  const draft =
    dossier.drafts.find(
      (item) => JSON.stringify([item.artifactId, item.sha256]) === draftKey
    ) ?? null;
  const target: ReviewTarget =
    draft === null
      ? {
          artifactId: dossier.strategy.artifactId,
          sha256: dossier.strategy.sha256,
          strategyVersion: dossier.strategy.artifactId,
        }
      : {
          artifactId: draft.artifactId,
          sha256: draft.sha256,
          strategyVersion: dossier.strategy.artifactId,
        };
  const draftMatches =
    draft === null ||
    (draft.value.strategyVersion === dossier.strategy.artifactId &&
      draft.value.accountAlias === scope.accountAlias &&
      draft.value.environment === scope.environment &&
      draft.value.proposalOnly === true &&
      draft.value.executionAuthorized === false);
  return (
    <div className="vx-ex-stack">
      <header className="vx-ex-section">
        <p className="vx-eyebrow">
          {strategy.sleeve} / immutable specification
        </p>
        <h2>
          {strategy.strategyId} · {strategy.version}
        </h2>
        <p className="vx-ex-lead">{strategy.hypothesis}</p>
        <ArtifactFacts
          entries={[
            [
              "Artifact ID / exact strategyVersion",
              dossier.strategy.artifactId,
            ],
            ["Artifact SHA-256", dossier.strategy.sha256],
            ["Code digest", strategy.codeDigest],
            ["Universe", strategy.universe.join(", ")],
            [
              "Signal schedule",
              `${strategy.signalSchedule.interval} / ${strategy.signalSchedule.calendar} / ${strategy.signalSchedule.timezone}`,
            ],
          ]}
        />
      </header>
      <div className="vx-ex-split">
        <Rules title="Deterministic entry rules" rules={strategy.entryRules} />
        <Rules title="Deterministic exit rules" rules={strategy.exitRules} />
      </div>
      <section className="vx-ex-section">
        <h3>Risk limits and transaction cost assumptions</h3>
        <p className="vx-caption">
          Source decimals are shown unchanged. These model limits do not reserve
          capital or authorize risk.
        </p>
        <ArtifactFacts
          entries={[
            ["Maximum loss", strategy.riskLimits.maximumLoss],
            ["Maximum notional", strategy.riskLimits.maximumNotional],
            ["Maximum positions", strategy.riskLimits.maximumPositions],
            ["Commission per unit", strategy.costModel.commissionPerUnit],
            ["Spread (bps)", strategy.costModel.spreadBps],
            ["Slippage (bps)", strategy.costModel.slippageBps],
            ["Annual borrow (bps)", strategy.costModel.borrowAnnualBps],
            ["Impact model", strategy.costModel.impactModel],
            [
              "Maximum participation (bps)",
              strategy.costModel.maximumParticipationBps,
            ],
          ]}
        />
      </section>
      <section className="vx-ex-section">
        <ResearchTableHeading id={requirementsId} title="Required source data">
          <p>
            Declared input requirements for this immutable specification.
            Maximum age is in milliseconds.
          </p>
        </ResearchTableHeading>
        <div
          className="vx-ex-table-scroll"
          role="region"
          aria-labelledby={requirementsId}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: axe scrollable-region-focusable: keyboard users must be able to focus and scroll this overflow region.
          tabIndex={0}
        >
          <table className="vx-ex-table" aria-labelledby={requirementsId}>
            <thead>
              <tr>
                <th scope="col">Data kind</th>
                <th scope="col" className="vx-ex-numeric">
                  Maximum age (ms)
                </th>
                <th scope="col">Point-in-time</th>
                <th scope="col">Entitlement policy</th>
              </tr>
            </thead>
            <tbody>
              {strategy.requiredData.map((requirement, index) => (
                <tr key={`${requirement.kind}:${index}`}>
                  <th scope="row">{requirement.kind}</th>
                  <td className="vx-ex-numeric">{requirement.maximumAgeMs}</td>
                  <td>
                    {requirement.pointInTimeRequired
                      ? "required"
                      : "not required"}
                  </td>
                  <td>{requirement.entitlementPolicyId}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <DossierLineage dossier={dossier} />
      <section className="vx-ex-section">
        <h3>Exact review target</h3>
        <label>
          Specification or proposal-only draft
          <select
            value={draftKey}
            onChange={(event) => setDraftKey(event.target.value)}
          >
            <option value="">
              Strategy specification · research review only
            </option>
            {dossier.drafts.map((item) => (
              <option
                key={`${item.artifactId}:${item.sha256}`}
                value={JSON.stringify([item.artifactId, item.sha256])}
              >
                {item.artifactId} · {item.value.instrumentId} · SHA-256{" "}
                {item.sha256}
              </option>
            ))}
          </select>
        </label>
        <p className="vx-caption">
          Selecting another draft discards the previous decision,
          acknowledgement, result and pending browser work. It does not cancel
          an already queued server job.
        </p>
        {draft === null ? (
          <p>
            No draft selected. A specification review cannot admit a trade
            intent.
          </p>
        ) : (
          <DraftFacts draft={draft} />
        )}
        {draft === null ? null : (
          <ul className="vx-ex-record-list">
            {draft.value.reasonEvidenceIds.map((id) => (
              <li key={id}>
                {id} ·{" "}
                {dossier.evidence.some((item) => item.evidenceId === id)
                  ? "Evidence record supplied in this dossier"
                  : "Referenced evidence unavailable in this dossier"}
              </li>
            ))}
          </ul>
        )}
      </section>
      {draftMatches ? (
        <ReviewSection
          key={JSON.stringify([target, draftKey])}
          scope={scope}
          dossier={dossier}
          target={target}
          draft={draft}
        />
      ) : (
        <ReadNotice title="Draft binding mismatch">
          This proposal does not match the exact strategyVersion, account,
          environment or proposal-only flags. Read-only lineage remains visible;
          decisions and simulation are blocked.
        </ReadNotice>
      )}
    </div>
  );
};

const DraftFacts = ({
  draft,
}: {
  readonly draft: ImmutableArtifact<TradeIntent>;
}) => (
  <div className="vx-ex-stack">
    <p className="vx-status">Proposal only · executionAuthorized false</p>
    <ArtifactFacts
      entries={[
        ["Draft artifact ID", draft.artifactId],
        ["Draft SHA-256", draft.sha256],
        ["Intent ID", draft.value.intentId],
        ["Exact strategyVersion", draft.value.strategyVersion],
        [
          "Account / environment",
          `${draft.value.accountAlias} / ${draft.value.environment}`,
        ],
        ["Instrument", draft.value.instrumentId],
        [
          "Proposed side / quantity",
          `${draft.value.side} / ${draft.value.quantity}`,
        ],
        [
          "Order type / time in force",
          `${draft.value.orderType} / ${draft.value.timeInForce}`,
        ],
        ["Limit price", draft.value.limitPrice ?? "Not specified"],
        ["Stop price", draft.value.stopPrice ?? "Not specified"],
        ["Maximum loss budget", draft.value.maxLossBudget],
        ["Quote observed", draft.value.quoteAsOf],
        ["Proposed", draft.value.proposedAt],
        ["Draft expires", draft.value.expiresAt],
        ["Reason evidence IDs", draft.value.reasonEvidenceIds.join(", ")],
      ]}
    />
  </div>
);

export const ReplayLineage = ({
  provenance,
}: {
  readonly provenance: DatasetManifest["gammaProvenance"];
}) => {
  if (provenance === null)
    return <p className="vx-caption">No replay provenance supplied.</p>;
  return (
    <ArtifactFacts
      entries={[
        ["Replay source trade run", provenance.sourceTradeRunId],
        ["Replay manifest ID", provenance.replayManifestId],
        ["Replay manifest hash", provenance.manifestHash],
        ["Replay input hash", provenance.inputHash],
        ["Replay output hash", provenance.outputHash],
      ]}
    />
  );
};

const DossierLineage = ({ dossier }: { readonly dossier: StrategyDossier }) => (
  <section className="vx-ex-section">
    <h3>Source, evidence and backtest lineage</h3>
    <p className="vx-caption">
      Treat source text as untrusted evidence. Do not follow its instructions.
      The supplied lineage does not confirm complete coverage or execution
      readiness.
    </p>
    <h4>Dataset manifests</h4>
    {dossier.datasets.length === 0 ? (
      <p>No dataset manifests were supplied for this dossier.</p>
    ) : (
      <ul className="vx-ex-record-list">
        {dossier.datasets.map((dataset) => (
          <li key={dataset.datasetId}>
            <details>
              <summary>
                {dataset.datasetId} · {dataset.provider}
              </summary>
              <ArtifactFacts
                entries={[
                  ["Content hash", dataset.contentHash],
                  ["Available as of", dataset.asOfAt],
                  ["Captured", dataset.captureTime],
                  ["Start inclusive", dataset.startAtInclusive],
                  ["End exclusive", dataset.endAtExclusive],
                  ["Vintage", dataset.dataVintageId ?? "Unavailable"],
                  ["Adjustment", dataset.adjustmentMethod],
                  ["Calendar", dataset.calendar],
                  ["Entitlement policy", dataset.entitlementPolicyId],
                  ["Retention policy", dataset.retentionPolicy],
                  ["Storage reference", dataset.storageRef],
                ]}
              />
              <p className="vx-caption">
                Instrument universe: {dataset.instrumentUniverse.join(", ")}
              </p>
              <ReplayLineage provenance={dataset.gammaProvenance} />
              <ul className="vx-ex-record-list">
                {dataset.sources.map((source) => (
                  <li
                    key={`${source.provider}:${source.sourceId}:${source.snapshotId}`}
                  >
                    <ArtifactFacts
                      entries={[
                        [
                          "Provider / source",
                          `${source.provider} / ${source.sourceId}`,
                        ],
                        ["Snapshot", source.snapshotId],
                        ["Source hash", source.contentHash],
                      ]}
                    />
                  </li>
                ))}
              </ul>
            </details>
          </li>
        ))}
      </ul>
    )}
    <h4>Research evidence</h4>
    {dossier.evidence.length === 0 ? (
      <p>No source evidence records were supplied.</p>
    ) : (
      <ul className="vx-ex-record-list">
        {dossier.evidence.map((evidence) => (
          <li key={evidence.evidenceId}>
            <details>
              <summary>
                {evidence.evidenceId} · {evidence.acceptanceStatus}
              </summary>
              <p>{evidence.claim}</p>
              <p>{evidence.method}</p>
              <ArtifactFacts
                entries={[
                  ["Source URI", evidence.sourceUri],
                  ["Source locator", evidence.sourceLocator],
                  ["Attribution", evidence.attribution],
                  [
                    "Collection / snapshot",
                    `${evidence.collectionId} / ${evidence.snapshotId}`,
                  ],
                  [
                    "Provider / source",
                    `${evidence.sourceIdentity.provider} / ${evidence.sourceIdentity.sourceId}`,
                  ],
                  ["Source snapshot", evidence.sourceIdentity.snapshotId],
                  ["Content hash", evidence.contentHash],
                  ["Published", evidence.publishedAt ?? "Unknown"],
                  ["Captured", evidence.capturedAt],
                  ["Rights policy", evidence.rightsPolicyId],
                ]}
              />
              <h5>Limitations</h5>
              {evidence.limitations.length === 0 ? (
                <p>
                  No limitations supplied; this is not proof of completeness.
                </p>
              ) : (
                <ul>
                  {evidence.limitations.map((limitation, index) => (
                    <li key={index}>{limitation}</li>
                  ))}
                </ul>
              )}
            </details>
          </li>
        ))}
      </ul>
    )}
    <h4>Backtest artifacts</h4>
    {dossier.backtests.length === 0 ? (
      <p>
        No backtest artifacts were supplied. No performance estimate is
        inferred.
      </p>
    ) : (
      <ul className="vx-ex-record-list">
        {dossier.backtests.map((backtest) => (
          <li key={`${backtest.artifactId}:${backtest.sha256}`}>
            <details>
              <summary>
                {backtest.value.runId} · {backtest.value.reviewStatus} ·{" "}
                {backtest.value.validationMode}
              </summary>
              <p className="vx-status">
                {backtest.value.strategyVersion === dossier.strategy.artifactId
                  ? "Exact strategyVersion binding"
                  : "Strategy version mismatch — not evidence for this specification"}
              </p>
              <ArtifactFacts
                entries={[
                  ["Artifact ID", backtest.artifactId],
                  ["SHA-256", backtest.sha256],
                  ["Exact strategyVersion", backtest.value.strategyVersion],
                  [
                    "Dataset manifest IDs",
                    backtest.value.datasetManifestIds.join(", "),
                  ],
                  [
                    "Engine version / seed",
                    `${backtest.value.engineVersion} / ${backtest.value.seed}`,
                  ],
                  [
                    "Training start / end exclusive",
                    `${backtest.value.trainingWindow.startAtInclusive} / ${backtest.value.trainingWindow.endAtExclusive}`,
                  ],
                  [
                    "Test start / end exclusive",
                    `${backtest.value.testWindow.startAtInclusive} / ${backtest.value.testWindow.endAtExclusive}`,
                  ],
                  ["Benchmark", backtest.value.benchmark],
                  ["Slippage model", backtest.value.slippageModel],
                  [
                    "Results reference",
                    backtest.value.resultsRef ?? "Unavailable",
                  ],
                  ["Forward sample count", backtest.value.forwardSampleCount],
                ]}
              />
              <ul>
                {backtest.value.leakageChecks.map((check) => (
                  <li key={check.kind}>
                    {check.kind}: {check.status} ·{" "}
                    {check.evidenceId ?? "No evidence reference"}
                  </li>
                ))}
              </ul>
              <h5>Manifest coverage</h5>
              <ul>
                {backtest.value.datasetManifestIds.map((id) => (
                  <li key={id}>
                    {id} ·{" "}
                    {dossier.datasets.some((item) => item.datasetId === id)
                      ? "Manifest supplied in this dossier"
                      : "Referenced manifest unavailable in this dossier"}
                  </li>
                ))}
              </ul>
              <h5>Backtest transaction costs</h5>
              <ArtifactFacts
                entries={[
                  [
                    "Commission per unit",
                    backtest.value.transactionCosts.commissionPerUnit,
                  ],
                  ["Spread (bps)", backtest.value.transactionCosts.spreadBps],
                  [
                    "Slippage (bps)",
                    backtest.value.transactionCosts.slippageBps,
                  ],
                  [
                    "Annual borrow (bps)",
                    backtest.value.transactionCosts.borrowAnnualBps,
                  ],
                  ["Impact model", backtest.value.transactionCosts.impactModel],
                  [
                    "Maximum participation (bps)",
                    backtest.value.transactionCosts.maximumParticipationBps,
                  ],
                ]}
              />
              <ReplayLineage provenance={backtest.value.gammaProvenance} />
            </details>
          </li>
        ))}
      </ul>
    )}
  </section>
);

const ReviewSection = ({
  scope,
  dossier,
  target,
  draft,
}: {
  readonly scope: ExperienceScope;
  readonly dossier: StrategyDossier;
  readonly target: ReviewTarget;
  readonly draft: ImmutableArtifact<TradeIntent> | null;
}) => {
  const [purpose, setPurpose] = useState<AcceptedReview["purpose"]>(
    draft !== null && scope.environment === "paper"
      ? "paper-simulation"
      : "research"
  );
  return (
    <section className="vx-ex-section">
      <h3>Artifact decision</h3>
      <label>
        Review purpose
        <select
          value={purpose}
          onChange={(event) => {
            if (
              event.target.value === "research" ||
              (event.target.value === "paper-simulation" &&
                scope.environment === "paper" &&
                draft !== null)
            )
              return setPurpose(event.target.value);
            return;
          }}
        >
          <option value="research">Research only</option>
          {scope.environment === "paper" && draft !== null ? (
            <option value="paper-simulation">Paper simulation only</option>
          ) : null}
        </select>
      </label>
      <ReviewFlow
        key={purpose}
        scope={scope}
        dossier={dossier}
        target={target}
        draft={draft}
        purpose={purpose}
      />
    </section>
  );
};

const ReviewFlow = ({
  scope,
  dossier,
  target,
  draft,
  purpose,
}: {
  readonly scope: ExperienceScope;
  readonly dossier: StrategyDossier;
  readonly target: ReviewTarget;
  readonly draft: ImmutableArtifact<TradeIntent> | null;
  readonly purpose: AcceptedReview["purpose"];
}) => {
  const services = useExperienceServices();
  const now = useCurrentTime();
  const [editing, setEditing] = useState(false);
  const model = buildReviewModel({
    scope,
    target,
    purpose,
    reviews: dossier.reviews,
    now,
  });
  return (
    <div className="vx-ex-stack">
      <p className="vx-status" role="status">
        Latest review: {model.status}
      </p>
      <p>{model.detail}</p>
      <ArtifactFacts
        entries={[
          ["Selected artifact ID", target.artifactId],
          ["Selected SHA-256", target.sha256],
          ["Exact strategyVersion", target.strategyVersion],
          ["Purpose", purpose],
          ["Expected predecessor", model.expectedReviewId ?? "No prior review"],
        ]}
      />
      {model.latest === null ? null : (
        <ArtifactFacts
          entries={[
            [
              "Latest review ID / version",
              `${model.latest.reviewId} / ${model.latest.reviewVersion}`,
            ],
            ["Server actor", model.latest.actorId],
            ["Server policy version", model.latest.policyVersion],
            ["Reviewed", model.latest.reviewedAt],
            ["Review expires", model.latest.expiresAt],
            ["Supersedes", model.latest.supersedesReviewId ?? "First review"],
          ]}
        />
      )}
      {scope.environment === "live" ? (
        <ReadNotice title="Live observation only">
          This scope cannot record reviews or request simulations.
        </ReadNotice>
      ) : services.reviews === null ? (
        <ReadNotice title="Review service unavailable">
          No decision is saved locally. The server must verify the actor,
          policy, expiry and latest predecessor before recording a review.
        </ReadNotice>
      ) : (
        <ReviewForm
          port={services.reviews}
          scope={scope}
          target={target}
          purpose={purpose}
          reviews={dossier.reviews}
          now={now}
          onEdit={() => setEditing(true)}
        />
      )}
      {editing ? (
        <ReadNotice title="Simulation selection cleared">
          The decision form changed. Reload the dossier for current review
          history and admissions before requesting simulation. Stopping a
          browser request does not cancel a server job.
        </ReadNotice>
      ) : purpose === "paper-simulation" && draft !== null ? (
        <SimulationSelector
          scope={scope}
          dossier={dossier}
          draft={draft}
          now={now}
        />
      ) : (
        <p className="vx-caption">
          Research review does not grant paper-simulation admission,
          broker-paper permission or live authorization.
        </p>
      )}
    </div>
  );
};

const ReviewForm = ({
  port,
  scope,
  target,
  purpose,
  reviews,
  now,
  onEdit,
}: {
  readonly port: ExperienceReviewPort;
  readonly scope: ExperienceScope;
  readonly target: ReviewTarget;
  readonly purpose: AcceptedReview["purpose"];
  readonly reviews: readonly AcceptedReview[];
  readonly now: string;
  readonly onEdit: () => void;
}) => {
  const formId = useId();
  const [decision, setDecision] = useState<AcceptedReview["decision"] | null>(
    null
  );
  const [acknowledgedTarget, setAcknowledgedTarget] =
    useState<ReviewTarget | null>(null);
  const [confirmedPredecessor, setConfirmedPredecessor] = useState<
    string | null
  >(null);
  const [submitted, setSubmitted] = useState(false);
  const started = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const decide = useMemo(
    () => async (command: ReviewDecisionCommand, signal: AbortSignal) =>
      validateReviewResponse(
        command,
        await port.decide(command, signal),
        new Date().toISOString()
      ),
    [port]
  );
  const { resource, state } = useExperienceResource(decide);
  const model = buildReviewModel({ scope, target, purpose, reviews, now });
  const choose = (value: AcceptedReview["decision"]) => {
    onEdit();
    resource.clear();
    setDecision(value);
    setAcknowledgedTarget(null);
    setConfirmedPredecessor(null);
    return setError(null);
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (started.current) return;
    try {
      const command = buildReviewDecisionCommand({
        scope,
        target,
        purpose,
        reviews,
        now: new Date().toISOString(),
        decision,
        acknowledged: acknowledgedTarget !== null,
        acknowledgedTarget,
        expectedReviewId: confirmedPredecessor,
        idempotencyKey: `review-${crypto.randomUUID()}`,
      });
      onEdit();
      started.current = true;
      setSubmitted(true);
      setAcknowledgedTarget(null);
      return void resource.load(command);
    } catch (failure) {
      return setError(failureText(failure));
    }
  };
  return (
    <div className="vx-ex-stack">
      <form
        className="vx-ex-form"
        onSubmit={submit}
        aria-label="Exact artifact review"
      >
        <fieldset disabled={submitted || model.status === "invalid"}>
          <legend>Explicit decision for this artifact</legend>
          <label className="vx-ex-choice">
            <input
              type="radio"
              name={`${formId}-decision`}
              checked={decision === "accepted"}
              onChange={() => choose("accepted")}
            />
            Accept for {purpose} only
          </label>
          <label className="vx-ex-choice">
            <input
              type="radio"
              name={`${formId}-decision`}
              checked={decision === "rejected"}
              onChange={() => choose("rejected")}
            />
            Reject for {purpose}
          </label>
          <label className="vx-ex-choice">
            <input
              type="checkbox"
              checked={acknowledgedTarget !== null}
              onChange={(event) => {
                onEdit();
                resource.clear();
                setAcknowledgedTarget(event.target.checked ? target : null);
                setConfirmedPredecessor(
                  event.target.checked ? model.expectedReviewId : null
                );
                return setError(null);
              }}
            />
            <span>
              I reviewed artifact {target.artifactId}, SHA-256 {target.sha256},
              bound to strategyVersion {target.strategyVersion}. This records no
              execution authority.
            </span>
          </label>
        </fieldset>
        <p className="vx-caption">
          The server sets the actor, policy and expiry. A concurrent decision
          causes a predecessor conflict. It does not overwrite a review.
        </p>
        <Button
          type="submit"
          disabled={
            submitted ||
            decision === null ||
            acknowledgedTarget === null ||
            model.status === "invalid"
          }
        >
          Record exact-artifact decision
        </Button>
        {error === null ? null : <p role="alert">{error}</p>}
      </form>
      {submitted ? (
        <ResourcePanel
          state={state}
          title="Review decision"
          action
          children={(review) => (
            <ReadNotice title={`Server recorded ${review.decision}`}>
              Review {review.reviewId} / {review.reviewVersion}, actor{" "}
              {review.actorId}, policy {review.policyVersion}, expires{" "}
              {review.expiresAt}. Reload the dossier before another decision or
              simulation; this response is not an admission.
            </ReadNotice>
          )}
        />
      ) : null}
    </div>
  );
};

const SimulationSelector = ({
  scope,
  dossier,
  draft,
  now,
}: {
  readonly scope: ExperienceScope;
  readonly dossier: StrategyDossier;
  readonly draft: ImmutableArtifact<TradeIntent>;
  readonly now: string;
}) => {
  const services = useExperienceServices();
  const [admissionId, setAdmissionId] = useState("");
  const admission =
    dossier.admissions.find((item) => item.admissionId === admissionId) ?? null;
  if (services.jobs === null)
    return (
      <ReadNotice title="Paper simulation queue unavailable">
        The job service is not configured. An accepted review alone cannot
        create an admission or queue work.
      </ReadNotice>
    );
  if (dossier.admissions.length === 0)
    return (
      <ReadNotice title="No server-supplied admission">
        A current PAPER-SIMULATION admission is required. It must match the
        exact draft and latest accepted review.
      </ReadNotice>
    );
  return (
    <section className="vx-ex-section">
      <h3>Paper simulation queue</h3>
      <p>
        Simulation does not grant broker submission, paper-broker permission or
        live authority. Queued status does not confirm execution.
      </p>
      <label>
        Server-supplied admission
        <select
          value={admissionId}
          onChange={(event) => setAdmissionId(event.target.value)}
        >
          <option value="">Choose an exact admission</option>
          {dossier.admissions.map((item) => (
            <option key={item.admissionId} value={item.admissionId}>
              {item.admissionId} · review {item.reviewId} · expires{" "}
              {item.expiresAt}
            </option>
          ))}
        </select>
      </label>
      {admission === null ? (
        <p>No admission selected. Nothing can be queued.</p>
      ) : (
        <SimulationQueueForm
          key={JSON.stringify(admission)}
          port={services.jobs}
          scope={scope}
          dossier={dossier}
          draft={draft}
          admission={admission}
          now={now}
        />
      )}
    </section>
  );
};

const SimulationQueueForm = ({
  port,
  scope,
  dossier,
  draft,
  admission,
  now,
}: {
  readonly port: ExperienceJobPort;
  readonly scope: ExperienceScope;
  readonly dossier: StrategyDossier;
  readonly draft: ImmutableArtifact<TradeIntent>;
  readonly admission: PaperSimulationAdmission;
  readonly now: string;
}) => {
  const [acknowledged, setAcknowledged] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const started = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const queue = useMemo(
    () => async (command: SimulationProposalCommand, signal: AbortSignal) =>
      validateSimulationQueueReceipt(
        command,
        await port.proposeSimulation(command, signal)
      ),
    [port]
  );
  const { resource, state } = useExperienceResource(queue);
  let blocked: string | null = null;
  try {
    buildSimulationProposalCommand({
      scope,
      strategy: dossier.strategy,
      draft,
      reviews: dossier.reviews,
      admission,
      acknowledged: true,
      acknowledgedAdmissionId: admission.admissionId,
      now,
    });
  } catch (failure) {
    blocked = failureText(failure);
  }
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (started.current) return;
    try {
      const command = buildSimulationProposalCommand({
        scope,
        strategy: dossier.strategy,
        draft,
        reviews: dossier.reviews,
        admission,
        acknowledged,
        acknowledgedAdmissionId: acknowledged ? admission.admissionId : null,
        now: new Date().toISOString(),
      });
      started.current = true;
      setSubmitted(true);
      setAcknowledged(false);
      setError(null);
      return void resource.load(command);
    } catch (failure) {
      return setError(failureText(failure));
    }
  };
  return (
    <div className="vx-ex-stack">
      <ArtifactFacts
        entries={[
          [
            "Admission kind / ID",
            `${admission.admissionKind} / ${admission.admissionId}`,
          ],
          [
            "Server actor / policy",
            `${admission.actorId} / ${admission.policyVersion}`,
          ],
          [
            "Simulator / stream / epoch",
            `${admission.simulatorId} / ${admission.streamId} / ${admission.ownerEpoch}`,
          ],
          ["Exact intent hash", admission.intentSha256],
          [
            "Review ID / version",
            `${admission.reviewId} / ${admission.reviewVersion}`,
          ],
          [
            "Portfolio snapshot / sequence",
            `${admission.portfolioSnapshotId} / ${admission.portfolioSequence}`,
          ],
          [
            "Maximum loss / notional",
            `${admission.maximumLoss} / ${admission.maximumNotional}`,
          ],
          ["Admitted", admission.admittedAt],
          ["Expires", admission.expiresAt],
        ]}
      />
      {blocked === null ? null : (
        <ReadNotice title="Admission is not eligible">{blocked}</ReadNotice>
      )}
      <form
        className="vx-ex-form"
        onSubmit={submit}
        aria-label="Queue admitted paper simulation"
      >
        <label className="vx-ex-choice">
          <input
            type="checkbox"
            checked={acknowledged}
            disabled={submitted || blocked !== null}
            onChange={(event) => {
              resource.clear();
              setAcknowledged(event.target.checked);
              return setError(null);
            }}
          />
          <span>
            I request simulation only under admission {admission.admissionId},
            for draft {draft.artifactId}, SHA-256 {draft.sha256}, review{" "}
            {admission.reviewId}. This never submits an order to a broker.
          </span>
        </label>
        <Button
          type="submit"
          disabled={submitted || blocked !== null || !acknowledged}
        >
          Queue admitted paper simulation
        </Button>
        {error === null ? null : <p role="alert">{error}</p>}
      </form>
      {submitted ? (
        <ResourcePanel
          state={state}
          title="Paper simulation request"
          action
          children={(receipt) => (
            <ReadNotice title="Simulation queued">
              Job {receipt.jobId} acknowledges admission {receipt.admissionId}.
              This does not confirm execution or fills. It does not grant broker
              permission or live authorization. Inspect Agents & runs and Audit
              for later observations.
            </ReadNotice>
          )}
        />
      ) : null}
    </div>
  );
};
