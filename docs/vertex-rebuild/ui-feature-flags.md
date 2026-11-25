# UI feature flags

`apps/web` provides a minimal, typed feature-flag layer for isolating experimental UI and research prototypes without affecting production views.

## Guardrails

- **UI and research views only.** Every registered flag carries `area: "ui" | "research"`. Never gate or alter execution-engine code, live orders, arming, kill switches, or risk settings behind UI feature flags.
- **Default off.** Every flag in `FEATURE_FLAG_REGISTRY` (`apps/web/src/lib/feature-flags.ts`) sets `defaultEnabled: false`.
- **Production isolation.** Client-side query-string (`?ff=`) and `localStorage` overrides are permitted only when `APP_ENV` is explicitly `development` or `test` and `APP_URL` is absent or points to a local hostname (`areUiFlagClientOverridesAllowed` in `packages/config/src/server.ts`). In `production` and on deployed non-local origins (including the QuantVPS production serve, which uses `APP_ENV=development` on a non-local tailnet `APP_URL`), client overrides are ignored and the dev toggle panel does not render.

## Precedence

When resolving a flag (`resolveFeatureFlagEntries` / `resolveFeatureFlags`), the highest-priority source wins:

1. Query parameter `?ff=<tokens>` (only when client overrides are allowed)
2. Browser `localStorage` key `vertex.ui-flags.v1` (only when client overrides are allowed)
3. Server environment variable `VERTEX_UI_FLAGS` (comma-separated kebab-case tokens, e.g. `ui-experiments-panel=on`, `research-prototype-slot`, or `-ui-experiments-panel`)
4. Registry default (`false`)

Unrecognized flag names and malformed override values are ignored safely so retiring an old flag never breaks startup or page loads.

## Layout

| Path | Role |
| --- | --- |
| `packages/config/src/server.ts` | `VERTEX_UI_FLAGS` Zod validation and `areUiFlagClientOverridesAllowed` |
| `apps/web/src/lib/feature-flags.ts` | Typed `FEATURE_FLAG_REGISTRY`, token parser/serializer, deterministic resolver |
| `apps/web/src/lib/server-feature-flags.ts` | `getServerFeatureFlagSnapshot` and `isServerFeatureFlagEnabled` |
| `apps/web/src/components/feature-flags-provider.tsx` | `FeatureFlagsProvider`, `useFeatureFlags`, `useFeatureFlag`, `<FeatureGate>` |
| `apps/web/src/components/feature-flags-panel.tsx` | Dev/viewer flag toggle panel and non-invasive smoke banners |

## Usage

Server component:

```ts
import { isServerFeatureFlagEnabled } from "../lib/server-feature-flags.ts";

const enabled = isServerFeatureFlagEnabled("ui-experiments-panel");
```

Client component:

```tsx
import { FeatureGate, useFeatureFlag } from "../components/feature-flags-provider.tsx";

const enabled = useFeatureFlag("research-prototype-slot");
```

Dev and viewer testing:

- Visit `/settings/workspace` (or `/lab/settings-workspace` when `VERTEX_UI_LAB=on`) to toggle registered flags in `localStorage` and view the smoke banners.
- Pass `?ff=ui-experiments-panel` or `?ff=ui-experiments-panel,research-prototype-slot` in the URL to override flags for a single view or screenshot capture.
