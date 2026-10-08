# Changelog

This file records user-visible changes. For development context and technical decisions, see [DEVELOPMENT.md](DEVELOPMENT.md).

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.7.0] - 2026-10-01

### Added

- The billing row shows the Beijing date type and pricing period: weekday peak/off-peak, weekend off-peak, or a named statutory holiday.
- Added English holiday names for the English interface.

### Changed

- Statutory holidays take precedence over weekend labels; a weekend makeup workday remains a weekend off-peak day.
- Bumped the billing projection state version to `6` and pass localized holiday names to the client.

## [0.6.0] - 2026-09-29

### Added

- Added China's 2026 statutory holidays to peak/off-peak pricing. Statutory holidays on weekdays use off-peak pricing all day; weekend makeup workdays remain off-peak.
- Added a centrally maintained annual billing calendar and source records. Years without a bundled calendar continue to use weekday peak-hour and weekend rules.

### Changed

- Bumped the billing projection state version to `5` so existing sessions are refolded with the new historical holiday classification and the browser receives the required holiday date spans.

### Fixed

- Resolve the balance API key through the DSH credentials service instead of reading the private credential-file format directly. Reject invalid non-numeric balance strings instead of partially parsing them.

## [0.5.4] - 2026-09-28

### Added

- When `DEEPSEEK_API_KEY` is unavailable, read the recharge balance through DSH's `deepseekAccount` Host service. The API-key route retains priority; account tokens are neither read nor forwarded.

### Changed

- Updated the target to DSH `v0.2.0-rc.1`.
- Documented how to update a Desktop GitHub plugin by submitting the same URL again in Add Plugin and restarting Desktop.
- Recorded an observed status mismatch: pnpm may report `Done` and the installed plugin version may change even when the UI says it cannot determine which package was installed from dependency changes. Check the installed version and restart to confirm the result.

## [0.5.3] - 2026-09-26

### Fixed

- Fixed the missing balance display by using Connection's shared exact-match `/api` route, which avoids Host route registration failures from `rpc.handle()` in composed DSH profiles. The initial balance request now runs after the billing row mounts.

## [0.5.2] - 2026-09-26

### Changed

- Clarified profile-specific plugin management: Web uses CMD or PowerShell; Desktop uses the Plugins page's Add Plugin flow. Restart Desktop after a GitHub installation.

### Fixed

- Added runtime dependencies required by direct Host imports and documented the Desktop dependency difference: local `link:` installation requires dependencies in the source directory; GitHub installation lets the profile's pnpm install declared dependencies.

## [0.5.1] - 2026-09-26

### Changed

- Updated the target to DSH `v0.1.7-rc.2`, recorded that the billing row had been verified in Web, and documented installation, configuration, and restart for the separate Desktop profile.

### Fixed

- Placed the billing row on a separate second line after both native statistics items and tightened row spacing without adding background decoration.

## [0.5.0] - 2026-09-12

### Added

- Added the `deepseek-flash` model for DeepSeek-V4.1-Flash with current CNY/USD peak and off-peak prices.
- Displayed the official pricing-period labels in both locales: off-peak/peak and OFF-PEAK/PEAK.
- Added links to DeepSeek's official CNY and USD price tables and pricing regression tests.
- Added structured historical prices and announcement records for the V4 series. Old sessions are priced by each message's timestamp, providing a common data source for a future price-history step chart.

### Changed

- Updated the compatibility target to DeepSeek Harness `v0.1.5-rc.1`.
- Kept the two legacy Flash model names as aliases at the current V4.1 Flash price; the V4 Pro price remains unchanged.
- Preserved DSH's expandable native `StatsPills` and registered a separate billing item instead of replacing the native `stats` item.
- Set default Beijing weekday peak hours to the official `[9,10,11,14,15,16,17]`.
- Bumped the billing projection state version to `4` so existing sessions are refolded using historical price periods instead of one current price.
- Recorded that the plan to route Pro to Flash on 2026-09-14 was withdrawn; it does not change the price of `deepseek-v4-pro`.
- Added links to DeepSeek's Chinese and English update logs for checking price effective dates and announcement revisions.
- Saved the DeepSeek website's sidebar news index and paired Chinese and English official links for pricing-related announcements.
- Added an upstream sidebar-diff script that finds new, removed, renamed, or reordered links from the English canonical pages. Chinese links are derived from the same paths; the script does not read article bodies or modify billing data.
- Standardized the README, DEVELOPMENT, and CHANGELOG structure and added document navigation, architecture status, validation entry points, and release checks.

## [0.4.0] - 2026-09-07

### Added

- Set DeepSeek Harness `v0.1.2-rc.1` as the compatibility target; older versions are not promised.
- Explicitly supported `deepseek-v4-flash-vision-exp` at the same price as `deepseek-v4-flash`.
- Made Saturday and Sunday off-peak in Beijing time.
- Allowed `overridePricing` to add a model with a complete price table.

### Changed

- Models without configured prices now show `Cost unknown` instead of using the Flash price.
- Unknown model prices no longer hide or change CNY/USD balances returned by the DeepSeek API.
- Bumped the billing projection state version to `2`.

## [0.3.2] - 2026-09-01

### Added

- Added `scripts/reload-plugin.mjs` to reinstall a local plugin snapshot on Windows.

### Fixed

- Adapted to DSH `v0.1.1-rc.2`'s `wire.viewSchema` projection contract, fixing the missing cost/balance row.

## [0.3.1] - 2026-08-22

### Fixed

- Reset “Today” cost after the Session crosses a calendar-day boundary.
- Completed defaults and toggle behavior for pricing, currencies, and balance settings.

## [0.3.0] - 2026-08-21

### Added

- Added a CNY/USD ledger for cumulative Session cost, cost for the last Session day, and recharge balance.
- Estimated cost from model, cache hits/misses, output tokens, and Beijing-time peak/off-peak periods.
- Reused `DEEPSEEK_API_KEY` from DSH credentials and queried the official balance through Host loopback RPC, keeping the key out of the browser.
- Added price overrides, currency and balance toggles, and peak-hour configuration.

## [0.2.0] - 2026-08-21

### Changed

- Truncated cache hit rates and K/M/G token values to two decimal places instead of rounding up.
- Split the runtime summary and token ledger into two lines so key numbers remain visible.
- Added the MIT License and reorganized installation instructions.

## [0.1.0] - 2026-08-21

### Added

- Established the Cordis Host plugin and Web client bundle.
- Replaced DSH's native session statistics row through a same-name `stats` slot.
- Added initial installation, configuration, and bundle patch instructions.
