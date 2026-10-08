# dsh-stats-decimal

[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-v0.2.0--rc.1-4D6BFE)](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.0-rc.1)
[![Platform](https://img.shields.io/badge/platform-Windows-0078D6)](https://www.microsoft.com/windows)
[![License](https://img.shields.io/badge/license-MIT-2EA44F)](LICENSE)

English | [中文](README.zh.md)

This Cordis plugin runs in DeepSeek Harness Web sessions and the Desktop app's embedded Web interface. It preserves DSH's expandable native session statistics and adds estimated CNY/USD costs, recharge balances, and the current pricing period. Costs are calculated on the Host from session events. Balance requests use Host-side RPC, so the API key never enters the browser or Session log.

## Features

- Keeps native `StatsPills` details for turns, speed, exact token counts, and cache hits.
- Adds a separate cost and balance ledger without replacing DSH's native `stats` item.
- Shows cumulative session cost, cost for the last calendar day in the session, and recharge balance in CNY and USD.
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

- Current target: DeepSeek Harness `v0.2.0-rc.1`. Account-login balance display was confirmed in a Desktop GitHub installation. Broader compatibility claims remain limited to verified source contracts.
- The plugin uses projection, slot, and RPC contracts; this does not imply compatibility with other DSH versions.
- Desktop uses the same Web interface but has a separate `desktop` profile. Enable cost settings in that profile after installation.
- The plugin is ESM JavaScript and depends on `@deepseek-ai/schemastery` and `zod`.

~~~text
lib/index.js             Host plugin, configuration schema, billing projection, balance RPC
lib/client.js            Web ledger and pricing status, localization, and balance polling
lib/pricing.js           Price tables, overrides, cost calculation, Beijing-time periods
cordis.patch.yml         Cordis bundle registration
scripts/reload-plugin.mjs Reinstalls the local file: plugin snapshot
~~~

## Display

The native DSH statistics remain intact. The plugin adds a separate cost row below the composer, after the native statistics pills and context meter. The row has no background decoration. Amounts are truncated to two decimal places; they are never rounded.

Example output:

~~~text
National Day · OFF-PEAK  CNY Total ¥0.67 · Today ¥0.67 · Balance ¥9.20 | USD Total $0.10 · Today $0.10 · Balance $0.00
国庆节 · 空闲时段  CNY 累计 ¥0.67 · 今日 ¥0.67 · 余额 ¥9.20 | USD 累计 $0.10 · 今日 $0.10 · 余额 $0.00
~~~

Each enabled currency appears once. Multiple currencies are separated by `|`; a single currency has no separator. Unknown pricing does not hide or change the balance.

## Installation and plugin management

Choose the management method for the target profile. Use the Desktop app's Plugins page for the Desktop profile and the command line for the Web profile. The profiles are independent.

| Environment | Management method |
| --- | --- |
| Desktop | Plugins page; use Add Plugin |
| Web | CMD or PowerShell: `dsh plugin --profile web ...` |

### Desktop

In the Desktop app, open the Plugins page, choose Add Plugin, and enter the repository URL:

~~~text
https://github.com/xingchenyang/dsh-stats-decimal
~~~

After installation, choose Enable Now and restart DSH Desktop. The Desktop profile's pnpm installs dependencies declared by the plugin. Unless a Git ref is specified, pnpm selects the latest commit on the default branch and records that commit in the profile lockfile. GitHub Releases do not select the installed commit.

To update a GitHub installation, enter the same repository URL in Add Plugin again, then restart Desktop. Uninstalling the plugin or reinstalling DSH Desktop is not required.

**Known UI warning on DSH `v0.2.0-rc.1`:** after submitting the same URL for an installed plugin, pnpm may finish successfully with `Already up to date`, `added 0`, and `Done`, while the plugin page reports that it could not determine which package was installed from the dependency changes. In the observed case, the plugin version had updated and account-login balance worked after restart. In that situation, the pnpm result and installed version were more reliable indicators than the warning. Treat a pnpm error, unchanged version after restart, or unavailable feature as an installation failure.

For a local source installation, select the repository directory in Add Plugin. This registers a `link:` package and does not install dependencies into the linked source directory. From the repository root, prepare the runtime dependencies first:

~~~powershell
npm.cmd install --omit=dev --no-package-lock --ignore-scripts
~~~

This command prepares source dependencies; it does not install the plugin into DSH. Local installation and configuration belong to the Desktop profile. Do not use Web CLI commands or the Web reload script to manage the Desktop profile.

### Web

The `dsh` command manages only the Web profile. The Desktop profile is managed by the Desktop app. The `dsh plugin` command uses pnpm, which must be on PATH. If pnpm is not installed, install it from CMD:

~~~cmd
npm install -g pnpm
~~~

Or from PowerShell:

~~~powershell
npm.cmd install -g pnpm
~~~

From the directory that contains the cloned repository, add the plugin and start Web:

~~~cmd
dsh plugin --profile web add file:./dsh-stats-decimal
dsh web
~~~

The PowerShell commands are the same. The `file:./dsh-stats-decimal` path is resolved from the current shell directory, not the profile directory. The `add` command adds the plugin to the profile and to `dsh.profile.bundles`; no manual insert is needed. The public `dsh` CLI does not manage the official Desktop profile. See the [DSH Desktop guide](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.1/apps/desktop/README.zh.md).

## Update and uninstall

After changing a source installed with the Web CLI's `file:` method, reinstall it and restart DSH so the Web profile and Host reload the plugin. Run these commands from the directory containing the clone:

~~~powershell
dsh plugin --profile web remove dsh-stats-decimal
dsh plugin --profile web add file:./dsh-stats-decimal
dsh web
~~~

The repository also includes a one-step reload script. Run it from the repository root:

~~~powershell
node scripts/reload-plugin.mjs                 # profile defaults to web
node scripts/reload-plugin.mjs --profile web   # choose web explicitly
node scripts/reload-plugin.mjs --dry-run       # print commands without changing anything
~~~

The script updates the profile dependency and `node_modules` only; it does not modify `cordis.patch.yml`. Restart `dsh web` and hard-refresh the page (Ctrl+F5) afterward. Calling the script with `node` avoids PowerShell's `.ps1` execution policy. The terminal must be able to write to `$DSH_HOME\profiles\web`.

To uninstall from the Web profile:

~~~powershell
dsh plugin --profile web remove dsh-stats-decimal
~~~

If the profile's `cordis.patch.yml` still contains a `stats-decimal` entry, remove it as well. A leftover entry does not prevent a later reinstall. Manage the Desktop plugin only through the Desktop app's Plugins page.

## Configuration

Desktop reads `$DSH_HOME\profiles\desktop\cordis.patch.yml`. Create the file if needed; its top level must be a YAML sequence. For Web CLI management, edit `$DSH_HOME\profiles\web\cordis.patch.yml`. Both profiles use the same settings:

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
      # apiBase: 'https://api.deepseek.com'
~~~

After editing the Desktop profile, restart Desktop. For Web, restart `dsh web` and hard-refresh (Ctrl+F5). Installation alone does not show the cost row because `enableCost`, `cnyEnabled`, and `usdEnabled` default to `false`. Profile settings are not shared.

| Setting | Default | Purpose |
| --- | ---: | --- |
| `enableCost` | `false` | Master switch for the cost ledger |
| `cnyEnabled` | `false` | Show the CNY segment |
| `usdEnabled` | `false` | Show the USD segment |
| `balance.enabled` | `false` | Add balance to each enabled currency segment |
| `peakHours` | `[9,10,11,14,15,16,17]` | Beijing weekday peak hours |

The cost row appears only when `enableCost=true` and at least one currency is enabled. Each currency shows its cumulative and last-session-day amounts; the balance setting adds the recharge balance.

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

The two older Flash names remain callable, but DeepSeek-V4.1-Flash serves them at the current Flash price; all three Flash IDs therefore share the same current price. Historical session events use the price effective at each message timestamp. If a model had not yet launched or the historical price record is incomplete, its cost is unknown; current prices are not applied retroactively.

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

For every enabled currency, provide `cacheHit`, `cacheMiss`, and `output` prices for both `peak` and `valley`. Otherwise the model's cost is unknown.

### Balance

- The Host resolves `DEEPSEEK_API_KEY` through the DSH credentials service, then calls the DeepSeek balance API. DSH owns the credential storage format; the plugin does not read credential files.
- When no API key is configured, the plugin can use DSH's optional `deepseekAccount` service to read the logged-in account's recharge balance. Do not configure an account token or `apiKey` in the plugin.
- The API-key route takes priority when both API key and account login are available. The account-login route reports the recharge wallet only, not the promotional wallet.
- The API key is resolved and used only on the Host; it is not sent to the browser, projection, or Session log.
- Balance is read on page load and polled every five minutes. Refresh the page to request it manually.
- If credentials are unavailable, a request fails, or a currency has no recharge balance, the display shows `Balance –`.

## Notes and license

- “Today” means the last calendar day present in the Session log. When an older Session is opened, it may not mean today's real-world date.
- Costs are estimates based on local token usage and the price table. The final amount is determined by DeepSeek's official bill.
- Balance is independent official API data. Unknown model pricing does not hide or change the balance returned by DeepSeek.
- This independent personal project is not affiliated with or endorsed by DeepSeek, DeepSeek Harness, or OpenAI. Some implementation and documentation used AI assistance. The project is distributed under the [MIT License](LICENSE).

The package version and Chinese snapshot synchronization status are recorded in the [localization manifest](docs/localization-manifest.json).
