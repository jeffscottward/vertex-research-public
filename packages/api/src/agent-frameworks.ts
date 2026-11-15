import type { AgentFrameworkOutput } from "./contracts/agent-model-runs.ts";

// Reference sheets of the agent frameworks Vertex benchmarks (agentModelRuns.frameworks, the
// Frameworks section of /agents/benchmark). Static and typed: every fact comes from this repository
// (README "Ported code", the research adapters and the Vibe-Trading driver) or from the upstream
// READMEs at the pinned versions. Research only: no framework here places, sizes or sends an order.
//
// The Vibe-Trading sheet adapts facts from the Vibe-Trading reference sheet of Glassbench
// (https://github.com/davidalmeida90/glassbench, commit 255414b3f38b5def667d3b75faf1dfd7c0d25c9b,
// backend/deskapp/frameworks.py, Apache License 2.0; see NOTICE).
// Modified: rewritten as a typed TypeScript catalog with the Vertex wiring, the tool lists of
// services/vibe-trading/driver/vt_driver.py and the Vertex guards.

/** Read-only tools a Vibe-Trading run may use; the same list as TOOL_ALLOWLIST in vt_driver.py. */
export const VIBE_TRADING_TOOLS_ALLOWED: readonly string[] = Object.freeze([
  "get_market_data",
  "technical_indicators",
  "get_fundamentals",
  "get_financial_statements",
  "get_stock_profile",
  "get_sector_info",
  "get_institutional_holdings",
  "get_sec_filings",
  "get_options_chain",
  "options_pricing",
  "options_payoff",
  "quantlib_call",
  "get_stock_news",
  "sentiment",
  "get_macro_series",
  "prediction_market",
  "web_search",
  "read_url",
  "search_symbol",
  "get_fund_flow",
  "get_margin_trading",
  "get_research_reports",
  "load_skill",
  "compact",
]);

/** Never allowed (TOOL_DENYLIST and DENIED_PREFIXES in vt_driver.py; a prefix ends in "*"). */
export const VIBE_TRADING_TOOLS_EXCLUDED: readonly string[] = Object.freeze([
  "bash",
  "background_run",
  "cancel_background",
  "check_background",
  "read_file",
  "write_file",
  "edit_file",
  "read_document",
  "read_run_artifact",
  "backtest",
  "run_shadow_backtest",
  "factor_analysis",
  "run_swarm",
  "scheduled_research",
  "run_research_autopilot",
  "remember",
  "save_skill",
  "delete_skill",
  "propose_mandate_profiles",
  "trading_*",
  "etoro_*",
  "swarm*",
  "schedule*",
]);

const TRADINGAGENTS: AgentFrameworkOutput = {
  benchName: null,
  code: [
    "services/research/agents/external_research.py (TradingAgentsResearchAdapter)",
  ],
  dataSources: [
    {
      name: "Context supplied by the caller",
      note: "The desks read only the redacted context they are given; the adapter fetches no data itself.",
      pointInTime: "caller",
    },
  ],
  guards: [
    "Output that contains order fields (contracts, lots, shares, notional, strikes) is rejected.",
    "The model transport is injected (ResearchGenerator); the adapter imports no SDK and performs no I/O on import.",
    "No TradingAgents code is copied (services/research/NOTICE.txt).",
  ],
  id: "tradingagents",
  license:
    "Upstream: Apache License 2.0. Vertex code: Vertex's own adapter; no upstream code is copied.",
  links: [
    {
      href: "https://github.com/TauricResearch/TradingAgents",
      label: "TradingAgents on GitHub",
    },
  ],
  name: "TradingAgents (Vertex research desks)",
  stages: [
    {
      name: "market_regime_analysis",
      summary: "Market regime with a label, confidence and evidence.",
    },
    {
      name: "theme_discovery",
      summary: "Theme theses from the supplied context.",
    },
    {
      name: "candidate_discovery",
      summary: "Candidate companies for the themes.",
    },
    {
      name: "bull_bear_research_brief",
      summary:
        "Bull and bear brief for one ticker; a brief for another ticker is rejected.",
    },
    {
      name: "trade_setup_debate",
      summary: "Debate of a proposed setup as a research brief.",
    },
  ],
  status: "reimplemented",
  summary:
    "Five TradingAgents-style research desks re-implemented in Vertex as typed prompt contracts with JSON output schemas. Each desk validates its output against its contract.",
  toolsAllowed: [],
  toolsExcluded: [],
  version: "Not pinned: Vertex's own adapter, no upstream code",
};

const AI_HEDGE_FUND: AgentFrameworkOutput = {
  benchName: null,
  code: [
    "services/research/backtesting/event_stats.py",
    "services/research/backtesting/event_study.py",
  ],
  dataSources: [
    {
      name: "Return observations with session and availability timestamps",
      note: "Each event needs a precise publication or availability time and an explicit anchor policy; dated-only filings stay inconclusive. Source types and anchor policies are never pooled.",
      pointInTime: "yes",
    },
  ],
  guards: [
    "Descriptive event association, not causal identification or executable strategy economics.",
    "No transaction cost, fill, borrow, margin, settlement or capital model is computed.",
    "Bootstrap replicates and total draws are bounded; the seed is mandatory.",
  ],
  id: "ai_hedge_fund",
  license:
    "MIT, Copyright (c) 2024 Virat Singh (services/research/backtesting/AI_HEDGE_FUND_LICENSE.txt).",
  links: [
    {
      href: "https://github.com/virattt/ai-hedge-fund",
      label: "AI Hedge Fund on GitHub",
    },
  ],
  name: "AI Hedge Fund (event study)",
  stages: [
    {
      name: "Market model",
      summary:
        "OLS fit of the stock on the market over the estimation window [-250, -11] (at least 200 observations).",
    },
    {
      name: "Abnormal returns",
      summary:
        "Abnormal and cumulative abnormal returns over the event windows [0, 1, 5, 20].",
    },
    {
      name: "Statistics",
      summary:
        "Sample t-test and percentile bootstrap confidence interval of the CARs.",
    },
  ],
  status: "adapted",
  summary:
    "Event-study statistics adapted from AI Hedge Fund v2/event_study for offline backtests. Only the statistics are adapted; AI Hedge Fund's agents do not run in Vertex.",
  toolsAllowed: [],
  toolsExcluded: [],
  version:
    "Not pinned: upstream file SHA-256 values are in the event_stats.py docstring",
};

// The LangAlpha sheet describes scripts/agent-desk/pitch.ts, which adapts the structure of two
// LangAlpha skills (https://github.com/ginlix-ai/LangAlpha, commit
// e102a7838225157f7b3beca3fc274b26be852154, Apache License 2.0; see NOTICE). No LangAlpha code
// is included and LangAlpha does not run in Vertex.
const LANGALPHA: AgentFrameworkOutput = {
  benchName: null,
  code: ["scripts/agent-desk/pitch.ts"],
  dataSources: [
    {
      name: "Accepted report datasets (fundamentals, news, committee, market history)",
      note: "Read through the paper agent desk. A dataset captured after the run date and a bar or catalyst outside the run date's view are not used (the desk's asOf rule).",
      pointInTime: "yes",
    },
  ],
  guards: [
    "No order, size, instrument or execution: the pitch states what the inputs support, and the paper book does not read it.",
    "No model call and no network: a deterministic function over the results of the other desk agents.",
    "LangAlpha's sandbox, broker connectors and model routes are not used.",
    "The pitch agent does not read scenario probabilities, so no probability-weighted figure is given.",
  ],
  id: "langalpha",
  license:
    "Apache-2.0, Copyright 2025 Ginlix AI (ideas and structure only; no LangAlpha code is included).",
  links: [
    {
      href: "https://github.com/ginlix-ai/LangAlpha/tree/e102a7838225157f7b3beca3fc274b26be852154",
      label: "LangAlpha at commit e102a783 on GitHub",
    },
  ],
  name: "LangAlpha (trade pitch structure)",
  stages: [
    {
      name: "Posture",
      summary:
        "One readiness posture (review-ready, screen-grade, not-ready or blocked) from one ordered table, with the inputs that set it. LangAlpha's top posture, decision-grade, is deliberately not used: the desk does not collect scenario probabilities or bear-case liquidity checks. An ETF, index or future gets no posture.",
    },
    {
      name: "Scenario tree",
      summary:
        "The bear, base and bull cases of the accepted fundamentals dataset with their upside and present price. The three are labelled an illustrative skew only when all exist and are ordered bear, base, bull.",
    },
    {
      name: "Exit levels and monitoring",
      summary:
        "An SMA exit reference (the rule's SMA while the close is above it) with its distance from the close, the changes that break a long-supported view, the next dated catalyst and at most five upcoming catalysts.",
    },
  ],
  status: "adapted",
  summary:
    "The paper agent desk's pitch agent adapts the structure of LangAlpha's trade-pitch and research-conventions skills. LangAlpha is not integrated as a harness: it needs PostgreSQL, Redis and a sandbox, it has no one-ticker rated run, and its Claude subscription route presents itself as the Claude Code client.",
  toolsAllowed: [],
  toolsExcluded: [],
  version:
    "Ideas adapted from commit e102a783; LangAlpha itself does not run in Vertex",
};

const VIBE_TRADING: AgentFrameworkOutput = {
  benchName: "vibe_trading",
  code: [
    "services/vibe-trading/driver/vt_driver.py",
    "services/research/adapters/vibe_trading_framework.py",
    "scripts/vibe-trading-setup.sh",
  ],
  dataSources: [
    {
      name: "Vibe-Trading data tools (prices, indicators, options, profile, news)",
      note: "Free sources by default (Yahoo Finance and others). Vibe-Trading has no date input: tools return current data, so a run dated in the past is flagged not_point_in_time.",
      pointInTime: "no",
    },
    {
      name: "SEC filings and statements",
      note: "As filed; the agents can still read later filings than the decision date.",
      pointInTime: "no",
    },
    {
      name: "Web search and web pages",
      note: "Present-day results.",
      pointInTime: "no",
    },
  ],
  guards: [
    "Read-only data tools and pure computation only: no shell, no file access, no backtests (they run generated code), no broker, trading, swarm or scheduler tools.",
    "Each tool call (except compact, which only shortens the context) is checked against the allowlist and reported as an event; the adapter refuses a driver whose tool list leaves it.",
    "Only the endpoint's API key reaches the driver; tracing settings and the Vertex key are dropped, and each run gets its own temporary home.",
    "A clone that holds agent/.env is refused, because Vibe-Trading would read missing settings from it.",
  ],
  id: "vibe_trading",
  license: "MIT, Copyright (c) 2026 Vibe-Trading Contributors.",
  links: [
    {
      href: "https://github.com/HKUDS/Vibe-Trading/tree/v0.1.18",
      label: "Vibe-Trading v0.1.18 on GitHub",
    },
    {
      href: "https://github.com/HKUDS/Vibe-Trading/blob/v0.1.18/agent/src/swarm/presets/investment_committee.yaml",
      label: "Investment committee preset",
    },
    {
      href: "https://github.com/davidalmeida90/glassbench",
      label: "Glassbench (driver origin)",
    },
  ],
  name: "Vibe-Trading",
  stages: [
    {
      name: "bull_advocate",
      summary:
        "Bull-side researcher: the long case from technicals, fundamentals and sentiment. Runs in parallel with the bear.",
    },
    {
      name: "bear_advocate",
      summary:
        "Bear-side researcher: the short case, valuation premium, deterioration, VaR and drawdown.",
    },
    {
      name: "risk_officer",
      summary:
        "Chief risk officer: reviews both reports, sizing, stops and hedges.",
    },
    {
      name: "portfolio_manager",
      summary:
        "Portfolio manager: the final call, closed with the Vertex JSON block (rating, action, entry, stop, target, horizon, confidence, thesis).",
    },
    {
      name: "Closing block",
      summary:
        "Vertex reads the last JSON block. A rating outside the five tiers maps the action (long to overweight, short to underweight, wait or hedge to hold); with neither the run has no rating. Figures withheld as (omitted※) read as null and set numbers_withheld.",
    },
  ],
  status: "external",
  summary:
    "Vibe-Trading's own investment_committee preset (or one research agent with VERTEX_VT_MODE=single) runs unmodified in its own clone and virtual environment. The Vertex driver adds a no-shell note to each prompt and asks the portfolio manager for a closing JSON block.",
  toolsAllowed: [...VIBE_TRADING_TOOLS_ALLOWED],
  toolsExcluded: [...VIBE_TRADING_TOOLS_EXCLUDED],
  version: "0.1.18 (commit 66eb576)",
};

export const AGENT_FRAMEWORKS: readonly AgentFrameworkOutput[] = Object.freeze([
  TRADINGAGENTS,
  AI_HEDGE_FUND,
  VIBE_TRADING,
  LANGALPHA,
]);
