# Agent Instructions

Read `README.md`, `DEVELOPMENT.md`, and `CHANGELOG.md` in full before modifying this repository.

## Scope

- The `version` in `package.json` is the sole source of truth for the plugin version; do not duplicate the current version in this file.
- The current DeepSeek Harness target is documented in `README.md` and `DEVELOPMENT.md`.
- Do not claim compatibility with other DSH versions without first verifying their source contracts.
- Keep the README user-focused and concise. Put release history in `CHANGELOG.md` and technical context and handoff status in `DEVELOPMENT.md`.

## Repository Git identity and local work area

- Use this repository's project-specific Safe Public Git identity: `dsh-stats-decimal <dsh-stats-decimal@example.invalid>`. Do not change global Git identity.
- `.work/` is a temporary local work area. Only `.work/README.md` is tracked; keep its other contents ignored.
- `.githooks/` contains maintained and tracked repository safety tools. Enable the identity-check hook locally with `git config --local core.hooksPath .githooks`.

## Invariants

- Truncate percentages, abbreviated token counts, and amounts; never round them.
- Use fixed UTC+8 Beijing time. Saturday, Sunday, and statutory holidays in bundled calendars always use off-peak pricing. Weekend makeup workdays remain off-peak.
- A model without configured prices must show “Cost unknown” and must not use another model's price.
- Unknown model pricing must not hide or change balances returned by the DeepSeek API.
- Resolve and use API keys only on the Host through DSH's credentials service, using the credential reference verified from the active official provider route. Never read or parse DSH's private credential storage directly, or expose secrets to the browser, projections, logs, or Session events.
- Determine the balance provider from Host-authoritative effective model selection for the requested DSH Session, and verify the official route before resolving its credential. Never accept browser-supplied provider, endpoint, or credential choices, or infer a provider from available credentials or sign-in state. If the selected route or credential is unavailable or invalid, fail closed instead of trying another provider, credential reference, or endpoint.
- Do not append plugin-specific balance events to a Session.
- When changing the projection state shape, update the state schema, wire view schema, client consumer, and `stateVersion` together.
- Add a built-in model only with evidence for complete peak/off-peak CNY/USD cache-hit, cache-miss, and output prices.

## Validation

Temporary scripts, examples, logs, and other helper files created for review, diagnosis, downloads, patches, or validation must go under `.work/`, not in source directories. Maintained project scripts belong in `scripts/`. Formal test files are exempt from this helper-file rule.

Before a commit, run:

~~~powershell
node --check lib/index.js
node --check lib/client.js
node --check lib/pricing.js
npm test
npm run check:language
git diff --check
~~~

For pricing changes, also verify weekday peak/off-peak behavior, Beijing-time weekends, unknown models, custom-price models, and the Vision/Flash equal-price constraint.

## Documentation

- Check the version and date before committing. The package version remains the source of truth.
- Put user-visible release changes in the corresponding `CHANGELOG.md` version section.
- Update `DEVELOPMENT.md` when architecture, limitations, or key decisions change.
- Update `README.md` only when installation, configuration, or current use changes.
- Keep repository documentation and maintenance prose in English.
- Keep Chinese UI translations, statutory holiday names, authentic source material, and localized test examples as data; do not remove or rewrite them as part of an engineering-language cleanup.
- Keep `README.zh.md` as a faithful Chinese snapshot of the canonical `README.md`. Update and check it for every release using `docs/localization-manifest.json` and `npm run check:language`. A release is not complete until snapshot synchronization is confirmed.
