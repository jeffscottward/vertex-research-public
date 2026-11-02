# Vertex configuration consolidation

This foundation utility gathers a bounded, local credential-presence inventory. It does not authenticate, resolve a vault reference, contact a provider, provision infrastructure, start a service, migrate a database, send a notification/email, or enable trading. A populated variable is not proof of validity, entitlement, connectivity, delivery, account approval, or production readiness.

## Files and trust boundaries

- `scripts/vertex-config/core.ts` implements strict dotenv parsing, exact equality/conflict handling, canonical-name allowlists and explicit service projection.
- `scripts/vertex-config/files.ts` implements bounded regular-file reads and atomic private writes.
- `scripts/vertex-config/cli.ts` is import-safe; only the thin root entry `scripts/vertex-config.ts` (`bun run vertex:config …`) runs a command. Reviewed modes (`consolidate --dry-run|--apply-reviewed`) run only when `VERTEX_APPROVED_CHECKOUT` names this exact checkout; an absent or different value fails closed.
- `private/configuration/.env` is the single canonical local master bundle. It is ignored by Git and mode `0600`. Never source it, print it, upload it, or use it as a process-wide environment file.
- `private/configuration/inventory.json` is ignored and mode `0600`. It contains canonical names, selection status, relative source provenance, unresolved-reference presence, absent names and missing-file metadata. It contains no values, addresses, account identifiers or secret hashes.
- Root `.env` is separate, ignored and mode `0600`. It contains only local development defaults and explicitly dummy auth/throttle strings. Its database URL is empty: no existing DarkFactory development database and no production database is used. Generated app/auth URLs both use `https://vertex-research.localhost`, a Vertex-isolated loopback origin following the baseline `.localhost` HTTPS convention; it does not reuse the baseline DarkFactory route. Availability is unverified: this utility neither provisions DNS/certificates nor starts a listener. Parent-owned provisioning must choose a Vertex-specific database/user and unused database port before changing this state.
- `private/` may also contain a separate broker worksheet. This utility does not read, modify or publish it.

The master is deliberately **not** a runnable development configuration. Development roots do not inherit its credentials. Root runtime states are disabled, access is read-only, order submission is disabled, paper/read-only broker controls remain explicit, email uses preview transport, and jobs/storage/telemetry remain off.

## Authorized input and parsing

Only the root `.env`, `.env.schema` and `.env.example` files in the five original sibling repositories are considered: `gamma-forge`, `vertex-quant`, `vertex-research`, `full-port`, and `darkfactory`. For the documented sibling layout, the first four are beside this repository and DarkFactory is under the sibling `tools` directory. There is no recursive discovery, archive/worktree traversal, `node_modules` scanning, shell sourcing, interpolation or evaluation. Originals are opened read-only. Symlinks, nonregular files, hardlinked inputs and oversized files are refused.

Genuinely missing repository directories, including missing intermediate directories in the canonical layout, contribute their three expected relative file labels to `missingSources`; they do not abort inventory of available repositories. The collector still checks existing ancestors before classifying a source as absent. A symlink (including a dangling link or one hiding an absent descendant), invalid directory/file type, insecure owner/mode, permission denial or unexpected filesystem error remains a failure, not an absent-source result. No new source locations are searched.

Parsing uses Node/Bun's `node:util.parseEnv` dotenv semantics with a strict assignment scanner. The scanner retains duplicate declarations instead of silently accepting the last value. Comments, optional `export`, quoted values and multiline quoted values are data; shell-looking text is never executed. Malformed sources block application. Errors are fixed diagnostic codes, never source text or provider output. Varlock remains the application's schema/configuration convention, but this utility intentionally does not run Varlock resolution/validation: that might resolve secrets or make external checks.

Only exact authorized canonical names present in the current public `.env.example` can enter the master (upstream DarkFactory removed `.env.schema`). The only legacy aliases are `IB_GATEWAY_HOST` → `IBKR_HOST` and `IB_GATEWAY_PORT` → `IBKR_PORT`. SSH endpoints are not API endpoints; names are never guessed or synthesized. Nonempty literals come only from `.env`; schema/example literal defaults are not credentials. Literal `op://` references may be retained from any of the three file types, without resolving or unlocking 1Password. Computed Varlock expressions/annotations are not evaluated or treated as resolved credentials.

Identical decoded values coalesce. Distinct eligible values, including a literal versus an unresolved reference, conflict and stay unselected. Conflict records reveal only names and relative provenance. Existing master entries cannot be overwritten with a different value; a conflict involving an existing entry blocks the entire write. Unsupported names remain unselected and visible as schema gaps; SSH passwords and inherited trading/live/read-only booleans are excluded. A database URL is eligible only as an unresolved vault reference or a PostgreSQL URL with the documented PlanetScale host suffix; even that shape check does **not** validate credentials, TLS, pooling or entitlement. Old local database URLs are ineligible.

## Explicit commands

Run from the repository root using the pinned toolchain already provisioned by the parent workflow:

```sh
bun run vertex:config consolidate
```

This checks Git ignore/tracking boundaries, plans everything in memory, and writes only ignored local artifacts. Existing root `.env` must exactly match the utility's isolated defaults; otherwise the operation stops for manual reconciliation. No credentials are printed. Reruns retain exact master entries; no automatic conflict winner exists.

A projection must explicitly name its environment, service and individual keys:

```sh
bun run vertex:config project --environment development --service research --keys QUANTDATA_API_KEY
```

This example fails if the key is absent. It creates only a private file at `private/configuration/projections/development-research.env`, never launches a process and never injects the file. Existing projection files are not overwritten. The caller must inspect provider entitlement separately before any authorized use.

Only `development` and `test` environments are accepted. Browser projections accept no master credentials. Research/market-data projections accept only explicitly requested QuantData/financialdatasets names; Agno and JEV receive only their own selected keys. Research/browser cannot receive broker, deployment, database, email, notification or SSH credentials. Broker, deployment, notification and unknown services, production/staging environments, public-prefixed secret names, missing requested keys and malformed selections are refused. Projection retains disabled runtime controls. No projection is created automatically by consolidation.

Writes use an exclusive per-target lock and an owner-only, same-directory temporary file. The complete file is fsynced before publication; initial creation uses an exclusive link, replacement checks expected prior content and uses rename. Mode `0600`, ownership, regular-file identity and safe parent paths are checked. Failed preparation removes temporary files and leaves the destination unchanged. Each file is atomic; the root defaults, bundle and metadata are not a multi-file filesystem transaction. A post-publication durability error is reported distinctly; inspect existing files before retrying. The metadata can be regenerated from the same read-only sources.

## Foundation boundary corrections

- Generated local defaults now round-trip through the server environment schema after supplying only a synthetic valid local PostgreSQL binding in a pure regression test. HTTPS remains mandatory in development/test as well as production; production still rejects loopback origins. Schema acceptance is not evidence that a database, HTTPS listener, provider or runtime is available.
- Production server validation rejects either known public Vertex development secret in either the authentication or contact-throttle field, including surrounding whitespace. Errors identify only the field and fixed diagnostic, never its value. Development/test retain their intended local defaults; independent non-default synthetic keys remain accepted. Current public `.env.schema` and `.env.example` secret fields are empty and remain invalid required values; no additional nonempty public-template defaults were established by this review.
- Direct `readCanonicalSources` regressions use temporary synthetic layouts to distinguish absent repositories/files from unsafe paths and filesystem failures while retaining available inputs. Source files remain read-only, conflict handling and atomic owner-only publication are unchanged, and production projections remain forbidden.

These corrections have not been applied to real private configuration files. A root `.env` generated with the earlier HTTP defaults will not be silently replaced: exact-content reconciliation continues to reject it until a separately authorized manual reconciliation. The focused regressions and all generation/format/type/build/coverage gates are deferred to the integration owner during the parallel foundation repair; this document makes no passing-test or readiness claim.

## Current local result and remaining work

The initial local consolidation selected only `EMAIL_FROM`, `IBKR_ACCOUNT_ID` and `IBKR_PORT`. These are configuration/account-presence facts, **not usable API-credential or broker-readiness evidence**. The three expected root files were absent in Gamma Forge and Vertex Research; Full Port lacked `.env` and `.env.example`; Vertex Quant lacked `.env.schema`. These nine missing files were not sought in archives, worktrees, nested services or vaults. QuantData/financialdatasets keys and the observed Resend/R2 entries were empty. Existing old local database configuration was deliberately not copied. No conflicts were selected and no provider validation ran.

Credential consolidation is therefore **incomplete**. Broker username/password and QuantVPS SSH host/user/key-reference names are not in the current canonical schema and remain unselected. The SSH password is excluded, not available to any automated connection workflow. Cloudflare management, notification, Agno and JEV credential readiness has not been established. Schema changes, additional source scopes and manual secret-manager work require a separately scoped integration decision; this utility does not widen scope to make the result appear complete.

Remaining checks are provider-specific and must not be inferred from this inventory:

- QuantData and financialdatasets: identity/key validity, subscribed products, historical depth, exchange/market-data entitlements, rate limits, permitted storage/research use and point-in-time coverage.
- QuantVPS: subscription and host entitlement, independently verified host identity, approved access method, service/API capability and monitoring. Do not reuse a stored SSH password in automation.
- IBKR: human broker-login setup, correct paper account and permissions, gateway/API configuration, read-only enforcement, market-data subscriptions, account mapping and reconciliation. Credential presence is not approval to submit an order.
- Cloudflare/R2: correct isolated account/project/bucket, resource ownership, token least privilege and explicit deploy authorization. An R2 key is not a Cloudflare deployment token.
- PlanetScale: isolated development resources, explicit production target approval, provider-managed pooling, verified TLS, least-privilege role and approved migration/restore policy. Root database availability remains blocked by design.
- Email/notification: sender/domain or topic authorization, destination consent, sending limits, recipient isolation and a separately authorized delivery test. Nothing was sent.
- Agno/JEV: endpoint identity, authentication, allowed-origin scope, data-processing/privacy approval and operational integration. References alone are not a connected installation.

Core behavioral tests were authored before implementation; additional CLI tests cover import safety and redacted failure behavior. Coverage includes duplicates/conflicts, quoted values, inert shell payloads, vault references, schema gaps, client leakage, forbidden services/environments, missing-key/partial-output failures and atomic `0600` writes. Per the foundation contract, tests/builds/lint/formatters and project gates are **not run by this workstream**; the parent owns final verification. The consolidation command itself was applied locally and its artifact modes, Git ignore status and root isolation predicates were inspected without printing credential values. A subsequent local apply verified byte-for-byte original-source preservation and unchanged root/master contents without computing or exposing secret hashes.
