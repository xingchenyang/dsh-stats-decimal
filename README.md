# dsh-stats-decimal

[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-v0.2.2--rc.1-4D6BFE)](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.1)
[![Platform](https://img.shields.io/badge/platform-Windows-0078D6)](https://www.microsoft.com/windows)
[![License](https://img.shields.io/badge/license-MIT-2EA44F)](LICENSE)

English | [中文](README.zh.md)

This Cordis plugin runs in the DeepSeek Harness Desktop app. It preserves DSH's expandable native session statistics and adds provider-billed Session and Subagent costs, balances, and the current pricing period. Costs are calculated on the Host from Session events. Balance requests use Host-side RPC, so the API key never enters the renderer or Session log.

## Features

- Keeps native `StatsPills` details for turns, speed, exact token counts, and cache hits.
- Adds a separate Usage & Billing footer without replacing DSH's native `stats` item.
- Bills the open Session from its own provider usage events, including attempt, stream, and retry replacement semantics, and excludes fork-inherited history.
- Shows descendant-only Subagents accounting from authoritative DSH subagent membership; no parent/header inference.
- Shows cumulative and current client-local-day cost, an independent Local Today profile total, and the selected provider's balance in CNY and USD.
- Replays each event using its historical model price, cache buckets, output tokens, and Beijing-time pricing period.
- Shows the current Beijing date type and pricing period: weekday peak/off-peak, weekend off-peak, or a named statutory holiday. The interface displays localized holiday names.
- Saturday, Sunday (including makeup workdays), and bundled Chinese statutory holidays always use off-peak prices. Complete custom prices can be supplied for built-in or additional models.
- Models without a complete configured price show `Cost unknown` and never fall back to another model's price.
- Cost and balance features are controlled by configuration and are disabled by default.

## Documentation

- [CHANGELOG.md](CHANGELOG.md): Release history and user-visible changes.
- [DEVELOPMENT.md](DEVELOPMENT.md): Architecture, compatibility, validation, and release workflow.
- [AGENTS.md](AGENTS.md): Repository rules for maintainers and automation.
- [docs/BILLING_CALENDAR.md](docs/BILLING_CALENDAR.md): Holiday billing rules and calendar sources.
- [docs/PRICING_HISTORY.md](docs/PRICING_HISTORY.md): Historical rates and announcement evidence.
- [docs/DEEPSEEK_NEWS_INDEX.md](docs/DEEPSEEK_NEWS_INDEX.md): Selected links from the official news sidebar.

## Compatibility and code map

- Minimum required host: DeepSeek Harness `v0.2.1-rc.1` or later (plugin `0.9.0`). The runtime actually qualified for 0.9.0 is DSH `v0.2.2-rc.1`, Host protocol 4, with Node `v24.20.0` in the qualification environment.
- Versions admitted by the minimum range may load, but later DSH versions are not automatically runtime-qualified. Historical RC.1 qualification remains limited to its original tested scope; raise the minimum only when a required Host capability or a demonstrated incompatibility warrants it.
- The plugin uses projection, slot, and RPC contracts; this does not imply compatibility with versions outside the documented qualification record.
- Desktop uses the separate `desktop` profile. Enable cost settings in that profile after installation.
- Local Today reads the active profile's Session logs through DSH SessionQuery, independent of API-key or account-login authentication. It uses the public `observeSession` read path when available and falls back to `readSession`; the Desktop renderer supplies the local IANA time zone.
- The plugin is ESM JavaScript and depends on `@deepseek-ai/schemastery` and `zod`.

~~~text
lib/index.js             Host plugin, billing projection, provider/tree aggregation, and RPC routes
lib/client.js            Responsive Usage & Billing UI, accounting detail, localization, and balance polling
lib/usage.js             Shared provider-usage fold for Session and Subagents accounting
lib/pricing.js           Price tables, overrides, cost calculation, Beijing-time periods
cordis.patch.yml         Cordis bundle registration
~~~

## Display

The native DSH statistics remain intact. The plugin adds a compact Usage & Billing footer below the composer after the native statistics pills and context meter. It has a centered pricing-period pill and four accounting scopes:

~~~text
● Weekday · OFF-PEAK

Session        ¥10.28 / ¥10.28       Subagents       ¥17.92 / ¥17.92
Local Today    ¥40.12                Balance         ¥50.17
~~~

The normal desktop layout is two columns by two rows. Genuinely narrow widths fall back to one column by four rows. The container is plugin-owned and width-driven; it does not depend on Session type.

- **Session** is the open Session's own cumulative/today cost.
- **Subagents** is descendant-only cost from authoritative DSH subagent membership (`tree.subagentsAggregate`), not a Tree total and not a subtraction.
- **Local Today** is the current client-time-zone day across the active DSH profile.
- **Balance** is the selected provider's independent balance.

The detail popup adds per-scope cache hit and sequential token rows for input, cache read, cache write, output, and reasoning. Ready scopes do not show a redundant status badge; partial, unknown, and unavailable states remain visible. When there are no Subagents, the compact scope shows `Not used` and the detail shows only a concise explanation. Multi-Agent tree total remains a lightweight explanatory line, not a primary component.

Amounts are truncated to two decimal places and are never rounded; token counts are displayed as grouped integers, not K/M/G abbreviations. Peak/off-peak pricing remains based on Beijing time. Each enabled currency appears once; unknown pricing does not hide or change the balance. The footer does not use monetary ellipsis or horizontal scrolling.

## Installation

Install the plugin through DeepSeek Harness Desktop's plugin management:

1. Open the Plugins page in DSH Desktop.
2. Choose Add Plugin.
3. Enter the repository URL:

~~~text
https://github.com/xingchenyang/dsh-stats-decimal
~~~

4. Choose Enable Now and restart DSH Desktop.

The Desktop profile's pnpm installs the dependencies declared by the plugin. Unless a Git ref is specified, pnpm selects the latest commit on the default branch and records that commit in the profile lockfile. GitHub Releases do not select the installed commit.

For a local source installation, select the repository directory in Add Plugin. This registers a `link:` package and does not install dependencies into the linked source directory. From the repository root, prepare the runtime dependencies first:

~~~powershell
npm.cmd install --omit=dev --no-package-lock --ignore-scripts
~~~

This command prepares source dependencies; it does not install the plugin into DSH. Installation and configuration belong to the Desktop profile.

**Known plugin-manager warning:** after submitting the same URL for an installed plugin, pnpm may finish successfully with `Already up to date`, `added 0`, and `Done`, while the plugin page reports that it could not determine which package was installed from the dependency changes. In the observed case, the plugin version had updated and account-login balance worked after restart. Treat a pnpm error, unchanged version after restart, or unavailable feature as an installation failure.

## Update and uninstall

To update a GitHub installation, open the Plugins page, enter the same repository URL in Add Plugin again, then restart Desktop. Uninstalling the plugin or reinstalling DSH Desktop is not required.

For a local source installation, update the linked source and re-submit the local directory if the Desktop plugin manager requires a refresh. Restart Desktop after the update.

To uninstall, remove the plugin through DSH Desktop's plugin management, then restart Desktop if prompted. The Desktop app is the supported installation and management surface for the current release.

## Configuration

Desktop reads `$DSH_HOME\profiles\desktop\cordis.patch.yml`. Create the file if it does not exist; its top level must be a YAML sequence:

~~~yaml
- id: stats-decimal
  name: 'dsh-stats-decimal'
  config:
    enableCost: true
    cnyEnabled: true
    usdEnabled: true
    peakHours: [9, 10, 11, 14, 15, 16, 17]
    balance:
      enabled: true
~~~

After editing the Desktop profile, restart Desktop. Installation alone does not show the footer because `enableCost`, `cnyEnabled`, and `usdEnabled` default to `false`.

| Setting | Default | Purpose |
| --- | ---: | --- |
| `enableCost` | `false` | Master switch for the cost ledger |
| `cnyEnabled` | `false` | Show the CNY segment |
| `usdEnabled` | `false` | Show the USD segment |
| `balance.enabled` | `false` | Add balance to each enabled currency segment |
| `peakHours` | `[9,10,11,14,15,16,17]` | Beijing weekday peak hours |

The footer appears only when `enableCost=true` and at least one currency is enabled. The compact footer shows the first configured CNY/USD currency; the detail popup shows all enabled currencies. Balance remains a separate compact scope and does not inherit cumulative/today semantics.

Local Today reads live and persisted Session logs through DSH's `sessionQuery` service. The Desktop renderer supplies its IANA time zone, so the day boundary follows the device zone, including daylight-saving changes; UTC is used if the renderer cannot provide a zone. The estimate is independent of whether Sessions used DeepSeek API-key or account-login authentication. The Host prefers DSH's public `observeSession` read path, which avoids the v0.2.2 per-session persistence-listing preflight, and falls back to `readSession` when `observeSession` is unavailable. Short bursts of usage and Session events are coalesced. Local Today includes owned events from every Session in the profile, including subagents, and excludes fork-inherited events so they are not counted twice. Session and Subagents scopes load independently of Local Today. If the service is unavailable or any log cannot be read, Local Today reports unavailable rather than a fabricated zero. If a current-day event has unknown pricing, its daily amount reports `Cost unknown`. The value covers logs in the current DSH Desktop profile and is not an official account bill. Peak/off-peak pricing and its status label continue to use Beijing time.

### `peakHours`

List the Beijing weekday peak hours as integers from 0 to 23. For example, use `[9,10,11,14,15,16,17]` for 09:00–12:00 and 14:00–18:00 Beijing time. Calculation uses a fixed UTC+8 offset, independent of the Host time zone and daylight-saving time. Saturdays, Sundays (including makeup workdays), and bundled Chinese statutory holidays use off-peak prices all day. The calendar currently includes 2026 holidays. Unsupported years use weekend rules and `peakHours` for weekdays; holidays are not inferred. An empty list means off-peak all day.

### Prices and models

Official price and history references:

- [CNY price table](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)
- [USD price table](https://api-docs.deepseek.com/quick_start/pricing/)
- [DeepSeek news index](docs/DEEPSEEK_NEWS_INDEX.md): selected articles contain prices, promotion end dates, or effective times.
- [Chinese updates](https://api-docs.deepseek.com/zh-cn/updates) and [English updates](https://api-docs.deepseek.com/updates/): mainly useful for checking model release order; use them as price evidence only when they state pricing information.

The built-in price table covers:

- `deepseek-flash`
- `deepseek-v4-flash`
- `deepseek-v4-pro`
- `deepseek-v4-flash-vision-exp` (same price as Flash)

The two older Flash names remain callable, but DeepSeek-V4.1-Flash-1017 serves them at the current Flash price; all three Flash IDs therefore share the same current price. Historical session events use the price effective at each message timestamp. If a model had not yet launched or the historical price record is incomplete, its cost is unknown; current prices are not applied retroactively.

See the [price history](docs/PRICING_HISTORY.md) for historical rates and announcement evidence. The plan to route Pro to Flash on 2026-09-14 was withdrawn and did not create a billing boundary; `deepseek-v4-pro` continues to use the Pro price.

Place `overridePricing` under the earlier `config` key to override a built-in model or add another model:

~~~yaml
overridePricing:
  my-model:
    cny:
      peak: { cacheHit: 0.04, cacheMiss: 2.0, output: 8.0 }
      valley: { cacheHit: 0.02, cacheMiss: 1.0, output: 4.0 }
    usd:
      peak: { cacheHit: 0.006, cacheMiss: 0.3, output: 1.2 }
      valley: { cacheHit: 0.003, cacheMiss: 0.15, output: 0.6 }
~~~

For every enabled currency, provide `cacheHit`, `cacheMiss`, and `output` prices for both `peak` and `valley`. Otherwise the model's cost is unknown. `cacheWrite` is an optional per-1M-token price for models that report cache-write usage. Add it only when the model's billing terms define that price; if a message reports cache writes and the applicable price is missing, its cost is unknown. Models that do not report cache writes need no `cacheWrite` setting.

### Balance

- When `balance.enabled=true`, the balance follows the effective model provider selected in the current DSH Session. A pending model selection wins; otherwise the last model used in that Session applies, and a new Session follows DSH's current default. No provider setting is needed.
- `deepseek-official` balance is available only when the Host verifies that the active DSH route uses the canonical `https://api.deepseek.com/anthropic` Messages endpoint. It resolves that route's configured `apiKeyEnv` reference through DSH credentials (default `DEEPSEEK_API_KEY`) and calls only `https://api.deepseek.com/user/balance` with redirects rejected. Custom gateways or missing effective route configuration show `Balance –` without resolving a key.
- The official API route displays `total_balance`, which includes unexpired granted balance and topped-up balance.
- `deepseek-account` calls only DSH's `deepseekAccount.getBalance()` service and adds its recharge and promotional wallets by currency. Do not configure an account token or API key in the plugin.
- The selected provider is never inferred from credentials or sign-in state. If its service or credentials are unavailable, the balance shows `Balance –`; the plugin never tries the other provider. Unsupported or unresolved model providers also show `Balance –`.
- Legacy `balance.provider` and `balance.apiBase` fields are accepted for older profile YAML but ignored. Remove them when convenient; `apiBase` cannot change the fixed HTTPS destination.
- These balance routes are available in DSH Desktop. A third-party model provider's invoice or usage endpoint is not queried; the daily estimate remains a local token-usage estimate using configured model prices.
- The API key is resolved and used only on the Host; it is sent only to the fixed official endpoint and never to the Desktop renderer, projection, or Session log. The Host reads the endpoint and credential reference from one DSH settings snapshot and rejects a balance result if the provider route or settings generation changes while it is in flight. This binds the request to the configured route; it does not cryptographically prove API-key ownership.
- Balance is read on page load and polled every five minutes while enabled. Switching Sessions or providers clears the previous balance immediately. Refresh the page to request it manually.
- When balance is disabled, the Desktop renderer does not poll the balance RPC. A completed request with no usable CNY/USD amount is shown as unavailable, not as zero; the detail badge cannot say Normal while all amounts are `—`. The provider source may remain visible.

## Notes and license

- “Today” amounts use the Desktop renderer's current IANA calendar date. Session covers only the open Session; Local Today covers all Sessions available through the current DSH Desktop profile's `sessionQuery` service.
- Costs are estimates based on model token usage and the price table. They do not include Search or Fetch request fees. Direct Search and Fetch API requests are each priced at ¥5 / $0.75 per 1,000 successful requests; DeepSeek's server-side Search/Fetch calls through DSH, Claude Code, and Codex are announced to become billable at 2026-11-01 00:00 Beijing time (UTC+8). This plugin cannot count billable Search/Fetch requests from Session logs. See [price history](docs/PRICING_HISTORY.md). The final amount is determined by DeepSeek's official bill.
- Balance is independent official API data. Unknown model pricing does not hide or change the balance returned by DeepSeek.
- This independent personal project is not affiliated with or endorsed by DeepSeek, DeepSeek Harness, or OpenAI. Some implementation and documentation used AI assistance. The project is distributed under the [MIT License](LICENSE).

The package version and Chinese snapshot synchronization status are recorded in the [localization manifest](docs/localization-manifest.json).
