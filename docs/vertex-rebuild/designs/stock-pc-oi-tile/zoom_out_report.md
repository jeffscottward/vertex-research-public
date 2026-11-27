# Stage 5 — Zoom-out and Inventive Catalyst Review

![Dark before-and-after UI diagram; mock](before-after.svg)

## Scope

This review checks whether the plan fixes the user-visible put/call open-interest tile without changing the meaning of incomplete open-interest data or widening into provider work.

## Findings

- **Nit — State coverage in the value slot:** Specify the displayed value for loading, no-answer, and error states as well as the partial-coverage case. Keep the explanation in muted detail text. This makes the compact-tile contract complete for every chain state.
- **Inventive Catalyst:** No false compromise detected. Keep the true missing-data semantics and use the tile's value/detail hierarchy to make them readable.

## Browser reproduction

The isolated Playwright run opened the real `/stock/NVDA?tab=options` page with a mock route that set some `openInterest` values to `null`. It confirmed the chain table shows `no OI`. The put/call tile instead rendered `No put/call ratio: call open interest reported for 27 of 41 contracts; put open interest reported for 30 of 41 contracts` in the large value slot. The expected short-value assertion failed before implementation, confirming the planned surface and cause. The failure screenshot is `test-results/artifacts/stock-detail-oi-repro-repr-fc593-ext-in-the-stock-value-slot-e2e/test-failed-1.png`.

## Scope check

Keep the change within the stock-detail tile and its tests. Preserve `null` as missing data; do not change provider requests, pagination, aggregation, contract data, trading behavior, or risk rules.

## Resolution

Applied. The plan now keeps `—` in the OI value slot for loading, no-answer, and error states, and puts each state’s explanation in muted detail.
