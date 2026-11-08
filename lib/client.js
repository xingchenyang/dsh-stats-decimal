/**
 * dsh-stats-decimal — browser half.
 *
 * DSH owns the native `stats`/Usage pills. This bundle contributes a
 * responsive Usage & Billing Zone in `conversation.composer.dock`: Current
 * Session, authoritative Multi-Agent Tree, Local Today, and Balance. It never
 * shadows or reimplements native token/timing/context execution UI.
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
		let reactDom = null;
		try {
			reactDom = require("react-dom");
		} catch {
			// Portal support is optional; the detail surface falls back inline.
		}

		const NS = "stats-decimal";
		/** How many decimals to show for currency amounts (truncated, never rounded). */
		const AMOUNT_DECIMALS = 2;
		const USAGE_SCOPES_REFRESH_MS = 60 * 1000;
		const USAGE_SCOPES_RPC_TIMEOUT_MS = 60 * 1000;

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
		let callGetUsageScopes = null;

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
		function parseStatus(value, allowed) {
			return typeof value === "string" && allowed.includes(value) ? value : "unavailable";
		}
		function parseMoney(value) {
			if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
			return { CNY: safeCost(value.CNY), USD: safeCost(value.USD) };
		}
		function parseTokens(value) {
			if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
			const tokens = {};
			for (const key of ["uncachedInput", "cacheRead", "cacheWrite", "output", "reasoning"]) {
				const entry = value[key];
				tokens[key] = Number.isSafeInteger(entry) && entry >= 0 ? entry : null;
			}
			return tokens;
		}
		function parseCacheHit(value) {
			return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
		}
		function parseDiagnostics(value) {
			const source = value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
			const diagnostics = {};
			for (const key of ["external", "unsupported", "corrupt", "unreadable", "duplicate", "malformed", "membershipUnavailable"]) {
				diagnostics[key] = source[key] === true;
			}
			return diagnostics;
		}
		function parseReasoningReported(value) {
			return value === true ? true : value === false ? false : null;
		}
		function parseScope(value, allowed, tree = false) {
			const status = parseStatus(value?.status, allowed);
			const scope = {
				cumulative: parseMoney(value?.cumulative),
				today: parseMoney(value?.today),
				tokens: parseTokens(value?.tokens),
				reasoningReported: parseReasoningReported(value?.reasoningReported),
				cacheHit: parseCacheHit(value?.cacheHit),
				pricingKnown: value?.pricingKnown === true,
				usageKnown: value?.usageKnown === true,
				reasoningReported: value?.reasoningReported === true
					? true
					: value?.reasoningReported === false
						? false
						: null,
				status
			};
			if (tree) {
				scope.complete = value?.complete === true;
				scope.hasDescendants = value?.hasDescendants === true
					? true
					: value?.hasDescendants === false
						? false
						: null;
				scope.coordinatorDirect = value?.coordinatorDirect === null || value?.coordinatorDirect === void 0
					? null
					: {
						cumulative: parseMoney(value.coordinatorDirect.cumulative),
						today: parseMoney(value.coordinatorDirect.today),
						tokens: parseTokens(value.coordinatorDirect.tokens),
						reasoningReported: parseReasoningReported(value.coordinatorDirect.reasoningReported)
					};
				scope.subagentsAggregate = value?.subagentsAggregate === null || value?.subagentsAggregate === void 0
					? null
					: {
						cumulative: parseMoney(value.subagentsAggregate.cumulative),
						today: parseMoney(value.subagentsAggregate.today),
						tokens: parseTokens(value.subagentsAggregate.tokens),
						reasoningReported: parseReasoningReported(value.subagentsAggregate.reasoningReported)
					};
				scope.diagnostics = parseDiagnostics(value?.diagnostics);
			}
			return scope;
		}
		function unavailableUsageScopes(error = null, timeZone = currentTimeZone()) {
			const date = dateKeyInTimeZone(Date.now(), timeZone);
			return {
				date,
				timeZone,
				session: parseScope(null, ["ready", "unknown", "unavailable"]),
				tree: parseScope(null, ["ready", "partial", "unknown", "unavailable"], true),
				local: parseScope(null, ["ready", "unknown", "unavailable"]),
				generatedAt: null,
				error
			};
		}
		function parseUsageScopes(value, error = null, timeZone = currentTimeZone()) {
			if (value === null || typeof value !== "object" || Array.isArray(value)) {
				return unavailableUsageScopes(error, timeZone);
			}
			const resolvedTimeZone = typeof value.timeZone === "string" && value.timeZone.length > 0 ? value.timeZone : timeZone;
			const date = typeof value.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.date)
				? value.date
				: dateKeyInTimeZone(Date.now(), resolvedTimeZone);
			const generatedAt = Number.isFinite(value.generatedAt) ? value.generatedAt : null;
			const local = parseScope(value.local, ["ready", "unknown", "unavailable"]);
			local.sessionCount = Number.isSafeInteger(value.local?.sessionCount) && value.local.sessionCount >= 0
				? value.local.sessionCount
				: null;
			return {
				date,
				timeZone: resolvedTimeZone,
				session: parseScope(value.session, ["ready", "unknown", "unavailable"]),
				tree: parseScope(value.tree, ["ready", "partial", "unknown", "unavailable"], true),
				local,
				generatedAt,
				error
			};
		}
		async function rpcFetchUsageScopes(force, sessionId, scopes) {
			const timeZone = currentTimeZone();
			if (typeof callGetUsageScopes !== "function") return unavailableUsageScopes("no-channel", timeZone);
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), USAGE_SCOPES_RPC_TIMEOUT_MS);
			try {
				const result = await callGetUsageScopes(
					"/api",
					"stats-decimal/getUsageScopes",
					{ force, timeZone, sessionId, scopes },
					controller.signal
				);
				if (result?.ok !== true) return unavailableUsageScopes(result?.error?.code ?? "rpc-error", timeZone);
				return parseUsageScopes(result.value, null, timeZone);
			} catch {
				return unavailableUsageScopes(controller.signal.aborted ? "rpc-timeout" : "rpc-error", timeZone);
			} finally {
				clearTimeout(timer);
			}
		}
		const usageScopesEntries = new Map();
		let releaseUsageScopesBoundaryRefresh = null;
		function usageScopesRefreshKey(sessionId, part) {
			return `usage-scopes:${part}:${sessionId}`;
		}
		function usageScopesSnapshotValue(entry) {
			return {
				sessionId: entry?.sessionId ?? null,
				fastValue: entry?.fastValue ?? null,
				localValue: entry?.localValue ?? null,
				fastRefreshing: entry?.fastRefreshing === true,
				localRefreshing: entry?.localRefreshing === true,
				fastError: entry?.fastError ?? null,
				localError: entry?.localError ?? null
			};
		}
		function emitUsageScopes(entry) {
			const snapshot = usageScopesSnapshotValue(entry);
			for (const listener of entry.listeners) listener(snapshot);
		}
		function usageScopesSnapshot(sessionId) {
			return usageScopesSnapshotValue(typeof sessionId === "string" ? usageScopesEntries.get(sessionId) : undefined);
		}
		function requestAllUsageScopesRefreshes(options) {
			for (const [sessionId, entry] of usageScopesEntries) {
				if (entry.listeners.size === 0) continue;
				requestRefreshTask(usageScopesRefreshKey(sessionId, "fast"), options);
				requestRefreshTask(usageScopesRefreshKey(sessionId, "local"), options);
			}
		}
		async function refreshUsageScopesPart(sessionId, part, force = false) {
			const entry = usageScopesEntries.get(sessionId);
			if (!entry || entry.listeners.size === 0) return;
			const refreshingKey = part === "fast" ? "fastRefreshing" : "localRefreshing";
			const valueKey = part === "fast" ? "fastValue" : "localValue";
			const errorKey = part === "fast" ? "fastError" : "localError";
			entry[refreshingKey] = true;
			emitUsageScopes(entry);
			const result = await rpcFetchUsageScopes(force, sessionId, part === "fast" ? ["session", "tree"] : ["local"]);
			if (usageScopesEntries.get(sessionId) !== entry) return;
			entry[valueKey] = result;
			entry[errorKey] = result.error;
			entry[refreshingKey] = false;
			emitUsageScopes(entry);
		}
		function subscribeUsageScopes(sessionId, listener) {
			if (typeof sessionId !== "string" || sessionId.length === 0) {
				listener({ sessionId: null, fastValue: null, localValue: null, fastRefreshing: false, localRefreshing: false, fastError: null, localError: null });
				return () => {};
			}
			let entry = usageScopesEntries.get(sessionId);
			if (!entry) {
				entry = {
					sessionId,
					fastValue: null,
					localValue: null,
					fastRefreshing: false,
					localRefreshing: false,
					fastError: null,
					localError: null,
					listeners: new Set(),
					releaseFast: null,
					releaseLocal: null
				};
				usageScopesEntries.set(sessionId, entry);
			}
			entry.listeners.add(listener);
			listener(usageScopesSnapshotValue(entry));
			if (entry.releaseFast === null) {
				entry.releaseFast = registerRefreshTask(
					usageScopesRefreshKey(sessionId, "fast"),
					(force) => refreshUsageScopesPart(sessionId, "fast", force),
					{ nextRunAtAfterRun: (now) => now + USAGE_SCOPES_REFRESH_MS }
				);
				requestRefreshTask(usageScopesRefreshKey(sessionId, "fast"));
			}
			if (entry.releaseLocal === null) {
				entry.releaseLocal = registerRefreshTask(
					usageScopesRefreshKey(sessionId, "local"),
					(force) => refreshUsageScopesPart(sessionId, "local", force),
					{ nextRunAtAfterRun: (now) => now + USAGE_SCOPES_REFRESH_MS }
				);
				requestRefreshTask(usageScopesRefreshKey(sessionId, "local"));
			}
			if (releaseUsageScopesBoundaryRefresh === null) {
				releaseUsageScopesBoundaryRefresh = registerRefreshTask(
					"usage-scopes-boundary",
					() => requestAllUsageScopesRefreshes(),
					{ initialRunAt: nextLocalDayBoundary(Date.now()), nextRunAtAfterRun: nextLocalDayBoundary }
				);
			}
			return () => {
				entry.listeners.delete(listener);
				if (entry.listeners.size === 0) {
					entry.releaseFast?.();
					entry.releaseLocal?.();
					entry.releaseFast = null;
					entry.releaseLocal = null;
					usageScopesEntries.delete(sessionId);
				}
				if (usageScopesEntries.size === 0 && releaseUsageScopesBoundaryRefresh !== null) {
					releaseUsageScopesBoundaryRefresh?.();
					releaseUsageScopesBoundaryRefresh = null;
				}
			};
		}
		function invalidateRemovedUsageScopes(sessionId) {
			if (typeof sessionId !== "string") return;
			const entry = usageScopesEntries.get(sessionId);
			if (!entry) return;
			entry.releaseFast?.();
			entry.releaseLocal?.();
			entry.releaseFast = null;
			entry.releaseLocal = null;
			usageScopesEntries.delete(sessionId);
			emitUsageScopes(entry);
		}

		const ZONE_MEDIUM_MIN = 400;
		/**
		 * Keep the plugin row after every native dock item. Native slot entries and
		 * the composer's Context Meter sibling use the default flex order (0);
		 * using the smallest positive order moves only this Zone after them, so a
		 * wrapped full-width Zone cannot push native content below itself.
		 */
		const ZONE_DOCK_ORDER = 1;
		function layoutModeForWidth(width) {
			if (!Number.isFinite(width)) return "narrow";
			return width >= ZONE_MEDIUM_MIN ? "medium" : "narrow";
		}
		function computeDetailPosition(trigger, panel, viewport) {
			const margin = 12;
			const gap = 8;
			const width = Math.max(0, Math.min(panel.width, viewport.width - margin * 2));
			const left = Math.max(margin, Math.min(trigger.left + trigger.width / 2 - width / 2, viewport.width - width - margin));
			const panelHeight = Math.max(120, Math.min(panel.height, viewport.height - margin * 2));
			const below = viewport.height - trigger.bottom - gap - margin;
			const above = trigger.top - gap - margin;
			const placeAbove = below < Math.min(panelHeight, 260) && above > below;
			const top = placeAbove
				? Math.max(margin, trigger.top - gap - panelHeight)
				: Math.max(margin, Math.min(trigger.bottom + gap, viewport.height - margin - panelHeight));
			return {
				left,
				top,
				width,
				maxHeight: Math.max(120, placeAbove ? trigger.top - margin - gap : viewport.height - trigger.bottom - margin - gap),
				placement: placeAbove ? "above" : "below"
			};
		}
		function formatCacheHit(value) {
			if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
			return `${Math.floor(Math.min(value, 1) * 10000) / 100}%`;
		}
		const TOKEN_COUNT_FORMAT = new Intl.NumberFormat("en-US", {
			useGrouping: true,
			maximumFractionDigits: 0
		});
		function formatTokenCount(value) {
			return Number.isSafeInteger(value) && value >= 0 ? TOKEN_COUNT_FORMAT.format(value) : "–";
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
			"statsDecimal.costUnknown": "费用未知",
			"statsDecimal.dailyCostUnavailable": "–",
			"statsDecimal.periodWeekdayPeak": "工作日 · 高峰时段",
			"statsDecimal.periodWeekdayOffPeak": "工作日 · 空闲时段",
			"statsDecimal.periodWeekendOffPeak": "周末 · 空闲时段",
			"statsDecimal.periodHolidayOffPeak": "{name} · 空闲时段",
			"statsDecimal.zone.open": "打开用量与费用详情",
			"statsDecimal.zone.ariaSummary": "用量与费用。{summary}。打开详情。",
			"statsDecimal.compact.session": "会话",
			"statsDecimal.compact.tree": "多智能体",
			"statsDecimal.compact.subagents": "子智能体",
			"statsDecimal.compact.local": "本地今日",
			"statsDecimal.compact.balance": "余额",
			"statsDecimal.compact.separator": " / ",
			"statsDecimal.compact.partial": "部分",
			"statsDecimal.compact.notUsed": "未使用",
			"statsDecimal.compact.unknown": "未知",
			"statsDecimal.compact.unavailable": "不可用",
			"statsDecimal.compact.loading": "…",
			"statsDecimal.compact.disabled": "已禁用",
			"statsDecimal.compact.aria.pair": "累计 {cumulative}，今日 {today}",
			"statsDecimal.compact.aria.local": "今日 {today}",
			"statsDecimal.compact.aria.balance": "{balance}",
			"statsDecimal.scope.currentSession": "当前会话",
			"statsDecimal.scope.tree": "多智能体树",
			"statsDecimal.scope.subagents": "子智能体",
			"statsDecimal.scope.local": "本地今日",
			"statsDecimal.scope.balance": "余额",
			"statsDecimal.label.cumulative": "累计",
			"statsDecimal.label.today": "今日",
			"statsDecimal.label.direct": "协调器直接用量",
			"statsDecimal.label.subagents": "子智能体合计",
			"statsDecimal.status.ready": "正常",
			"statsDecimal.status.partial": "部分",
			"statsDecimal.status.unknown": "未知",
			"statsDecimal.status.unavailable": "不可用",
			"statsDecimal.status.loading": "加载中…",
			"statsDecimal.valueSeparator": " · ",
			"statsDecimal.detail.title": "用量与费用 — 用量估算",
			"statsDecimal.detail.close": "关闭",
			"statsDecimal.detail.tokens": "Token",
			"statsDecimal.detail.cacheHit": "缓存命中",
			"statsDecimal.detail.status": "状态",
			"statsDecimal.detail.coverage": "今日观测到的会话",
			"statsDecimal.detail.noDescendants": "当前会话未使用子智能体。",
			"statsDecimal.detail.subagentsMembershipUnknown": "子智能体成员信息不可用。",
			"statsDecimal.detail.treeTotal": "多智能体树合计 {total} = 当前会话 {session} + 子智能体 {subagents}",
			"statsDecimal.detail.diagnostics": "统计诊断",
			"statsDecimal.detail.pricingUnknown": "部分用量缺少价格配置，费用保持未知。",
			"statsDecimal.detail.usageIncomplete": "部分用量数据不完整，统计保持未知。",
			"statsDecimal.detail.updated": "更新于 {time}",
			"statsDecimal.detail.balanceSource": "来源：{source}",
			"statsDecimal.detail.context": "{date} · {timeZone}",
			"statsDecimal.detail.period": "定价时段：{period}",
			"statsDecimal.detail.transportError": "账务数据暂时无法刷新；显示不可用状态，不显示虚构金额。",
			"statsDecimal.detail.disclaimer": "基于本地 DSH 会话日志估算。提供商/平台账单为准。可能未包含非 Token 或提供商侧费用。",
			"statsDecimal.token.uncachedInput": "未缓存输入",
			"statsDecimal.token.cacheRead": "缓存读取",
			"statsDecimal.token.cacheWrite": "缓存写入",
			"statsDecimal.token.output": "输出",
			"statsDecimal.token.reasoning": "推理",
			"statsDecimal.token.in": "输入",
			"statsDecimal.token.cache": "缓存",
			"statsDecimal.token.write": "写入",
			"statsDecimal.token.out": "输出",
			"statsDecimal.token.reason": "推理",
			"statsDecimal.token.reasoningSubset": "（输出的一部分）",
			"statsDecimal.token.reasoningSubset": "（输出的一部分）",
			"statsDecimal.diagnostic.external": "外部用量未计入",
			"statsDecimal.diagnostic.unreadable": "不可读用量未计入",
			"statsDecimal.diagnostic.unsupported": "不支持的子分支",
			"statsDecimal.diagnostic.corrupt": "损坏的子分支",
			"statsDecimal.diagnostic.duplicate": "重复子分支",
			"statsDecimal.diagnostic.malformed": "异常成员数据",
			"statsDecimal.diagnostic.membershipUnavailable": "成员信息不可用"
		};
		const en = {
			"statsDecimal.costUnknown": "Cost unknown",
			"statsDecimal.dailyCostUnavailable": "–",
			"statsDecimal.periodWeekdayPeak": "Weekday · PEAK",
			"statsDecimal.periodWeekdayOffPeak": "Weekday · OFF-PEAK",
			"statsDecimal.periodWeekendOffPeak": "Weekend · OFF-PEAK",
			"statsDecimal.periodHolidayOffPeak": "{nameEn} · OFF-PEAK",
			"statsDecimal.zone.open": "Open usage and billing details",
			"statsDecimal.zone.ariaSummary": "Usage & Billing. {summary}. Open details.",
			"statsDecimal.compact.session": "Session",
			"statsDecimal.compact.tree": "Multi-Agent",
			"statsDecimal.compact.subagents": "Subagents",
			"statsDecimal.compact.local": "Local Today",
			"statsDecimal.compact.balance": "Balance",
			"statsDecimal.compact.separator": " / ",
			"statsDecimal.compact.partial": "Partial",
			"statsDecimal.compact.notUsed": "Not used",
			"statsDecimal.compact.unknown": "Unknown",
			"statsDecimal.compact.unavailable": "Unavailable",
			"statsDecimal.compact.loading": "…",
			"statsDecimal.compact.disabled": "Disabled",
			"statsDecimal.compact.aria.pair": "Cumulative {cumulative}, Today {today}",
			"statsDecimal.compact.aria.local": "Today {today}",
			"statsDecimal.compact.aria.balance": "{balance}",
			"statsDecimal.scope.currentSession": "Current Session",
			"statsDecimal.scope.tree": "Multi-Agent Tree",
			"statsDecimal.scope.subagents": "Subagents",
			"statsDecimal.scope.local": "Local Today",
			"statsDecimal.scope.balance": "Balance",
			"statsDecimal.label.cumulative": "Cumulative",
			"statsDecimal.label.today": "Today",
			"statsDecimal.label.direct": "Coordinator Direct",
			"statsDecimal.label.subagents": "Subagents Aggregate",
			"statsDecimal.status.ready": "Ready",
			"statsDecimal.status.partial": "Partial",
			"statsDecimal.status.unknown": "Unknown",
			"statsDecimal.status.unavailable": "Unavailable",
			"statsDecimal.status.loading": "Loading…",
			"statsDecimal.valueSeparator": " · ",
			"statsDecimal.detail.title": "Usage & Billing — Estimated usage",
			"statsDecimal.detail.close": "Close",
			"statsDecimal.detail.tokens": "Tokens",
			"statsDecimal.detail.cacheHit": "Cache hit",
			"statsDecimal.detail.status": "Status",
			"statsDecimal.detail.coverage": "Sessions observed today",
			"statsDecimal.detail.noDescendants": "This Session did not use subagents.",
			"statsDecimal.detail.subagentsMembershipUnknown": "Subagent membership is unavailable.",
			"statsDecimal.detail.treeTotal": "Multi-Agent tree total {total} = current Session {session} + Subagents {subagents}",
			"statsDecimal.detail.diagnostics": "Accounting diagnostics",
			"statsDecimal.detail.pricingUnknown": "Some usage has no configured price; cost remains unknown.",
			"statsDecimal.detail.usageIncomplete": "Some usage is incomplete; accounting remains unknown.",
			"statsDecimal.detail.updated": "Updated {time}",
			"statsDecimal.detail.balanceSource": "Source: {source}",
			"statsDecimal.detail.context": "{date} · {timeZone}",
			"statsDecimal.detail.period": "Pricing period: {period}",
			"statsDecimal.detail.transportError": "Accounting data could not be refreshed; an unavailable state is shown instead of fabricated amounts.",
			"statsDecimal.detail.disclaimer": "Estimated from local DSH Session logs. Provider/platform billing remains authoritative. Non-token/provider-side fees may not be represented.",
			"statsDecimal.token.uncachedInput": "Uncached input",
			"statsDecimal.token.cacheRead": "Cache read",
			"statsDecimal.token.cacheWrite": "Cache write",
			"statsDecimal.token.output": "Output",
			"statsDecimal.token.reasoning": "Reasoning",
			"statsDecimal.token.in": "In",
			"statsDecimal.token.cache": "Cache",
			"statsDecimal.token.write": "Write",
			"statsDecimal.token.out": "Out",
			"statsDecimal.token.reason": "Reasoning",
			"statsDecimal.token.reasoningSubset": "(subset of output)",
			"statsDecimal.diagnostic.external": "external usage excluded",
			"statsDecimal.diagnostic.unreadable": "unreadable usage excluded",
			"statsDecimal.diagnostic.unsupported": "unsupported branch",
			"statsDecimal.diagnostic.corrupt": "corrupt branch",
			"statsDecimal.diagnostic.duplicate": "duplicate branch",
			"statsDecimal.diagnostic.malformed": "malformed membership data",
			"statsDecimal.diagnostic.membershipUnavailable": "membership unavailable"
		};

		const ZONE_CSS = `
[data-stats-decimal-zone]{box-sizing:border-box;flex:1 1 100%;order:${ZONE_DOCK_ORDER};min-width:0;width:100%;color:var(--dsw-alias-label-secondary);font-size:var(--dsh-content-font-size-secondary,12px);line-height:18px;text-align:left}
[data-stats-decimal-zone] .dsh-sd-responsive{container-type:inline-size;display:block;width:100%;min-width:0}
[data-stats-decimal-zone] .dsh-sd-inset{padding:0 calc(var(--dsh-composer-side-clearance) + 16px);min-width:0}
[data-composer-dock]:has([data-stats-decimal-zone]){flex-wrap:wrap;row-gap:4px}
[data-stats-decimal-zone] .dsh-sd-trigger{display:block;box-sizing:border-box;width:100%;min-width:0;margin:0;padding:0;border:0;background:none;color:inherit;font:inherit;text-align:inherit;cursor:pointer;border-radius:8px}
[data-stats-decimal-zone] .dsh-sd-trigger:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
[data-stats-decimal-zone] .dsh-sd-pills{display:grid;grid-template-columns:minmax(0,1fr);gap:4px 10px;min-width:0}
[data-stats-decimal-zone] .dsh-sd-pill{box-sizing:border-box;display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:baseline;gap:5px;min-width:0;min-height:21px;padding:1px 8px;border:.5px solid var(--dsw-alias-border-l1);border-radius:6px;background:transparent;line-height:18px;white-space:normal}
[data-stats-decimal-zone] .dsh-sd-pill-label{color:var(--dsw-alias-label-secondary);font-size:11px;white-space:normal;overflow-wrap:anywhere;min-width:0;justify-self:start;text-align:left}
[data-stats-decimal-zone] .dsh-sd-pill-value-group{display:flex;align-items:baseline;justify-content:flex-end;gap:4px;min-width:0;justify-self:end}
[data-stats-decimal-zone] .dsh-sd-pill-value{color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;min-width:0;white-space:normal;overflow-wrap:anywhere;text-align:right}
[data-stats-decimal-zone] .dsh-sd-partial{color:var(--dsw-alias-state-warn-primary);font-size:10px;flex:none;white-space:nowrap}
[data-stats-decimal-zone] .dsh-sd-pill-period{display:flex;align-items:center;background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);font-weight:600}
[data-stats-decimal-zone] .dsh-sd-pill-period::before{content:"";flex:none;width:5px;height:5px;border-radius:50%;background:var(--dsw-alias-brand-primary)}
[data-stats-decimal-zone] .dsh-sd-band-value{flex:0 1 auto;color:var(--dsw-alias-label-primary)}
[data-stats-decimal-zone] .dsh-sd-band-row{display:flex;align-items:center;justify-content:center;padding:0 2px 3px;min-width:0}
[data-stats-decimal-zone] .dsh-sd-band-row .dsh-sd-pill-period{flex:0 1 auto}
.dsh-sd-detail{position:fixed;width:min(600px,calc(100vw - 24px));max-height:min(82vh,760px);z-index:10000;box-sizing:border-box;display:flex;flex-direction:column;gap:6px;padding:10px 12px;overflow-y:auto;overscroll-behavior:contain;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.18);color:var(--dsw-alias-label-primary);font-size:12px;line-height:1.5;text-align:left;pointer-events:auto;container-type:inline-size}
.dsh-sd-detail:focus{outline:none}
.dsh-sd-detail-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;min-width:0}
.dsh-sd-detail-title{font-weight:600;white-space:normal;overflow-wrap:anywhere}
.dsh-sd-close{padding:2px 6px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;cursor:pointer;white-space:normal}
.dsh-sd-detail-meta{display:flex;flex-wrap:wrap;gap:2px 12px;color:var(--dsw-alias-label-secondary);font-size:11px;min-width:0}
.dsh-sd-meta-item{white-space:normal;overflow-wrap:anywhere}
.dsh-sd-detail-grid{display:grid;grid-template-columns:minmax(0,1fr);gap:7px 20px;min-width:0;margin-top:2px}
.dsh-sd-detail-card{box-sizing:border-box;min-width:0;padding-top:4px;border-top:1px solid var(--dsw-alias-border-l1)}
.dsh-sd-detail-card-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;min-width:0}
.dsh-sd-detail-card-title{font-weight:600;color:var(--dsw-alias-label-primary);white-space:normal;overflow-wrap:anywhere}
.dsh-sd-detail-status{font-size:11px;color:var(--dsw-alias-label-secondary);white-space:normal;overflow-wrap:anywhere}
.dsh-sd-detail-card[data-status="partial"] .dsh-sd-detail-status,.dsh-sd-detail-card[data-status="unknown"] .dsh-sd-detail-status{color:var(--dsw-alias-state-warn-primary)}
.dsh-sd-detail-card[data-status="unavailable"] .dsh-sd-detail-status{color:var(--dsw-alias-state-error-primary)}
.dsh-sd-detail-rows{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:1px 8px;min-width:0}
.dsh-sd-detail-row{display:contents}
.dsh-sd-detail-label{color:var(--dsw-alias-label-secondary);white-space:normal;overflow-wrap:anywhere;min-width:0;justify-self:start}
.dsh-sd-detail-value{font-variant-numeric:tabular-nums;text-align:right;justify-self:end;white-space:normal;overflow-wrap:anywhere;min-width:0}
.dsh-sd-token-block{display:grid;gap:2px;min-width:0;margin-top:5px;padding-top:4px;border-top:1px dashed var(--dsw-alias-border-l1)}
.dsh-sd-token-title{font-size:11px;color:var(--dsw-alias-label-secondary);white-space:normal}
.dsh-sd-token-list{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:1px 8px;min-width:0}
.dsh-sd-token-item{display:contents}
.dsh-sd-token-label{color:var(--dsw-alias-label-secondary);white-space:normal;overflow-wrap:anywhere;min-width:0;justify-self:start}
.dsh-sd-token-value{font-variant-numeric:tabular-nums;text-align:right;justify-self:end;white-space:normal;overflow-wrap:anywhere;min-width:0}
.dsh-sd-note{color:var(--dsw-alias-label-secondary);white-space:normal;overflow-wrap:anywhere}
.dsh-sd-tree-total{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.45;padding-top:3px;white-space:normal;overflow-wrap:anywhere}
.dsh-sd-detail-footer{font-size:11px;padding-top:4px;border-top:1px solid var(--dsw-alias-border-l1)}
@container (min-width:520px){.dsh-sd-detail-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@container (min-width:${ZONE_MEDIUM_MIN}px){[data-stats-decimal-zone] .dsh-sd-pills{grid-template-columns:repeat(2,minmax(0,1fr))}}
`;
		let detailSequence = 0;
		function zoneStatusText(status, t) {
			if (status === "loading") return t("statsDecimal.status.loading");
			if (status === "partial") return t("statsDecimal.status.partial");
			if (status === "unknown") return t("statsDecimal.status.unknown");
			if (status === "unavailable") return t("statsDecimal.status.unavailable");
			if (status === "disabled") return t("statsDecimal.compact.disabled");
			return t("statsDecimal.status.ready");
		}
		function zoneAmountText(status, money, currencies, t) {
			if (status === "loading") return t("statsDecimal.status.loading");
			if (status === "unavailable") return t("statsDecimal.status.unavailable");
			if (status === "unknown") return t("statsDecimal.costUnknown");
			if (money === null || money === void 0) return t("statsDecimal.dailyCostUnavailable");
			const separator = t("statsDecimal.valueSeparator");
			const values = [];
			for (const iso of currencies) {
				if (iso !== "CNY" && iso !== "USD") continue;
				const value = money[iso];
				values.push(Number.isFinite(value) ? formatAmount(value, iso, AMOUNT_DECIMALS) : t("statsDecimal.dailyCostUnavailable"));
			}
			return values.length > 0 ? values.join(separator) : t("statsDecimal.dailyCostUnavailable");
		}
		/**
		 * One compact value for the first enabled/displayed currency. The caller
		 * supplies the currency order; no currency is preferred here.
		 */
		function compactSingleText(status, money, currency, t) {
			if (status === "loading") return t("statsDecimal.compact.loading");
			if (status === "unavailable") return t("statsDecimal.compact.unavailable");
			if (status === "unknown") return t("statsDecimal.compact.unknown");
			if (status === "disabled") return t("statsDecimal.compact.disabled");
			if (typeof currency !== "string" || money === null || money === void 0) {
				return t("statsDecimal.compact.unavailable");
			}
			const value = money[currency];
			if (!Number.isFinite(value)) return t("statsDecimal.compact.unavailable");
			return formatAmount(value, currency, AMOUNT_DECIMALS);
		}
		function compactPairText(status, cumulative, today, currency, t) {
			if (status === "loading" || status === "unavailable" || status === "unknown") {
				return compactSingleText(status, cumulative, currency, t);
			}
			if (typeof currency !== "string") return t("statsDecimal.compact.unavailable");
			return `${compactSingleText(status, cumulative, currency, t)}${t("statsDecimal.compact.separator")}${compactSingleText(status, today, currency, t)}`;
		}
		function compactAriaLabel(kind, status, cumulative, today, currency, t) {
			const label = t(`statsDecimal.compact.${kind}`);
			const partial = status === "partial" ? ` (${t("statsDecimal.compact.partial")})` : "";
			if (kind === "local") {
				return `${label}: ${t("statsDecimal.compact.aria.local", { today: compactSingleText(status, today, currency, t) })}${partial}`;
			}
			if (kind === "balance") {
				return `${label}: ${compactSingleText(status, cumulative, currency, t)}${partial}`;
			}
			return `${label}: ${t("statsDecimal.compact.aria.pair", {
				cumulative: compactSingleText(status, cumulative, currency, t),
				today: compactSingleText(status, today, currency, t)
			})}${partial}`;
		}
		function cacheHitFromTokens(tokens) {
			if (tokens === null || tokens === void 0) return null;
			const denominator = tokens.uncachedInput + tokens.cacheRead + tokens.cacheWrite;
			if (!Number.isFinite(denominator) || denominator <= 0) return null;
			return tokens.cacheRead / denominator;
		}
		function firstAvailableBalanceCurrency(currencies, balances) {
			for (const iso of currencies) {
				if (iso !== "CNY" && iso !== "USD") continue;
				const value = balances?.[iso];
				if (typeof value === "number" && Number.isFinite(value) && value >= 0) return iso;
			}
			return null;
		}
		function balanceDisplayStatus(balanceEnabled, loading, visibleBalance, currencies) {
			if (!balanceEnabled) return "disabled";
			if (loading) return "loading";
			if (visibleBalance === null || visibleBalance === void 0) return "unavailable";
			return firstAvailableBalanceCurrency(currencies, visibleBalance.balances) === null ? "unavailable" : "ready";
		}
		function compactSubagentsText(treeScope, status, currency, t) {
			if (treeScope?.hasDescendants === false) return t("statsDecimal.compact.notUsed");
			if (treeScope?.hasDescendants === null && status === "ready") return t("statsDecimal.compact.unknown");
			const subagents = treeScope?.subagentsAggregate ?? null;
			return compactPairText(status, subagents?.cumulative ?? null, subagents?.today ?? null, currency, t);
		}
		function compactSubagentsAriaLabel(treeScope, status, currency, t) {
			if (treeScope?.hasDescendants === false) {
				return `${t("statsDecimal.compact.subagents")}: ${t("statsDecimal.compact.notUsed")}`;
			}
			if (treeScope?.hasDescendants === null && status === "ready") {
				return `${t("statsDecimal.compact.subagents")}: ${t("statsDecimal.compact.unknown")}`;
			}
			const subagents = treeScope?.subagentsAggregate ?? null;
			return compactAriaLabel("subagents", status, subagents?.cumulative ?? null, subagents?.today ?? null, currency, t);
		}
		function zoneTokenRows(tokens, reasoningReported, t) {
			if (tokens === null || tokens === void 0) return [];
			const reasoning = reasoningReported === true && Number.isSafeInteger(tokens.reasoning)
				? formatTokenCount(tokens.reasoning)
				: "—";
			return [
				["statsDecimal.token.in", formatTokenCount(tokens.uncachedInput)],
				["statsDecimal.token.cacheRead", formatTokenCount(tokens.cacheRead)],
				["statsDecimal.token.cacheWrite", formatTokenCount(tokens.cacheWrite)],
				["statsDecimal.token.output", formatTokenCount(tokens.output)],
				["statsDecimal.token.reason", reasoning, t("statsDecimal.token.reasoningSubset")]
			];
		}
		function zoneDiagnosticsText(diagnostics, t) {
			if (diagnostics === null || diagnostics === void 0) return null;
			const labels = [];
			if (diagnostics.external) labels.push(t("statsDecimal.diagnostic.external"));
			if (diagnostics.unreadable) labels.push(t("statsDecimal.diagnostic.unreadable"));
			if (diagnostics.unsupported) labels.push(t("statsDecimal.diagnostic.unsupported"));
			if (diagnostics.corrupt) labels.push(t("statsDecimal.diagnostic.corrupt"));
			if (diagnostics.duplicate) labels.push(t("statsDecimal.diagnostic.duplicate"));
			if (diagnostics.malformed) labels.push(t("statsDecimal.diagnostic.malformed"));
			if (diagnostics.membershipUnavailable) labels.push(t("statsDecimal.diagnostic.membershipUnavailable"));
			return labels.length > 0 ? labels.join(t("statsDecimal.valueSeparator")) : null;
		}
		function zoneUpdatedText(generatedAt, t) {
			if (!Number.isFinite(generatedAt)) return null;
			try {
				return t("statsDecimal.detail.updated", { time: new Date(generatedAt).toLocaleString() });
			} catch {
				return null;
			}
		}
		function BillingStatus({ useProjection, t, sessionId }) {
			const ledgerVal = useProjection("billingLedger");
			const modelSelectionVal = useProjection("modelSelection");
			const enabled = ledgerVal !== null && ledgerVal !== void 0 && ledgerVal.enabled === true;
			const balanceEnabled = ledgerVal !== null && ledgerVal !== void 0 && ledgerVal.balanceEnabled === true;
			const selectedProvider = selectedProviderFromProjection(modelSelectionVal);
			const [balanceVal, setBalanceVal] = react.useState(null);
			react.useEffect(() => {
				if (!enabled || !balanceEnabled) {
					setBalanceVal(null);
					return undefined;
				}
				return subscribeBalance(sessionId, selectedProvider, setBalanceVal);
			}, [enabled, balanceEnabled, sessionId, selectedProvider]);

			const [usageSnapshot, setUsageSnapshot] = react.useState(() => ({
				...usageScopesSnapshot(sessionId),
				sessionId
			}));
			react.useEffect(() => {
				if (!enabled) return undefined;
				return subscribeUsageScopes(sessionId, (snapshot) => setUsageSnapshot({ ...snapshot, sessionId }));
			}, [enabled, sessionId]);
			const usageSnapshotMatchesSession = usageSnapshot?.sessionId === sessionId;
			const fastValue = usageSnapshotMatchesSession ? (usageSnapshot.fastValue ?? null) : null;
			const localValue = usageSnapshotMatchesSession ? (usageSnapshot.localValue ?? null) : null;
			const fastLoading = usageSnapshotMatchesSession
				? fastValue === null && usageSnapshot.fastError === null
				: true;
			const localLoading = usageSnapshotMatchesSession
				? localValue === null && usageSnapshot.localError === null
				: true;

			const [now, setNow] = react.useState(() => Date.now());
			react.useEffect(() => {
				if (!enabled) return undefined;
				return registerRefreshTask("period-label", () => setNow(Date.now()), {
					initialRunAt: nextBeijingHourBoundary(Date.now()),
					nextRunAtAfterRun: nextBeijingHourBoundary
				});
			}, [enabled]);

			const ledgerKey = `${ledgerVal?.cumulative?.CNY}:${ledgerVal?.cumulative?.USD}:${ledgerVal?.pricingKnown}`;
			const lastLedgerKey = react.useRef(null);
			react.useEffect(() => {
				if (!enabled) {
					lastLedgerKey.current = null;
					return;
				}
				const previous = lastLedgerKey.current;
				lastLedgerKey.current = ledgerKey;
				if (previous !== null && previous !== ledgerKey && typeof sessionId === "string") {
					requestRefreshTask(usageScopesRefreshKey(sessionId), { delayMs: 2000 });
				}
			}, [enabled, sessionId, ledgerKey]);
			const timeZoneKey = currentTimeZone();
			const lastTimeZone = react.useRef(timeZoneKey);
			react.useEffect(() => {
				if (!enabled) return;
				if (lastTimeZone.current === timeZoneKey) return;
				lastTimeZone.current = timeZoneKey;
				if (typeof sessionId === "string") requestRefreshTask(usageScopesRefreshKey(sessionId));
			}, [enabled, sessionId, timeZoneKey]);
			react.useEffect(() => {
				if (!enabled) return undefined;
				return registerRefreshTask("stats-decimal-local-day", () => setNow(Date.now()), {
					initialRunAt: nextLocalDayBoundary(Date.now()),
					nextRunAtAfterRun: nextLocalDayBoundary
				});
			}, [enabled]);

			const [detailOpen, setDetailOpen] = react.useState(false);
			const [detailReady, setDetailReady] = react.useState(false);
			const [detailPosition, setDetailPosition] = react.useState(null);
			const triggerRef = react.useRef(null);
			const panelRef = react.useRef(null);
			const detailIdRef = react.useRef(`stats-decimal-detail-${++detailSequence}`);
			const detailId = detailIdRef.current;
			const closeDetail = () => {
				setDetailOpen(false);
				setDetailReady(false);
				setDetailPosition(null);
				triggerRef.current?.focus?.();
			};
			const openDetail = () => {
				setDetailPosition(null);
				setDetailReady(false);
				setDetailOpen(true);
			};
			react.useEffect(() => {
				setDetailOpen(false);
				setDetailReady(false);
				setDetailPosition(null);
			}, [sessionId]);
			react.useEffect(() => {
				if (!detailOpen) return undefined;
				const onKeyDown = (event) => {
					if (event.key === "Escape") {
						event.preventDefault();
						closeDetail();
					}
				};
				const onPointerDown = (event) => {
					const target = event.target;
					if (panelRef.current?.contains?.(target) || triggerRef.current?.contains?.(target)) return;
					closeDetail();
				};
				document.addEventListener("keydown", onKeyDown);
				document.addEventListener("pointerdown", onPointerDown, true);
				return () => {
					document.removeEventListener("keydown", onKeyDown);
					document.removeEventListener("pointerdown", onPointerDown, true);
				};
			}, [detailOpen]);
			react.useEffect(() => {
				if (detailOpen && detailReady) panelRef.current?.focus?.();
			}, [detailOpen, detailReady]);
			react.useLayoutEffect(() => {
				if (!detailOpen || typeof window === "undefined") return undefined;
				let frame = null;
				const measure = () => {
					const trigger = triggerRef.current;
					const panel = panelRef.current;
					if (!trigger || !panel) return false;
					const triggerRect = trigger.getBoundingClientRect();
					const panelRect = panel.getBoundingClientRect();
					if (panelRect.width < 2 || panelRect.height < 2) return false;
					setDetailPosition(computeDetailPosition(triggerRect, panelRect, {
						width: window.innerWidth,
						height: window.innerHeight
					}));
					return true;
				};
				const update = () => {
					if (measure()) setDetailReady(true);
				};
				measure();
				if (typeof window.requestAnimationFrame === "function") {
					frame = window.requestAnimationFrame(() => {
						frame = null;
						if (measure()) setDetailReady(true);
					});
				} else {
					setDetailReady(true);
				}
				window.addEventListener("resize", update);
				window.addEventListener("scroll", update, true);
				return () => {
					if (frame !== null && typeof window.cancelAnimationFrame === "function") window.cancelAnimationFrame(frame);
					window.removeEventListener("resize", update);
					window.removeEventListener("scroll", update, true);
				};
			}, [detailOpen, fastValue, localValue, balanceVal]);

			if (!enabled) return null;

			const currencies = Array.isArray(ledgerVal.currencies) ? ledgerVal.currencies : [];
			const entry = typeof sessionId === "string" ? balanceEntries.get(sessionId) : null;
			const balanceMatchesSelection = balanceVal?.sessionId === sessionId
				&& (selectedProvider === null || balanceVal.provider === selectedProvider)
				&& (balanceVal.provider !== "deepseek-official" || Number.isSafeInteger(balanceVal.balanceGeneration))
				&& balanceVal.generation === entry?.generation
				&& balanceVal.loading !== true
				&& Date.now() - balanceVal.fetchedAt <= BALANCE_STALE_TTL_MS;
			const visibleBalance = balanceEnabled && balanceMatchesSelection ? balanceVal : null;
			const balanceLoading = balanceEnabled && (balanceVal === null || balanceVal?.loading === true);
			const sessionScope = fastValue?.session ?? null;
			const treeScope = fastValue?.tree ?? null;
			const localScope = localValue?.local ?? null;
			const sessionStatus = fastLoading ? "loading" : (sessionScope?.status ?? "unavailable");
			const treeStatus = fastLoading ? "loading" : (treeScope?.status ?? "unavailable");
			const localStatus = localLoading ? "loading" : (localScope?.status ?? "unavailable");
			const date = fastValue?.date ?? localValue?.date ?? dateKeyInTimeZone(now);
			const timeZone = fastValue?.timeZone ?? localValue?.timeZone ?? currentTimeZone();
			const periodStatus = currentPeriodStatus(now, ledgerVal.peakHours, ledgerVal.publicHolidaySpans);
			const periodKey = periodStatus.dayType === "holiday"
				? "statsDecimal.periodHolidayOffPeak"
				: periodStatus.dayType === "weekend"
					? "statsDecimal.periodWeekendOffPeak"
					: periodStatus.band === "peak"
						? "statsDecimal.periodWeekdayPeak"
						: "statsDecimal.periodWeekdayOffPeak";
			const period = t(periodKey, { name: periodStatus.name, nameEn: periodStatus.nameEn });
			const h = react.createElement;
			const moneyText = (status, money) => zoneAmountText(status, money, currencies, t);
			const compactCurrency = currencies.find((iso) => iso === "CNY" || iso === "USD") ?? null;
			const balanceStatus = balanceDisplayStatus(balanceEnabled, balanceLoading, visibleBalance, currencies);
			const balanceDisplayCurrency = balanceStatus === "ready"
				? firstAvailableBalanceCurrency(currencies, visibleBalance?.balances)
				: compactCurrency;
			const sessionCompact = compactPairText(
				sessionStatus,
				sessionScope?.cumulative ?? null,
				sessionScope?.today ?? null,
				compactCurrency,
				t
			);
			const subagentsCompact = compactSubagentsText(treeScope, treeStatus, compactCurrency, t);
			const localCompact = compactSingleText(localStatus, localScope?.today ?? null, compactCurrency, t);
			const balanceCompact = compactSingleText(balanceStatus, visibleBalance?.balances ?? null, balanceDisplayCurrency, t);
			const sessionAria = compactAriaLabel("session", sessionStatus, sessionScope?.cumulative ?? null, sessionScope?.today ?? null, compactCurrency, t);
			const subagentsAria = compactSubagentsAriaLabel(treeScope, treeStatus, compactCurrency, t);
			const localAria = compactAriaLabel("local", localStatus, null, localScope?.today ?? null, compactCurrency, t);
			const balanceAria = compactAriaLabel("balance", balanceStatus, visibleBalance?.balances ?? null, null, balanceDisplayCurrency, t);
			const compactPill = (key, label, value, status, accessibleTitle) => h("span", {
				className: "dsh-sd-pill",
				key,
				"data-scope": key,
				"data-status": status,
				title: accessibleTitle
			},
				h("span", { className: "dsh-sd-pill-label" }, label),
				h("span", { className: "dsh-sd-pill-value-group" },
					h("span", { className: "dsh-sd-pill-value" }, value),
					status === "partial" ? h("span", { className: "dsh-sd-partial" }, t("statsDecimal.compact.partial")) : null));
			const pricingPill = h("span", {
				className: "dsh-sd-pill dsh-sd-pill-period",
				key: "period",
				"data-scope": "period",
				"data-status": "ready",
				title: t("statsDecimal.detail.period", { period }),
				"aria-label": t("statsDecimal.detail.period", { period })
			}, h("span", { className: "dsh-sd-pill-value dsh-sd-band-value" }, period));
			const compactPills = [
				compactPill("session", t("statsDecimal.compact.session"), sessionCompact, sessionStatus, sessionAria),
				compactPill("subagents", t("statsDecimal.compact.subagents"), subagentsCompact, treeStatus, subagentsAria),
				compactPill("local", t("statsDecimal.compact.local"), localCompact, localStatus, localAria),
				compactPill("balance", t("statsDecimal.compact.balance"), balanceCompact, balanceStatus, balanceAria)
			];
			const compactSummary = [period, sessionAria, subagentsAria, localAria, balanceAria].join(t("statsDecimal.valueSeparator"));
			const zone = h("div", {
				ref: triggerRef,
				className: "dsh-sd-trigger",
				"data-stats-decimal-zone": "",
				role: "button",
				tabIndex: 0,
				"aria-haspopup": "dialog",
				"aria-expanded": detailOpen,
				"aria-controls": detailId,
				"aria-label": t("statsDecimal.zone.ariaSummary", { summary: compactSummary }),
				title: t("statsDecimal.zone.open"),
				onClick: () => {
					if (detailOpen) closeDetail();
					else openDetail();
				},
				onKeyDown: (event) => {
					if (event.key === "Enter" || event.key === " ") {
						event.preventDefault();
						if (detailOpen) closeDetail();
						else openDetail();
					}
				}
			},
				h("div", { className: "dsh-sd-responsive" },
					h("div", { className: "dsh-sd-inset" },
						h("div", { className: "dsh-sd-band-row" }, pricingPill),
						h("div", { className: "dsh-sd-pills" }, compactPills))));

			const detailRows = (rows) => rows.map(([label, value], index) => h("div", { className: "dsh-sd-detail-row", key: index },
				h("span", { className: "dsh-sd-detail-label" }, label),
				h("span", { className: "dsh-sd-detail-value" }, value)));
			const tokenGrid = (tokens, reasoningReported) => {
				const rows = zoneTokenRows(tokens, reasoningReported, t);
				if (rows.length === 0) return null;
				return h("div", { className: "dsh-sd-token-block" },
					h("div", { className: "dsh-sd-token-title" }, t("statsDecimal.detail.tokens")),
					h("div", { className: "dsh-sd-token-list" }, rows.map(([label, value, title], index) => h("div", { className: "dsh-sd-token-item", key: index, title },
						h("span", { className: "dsh-sd-token-label" }, t(label)),
						h("span", { className: "dsh-sd-token-value" }, value)))));
			};
			const detailCard = (key, title, status, rows, note, tokens, reasoningReported = null) => h("section", {
				className: "dsh-sd-detail-card",
				key,
				"data-scope": key,
				"data-status": status,
				title: `${title}: ${zoneStatusText(status, t)}`
			},
				h("div", { className: "dsh-sd-detail-card-head" },
					h("span", { className: "dsh-sd-detail-card-title" }, title),
					status === "ready" ? null : h("span", { className: "dsh-sd-detail-status" }, zoneStatusText(status, t))),
				rows.length > 0 ? h("div", { className: "dsh-sd-detail-rows" }, detailRows(rows)) : null,
				tokenGrid(tokens, reasoningReported),
				note === null ? null : h("div", { className: "dsh-sd-note" }, note));
			const sessionDetailRows = [
				[t("statsDecimal.label.cumulative"), moneyText(sessionStatus, sessionScope?.cumulative ?? null)],
				[t("statsDecimal.label.today"), moneyText(sessionStatus, sessionScope?.today ?? null)],
				[t("statsDecimal.detail.cacheHit"), sessionScope?.cacheHit !== null && sessionScope?.cacheHit !== void 0 ? formatCacheHit(sessionScope.cacheHit) ?? "–" : "–"],
				...(sessionStatus === "ready" ? [] : [[t("statsDecimal.detail.status"), zoneStatusText(sessionStatus, t)]])
			];
			const subagentsScope = treeScope?.subagentsAggregate ?? null;
			const subagentsCacheHit = cacheHitFromTokens(subagentsScope?.tokens);
			const subagentsDetailRows = [
				[t("statsDecimal.label.cumulative"), moneyText(treeStatus, subagentsScope?.cumulative ?? null)],
				[t("statsDecimal.label.today"), moneyText(treeStatus, subagentsScope?.today ?? null)],
				[t("statsDecimal.detail.cacheHit"), subagentsCacheHit !== null ? formatCacheHit(subagentsCacheHit) ?? "–" : "–"],
				...(treeStatus === "ready" ? [] : [[t("statsDecimal.detail.status"), zoneStatusText(treeStatus, t)]])
			];
			const localDetailRows = [
				[t("statsDecimal.label.today"), moneyText(localStatus, localScope?.today ?? null)],
				[t("statsDecimal.detail.cacheHit"), localScope?.cacheHit !== null && localScope?.cacheHit !== void 0 ? formatCacheHit(localScope.cacheHit) ?? "–" : "–"],
				...(localStatus === "ready" ? [] : [[t("statsDecimal.detail.status"), zoneStatusText(localStatus, t)]]),
				[t("statsDecimal.detail.coverage"), Number.isSafeInteger(localScope?.sessionCount) ? String(localScope.sessionCount) : "–"]
			];
			const balanceDetailRows = currencies.filter((iso) => iso === "CNY" || iso === "USD").map((iso) => {
				const value = visibleBalance?.balances?.[iso];
				return [iso, balanceEnabled && Number.isFinite(value) ? formatAmount(value, iso, AMOUNT_DECIMALS) : t("statsDecimal.dailyCostUnavailable")];
			});
			const generatedAt = Math.max(
				Number.isFinite(fastValue?.generatedAt) ? fastValue.generatedAt : 0,
				Number.isFinite(localValue?.generatedAt) ? localValue.generatedAt : 0
			) || null;
			const generatedAtText = zoneUpdatedText(generatedAt, t);
			const diagnosticsText = zoneDiagnosticsText(treeScope?.diagnostics, t);
			const treeNotes = [];
			if (diagnosticsText !== null) treeNotes.push(`${t("statsDecimal.detail.diagnostics")}: ${diagnosticsText}`);
			if (treeScope?.pricingKnown === false) treeNotes.push(t("statsDecimal.detail.pricingUnknown"));
			if (treeScope?.usageKnown === false) treeNotes.push(t("statsDecimal.detail.usageIncomplete"));
			const treeNote = treeNotes.length > 0 ? treeNotes.join(t("statsDecimal.valueSeparator")) : null;
			const sessionNotes = [];
			if (sessionScope?.pricingKnown === false) sessionNotes.push(t("statsDecimal.detail.pricingUnknown"));
			if (sessionScope?.usageKnown === false) sessionNotes.push(t("statsDecimal.detail.usageIncomplete"));
			const sessionNote = sessionNotes.length > 0 ? sessionNotes.join(t("statsDecimal.valueSeparator")) : null;
			const localNotes = [];
			if (localScope?.pricingKnown === false) localNotes.push(t("statsDecimal.detail.pricingUnknown"));
			if (localScope?.usageKnown === false) localNotes.push(t("statsDecimal.detail.usageIncomplete"));
			const localNote = localNotes.length > 0 ? localNotes.join(t("statsDecimal.valueSeparator")) : null;
			const treeHasDescendants = treeScope?.hasDescendants;
			const subagentsCard = treeHasDescendants === false
				? detailCard("subagents", t("statsDecimal.scope.subagents"), treeStatus, [], t("statsDecimal.detail.noDescendants"), null)
				: treeHasDescendants === null
					? detailCard("subagents", t("statsDecimal.scope.subagents"), treeStatus, [], t("statsDecimal.detail.subagentsMembershipUnknown"), null)
					: detailCard("subagents", t("statsDecimal.scope.subagents"), treeStatus, subagentsDetailRows, treeNote, subagentsScope?.tokens, subagentsScope?.reasoningReported);
			const treeTotal = treeHasDescendants === true && treeScope !== null && subagentsScope !== null && sessionScope !== null
				? h("div", { className: "dsh-sd-tree-total" }, t("statsDecimal.detail.treeTotal", {
					total: moneyText(treeStatus, treeScope?.cumulative ?? null),
					session: moneyText(sessionStatus, sessionScope?.cumulative ?? null),
					subagents: moneyText(treeStatus, subagentsScope?.cumulative ?? null)
				}))
				: null;
			const metaParts = [generatedAtText, t("statsDecimal.detail.context", { date, timeZone }), t("statsDecimal.detail.period", { period })].filter((value) => value !== null);
			const hasTransportError = usageSnapshotMatchesSession && (usageSnapshot?.fastError !== null && usageSnapshot?.fastError !== void 0
				|| usageSnapshot?.localError !== null && usageSnapshot?.localError !== void 0);
			const detail = detailOpen ? h("div", {
				ref: panelRef,
				id: detailId,
				className: "dsh-sd-detail",
				role: "dialog",
				"aria-modal": "false",
				"aria-labelledby": `${detailId}-detail-title`,
				tabIndex: -1,
				style: detailPosition === null ? { visibility: "hidden" } : {
					top: detailPosition.top,
					left: detailPosition.left,
					width: detailPosition.width,
					maxHeight: detailPosition.maxHeight,
					visibility: detailReady ? "visible" : "hidden"
				}
			},
				h("div", { className: "dsh-sd-detail-head" },
					h("span", { className: "dsh-sd-detail-title", id: `${detailId}-detail-title` }, t("statsDecimal.detail.title")),
					h("button", { type: "button", className: "dsh-sd-close", onClick: closeDetail, "aria-label": t("statsDecimal.detail.close") }, t("statsDecimal.detail.close"))),
				h("div", { className: "dsh-sd-detail-meta" }, metaParts.map((part, index) => h("span", { className: "dsh-sd-meta-item", key: index }, part))),
				hasTransportError ? h("div", { className: "dsh-sd-note" }, t("statsDecimal.detail.transportError")) : null,
				h("div", { className: "dsh-sd-detail-grid" },
					detailCard("session", t("statsDecimal.scope.currentSession"), sessionStatus, sessionDetailRows, sessionNote, sessionScope?.tokens, sessionScope?.reasoningReported),
					subagentsCard,
					detailCard("local", t("statsDecimal.scope.local"), localStatus, localDetailRows, localNote, localScope?.tokens, localScope?.reasoningReported),
					detailCard("balance", t("statsDecimal.scope.balance"), balanceStatus, balanceDetailRows,
						visibleBalance?.provider ? t("statsDecimal.detail.balanceSource", { source: visibleBalance.provider }) : null,
						null)),
				treeTotal,
				h("div", { className: "dsh-sd-note dsh-sd-detail-footer" }, t("statsDecimal.detail.disclaimer"))) : null;
			const portal = detail !== null && reactDom?.createPortal && typeof document !== "undefined"
				? reactDom.createPortal(detail, document.body)
				: detail;
			return h(react.Fragment, null,
				h("style", { key: "stats-decimal-zone-style", "data-plugin": "dsh-stats-decimal", "data-plugin-css": "stats-decimal-zone", "data-stats-decimal-style": "" }, ZONE_CSS),
				zone,
				portal);
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
				callGetUsageScopes = rpc.call.bind(rpc);
			};
			// Bind the balance RPC client from the injected connection service.
			bindConnectionRpc();
			if (typeof ctx.remote?.$on === "function") {
				ctx.effect(() => ctx.remote.$on("api-session/removed", (sessionId) => {
					invalidateRemovedSessionBalance(sessionId);
					invalidateRemovedUsageScopes(sessionId);
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
