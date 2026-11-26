# Drift Report — `vertex-viz-offexchange-levels`

- **Date:** 2026-11-24
- **Design doc:** [design.md](design.md)
- **Branch:** `ws/off-exchange-levels`

## Summary

Implementation matches [design.md](design.md) across database queries, oRPC contract (`flow.offExchangeLevels`, `flow-off-exchange-levels.v1`), pure clustering/bucketing rules (`OFF_EXCHANGE_LEVELS_RULES`), view-model geometry, `FlowOffExchangeLevelsPanel`, `FlowWorkspace` wiring, and `/lab/flow` fixtures.

## Intentional Refinements

1. **Accessible SVG separation (`role="img"`):** The price + levels chart and the sampled FINRA TRF volume-share strip render as two aligned `<svg role="img">` elements (matching `FlowHedgingPressurePanel` and `FlowPutCallRatioPanel`), and interactive level selection is driven exclusively by the keyboard-navigable `<button aria-pressed>` controls in the level table below the chart (ArrowUp/ArrowDown/Home/End/Escape) rather than click listeners on static SVG `<g>`/`<circle>` nodes inside `role="img"`, avoiding ARIA/Biome `noStaticElementInteractions` violations while preserving full hover `<title>` tooltips and active level highlighting on the SVG.
