# Native services

Python and Rust services are the one exception to the TypeScript rule (ADR-V03). They use versioned public contracts and never import package internals across the boundary.

| Service | Language | Purpose |
| --- | --- | --- |
| `services/research` | Python | Offline research building blocks (features, setups, options, portfolio, replay), backtests and research agents |
| `services/execution` | Python | Fenced deterministic paper simulation; no broker dispatch |
| `services/execution-kernel` | Rust | Paper-only admission planning; cannot grant live trading permission |
| `services/kernel-bridge` | Rust, Python | Reviewed ctypes bridge to the paper-only kernel |
| `services/contracts` | Python, Rust | Canonical Vertex contract authority |
| `services/host` | Python | Single-owner native paper and research host |
| `services/gateway` | Python | Gateway readiness checks and human-authorized recovery boundaries |
| `services/market-data` | Python | Market-data normalization and immutable dataset planning |
| `services/ibkr-history` | Rust | IBKR history acquisition; source only, not built or activated |
| `services/control-client` | Python | Scoped client for the Vertex control plane |
| `services/openbb` | Python | Pinned OpenBB Platform fetcher for research data sets; prints JSON for `openbb.ingest`, no order path |
| `services/vibe-trading` | Python | Driver for the Vibe-Trading agent framework in the agent benchmark; no upstream code in the repository |

Each service keeps its tests next to its code. The CI lanes run only the `services/gateway` tests (`bun run test:gateway`).

## First-party research building blocks

The research building blocks are first-party Vertex code in `services/research`. The Python distribution `vertex-gamma-research`, the `gamma` import package, the recipe profile IDs `vertex-gamma-research-v1` and `vertex-gamma-recipe-v1`, the `gammaProvenance` contract field and the `GAMMA_RESEARCH_API_URL`/`GAMMA_RESEARCH_API_TOKEN` environment variables keep their historical names, so that imports, stored recipes, the API contract and configured environments stay stable.

| Block | What it does | Where it lives |
| --- | --- | --- |
| Features | Momentum, market structure, volatility, liquidity, fundamental/catalyst and option-flow features | `services/research/gamma/features/` |
| Indicators | TA-Lib-compatible EMA, MACD, RSI, ATR, ADX and similar indicators | `services/research/indicators/` |
| Setups | Setup identification from the features, research brief and market regime | `services/research/gamma/engines/setup_engine.py` |
| Options | Options strategy selection and the BridgingCycles short strangle | `services/research/gamma/engines/options_strategy_selector.py`, `services/research/gamma/engines/bridgingcycles_short_strangle.py`, `services/research/gamma/schemas/options.py` |
| Portfolio | Portfolio committee and portfolio schemas | `services/research/gamma/engines/portfolio_committee.py`, `services/research/gamma/schemas/portfolio.py` |
| Replay | Replay manifests and offline backtest replay | `services/research/backtesting/replay.py`, `services/research/backtesting/manifest.py` |
