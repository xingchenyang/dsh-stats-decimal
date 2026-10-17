# Development Guide

This guide records technical context, key decisions, and handoff information. Installation and configuration are in [README.md](README.md); user-visible release history is in [CHANGELOG.md](CHANGELOG.md); maintenance requirements are in [AGENTS.md](AGENTS.md).

## Current status

- Compatibility target: DeepSeek Harness `v0.2.1-rc.1` (official release commit `1600d8a1e140dcde43a1a0941940a0480712c011`). Version `0.8.5` declares only `engines.dsh: "=0.2.1-rc.1"`.
- Desktop loads the full Web application through Electron but has its own `$DSH_HOME/profiles/desktop`, plugin package-manager state, and bundled pnpm, isolated from the Web profile. `dsh.client.platform: "web"` applies to the embedded Web interface. The daily estimate uses the renderer's IANA time zone and provider-neutral Session logs in either surface, for both the DeepSeek API-key and account-login routes. Manage Web plugins with `dsh plugin --profile web`; manage Desktop plugins from the app's Plugins page and configure the Desktop profile separately.
- Upstream reference: [DSH v0.2.1-rc.1 release](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-rc.1) (commit `1600d8a1e140dcde43a1a0941940a0480712c011`).
- Stack: ESM JavaScript, Cordis Host/Web bundles, `@deepseek-ai/schemastery`, and `zod`.
- The billing projection version is `stateVersion: 7`. Version 5 added statutory-holiday date spans; version 6 added localized holiday names; version 7 changes how reported cache-write usage is priced and refolds prior sessions.
- For a GitHub installation, Desktop's profile package manager installs the dependencies declared by the plugin. Restart Desktop after installing or updating. To update an installed GitHub plugin, submit the same URL again through Add Plugin.
- A Desktop local-directory installation is recorded as `link:` and does not install dependencies into the linked directory. Install the declared runtime dependencies in the repository before using this development path. The public `dsh` CLI does not manage the Desktop profile.

## Compatibility qualification

- DSH `v0.2.1-rc.1` is the sole compatibility target for plugin `0.8.5`. The pinned [plugin-compatibility implementation](https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/1600d8a1e140dcde43a1a0941940a0480712c011/packages/boot/app-boot/src/plugin-compatibility.ts) uses `semver.satisfies(runtimeVersion, range, { includePrerelease: true })`; when `engines.dsh` exists, it decides alone and DSH peers are ignored. The exact range admits only `0.2.1-rc.1`; no DSH peer dependency is added.
- Gate B1 accepted RC.1 source, regression, and isolated synthetic usage/UI qualification. The runtime check exercised candidate loading, a valid usage-bearing persisted Session, billing projection, authenticated daily-cost RPC, and plugin disable/re-enable/restart. Balance-provider runtime behavior, real inference or credentials, normal-width browser layout, and graceful shutdown were not established by that usage qualification.
- DSH `v0.2.0-rc.2` is not in the `0.8.5` compatibility range. Its pinned source-contract and regression checks were accepted, but runtime qualification remains **NOT TESTED**. During that qualification, [an upstream report](https://github.com/deepseek-ai/deepseek-harness/discussions/8257) raised a possible publication gap for `@deepseek-ai/dsh-client-ui-settings-account@0.2.0-rc.2`; local registry access was inconclusive. This records the historical qualification limitation and does not assert the package's current registry status. It is not an outstanding release gate under the accepted Gate B1 scope.

## Architecture and data flow

1. The Host-side `billingLedger` folds usage events from `assistant/message`.
2. `lib/pricing.js` selects the model price effective at the event time, then calculates cost from cache buckets, output tokens, and the Beijing-time peak/off-peak period. `lib/billing-calendar/` provides the single annual statutory-holiday calendar. Weekends are checked first; statutory holidays on weekdays also use off-peak pricing.
3. The projection's `wire.viewSchema` sends cumulative cost, enabled currencies, pricing settings, and holiday spans with Chinese and English names to the Web client. It retains its Host-local `today` field as a change signal; the displayed current-session daily amount comes from the client-time-zone session-log scan described below.
4. The Web client preserves DSH's native `StatsPills` and registers a separate billing item in `conversation.composer.dock`. `ContextMeter` is a later sibling of the dock slot. When billing is enabled, the client permits the shared footer to wrap and uses flex order to place billing below both native statistics items as a separate second row. The row gap is 4 px and the billing row has no background decoration.
5. Balance uses DSH Connection's shared exact-match `/api` route. With `balance.enabled=true`, the browser sends only its Session ID. The Host reads `sessionController.projections({ sessionId }, signal)` without activating an Agent, then follows `modelSelection.next`, `lastUsed`, or `agentDefaultModel.currentSelection()` for a new Session. It dispatches only to that provider: `deepseek-account` uses DSH's account service and sums its recharge and bonus wallet arrays per currency; `deepseek-official` is eligible only when DSH's active provider directory and settings descriptor identify the official adapter and its effective Messages endpoint is exactly `https://api.deepseek.com/anthropic`. A single redacted Host settings snapshot supplies both `baseURL` and `apiKeyEnv`; when `baseURL` is unset, `DEEPSEEK_BASE_URL` is read from DSH's immutable launch-environment snapshot, then the pinned public default applies. The Host resolves that exact credential reference through DSH credentials and calls only the fixed `https://api.deepseek.com/user/balance` URL with `redirect: "error"`; the official route returns `total_balance`, including unexpired grants and top-ups. Custom gateways, unreadable configuration, and unknown selections stop before credential resolution or network access. Provider presence and credential availability never select a provider. Route and settings update notifications plus a post-response snapshot reject in-flight results from a changed route. DSH owns account tokens and API-key storage; no credential reaches the browser.
6. The client-time-zone daily estimate uses DSH `sessionQuery.listSessions()` and `readSession()` on the Host for both the open Session and all sessions. Its fold is authentication-independent: it reads provider-neutral `assistant/message` usage events, so API-key (`deepseek-official`) and account-login (`deepseek-account`) sessions use the same aggregation. The client sends its current IANA time zone (UTC if unavailable) and the current `sessionId` in the Connection RPC payload; the Host reads those values from `message.payload`, validates the zone, and filters events using that calendar date, including daylight-saving transitions. The response contains the date, time-zone name, all-session totals and count, plus only the requesting Session's daily totals. The Host keeps other sessions' individual totals and raw log events private. Reads run in batches of four and are folded in deterministic session/event order. The client refreshes after the open Session's daily projection changes, local midnight, or DSH forwards `api-session/removed`, coalescing short bursts and keeping a five-minute fallback. Results are cached for one minute by date and time zone; event-triggered refreshes force a fresh scan and supersede any older in-flight result.
7. One client-side timeout scheduler serves the balance and daily refresh jobs plus the period-label clock. Balance and daily costs start immediately and use five-minute fallback intervals. Transient Session-selection, RPC initialization, and account-service errors get at most two short balance retries before returning to that interval. The period label is checked at each Beijing hour boundary and on initial render. Local midnight requests fresh daily estimates for mounted Sessions. The label classifier always reads the current `peakHours` and holiday data; the hourly schedule does not encode pricing rules. Peak/off-peak price calculation continues to use Beijing time regardless of the daily display time zone.

Balance is not written to the Session. Session logs reject unknown event types, and the projection already provides the session totals; the plugin therefore does not append custom balance events.

## Code map

- `lib/index.js`: Host plugin, configuration schema, `billingLedger` projection, session-query aggregation, Session Controller provider resolution, and balance RPC.
- `lib/client.js`: Web session cost and all-session daily total, period status, localization, Session-scoped balance polling, and the shared refresh scheduler.
- `lib/pricing.js`: Historical price periods, announcement archive, price overrides, cost calculation, and Beijing-time peak/off-peak classification.
- `lib/billing-calendar/index.js`: The single program entry point for annual statutory-holiday data and Host date queries. `2026.js` contains the complete 2026 official holiday spans.
- `docs/BILLING_CALENDAR.md`: Holiday-pricing evidence, calendar sources, missing-year fallback, and annual maintenance.
- `docs/PRICING_HISTORY.md`: Historical pricing evidence, timestamp precision, and announcement revisions.
- `docs/DEEPSEEK_NEWS_INDEX.md`: Chinese and English official news links because the official site has no single news index.
- `docs/localization-manifest.json`: Translated-document mapping, snapshot version, and release synchronization rules.
- `cordis.patch.yml`: Cordis bundle registration entry.
- `package.json`: Host runtime dependencies. A Desktop local `link:` installation requires dependencies in the linked source directory; a GitHub installation lets the Desktop profile's pnpm resolve and install them.
- `scripts/reload-plugin.mjs`: Removes and reinstalls the `file:` plugin snapshot.
- `scripts/check-deepseek-docs.mjs`: Extracts the English canonical sidebar from DeepSeek pages and compares it with the repository baseline.
- `scripts/check-language-policy.mjs`: Checks English engineering prose while respecting documented localization, source-data, and example exceptions.
- `README.md`, `README.zh.md`, `CHANGELOG.md`, and `AGENTS.md`: User instructions, the Chinese release-scoped README snapshot, release history, and repository maintenance rules.

## Contracts and key constraints

### DSH projection contract

- Internal state includes `cumulative`, `today`, `todayStamp`, and `pricingKnown`.
- The client view includes `enabled`, the non-sensitive `balanceEnabled` feature flag, `currencies`, `peakHours`, `publicHolidaySpans` with localized names, `cumulative`, `today`, and `pricingKnown`. It does not expose internal `todayStamp` or calendar-source metadata. The client still receives `today` as a change signal, but displays the open Session's client-time-zone day from authenticated RPC alongside the all-session total. `balanceEnabled` is presentation/configuration metadata; the persisted ledger state and `stateVersion: 7` do not change, so no cost refold is required.
- The DSH contract uses `wire.viewSchema` to provide projection data to the client. Without `wire`, `useProjection("billingLedger")` receives no renderable data.
- If the projection state or wire view changes, update the state schema, wire view schema, client consumer, and `stateVersion` together.
- `todayStamp` clears last-day cost before folding events from another calendar day, preventing values from different days from being mixed.

### Pricing

- Current price sources: [CNY price table](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/) and [USD price table](https://api-docs.deepseek.com/quick_start/pricing/). Historical prices should use dated pricing-page snapshots and independent news articles that state prices. The [Chinese updates](https://api-docs.deepseek.com/zh-cn/updates) and [English updates](https://api-docs.deepseek.com/updates/) are mainly for confirming model release order; do not use them as the sole price source unless they explicitly state a price.
- `PRICE_HISTORY` is the billing source of truth, with effective periods ordered oldest to newest per model. `PRICES` is the latest-price compatibility view for calls without a timestamp and for configuration merging.
- `PRICE_NOTICES` records pricing announcements and their status. `cancelled` and `effective-no-rate-change` notices do not create billing periods.
- Each pricing-related news entry has paired `zhCN` and `en` sources. The complete discovery index is `docs/DEEPSEEK_NEWS_INDEX.md`, based on the official documentation sidebar rather than guessed URLs. The index notes whether an article states prices, an effective time, or that prices remain unchanged.
- The official exact Beijing effective times are 2026-08-17 00:00 and 2026-09-10 12:00. April 2026 changes supported only by date-level evidence use `effectivePrecision: "date"` and Beijing midnight as a deterministic boundary.
- A price override applies to the specified model's entire history, suitable for private proxies or custom contracts. Other built-in models continue to use official historical periods.
- Percentages, abbreviated token counts, and amounts are truncated, never rounded.
- Beijing time uses a fixed UTC+8 offset independent of the Host time zone or daylight-saving time. Saturdays and Sundays always use off-peak pricing, including weekend makeup workdays. Statutory holidays in bundled annual calendars also use off-peak pricing all day. Unsupported years retain weekend rules and the configured weekday `peakHours` fallback.
- `cacheReadTokens` use the cache-hit price, uncached input uses the cache-miss price, and output uses the output price. Cache writes use an optional, explicit per-model `cacheWrite` price. If a message reports positive cache-write usage without an applicable price, that cost is unknown; a missing or zero cache-write count needs no cache-write price.
- A model must have complete peak/off-peak and CNY/USD cache-hit, cache-miss, and output prices for each enabled currency to be priced. `cacheWrite` is optional unless usage reports a positive cache-write count.
- Unknown models and incomplete prices return `null`; the projection sets `pricingKnown` to `false` and does not fall back to another model's price.
- Vision pricing must remain equal to Flash pricing where the official table specifies that relationship. Add a built-in model only when all required prices have evidence.

### Annual statutory-holiday calendar

- Annual dates and source metadata live only in `lib/billing-calendar/<year>.js`. Host and Web code obtain data through `lib/billing-calendar/index.js`; the Web client receives date spans and the Chinese and English names it needs to display.
- Each annual file preserves every date in the full holiday periods published by the State Council notice, including weekend dates. Weekend makeup workdays are not holiday data.
- The client labels a date in this order: statutory holiday, weekend, then weekday peak/off-peak. This label does not change the cost calculation rule.
- If the projection wire view changes, update its schema, client consumer, and `stateVersion`. If historical period classification changes, also increment the version so old totals are refolded.
- Only 2026 is currently bundled. Unsupported years do not infer future holidays and keep the existing weekday/weekend rules. Before adding a year, check the State Council General Office notice and follow `docs/BILLING_CALENDAR.md`.

### Credentials and balance

- Resolve and use the API key only on the Host through `credentials.resolve()` using the `apiKeyEnv` reference from the active official adapter's settings snapshot (default `DEEPSEEK_API_KEY`). DSH's credentials service owns storage and precedence. Balance does not fall back to a different reference or directly inspect process environment for the key.
- The API key must not enter the client bundle, projection, Session log, URL, or ordinary error output.
- The Host exposes balance through the exact `/api/stats-decimal/getBalance` route. The client sends a Session ID and `AbortSignal`, never a trusted provider. It receives the resolved provider identity, balance numbers, and safe error markers.
- The Host calls DSH `sessionController.projections({ sessionId }, signal)` to read the current `modelSelection` without resuming or activating an Agent. It applies the pinned Session Controller precedence: `next` (pending selection), otherwise `lastUsed`, otherwise `agentDefaultModel.currentSelection()` when the Session has no model history. An invalid Session/projection/default or unsupported provider fails closed.
- `deepseek-account` uses only DSH `deepseekAccount.getBalance(AccountClientMetadata)` for the selected account balance. It sums the service's `value` recharge wallets and `bonusWallets` promotional wallets by currency. DSH returns `null` when there is no usable account session; API credentials are not read.
- `deepseek-official` reads `total_balance` from `/user/balance`, which includes the unexpired granted and topped-up amounts.
- `deepseek-official` is balance-eligible only when `llm.listProviders()`, `llm.listConfigurableProviders()`, and `settings.describe({ redactSecrets: true })` verify one active official route, its known settings namespace, and an empty settings path. The settings descriptor revision, canonicalized effective endpoint, exact `apiKeyEnv` reference, and Host route/settings generations form one in-memory route identity. Endpoint precedence matches pinned DSH: configured `baseURL`, then `launchEnvironment.get("DEEPSEEK_BASE_URL")`, then `https://api.deepseek.com/anthropic`. Only the canonical Messages root is accepted; custom HTTPS proxies, HTTP, lookalike hosts, non-default ports, and other paths fail before credential lookup. The exact route reference is resolved through `credentials.resolve()` and used only at `https://api.deepseek.com/user/balance` with `redirect: "error"`. The Fetch deadline is 20 seconds. `balance.apiBase` is retained as an ignored legacy configuration field and cannot alter the request destination. A legacy `balance.provider` field is also ignored.
- The Host rechecks route identity before credential lookup, immediately before Fetch, and after the response. Adapter topology and matching settings updates advance local generations; configuration identity also includes the Settings Forms revision. Official in-flight balance calls coalesce only within the same route identity. This establishes intended route association but cannot cryptographically establish API-key ownership; credentials are supplied by the administrator and DSH's credential provider.
- DSH's account balance service has an internal default deadline of 30 seconds and a configured maximum of 120 seconds. The plugin bounds its wait at 125 seconds; the total Host operation is capped at 160 seconds. The client RPC has a 165-second deadline. These limits allow the pinned account service's maximum plus projection/serialization headroom.
- DSH Connection RPC cancellation is passed to the Host and official Fetch. The account service API has no caller `AbortSignal`; client cancellation stops waiting and discards the response, while DSH's own bounded account deadline ends the underlying call. Concurrent requests for one provider share an in-flight provider call; results are not cached across Sessions.
- Client balance state is keyed by Session and generation. A Session/provider change clears the value and cancels the prior RPC; late responses are ignored. Each refresh clears the prior value before waiting, and a successful value expires after five minutes. A timed-out RPC settles the scheduler so the next scheduled refresh can proceed.
- The Host holds a per-Session selection lease through response publication. `sessionProjections.onChanged()` advances it when `modelSelection` changes; `session/created` and `session/disposed` cover Session lifecycle. The listener disposer is attached to the plugin's owning Cordis effect. The `/api` handler performs a synchronous final selection/default/route check after the RPC await and immediately before JSON serialization. An A→B→A change advances the lease twice, so provider-string equality cannot revive the original operation. A default-only Session is re-resolved from `agentDefaultModel.currentSelection()` on every request and is invalidated by settings updates. These use the pinned [Session projection change feed](https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/1600d8a1e140dcde43a1a0941940a0480712c011/packages/session/session-projection/src/index.ts), [model-selection projection](https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/1600d8a1e140dcde43a1a0941940a0480712c011/packages/api/session-controller/src/model-selection-projection.ts), and [Session Controller projection read](https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/1600d8a1e140dcde43a1a0941940a0480712c011/packages/api/session-controller/src/index.ts).
- Official route and credential changes advance Host-local, nonsecret generations. Every delivered `credentials/reference-updated` event synchronously advances the credential and balance generations and aborts all official balance work before any optional route inspection; the Host listener itself does not resolve the event's reference or dispatch a request. This conservative invalidation can refresh unrelated official balance views, but their requests still use only the currently selected route's configured reference. The Host captures the route/credential generation before resolving the configured key, rechecks route and Session authorization after each asynchronous boundary, immediately before Fetch, after Fetch, and at response publication. The official result includes the Host balance generation; the client also clears and aborts official entries on forwarded settings, adapter, and credential notifications, on Connection reset, and on Session removal. These generation values identify observed configuration change only: they do not identify a secret, prove its owner, or derive from it. The pinned [Remote event allowlist](https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/1600d8a1e140dcde43a1a0941940a0480712c011/packages/api/remotes/src/remote-events.ts) carries the client invalidation notifications.
- The pinned credentials event fires synchronously after a provider-managed reference change commits, and listener failures are contained. It does not report ambient process-environment changes. DSH provides no credential version or transaction that atomically couples `credentials.resolve()` to outbound Fetch. If a managed mutation races after resolution and before its update event is observed, one already-resolved key can still be dispatched to the fixed official balance URL; a later event prevents its result from being published, but cannot retract bytes already sent. An unannounced ambient environment change has no immediate invalidation signal; the existing five-minute successful-value age bound is the fallback. See the pinned [credential service](https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/1600d8a1e140dcde43a1a0941940a0480712c011/packages/credentials/credentials/src/index.ts) and [credential event contract](https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/1600d8a1e140dcde43a1a0941940a0480712c011/docs/subsystems/credentials.md).
- Official balance response bodies are decoded incrementally and capped at 64 KiB of actual received bytes, regardless of `Content-Length`. Oversized, invalid UTF-8/JSON, or malformed balance payloads return sanitized unavailable results; the same 20-second Fetch deadline and abort signal remain in force.
- The daily-cost RPC remains profile-wide by design. Pinned Connection admits each shared `/api` request as the authenticated profile operator; it does not define a per-Session principal. The Host reads the profile's SessionQuery corpus and returns the requesting Session's daily slice plus all-Session totals. The client-supplied Session ID selects that slice, not an independent authorization identity. This retains DSH's existing operator/profile boundary and aggregate feature; the pinned [Connection security contract](https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/1600d8a1e140dcde43a1a0941940a0480712c011/packages/client/connection/README.md) documents that every admitted request speaks for one operator Peer.
- Active provider metadata, configurable-provider declarations, and settings namespaces are separate Host APIs; the pinned surface does not cryptographically attest they came from the same adapter instance. The plugin retains uniqueness, namespace, settings-path, endpoint, and credential-reference checks and fails closed for unknown/ambiguous declarations. This assumes the pinned stock DSH composition and trusted Host plugins. A malicious privileged Host plugin could spoof those APIs and is outside this plugin's trust boundary; no proof is manufactured from public metadata.
- `balanceEnabled` in the billing wire view prevents the client from registering the balance refresh task when disabled. Cost projection and all-session daily aggregation remain independent. Provider, credential, authentication, HTTP, deadline, and network failures return empty balances with stable sanitized error codes; they never select another provider or terminate the DSH application.

## Known limitations

- Both displayed “Today” amounts use the current Web browser or Desktop renderer IANA calendar day. The first line covers only the open Session; the second covers all sessions in the current DSH profile. They read live and persisted logs through `sessionQuery`; unreadable history or a missing query service makes the first-line daily value unavailable and the second-line total unavailable. The all-session value includes subagent sessions and excludes fork-inherited events. Both are local-log estimates rather than official account bills. Peak/off-peak pricing and the period label remain based on Beijing time.
- Costs are local estimates; the final amount is determined by DeepSeek's official bill.
- Balance follows the current Session's effective provider. The account route requires the selected account service to be authenticated and sums the recharge and promotional wallets returned by that service; the official route reports `total_balance`, including unexpired grants, and requires the active adapter's verified canonical Messages endpoint, its configured `apiKeyEnv` credential reference, and the `/user/balance` response format. If `baseURL` is unset and DSH does not expose its launch-environment snapshot, the Host fails closed rather than inspect process environment directly. A selected source failure is returned directly with no fallback. Account-service calls cannot be canceled by the client because the pinned DSH method accepts no signal, but DSH bounds them at 120 seconds maximum.
- A Desktop local-directory installation links the repository but does not install its dependencies. Before using this development path, run `npm install --omit=dev --no-package-lock --ignore-scripts` from the repository root. A Desktop GitHub installation uses the profile's pnpm to install declared dependencies and requires a Desktop restart. After installation, check that the Desktop profile's `cordis.patch.yml` enables costs and currencies; they are off by default.

## Build and validation

Before submitting, run:

~~~powershell
node --check lib/index.js
node --check lib/client.js
node --check lib/pricing.js
npm test
npm run check:language
git diff --check
~~~

For pricing changes, also verify:

- Beijing weekday peak and off-peak labels.
- Regular and makeup weekends are off-peak.
- Bundled statutory holidays take precedence in labels; unsupported years keep the weekday/weekend fallback.
- The three Flash IDs have identical built-in prices.
- `costOf()` returns `null` for unknown models.
- A complete model added with `overridePricing` is priced.
- Cache-write usage is ignored when absent or zero, priced only from an explicit applicable `cacheWrite` rate, and unknown when positive usage has no rate.
- Custom CNY/USD prices, independent balance failures, and unknown-pricing display still meet their contracts.

For an installation check, run `node scripts/reload-plugin.mjs --profile web`, start `dsh web`, and hard-refresh the page. Check native StatsPills, the two-line billing readout, cumulative and last-day cost, all-session current-day total (including a forked child without double-counting inherited usage), unavailable/unknown aggregate states, balance display, date type, pricing period, and layout.

A Desktop manual check must install through the Desktop app's Add Plugin flow into its separate `desktop` profile, enable cost and currency settings in `$DSH_HOME/profiles/desktop/cordis.patch.yml`, and restart Desktop. Check native StatsPills, the two-line billing readout, all-session current-day total, and balance display with both API-key and account-login authentication. Repeat the relevant checks in Web's separate `web` profile. Do not manage the reserved Desktop profile through the CLI or Web reload script.

## Follow-up

- Build a price-history step chart from `PRICE_HISTORY` with filters for model, currency, billing item, and peak/off-peak period.

## Release checks

1. Run `npm run check:upstream`. If the English canonical sidebar changes, open new pages and manually verify prices, effective times, and announcement status before updating the baseline.
2. Choose the release version and date:
   - Update the version in `package.json`.
   - Add the matching release section to `CHANGELOG.md`.
   - Update `README.md` only when installation, configuration, compatibility, or current usage changes.
   - Update this guide when architecture, limitations, key decisions, or maintenance steps change.
   - Update `AGENTS.md` only when repository maintenance requirements change.
3. Verify the DSH projection, slot, locale, and RPC contracts; do not broaden compatibility based on assumptions.
4. Run the existing Node test suite, syntax checks, pricing regression checks, the language-policy check, and `git diff --check`.
5. Synchronize `README.zh.md` with the canonical README for the release. Confirm its version matches `package.json` and record the synchronization in `docs/localization-manifest.json`. A release is incomplete until this check passes.
6. Reinstall into a test profile and check native StatsPills, the separate billing row, pricing-period status, unknown models, and both DSH account states with and without an API key present.
7. Check Git for credentials, local configuration, caches, and temporary artifacts before creating a tag or release.

### Upstream documentation check

~~~powershell
npm run check:upstream
node scripts/check-deepseek-docs.mjs --snapshot
~~~

The default command reads `docs/deepseek-docs-baseline.json` and reports differences. It discovers the newest News entry from the English home page, extracts the API documentation sidebar from the current English Models & Pricing page, and extracts the separate News sidebar from the newest article. It compares the union so a category page's partial sidebar is not mistaken for removal of links still used elsewhere. Chinese URLs are derived by adding `/zh-cn` to the canonical path; the script does not fetch a second navigation tree. `--snapshot` prints a structured candidate snapshot for manual review and baseline updates. The script does not fetch article bodies or update `PRICE_HISTORY` automatically.

On 2026-09-29, the upstream site separated API Guides, News, and other resources into distinct API documentation and News sidebars. The old guide, pricing, and 18 historical-news links remained accessible, and the News paths and titles were unchanged. The sidebar baseline was therefore rebuilt for the new navigation only; prices and historical announcements were not changed.

## Maintenance workflow

1. Before changing the repository, read `README.md`, this guide, `CHANGELOG.md`, and `AGENTS.md`.
2. When DSH changes, verify the corresponding source contract before changing compatibility statements or projection integration.
3. Put user-visible changes in `CHANGELOG.md`; update this guide for architecture, limitations, and key decisions.
4. Expand `README.md` only for installation, configuration, or current-use changes.
5. Put temporary review, diagnostics, download, patch, and validation scripts, sample data, logs, and other helper artifacts under `.work/`. Maintained project scripts belong in `scripts/`.

## Language policy

English is the canonical language for engineering and maintenance: identifiers, comments, developer documentation, maintenance instructions, and non-localized diagnostics. The application may retain target-language locale dictionaries and localized labels. Preserve original-language names and wording in statutory data, official documents, legal references, citations, and authentic source material where appropriate. Localized test fixtures, expected values, and multilingual examples are valid and remain testable.

Do not impose a blanket prohibition on CJK characters in source. The language check covers canonical Markdown prose, maintenance scripts, and code/config comments while excluding documented locale resources, source data, tests, examples, and the Chinese README snapshot. Detailed engineering documents do not need translated copies.

English documentation is canonical. `README.zh.md` is a release-scoped comprehension snapshot of the user-facing README, not a second continuously maintained source. The localization manifest records the mapping, snapshot version, and synchronization rules; every release must check and synchronize the snapshot.

## Repository Git identity and local work area

This repository uses the project-specific Safe Public Git identity `dsh-stats-decimal <dsh-stats-decimal@example.invalid>`. Do not change global Git identity. `.work/` is a temporary local work area; only `.work/README.md` is tracked and all other contents are ignored. `.githooks/` stores the maintained repository safety tools. Enable the identity check hook locally with:

~~~sh
git config --local core.hooksPath .githooks
~~~
