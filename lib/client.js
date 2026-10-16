/**
 * dsh-stats-decimal — browser half.
 *
 * DSH v0.2.0-rc.2 owns the native `stats` cell and renders its expandable StatsPills.
 * This bundle contributes a separate `billing` cell containing the estimated
 * CNY/USD ledger, current-session and current-profile daily totals, recharge
 * balance, and the current official pricing period.
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

		// ---- provider-scoped balance readout (via Host RPC, no Session events) ----
		// The browser sends only the active Session ID. The Host independently
		// reads DSH's Session Controller projection and chooses the balance source.
		// Credentials remain Host-side. A balance is never shared across Session
		// identities, and provider changes invalidate the old result immediately.
		const SOURCE_REFRESH_MS = 5 * 60 * 1000; // Poll external/profile-wide sources every five minutes.
		const BALANCE_RPC_TIMEOUT_MS = 165 * 1000; // The DSH account service may take up to 120 seconds.
		const BALANCE_STALE_TTL_MS = SOURCE_REFRESH_MS;
		const BALANCE_RETRY_DELAYS_MS = [1000, 3000];
		const BALANCE_RETRYABLE_ERRORS = new Set([
			"no-channel",
			"rpc-error",
			"session-authority-unavailable",
			"session-selection-timeout",
			"session-unavailable",
			"model-selection-unavailable",
			"default-model-unavailable",
			"selection-changed",
			"account-provider-unavailable",
			"account-balance-failed",
			"account-balance-unavailable",
			"no-account-session"
		]);
		const BALANCE_RETRY_RESET_MS = 30 * 1000;
		const BEIJING_HOUR_MS = 60 * 60 * 1000;
		const EVENT_REFRESH_DEBOUNCE_MS = 300;
		const refreshTasks = new Map();
		let refreshSchedulerTimer = null;
		// The shared Web client runs in a browser on Web and in Electron's renderer on Desktop.
		function currentTimeZone() {
			try {
				return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
			} catch {
				return "UTC";
			}
		}
		function dateKeyInTimeZone(timeEpochMs, timeZone = currentTimeZone()) {
			if (!Number.isFinite(timeEpochMs)) return null;
			try {
				const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
					timeZone,
					year: "numeric",
					month: "2-digit",
					day: "2-digit"
				}).formatToParts(new Date(timeEpochMs))
					.filter((part) => part.type === "year" || part.type === "month" || part.type === "day")
					.map((part) => [part.type, part.value]));
				if (!parts.year || !parts.month || !parts.day) return null;
				return `${parts.year.padStart(4, "0")}-${parts.month}-${parts.day}`;
			} catch {
				return null;
			}
		}
		function nextBeijingHourBoundary(timeEpochMs) {
			const beijingEpochMs = timeEpochMs + 8 * BEIJING_HOUR_MS;
			return (Math.floor(beijingEpochMs / BEIJING_HOUR_MS) + 1) * BEIJING_HOUR_MS - 8 * BEIJING_HOUR_MS;
		}
		function nextLocalDayBoundary(timeEpochMs) {
			const nextDay = new Date(timeEpochMs);
			nextDay.setHours(24, 0, 0, 0);
			return nextDay.getTime();
		}
		function scheduleRefreshTasks() {
			if (refreshSchedulerTimer !== null) {
				clearTimeout(refreshSchedulerTimer);
				refreshSchedulerTimer = null;
			}
			const now = Date.now();
			let nextAt = Infinity;
			for (const task of refreshTasks.values()) {
				if (task.subscribers === 0 || task.inFlight) continue;
				nextAt = Math.min(nextAt, task.nextRunAt, task.requestedAt ?? Infinity);
			}
			if (Number.isFinite(nextAt)) {
				refreshSchedulerTimer = setTimeout(runScheduledRefreshTasks, Math.max(0, nextAt - now));
			}
		}
		function runScheduledRefreshTasks() {
			refreshSchedulerTimer = null;
			const now = Date.now();
			for (const task of refreshTasks.values()) {
				if (task.subscribers === 0 || task.inFlight) continue;
				const periodicDue = task.nextRunAt <= now;
				const eventDue = task.requestedAt !== null && task.requestedAt <= now;
				if (!periodicDue && !eventDue) continue;
				const force = task.forceRequested;
				task.requestedAt = null;
				task.forceRequested = false;
				task.nextRunAt = task.nextRunAtAfterRun(Date.now());
				task.inFlight = true;
				Promise.resolve()
					.then(() => task.run(force))
					.catch(() => {})
					.finally(() => {
						task.inFlight = false;
						if (task.subscribers === 0 && refreshTasks.get(task.key) === task) refreshTasks.delete(task.key);
						scheduleRefreshTasks();
					});
			}
			scheduleRefreshTasks();
		}
		function registerRefreshTask(key, run, options = {}) {
			let task = refreshTasks.get(key);
			if (!task) {
				task = {
					key,
					run,
					nextRunAtAfterRun: options.nextRunAtAfterRun ?? ((now) => now + SOURCE_REFRESH_MS),
					nextRunAt: options.initialRunAt ?? Date.now(),
					requestedAt: null,
					forceRequested: false,
					subscribers: 0,
					inFlight: false
				};
				refreshTasks.set(key, task);
			} else {
				task.run = run;
				task.nextRunAtAfterRun = options.nextRunAtAfterRun ?? task.nextRunAtAfterRun;
			}
			task.subscribers += 1;
			scheduleRefreshTasks();
			let released = false;
			return () => {
				if (released) return;
				released = true;
				task.subscribers = Math.max(0, task.subscribers - 1);
				if (task.subscribers === 0) {
					task.requestedAt = null;
					task.forceRequested = false;
					if (!task.inFlight && refreshTasks.get(key) === task) refreshTasks.delete(key);
				}
				scheduleRefreshTasks();
			};
		}
		function requestRefreshTask(key, { force = false, delayMs = 0 } = {}) {
			const task = refreshTasks.get(key);
			if (!task || task.subscribers === 0) return;
			task.requestedAt = Date.now() + Math.max(0, delayMs);
			task.forceRequested = task.forceRequested || force;
			scheduleRefreshTasks();
		}
		/** `callGetBalance` is bound in `apply(ctx)` when `connection` is injected. */
		let callGetBalance = null;
		let callGetSessionDailyCost = null;

		/**
		 * Ask the Host to resolve this Session's provider and fetch its recharge
		 * balance. A caller deadline settles even if Connection ignores abort.
		 */
		async function rpcFetchBalance(sessionId, controller) {
			const empty = { enabled: true, sessionId, provider: null, balanceGeneration: null, balances: { CNY: null, USD: null }, error: null };
			if (typeof callGetBalance !== "function") return { ...empty, error: "no-channel" };
			if (controller.signal.aborted) return { ...empty, error: "rpc-cancelled" };
			let timer = null;
			let removeAbort = null;
			let deadlineHit = false;
			const aborted = new Promise((resolve) => {
				const onAbort = () => resolve({ status: deadlineHit ? "timeout" : "aborted" });
				if (controller.signal.aborted) onAbort();
				else {
					controller.signal.addEventListener("abort", onAbort, { once: true });
					removeAbort = () => controller.signal.removeEventListener("abort", onAbort);
				}
			});
			const timeout = new Promise((resolve) => {
				timer = setTimeout(() => {
					deadlineHit = true;
					controller.abort();
					resolve({ status: "timeout" });
				}, BALANCE_RPC_TIMEOUT_MS);
			});
			const request = Promise.resolve().then(() => callGetBalance(
				"/api", "stats-decimal/getBalance", { sessionId }, controller.signal
			)).then((result) => ({ status: "fulfilled", result }), () => ({ status: "rejected" }));
			try {
				const outcome = await Promise.race([request, timeout, aborted]);
				if (outcome.status === "timeout") return { ...empty, error: "rpc-timeout" };
				if (outcome.status === "aborted") return { ...empty, error: "rpc-cancelled" };
				if (outcome.status !== "fulfilled" || outcome.result?.ok !== true) {
					return { ...empty, error: outcome.result?.error?.code ?? "rpc-error" };
				}
				const value = outcome.result.value ?? empty;
				return {
					...empty,
					enabled: Boolean(value?.enabled),
					provider: value?.provider === "deepseek-account" || value?.provider === "deepseek-official" ? value.provider : null,
					balanceGeneration: Number.isSafeInteger(value?.balanceGeneration) && value.balanceGeneration >= 0
						? value.balanceGeneration
						: null,
					balances: {
						CNY: safeBalance(value?.balances?.CNY),
						USD: safeBalance(value?.balances?.USD)
					},
					error: typeof value?.error === "string" ? value.error : null
				};
			} finally {
				if (timer !== null) clearTimeout(timer);
				removeAbort?.();
			}
		}
		function safeBalance(v) {
			return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
		}
		/** Balance state is scoped to one mounted Session; overlapping rows share one task. */
		const balanceEntries = new Map();
		function balanceRefreshKey(sessionId) {
			return `balance:${sessionId}`;
		}
		function emitBalance(entry) {
			for (const listener of entry.listeners) listener(entry.value);
		}
		function invalidateBalanceEntry(entry, selectedProvider, identityEpoch = entry.identityEpoch) {
			if (entry.selectedProvider === selectedProvider && entry.identityEpoch === identityEpoch) return false;
			entry.selectedProvider = selectedProvider;
			entry.identityEpoch = identityEpoch;
			entry.generation += 1;
			entry.retryCount = 0;
			entry.lastRetryAt = null;
			entry.controller?.abort();
			entry.controller = null;
			if (entry.expiryTimer !== null) clearTimeout(entry.expiryTimer);
			entry.expiryTimer = null;
			entry.value = null;
			emitBalance(entry);
			return true;
		}
		function invalidateBalanceEntries(predicate = () => true) {
			for (const entry of balanceEntries.values()) {
				if (!predicate(entry)) continue;
				if (!invalidateBalanceEntry(entry, entry.selectedProvider, entry.identityEpoch + 1)) continue;
				requestRefreshTask(balanceRefreshKey(entry.sessionId), { delayMs: EVENT_REFRESH_DEBOUNCE_MS });
			}
		}
		function invalidateRemovedSessionBalance(sessionId) {
			if (typeof sessionId !== "string") return;
			const entry = balanceEntries.get(sessionId);
			if (!entry) return;
			entry.generation += 1;
			entry.controller?.abort();
			entry.controller = null;
			if (entry.expiryTimer !== null) clearTimeout(entry.expiryTimer);
			entry.expiryTimer = null;
			entry.value = null;
			entry.releaseRefresh?.();
			entry.releaseRefresh = null;
			balanceEntries.delete(sessionId);
			emitBalance(entry);
		}
		function subscribeBalance(sessionId, selectedProvider, listener) {
			if (typeof sessionId !== "string" || sessionId.length === 0) {
				listener(null);
				return () => {};
			}
			let entry = balanceEntries.get(sessionId);
			let selectionChanged = false;
			if (!entry) {
				entry = {
					sessionId,
					selectedProvider,
					identityEpoch: 0,
					generation: 0,
					retryCount: 0,
					lastRetryAt: null,
					value: null,
					listeners: new Set(),
					controller: null,
					expiryTimer: null,
					releaseRefresh: null
				};
				balanceEntries.set(sessionId, entry);
			} else {
				selectionChanged = invalidateBalanceEntry(entry, selectedProvider);
			}
			entry.listeners.add(listener);
			listener(entry.value);
			if (entry.releaseRefresh === null) {
				const refreshKey = balanceRefreshKey(sessionId);
				entry.releaseRefresh = registerRefreshTask(refreshKey, () => refreshBalance(sessionId));
				requestRefreshTask(refreshKey);
			} else if (selectionChanged) {
				requestRefreshTask(balanceRefreshKey(sessionId));
			}
			return () => {
				entry.listeners.delete(listener);
				if (entry.listeners.size !== 0) return;
				entry.releaseRefresh?.();
				entry.releaseRefresh = null;
				entry.controller?.abort();
				entry.controller = null;
				if (entry.expiryTimer !== null) clearTimeout(entry.expiryTimer);
				entry.expiryTimer = null;
				entry.generation += 1;
				if (balanceEntries.get(sessionId) === entry) balanceEntries.delete(sessionId);
			};
		}
		async function refreshBalance(sessionId) {
			const entry = balanceEntries.get(sessionId);
			if (!entry || entry.listeners.size === 0) return;
			if (entry.lastRetryAt !== null && Date.now() - entry.lastRetryAt >= BALANCE_RETRY_RESET_MS) {
				entry.retryCount = 0;
				entry.lastRetryAt = null;
			}
			const generation = entry.generation;
			const controller = new AbortController();
			entry.controller = controller;
			// Remove the previous success as soon as refresh starts. A hung provider
			// can never leave an old balance visible while this bounded RPC runs.
			entry.value = {
				enabled: true,
				sessionId,
				provider: entry.selectedProvider,
					balanceGeneration: null,
				generation,
				fetchedAt: Date.now(),
				loading: true,
				balances: { CNY: null, USD: null },
				error: null
			};
			emitBalance(entry);
			let result = await rpcFetchBalance(sessionId, controller);
			if (balanceEntries.get(sessionId) !== entry || entry.generation !== generation) return;
			if (entry.selectedProvider !== null && result.provider !== null && result.provider !== entry.selectedProvider) {
				entry.value = {
					enabled: true,
					sessionId,
					provider: null,
					generation,
					fetchedAt: Date.now(),
					loading: false,
					balances: { CNY: null, USD: null },
					error: "selection-changed"
				};
				requestRefreshTask(balanceRefreshKey(sessionId), { delayMs: EVENT_REFRESH_DEBOUNCE_MS });
			} else {
				if (result.provider === "deepseek-official" && result.balanceGeneration === null) {
					result = { ...result, balances: { CNY: null, USD: null }, error: "balance-identity-unavailable" };
				}
				entry.value = { ...result, generation, fetchedAt: Date.now(), loading: false };
				if (BALANCE_RETRYABLE_ERRORS.has(entry.value.error)) {
					const delayMs = BALANCE_RETRY_DELAYS_MS[entry.retryCount];
					if (delayMs !== undefined) {
						entry.retryCount += 1;
						entry.lastRetryAt = Date.now();
						requestRefreshTask(balanceRefreshKey(sessionId), { delayMs });
					}
				} else {
					entry.retryCount = 0;
					entry.lastRetryAt = null;
				}
			}
			if (entry.expiryTimer !== null) clearTimeout(entry.expiryTimer);
			entry.expiryTimer = setTimeout(() => {
				if (balanceEntries.get(sessionId) !== entry || entry.generation !== generation) return;
				entry.value = null;
				entry.expiryTimer = null;
				emitBalance(entry);
			}, BALANCE_STALE_TTL_MS);
			entry.controller = null;
			emitBalance(entry);
		}
		async function rpcFetchSessionDailyCost(force = false, sessionId) {
			const timeZone = currentTimeZone();
			const unavailable = {
				status: "unavailable",
				date: dateKeyInTimeZone(Date.now(), timeZone),
				timeZone,
				sessionCount: 0,
				currentSession: { status: "unavailable", totals: null }
			};
			if (typeof callGetSessionDailyCost !== "function") return unavailable;
			try {
				const result = await callGetSessionDailyCost("/api", "stats-decimal/getSessionDailyCost", { force, timeZone, sessionId });
				if (result?.ok !== true) return unavailable;
				const value = result.value ?? {};
				const status = ["ready", "unknown", "unavailable"].includes(value.status) ? value.status : "unavailable";
				const date = typeof value.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.date)
					? value.date
					: unavailable.date;
				const resolvedTimeZone = typeof value.timeZone === "string" && value.timeZone.length > 0
					? value.timeZone
					: timeZone;
				const sessionCount = Number.isSafeInteger(value.sessionCount) && value.sessionCount >= 0 ? value.sessionCount : 0;
				const totals = {
					CNY: safeCost(value.totals?.CNY),
					USD: safeCost(value.totals?.USD)
				};
				if (status === "ready" && (totals.CNY === null || totals.USD === null)) return unavailable;
				const currentSessionStatus = ["ready", "unknown", "unavailable"].includes(value.currentSession?.status)
					? value.currentSession.status
					: "unavailable";
				const currentSessionTotals = {
					CNY: safeCost(value.currentSession?.totals?.CNY),
					USD: safeCost(value.currentSession?.totals?.USD)
				};
				const currentSession = currentSessionStatus === "ready"
					&& (currentSessionTotals.CNY === null || currentSessionTotals.USD === null)
					? unavailable.currentSession
					: { status: currentSessionStatus, totals: currentSessionTotals };
				return { status, date, timeZone: resolvedTimeZone, totals, sessionCount, currentSession };
			} catch {
				return unavailable;
			}
		}
		function safeCost(value) {
			return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
		}
		/** One daily aggregate snapshot and refresh lifecycle per mounted Session. */
		const sessionDailyEntries = new Map();
		let releaseSessionDailyBoundaryRefresh = null;
		function sessionDailyRefreshKey(sessionId) {
			return `session-daily:${sessionId}`;
		}
		function subscribeSessionDaily(sessionId, listener) {
			if (typeof sessionId !== "string" || sessionId.length === 0) {
				listener();
				return () => {};
			}
			let entry = sessionDailyEntries.get(sessionId);
			if (!entry) {
				entry = { value: null, listeners: new Set(), releaseRefresh: null };
				sessionDailyEntries.set(sessionId, entry);
			}
			entry.listeners.add(listener);
			listener();
			if (entry.releaseRefresh === null) {
				const refreshKey = sessionDailyRefreshKey(sessionId);
				entry.releaseRefresh = registerRefreshTask(refreshKey, (force) => refreshSessionDailyCost(sessionId, force));
				requestRefreshTask(refreshKey);
			}
			if (releaseSessionDailyBoundaryRefresh === null) {
				releaseSessionDailyBoundaryRefresh = registerRefreshTask(
					"session-daily-boundary",
					() => requestAllSessionDailyRefreshes({ force: true }),
					{ initialRunAt: nextLocalDayBoundary(Date.now()), nextRunAtAfterRun: nextLocalDayBoundary }
				);
			}
			return () => {
				entry.listeners.delete(listener);
				if (entry.listeners.size === 0) {
					entry.releaseRefresh?.();
					entry.releaseRefresh = null;
					sessionDailyEntries.delete(sessionId);
				}
				if (sessionDailyEntries.size === 0 && releaseSessionDailyBoundaryRefresh !== null) {
					releaseSessionDailyBoundaryRefresh?.();
					releaseSessionDailyBoundaryRefresh = null;
				}
			};
		}
		function requestAllSessionDailyRefreshes(options) {
			for (const [activeSessionId, entry] of sessionDailyEntries) {
				if (entry.listeners.size > 0) requestRefreshTask(sessionDailyRefreshKey(activeSessionId), options);
			}
		}
		function emitSessionDailyCost(entry) {
			for (const listener of entry.listeners) listener();
		}
		async function refreshSessionDailyCost(sessionId, force = false) {
			const entry = sessionDailyEntries.get(sessionId);
			if (!entry) return;
			const result = await rpcFetchSessionDailyCost(force, sessionId);
			if (sessionDailyEntries.get(sessionId) !== entry) return;
			entry.value = result;
			emitSessionDailyCost(entry);
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
		function currencyLedgerSegment(cumulative, todayText, iso, decimals, t, balanceRow) {
			let text = t("statsDecimal.currency", {
				currency: iso,
				cumulative: formatAmount(cumulative[iso], iso, decimals),
				today: todayText
			});
			if (balanceRow !== null) {
				text += " · " + balanceRow;
			}
			return text;
		}
		function currentSessionDailyCostText(value, iso, t) {
			if (value?.currentSession?.status === "ready") {
				return formatAmount(value.currentSession.totals[iso], iso, AMOUNT_DECIMALS);
			}
			if (value?.currentSession?.status === "unknown") return t("statsDecimal.dailyCostUnknown");
			if (value?.currentSession?.status === "unavailable") return t("statsDecimal.dailyCostUnavailable");
			return t("statsDecimal.dailyCostLoading");
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
			"statsDecimal.sessionDaily": "{timeZone} {date} · 本地全会话今日 {totals} · {sessions} 个会话",
			"statsDecimal.sessionDailyLoading": "{timeZone} {date} · 正在统计本地会话…",
			"statsDecimal.sessionDailyUnknown": "{timeZone} {date} · 本地全会话费用未知 · {sessions} 个会话",
			"statsDecimal.sessionDailyUnavailable": "本地全会话统计暂不可用",
			"statsDecimal.sessionDailySeparator": " · ",
			"statsDecimal.balanceSuffix": "余额 {amount}",
			"statsDecimal.balanceUnavailableSuffix": "余额 –",
			"statsDecimal.costUnknown": "费用未知",
			"statsDecimal.dailyCostLoading": "…",
			"statsDecimal.dailyCostUnavailable": "–",
			"statsDecimal.dailyCostUnknown": "费用未知",
			"statsDecimal.currencyCostUnknown": "{currency} 费用未知",
			"statsDecimal.periodWeekdayPeak": "工作日 · 高峰时段",
			"statsDecimal.periodWeekdayOffPeak": "工作日 · 空闲时段",
			"statsDecimal.periodWeekendOffPeak": "周末 · 空闲时段",
			"statsDecimal.periodHolidayOffPeak": "{name} · 空闲时段"
		};
		const en = {
			"statsDecimal.currency": "{currency} Total {cumulative} · Today {today}",
			"statsDecimal.sessionDaily": "Local sessions · {date} ({timeZone}) · Today {totals} · {sessions} sessions",
			"statsDecimal.sessionDailyLoading": "Local sessions · {date} ({timeZone}) · Calculating…",
			"statsDecimal.sessionDailyUnknown": "Local sessions · {date} ({timeZone}) · Cost unknown · {sessions} sessions",
			"statsDecimal.sessionDailyUnavailable": "Local session total unavailable",
			"statsDecimal.sessionDailySeparator": " | ",
			"statsDecimal.balanceSuffix": "Balance {amount}",
			"statsDecimal.balanceUnavailableSuffix": "Balance –",
			"statsDecimal.costUnknown": "Cost unknown",
			"statsDecimal.dailyCostLoading": "…",
			"statsDecimal.dailyCostUnavailable": "–",
			"statsDecimal.dailyCostUnknown": "Cost unknown",
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
		function BillingStatus({ useProjection, t, sessionId }) {
			const ledgerVal = useProjection("billingLedger");
			const modelSelectionVal = useProjection("modelSelection");
			const enabled = ledgerVal !== void 0 && ledgerVal.enabled;
			const balanceEnabled = ledgerVal !== void 0 && ledgerVal.balanceEnabled === true;
			const selectedProvider = selectedProviderFromProjection(modelSelectionVal);
			const [balanceVal, setBalanceVal] = react.useState(null);
			react.useEffect(() => {
				if (!enabled || !balanceEnabled) {
					setBalanceVal(null);
					return undefined;
				}
				return subscribeBalance(sessionId, selectedProvider, setBalanceVal);
			}, [enabled, balanceEnabled, sessionId, selectedProvider]);
			const billingRoot = react.useRef(null);
			const [sessionDailyVal, setSessionDailyVal] = react.useState(() => sessionDailyEntries.get(sessionId)?.value ?? null);
			const lastSessionDailyLedger = react.useRef(null);
			react.useEffect(() => {
				if (!enabled) return undefined;
				return subscribeSessionDaily(sessionId, () => setSessionDailyVal(sessionDailyEntries.get(sessionId)?.value ?? null));
			}, [enabled, sessionId]);
			react.useEffect(() => {
				if (!enabled) {
					lastSessionDailyLedger.current = null;
					return;
				}
				const ledgerKey = `${ledgerVal.today.CNY}:${ledgerVal.today.USD}:${ledgerVal.pricingKnown}`;
				const previousLedgerKey = lastSessionDailyLedger.current;
				lastSessionDailyLedger.current = ledgerKey;
				if (previousLedgerKey !== null && previousLedgerKey !== ledgerKey && typeof sessionId === "string") {
					requestRefreshTask(sessionDailyRefreshKey(sessionId), {
						force: true,
						delayMs: EVENT_REFRESH_DEBOUNCE_MS
					});
				}
			}, [enabled, sessionId, ledgerVal?.today?.CNY, ledgerVal?.today?.USD, ledgerVal?.pricingKnown]);
			react.useLayoutEffect(() => {
				if (!enabled || !billingRoot.current) return;
				const slot = billingRoot.current.closest('[data-slot="conversation.composer.dock"]');
				const dock = slot?.parentElement;
				if (!dock || window.getComputedStyle(dock).display !== "flex") return;
				// DSH v0.2.0-rc.2 mounts ContextMeter after the dock slot as a sibling.
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
				if (!enabled) return undefined;
				return registerRefreshTask("period-label", () => {
					setNow(Date.now());
				}, {
					initialRunAt: nextBeijingHourBoundary(Date.now()),
					nextRunAtAfterRun: nextBeijingHourBoundary
				});
			}, [enabled]);
			if (ledgerVal === void 0 || !ledgerVal.enabled) return null;

			const billing = [];
			// One segment per enabled currency (cnyEnabled/usdEnabled),
			// "Total · Today" plus " · Balance" when enabled. Each currency
			// appears exactly once; balance is attached to the cost row.
			const currencies = Array.isArray(ledgerVal.currencies) ? ledgerVal.currencies : [];
			const entry = typeof sessionId === "string" ? balanceEntries.get(sessionId) : null;
			const balanceMatchesSelection = balanceVal?.sessionId === sessionId
				&& (selectedProvider === null || balanceVal.provider === selectedProvider)
				&& (balanceVal.provider !== "deepseek-official" || Number.isSafeInteger(balanceVal.balanceGeneration))
				&& balanceVal.generation === entry?.generation
				&& balanceVal.loading !== true
				&& Date.now() - balanceVal.fetchedAt <= BALANCE_STALE_TTL_MS;
			const visibleBalance = balanceEnabled && balanceMatchesSelection ? balanceVal : null;
			const balanceOn = balanceEnabled;
			if (ledgerVal.pricingKnown === false && !balanceOn) {
				billing.push(t("statsDecimal.costUnknown"));
			}
			for (const iso of currencies) {
				if (iso !== "CNY" && iso !== "USD") continue;
				const balanceRow = balanceOn ? balanceSuffix(visibleBalance, iso, t) : null;
				if (ledgerVal.pricingKnown === false) {
					if (balanceRow !== null) billing.push(`${t("statsDecimal.currencyCostUnknown", { currency: iso })} · ${balanceRow}`);
					continue;
				}
				billing.push(currencyLedgerSegment(
					ledgerVal.cumulative,
					currentSessionDailyCostText(sessionDailyVal, iso, t),
					iso,
					AMOUNT_DECIMALS,
					t,
					balanceRow
				));
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
			const timeZone = typeof value?.timeZone === "string" && value.timeZone.length > 0
				? value.timeZone
				: currentTimeZone();
			if (value === null || value.status === "loading") {
				const date = typeof value?.date === "string" ? value.date : dateKeyInTimeZone(Date.now(), timeZone);
				return t("statsDecimal.sessionDailyLoading", { date, timeZone });
			}
			if (value.status === "unavailable") return t("statsDecimal.sessionDailyUnavailable");
			if (value.status === "unknown") {
				return t("statsDecimal.sessionDailyUnknown", { date: value.date, timeZone, sessions: value.sessionCount });
			}
			const separator = t("statsDecimal.sessionDailySeparator");
			const totals = currencies
				.filter((iso) => iso === "CNY" || iso === "USD")
				.map((iso) => `${iso} ${formatAmount(value.totals[iso], iso, AMOUNT_DECIMALS)}`)
				.join(separator);
			return t("statsDecimal.sessionDaily", { date: value.date, timeZone, totals, sessions: value.sessionCount });
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
		function selectedProviderFromProjection(value) {
			const selection = value?.next ?? value?.lastUsed;
			return typeof selection?.provider === "string" && selection.provider.length > 0
				? selection.provider
				: null;
		}

		function apply(ctx) {
			const bindConnectionRpc = () => {
				const rpc = ctx.connection?.rpc;
				if (!rpc || typeof rpc.call !== "function") return;
				callGetBalance = rpc.call.bind(rpc);
				callGetSessionDailyCost = rpc.call.bind(rpc);
			};
			// Bind the balance RPC client from the injected connection service.
			bindConnectionRpc();
			if (typeof ctx.remote?.$on === "function") {
				ctx.effect(() => ctx.remote.$on("api-session/removed", (sessionId) => {
					invalidateRemovedSessionBalance(sessionId);
					requestAllSessionDailyRefreshes({ force: true, delayMs: EVENT_REFRESH_DEBOUNCE_MS });
				}), "stats-decimal: session removal invalidation");
				const invalidateOfficialBalances = () => invalidateBalanceEntries((entry) => entry.selectedProvider !== "deepseek-account");
				for (const event of ["settings/document-updated", "llm/adapters-updated", "credentials/reference-updated"]) {
					ctx.effect(() => ctx.remote.$on(event, invalidateOfficialBalances), `stats-decimal: ${event} balance invalidation`);
				}
			}
		if (typeof ctx.on === "function") {
			ctx.effect(() => ctx.on("connection/reset", () => {
				bindConnectionRpc();
				invalidateBalanceEntries();
			}), "stats-decimal: connection reset balance invalidation");
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
		exports.inject = ["slots", "locale", "connection", "remote"];
		return module.exports;
	}
});
