/**
 * dsh-stats-decimal — browser half.
 *
 * Fixes the cache-hit display bug in @deepseek-ai/dsh-client-ui-conversation:
 * the shipped StatsLine renders `Math.round(cacheRead / billed * 100)` — an
 * integer, so 99.7% shows as 100% and 99.4% as 99%. This bundle shadows the
 * shipped entry of the `conversation.composer.dock` list slot (same cell id
 * "stats" at a lower priority; the slot registry's per-id shadowing means only
 * the lowest-priority entry of a cell renders) and draws the line itself with
 * two decimals truncated down (e.g. 99.20%) — never rounded up, so 99.9999%
 * shows 99.99% instead of a misleading 100%. Layout: one row for the run
 * summary (turns/steps, durations, speeds) and a second row for the token
 * ledger (cache-hit share + billed input/output), each kept on a single line.
 *
 * Format mirrors the shipped bundle: window.__ModuleLoader__.load({ id, factory }),
 * no build step required.
 */
window.__ModuleLoader__.load({
	id: "dsh-stats-decimal",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");

		const NS = "stats-decimal";
		/** How many decimals to show for currency amounts (truncated, never rounded). */
		const AMOUNT_DECIMALS = 2;

		// ---- account-balance readout (via host RPC, no session-log events) ----
		// The account balance is fetched by the HOST half (`lib/index.js`) over a
		// loopback-only RPC channel `/stats-decimal`; the browser asks and the host
		// answers using ITS OWN api key (auto-reused from DSH's DEEPSEEK_API_KEY
		// credential) — so the key never appears in the browser bundle. This ALSO
		// keeps the durable agent log free of plugin-specific event types. The host
		// `getBalance` returns `{ enabled, balances, error }`, so the SINGLE
		// `balance.enabled` switch (host config) controls whether the balance row
		// renders at all.
		const BALANCE_REFRESH_MS = 5 * 60 * 1000; // 5 分钟轮询；页面刷新(加载)也会拉一次
		/** `callGetBalance` is bound in `apply(ctx)` when `connection` is injected. */
		let callGetBalance = null;

		/**
		 * Ask the host for the recharge (topped-up) balance. Never throws: on
		 * any failure resolves `{ enabled:false, balances:{CNY:null,USD:null}, error }`.
		 */
		async function rpcFetchBalance() {
			const empty = { enabled: false, balances: { CNY: null, USD: null }, error: null };
			if (typeof callGetBalance !== "function") return { ...empty, error: "no-channel" };
			try {
				const result = await callGetBalance("/stats-decimal", "getBalance", {});
				if (result.ok !== true) return { ...empty, error: result.error?.message ?? "rpc-error" };
				const value = result.value ?? empty;
				return {
					enabled: Boolean(value?.enabled),
					balances: {
						CNY: safeBalance(value?.balances?.CNY),
						USD: safeBalance(value?.balances?.USD)
					},
					error: value?.error ?? null
				};
			} catch (err) {
				return { ...empty, error: String(err?.name ?? "rpc-failed") };
			}
		}
		function safeBalance(v) {
			return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
		}
		/** The latest balance snapshot on the page: { fetchedAt, enabled, balances, error } or null while unknown. */
		let pageBalance = null;
		/** Tiny observable so every mounted stats row shares one ongoing fetch/refresh. */
		const balanceListeners = new Set();
		let balanceInterval = null;
		function subscribeBalance(listener) {
			balanceListeners.add(listener);
			listener();
			if (balanceInterval === null) {
				balanceInterval = setInterval(refreshBalance, BALANCE_REFRESH_MS);
			}
			return () => {
				balanceListeners.delete(listener);
			};
		}
		function emitBalance() {
			for (const l of balanceListeners) l();
		}
		async function refreshBalance() {
			pageBalance = { fetchedAt: Date.now(), ...(await rpcFetchBalance()) };
			emitBalance();
		}
		// First fetch once the channel is known (best-effort; the row is gated on
		// `enabled` from the host response, so nothing renders until the host says so).
		setTimeout(() => {
			if (typeof callGetBalance === "function") void refreshBalance();
		}, 0);

		// ---- display helpers ----
		// Token figures: raw counts below 1000 have no K/M unit and stay
		// integers (e.g. 131 tok); K/M scales always carry two decimals,
		// truncated down — never rounded up (0.01 at a large base is still a
		// large quantity, and rounding would overstate it). All truncation is
		// done in integer math on the raw token count, so no float drift.
		function formatTokens(n) {
			if (n < 1e3) return String(n);
			let unit, div100;
			if (n < 1e6) {
				unit = "K";
				div100 = 10;
			} else if (n < 1e9) {
				unit = "M";
				div100 = 10000;
			} else {
				unit = "G";
				div100 = 10000000;
			}
			const hundredths = Math.floor(n / div100);
			return `${(hundredths / 100).toFixed(2)}${unit}`;
		}
		function formatDuration(ms) {
			const s = ms / 1e3;
			if (s < 60) return `${Math.round(s * 10) / 10}s`;
			const whole = Math.round(s);
			return `${Math.floor(whole / 60)}m${whole % 60}s`;
		}
		function formatTokensPerSecond(tps) {
			const clamped = Math.max(0, tps);
			return clamped >= 10 ? String(Math.round(clamped)) : String(Math.round(clamped * 10) / 10);
		}
		/** Currency symbol by iso code. */
		function currencySymbol(iso) {
			return iso === "CNY" ? "¥" : iso === "USD" ? "$" : `${iso} `;
		}
		/** Format a non-negative amount with a fixed number of decimals, sign
		 *  always shown, truncated down (never rounded up): integer math on the
		 *  scaled value so float representation cannot round 2.999… up into a
		 *  higher cent. */
		function formatAmount(value, iso, decimals) {
			const v = Number.isFinite(value) && value >= 0 ? value : 0;
			const scale = Math.pow(10, decimals);
			const truncated = Math.floor(v * scale) / scale;
			return `${currencySymbol(iso)}${truncated.toFixed(decimals)}`;
		}
		/** One per-currency third-row segment: "累计 x · 今日 y" plus, when the
		 *  balance is enabled, " · 余额 z" (value, or "–" when degraded/no key).
		 *  The host decides which currencies are active (`ledgerVal.currencies`,
		 *  from cnyEnabled/usdEnabled), so each currency appears exactly once. */
		function currencyLedgerSegment(cumulative, today, iso, decimals, t, balanceRow) {
			let text = t("statsDecimal.currency", {
				currency: iso,
				cumulative: formatAmount(cumulative[iso], iso, decimals),
				today: formatAmount(today[iso], iso, decimals)
			});
			if (balanceRow !== null) {
				text += " · " + balanceRow;
			}
			return text;
		}
		/** The fix: two decimals, truncated down (never rounded up to 100%). */
		function cacheHitPercent(usage) {
			const denominator = billedInputTokens(usage);
			if (denominator === 0) return null;
			// Integer math: exact truncation to the hundredth of a percent.
			return Math.floor(usage.cacheReadTokens * 10000 / denominator) / 100;
		}
		function billedInputTokens(usage) {
			return usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
		}

		// ---- locale templates copied verbatim from the conversation bundle ----
		const zh = {
			"stats.counts": "{turns} 轮 · {steps} 步",
			"stats.llm": "LLM {duration}",
			"stats.toolCall": "工具调用 {duration}",
			"stats.ttftAverage": "首 token 平均 {duration}",
			"stats.tokensPerSecond": "{throughput} tok/s",
			"stats.cacheHit": "缓存命中 {percent}%",
			"stats.tokens": "输入 {input} tok · 输出 {output} tok",
			"statsDecimal.currency": "{currency} 累计 {cumulative} · 今日 {today}",
			"statsDecimal.balanceSuffix": "余额 {amount}",
			"statsDecimal.balanceUnavailableSuffix": "余额 –",
			"statsDecimal.costUnknown": "费用未知",
			"statsDecimal.currencyCostUnknown": "{currency} 费用未知"
		};
		const en = {
			"stats.counts": "{turns} turns · {steps} steps",
			"stats.llm": "LLM {duration}",
			"stats.toolCall": "Tool call {duration}",
			"stats.ttftAverage": "TTFT avg {duration}",
			"stats.tokensPerSecond": "{throughput} tok/s",
			"stats.cacheHit": "Cache hit {percent}%",
			"stats.tokens": "Input {input} tok · Output {output} tok",
			"statsDecimal.currency": "{currency} Total {cumulative} · Today {today}",
			"statsDecimal.balanceSuffix": "Balance {amount}",
			"statsDecimal.balanceUnavailableSuffix": "Balance –",
			"statsDecimal.costUnknown": "Cost unknown",
			"statsDecimal.currencyCostUnknown": "{currency} Cost unknown"
		};

		// Same props shape the shipped StatsLine receives in this slot:
		// { useSession, useProjection, t } — we only need the last two.
		// Typography mirrors the shipped StatsLine.module.css (12px, tertiary
		// label, centered, spaced separators); truncation + tooltip is dropped
		// in favor of full output. Rows never wrap (each fits the composer
		// column); the ledger gets its own row so the cache-hit and token
		// figures stay readable next to the two-decimal precision.
		const rootStyle = {
			textAlign: "center",
			boxSizing: "border-box",
			width: "100%",
			padding: "4px calc(var(--dsh-composer-side-clearance) + 16px) 0px",
			color: "var(--dsw-alias-label-tertiary)",
			fontSize: "12px",
			lineHeight: "20px",
			display: "block"
		};
		const lineStyle = {
			whiteSpace: "nowrap"
		};
		const sepStyle = {
			color: "var(--dsw-alias-separator-primary)",
			margin: "0 10px"
		};
		function StatsLineDecimal({ useProjection, t }) {
			const usage = useProjection("tokenUsage");
			const projected = useProjection("sessionStats");
			const ledgerVal = useProjection("billingLedger");
			// Account balance is fetched in the browser (see the balance config
			// above) and shared through a small page-level observable, so every
			// mounted stats row shows the same snapshot without re-fetching.
			const [balanceVal, setBalanceVal] = react.useState(null);
			react.useEffect(() => subscribeBalance(() => setBalanceVal(pageBalance)), []);
			const stats = projected ?? null;
			const summary = [];
			const ledger = [];
			const billing = [];
			if (stats !== null && stats.steps > 0) {
				summary.push(t("stats.counts", {
					turns: stats.turns,
					steps: stats.steps
				}));
				const durations = [];
				if (stats.llmMs > 0) durations.push(t("stats.llm", { duration: formatDuration(stats.llmMs) }));
				if (stats.toolMs > 0) durations.push(t("stats.toolCall", { duration: formatDuration(stats.toolMs) }));
				if (durations.length > 0) summary.push(durations.join(" · "));
				const speeds = [];
				if (stats.ttftSteps > 0) speeds.push(t("stats.ttftAverage", { duration: formatDuration(stats.ttftMs / stats.ttftSteps) }));
				if (stats.decodeMs > 0) speeds.push(t("stats.tokensPerSecond", { throughput: formatTokensPerSecond(stats.decodeTokens / (stats.decodeMs / 1e3)) }));
				if (speeds.length > 0) summary.push(speeds.join(" · "));
			}
			if (usage !== void 0 && (billedInputTokens(usage) > 0 || usage.outputTokens > 0)) {
				const cacheHit = cacheHitPercent(usage);
				if (cacheHit !== null) ledger.push(t("stats.cacheHit", { percent: cacheHit.toFixed(2) }));
				ledger.push(t("stats.tokens", {
					input: formatTokens(billedInputTokens(usage)),
					output: formatTokens(usage.outputTokens)
				}));
			}
			// Third row: one segment per enabled currency (cnyEnabled/usdEnabled),
			// "累计 · 今日" plus " · 余额" when balance is enabled. Each currency
			// appears exactly once; the row renders when the cost ledger is enabled
			// for at least one currency (balance is attached to the cost row).
			if (ledgerVal !== void 0 && ledgerVal.enabled) {
				const currencies = Array.isArray(ledgerVal.currencies) ? ledgerVal.currencies : [];
				const balanceOn = balanceVal !== null && balanceVal.enabled;
				if (ledgerVal.pricingKnown === false && !balanceOn) {
					billing.push(t("statsDecimal.costUnknown"));
				}
				for (const iso of currencies) {
					if (iso !== "CNY" && iso !== "USD") continue;
					const balanceRow = balanceOn ? balanceSuffix(balanceVal, iso, t) : null;
					if (ledgerVal.pricingKnown === false) {
						if (balanceRow !== null) billing.push(`${t("statsDecimal.currencyCostUnknown", { currency: iso })} · ${balanceRow}`);
						continue;
					}
					billing.push(currencyLedgerSegment(ledgerVal.cumulative, ledgerVal.today, iso, AMOUNT_DECIMALS, t, balanceRow));
				}
			}
			const renderRow = (groups) => {
				if (groups.length === 0) return null;
				const children = [];
				groups.forEach((group, i) => {
					if (i > 0) {
						children.push(react.createElement("span", { style: sepStyle, "aria-hidden": true }, "|"), " ");
					}
					children.push(react.createElement("span", null, group));
				});
				return react.createElement("div", { style: lineStyle }, children);
			};
			const rows = [renderRow(summary), renderRow(ledger), renderRow(billing)].filter(Boolean);
			return react.createElement("div", { "data-stats-decimal": "", style: rootStyle }, rows);
		}
		/** "余额 x" suffix appended to a currency segment (no currency prefix —
		 *  it is already the segment's leading currency). Degrades to "余额 –"
		 *  when the value is null (no key / degraded / that currency has none). */
		function balanceSuffix(balanceVal, iso, t) {
			const balances = balanceVal?.balances ?? {};
			const value = balances[iso];
			if (typeof value === "number" && value !== null) {
				return t("statsDecimal.balanceSuffix", { amount: formatAmount(value, iso, AMOUNT_DECIMALS) });
			}
			return t("statsDecimal.balanceUnavailableSuffix");
		}

		function apply(ctx) {
			// Bind the balance RPC client from the injected connection service.
			const rpc = ctx.connection?.rpc;
			if (rpc && typeof rpc.call === "function") {
				callGetBalance = rpc.call.bind(rpc);
			}
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "stats-decimal: dictionaries");
			// Wait for the shipped slot declaration, then shadow cell "stats"
			// at priority -1 (shipped entry sits at priority 0).
			ctx.slots.inject("conversation.composer.dock", () => ctx.slots.register({
				name: "conversation.composer.dock",
				id: "stats",
				priority: -1,
				order: 0,
				locale: NS
			}, StatsLineDecimal));
		}

		exports.apply = apply;
		exports.inject = ["slots", "locale", "connection"];
		return module.exports;
	}
});
