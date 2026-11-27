# Stage 8 — Intermediate Zoom-Out Review

![Dark before-and-after UI diagram; mock](before-after.svg)

**Target:** `plan.md`, full file  
**Reviewer:** `egm-zoom-out` — completed

## Finding

### Nit — Keep acceptance tests within the UI change

**Affected scope:** Acceptance check 6.

Requiring tests to prove unchanged API output, provider requests, pagination, orders, and risk behavior broadens verification beyond this UI-only change. The implementation changes `chainKpis` and its presentation; preserve those boundaries without adding broad tests for untouched systems.

**Resolution:** Accepted. The plan now states that the UI-only change does not alter those areas. Focused tests cover the KPI state mapping and the `/stock` presentation.

## Review result

No other findings. The plan focuses on the observed value-slot problem, reuses existing `chainKpis` and `StatCard` code, and adds no speculative functionality.
