# Retirement plan: vertex-portfolio (IB client 78)

Status: plan only (audit phase 2). Nothing in this document is executed. Date: 2026-11-02.

## Background

The owner chose one IBKR reader: `ibkr-monitor.service` (IB client 195) on QuantVPS. The
Mission control glance card (#68) and `/portfolio` (#113, #115) read it through
`ibkrMonitor.*`. A second reader, `vertex-portfolio.service` (IB client 78), still runs.
Two readers can show different NLV at the same moment (audit finding P1-2).

## Current users of vertex-portfolio (code on 2026-11-02)

| User | Path | Effect if removed without a replacement |
| --- | --- | --- |
| Academy deploy gates | `packages/api/src/server/academy.ts` calls `fetchPortfolioMonitor` for NLV and open premium | The NLV gate fails closed ("NLV unknown"); every Academy deploy request needs an override |
| `PortfolioMonitor` default gateway | `portfolio-monitor.tsx` falls back to `createBrowserPortfolioMonitorGateway()` when no gateway is passed | No page mounts it without a gateway today; the fallback is dead code |
| oRPC procedure | `portfolioMonitor.snapshot` (contract, router, `route.ts` config, `openapi.json`) | None after the steps below |
| Config | `VERTEX_PORTFOLIO_URL` in `packages/config/src/server.ts` and the rig `.dev.vars` | None after the steps below |
| QuantVPS unit | `vertex-portfolio.service` (rollback steps in `quantvps-status-endpoint.md`) | Frees IB client 78 |

## Steps (one small PR each, merge only on green CI)

1. **Academy reads ibkr-monitor.** Change `academy.ts` to use `fetchIbkrMonitorSnapshot(context.ibkrMonitor)`
   for NLV and open premium. Keep the fail-closed rule: an unready or stale feed is unknown, never
   zero. Test: gates with a live, stale and unconfigured ibkr-monitor fixture. Update
   `docs/vertex-academy.md` (`IBKR_MONITOR_URL`).
2. **Remove the dead fallback.** Make `gateway` required on `PortfolioMonitor`; delete
   `createPortfolioMonitorGateway` and `createBrowserPortfolioMonitorGateway`.
3. **Remove the procedure.** Delete `portfolioMonitor.snapshot` from the contract, router and
   `route.ts`; keep the shared output schema (ibkr-monitor uses it). Regenerate `openapi.json`.
   Remove `VERTEX_PORTFOLIO_URL` from the env schema and docs.
4. **Deploy** the web app through `infra/quantvps/restart-when-idle.sh` and check `/portfolio`,
   `/dashboard` and an Academy deploy-gate read on the live site.
5. **Stop the unit (owner approval required).** `systemctl disable --now vertex-portfolio` on
   QuantVPS, only after step 4 is verified live for 24 h. Keep the unit file and the rollback steps
   for 7 days, then remove them in a separate change.

## Risks and limits

- Field coverage of the two services was not compared field by field (audit limitation). Step 1
  needs a fixture check that ibkr-monitor supplies NLV and per-name option premium.
- Stopping the unit is a service change on the trading host. It needs explicit owner approval and
  must not touch ibkr-monitor, the IB gateway, Nautilus or the exec node.
- Rollback for steps 1-3: revert the PR. Rollback for step 5: `systemctl enable --now vertex-portfolio`.
