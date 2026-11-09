"use client";

import { lessonSlugOfStrategy } from "@darkfactory/academy/courses";
import {
  STRATEGY_STATUS_VALUES,
  type StrategyGetOutput,
  type StrategyParamOutput,
  type StrategyPresetOutput,
  type StrategyStatusValue,
} from "@darkfactory/api";
import {
  Badge,
  Button,
  Input,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
} from "@darkfactory/ui";
import { Copy, Save, Trash2, Upload } from "lucide-react";
import { type KeyboardEvent, useEffect, useState } from "react";
import {
  formatTimestamp,
  InfoGlyph,
  type StrategyLibraryGateway,
} from "./agent-ops-client.tsx";
import {
  formatPercent,
  formatReported,
  reportedSharpe,
} from "./backtests-workspace.tsx";
import { newRequestHref } from "./deployment-requests-model.ts";
import type { ResearchStudyGateway } from "./filter-studies-section.tsx";
import {
  QcPortDefinitionLink,
  StrategyBacktestStudy,
} from "./strategy-backtest-study.tsx";
import { QC_IDEA_TAG } from "./strategy-backtest-study-model.ts";
import {
  descriptionLinks,
  EXTERNAL_CLAIM_HEADING,
  EXTERNAL_CLAIM_NOTICE,
  formatParamValue,
  formatPresetValues,
  formatRatio,
  formatSignedPercent,
  type PresetFormValues,
  parseParamsJson,
  parseTagsText,
  presetExportText,
  presetFormValues,
  presetValuesFromForm,
  STRATEGY_KIND_LABELS,
  STRATEGY_STATUS_LABELS,
  STRATEGY_TAB_LABELS,
  STRATEGY_TABS,
  type StrategyTab,
  strategyBadges,
} from "./strategy-library-model.ts";
import { ParamField, selectClass } from "./strategy-param-field.tsx";
import { StrategyReelStudy } from "./strategy-reel-study.tsx";
import { BACKTEST_STUDY_TAG } from "./strategy-reel-study-model.ts";

// External links from a strategy description (source dashboard, code), opened in a new tab.
export const StrategyLinks = ({
  description,
}: Readonly<{ description: string | null }>) => {
  const links = descriptionLinks(description);
  if (links.length === 0) return null;
  return (
    <p
      className="flex flex-wrap gap-x-3 gap-y-1 text-xs"
      data-click-private=""
      data-strategy-links=""
    >
      {links.map((link) => (
        <a
          className="inline-flex min-h-11 items-center underline underline-offset-2 hover:text-foreground"
          href={link.url}
          key={link.url}
          rel="noopener noreferrer"
          target="_blank"
        >
          {link.label}
        </a>
      ))}
    </p>
  );
};

// "High priority" and "Externally pre-validated" beside a strategy name (board rows, cards and the
// detail header). Text labels on theme tokens; nothing renders when neither applies.
export const StrategyBadges = ({
  strategy,
}: Readonly<{
  strategy: Pick<
    StrategyGetOutput["strategy"],
    "priority" | "externalValidation"
  >;
}>) => {
  const badges = strategyBadges(strategy);
  if (badges.length === 0) return null;
  return (
    <span className="inline-flex flex-wrap gap-1" data-strategy-badges="">
      {badges.map((badge) => (
        <Badge
          data-strategy-badge={badge.key}
          {...(badge.key === "high-priority"
            ? { "data-strategy-priority": "high" }
            : { "data-strategy-external-validation": "" })}
          key={badge.key}
          title={badge.hint}
          variant={badge.key === "high-priority" ? "default" : "outline"}
        >
          {badge.label}
          {badge.srText === null ? null : (
            <span className="sr-only">{badge.srText}</span>
          )}
        </Badge>
      ))}
    </span>
  );
};

// The third party's claim as published: source, author, date, claimed method and claimed metrics.
// Read-only; it carries no arm, order or deploy control.
const ExternalClaim = ({
  strategy,
}: Readonly<{ strategy: StrategyGetOutput["strategy"] }>) => {
  const claim = strategy.externalValidation;
  if (claim === null) return null;
  return (
    <section
      aria-labelledby="strategy-external-claim-heading"
      className="space-y-2 rounded-md border border-border p-3 text-xs [overflow-wrap:anywhere]"
      data-click-private=""
      data-strategy-external-claim={strategy.id}
    >
      <h3 className="font-medium text-sm" id="strategy-external-claim-heading">
        {EXTERNAL_CLAIM_HEADING}
      </h3>
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1">
        <dt className="text-muted-foreground">Source</dt>
        <dd>
          <a
            className="inline-flex min-h-11 items-center underline underline-offset-2 hover:text-foreground"
            data-strategy-external-claim-source=""
            href={claim.sourceUrl}
            rel="noreferrer noopener"
            target="_blank"
          >
            {claim.sourceTitle}
          </a>
        </dd>
        <dt className="text-muted-foreground">Author</dt>
        <dd data-external-claim-author="">{claim.sourceAuthor}</dd>
        <dt className="text-muted-foreground">Published</dt>
        <dd className="font-mono" data-external-claim-published="">
          <time dateTime={claim.publishedOn}>{claim.publishedOn}</time>
        </dd>
        <dt className="text-muted-foreground">Claimed method</dt>
        <dd data-external-claim-method="">{claim.claimedMethod}</dd>
      </dl>
      <h4 className="text-muted-foreground">Claimed metrics</h4>
      <dl
        className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1"
        data-external-claim-metrics=""
      >
        {claim.claimedMetrics.map((metric, index) => (
          <div className="contents" key={index}>
            <dt className="text-muted-foreground">{metric.label}</dt>
            <dd className="font-mono">{metric.value}</dd>
          </div>
        ))}
      </dl>
      <p data-external-claim-notice="">{EXTERNAL_CLAIM_NOTICE}</p>
    </section>
  );
};

const cell = "py-1 pr-3";
const headCell = "py-1 pr-3 font-normal";
const linkButton =
  "inline-flex min-h-11 items-center rounded-md border border-border px-3 text-sm underline-offset-2 hover:underline";

type Detail = StrategyGetOutput;

export interface StrategyDetailProps {
  readonly describeFailure: (error: unknown) => string;
  readonly detail: Detail;
  readonly gateway: StrategyLibraryGateway;
  // Reloads detail and board after a successful write.
  readonly onChanged: () => Promise<void>;
  readonly onClose: () => void;
  readonly onTab: (tab: StrategyTab) => void;
  // researchStudies.get for the Backtest study section (QuantConnect idea ports and entries tagged
  // backtest-study); the browser API by default.
  readonly researchStudies?: ResearchStudyGateway;
  readonly tab: StrategyTab;
}

// Roving focus for the tab list: arrows move and select (wrapping), Home/End jump.
const tabKeyTarget = (
  key: string,
  current: StrategyTab
): StrategyTab | null => {
  const count = STRATEGY_TABS.length;
  const index = STRATEGY_TABS.indexOf(current);
  const target =
    key === "ArrowRight"
      ? (index + 1) % count
      : key === "ArrowLeft"
        ? (index - 1 + count) % count
        : key === "Home"
          ? 0
          : key === "End"
            ? count - 1
            : null;
  // Every target is an index of STRATEGY_TABS.
  return target === null ? null : (STRATEGY_TABS[target] as StrategyTab);
};

const Message = ({
  text,
  tone,
}: {
  readonly text: string;
  readonly tone: "status" | "alert";
}) => {
  if (text === "")
    return <div aria-live="polite" className="min-h-5 text-sm" role="status" />;
  return (
    <p
      className={`min-h-5 text-sm ${tone === "alert" ? "text-destructive" : ""}`}
      role={tone}
    >
      {text}
    </p>
  );
};

const OverviewTab = ({
  detail,
  gateway,
  onChanged,
  describeFailure,
}: Pick<
  StrategyDetailProps,
  "detail" | "gateway" | "onChanged" | "describeFailure"
>) => {
  const { strategy } = detail;
  const [name, setName] = useState(strategy.name);
  const [status, setStatus] = useState<StrategyStatusValue>(strategy.status);
  const [section, setSection] = useState(strategy.section ?? "");
  const [tags, setTags] = useState(strategy.tags.join(", "));
  const [sourceRef, setSourceRef] = useState(strategy.sourceRef ?? "");
  const [description, setDescription] = useState(strategy.description ?? "");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{
    text: string;
    tone: "status" | "alert";
  }>({ text: "", tone: "status" });
  const latest = strategy.latestBacktest;

  const save = async (): Promise<void> => {
    setBusy(true);
    try {
      await gateway.update({
        description,
        id: strategy.id,
        name,
        section,
        sourceRef,
        status,
        tags: parseTagsText(tags),
      });
      setMessage({ text: "Saved.", tone: "status" });
      await onChanged();
    } catch (error) {
      setMessage({ text: describeFailure(error), tone: "alert" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <ExternalClaim strategy={strategy} />
      <form
        className="grid gap-3 md:grid-cols-2"
        data-strategy-overview-form=""
        onSubmit={(event) => {
          event.preventDefault();
          return void save();
        }}
      >
        <label className="text-xs">
          Name
          <Input
            maxLength={200}
            onChange={(event) => setName(event.target.value)}
            required
            value={name}
          />
        </label>
        <label className="text-xs">
          Status
          <select
            aria-label="Status"
            className={selectClass}
            onChange={(event) =>
              setStatus(event.target.value as StrategyStatusValue)
            }
            value={status}
          >
            {STRATEGY_STATUS_VALUES.map((value) => {
              return (
                <option key={value} value={value}>
                  {STRATEGY_STATUS_LABELS[value]}
                </option>
              );
            })}
          </select>
        </label>
        <label className="text-xs">
          Section
          <InfoGlyph text="Operator folder for grouping the board. Blank means Unsorted." />
          <Input
            maxLength={80}
            onChange={(event) => setSection(event.target.value)}
            value={section}
          />
        </label>
        <label className="text-xs">
          Tags
          <InfoGlyph text="Comma-separated; up to 20 tags of at most 32 characters." />
          <Input
            onChange={(event) => setTags(event.target.value)}
            value={tags}
          />
        </label>
        <label className="text-xs md:col-span-2">
          Source ref
          <InfoGlyph text="Repository-relative path with an optional @revision, for example services/research/strategies/hmm.py@36ca13b." />
          <Input
            className="font-mono"
            maxLength={300}
            onChange={(event) => setSourceRef(event.target.value)}
            value={sourceRef}
          />
        </label>
        <label className="text-xs md:col-span-2">
          Description
          <Textarea
            maxLength={2000}
            onChange={(event) => setDescription(event.target.value)}
            rows={3}
            value={description}
          />
        </label>
        <div className="md:col-span-2">
          <Button disabled={busy} type="submit">
            <Save aria-hidden="true" className="size-4" />
            Save overview
          </Button>
        </div>
      </form>
      <Message text={message.text} tone={message.tone} />
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1 text-xs [overflow-wrap:anywhere]">
        <dt className="text-muted-foreground">Kind</dt>
        <dd>{STRATEGY_KIND_LABELS[strategy.kind] ?? strategy.kind}</dd>
        <dt className="text-muted-foreground">Slug</dt>
        <dd className="font-mono">{strategy.slug}</dd>
        <dt className="text-muted-foreground">Created (UTC)</dt>
        <dd className="font-mono">{formatTimestamp(strategy.createdAt)}</dd>
        <dt className="text-muted-foreground">Updated (UTC)</dt>
        <dd className="font-mono">{formatTimestamp(strategy.updatedAt)}</dd>
        <dt className="text-muted-foreground">
          Latest backtest
          <InfoGlyph text="Sharpe, total return and max drawdown derived by the server from the latest linked backtest's reported equity." />
        </dt>
        <dd className="font-mono" data-latest-backtest="">
          {latest === null
            ? "—"
            : `Sharpe ${formatRatio(latest.sharpe)} · return ${formatSignedPercent(latest.totalReturn)} · max DD ${formatPercent(latest.maxDrawdown)}`}
        </dd>
      </dl>
    </div>
  );
};

const SchemaTable = ({
  params,
}: {
  readonly params: readonly StrategyParamOutput[];
}) => {
  if (params.length === 0)
    return <p className="text-muted-foreground text-xs">No parameters.</p>;
  return (
    <div className="relative overflow-x-auto">
      <Table className="w-full min-w-[40rem] text-xs" data-params-table="">
        <TableCaption className="sr-only">Parameter schema</TableCaption>
        <TableHeader>
          <TableRow className="border-border border-b text-left text-muted-foreground">
            <TableHead
              className={`${headCell} text-muted-foreground`}
              scope="col"
            >
              Name
            </TableHead>
            <TableHead
              className={`${headCell} text-muted-foreground`}
              scope="col"
            >
              Title
            </TableHead>
            <TableHead
              className={`${headCell} text-muted-foreground`}
              scope="col"
            >
              Type
            </TableHead>
            <TableHead
              className={`${headCell} text-muted-foreground`}
              scope="col"
            >
              Default
            </TableHead>
            <TableHead
              className={`${headCell} text-muted-foreground`}
              scope="col"
            >
              Min
            </TableHead>
            <TableHead
              className={`${headCell} text-muted-foreground`}
              scope="col"
            >
              Max
            </TableHead>
            <TableHead
              className={`${headCell} text-muted-foreground`}
              scope="col"
            >
              Step
            </TableHead>
            <TableHead
              className={`${headCell} text-muted-foreground`}
              scope="col"
            >
              Options
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {params.map((param) => {
            return (
              <TableRow
                className="border-border border-b"
                data-param={param.name}
                key={param.name}
              >
                <TableHead
                  className={`${headCell} whitespace-normal font-mono`}
                  scope="row"
                >
                  {param.name}
                </TableHead>
                <TableCell className={`${cell} whitespace-normal`}>
                  {param.title}
                </TableCell>
                <TableCell className={`${cell} whitespace-normal`}>
                  {param.type}
                </TableCell>
                <TableCell className={`${cell} whitespace-normal font-mono`}>
                  {formatParamValue(param.default)}
                </TableCell>
                <TableCell className={`${cell} whitespace-normal font-mono`}>
                  {formatParamValue(param.min)}
                </TableCell>
                <TableCell className={`${cell} whitespace-normal font-mono`}>
                  {formatParamValue(param.max)}
                </TableCell>
                <TableCell className={`${cell} whitespace-normal font-mono`}>
                  {formatParamValue(param.step)}
                </TableCell>
                <TableCell className={`${cell} whitespace-normal`}>
                  {param.options === undefined ? "—" : param.options.join(", ")}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
};

const ParametersTab = ({
  detail,
  gateway,
  onChanged,
  describeFailure,
}: Pick<
  StrategyDetailProps,
  "detail" | "gateway" | "onChanged" | "describeFailure"
>) => {
  const { strategy, presets } = detail;
  const params = strategy.params;
  const [schemaText, setSchemaText] = useState(JSON.stringify(params, null, 2));
  const [schemaMessage, setSchemaMessage] = useState<{
    text: string;
    tone: "status" | "alert";
  }>({ text: "", tone: "status" });
  const [presetName, setPresetName] = useState("");
  const [form, setForm] = useState<PresetFormValues>(() =>
    presetFormValues(params)
  );
  const [presetMessage, setPresetMessage] = useState<{
    text: string;
    tone: "status" | "alert";
  }>({ text: "", tone: "status" });
  const [exported, setExported] = useState<{
    name: string;
    text: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);

  // Reset editors only when the stored schema itself changes, not on every reload.
  const schemaKey = JSON.stringify(params);
  useEffect(() => {
    const stored = JSON.parse(schemaKey) as StrategyParamOutput[];
    setSchemaText(JSON.stringify(stored, null, 2));
    setForm(presetFormValues(stored));
    return;
  }, [schemaKey]);

  const saveSchema = async (): Promise<void> => {
    const parsed = parseParamsJson(schemaText);
    if (typeof parsed === "string") {
      setSchemaMessage({ text: parsed, tone: "alert" });
      return;
    }
    setBusy(true);
    try {
      await gateway.update({
        id: strategy.id,
        params: parsed as Record<string, unknown>[],
      });
      setSchemaMessage({ text: "Schema saved.", tone: "status" });
      await onChanged();
    } catch (error) {
      setSchemaMessage({ text: describeFailure(error), tone: "alert" });
    } finally {
      setBusy(false);
    }
  };

  const savePreset = async (): Promise<void> => {
    if (presetName.trim() === "") {
      setPresetMessage({ text: "Preset name is required.", tone: "alert" });
      return;
    }
    const values = presetValuesFromForm(params, form);
    if (typeof values === "string") {
      setPresetMessage({ text: values, tone: "alert" });
      return;
    }
    setBusy(true);
    try {
      const preset = await gateway.savePreset({
        name: presetName,
        strategyId: strategy.id,
        values,
      });
      setPresetMessage({
        text: `Saved preset ${preset.name}.`,
        tone: "status",
      });
      setPresetName("");
      await onChanged();
    } catch (error) {
      setPresetMessage({ text: describeFailure(error), tone: "alert" });
    } finally {
      setBusy(false);
    }
  };

  const removePreset = async (preset: StrategyPresetOutput): Promise<void> => {
    setBusy(true);
    try {
      await gateway.removePreset(strategy.id, preset.id);
      setPresetMessage({
        text: `Deleted preset ${preset.name}.`,
        tone: "status",
      });
      if (exported?.name === preset.name) setExported(null);
      await onChanged();
    } catch (error) {
      setPresetMessage({ text: describeFailure(error), tone: "alert" });
    } finally {
      setBusy(false);
    }
  };

  const copyPreset = async (preset: StrategyPresetOutput): Promise<void> => {
    const text = presetExportText(strategy.slug, preset, params);
    setExported({ name: preset.name, text });
    try {
      await navigator.clipboard.writeText(text);
      setPresetMessage({
        text: `Copied preset ${preset.name}.`,
        tone: "status",
      });
    } catch {
      setPresetMessage({
        text: `Clipboard unavailable; preset ${preset.name} text is shown below.`,
        tone: "status",
      });
    }
  };

  const loadPreset = (preset: StrategyPresetOutput): void => {
    setForm(presetFormValues(params, preset.values));
    setPresetName(preset.name);
    setPresetMessage({ text: `Loaded preset ${preset.name}.`, tone: "status" });
  };

  return (
    <div className="space-y-6">
      <section aria-labelledby="strategy-schema-heading" className="space-y-2">
        <h3 className="font-medium text-sm" id="strategy-schema-heading">
          Schema
        </h3>
        <SchemaTable params={params} />
      </section>
      <section
        aria-labelledby="strategy-schema-edit-heading"
        className="space-y-2"
      >
        <h3 className="font-medium text-sm" id="strategy-schema-edit-heading">
          Edit schema (JSON)
          <InfoGlyph text="Array of up to 60 objects: name (identifier), title, type integer|decimal|boolean|choice, default, optional min, max, step (numeric types) or options (choice). Saving is refused while a preset would no longer fit." />
        </h3>
        <Textarea
          aria-label="Params schema JSON"
          className="min-h-48 font-mono text-xs"
          onChange={(event) => setSchemaText(event.target.value)}
          spellCheck={false}
          value={schemaText}
        />
        <Button disabled={busy} onClick={() => void saveSchema()} type="button">
          <Save aria-hidden="true" className="size-4" />
          Save schema
        </Button>
        <Message text={schemaMessage.text} tone={schemaMessage.tone} />
      </section>
      <section aria-labelledby="strategy-presets-heading" className="space-y-2">
        <h3 className="font-medium text-sm" id="strategy-presets-heading">
          Presets
        </h3>
        {presets.length === 0 ? (
          <p className="text-muted-foreground text-xs">No presets.</p>
        ) : (
          <div className="relative overflow-x-auto">
            <Table
              className="w-full min-w-[40rem] text-xs"
              data-click-private=""
            >
              <TableCaption className="sr-only">Presets</TableCaption>
              <TableHeader>
                <TableRow className="border-border border-b text-left text-muted-foreground">
                  <TableHead
                    className={`${headCell} text-muted-foreground`}
                    scope="col"
                  >
                    Name
                  </TableHead>
                  <TableHead
                    className={`${headCell} text-muted-foreground`}
                    scope="col"
                  >
                    Values
                  </TableHead>
                  <TableHead
                    className={`${headCell} text-muted-foreground`}
                    scope="col"
                  >
                    Saved (UTC)
                  </TableHead>
                  <TableHead
                    className={`${headCell} text-muted-foreground`}
                    scope="col"
                  >
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {presets.map((preset) => {
                  return (
                    <TableRow
                      className="border-border border-b [&>td]:align-top [&>th]:align-top"
                      data-preset={preset.name}
                      key={preset.id}
                    >
                      <TableHead
                        className={`${headCell} whitespace-normal`}
                        scope="row"
                      >
                        {preset.name}
                      </TableHead>
                      <TableCell
                        className={`${cell} whitespace-normal font-mono`}
                      >
                        {formatPresetValues(preset.values)}
                      </TableCell>
                      <TableCell
                        className={`${cell} whitespace-normal font-mono text-muted-foreground`}
                      >
                        {formatTimestamp(preset.updatedAt)}
                      </TableCell>
                      <TableCell
                        className={`${cell} whitespace-normal text-right`}
                      >
                        <div className="flex flex-wrap justify-end gap-1">
                          <Button
                            aria-label={`Load ${preset.name}`}
                            disabled={busy}
                            onClick={() => loadPreset(preset)}
                            size="compact"
                            type="button"
                            variant="secondary"
                          >
                            <Upload aria-hidden="true" className="size-4" />
                            Load
                          </Button>
                          <Button
                            aria-label={`Copy ${preset.name}`}
                            onClick={() => void copyPreset(preset)}
                            size="compact"
                            type="button"
                            variant="secondary"
                          >
                            <Copy aria-hidden="true" className="size-4" />
                            Copy
                          </Button>
                          <Button
                            aria-label={`Delete ${preset.name}`}
                            disabled={busy}
                            onClick={() => void removePreset(preset)}
                            size="compact"
                            type="button"
                            variant="secondary"
                          >
                            <Trash2 aria-hidden="true" className="size-4" />
                            Delete
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
        {exported === null ? null : (
          <pre
            aria-label={`Preset ${exported.name} as text`}
            className="overflow-x-auto rounded-md border border-border p-2 text-xs"
            data-preset-export={exported.name}
            role="region"
          >
            {exported.text}
          </pre>
        )}
        <Message text={presetMessage.text} tone={presetMessage.tone} />
      </section>
      <section
        aria-labelledby="strategy-preset-save-heading"
        className="space-y-2"
      >
        <h3 className="font-medium text-sm" id="strategy-preset-save-heading">
          Save preset
          <InfoGlyph text="Saves the values below under a name; an existing preset with the same name is replaced." />
        </h3>
        {params.length === 0 ? (
          <p className="text-muted-foreground text-xs">
            Define parameters first.
          </p>
        ) : (
          <form
            className="space-y-3"
            data-preset-form=""
            onSubmit={(event) => {
              event.preventDefault();
              return void savePreset();
            }}
          >
            <label className="block max-w-sm text-xs">
              Preset name
              <Input
                maxLength={80}
                onChange={(event) => setPresetName(event.target.value)}
                value={presetName}
              />
            </label>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {params.map((param) => {
                return (
                  <ParamField
                    key={param.name}
                    onChange={(value) =>
                      setForm((current) => ({
                        ...current,
                        [param.name]: value,
                      }))
                    }
                    param={param}
                    value={form[param.name]}
                  />
                );
              })}
            </div>
            <Button disabled={busy} type="submit">
              <Save aria-hidden="true" className="size-4" />
              Save preset
            </Button>
          </form>
        )}
      </section>
    </div>
  );
};

const BacktestsTab = ({
  detail,
  researchStudies,
}: {
  readonly detail: Detail;
  readonly researchStudies: ResearchStudyGateway | undefined;
}) => {
  const { strategy, backtests } = detail;
  const latest = strategy.latestBacktest;
  return (
    <div className="space-y-3">
      {/* QuantConnect idea ports and entries tagged backtest-study keep their backtest study in
          research_studies under the slug; QuantConnect idea ports also link their stored strategy
          definition (Run backtest opens Backtest runs with it). */}
      {strategy.tags.includes(QC_IDEA_TAG) ? (
        <>
          <QcPortDefinitionLink
            params={strategy.params}
            strategyId={strategy.id}
          />
          <StrategyBacktestStudy
            gateway={researchStudies}
            key={strategy.slug}
            slug={strategy.slug}
          />
        </>
      ) : null}
      {strategy.tags.includes(BACKTEST_STUDY_TAG) ? (
        <StrategyReelStudy
          gateway={researchStudies}
          key={strategy.slug}
          slug={strategy.slug}
        />
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs" data-latest-summary="">
          <span className="text-muted-foreground">Latest</span>
          <InfoGlyph text="Derived by the server from the latest linked backtest's reported equity; the Sharpe sort uses this value." />
          <span className="ml-2 font-mono">
            {latest === null
              ? "—"
              : `Sharpe ${formatRatio(latest.sharpe)} · return ${formatSignedPercent(latest.totalReturn)} · CAGR ${formatSignedPercent(latest.cagr)}`}
          </span>
        </p>
        <div className="flex flex-wrap gap-2">
          <a
            className={linkButton}
            data-strategy-rerun={strategy.id}
            href={`/backtest-runs?strategy=${encodeURIComponent(strategy.id)}&universe=core7-futures`}
          >
            Re-run on Core 7 futures
          </a>
          <a
            className={linkButton}
            data-strategy-optimizations={strategy.id}
            href={`/optimizations?strategy=${encodeURIComponent(strategy.id)}`}
          >
            Optimizations
          </a>
        </div>
      </div>
      {backtests.length === 0 ? (
        <p className="text-muted-foreground text-xs">
          No linked backtests.{" "}
          <InfoGlyph text="Agents link a result by passing strategyId to agentOps.backtests.record." />
        </p>
      ) : (
        <div className="relative overflow-x-auto">
          <Table
            className="w-full min-w-[48rem] text-sm"
            data-click-private=""
            data-strategy-backtests=""
          >
            <TableCaption className="sr-only">Linked backtests</TableCaption>
            <TableHeader>
              <TableRow className="border-border border-b text-left text-muted-foreground text-xs">
                <TableHead
                  className={`${headCell} text-muted-foreground`}
                  scope="col"
                >
                  Label
                </TableHead>
                <TableHead
                  className={`${headCell} text-muted-foreground`}
                  scope="col"
                >
                  Instruments
                </TableHead>
                <TableHead
                  className={`${headCell} text-muted-foreground`}
                  scope="col"
                >
                  Period
                </TableHead>
                <TableHead
                  className={`${headCell} text-right text-muted-foreground`}
                  scope="col"
                >
                  Sharpe
                  <InfoGlyph text="Reported metric sharpe (or sharpe_ratio), as submitted." />
                </TableHead>
                <TableHead
                  className={`${headCell} text-right text-muted-foreground`}
                  scope="col"
                >
                  Max DD
                  <InfoGlyph text="Derived server-side from the reported equity series." />
                </TableHead>
                <TableHead
                  className={`${headCell} text-right text-muted-foreground`}
                  scope="col"
                >
                  Trades
                </TableHead>
                <TableHead
                  className={`${headCell} text-muted-foreground`}
                  scope="col"
                >
                  Task
                </TableHead>
                <TableHead
                  className={`${headCell} text-muted-foreground`}
                  scope="col"
                >
                  Recorded (UTC)
                </TableHead>
                <TableHead
                  className={`${headCell} text-muted-foreground`}
                  scope="col"
                >
                  <span className="sr-only">Open</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {backtests.map((row) => {
                return (
                  <TableRow
                    className="border-border border-b [&>td]:align-top [&>th]:align-top"
                    data-linked-backtest={row.id}
                    key={row.id}
                  >
                    <TableHead
                      className={`${headCell} whitespace-normal`}
                      scope="row"
                    >
                      {row.strategy}
                    </TableHead>
                    <TableCell className={`${cell} whitespace-normal text-xs`}>
                      {row.instruments}
                    </TableCell>
                    <TableCell
                      className={`${cell} whitespace-normal font-mono text-xs`}
                    >
                      {row.periodStart} to {row.periodEnd}
                    </TableCell>
                    <TableCell
                      className={`${cell} whitespace-normal text-right font-mono text-xs`}
                    >
                      {formatReported(reportedSharpe(row.metrics))}
                    </TableCell>
                    <TableCell
                      className={`${cell} whitespace-normal text-right font-mono text-xs`}
                    >
                      {formatPercent(row.maxDrawdown)}
                    </TableCell>
                    <TableCell
                      className={`${cell} whitespace-normal text-right font-mono text-xs`}
                    >
                      {row.tradeCount}
                    </TableCell>
                    <TableCell className={`${cell} whitespace-normal text-xs`}>
                      {row.taskTitle ?? row.taskId}
                    </TableCell>
                    <TableCell
                      className={`${cell} whitespace-normal font-mono text-muted-foreground text-xs`}
                    >
                      {formatTimestamp(row.createdAt)}
                    </TableCell>
                    <TableCell
                      className={`${cell} whitespace-normal text-right`}
                    >
                      <a
                        aria-label={`Open backtest ${row.strategy}`}
                        className={linkButton}
                        href={`/backtests?id=${encodeURIComponent(row.id)}`}
                      >
                        Open
                      </a>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
};

export const StrategyDetail = ({
  detail,
  gateway,
  tab,
  onTab,
  onClose,
  onChanged,
  describeFailure,
  researchStudies,
}: StrategyDetailProps) => {
  const { strategy } = detail;
  // Lesson behind an Academy strategy of any course (dyr-*, qftg-*, ...), or null.
  const academyLesson = lessonSlugOfStrategy(strategy.slug);
  const onTabKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    const next = tabKeyTarget(event.key, tab);
    if (next === null) return;
    event.preventDefault();
    onTab(next);
    document.getElementById(`strategy-tab-${next}`)?.focus();
  };
  return (
    <section
      aria-labelledby="strategy-detail-heading"
      className="space-y-4 rounded-md border border-border p-4"
      data-strategy-detail={strategy.id}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2
            className="break-words font-medium text-base"
            id="strategy-detail-heading"
          >
            {strategy.name}
          </h2>
          <StrategyBadges strategy={strategy} />
          <p className="break-words text-muted-foreground text-xs [overflow-wrap:anywhere]">
            <span className="font-mono">{strategy.slug}</span> ·{" "}
            {STRATEGY_KIND_LABELS[strategy.kind] ?? strategy.kind} ·{" "}
            {STRATEGY_STATUS_LABELS[strategy.status]}
            {strategy.sourceRef === null ? null : (
              <>
                {" "}
                · <span className="font-mono">{strategy.sourceRef}</span>
              </>
            )}
          </p>
          <StrategyLinks description={strategy.description} />
        </div>
        <div className="flex flex-wrap gap-2">
          {/* Academy strategies deploy only from their lesson page (rule gates, password, audit).
              Strategies tagged research-only offer no deployment or order action at all. */}
          {strategy.tags.includes("research-only") ? (
            <span
              className="text-muted-foreground text-sm"
              data-strategy-research-only={strategy.id}
            >
              Research only: no deployment
            </span>
          ) : academyLesson === null ? (
            <a
              className={linkButton}
              data-strategy-request-deployment={strategy.id}
              href={newRequestHref(strategy.id)}
            >
              Request paper deployment
            </a>
          ) : (
            <a
              className={linkButton}
              data-strategy-academy-lesson={strategy.slug}
              href={`/academy/${academyLesson}#deploy`}
            >
              Deploy from the Academy lesson
            </a>
          )}
          <Button onClick={onClose} type="button" variant="secondary">
            Close
          </Button>
        </div>
      </div>
      <div
        aria-label="Strategy views"
        className="flex flex-wrap gap-1 border-border border-b"
        onKeyDown={onTabKey}
        role="tablist"
      >
        {STRATEGY_TABS.map((option) => {
          return (
            <button
              aria-controls={`strategy-panel-${option}`}
              aria-selected={tab === option}
              className={`min-h-11 border-b-2 px-3 text-sm ${tab === option ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
              data-tab={option}
              id={`strategy-tab-${option}`}
              key={option}
              onClick={() => onTab(option)}
              role="tab"
              tabIndex={tab === option ? 0 : -1}
              type="button"
            >
              {STRATEGY_TAB_LABELS[option]}
            </button>
          );
        })}
      </div>
      <div
        aria-labelledby={`strategy-tab-${tab}`}
        className="space-y-5"
        id={`strategy-panel-${tab}`}
        role="tabpanel"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: APG tabpanel: the panel is focusable so keyboard users reach its content.
        tabIndex={0}
      >
        {tab === "overview" ? (
          <OverviewTab
            describeFailure={describeFailure}
            detail={detail}
            gateway={gateway}
            key={strategy.id}
            onChanged={onChanged}
          />
        ) : tab === "parameters" ? (
          <ParametersTab
            describeFailure={describeFailure}
            detail={detail}
            gateway={gateway}
            key={strategy.id}
            onChanged={onChanged}
          />
        ) : (
          <BacktestsTab detail={detail} researchStudies={researchStudies} />
        )}
      </div>
    </section>
  );
};
