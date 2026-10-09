/**
 * dsh-stats-decimal — browser half.
 *
 * DSH v0.2.0-rc.1 owns the native `stats` cell and renders its expandable StatsPills.
 * This bundle contributes a separate `billing` cell containing the estimated
 * CNY/USD ledger, current-profile daily total, recharge balance, and the
 * current official pricing period.
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
		// authenticated shared `/api` endpoint; the host reuses its DSH API key or
		// delegates to DSH's account provider when no key is configured. Neither
		// key nor account grant appears in the browser bundle. This ALSO keeps the
		// durable agent log free of plugin-specific event types. The host
		// `getBalance` returns `{ enabled, balances, error }`, so the SINGLE
		// `balance.enabled` switch (host config) controls whether the balance row
		// renders at all.
		const BALANCE_REFRESH_MS = 5 * 60 * 1000; // Poll every five minutes; page load also starts a balance read.
		/** `callGetBalance` is bound in `apply(ctx)` when `connection` is injected. */
		let callGetBalance = null;
		let callGetSessionDailyCost = null;

		/**
		 * Ask the host for the recharge (topped-up) balance. Never throws: on
		 * any failure resolves `{ enabled:false, balances:{CNY:null,USD:null}, error }`.
		 */
		async function rpcFetchBalance() {
			const empty = { enabled: false, balances: { CNY: null, USD: null }, error: null };
			if (typeof callGetBalance !== "function") return { ...empty, error: "no-channel" };
			try {
				const result = await callGetBalance("/api", "stats-decimal/getBalance", {});
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
				// Start the first request from the mounted billing row, after the
				// plugin's `apply(ctx)` has received and bound the Connection RPC.
				// A module-level zero-delay timer can run before dependency injection;
				// if that happens, the first real request would otherwise wait 5 min.
				void refreshBalance();
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
		async function rpcFetchSessionDailyCost() {
			const unavailable = { status: "unavailable", date: beijingDateKey(Date.now()), sessionCount: 0 };
			if (typeof callGetSessionDailyCost !== "function") return unavailable;
			try {
				const result = await callGetSessionDailyCost("/api", "stats-decimal/getSessionDailyCost", {});
				if (result?.ok !== true) return unavailable;
				const value = result.value ?? {};
				const status = ["ready", "unknown", "unavailable"].includes(value.status) ? value.status : "unavailable";
				const date = typeof value.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.date)
					? value.date
					: unavailable.date;
				const sessionCount = Number.isSafeInteger(value.sessionCount) && value.sessionCount >= 0 ? value.sessionCount : 0;
				const totals = {
					CNY: safeCost(value.totals?.CNY),
					USD: safeCost(value.totals?.USD)
				};
				if (status === "ready" && (totals.CNY === null || totals.USD === null)) return unavailable;
				return { status, date, totals, sessionCount };
			} catch {
				return unavailable;
			}
		}
		function safeCost(value) {
			return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
		}
		function beijingDateKey(timeEpochMs) {
			return new Date(timeEpochMs + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
		}
		/** One shared Host aggregation request and five-minute refresh for the mounted billing rows. */
		let pageSessionDailyCost = null;
		const sessionDailyListeners = new Set();
		let sessionDailyInterval = null;
		function subscribeSessionDaily(listener) {
			sessionDailyListeners.add(listener);
			listener();
			if (sessionDailyInterval === null) {
				void refreshSessionDailyCost();
				sessionDailyInterval = setInterval(refreshSessionDailyCost, BALANCE_REFRESH_MS);
			}
			return () => {
				sessionDailyListeners.delete(listener);
				if (sessionDailyListeners.size === 0 && sessionDailyInterval !== null) {
					clearInterval(sessionDailyInterval);
					sessionDailyInterval = null;
				}
			};
		}
		function emitSessionDailyCost() {
			for (const listener of sessionDailyListeners) listener();
		}
		async function refreshSessionDailyCost() {
			pageSessionDailyCost = await rpcFetchSessionDailyCost();
			emitSessionDailyCost();
		}
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
		/** One per-currency third-row segment: "Total x · Today y" plus, when the
		 *  balance is enabled, " · Balance z" (value, or "–" when degraded/no key).
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
		/** Classify the current Beijing date and pricing period for the status pill. */
		function currentPeriodStatus(timeEpochMs, peakHours, publicHolidaySpans) {
			const beijingTime = new Date(timeEpochMs + 8 * 60 * 60 * 1000);
			const beijingDate = beijingTime.toISOString().slice(0, 10);
			const holiday = Array.isArray(publicHolidaySpans) && publicHolidaySpans.find((span) =>
				typeof span?.startDate === "string"
					&& typeof span?.endDate === "string"
					&& span.startDate <= beijingDate
					&& beijingDate <= span.endDate
			);
			if (holiday) {
				return {
					dayType: "holiday",
					band: "valley",
					name: typeof holiday.name === "string" && holiday.name ? holiday.name : "法定节假日",
					nameEn: typeof holiday.nameEn === "string" && holiday.nameEn ? holiday.nameEn : "Public holiday"
				};
			}
			const beijingDay = beijingTime.getUTCDay();
			if (beijingDay === 0 || beijingDay === 6) return { dayType: "weekend", band: "valley" };
			const isPeak = Array.isArray(peakHours) && peakHours.includes(beijingTime.getUTCHours());
			return { dayType: "weekday", band: isPeak ? "peak" : "valley" };
		}
		// ---- plugin-owned locale templates ----
		const zh = {
			"statsDecimal.currency": "{currency} 累计 {cumulative} · 今日 {today}",
			"statsDecimal.sessionDaily": "北京时间 {date} · 本地全会话今日 {totals} · {sessions} 个会话",
			"statsDecimal.sessionDailyLoading": "北京时间 {date} · 正在统计本地会话…",
			"statsDecimal.sessionDailyUnknown": "北京时间 {date} · 本地全会话费用未知 · {sessions} 个会话",
			"statsDecimal.sessionDailyUnavailable": "本地全会话统计暂不可用",
			"statsDecimal.sessionDailySeparator": " · ",
			"statsDecimal.balanceSuffix": "余额 {amount}",
			"statsDecimal.balanceUnavailableSuffix": "余额 –",
			"statsDecimal.costUnknown": "费用未知",
			"statsDecimal.currencyCostUnknown": "{currency} 费用未知",
			"statsDecimal.periodWeekdayPeak": "工作日 · 高峰时段",
			"statsDecimal.periodWeekdayOffPeak": "工作日 · 空闲时段",
			"statsDecimal.periodWeekendOffPeak": "周末 · 空闲时段",
			"statsDecimal.periodHolidayOffPeak": "{name} · 空闲时段"
		};
		const en = {
			"statsDecimal.currency": "{currency} Total {cumulative} · Today {today}",
			"statsDecimal.sessionDaily": "Local sessions · {date} Beijing · Today {totals} · {sessions} sessions",
			"statsDecimal.sessionDailyLoading": "Local sessions · {date} Beijing · Calculating…",
			"statsDecimal.sessionDailyUnknown": "Local sessions · {date} Beijing · Cost unknown · {sessions} sessions",
			"statsDecimal.sessionDailyUnavailable": "Local session total unavailable",
			"statsDecimal.sessionDailySeparator": " | ",
			"statsDecimal.balanceSuffix": "Balance {amount}",
			"statsDecimal.balanceUnavailableSuffix": "Balance –",
			"statsDecimal.costUnknown": "Cost unknown",
			"statsDecimal.currencyCostUnknown": "{currency} Cost unknown",
			"statsDecimal.periodWeekdayPeak": "Weekday · PEAK",
			"statsDecimal.periodWeekdayOffPeak": "Weekday · OFF-PEAK",
			"statsDecimal.periodWeekendOffPeak": "Weekend · OFF-PEAK",
			"statsDecimal.periodHolidayOffPeak": "{nameEn} · OFF-PEAK"
		};

		// Append billing after the complete native composer stats band.
		const rootStyle = {
			textAlign: "center",
			boxSizing: "border-box",
			order: 1,
			flex: "0 0 100%",
			width: "100%",
			padding: "0px calc(var(--dsh-composer-side-clearance) + 16px)",
			color: "var(--dsw-alias-label-tertiary)",
			fontSize: "12px",
			lineHeight: "20px",
			display: "block"
		};
		const lineStyle = {
			display: "block",
			maxWidth: "100%",
			whiteSpace: "nowrap",
			overflow: "hidden",
			textOverflow: "ellipsis"
		};
		const sessionDailyLineStyle = { ...lineStyle, opacity: 0.9 };
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
			const billingRoot = react.useRef(null);
			const enabled = ledgerVal !== void 0 && ledgerVal.enabled;
			const [sessionDailyVal, setSessionDailyVal] = react.useState(pageSessionDailyCost);
			react.useEffect(() => {
				if (!enabled) return undefined;
				return subscribeSessionDaily(() => setSessionDailyVal(pageSessionDailyCost));
			}, [enabled]);
			react.useLayoutEffect(() => {
				if (!enabled || !billingRoot.current) return;
				const slot = billingRoot.current.closest('[data-slot="conversation.composer.dock"]');
				const dock = slot?.parentElement;
				if (!dock || window.getComputedStyle(dock).display !== "flex") return;
				// DSH v0.2.0-rc.1 mounts ContextMeter after the dock slot as a sibling.
				// Reserve a compact second row so the plugin readout stays distinct.
				const previousFlexWrap = dock.style.flexWrap;
				const previousRowGap = dock.style.rowGap;
				dock.style.flexWrap = "wrap";
				dock.style.rowGap = "4px";
				return () => {
					if (dock.style.flexWrap === "wrap") dock.style.flexWrap = previousFlexWrap;
					if (dock.style.rowGap === "4px") dock.style.rowGap = previousRowGap;
				};
			}, [enabled]);
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
			// "Total · Today" plus " · Balance" when enabled. Each currency
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
			const sessionDailyText = formatSessionDailyCost(sessionDailyVal, currencies, t);
			const status = currentPeriodStatus(now, ledgerVal.peakHours, ledgerVal.publicHolidaySpans);
			const periodKey = status.dayType === "holiday"
				? "statsDecimal.periodHolidayOffPeak"
				: status.dayType === "weekend"
					? "statsDecimal.periodWeekendOffPeak"
					: status.band === "peak"
						? "statsDecimal.periodWeekdayPeak"
						: "statsDecimal.periodWeekdayOffPeak";
			const period = t(periodKey, { name: status.name, nameEn: status.nameEn });
			const children = [react.createElement("span", { key: "period", style: periodStyle }, period)];
			billing.forEach((group, index) => {
				if (index > 0) children.push(react.createElement("span", { key: `sep-${index}`, style: sepStyle, "aria-hidden": true }, "|"));
				children.push(react.createElement("span", { key: `billing-${index}` }, group));
			});
			return react.createElement("div", { ref: billingRoot, "data-stats-decimal": "", style: rootStyle },
				react.createElement("div", { style: lineStyle }, children),
				sessionDailyText === null ? null : react.createElement("div", { style: sessionDailyLineStyle }, sessionDailyText));
		}
		function formatSessionDailyCost(value, currencies, t) {
			if (value === null || value.status === "loading") {
				const date = typeof value?.date === "string" ? value.date : beijingDateKey(Date.now());
				return t("statsDecimal.sessionDailyLoading", { date });
			}
			if (value.status === "unavailable") return t("statsDecimal.sessionDailyUnavailable");
			if (value.status === "unknown") {
				return t("statsDecimal.sessionDailyUnknown", { date: value.date, sessions: value.sessionCount });
			}
			const separator = t("statsDecimal.sessionDailySeparator");
			const totals = currencies
				.filter((iso) => iso === "CNY" || iso === "USD")
				.map((iso) => `${iso} ${formatAmount(value.totals[iso], iso, AMOUNT_DECIMALS)}`)
				.join(separator);
			return t("statsDecimal.sessionDaily", { date: value.date, totals, sessions: value.sessionCount });
		}
		/** "Balance x" suffix appended to a currency segment (no currency prefix —
		 *  it is already the segment's leading currency). Degrades to "Balance –"
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
				callGetSessionDailyCost = rpc.call.bind(rpc);
			}
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "stats-decimal: dictionaries");
			// Keep DSH's native stats item intact; add billing after it in the slot.
			ctx.slots.inject("conversation.composer.dock", () => ctx.slots.register({
				name: "conversation.composer.dock",
				id: "stats-decimal-billing",
				order: 10,
				locale: NS
			}, BillingStatus));
		}

		exports.apply = apply;
		exports.inject = ["slots", "locale", "connection"];
		return module.exports;
	}
});
