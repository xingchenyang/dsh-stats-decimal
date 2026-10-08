/**
 * dsh-stats-decimal — browser half.
 *
 * DSH 0.1.5 owns the native `stats` cell and renders its expandable StatsPills.
 * This bundle contributes a separate `billing` cell containing the estimated
 * CNY/USD ledger, recharge balance, and the current official pricing period.
 * It never shadows or reimplements the native token and timing UI.
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
				if (balanceListeners.size === 0 && balanceInterval !== null) {
					clearInterval(balanceInterval);
					balanceInterval = null;
				}
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
		/** Same fixed-UTC+8 weekday/hour rule as `pricing.js#bandForTime`. */
		function currentBand(timeEpochMs, peakHours) {
			if (!Array.isArray(peakHours) || peakHours.length === 0) return "valley";
			const beijingTime = new Date(timeEpochMs + 8 * 60 * 60 * 1000);
			const beijingDay = beijingTime.getUTCDay();
			if (beijingDay === 0 || beijingDay === 6) return "valley";
			return peakHours.includes(beijingTime.getUTCHours()) ? "peak" : "valley";
		}

		// ---- plugin-owned locale templates ----
		const zh = {
			"statsDecimal.currency": "{currency} 累计 {cumulative} · 今日 {today}",
			"statsDecimal.balanceSuffix": "余额 {amount}",
			"statsDecimal.balanceUnavailableSuffix": "余额 –",
			"statsDecimal.costUnknown": "费用未知",
			"statsDecimal.currencyCostUnknown": "{currency} 费用未知",
			"statsDecimal.periodPeak": "高峰时段",
			"statsDecimal.periodOffPeak": "空闲时段"
		};
		const en = {
			"statsDecimal.currency": "{currency} Total {cumulative} · Today {today}",
			"statsDecimal.balanceSuffix": "Balance {amount}",
			"statsDecimal.balanceUnavailableSuffix": "Balance –",
			"statsDecimal.costUnknown": "Cost unknown",
			"statsDecimal.currencyCostUnknown": "{currency} Cost unknown",
			"statsDecimal.periodPeak": "PEAK",
			"statsDecimal.periodOffPeak": "OFF-PEAK"
		};

		// Separate composer-dock contribution placed after DSH's native StatsPills.
		const rootStyle = {
			textAlign: "center",
			boxSizing: "border-box",
			width: "100%",
			padding: "2px calc(var(--dsh-composer-side-clearance) + 16px) 0px",
			color: "var(--dsw-alias-label-tertiary)",
			fontSize: "12px",
			lineHeight: "20px",
			display: "block"
		};
		const lineStyle = {
			whiteSpace: "nowrap",
			overflow: "hidden",
			textOverflow: "ellipsis"
		};
		const periodStyle = {
			display: "inline-block",
			padding: "0 7px",
			marginRight: "8px",
			border: "1px solid var(--dsw-alias-separator-primary)",
			borderRadius: "999px",
			fontWeight: 600,
			lineHeight: "18px"
		};
		const sepStyle = {
			color: "var(--dsw-alias-separator-primary)",
			margin: "0 10px"
		};
		function BillingStatus({ useProjection, t }) {
			const ledgerVal = useProjection("billingLedger");
			const [balanceVal, setBalanceVal] = react.useState(null);
			react.useEffect(() => subscribeBalance(() => setBalanceVal(pageBalance)), []);
			const [now, setNow] = react.useState(() => Date.now());
			react.useEffect(() => {
				let interval = null;
				const delay = 60_000 - Date.now() % 60_000;
				const timeout = setTimeout(() => {
					setNow(Date.now());
					interval = setInterval(() => setNow(Date.now()), 60_000);
				}, delay);
				return () => {
					clearTimeout(timeout);
					if (interval !== null) clearInterval(interval);
				};
			}, []);
			if (ledgerVal === void 0 || !ledgerVal.enabled) return null;

			const billing = [];
			// One segment per enabled currency (cnyEnabled/usdEnabled),
			// "累计 · 今日" plus " · 余额" when balance is enabled. Each currency
			// appears exactly once; balance is attached to the cost row.
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
			const band = currentBand(now, ledgerVal.peakHours);
			const period = t(band === "peak" ? "statsDecimal.periodPeak" : "statsDecimal.periodOffPeak");
			const children = [react.createElement("span", { key: "period", style: periodStyle }, period)];
			billing.forEach((group, index) => {
				if (index > 0) children.push(react.createElement("span", { key: `sep-${index}`, style: sepStyle, "aria-hidden": true }, "|"));
				children.push(react.createElement("span", { key: `billing-${index}` }, group));
			});
			return react.createElement("div", { "data-stats-decimal": "", "data-composer-stats": "", style: rootStyle },
				react.createElement("div", { style: lineStyle }, children));
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
			// Keep DSH's native `stats` cell and append one independent billing row.
			ctx.slots.inject("conversation.composer.dock", () => ctx.slots.register({
				name: "conversation.composer.dock",
				id: "stats-decimal-billing",
				order: 1,
				locale: NS
			}, BillingStatus));
		}

		exports.apply = apply;
		exports.inject = ["slots", "locale", "connection"];
		return module.exports;
	}
});
