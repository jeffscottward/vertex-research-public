# EGM Plan Review: `vertex-chain-oi-yahoo-false-zero`

**Verdict: Revise plan before implementation (4 High, 7 Medium, 4 Low findings).**
The core architecture (dropping Yahoo `openInterest < 1`, conditional `yahoo -> nasdaq -> quantdata` fallback, keeping Nasdaq out of primary chain/expiry/spot/strike discovery) is sound, but the plan has concrete contract-schema, note-limit, caching/latency, edge-case, and test-isolation defects that will cause schema failures, unexpected latency on non-chain endpoints, or broken tests if implemented as written.

---

## Summary of Findings

| ID | Severity | Rubric | Summary |
| --- | --- | --- | --- |
| **F1** | **High** | Contract / Notes | IV + OI note worst-case length is miscalculated (`~235` claimed vs `251+` chars already before adding Yahoo-0 text; 300-char limit risk) and conditional gating on `facts.quantDataRows` hides the Yahoo-0 explanation when Quant Data has no rows |
| **F2** | **High** | Contract Consistency | Adding `"nasdaq"` to `OPTIONS_CHAIN_SOURCES` leaks `"nasdaq"` into `spotSource` and `expiriesSources` (and `spread`/`expectedMove` `spotSource`) unless those schemas switch to `OPTIONS_CHAIN_PRIMARY_SOURCES`; also breaks exhaustive `Record<OptionsChainSourceId, ...>` maps in `options-chain-merge.ts` |
| **F3** | **High** | Latency / Caching / Semantics | `readChain()` is shared by `expiries`, `expectedMove`, and `spread` — running Nasdaq inside `load()` adds 2–8+ s latency to non-OI endpoints, causes `expiries` to report `nasdaq: "used"` despite returning no OI, and `symbol\|nearest` vs `symbol\|<date>` cache keys trigger duplicate Nasdaq fetches |
| **F4** | **High** | Testing / Test Seams | `setOptionsChainForTesting` must reset the singleton `nasdaqSource`, and existing tests that inject fake `yahoo`/`ibkr`/`quantData` without `nasdaq` will hit live `api.nasdaq.com` whenever Yahoo has `0`/`null` OI or fails |
| **F5** | **Medium** | Latency / Edge Cases | Uncached ETF fallback (`stocks` -> `etf`) uses two sequential requests; per-request `AbortSignal.timeout(8_000)` doubles worst-case Nasdaq tail latency to `16_000` ms (on top of Yahoo's 10–20 s) unless a single shared timeout signal is used |
| **F6** | **Medium** | Merge / Service Edge Cases | `needsNasdaqOpenInterest(reads, expiry)` has unhandled edge cases: `yahoo.data.expiry !== expiry`, empty expiries (`allowEmpty: true` / `expiry === null`) producing misleading `off` messages, and `(right, strike)` vs `strike`-only matching |
| **F7** | **Medium** | Merge Edge Cases | `positiveOpenInterest` in `options-chain-merge.ts` must reject `NaN`, `Infinity`, `< 1`, and truncate/validate integers — a bare `>= 1` check lets `1.5` or `Infinity` violate `OptionContractSchema.openInterest` (`z.number().int()`) |
| **F8** | **Medium** | Adapter Edge Cases | Nasdaq adapter specification omits HTTP status / `rCode` matrix (403, 404, 429, 5xx, non-200/400 `rCode`, `data: null`), required Akamai-tolerant headers, comma-formatted strikes (`"1,250.00"`), strict integer parsing (avoid `parseInt`), `drillDownURL` missing/case-insensitive handling, and stale cached `assetClass` recovery |
| **F9** | **Medium** | Contract Invariants | Plan leaves `OptionContractSchema.openInterest` as `nonnegative` (`>= 0`) instead of deciding whether to tighten it to `positive` (`>= 1`) to enforce the "never false zero" invariant at the contract boundary |
| **F10** | **Medium** | Operational / Rollback | No live probe from QuantVPS IP (Akamai frequently 403/hangs datacenter IPs) and no circuit breaker or runtime kill-switch if Nasdaq blocks QuantVPS (forcing repeated 8 s timeouts every 60 s cache expiry) |
| **F11** | **Medium** | Security / Sanitization | Direct calls to `nasdaq.read(symbol, expiry)` need `encodeURIComponent`, symbol normalization (`trim().toUpperCase().replaceAll("-", ".")`), `expiry` format validation, and explicit prohibition against copying Nasdaq `status.bCodeMessage` into `OptionsChainSourceError` |
| **F12** | **Low** | Notes Invariant | Existing `age` note is already **297 / 300 chars** (`98 + 1 + 90 + 1 + 107`); plan should explicitly forbid adding a Nasdaq sentence to `age` |
| **F13** | **Low** | Adapter Edge Cases | `limit=2000` includes `expirygroup` header rows, so a 2000-strike expiry silently drops trailing rows; document or detect truncation (`totalRecord`) |
| **F14** | **Low** | Caching Semantics | Transient Nasdaq failures are swallowed by `outcome()` and cached for the full 60 s `CACHE_TTL_MS` in `readChain` (worth noting in Risks) |
| **F15** | **Low** | Testing / Coverage | 100% coverage plan omits several branch traps (`options.fetch` default arrow, `assetClass` cache eviction > 500, worst-case 4000-contract note-length schema test, `apps/web` exhaustive `OptionsChainSourceId` maps) |

---

## Detailed Review by Rubric

### 1. Note Length Limits (`<= 300` chars, `<= 10` notes) & Note Semantics

* **[F1 — High] Worst-case IV + OI note exceeds plan's `~235` char estimate and risks breaching 300 chars (`contracts/options-chain.ts:199`, `options-chain-merge.ts:358-362, 428-430`).**
  * With `OPTIONS_CHAIN_MAX_ROWS = 2000`, `contracts.length` can reach `4000` (4 digits per source).
  * Prefix alone:
    `IV: Quant Data for 4000, Yahoo Finance for 4000. Open interest: Yahoo Finance for 4000, Nasdaq for 4000, Quant Data for 4000.` = **125 chars** (`48 + 1 + 76`).
  * Existing `PRINT_OPEN_INTEREST_NOTE` (`options-chain-merge.ts:361-362`) is **125 chars** -> `125 + 1 + 125` = **251 chars** already, *before* adding any mention of Yahoo Finance `0` values.
  * That leaves only **48 chars** of headroom (total suffix must be `<= 174` chars). Any phrasing longer than 174 chars will fail `OptionsChainOutputSchema` (`z.string().max(300)`).
  * **Gating bug:** Line 429 appends `PRINT_OPEN_INTEREST_NOTE` only when `facts.quantDataRows` is true. If Yahoo reports `0` while Quant Data is off/failed/empty for the expiry (`facts.quantDataRows === false`), the user gets no note explaining that Yahoo `0` is treated as unreported.
  * **Fix:** Split or craft concise wording verified by a unit test at 4-digit counts (`<= 300` chars). Example (146 chars suffix -> **272 chars** worst case):
    * Always (when Yahoo or QD rows exist): `"Open interest of 0 is read as not reported."` (43 chars).
    * Plus when `facts.quantDataRows`: `" Quant Data print OI fills gaps only."` (37 chars) -> total suffix **80 chars**, worst-case note **206 chars** (comfortably `< 300` while staying at `<= 10` total notes).
* **[F12 — Low] `age` note is at 297 / 300 chars (`options-chain-merge.ts:349-355, 412-424`).**
  * `QUANT_DATA_AGE_NOTE` (98) + space + `IBKR_AGE_NOTE` (90) + space + `YAHOO_DELAY_NOTE` (107) = **297 chars**. Explicitly record as an invariant that no Nasdaq age text may be appended to `age`.
* **Source message length (`contracts/options-chain.ts:134`, `options-chain-merge.ts:84`):** `SOURCE_MESSAGE_MAX = 200`. Proposed `off` message (66 chars) is safe; ensure all `EMPTY_MESSAGES.nasdaq` and Nasdaq error messages stay well under 200 chars.

---

### 2. Contract Consistency & Schema Invariants

* **[F2 — High] `OPTIONS_CHAIN_SOURCES` leaks `"nasdaq"` into primary-only schema fields (`contracts/options-chain.ts:11, 152-172, 542`; `options-chain-merge.ts:54-65, 85-95, 517-536`).**
  * `plan.md:77-78` adds `"nasdaq"` to `OPTIONS_CHAIN_SOURCES` and introduces `OPTIONS_CHAIN_PRIMARY_SOURCES`, but `contracts/options-chain.ts` currently uses `OPTIONS_CHAIN_SOURCES` for:
    * `expiriesSources` (`lines 152-166`: enum, `.max()`, and priority-order `.refine()`)
    * `spotSource` in `quoteFields` (`line 172`)
    * `spotSource` in the spread/expected-move schema (`line 542`)
  * If those remain on `OPTIONS_CHAIN_SOURCES`, Zod and `openapi.json` falsely permit `"nasdaq"` as a `spotSource` and `expiriesSources` entry, contradicting `plan.md:77`.
  * In `options-chain-merge.ts`, `OPTIONS_CHAIN_PRIORITY` `satisfies` (`lines 62-63`), `listed` (`lines 517-521`), and `quoteTimes: Readonly<Record<OptionsChainSourceId, string | null>>` (`line 532`) will fail typecheck or require dummy `nasdaq` entries unless typed against `OptionsChainPrimarySourceId`. Meanwhile `EMPTY_MESSAGES` (`line 85`) and `NOTE_NAMES` (`line 91`) **do** need explicit `"nasdaq"` entries (e.g., `EMPTY_MESSAGES.nasdaq = "Nasdaq has no open interest values for this expiry"`).
  * **Fix:** Export `OPTIONS_CHAIN_PRIMARY_SOURCES = ["quantdata", "ibkr", "yahoo"] as const` and `OptionsChainPrimarySourceId` from `contracts/options-chain.ts`, and switch `expiriesSources`, both `spotSource` fields, `OPTIONS_CHAIN_PRIORITY.spot/expiries`, `listed`, and `quoteTimes` to it.
* **[F9 — Medium] `OptionContractSchema.openInterest` invariant (`contracts/options-chain.ts:46, 112`).**
  * Currently `openInterest: count` (`z.number().int().nonnegative().nullable()`), which still accepts `0`.
  * Decide explicitly: tighten `OptionContractSchema.openInterest` to `z.number().int().positive().nullable()` (keeping `volume: count` nonnegative and `OptionsChainSnapshotQuoteSchema.openInterest` as `int32Count`) so the "never false zero" guarantee is contract-enforced, OR document why `nonnegative` is intentionally retained for API compatibility.

---

### 3. Merge, Service, Latency & Caching Edge Cases

* **[F3 — High] `readChain()` coupling across `expiries`, `chain`, `expectedMove`, and `spread` (`server/options-chain.ts:264-293, 312-397`; `contracts/options-chain.ts:170, 176`; `options-chain-merge.ts:624-628`).**
  * All four endpoints (`expiries`, `chain`, `expectedMove`, `spread`) call `readChain()`.
  * `OptionsChainExpiriesOutputSchema` embeds `...quoteFields`, which includes `sources: OptionsChainSourceStatusesSchema` (now a 4-tuple).
  * **Consequences if Nasdaq runs unconditionally inside `load()`:**
    1. `optionsChain.expiries` (which returns NO contracts or OI!), `expectedMove`, and `spread` all block on Nasdaq for 2–3.5 s (up to 8+ s on timeout) whenever the nearest expiry has a Yahoo `0`/missing OI.
    2. `mergeOptionsExpiries()` runs full `merge()` (`options-chain-merge.ts:628`), so `expiries` will report `nasdaq: { status: "used" }` even though the response contains no open interest!
    3. `readChain` keys by `symbol | (expiry ?? "nearest") | marketHistory.url | quantData.baseUrl` (`lines 272-277`). A page load calling `expiries` (`nearest`) followed by `chain({ symbol, expiry: "2026-12-18" })` misses the cache and triggers **two** separate Nasdaq fetches for the same `(symbol, expiry)`.
  * **Fix:** Decide explicitly between:
    * **(a) Skip Nasdaq for non-OI endpoints (`expiries`, `expectedMove`, `spread`):** Pass an `includeOpenInterestFallback: boolean` flag (included in the cache key or layered cleanly so `chain` can still reuse primary reads, OR separate Nasdaq read with its own short-lived `(symbol, expiry)` 60 s cache keyed by `(normalizedSymbol, expiry)`). That eliminates duplicate Nasdaq calls between `nearest` and explicit `expiry`, keeps `expiries`/`expectedMove`/`spread` fast, and sets `nasdaq: { status: "off", message: "Not asked: endpoint does not display open interest" }` on `expiries`.
    * **(b) Keep single `load()` cache:** Explicitly accept and document the latency impact on `expiries`/`expectedMove`/`spread` and add a lightweight `(symbol, expiry)` 60 s in-flight/response cache inside the Nasdaq adapter so `nearest` -> `<date>` does not double-fetch Nasdaq.
* **[F5 — Medium] Uncached ETF fallback doubles tail latency (`plan.md:72, 74, 109`).**
  * On an uncached ETF (`SPY`, `IWM`, `QQQ`), Nasdaq does two sequential GETs (`assetclass=stocks` -> `rCode 400`, then `assetclass=etf` -> `200`).
  * A per-fetch `AbortSignal.timeout(8_000)` allows up to **16 s** in Nasdaq alone (plus Yahoo's 10 s timeout, or 20 s if Yahoo fetches a second expiry at `server/options-chain.ts:231`).
  * **Fix:** Create **one** `const signal = AbortSignal.timeout(timeoutMs)` at the top of `nasdaq.read(symbol, expiry)` and pass it to both `stocks` and `etf` fetches so total Nasdaq time is strictly bounded to `8_000` ms.
* **[F6 — Medium] `needsNasdaqOpenInterest(reads, expiry)` edge cases (`plan.md:84-85`; `server/options-chain.ts:222-261`; `options-chain-merge.ts:105-112, 179-201`).**
  * **Yahoo expiry mismatch:** `yahoo.status === "ok"` does NOT guarantee `yahoo.data.expiry === expiry` (`server/options-chain.ts:223-233`, `options-chain-merge.ts:194`). If `yahoo.data.expiry !== expiry`, Yahoo has **zero** contracts for `expiry`; checking `yahoo.data.calls/puts` without guarding `yahoo.data.expiry === expiry` will read the wrong expiry's OI!
  * **Matching key:** Must check Yahoo OI coverage by `(right, strike)` (`contractKey`), not just `strike` — e.g., Yahoo having `160C` OI `> 0` must not hide a Quant Data/IBKR `160P` lacking Yahoo OI.
  * **IBKR filtering:** Use `liveQuotes(reads.ibkr)` (and `ibkr.expiry === expiry`), matching `indexContracts()` (`options-chain-merge.ts:105-112, 186`).
  * **Empty expiry / `expiry === null`:** When `expiry === null` (`server/options-chain.ts:254`) or when `allowEmpty === true` yields 0 contracts across Yahoo, IBKR, and Quant Data, Nasdaq should NOT be called, and the `off` message must NOT claim `"Yahoo Finance reported open interest for every contract"` (misleading when 0 contracts exist). Use e.g. `"Not asked: no option contracts for this expiry"`.
* **[F7 — Medium] `positiveOpenInterest` defense-in-depth numeric edge cases (`plan.md:66`).**
  * In `options-chain-yahoo.ts`, `optionalNumber` enforces `.finite()`, so `value !== undefined && value >= 1 ? Math.trunc(value) : null` handles `0`, `-1`, `0.5`, `1.9`.
  * In `options-chain-merge.ts`, direct/synthetic callers can pass `NaN`, `Infinity`, `-5`, `0`, or fractional `1.5`. A naive `value >= 1` lets `1.5` and `Infinity` through, violating `OptionContractSchema.openInterest` (`z.number().int()`).
  * **Fix:** `const positiveOpenInterest = (v: number | null | undefined): number | null => v !== null && v !== undefined && Number.isFinite(v) && v >= 1 ? Math.trunc(v) : null;` (and guard `Math.trunc(v) <= Number.MAX_SAFE_INTEGER`).
* **[F8 — Medium] Nasdaq adapter parsing, HTTP/rCode, headers, and cache edge cases (`plan.md:69-74`).**
  * **HTTP & `rCode` error matrix is incomplete:** Plan specifies only `rCode === 400` and mentions `403`/`429` in Risks. Explicitly specify:
    * Fetch throw (network / timeout / `redirect: "error"`) -> `UNAVAILABLE`
    * HTTP `404` -> `NOT_FOUND`
    * HTTP `429` or `>= 500` -> `UNAVAILABLE`
    * HTTP `403` -> decide `UNAVAILABLE` (WAF/rate-block) vs `UPSTREAM_ERROR` (match Yahoo or Risks table explicitly)
    * Other non-200 HTTP -> `UPSTREAM_ERROR`
    * Invalid JSON / body > 4 MB -> `UPSTREAM_ERROR`
    * `status.rCode === 400` on both `stocks` and `etf` -> `NOT_FOUND`
    * Other `status.rCode !== 200` (e.g. `401`, `404`, `500`) -> `UPSTREAM_ERROR` (or `404` -> `NOT_FOUND`, `>= 500` -> `UNAVAILABLE`)
    * `rCode === 200` with `data === null`, `data.table === null`, or `data.table.rows === null` -> empty rows (`[]`), not a crash (matches `totalRecord: 0` probe on Saturday `2026-12-05`).
  * **Request headers:** `api.nasdaq.com` is Akamai-protected and commonly blocks/stalls bare `fetch`. Specify exact headers (`user-agent`, `accept: "application/json, text/plain, */*"`, `accept-language: "en-US,en;q=0.9"`).
  * **Strike parsing:** Strip commas from `strike` (`"1,250.00"` -> `1250`), require `Number.isFinite(strike) && strike > 0`.
  * **Strict OI integer parsing:** Do NOT use `parseInt` (accepts `"123abc"`, `"123.9"`). Strip commas, match `/^\d+$/`, convert with `Number()`, require `Number.isSafeInteger(n) && n >= 1`.
  * **`drillDownURL` expiry check:** Match case-insensitively (`/\d{6}[cp]\d{8}$/i`), and decide behavior when `drillDownURL` is absent/null vs malformed (plan says "If `drillDownURL` ends in ...", which fails open if Nasdaq alters URL format; consider also validating `expirygroup` header text or failing closed if a URL is present with a non-matching date).
  * **Stale `assetClass` cache entry:** If a cached `assetClass` returns `rCode === 400`, evict it and retry the alternate class once before throwing `NOT_FOUND`. Never retry `"etf"` or cache on transient errors (429/5xx/timeout).
* **[F13 — Low] `limit=2000` header-row truncation:** `table.rows` includes `expirygroup` rows, so an expiry with 2000 strikes drops >= 1 strike silently; accept or emit `warning` when `totalRecord > dataRows`.
* **[F14 — Low] Cached transient Nasdaq failures:** Because `outcome("Nasdaq", ...)` catches errors instead of rejecting `load()`, a transient Nasdaq failure is cached for 60 s in `readChain` (`server/options-chain.ts:285-287` only evicts on promise rejection). Document in Risks.

---

### 4. Security

* **[F11 — Medium] URL construction & upstream error message sanitization (`plan.md:70-74`).**
  * Always normalize `symbol` inside the adapter (`symbol.trim().toUpperCase().replaceAll("-", ".")`), validate `expiry` against `/^\d{4}-\d{2}-\d{2}$/` (or `encodeURIComponent`), and `encodeURIComponent(normalizedSymbol)` in the URL path so direct adapter calls cannot inject path traversal (`../`) or extra query parameters.
  * Never include Nasdaq's `status.bCodeMessage` (or URL / raw body) in `OptionsChainSourceError.message` — use fixed safe strings only.
  * Keep `redirect: "error"`, `readCappedText(response, 4 * 1024 * 1024, ...)`, and `.use(requireOperator)` on all handlers.

---

### 5. Testing & 100% Coverage

* **[F4 — High] `setOptionsChainForTesting` singleton reset & live-network trap in existing tests (`server/options-chain.ts:71, 77-82, 102`).**
  * `nasdaqSource` must be reset (`nasdaqSource = null`) inside `setOptionsChainForTesting`, mirroring `yahooSource = null`, so cached `assetClass` maps and injected doubles never leak across tests.
  * **Critical trap:** Any existing test calling `setOptionsChainForTesting({ yahoo: fakeYahoo, ibkr: fakeIbkr, quantData: fakeQd })` *without* passing `nasdaq` will fall through to `createNasdaqOptionsOpenInterestSource()` and make **live HTTP calls to `api.nasdaq.com`** whenever `fakeYahoo` has `0`/`null` OI or fails!
  * **Fix:** Audit and update all existing `setOptionsChainForTesting(...)` test setups to pass a deterministic fake/off `nasdaq` source (while keeping bare `setOptionsChainForTesting()` resetting to production defaults in `afterEach`), and update 3-tuple `sources` assertions in both `packages/api` and `apps/web`.
* **[F15 — Low] 100% coverage traps & missing test cases:**
  * Avoid uncovered default arrow functions in `createNasdaqOptionsOpenInterestSource` (e.g., pass `globalThis.fetch` via a tested default or extract helper cleanly, matching `options-chain-yahoo.ts` coverage patterns).
  * Explicitly cover: `assetClass` cache hit + eviction at 500 entries; stale cached `assetClass` eviction; all HTTP/rCode error branches; `redirect: "error"` rejection; `readCappedText` overflow; invalid JSON; `totalRecord: 0` with `table.rows: null`; comma-formatted strike & OI; `"--"`, `"0"`, `"-5"`, `"1.5"`, `"12abc"`, `NaN`, `Infinity`; `drillDownURL` match vs mismatch; `needsNasdaqOpenInterest` when `yahoo.data.expiry !== expiry` and when `expiry === null`/empty; `chainNotes` worst-case 4000-contract schema parse (`OptionsChainOutputSchema.parse`); contract test proving `spotSource` and `expiriesSources` reject `"nasdaq"`.
  * Check `apps/web` for any exhaustive `Record<OptionsChainSourceId, ...>` UI mappings (badges/labels/order) beyond test fixtures.

---

### 6. Operational, Verification & Rollback Gaps

* **[F10 — Medium] QuantVPS Akamai risk & lack of runtime kill-switch (`plan.md:38-51, 107-112, 145-148`).**
  * The public-source probe ran from the cloud sandbox, **not** from QuantVPS. `api.nasdaq.com` (Akamai) routinely returns HTTP 403 or tar-pits datacenter/VPS IP ranges.
  * If QuantVPS is blocked or rate-limited after deploy, every cold chain request with a Yahoo zero will stall for the full `8_000` ms timeout every 60 s with no mitigation short of reverting and waiting for an off-hours redeploy (`restart-when-idle.sh`).
  * **Fixes:**
    1. Add a lightweight pre-deploy or deploy-time live probe from QuantVPS to `api.nasdaq.com` (and have `live-check.mjs` assert/report `sources[3]` Nasdaq status and latency, not just final OI, so silent 100% Nasdaq failure falling back to Quant Data isn't missed).
    2. Consider either a minimal env kill-switch (e.g. disabling Nasdaq -> `OptionsChainSourceOff`) or a simple consecutive-failure cooldown (e.g., after N consecutive 403/429/timeout failures, skip Nasdaq for 5 min with `status: "off"`/`"failed"`) to protect chain latency without requiring an emergency off-hours rollback.
  * **Rollback note (`plan.md:148`):** Confirm that reverting the commit cleanly reverts `openapi.json`, `OptionsChainSourceStatusesSchema` (4-tuple -> 3-tuple), and `apps/web` together; note that `live-check.mjs` criterion (c) (`yahooOi > 0`) remains compatible if rolled back, while criterion (d) will fail again on Yahoo false zeros as expected.
