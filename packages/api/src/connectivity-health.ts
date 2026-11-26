import type {
  ConnectivityEscalation,
  ConnectivityIssue,
  ConnectivityIssueCategory,
  ConnectivityOverallStatus,
  ConnectivityPlannedAlert,
  ConnectivityProviderStatus,
} from "./contracts/connectivity.ts";

// Pure connectivity health classifier, evaluator, and alert state machine
// (card vertex-connectivity-audit-autofix; research diagnostics and alerting only, no orders).
// Reuses the durable multi-monitor outbox schema (`price_freshness_state`) under monitor
// "feed-connectivity" so steady-state healthy checks write zero database rows.

export const CONNECTIVITY_ALERT_MONITOR = "feed-connectivity";
export const CONNECTIVITY_IN_FLIGHT_LEASE_MS = 3 * 60 * 1000;
export const CONNECTIVITY_FLOW_REPEAT_THRESHOLD = 2;

const HTTP_STATUS_PATTERN = /\bHTTP\s+([1-5]\d{2})\b/iu;
const AUTH_TEXT_PATTERN =
  /\b(authentication failed|access forbidden|unauthorized|invalid api key|invalid token)\b/iu;
const RATE_LIMIT_PATTERN =
  /\b(rate limit|rate_limited|cooling down|cooldown|quota|paced|pacing)\b/iu;
const UNREACHABLE_PATTERN =
  /\b(timed out|timeout|unreachable|did not answer|request failed|econnrefused|network)\b/iu;
const SERVER_ERROR_PATTERN =
  /\b(upstream error|bad gateway|service unavailable|gateway timeout|server error)\b/iu;

const QUANTDATA_FLOW_SOURCES: Readonly<Record<string, true>> = {
  gex: true,
  market_premium: true,
  net_drift: true,
  options: true,
};

export type ConnectivityMessageClassification = Readonly<{
  category: ConnectivityIssueCategory;
  escalation: ConnectivityEscalation;
  httpStatus: number | null;
}>;

/** Classifies a feed/upstream error message into a connectivity category and escalation level. */
export const classifyConnectivityMessage = (
  message: string
): ConnectivityMessageClassification => {
  const statusMatch = HTTP_STATUS_PATTERN.exec(message);
  const httpStatus = statusMatch ? Number(statusMatch[1]) : null;
  if (
    httpStatus === 401 ||
    httpStatus === 403 ||
    AUTH_TEXT_PATTERN.test(message)
  ) {
    return {
      category: "auth_failed",
      escalation: "needs_you_credential_rotation",
      httpStatus,
    };
  }
  if (httpStatus === 429 || RATE_LIMIT_PATTERN.test(message)) {
    return {
      category: "rate_limited",
      escalation: "info",
      httpStatus,
    };
  }
  if (
    (httpStatus !== null && httpStatus >= 500) ||
    SERVER_ERROR_PATTERN.test(message)
  ) {
    return {
      category: "upstream_5xx",
      escalation: "alert",
      httpStatus,
    };
  }
  if (UNREACHABLE_PATTERN.test(message)) {
    return {
      category: "unreachable",
      escalation: "alert",
      httpStatus,
    };
  }
  return {
    category: "feed_error",
    escalation: "alert",
    httpStatus,
  };
};

export type ConnectivityFlowSampleInput = Readonly<{
  at: Date;
  message: string | null;
  source: string;
  status: string;
  symbol: string;
}>;

export type ConnectivityOpenbbRunInput = Readonly<{
  error: string | null;
  finishedAt: Date;
  job: string;
  startedAt: Date;
  status: string;
}>;

export type ConnectivityRuntimeConfigSummary = Readonly<{
  deployStatus: boolean;
  engineStatus: boolean;
  ibkrMonitor: boolean;
  ibkrRecovery: boolean;
  marketHistory: boolean;
  portfolioMonitor: boolean;
  priceAlertsNtfy: boolean;
  quantData: boolean;
  researchLenses: boolean;
}>;

const flowProviderMeta = (
  source: string
): Readonly<{ envVars: string[]; provider: string }> =>
  Object.hasOwn(QUANTDATA_FLOW_SOURCES, source)
    ? { envVars: ["QUANTDATA_API_KEY"], provider: "quantdata" }
    : {
        envVars: ["VERTEX_HISTORY_URL", "VERTEX_DEPLOY_STATUS_TOKEN"],
        provider: "ibkr-history",
      };

const evaluateFlowIssues = (
  samples: readonly ConnectivityFlowSampleInput[]
): ConnectivityIssue[] => {
  const byPair = new Map<string, ConnectivityFlowSampleInput[]>();
  for (const sample of samples) {
    const pairKey = `${sample.symbol}:${sample.source}`;
    const list = byPair.get(pairKey);
    if (list === undefined) byPair.set(pairKey, [sample]);
    else list.push(sample);
  }
  const issues: ConnectivityIssue[] = [];
  for (const [pairKey, rows] of byPair) {
    const sorted = [...rows].sort((a, b) => b.at.getTime() - a.at.getTime());
    const newest = sorted[0];
    if (newest === undefined || newest.status !== "unavailable") continue;
    let consecutiveFailures = 0;
    for (const row of sorted) {
      if (row.status === "unavailable") consecutiveFailures += 1;
      else break;
    }
    const lastOk = sorted.find((row) => row.status === "ok")?.at ?? null;
    const message =
      newest.message?.trim() ||
      "Collector recorded no error message; check the collector log or /connections";
    const classified = classifyConnectivityMessage(message);
    const meta = flowProviderMeta(newest.source);
    issues.push({
      category: classified.category,
      consecutiveFailures,
      envVars: meta.envVars,
      escalation: classified.escalation,
      httpStatus: classified.httpStatus,
      key: `flow:${pairKey}:${classified.category}`,
      lastFailureAt: newest.at,
      lastOkAt: lastOk,
      layer: "flow",
      message,
      provider: meta.provider,
      source: `${newest.symbol} ${newest.source}`,
    });
  }
  return issues;
};

const evaluateOpenbbIssues = (
  runs: readonly ConnectivityOpenbbRunInput[]
): ConnectivityIssue[] => {
  const issues: ConnectivityIssue[] = [];
  for (const run of runs) {
    if (run.status !== "failed" && run.status !== "blocked_upstream") continue;
    const message =
      run.error?.trim() ||
      (run.status === "blocked_upstream"
        ? "OpenBB job blocked upstream"
        : "OpenBB job failed");
    const raw = classifyConnectivityMessage(message);
    const isAuthenticatedOpenbbJob =
      run.status === "failed" && run.job === "daily-prices";
    const classified =
      raw.category === "auth_failed" && !isAuthenticatedOpenbbJob
        ? {
            category: "feed_error" as const,
            escalation: "alert" as const,
            httpStatus: raw.httpStatus,
          }
        : raw;
    const envVars =
      classified.category === "auth_failed"
        ? ["VERTEX_HISTORY_URL", "VERTEX_DEPLOY_STATUS_TOKEN"]
        : [];
    issues.push({
      category: classified.category,
      consecutiveFailures: 1,
      envVars,
      escalation: classified.escalation,
      httpStatus: classified.httpStatus,
      key: `openbb:${run.job}:${classified.category}`,
      lastFailureAt: run.finishedAt,
      lastOkAt: null,
      layer: "openbb",
      message,
      provider: "openbb",
      source: run.job,
    });
  }
  return issues;
};

const PROVIDER_SPECS: readonly Readonly<{
  configKey: keyof ConnectivityRuntimeConfigSummary | null;
  envVars: readonly string[];
  id: string;
  label: string;
}>[] = [
  {
    configKey: "quantData",
    envVars: ["QUANTDATA_API_KEY"],
    id: "quantdata",
    label: "QuantData Options & Flow",
  },
  {
    configKey: null,
    envVars: ["VERTEX_ORIGIN", "VERTEX_AGENT_API_KEY"],
    id: "openbb",
    label: "OpenBB Market & Macro Ingest",
  },
  {
    configKey: "marketHistory",
    envVars: ["VERTEX_HISTORY_URL", "VERTEX_DEPLOY_STATUS_TOKEN"],
    id: "ibkr-history",
    label: "IBKR History & Order Flow",
  },
  {
    configKey: "portfolioMonitor",
    envVars: ["VERTEX_PORTFOLIO_URL", "VERTEX_DEPLOY_STATUS_TOKEN"],
    id: "ibkr-portfolio",
    label: "IBKR Portfolio Snapshot",
  },
  {
    configKey: "ibkrMonitor",
    envVars: ["IBKR_MONITOR_URL"],
    id: "ibkr-monitor",
    label: "IBKR Monitor (Loopback)",
  },
  {
    configKey: "ibkrRecovery",
    envVars: ["VERTEX_IBKR_RECOVERY_URL", "VERTEX_IBKR_RECOVERY_TOKEN"],
    id: "ibkr-recovery",
    label: "IBKR Human 2FA Recovery",
  },
  {
    configKey: "deployStatus",
    envVars: ["VERTEX_DEPLOY_STATUS_URL", "VERTEX_DEPLOY_STATUS_TOKEN"],
    id: "deploy-status",
    label: "QuantVPS Deployment Status",
  },
  {
    configKey: "engineStatus",
    envVars: ["ENGINE_STATUS_URL"],
    id: "engine-status",
    label: "Rig Engine & Market Context Feed",
  },
  {
    configKey: "researchLenses",
    envVars: ["VERTEX_RESEARCH_LENSES_URL", "VERTEX_DEPLOY_STATUS_TOKEN"],
    id: "research-lenses",
    label: "Research Lenses Feed",
  },
  {
    configKey: "priceAlertsNtfy",
    envVars: [
      "VERTEX_PRICE_ALERTS_NTFY_ORIGIN",
      "VERTEX_PRICE_ALERTS_NTFY_TOPIC",
    ],
    id: "ntfy-alerts",
    label: "Automated Alert Delivery (ntfy)",
  },
];

const compareIssues = (a: ConnectivityIssue, b: ConnectivityIssue): number => {
  const rank = (category: ConnectivityIssueCategory): number =>
    category === "auth_failed" ? 0 : category === "rate_limited" ? 2 : 1;
  const rankDelta = rank(a.category) - rank(b.category);
  if (rankDelta !== 0) return rankDelta;
  return a.key.localeCompare(b.key);
};

export const evaluateConnectivityHealth = (
  input: Readonly<{
    config: ConnectivityRuntimeConfigSummary;
    flowSamples: readonly ConnectivityFlowSampleInput[];
    openbbRuns: readonly ConnectivityOpenbbRunInput[];
  }>
): Readonly<{
  issues: ConnectivityIssue[];
  overallStatus: ConnectivityOverallStatus;
  providers: ConnectivityProviderStatus[];
}> => {
  const issues = [
    ...evaluateFlowIssues(input.flowSamples),
    ...evaluateOpenbbIssues(input.openbbRuns),
  ].sort(compareIssues);

  const providers: ConnectivityProviderStatus[] = PROVIDER_SPECS.map((spec) => {
    const configured =
      spec.configKey === null ? true : input.config[spec.configKey];
    const providerIssues = issues.filter((issue) => issue.provider === spec.id);
    const hasAuth = providerIssues.some(
      (issue) => issue.category === "auth_failed"
    );
    const status = configured
      ? hasAuth
        ? "auth_failed"
        : providerIssues.length > 0
          ? "degraded"
          : "healthy"
      : "not_configured";
    const firstIssue = providerIssues[0];
    const summary =
      status === "not_configured"
        ? `Not configured on this server (${spec.envVars.join(", ")})`
        : status === "auth_failed"
          ? `Credential/auth error on ${providerIssues.filter((issue) => issue.category === "auth_failed").length} feed(s) — owner credential rotation required`
          : firstIssue === undefined
            ? spec.configKey === null
              ? "Latest recorded ingest runs healthy"
              : "Configured; no active feed errors"
            : `${providerIssues.length} degraded feed(s): ${firstIssue.message}`;
    return {
      activeIssueCount: providerIssues.length,
      configured,
      envVars: [...spec.envVars],
      id: spec.id,
      label: spec.label,
      status,
      summary,
    };
  });

  const overallStatus: ConnectivityOverallStatus = issues.some(
    (issue) => issue.category === "auth_failed"
  )
    ? "auth_failed"
    : issues.length > 0
      ? "degraded"
      : "healthy";

  return { issues, overallStatus, providers };
};

/**
 * Selects issues that should trigger an automated alert:
 * - auth_failed (HTTP 401/403): immediate escalation on first failure (Needs-you credential rotation).
 * - upstream_5xx / unreachable / feed_error: repeated Flow failures (>= 2) or any failed OpenBB run.
 * - rate_limited: excluded from alert paging (shown as info in connectivity.health).
 */
export const alertableConnectivityIssues = (
  issues: readonly ConnectivityIssue[]
): ConnectivityIssue[] =>
  issues.filter((issue) => {
    if (issue.category === "auth_failed") return true;
    if (issue.category === "rate_limited") return false;
    if (issue.layer === "openbb") return true;
    return issue.consecutiveFailures >= CONNECTIVITY_FLOW_REPEAT_THRESHOLD;
  });

const formatProviderList = (issues: readonly ConnectivityIssue[]): string =>
  [...new Set(issues.map((issue) => issue.provider))].sort().join(", ");

export const formatConnectivityAlert = (
  issues: readonly ConnectivityIssue[]
): ConnectivityPlannedAlert => {
  const authIssues = issues.filter((issue) => issue.category === "auth_failed");
  const needsOwnerAsk = authIssues.length > 0;
  const providers = formatProviderList(needsOwnerAsk ? authIssues : issues);
  const title = needsOwnerAsk
    ? `Vertex connectivity: credential rotation needed (${providers})`
    : `Vertex connectivity: repeated feed failures (${providers})`;
  const envVars = [
    ...new Set(authIssues.flatMap((issue) => issue.envVars)),
  ].sort();
  const lines = issues
    .slice(0, 8)
    .map(
      (issue) =>
        `- ${issue.source} (${issue.provider}): ${issue.message}${issue.consecutiveFailures > 1 ? ` [${issue.consecutiveFailures}x]` : ""}`
    );
  const more =
    issues.length > 8 ? [`- ... and ${issues.length - 8} more feed(s)`] : [];
  const footer = needsOwnerAsk
    ? [
        envVars.length > 0
          ? `Credential(s) to rotate: ${envVars.join(", ")}`
          : "Credential rotation required by owner.",
        "Escalation: Needs-you owner ask (never auto-rotated).",
      ]
    : ["Check /connections or /flow for full feed diagnostics."];
  return {
    body: [...lines, ...more, ...footer].join("\n"),
    kind: "alert",
    needsOwnerAsk,
    title,
  };
};

export const formatConnectivityRecovery = (): ConnectivityPlannedAlert => ({
  body: "All previously alerted Vertex connectivity feeds are healthy again.",
  kind: "recovery",
  needsOwnerAsk: false,
  title: "Vertex connectivity recovered",
});

export type ConnectivityAlertPersistedState = Readonly<{
  activeKeys: readonly string[];
  pendingDelivery: "pending" | "not-configured" | "failed" | null;
  pendingEventId: string | null;
  pendingKeys: readonly string[];
  pendingKind: "alert" | "recovery" | null;
  updatedAt: Date;
}>;

export type ConnectivityAlertDiff =
  | Readonly<{
      action: "noop" | "in-flight" | "clear-pending";
      alert: null;
      newlyAlerted: readonly ConnectivityIssue[];
      targetKeys: readonly string[];
    }>
  | Readonly<{
      action: "prune-active";
      alert: null;
      newlyAlerted: readonly ConnectivityIssue[];
      targetKeys: readonly string[];
    }>
  | Readonly<{
      action: "alert" | "recovery";
      alert: ConnectivityPlannedAlert;
      newlyAlerted: readonly ConnectivityIssue[];
      targetKeys: readonly string[];
    }>;

/**
 * Pure transition diff for the durable "feed-connectivity" monitor (mirrors diffPriceFreshness).
 * Deduplicates repeated alerts for the same active issue keys, retries failed/unconfigured pending
 * deliveries, prunes recovered keys while others stay broken, and sends one recovery when all clear.
 */
export const diffConnectivityAlerts = (
  input: Readonly<{
    alertable: readonly ConnectivityIssue[];
    now: Date;
    state: ConnectivityAlertPersistedState | null;
  }>
): ConnectivityAlertDiff => {
  const { alertable, now, state } = input;
  const activeSet = new Set(state?.activeKeys ?? []);
  const currentKeys = alertable.map((issue) => issue.key).sort();
  const currentSet = new Set(currentKeys);
  const newlyAlerted = alertable.filter((issue) => !activeSet.has(issue.key));
  const pendingActive =
    state?.pendingEventId !== null && state?.pendingEventId !== undefined;

  if (
    pendingActive &&
    state.pendingDelivery === "pending" &&
    now.getTime() - state.updatedAt.getTime() < CONNECTIVITY_IN_FLIGHT_LEASE_MS
  ) {
    return {
      action: "in-flight",
      alert: null,
      newlyAlerted,
      targetKeys: currentKeys,
    };
  }

  if (newlyAlerted.length > 0) {
    return {
      action: "alert",
      alert: formatConnectivityAlert(alertable),
      newlyAlerted,
      targetKeys: currentKeys,
    };
  }

  if (pendingActive && state.pendingKind === "alert") {
    if (alertable.length > 0) {
      return {
        action: "alert",
        alert: formatConnectivityAlert(alertable),
        newlyAlerted: [],
        targetKeys: currentKeys,
      };
    }
    if (activeSet.size > 0) {
      return {
        action: "recovery",
        alert: formatConnectivityRecovery(),
        newlyAlerted: [],
        targetKeys: [],
      };
    }
    return {
      action: "clear-pending",
      alert: null,
      newlyAlerted: [],
      targetKeys: [],
    };
  }

  if (pendingActive && state.pendingKind === "recovery") {
    if (alertable.length === 0) {
      return {
        action: "recovery",
        alert: formatConnectivityRecovery(),
        newlyAlerted: [],
        targetKeys: [],
      };
    }
    return {
      action: "clear-pending",
      alert: null,
      newlyAlerted: [],
      targetKeys: currentKeys,
    };
  }

  if (alertable.length === 0 && activeSet.size > 0) {
    return {
      action: "recovery",
      alert: formatConnectivityRecovery(),
      newlyAlerted: [],
      targetKeys: [],
    };
  }

  const remainingActive = [...activeSet]
    .filter((key) => currentSet.has(key))
    .sort();
  if (remainingActive.length < activeSet.size) {
    return {
      action: "prune-active",
      alert: null,
      newlyAlerted: [],
      targetKeys: remainingActive,
    };
  }

  return {
    action: "noop",
    alert: null,
    newlyAlerted: [],
    targetKeys: currentKeys,
  };
};
