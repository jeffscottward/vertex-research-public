// HTML of the step-4 "current engine vs Nautilus" report page: one self-contained file with
// inline SVG charts (no images, no scripts). Every text from the data is escaped.
import type {
  FeatureSummary,
  ReportModel,
  Stats,
  TimelinePoint,
} from "./model.ts";

const DAY_MS = 86_400_000;

export const escapeHtml = (text: string): string =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

/** "0.30 ms", "12.3 ms", "1.25 s", "42 s". */
export const formatMs = (ms: number | null): string => {
  if (ms === null) return "-";
  if (ms < 10) return `${ms.toFixed(2)} ms`;
  if (ms < 1000) return `${ms.toFixed(1)} ms`;
  return ms < 10_000
    ? `${(ms / 1000).toFixed(2)} s`
    : `${(ms / 1000).toFixed(1)} s`;
};

const formatStats = (stats: Stats | null): string =>
  stats === null
    ? "-"
    : `${formatMs(stats.p50)} / ${formatMs(stats.p95)} (n=${stats.n})`;

const minute = (iso: string): string =>
  escapeHtml(`${iso.slice(0, 16).replace("T", " ")}Z`);

const KIND_COLORS: Readonly<Record<TimelinePoint["kind"], string>> = {
  differs: "#e8a33d",
  failed: "#e05252",
  matched: "#4caf50",
  nautilus: "#c9a54a",
  pending: "#5aa8e6",
  superseded: "#6b7280",
  unknown: "#9aa0a6",
};

const KIND_LABELS: Readonly<Record<TimelinePoint["kind"], string>> = {
  differs: "differs",
  failed: "failed",
  matched: "same result",
  nautilus: "Nautilus run without a TypeScript twin",
  pending: "queued or running",
  superseded: "superseded (a newer request replaced it)",
  unknown: "done, differences not readable",
};

const NAUTILUS_ROW = "Nautilus backtest runs";
/** Later kinds are drawn on top: a difference or failure is never hidden under a superseded run. */
const DRAW_ORDER: Readonly<Record<TimelinePoint["kind"], number>> = {
  differs: 4,
  failed: 5,
  matched: 3,
  nautilus: 2,
  pending: 1,
  superseded: 0,
  unknown: 3,
};

/** Timeline of every stored run with the worker outages shaded; the axis runs to the decision date. */
export const timelineSvg = (model: ReportModel): string => {
  const rows = [
    ...model.features.map((feature) => feature.title),
    NAUTILUS_ROW,
  ];
  const left = 190;
  const width = 1100;
  const plotWidth = width - left - 20;
  const top = 48;
  const rowHeight = 30;
  const plotBottom = top + rows.length * rowHeight;
  const height = plotBottom + 34;
  const from = Date.parse(model.windowFrom);
  const now = Date.parse(model.generatedAt);
  const decision = Date.parse(`${model.step4.decisionDate}T00:00:00.000Z`);
  const to = Math.max(now, decision + DAY_MS);
  const x = (at: number): number =>
    left +
    ((Math.min(Math.max(at, from), to) - from) / (to - from)) * plotWidth;
  const parts: string[] = [];
  const days = Math.round((to - from) / DAY_MS);
  const labelStep = Math.max(1, Math.ceil(days / 16));
  for (let day = 0; day <= days; day += 1) {
    const at = from + day * DAY_MS;
    parts.push(
      `<line x1="${x(at).toFixed(1)}" y1="${top}" x2="${x(at).toFixed(1)}" y2="${plotBottom}" stroke="#2a2e36"/>`
    );
    if (day % labelStep === 0)
      parts.push(
        `<text x="${x(at).toFixed(1)}" y="${plotBottom + 16}" fill="#8a8f98" font-size="11" text-anchor="middle">${new Date(at).toISOString().slice(5, 10)}</text>`
      );
  }
  for (const [index, outage] of model.outages.entries()) {
    const start = x(Date.parse(outage.from));
    const end = x(outage.to === null ? now : Date.parse(outage.to));
    parts.push(
      `<rect x="${start.toFixed(1)}" y="${top}" width="${Math.max(2, end - start).toFixed(1)}" height="${plotBottom - top}" fill="#e05252" fill-opacity="0.22"/>`,
      `<text x="${start.toFixed(1)}" y="${top - 8 - (index % 2) * 16}" fill="#e05252" font-size="12">worker outage ${outage.hours.toFixed(1)} h</text>`
    );
  }
  rows.forEach((row, index) => {
    const y = top + index * rowHeight + rowHeight / 2;
    parts.push(
      `<text x="${left - 8}" y="${y + 4}" fill="#e7e7e7" font-size="12" text-anchor="end">${escapeHtml(row)}</text>`
    );
    const points = model.timeline
      .filter((entry) => entry.row === row)
      .sort(
        (first, second) => DRAW_ORDER[first.kind] - DRAW_ORDER[second.kind]
      );
    for (const point of points)
      parts.push(
        `<circle cx="${x(Date.parse(point.at)).toFixed(1)}" cy="${y}" r="4" fill="${KIND_COLORS[point.kind]}" fill-opacity="0.75"/>`
      );
  });
  for (const [at, label, color] of [
    [now, "now", "#5aa8e6"],
    [decision, `decision ${model.step4.decisionDate}`, "#c9a54a"],
  ] as const)
    parts.push(
      `<line x1="${x(at).toFixed(1)}" y1="${top}" x2="${x(at).toFixed(1)}" y2="${plotBottom}" stroke="${color}" stroke-dasharray="4 3"/>`,
      `<text x="${(x(at) - 4).toFixed(1)}" y="${plotBottom + 30}" fill="${color}" font-size="11" text-anchor="end">${escapeHtml(label)}</text>`
    );
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="Timeline of stored comparison runs with worker outages"><rect width="${width}" height="${height}" fill="#0f1115"/>${parts.join("")}</svg>`;
};

/** Bars of the 2026-11-06 rig benchmark: TypeScript p50 vs Nautilus p50 (p95 as a tick). */
const benchmarkSvg = (model: ReportModel): string => {
  const rows = model.benchmark.rows;
  const left = 190;
  const width = 1100;
  const plotWidth = width - left - 220;
  const rowHeight = 56;
  const height = rows.length * rowHeight + 20;
  const max =
    Math.max(
      ...rows.flatMap((row) => [
        row.nautilus.p95Ms,
        row.typescript.p50Ms + model.benchmark.roundTripMs,
      ])
    ) * 1.05;
  const scale = (ms: number): number => (ms / max) * plotWidth;
  const parts = rows.map((row, index) => {
    const y = 10 + index * rowHeight;
    const ts = row.typescript.p50Ms + model.benchmark.roundTripMs;
    const nautilus = row.nautilus.p50Ms;
    return [
      `<text x="${left - 8}" y="${y + 26}" fill="#e7e7e7" font-size="12" text-anchor="end">${escapeHtml(row.label.replace(/ \(.*$/u, ""))}</text>`,
      `<rect x="${left}" y="${y}" width="${Math.max(2, scale(ts)).toFixed(1)}" height="18" fill="#c9a54a"/>`,
      `<text x="${(left + Math.max(2, scale(ts)) + 6).toFixed(1)}" y="${y + 13}" fill="#e7e7e7" font-size="11">TypeScript ${formatMs(ts)} incl. ${model.benchmark.roundTripMs} ms round trip</text>`,
      `<rect x="${left}" y="${y + 22}" width="${scale(nautilus).toFixed(1)}" height="18" fill="#5aa8e6"/>`,
      `<line x1="${(left + scale(row.nautilus.p95Ms)).toFixed(1)}" y1="${y + 20}" x2="${(left + scale(row.nautilus.p95Ms)).toFixed(1)}" y2="${y + 42}" stroke="#e7e7e7"/>`,
      `<text x="${(left + scale(row.nautilus.p95Ms) + 6).toFixed(1)}" y="${y + 35}" fill="#e7e7e7" font-size="11">Nautilus ${formatMs(nautilus)} (p95 ${formatMs(row.nautilus.p95Ms)}), ${row.nautilus.processes} process(es)</text>`,
    ].join("");
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="Rig benchmark 2026-11-06: time to result per feature"><rect width="${width}" height="${height}" fill="#0f1115"/>${parts.join("")}</svg>`;
};

const featureRow = (summary: FeatureSummary): string => {
  const cells = [
    `${escapeHtml(summary.title)}<br><span class="muted">step ${summary.step}</span>`,
    summary.runs === 0
      ? "none"
      : `${summary.runs} runs / ${summary.requests} request(s)${summary.truncated ? "<br><b>list limit reached: older runs not shown</b>" : ""}`,
    summary.span === null
      ? "-"
      : `${summary.days} day(s)<br><span class="muted">${minute(summary.span.first)} to ${minute(summary.span.last)}</span>`,
    `${summary.status.succeeded} ok, ${summary.status.failed - summary.superseded} failed, ${summary.superseded} superseded, ${summary.status.queued + summary.status.running} waiting`,
    `${escapeHtml(summary.tsHosts.join(", ") || "-")}<br>${formatStats(summary.tsWall)}${summary.tsFrozen > 0 ? `<br><span class="muted">${summary.tsFrozen} timer frozen (Worker runtime)</span>` : ""}`,
    `${escapeHtml(summary.nautilusHosts.join(", ") || "-")}<br>engine ${formatStats(summary.engineWall)}<br>process ${formatStats(summary.processWall)}`,
    formatStats(summary.queueWait) +
      (summary.queueWait === null
        ? ""
        : `<br><span class="muted">max ${formatMs(summary.queueWait.max)}</span>`),
    `${summary.cpu === null ? "-" : `p50 ${formatMs(summary.cpu.p50)}`}<br><span class="muted">${escapeHtml(summary.gpu.join(", ") || "GPU: -")}</span>`,
    summary.matched + summary.differing === 0
      ? "-"
      : `${summary.matched} same, ${summary.differing} differ`,
  ];
  return `<tr>${cells.map((cell) => `<td>${cell}</td>`).join("")}</tr>`;
};

const STYLE =
  "body{background:#0f1115;color:#e7e7e7;font:15px/1.5 system-ui,sans-serif;margin:0;padding:16px;max-width:1150px}h1{font-size:20px}h2{font-size:16px;margin-top:26px}.wrap{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:13px}th,td{border-bottom:1px solid #2a2e36;padding:6px 8px;text-align:left;vertical-align:top}th{color:#c9a54a}code{color:#c9a54a}li{margin:4px 0}.muted{color:#8a8f98}.warn{color:#e8a33d}a{color:#5aa8e6}";

const table = (head: readonly string[], rows: readonly string[]): string =>
  `<div class="wrap"><table><tr>${head.map((cell) => `<th>${cell}</th>`).join("")}</tr>${rows.join("")}</table></div>`;

export const renderReport = (
  model: ReportModel,
  options: Readonly<{ snapshotHref?: string }> = {}
): string => {
  const now = Date.parse(model.generatedAt);
  const daysLeft = Math.ceil(
    (Date.parse(`${model.step4.decisionDate}T00:00:00.000Z`) - now) / DAY_MS
  );
  let deadline = `passed ${-daysLeft} day(s) ago`;
  if (daysLeft > 0) deadline = `${daysLeft} day(s) left`;
  else if (daysLeft === 0) deadline = "today";
  const differenceItems = model.features.flatMap((feature) =>
    feature.differenceItems.map(
      (item) =>
        `<li>${escapeHtml(feature.title)} · ${escapeHtml(item.label)} · <code>${escapeHtml(item.field)}</code>: ${escapeHtml(item.detail)}</li>`
    )
  );
  const failures = model.features.flatMap((feature) =>
    feature.failures.map(
      (failure) =>
        `<li>${escapeHtml(feature.title)}: ${failure.count} × ${escapeHtml(failure.error)}</li>`
    )
  );
  const outageRows = model.outages.map(
    (outage) =>
      `<tr><td>${minute(outage.from)}</td><td>${outage.to === null ? "still going on" : minute(outage.to)}</td><td>${outage.hours.toFixed(1)} h</td><td>${outage.runsCreated}</td><td>${escapeHtml(outage.reason)}</td></tr>`
  );
  const nautilusRows = model.nautilusRuns.map(
    (run) =>
      `<tr><td>${minute(run.createdAt)}</td><td>${escapeHtml(run.label)}</td><td>${escapeHtml(run.symbol)} ${escapeHtml(run.from)} to ${escapeHtml(run.to)}</td><td>${escapeHtml(run.status)}${run.error === null ? "" : `: ${escapeHtml(run.error)}`}</td><td>${formatMs(run.queueWaitMs)}</td><td>${escapeHtml(run.engineRun?.host ?? "-")}</td><td>${formatMs(run.engineRun?.wallMs ?? null)} / ${formatMs(run.engineRun?.processWallMs ?? null)}</td><td>${formatMs(run.engineRun?.cpuMs ?? null)}</td></tr>`
  );
  const bench = model.benchmark;
  const benchRows = bench.rows.map(
    (row) =>
      `<tr><td>${escapeHtml(row.label)}<br><span class="muted">${escapeHtml(row.method)}</span></td><td>${formatMs(row.typescript.p50Ms)} / ${formatMs(row.typescript.p95Ms)}</td><td>${formatMs(row.typescript.cpuMs)}</td><td>${formatMs(row.nautilus.p50Ms)} / ${formatMs(row.nautilus.p95Ms)}</td><td>${row.nautilus.processes}</td><td>${formatMs(row.nautilus.cpuMs)}</td></tr>`
  );
  const gpuRows = bench.gpu.rows.map(
    (row) =>
      `<tr><td>${row.cells.toLocaleString("en-US")}</td><td>${formatMs(row.cpuMs)}</td><td>${formatMs(row.gpuMs)}</td><td>${Math.round(row.cpuMs / row.gpuMs)}×</td><td>${row.gpuMemoryMb.toLocaleString("en-US")} MB</td></tr>`
  );
  const journalText = model.journal.read
    ? `worker journal from ${model.journal.firstAt === null ? "-" : minute(model.journal.firstAt)} (${model.journal.entries.toLocaleString("en-US")} lines)`
    : "worker journal not read (outages below are the recorded ones only)";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Vertex: current engine vs Nautilus</title><style>${STYLE}</style></head><body>
<h1>Current engine vs Nautilus (step 4 report)</h1>
<p class="muted">Built ${minute(model.generatedAt)} from the stored runs in production (<code>backtestRuns.comparisons.list</code>, up to ${model.limit} per feature; <code>backtestRuns.list</code>/<code>get</code>) and the ${journalText}. Research only: no orders. Nautilus never runs on QuantVPS.</p>
<h2>Step 4 decision (${model.step4.decisionDate}, ${deadline})</h2>
<p>Pass condition (switch plan): ${model.step4.daysNeeded} days of live side-by-side data for the instant backtest, the parameter sweep and the Autopilot gate. The dual run is on in production since ${model.step4.since}. <span class="${model.step4.met ? "" : "warn"}">${escapeHtml(model.step4.verdict)}</span></p>
<ul>${model.step4.lines.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ul>
<h2>Timeline of stored runs</h2>
${timelineSvg(model)}
<p class="muted">${(Object.keys(KIND_COLORS) as TimelinePoint["kind"][]).map((kind) => `<span style="color:${KIND_COLORS[kind]}">●</span> ${KIND_LABELS[kind]}`).join(" &nbsp; ")} &nbsp; <span style="color:#e05252">▮</span> worker outage</p>
<h2>Worker outages</h2>
${model.outages.length === 0 ? "<p>None found.</p>" : `${table(["From", "To", "Length", "Runs created in it", "Cause"], outageRows)}<p class="muted">A run created during an outage waits in the queue until the worker is back; its queue wait counts the outage. The TypeScript result is never held up.</p>`}
<h2>Live comparisons per feature (p50 / p95, nearest rank)</h2>
${table(["Feature", "Runs", "Days", "Status", "TypeScript: where, wall", "Nautilus: where, wall", "Queue wait", "Nautilus CPU / GPU", "Result"], model.features.map(featureRow))}
<ul class="muted"><li>TypeScript wall = server-side engine time in the request; the Worker runtime freezes its own timer, so many in-request runs have none (counted as frozen).</li><li>Nautilus engine = engine time of the run inside its process; process = the whole engine process (Python start + every case of the batch).</li><li>Queue wait = start minus creation of the Nautilus run (superseded and failed runs left out).</li></ul>
${differenceItems.length === 0 ? "" : `<h3>Differences</h3><ul>${differenceItems.join("")}</ul>`}
${failures.length === 0 ? "" : `<h3>Failed runs</h3><ul>${failures.join("")}</ul>`}
<h2>Nautilus backtest runs without a TypeScript twin</h2>
${nautilusRows.length === 0 ? "<p>None.</p>" : table(["Created", "Strategy", "Bars", "Status", "Queue wait", "Host", "Engine / process wall", "CPU"], nautilusRows)}
${model.nautilusListFull ? '<p class="warn">The run list returned its maximum; older Nautilus runs are not shown.</p>' : ""}
<h2>Rig benchmark (${minute(bench.measuredAt)}, not re-measured)</h2>
<p class="muted">${escapeHtml(bench.conditions)}. Engine time alone in a warm process: ${formatMs(bench.warmEngineMs)} for the instant backtest, so most of a cold Nautilus run is Python start.${options.snapshotHref === undefined ? "" : ` Original page: <a href="${escapeHtml(options.snapshotHref)}">snapshot of 2026-11-06</a>.`}</p>
${benchmarkSvg(model)}
${table(["Feature", "TS wall p50 / p95", "TS CPU", "Nautilus wall p50 / p95", "Processes", "Nautilus CPU"], benchRows)}
<ul>${bench.differences.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ul>
<h3>GPU (${escapeHtml(bench.gpu.device)})</h3>
<p>${escapeHtml(bench.gpu.note)}</p>
${table(["Cells", "CPU (numpy)", "GPU (torch)", "Speed-up", "GPU memory"], gpuRows)}
<h2>Rebuild this page</h2>
<p><code>VERTEX_ORIGIN=&lt;portal origin&gt; VERTEX_AGENT_KEY_FILE=&lt;operator read key file&gt; bun run vertex:engine-comparison-report -- --out &lt;dir&gt;</code> (scripts/engine-comparison-report). Read-only: it calls list and get procedures and reads the worker journal.</p>
</body></html>
`;
};
