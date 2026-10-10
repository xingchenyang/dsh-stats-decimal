# Development Guide

This guide records technical context, key decisions, and handoff information. Installation and configuration are in [README.md](README.md); user-visible release history is in [CHANGELOG.md](CHANGELOG.md); maintenance requirements are in [AGENTS.md](AGENTS.md).

## Current status

- Compatibility target: DeepSeek Harness `v0.2.0-rc.2` (official release commit `639ed01`); relevant release-tag contracts verified.
- Desktop loads the full Web application through Electron but has its own `$DSH_HOME/profiles/desktop`, plugin package-manager state, and bundled pnpm, isolated from the Web profile. `dsh.client.platform: "web"` applies to the embedded Web interface. Manage Web plugins with `dsh plugin --profile web`; manage Desktop plugins from the app's Plugins page and configure the Desktop profile separately.
- Upstream reference: [DSH v0.2.0-rc.2 release](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.0-rc.2) (commit `639ed01`).
- Stack: ESM JavaScript, Cordis Host/Web bundles, `@deepseek-ai/schemastery`, and `zod`.
- The billing projection version is `stateVersion: 7`. Version 5 added statutory-holiday date spans; version 6 added localized holiday names; version 7 changes how reported cache-write usage is priced and refolds prior sessions.
- For a GitHub installation, Desktop's profile package manager installs the dependencies declared by the plugin. Restart Desktop after installing or updating. To update an installed GitHub plugin, submit the same URL again through Add Plugin.
- A Desktop local-directory installation is recorded as `link:` and does not install dependencies into the linked directory. Install the declared runtime dependencies in the repository before using this development path. The public `dsh` CLI does not manage the Desktop profile.

## Architecture and data flow

1. The Host-side `billingLedger` folds usage events from `assistant/message`.
2. `lib/pricing.js` selects the model price effective at the event time, then calculates cost from cache buckets, output tokens, and the Beijing-time peak/off-peak period. `lib/billing-calendar/` provides the single annual statutory-holiday calendar. Weekends are checked first; statutory holidays on weekdays also use off-peak pricing.
3. The projection's `wire.viewSchema` sends cumulative and last-day cost, enabled currencies, pricing settings, and holiday spans with Chinese and English names to the Web client.
4. The Web client preserves DSH's native `StatsPills` and registers a separate billing item in `conversation.composer.dock`. `ContextMeter` is a later sibling of the dock slot. When billing is enabled, the client permits the shared footer to wrap and uses flex order to place billing below both native statistics items as a separate second row. The row gap is 4 px and the billing row has no background decoration.
5. Balance uses DSH Connection's shared exact-match `/api` route. The Host first resolves `DEEPSEEK_API_KEY` through DSH credentials and calls DeepSeek `/user/balance`. Without an API key, it can query the optional `deepseekAccount` Host service through `getBalance(AccountClientMetadata)`. DSH's provider owns account tokens and Platform request headers; credentials do not reach the browser.
6. The all-session daily estimate uses DSH `sessionQuery.listSessions()` and `readSession()` on the Host. It prices only the current Beijing date, counts each session's owned events (skipping fork-inherited prefixes), and returns only the date, totals, and count through the authenticated `/api` route. Raw session events and message content stay on the Host. Reads run in batches of four and are folded in deterministic session/event order. The client shows a loading status and refreshes after the open session's daily cost changes or DSH forwards `api-session/removed`, coalescing short bursts and keeping a five-minute fallback. Results are cached for one minute; event-triggered refreshes force a fresh scan and supersede any older in-flight result.
7. One client-side timeout scheduler serves the balance and all-session daily refresh jobs plus the period-label clock. Balance and all-session daily cost start immediately and use five-minute fallback intervals; the period label is checked at each Beijing hour boundary and on initial render. Beijing midnight also requests a fresh all-session daily estimate. The label classifier always reads the current `peakHours` and holiday data; the hourly schedule does not encode pricing rules.

Balance is not written to the Session. Session logs reject unknown event types, and the projection already provides the session totals; the plugin therefore does not append custom balance events.

## Code map

- `lib/index.js`: Host plugin, configuration schema, `billingLedger` projection, session-query aggregation, balance RPC, and DSH credentials service call.
- `lib/client.js`: Web session cost and all-session daily total, period status, localization, balance polling, and the shared refresh scheduler.
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
- The client view includes `enabled`, `currencies`, `peakHours`, `publicHolidaySpans` with localized names, `cumulative`, `today`, and `pricingKnown`. It does not expose internal `todayStamp` or calendar-source metadata. The all-session total is served separately through authenticated RPC, not added to this per-session projection.
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

- Resolve and use the API key only on the Host through `credentials.resolve("DEEPSEEK_API_KEY")`. DSH's credentials service owns storage, startup environment, and fallback precedence. The plugin does not read private credential files or inspect process environment directly for the key.
- The API key must not enter the client bundle, projection, Session log, URL, or ordinary error output.
- The Host exposes balance through the exact `/api/stats-decimal/getBalance` route. The client receives only balance numbers, availability, and safe error markers.
- When `DEEPSEEK_API_KEY` is configured, use that route. If the credentials capability is missing, resolution fails, or no key is present, query the optional `deepseekAccount` service. Both capabilities are resolved with `ctx.get()` per request and are not mandatory plugin dependencies. If neither is available, return `no-balance-credentials`.
- `deepseekAccount.getBalance()` receives only DSH client version, request language, and time-zone offset metadata. Balance mapping reads only the recharge balance and does not add the promotional wallet.
- A balance failure, missing credentials and logged-in account, or missing currency balance returns an empty value. Balance retrieval is independent of model-cost calculation.

## Known limitations

- “Today” is the total for the last calendar day in the Session log. When an older Session is opened, it may not be today's real-world date.
- The all-session daily estimate is for the current Beijing calendar day in the current DSH profile. It reads live and persisted sessions through `sessionQuery`; unreadable session history or a missing query service makes the total unavailable. It includes subagent sessions, excludes fork-inherited events, and is a local-log estimate rather than an official account bill.
- Costs are local estimates; the final amount is determined by DeepSeek's official bill.
- Balance requires either the `DEEPSEEK_API_KEY` credential and the DeepSeek `/user/balance` response format, or DSH's `deepseekAccount.getBalance()` service and its Platform wallet structure. The API-key path has priority; account login is used only when no API key is configured.
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

A Desktop manual check must install through the Desktop app's Add Plugin flow into its separate `desktop` profile, enable cost and currency settings in `$DSH_HOME/profiles/desktop/cordis.patch.yml`, and restart Desktop. Check native StatsPills, the two-line billing readout, all-session current-day total, and balance display. Do not manage the reserved Desktop profile through the CLI or Web reload script.

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
6. Reinstall into a test profile and check native StatsPills, the separate billing row, pricing-period status, unknown models, and balance fallback.
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
