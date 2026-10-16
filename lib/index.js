/**
 * dsh-stats-decimal — node/host half.
 *
 * Registers one session projection served to the browser conversation dock:
 *
 *  `billingLedger` — a pure fold of `assistant/message` usage events into
 *  per-currency (CNY / USD) session **cumulative** cost and a Host-local
 *  **today** change signal. The client-time-zone daily amount is read from the
 *  session log RPC. Each message is priced by its model id, the Beijing-time
 *  peak/valley band of its `SessionEvent.time`, official HIT / MISS / OUTPUT
 *  rates, and optional model-specific CACHE WRITE rates. Zero
 *  network; the fold replays history, so re-opening an old session yields the
 *  same totals the live session shows.
 *
 * The account-balance row is deliberately NOT computed here and NOT carried
 * by a session event: the session log refuses to load any event whose type it
 * does not know unless it is marked `ignorable`, and this host half has no way
 * to attach that marker (see the session.append envelope). Persisting a custom
 * `stats-decimal/balance` event would permanently corrupt every session it was
 * appended to. The browser requests balance over authenticated RPC. The Host
 * resolves the effective model provider from DSH's Session Controller and
 * dispatches only to that provider's DSH-owned balance service; credentials
 * stay out of the browser and plugin-specific events stay out of the log.
 */
import z from "@deepseek-ai/schemastery";
import { z as zod } from "zod";
import { holidaySpansForClient } from "./billing-calendar/index.js";
import { costOf, bandForTime, localDayStart, mergePricing } from "./pricing.js";

const BALANCE_CONFIG_SCHEMA = z.object({
	enabled: z.boolean().default(false),
	// Accepted only so older profile YAML continues to load; neither field is used.
	provider: z.string(),
	apiBase: z.string()
}).default({});
const OFFICIAL_BALANCE_URL = "https://api.deepseek.com/user/balance";
const OFFICIAL_MESSAGES_BASE_URL = "https://api.deepseek.com/anthropic";
const OFFICIAL_BASE_URL_ENV = "DEEPSEEK_BASE_URL";
// The pinned adapter uses its loader entry ID as settingsNs, or its package name when no ID exists.
const OFFICIAL_SETTINGS_NAMESPACES = new Set(["llm-deepseek", "llm-deepseek-api-key"]);
const OFFICIAL_BALANCE_TIMEOUT_MS = 20_000;
const OFFICIAL_BALANCE_MAX_RESPONSE_BYTES = 64 * 1024;
const SESSION_SELECTION_TIMEOUT_MS = 10_000;
const ACCOUNT_BALANCE_TIMEOUT_MS = 125_000;
// DSH deepseekAccount currently bounds getBalance() to at most 120 seconds.
// Allow two 10-second selection reads, the account-service maximum plus
// headroom, and response serialization.
const BALANCE_OPERATION_TIMEOUT_MS = 160_000;

/** Cordis plugin name. */
export const name = "stats-decimal";

const Config = z.object({
	// Master cost switch; disabled by default so the billing row stays hidden without configuration.
	enableCost: z.boolean().default(false),
	// Currency switches; both are disabled by default.
	cnyEnabled: z.boolean().default(false),
	usdEnabled: z.boolean().default(false),
	// Beijing-time (UTC+8) peak hours, 0-23; other hours are off-peak. An empty list means all day off-peak.
	// Example: 09:00-12:00 and 14:00-18:00 => [9,10,11,14,15,16,17]. Independent of Host time zone and DST.
	peakHours: z.array(z.natural().max(23)).default([9, 10, 11, 14, 15, 16, 17]),
	// Peak/off-peak price overrides; defaults come from lib/pricing.js. Shape: model -> currency -> band -> cacheHit/cacheMiss/output with optional cacheWrite.
	overridePricing: z.dict(z.any()).default({}),
	// When enabled, the Host follows the current Session's effective DSH model
	// provider. API keys remain in DSH credentials.
	balance: BALANCE_CONFIG_SCHEMA.default({ enabled: false })
});

const ZERO_LEDGER = () => ({ cumulative: { CNY: 0, USD: 0 }, today: { CNY: 0, USD: 0 }, todayStamp: null, pricingKnown: true });

// Internal projection state shape carried by `init`/`apply`. Distinct from the
// client view (`BILLING_LEDGER_SCHEMA`): the state also holds `todayStamp`, the
// local-day epoch "today" refers to, which is how the day cut survives folds.
const BILLING_LEDGER_STATE_SCHEMA = zod.object({
	cumulative: zod.object({ CNY: zod.number().nonnegative(), USD: zod.number().nonnegative() }).strict(),
	today: zod.object({ CNY: zod.number().nonnegative(), USD: zod.number().nonnegative() }).strict(),
	todayStamp: zod.number().nullable(),
	pricingKnown: zod.boolean()
}).strict();

// Client view shape. The supported DSH v0.2.0-rc.2 projection contract exposes
// the client-visible part under `wire.viewSchema`; older versions are not a
// compatibility target.
// Without a `wire` the projection is not client-visible and its row
// never renders in the conversation dock.
const BILLING_LEDGER_SCHEMA = zod.object({
	enabled: zod.boolean(),
	balanceEnabled: zod.boolean(),
	currencies: zod.array(zod.enum(["CNY", "USD"])),
	peakHours: zod.array(zod.number().int().min(0).max(23)),
	publicHolidaySpans: zod.array(zod.object({
		startDate: zod.string(),
		endDate: zod.string(),
		name: zod.string(),
		nameEn: zod.string()
	}).strict()),
	cumulative: zod.object({ CNY: zod.number().nonnegative(), USD: zod.number().nonnegative() }).strict(),
	today: zod.object({ CNY: zod.number().nonnegative(), USD: zod.number().nonnegative() }).strict(),
	pricingKnown: zod.boolean()
}).strict();

/** Projection registry is required; Connection (for the balance RPC) is gated
 *  separately via an inner `ctx.inject` so the ledger still works in profiles
 *  that only mount projections. Credentials and account services stay optional. */
export const inject = ["sessionProjections"];

/** Fold one usage record into the running ledger (pure). Preserves the
 *  `todayStamp` (the local day `today` refers to) so it survives folds. */
function foldUsage(state, buckets, model, band, currencies, table, today, timeEpochMs) {
	const delta = costOf(buckets, model, band, currencies, table, timeEpochMs);
	if (delta == null) return state.pricingKnown ? { ...state, pricingKnown: false } : state;
	let changed = false;
	const cumulative = { ...state.cumulative };
	const todayCur = { ...state.today };
	for (const currency of currencies) {
		const amount = delta[currency] ?? 0;
		if (amount <= 0) continue;
		changed = true;
		cumulative[currency] = cumulative[currency] + amount;
		if (today) todayCur[currency] = todayCur[currency] + amount;
	}
	if (!changed) return state;
	return { cumulative, today: todayCur, todayStamp: state.todayStamp, pricingKnown: state.pricingKnown };
}

/** Resolve an IANA time zone supplied by the browser, or the Host zone for older clients. */
function resolveTimeZone(value) {
	let candidate = value;
	if (candidate === undefined || candidate === null) {
		try {
			candidate = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
		} catch {
			candidate = "UTC";
		}
	}
	if (typeof candidate !== "string" || candidate.length === 0 || candidate.length > 128) return null;
	try {
		return new Intl.DateTimeFormat("en-US", { timeZone: candidate }).resolvedOptions().timeZone ?? null;
	} catch {
		return null;
	}
}

function dateKeyFormatter(timeZone) {
	return new Intl.DateTimeFormat("en-CA", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit"
	});
}

function dateKeyFromFormatter(timeEpochMs, formatter) {
	if (!Number.isFinite(timeEpochMs)) return null;
	const parts = Object.fromEntries(formatter.formatToParts(new Date(timeEpochMs))
		.filter((part) => part.type === "year" || part.type === "month" || part.type === "day")
		.map((part) => [part.type, part.value]));
	if (!parts.year || !parts.month || !parts.day) return null;
	return `${parts.year.padStart(4, "0")}-${parts.month}-${parts.day}`;
}

/**
 * Sum costs from the requested client-local calendar day across DSH's live and
 * persisted session corpus. Keep per-session totals on the Host so the active
 * Session's daily cost can use the same client time zone without exposing
 * other sessions' individual totals. SessionQuery returns replay-validated
 * detached logs; only child-owned events are billed so fork-inherited prefixes
 * are not counted twice. API-key and account-login requests use the same
 * provider-neutral usage-event shape. Raw events remain on the Host.
 */
async function aggregateSessionDailyCost(sessionQuery, date, timeZone, peakHours, currencies, table) {
	const unavailable = { status: "unavailable", date, timeZone, sessionCount: 0, sessionTotalsById: new Map() };
	if (typeof sessionQuery?.listSessions !== "function" || typeof sessionQuery?.readSession !== "function") {
		return unavailable;
	}
	try {
		const formatter = dateKeyFormatter(timeZone);
		const records = await sessionQuery.listSessions();
		if (!Array.isArray(records)) return unavailable;
		const sessionIds = records.map((record) => {
			const sessionId = record?.header?.id;
			if (typeof sessionId !== "string" || sessionId.length === 0) throw new TypeError("Invalid session query record");
			return sessionId;
		});
		const totals = { CNY: 0, USD: 0 };
		const sessionTotalsById = new Map();
		let pricingKnown = true;
		let sessionCount = 0;
		const readConcurrency = 4;
		for (let offset = 0; offset < sessionIds.length; offset += readConcurrency) {
			const batchIds = sessionIds.slice(offset, offset + readConcurrency);
			const readResults = await Promise.allSettled(batchIds.map((sessionId) => sessionQuery.readSession(sessionId)));
			const failedRead = readResults.find((result) => result.status === "rejected");
			if (failedRead) throw failedRead.reason;
			for (let index = 0; index < readResults.length; index += 1) {
				const sessionId = batchIds[index];
				const snapshot = readResults[index].value;
				if (!Array.isArray(snapshot?.events)
					|| !Number.isSafeInteger(snapshot.inheritedEventCount)
					|| snapshot.inheritedEventCount < 0
					|| snapshot.session?.id !== sessionId) {
					return unavailable;
				}
				let sessionHasUsage = false;
				let sessionPricingKnown = true;
				const sessionTotals = { CNY: 0, USD: 0 };
				for (const event of snapshot.events) {
					if (event.seq < snapshot.inheritedEventCount || event.type !== "assistant/message") continue;
					const usage = event.data?.usage;
					if (usage === void 0 || usage === null || dateKeyFromFormatter(event.time, formatter) !== date) continue;
					sessionHasUsage = true;
					const delta = costOf({
						uncachedInputTokens: usage.inputTokens ?? 0,
						cacheReadTokens: usage.cacheReadTokens ?? 0,
						cacheWriteTokens: usage.cacheWriteTokens ?? 0,
						outputTokens: usage.outputTokens ?? 0
					}, event.data.message?.source?.model, bandForTime(event.time, peakHours), currencies, table, event.time);
					if (delta === null || currencies.some((currency) => !Number.isFinite(delta[currency]) || delta[currency] < 0)) {
						pricingKnown = false;
						sessionPricingKnown = false;
						continue;
					}
					for (const currency of currencies) {
						totals[currency] += delta[currency] ?? 0;
						sessionTotals[currency] += delta[currency] ?? 0;
					}
				}
				if (currencies.some((currency) => !Number.isFinite(sessionTotals[currency]) || sessionTotals[currency] < 0)) sessionPricingKnown = false;
				sessionTotalsById.set(sessionId, { status: sessionPricingKnown ? "ready" : "unknown", totals: sessionTotals });
				if (sessionHasUsage) sessionCount += 1;
			}
		}
		if (currencies.some((currency) => !Number.isFinite(totals[currency]) || totals[currency] < 0)) pricingKnown = false;
		return {
			status: pricingKnown ? "ready" : "unknown",
			date,
			timeZone,
			totals,
			sessionCount,
			sessionTotalsById
		};
	} catch {
		// A partial scan must never be presented as a complete all-session total.
		return unavailable;
	}
}

/** Return only the requested current Session's daily total from a Host-side aggregate. */
function sessionDailyResponseForClient(result, sessionId) {
	const { sessionTotalsById, ...publicResult } = result;
	const sessionTotal = typeof sessionId === "string" && sessionId.length > 0
		? sessionTotalsById?.get(sessionId)
		: null;
	return {
		...publicResult,
		currentSession: sessionTotal
			? { status: sessionTotal.status, totals: { ...sessionTotal.totals } }
			: { status: "unavailable", totals: null }
	};
}

/**
 * Node/host plugin apply. Registers the `billingLedger` projection (a pure
 * fold of `assistant/message` cost — the only session-affecting work this half
 * does) and a balance endpoint under the authenticated shared `/api` route,
 * which returns the available balance using the key resolved by DSH's
 * credentials service.
 * The account balance is deliberately NOT written to the session log (a custom
 * event type would corrupt every session it landed in) and its key never
 * leaves the host (the browser asks via RPC, never holds the key).
 * The cordis framework passes the schema-resolved plugin config as the second
 * argument.
 */
function apply(ctx, config) {
	const cfg = config ?? ctx?.config ?? {};
	const currencies = [];
	if (cfg.cnyEnabled) currencies.push("CNY");
	if (cfg.usdEnabled) currencies.push("USD");
	// If both currency switches are off the cost row is suppressed entirely;
	// still keep a usable default set so the projection schema stays valid.
	const activeCurrencies = currencies.length ? currencies : ["CNY", "USD"];
	const peakHours = Array.isArray(cfg.peakHours) ? cfg.peakHours : [];
	const table = mergePricing(cfg.overridePricing);
	const costEnabled = Boolean(cfg.enableCost) && currencies.length > 0;
	const balanceEnabled = cfg.balance?.enabled === true;
	let llmTopologyGeneration = 0;
	let settingsDocumentGeneration = 0;
	let officialCredentialGeneration = 0;
	let balanceIdentityGeneration = 0;
	let officialRouteChangeTracking = false;
	let sessionSelectionChangeTracking = false;
	let sessionLifecycleChangeTracking = false;
	const sessionSelectionOperations = new Map();
	let abortOfficialBalanceFlights = () => {};
	const getBalanceGenerations = () => ({
		llm: llmTopologyGeneration,
		settings: settingsDocumentGeneration,
		credential: officialCredentialGeneration,
		balance: balanceIdentityGeneration
	});
	const bumpBalanceIdentity = () => {
		balanceIdentityGeneration += 1;
		abortOfficialBalanceFlights();
	};
	const invalidateSessionSelection = (sessionId) => {
		if (typeof sessionId !== "string") return;
		const operation = sessionSelectionOperations.get(sessionId);
		if (operation) operation.generation += 1;
	};
	const acquireSessionSelectionLease = (sessionId) => {
		let operation = sessionSelectionOperations.get(sessionId);
		if (!operation) {
			operation = { generation: 0, active: 0 };
			sessionSelectionOperations.set(sessionId, operation);
		}
		operation.active += 1;
		const generation = operation.generation;
		let released = false;
		let invalidated = false;
		return {
			generation,
			isCurrent() {
				return !invalidated && sessionSelectionOperations.get(sessionId) === operation && operation.generation === generation;
			},
			invalidate() {
				invalidated = true;
			},
			release() {
				if (released) return;
				released = true;
				operation.active = Math.max(0, operation.active - 1);
				if (operation.active === 0 && sessionSelectionOperations.get(sessionId) === operation) {
					sessionSelectionOperations.delete(sessionId);
				}
			}
		};
	};
	if (balanceEnabled) {
		try {
			if (typeof ctx?.effect === "function" && typeof ctx?.sessionProjections?.onChanged === "function") {
				ctx.effect(() => ctx.sessionProjections.onChanged((session, key) => {
					if (key === "modelSelection") invalidateSessionSelection(session?.id);
				}), "stats-decimal: Session model-selection changes");
				sessionSelectionChangeTracking = true;
			}
		} catch {
			// Balance fails closed when the pinned Session selection change feed is unavailable.
		}
		try {
			if (typeof ctx?.on === "function") {
				ctx.on("session/disposed", (session) => invalidateSessionSelection(session?.id));
				ctx.on("session/created", (session) => invalidateSessionSelection(session?.id));
				sessionLifecycleChangeTracking = true;
			}
		} catch {
			// Balance fails closed when Session lifecycle notifications are unavailable.
		}
		try {
			if (typeof ctx?.on === "function") {
				ctx.on("llm/adapters-updated", () => {
					llmTopologyGeneration += 1;
					bumpBalanceIdentity();
				});
				ctx.on("settings/document-updated", () => {
					settingsDocumentGeneration += 1;
					bumpBalanceIdentity();
				});
				ctx.on("credentials/reference-updated", () => {
					// The notification is the invalidation boundary. Do not make its
					// delivery depend on a fresh settings read: that read can fail
					// transiently while an obsolete credential resolution is pending.
					officialCredentialGeneration += 1;
					bumpBalanceIdentity();
				});
				officialRouteChangeTracking = true;
			}
		} catch {
			// Official API-key balance fails closed without every required Host update notification.
		}
	}

	const billingLedger = {
		key: "billingLedger",
		stateSchema: BILLING_LEDGER_STATE_SCHEMA,
		init: ZERO_LEDGER,
		apply: (state, event) => {
			if (event.type !== "assistant/message") return state;
			const usage = event.data?.usage;
			if (usage === void 0 || usage === null) return state;
			const buckets = {
				uncachedInputTokens: usage.inputTokens ?? 0,
				cacheReadTokens: usage.cacheReadTokens ?? 0,
				cacheWriteTokens: usage.cacheWriteTokens ?? 0,
				outputTokens: usage.outputTokens ?? 0
			};
			const model = event.data.message?.source?.model;
			const band = bandForTime(event.time, peakHours);
			// Today's cost covers the same local calendar day as the latest event.
			// On a day change (including historical replay), clear it before adding
			// the new event so amounts from different dates are not mixed.
			const dayStamp = localDayStart(event.time);
			let base = state;
			if (state.todayStamp !== dayStamp) {
				base = { cumulative: state.cumulative, today: { CNY: 0, USD: 0 }, todayStamp: dayStamp, pricingKnown: state.pricingKnown };
			}
			const next = foldUsage(base, buckets, model, band, activeCurrencies, table, true, event.time);
			return next === base ? state : next;
		},
		// rc2+ projection contract: the client-visible part lives under `wire` and
		// is validated by `wire.viewSchema`. Without `wire` the projection is not
		// served to `useProjection()`.
		wire: {
			viewSchema: BILLING_LEDGER_SCHEMA,
			view: (state) => ({
				enabled: costEnabled,
				balanceEnabled,
				currencies: activeCurrencies,
				peakHours: [...peakHours],
				publicHolidaySpans: holidaySpansForClient(),
				cumulative: { ...state.cumulative },
				today: { ...state.today },
				pricingKnown: state.pricingKnown
			})
		},
		stateVersion: 7
	};
	ctx.sessionProjections.register(billingLedger);

	// Balance endpoint uses Connection's exact `/api` Fetch route registry.
	// Dedicated `rpc.handle()` routes resolve `webServer` from the Connection
	// service context; in composed profiles it is provided by a sibling and the
	// route can fail to register. The shared `/api` route already applies DSH's
	// Host/Origin checks and browser authentication. The DeepSeek key stays
	// host-side (resolved through DSH credentials, never configured here). No
	// Session event is ever written.
	if (true) {
		let sessionDailyCache = null;
		let sessionDailyCacheAt = 0;
		let sessionDailyInFlight = null;
		let sessionDailyRevision = 0;
		ctx.inject(["connection"], (connectionCtx) => {
			const connection = connectionCtx.connection;
			if (typeof connection?.fetch?.register !== "function") return;
			const providerBalanceFlights = new Map();
			abortOfficialBalanceFlights = (sessionId) => {
				for (const flight of providerBalanceFlights.values()) {
					if (flight.provider !== "deepseek-official") continue;
					if (sessionId !== undefined && flight.sessionId !== sessionId) continue;
					flight.controller.abort();
				}
			};
			connectionCtx.effect(() => () => abortOfficialBalanceFlights(), "stats-decimal: cancel balance requests");
			const getProviderBalance = async (provider, request, signal, officialRoute, sessionId, isSelectionCurrent, revalidateSelection) => {
				const flightKey = provider === "deepseek-official"
					? JSON.stringify([provider, sessionId, officialRoute?.fingerprint ?? "unverified"])
					: provider;
				let flight = providerBalanceFlights.get(flightKey);
				if (flight?.controller.signal.aborted && provider === "deepseek-official") {
					providerBalanceFlights.delete(flightKey);
					flight = null;
				}
				if (!flight) {
					const controller = new AbortController();
					flight = { controller, waiters: 0, settled: false, promise: null, provider, sessionId, authorizers: new Set() };
					const providerSignal = provider === "deepseek-official" ? controller.signal : undefined;
					flight.promise = Promise.resolve()
						.then(() => getSelectedProviderBalance(
							connectionCtx,
							ctx,
							provider,
							request,
							providerSignal,
							officialRoute,
							getBalanceGenerations,
							officialRouteChangeTracking,
							() => [...flight.authorizers].some((authorize) => authorize()),
							revalidateSelection
						))
						.catch(() => ({ balances: { CNY: null, USD: null }, error: "balance-unavailable" }))
						.finally(() => {
							flight.settled = true;
							if (providerBalanceFlights.get(flightKey) === flight) providerBalanceFlights.delete(flightKey);
						});
					providerBalanceFlights.set(flightKey, flight);
				}
				const authorize = () => isSelectionCurrent();
				flight.authorizers.add(authorize);
				flight.waiters += 1;
				let outcome;
				try {
					outcome = await raceWithAbortAndTimeout(flight.promise, signal, BALANCE_OPERATION_TIMEOUT_MS);
				} finally {
					flight.authorizers.delete(authorize);
					flight.waiters = Math.max(0, flight.waiters - 1);
					if (flight.waiters === 0 && !flight.settled && provider === "deepseek-official") {
						flight.controller.abort();
					}
				}
				if (outcome.status === "aborted") return { balances: { CNY: null, USD: null }, error: "request-cancelled" };
				if (outcome.status === "timeout") return { balances: { CNY: null, USD: null }, error: "balance-timeout" };
				if (outcome.status !== "fulfilled") return { balances: { CNY: null, USD: null }, error: "balance-unavailable" };
				return outcome.value;
			};
			const getBalanceResult = async (signal, request, payload) => {
				if (!balanceEnabled) {
					return { ok: true, value: { enabled: false, provider: null, balances: { CNY: null, USD: null }, error: null } };
				}
				let lease = null;
				let selected = null;
				let officialRoute = null;
				let responseLeaseHandedOff = false;
				const operation = (async () => {
					const sessionId = payload?.sessionId;
					if (typeof sessionId !== "string" || !sessionSelectionChangeTracking || !sessionLifecycleChangeTracking) {
						return balanceFailure("session-change-monitor-unavailable");
					}
					lease = acquireSessionSelectionLease(sessionId);
					selected = await resolveEffectiveBalanceProvider(connectionCtx, sessionId, signal, lease, getBalanceGenerations);
					if (!selected.provider) return balanceFailure(selected.error);
					const isSelectionCurrent = () => lease.isCurrent()
						&& (selected.source !== "default" || selected.defaultGeneration === settingsDocumentGeneration);
					const revalidateSelection = async () => {
						if (!isSelectionCurrent()) return false;
						const current = await resolveEffectiveBalanceProvider(connectionCtx, sessionId, signal, lease, getBalanceGenerations);
						return isSelectionCurrent() && sameEffectiveBalanceSelection(selected, current);
					};
					if (!isSelectionCurrent()) return balanceFailure("selection-changed", null);
					if (selected.provider === "deepseek-official") {
						const resolvedRoute = resolveOfficialBalanceRoute(ctx, getBalanceGenerations, officialRouteChangeTracking);
						if (!resolvedRoute.route) return balanceFailure(resolvedRoute.error, selected.provider);
						officialRoute = resolvedRoute.route;
					}
					const result = await getProviderBalance(
						selected.provider,
						request,
						signal,
						officialRoute,
						sessionId,
						isSelectionCurrent,
						revalidateSelection
					);
					if (result.error === "request-cancelled") return balanceFailure(result.error, selected.provider);
					if (!isSelectionCurrent()) return balanceFailure("selection-changed", null);
					const stillSelected = await revalidateSelection();
					if (!stillSelected) return balanceFailure("selection-changed", null);
					if (result.error) warnBalanceFailure(result.error);
					return {
						ok: true,
						value: {
							enabled: true,
							provider: selected.provider,
							balances: result.balances,
							error: result.error,
							...(officialRoute ? { balanceGeneration: officialRoute.balanceGeneration } : {})
						}
					};
				})();
				const outcome = await raceWithAbortAndTimeout(operation, signal, BALANCE_OPERATION_TIMEOUT_MS);
				try {
					if (outcome.status !== "fulfilled") {
						lease?.invalidate();
						if (outcome.status === "aborted") return balanceFailure("request-cancelled");
						if (outcome.status === "timeout") return balanceFailure("balance-timeout");
						return balanceFailure("balance-unavailable");
					}
					responseLeaseHandedOff = true;
					return {
						finalize() {
							if (outcome.value?.value?.error) return outcome.value;
							if (signal?.aborted) return balanceFailure("request-cancelled", selected?.provider ?? null);
							if (lease && !lease.isCurrent()) return balanceFailure("selection-changed", null);
							if (selected?.source === "default" && selected.defaultGeneration !== settingsDocumentGeneration) {
								return balanceFailure("selection-changed", null);
							}
							if (officialRoute) {
								const currentRoute = resolveOfficialBalanceRoute(ctx, getBalanceGenerations, officialRouteChangeTracking);
								if (!currentRoute.route || currentRoute.route.fingerprint !== officialRoute.fingerprint) {
									return balanceFailure(currentRoute.error ?? "official-route-changed", selected?.provider ?? null);
								}
							}
							return outcome.value;
						},
						release() {
							lease?.release();
						}
					};
				} finally {
					if (!responseLeaseHandedOff) lease?.release();
				}
			};
			const balanceFailure = (error, provider = null) => {
				if (error !== "request-cancelled") warnBalanceFailure(error);
				return { ok: true, value: { enabled: true, provider, balances: { CNY: null, USD: null }, error } };
			};
			const warnBalanceFailure = (error) => {
				try {
					if (typeof ctx.logger === "function") ctx.logger("stats-decimal").warn(`balance query failed: ${error}`);
				} catch {
					// Logging must not turn an unavailable balance into a Host failure.
				}
			};
			const getSessionDailyCost = async (force = false, requestedTimeZone, requestedSessionId) => {
				const timeZone = resolveTimeZone(requestedTimeZone);
				if (!timeZone) return sessionDailyResponseForClient({ status: "unavailable", date: null, timeZone: null, sessionCount: 0 }, requestedSessionId);
				const formatter = dateKeyFormatter(timeZone);
				const date = dateKeyFromFormatter(Date.now(), formatter);
				if (!date) return sessionDailyResponseForClient({ status: "unavailable", date: null, timeZone, sessionCount: 0 }, requestedSessionId);
				const cacheKey = `${timeZone}\u0000${date}`;
				if (!costEnabled) return sessionDailyResponseForClient({ status: "unavailable", date, timeZone, sessionCount: 0 }, requestedSessionId);
				if (force) {
					sessionDailyRevision += 1;
					sessionDailyCache = null;
					sessionDailyCacheAt = 0;
				}
				const revision = sessionDailyRevision;
				const now = Date.now();
				if (!force && sessionDailyCache?.date === date && sessionDailyCache?.timeZone === timeZone && now - sessionDailyCacheAt < 60_000) {
					return sessionDailyResponseForClient(sessionDailyCache, requestedSessionId);
				}
				if (sessionDailyInFlight?.key === cacheKey) {
					if (sessionDailyInFlight.revision === revision) {
						return sessionDailyInFlight.promise.then((result) => sessionDailyResponseForClient(result, requestedSessionId));
					}
					await sessionDailyInFlight.promise;
					if (revision !== sessionDailyRevision) return getSessionDailyCost(false, timeZone, requestedSessionId);
					if (sessionDailyInFlight?.key === cacheKey) {
						return sessionDailyInFlight.promise.then((result) => sessionDailyResponseForClient(result, requestedSessionId));
					}
				}
				let sessionQuery;
				try {
					sessionQuery = typeof connectionCtx.get === "function"
						? connectionCtx.get("sessionQuery")
						: connectionCtx.sessionQuery;
				} catch {
					sessionQuery = null;
				}
				const promise = aggregateSessionDailyCost(sessionQuery, date, timeZone, peakHours, activeCurrencies, table)
					.then((result) => {
						if (revision === sessionDailyRevision) {
							sessionDailyCache = result;
							sessionDailyCacheAt = Date.now();
						}
						return result;
					})
					.finally(() => {
						if (sessionDailyInFlight?.promise === promise) sessionDailyInFlight = null;
					});
				sessionDailyInFlight = { key: cacheKey, date, timeZone, revision, promise };
				const result = await promise;
				return revision === sessionDailyRevision
					? sessionDailyResponseForClient(result, requestedSessionId)
					: getSessionDailyCost(false, timeZone, requestedSessionId);
			};
			connectionCtx.effect(() => connection.fetch.register({
				path: "/api/stats-decimal/getBalance",
				methods: ["POST"],
				requestBody: "buffered",
				fetch: async (request) => {
					let message;
					try {
						message = await request.json();
					} catch {
						return new Response("body is not JSON", { status: 400 });
					}
					if (message?.type !== "client-request" || typeof message.rpcId !== "string" || message.method !== "stats-decimal/getBalance") {
						return new Response("invalid balance RPC request", { status: 400 });
					}
					let balanceOutcome;
					try {
						balanceOutcome = await getBalanceResult(request.signal, request, message.payload);
						const result = typeof balanceOutcome?.finalize === "function"
							? balanceOutcome.finalize()
							: balanceOutcome;
						return Response.json({
							type: "server-response",
							rpcId: message.rpcId,
							result
						});
					} finally {
						balanceOutcome?.release?.();
					}
				}
			}), "stats-decimal: balance endpoint");
			connectionCtx.effect(() => connection.fetch.register({
				path: "/api/stats-decimal/getSessionDailyCost",
				methods: ["POST"],
				requestBody: "buffered",
				fetch: async (request) => {
					let message;
					try {
						message = await request.json();
					} catch {
						return new Response("body is not JSON", { status: 400 });
					}
					if (message?.type !== "client-request" || typeof message.rpcId !== "string" || message.method !== "stats-decimal/getSessionDailyCost") {
						return new Response("invalid session daily cost RPC request", { status: 400 });
					}
					return Response.json({
						type: "server-response",
						rpcId: message.rpcId,
						result: { ok: true, value: await getSessionDailyCost(
							message.payload?.force === true,
							message.payload?.timeZone,
							message.payload?.sessionId
						) }
					});
				}
			}), "stats-decimal: session daily cost endpoint");
		});
	}
}

/**
 * Resolve the DeepSeek API key through DSH's credentials capability. The
 * service owns its storage and environment precedence; this plugin does not
 * read DSH credential files or process environment directly. Returns only a
 * Host-local key or a sanitized failure code; callers never switch providers.
 */
/** Resolve the Host-authoritative model provider without activating an Agent. */
async function resolveEffectiveBalanceProvider(connectionCtx, sessionId, signal, lease, getGenerations) {
	if (typeof sessionId !== "string" || sessionId.trim().length === 0 || sessionId.length > 256) {
		return { provider: null, error: "session-id-invalid" };
	}
	if (!lease?.isCurrent?.()) return { provider: null, error: "selection-changed" };
	if (signal?.aborted) return { provider: null, error: "request-cancelled" };
	const controller = getConnectionService(connectionCtx, "sessionController");
	if (typeof controller?.projections !== "function") {
		return { provider: null, error: "session-authority-unavailable" };
	}
	const projectionOutcome = await raceWithAbortAndTimeout(
		Promise.resolve().then(() => controller.projections({ sessionId }, signal)),
		signal,
		SESSION_SELECTION_TIMEOUT_MS
	);
	if (projectionOutcome.status === "aborted") return { provider: null, error: "request-cancelled" };
	if (projectionOutcome.status === "timeout") return { provider: null, error: "session-selection-timeout" };
	if (projectionOutcome.status !== "fulfilled" || projectionOutcome.value === null) {
		return { provider: null, error: "session-unavailable" };
	}
	if (!lease.isCurrent()) return { provider: null, error: "selection-changed" };

	const selectionState = projectionOutcome.value?.values?.modelSelection;
	if (!selectionState || typeof selectionState !== "object"
		|| !Object.hasOwn(selectionState, "next") || !Object.hasOwn(selectionState, "lastUsed")) {
		return { provider: null, error: "model-selection-unavailable" };
	}
	let selection = selectionState.next ?? selectionState.lastUsed;
	let source = "session";
	let defaultGeneration = null;
	if (selection === null || selection === undefined) {
		const beforeDefaultRead = getGenerations().settings;
		const defaultModel = getConnectionService(connectionCtx, "agentDefaultModel");
		if (typeof defaultModel?.currentSelection !== "function") {
			return { provider: null, error: "default-model-unavailable" };
		}
		try {
			selection = defaultModel.currentSelection();
		} catch {
			return { provider: null, error: "default-model-unavailable" };
		}
		if (!lease.isCurrent() || beforeDefaultRead !== getGenerations().settings) {
			return { provider: null, error: "selection-changed" };
		}
		source = "default";
		defaultGeneration = beforeDefaultRead;
	}
	if (!lease.isCurrent()) return { provider: null, error: "selection-changed" };
	if (!selection || typeof selection !== "object"
		|| typeof selection.provider !== "string" || selection.provider.trim().length === 0
		|| typeof selection.model !== "string" || selection.model.trim().length === 0) {
		return { provider: null, error: "model-selection-invalid" };
	}
	if (selection.provider !== "deepseek-account" && selection.provider !== "deepseek-official") {
		return { provider: null, error: "unsupported-provider" };
	}
	return {
		provider: selection.provider,
		selection: {
			provider: selection.provider,
			model: selection.model,
			reasoningEffort: typeof selection.reasoningEffort === "string" ? selection.reasoningEffort : null
		},
		source,
		defaultGeneration,
		selectionRevision: projectionOutcome.value.asOfSeq,
		selectionGeneration: lease.generation,
		error: null
	};
}

function sameEffectiveBalanceSelection(left, right) {
	return Boolean(left?.provider && right?.provider
		&& left.provider === right.provider
		&& left.source === right.source
		&& left.selection?.provider === right.selection?.provider
		&& left.selection?.model === right.selection?.model
		&& left.selection?.reasoningEffort === right.selection?.reasoningEffort
		&& left.selectionGeneration === right.selectionGeneration
		&& left.defaultGeneration === right.defaultGeneration);
}

/** Resolve the official adapter configuration from DSH's Host-owned APIs. */
function resolveOfficialBalanceRoute(hostCtx, getGenerations, canTrackChanges) {
	if (!canTrackChanges) return { route: null, error: "official-route-monitor-unavailable" };
	const before = getGenerations();
	const llm = getConnectionService(hostCtx, "llm");
	const settings = getConnectionService(hostCtx, "settings");
	if (typeof llm?.listProviders !== "function"
		|| typeof llm?.listConfigurableProviders !== "function"
		|| typeof settings?.describe !== "function") {
		return { route: null, error: "official-route-configuration-unavailable" };
	}

	let providers;
	let configurableProviders;
	let descriptors;
	try {
		providers = llm.listProviders();
		configurableProviders = llm.listConfigurableProviders();
		descriptors = settings.describe({ redactSecrets: true });
	} catch {
		return { route: null, error: "official-route-configuration-unavailable" };
	}
	const after = getGenerations();
	if (before.llm !== after.llm || before.settings !== after.settings
		|| before.credential !== after.credential || before.balance !== after.balance) {
		return { route: null, error: "official-route-changed" };
	}
	if (!Array.isArray(providers) || !Array.isArray(configurableProviders) || !Array.isArray(descriptors)) {
		return { route: null, error: "official-route-configuration-unavailable" };
	}

	const activeRoutes = providers.filter((provider) => provider?.id === "deepseek-official");
	const configuredRoutes = configurableProviders.filter((provider) => provider?.provider === "deepseek-official");
	if (activeRoutes.length !== 1 || activeRoutes[0]?.name !== "DeepSeek"
		|| configuredRoutes.length !== 1
		|| configuredRoutes[0]?.displayName !== "DeepSeek"
		|| !Array.isArray(configuredRoutes[0]?.settingsPath)
		|| configuredRoutes[0].settingsPath.length !== 0
		|| !OFFICIAL_SETTINGS_NAMESPACES.has(configuredRoutes[0]?.settingsNs)) {
		return { route: null, error: "official-provider-unavailable" };
	}

	const settingsNamespace = configuredRoutes[0].settingsNs;
	const matchingDescriptors = descriptors.filter((descriptor) => descriptor?.ns === settingsNamespace);
	if (matchingDescriptors.length !== 1) return { route: null, error: "official-config-unavailable" };
	const descriptor = matchingDescriptors[0];
	if (descriptor.applies !== "live" || !Number.isSafeInteger(descriptor.revision) || descriptor.revision < 0
		|| !descriptor.value || typeof descriptor.value !== "object" || Array.isArray(descriptor.value)) {
		return { route: null, error: "official-config-unavailable" };
	}

	const config = descriptor.value;
	const credentialRef = config.apiKeyEnv ?? "DEEPSEEK_API_KEY";
	if (typeof credentialRef !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(credentialRef)) {
		return { route: null, error: "official-credential-reference-invalid" };
	}

	let effectiveBaseURL;
	if (config.baseURL !== undefined && config.baseURL !== null) {
		if (typeof config.baseURL !== "string") return { route: null, error: "official-config-unavailable" };
		effectiveBaseURL = config.baseURL;
	} else {
		const environment = getConnectionService(hostCtx, "launchEnvironment");
		if (typeof environment?.get !== "function") {
			return { route: null, error: "official-environment-unavailable" };
		}
		try {
			const entry = environment.get(OFFICIAL_BASE_URL_ENV);
			if (entry !== undefined && typeof entry?.value !== "string") {
				return { route: null, error: "official-environment-unavailable" };
			}
			effectiveBaseURL = entry?.value ?? OFFICIAL_MESSAGES_BASE_URL;
		} catch {
			return { route: null, error: "official-environment-unavailable" };
		}
	}
	let canonicalBaseURL;
	try {
		canonicalBaseURL = new URL(effectiveBaseURL).href;
		if (canonicalBaseURL !== OFFICIAL_MESSAGES_BASE_URL) {
			return { route: null, error: "official-endpoint-unverified" };
		}
	} catch {
		return { route: null, error: "official-endpoint-unverified" };
	}

	const fingerprint = JSON.stringify([
		activeRoutes[0].id,
		activeRoutes[0].name,
		configuredRoutes[0].provider,
		configuredRoutes[0].displayName,
		settingsNamespace,
		configuredRoutes[0].settingsPath,
		descriptor.revision,
		canonicalBaseURL,
		credentialRef,
		after.llm,
		after.settings,
		after.credential,
		after.balance
	]);
	return {
		route: Object.freeze({
			credentialRef,
			fingerprint,
			settingsNamespace,
			revision: descriptor.revision,
			balanceGeneration: after.balance,
			credentialGeneration: after.credential
		}),
		error: null
	};
}

function officialBalanceRouteIsCurrent(hostCtx, routeSnapshot, getGenerations, canTrackChanges) {
	if (!routeSnapshot) return false;
	const current = resolveOfficialBalanceRoute(hostCtx, getGenerations, canTrackChanges);
	return current.route !== null && current.route.fingerprint === routeSnapshot.fingerprint;
}

/** Dispatch to exactly the selected DSH-owned balance service. */
async function getSelectedProviderBalance(connectionCtx, hostCtx, provider, request, signal, officialRoute, getGenerations, canTrackChanges, isAuthorized, revalidateSelection) {
	if (provider === "deepseek-account") {
		const account = getConnectionService(connectionCtx, "deepseekAccount");
		if (!account) return { balances: { CNY: null, USD: null }, error: "account-provider-unavailable" };
		let getBalance;
		try {
			getBalance = account.getBalance;
		} catch {
			return { balances: { CNY: null, USD: null }, error: "account-provider-unavailable" };
		}
		if (typeof getBalance !== "function") {
			return { balances: { CNY: null, USD: null }, error: "account-provider-unavailable" };
		}
		if (!isAuthorized()) return { balances: { CNY: null, USD: null }, error: "selection-changed" };
		let pendingBalance;
		try {
			// Keep this authorization check adjacent to the DSH service dispatch.
			pendingBalance = getBalance.call(account, accountClientMetadata(request));
		} catch {
			return { balances: { CNY: null, USD: null }, error: "account-balance-failed" };
		}
		const balance = await raceWithAbortAndTimeout(
			Promise.resolve(pendingBalance),
			signal,
			ACCOUNT_BALANCE_TIMEOUT_MS
		);
		if (balance.status === "aborted") return { balances: { CNY: null, USD: null }, error: "request-cancelled" };
		if (balance.status === "timeout") return { balances: { CNY: null, USD: null }, error: "account-balance-timeout" };
		if (balance.status !== "fulfilled") return { balances: { CNY: null, USD: null }, error: "account-balance-failed" };
		return accountBalanceToBalances(balance.value);
	}

	if (provider === "deepseek-official") {
		if (!isAuthorized()) return { balances: { CNY: null, USD: null }, error: "selection-changed" };
		if (!officialBalanceRouteIsCurrent(hostCtx, officialRoute, getGenerations, canTrackChanges)) {
			return { balances: { CNY: null, USD: null }, error: "official-route-changed" };
		}
		const credentials = getConnectionService(connectionCtx, "credentials");
		if (!isAuthorized()) return { balances: { CNY: null, USD: null }, error: "selection-changed" };
		if (!officialBalanceRouteIsCurrent(hostCtx, officialRoute, getGenerations, canTrackChanges)) {
			return { balances: { CNY: null, USD: null }, error: "official-route-changed" };
		}
		const resolved = await resolveBalanceKey(credentials, officialRoute.credentialRef, signal, () => {
			if (!isAuthorized()) return "selection-changed";
			return officialBalanceRouteIsCurrent(hostCtx, officialRoute, getGenerations, canTrackChanges)
				? true
				: "official-route-changed";
		});
		if (!resolved.apiKey) return { balances: { CNY: null, USD: null }, error: resolved.error };
		if (!await revalidateSelection()) {
			return { balances: { CNY: null, USD: null }, error: "selection-changed" };
		}
		if (!isAuthorized()) return { balances: { CNY: null, USD: null }, error: "selection-changed" };
		if (!officialBalanceRouteIsCurrent(hostCtx, officialRoute, getGenerations, canTrackChanges)) {
			return { balances: { CNY: null, USD: null }, error: "official-route-changed" };
		}
		return fetchBalance(resolved.apiKey, signal, () => {
			if (!officialBalanceRouteIsCurrent(hostCtx, officialRoute, getGenerations, canTrackChanges)) {
				return "official-route-changed";
			}
			return isAuthorized() ? true : "selection-changed";
		});
	}
	return { balances: { CNY: null, USD: null }, error: "unsupported-provider" };
}

/** Resolve one Promise with an abort and wall-clock bound, consuming late failures. */
function raceWithAbortAndTimeout(value, signal, timeoutMs, onAbort, onTimeout) {
	return new Promise((resolve) => {
		let settled = false;
		let timer = null;
		const finish = (status, result) => {
			if (settled) return;
			settled = true;
			if (timer !== null) clearTimeout(timer);
			signal?.removeEventListener?.("abort", abort);
			resolve(result === undefined ? { status } : { status, value: result });
		};
		const abort = () => {
			try { onAbort?.(); } catch { /* Cancellation remains best effort. */ }
			finish("aborted");
		};
		if (signal?.aborted) {
			abort();
			return;
		}
		signal?.addEventListener?.("abort", abort, { once: true });
		if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
			timer = setTimeout(() => {
				try { onTimeout?.(); } catch { /* The timeout result is still enforced. */ }
				finish("timeout");
			}, timeoutMs);
		}
		Promise.resolve(value).then(
			(result) => finish("fulfilled", result),
			() => finish("rejected")
		);
	});
}

async function resolveBalanceKey(credentials, credentialRef, signal, verifyBeforeResolve) {
	let resolve;
	try {
		resolve = credentials?.resolve;
	} catch {
		return { apiKey: "", error: "credentials-unavailable" };
	}
	if (typeof resolve !== "function") return { apiKey: "", error: "credentials-unavailable" };
	if (signal?.aborted) return { apiKey: "", error: "request-cancelled" };
	if (typeof verifyBeforeResolve === "function") {
		const verification = verifyBeforeResolve();
		if (verification !== true) {
			return { apiKey: "", error: typeof verification === "string" ? verification : "official-route-changed" };
		}
	}
	let pending;
	try {
		pending = resolve.call(credentials, credentialRef);
	} catch {
		return { apiKey: "", error: "credentials-unavailable" };
	}
	const outcome = await raceWithAbortAndTimeout(
		Promise.resolve(pending),
		signal,
		SESSION_SELECTION_TIMEOUT_MS
	);
	if (outcome.status === "aborted") return { apiKey: "", error: "request-cancelled" };
	if (outcome.status === "timeout") return { apiKey: "", error: "credentials-timeout" };
	if (outcome.status !== "fulfilled") return { apiKey: "", error: "credentials-unavailable" };
	const apiKey = typeof outcome.value?.value === "string" && outcome.value.value.trim().length > 0
		? outcome.value.value
		: "";
	return apiKey ? { apiKey, error: null } : { apiKey: "", error: "missing-api-key" };
}

/** Read only the selected DSH service; lookup failures stay local to the query. */
function getConnectionService(connectionCtx, name) {
	try {
		return typeof connectionCtx?.get === "function" ? connectionCtx.get(name) : null;
	} catch {
		return null;
	}
}

export { apply, Config };
// Cordis loads a package's host plugin via its default export; expose it as
// an OBJECT (name/inject/apply/Config) so the loader preserves the `inject`
// metadata — a bare function default would drop `inject`, and cordis rejects
// `ctx.sessionProjections` access with "cannot get property without inject".
const plugin = { name, inject, Config, apply };
export default plugin;

/**
 * Call the official DeepSeek `/user/balance` endpoint and pick the total
 * available (`total_balance`) per currency. Never throws: on any failure it resolves
 * `{ balances: {CNY:null,USD:null}, error }`. Runs HOST-side (the browser asks
 * via the authenticated `/api` route and never holds the API key). Requests
 * can reach only the fixed official URL and redirects are rejected.
 */
async function fetchBalance(apiKey, signal, verifyRoute) {
	const empty = { balances: { CNY: null, USD: null }, error: null };
	if (!apiKey) return { ...empty, error: "missing-api-key" };
	const controller = new AbortController();
	const work = Promise.resolve().then(async () => {
		const routeCheck = typeof verifyRoute === "function" ? verifyRoute() : false;
		if (routeCheck !== true) {
			return { ...empty, error: typeof routeCheck === "string" ? routeCheck : "official-route-changed" };
		}
		const res = await fetch(OFFICIAL_BALANCE_URL, {
			headers: { Authorization: `Bearer ${apiKey}` },
			signal: controller.signal,
			redirect: "error"
		});
		if (!res.ok) return { ...empty, error: `http-${res.status}` };
		const parsed = await readBoundedBalanceJson(res, controller.signal);
		if (parsed.error) return { ...empty, error: parsed.error };
		const json = parsed.value;
		if (!json || typeof json !== "object" || Array.isArray(json) || !Array.isArray(json.balance_infos)) {
			return { ...empty, error: "invalid-response" };
		}
		const infos = json.balance_infos;
		const balances = { CNY: null, USD: null };
		for (const info of infos) {
			const cur = String(info?.currency ?? "").toUpperCase();
			if (cur === "CNY" || cur === "USD") balances[cur] = nonneg(info?.total_balance);
		}
		return { balances, error: null };
	});
	const outcome = await raceWithAbortAndTimeout(
		work,
		signal,
		OFFICIAL_BALANCE_TIMEOUT_MS,
		() => controller.abort(),
		() => controller.abort()
	);
	if (outcome.status === "aborted") return { ...empty, error: "request-cancelled" };
	if (outcome.status === "timeout") return { ...empty, error: "official-balance-timeout" };
	if (outcome.status !== "fulfilled") return { ...empty, error: "fetch-failed" };
	return outcome.value;
}

/** Read actual response bytes incrementally and stop as soon as the cap is crossed. */
async function readBoundedBalanceJson(response, signal) {
	const empty = { value: null, error: "invalid-response" };
	let reader;
	try {
		reader = response?.body?.getReader?.();
	} catch {
		return empty;
	}
	if (!reader || typeof reader.read !== "function") return empty;
	let byteLength = 0;
	const chunks = [];
	const cancel = () => {
		try { void Promise.resolve(reader.cancel()).catch(() => {}); } catch { /* Cancellation is best effort. */ }
	};
	try {
		signal?.addEventListener?.("abort", cancel, { once: true });
		if (signal?.aborted) cancel();
		for (;;) {
			const part = await reader.read();
			if (part?.done) break;
			const chunk = part?.value;
			if (!ArrayBuffer.isView(chunk) || chunk.BYTES_PER_ELEMENT !== 1
				|| !Number.isSafeInteger(chunk.byteLength) || chunk.byteLength < 0) {
				cancel();
				return empty;
			}
			if (chunk.byteLength > OFFICIAL_BALANCE_MAX_RESPONSE_BYTES - byteLength) {
				cancel();
				return { value: null, error: "response-too-large" };
			}
			byteLength += chunk.byteLength;
			chunks.push(chunk);
		}
		const bytes = new Uint8Array(byteLength);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.byteLength;
		}
		const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		return { value: JSON.parse(text), error: null };
	} catch {
		return empty;
	} finally {
		signal?.removeEventListener?.("abort", cancel);
		try { reader.releaseLock?.(); } catch { /* The read outcome is already decided. */ }
	}
}

/** Sum DSH's separate recharge and bonus wallet arrays per currency. */
function accountBalanceToBalances(outcome) {
	const balances = { CNY: null, USD: null };
	if (outcome?.status !== "ready" || !Array.isArray(outcome.value) || !Array.isArray(outcome.bonusWallets)) {
		return { balances, error: outcome === null ? "no-account-session" : "account-balance-unavailable" };
	}
	const totals = { CNY: 0, USD: 0 };
	const found = { CNY: false, USD: false };
	const invalid = { CNY: false, USD: false };
	for (const wallet of [...outcome.value, ...outcome.bonusWallets]) {
		const currency = String(wallet?.currency ?? "").toUpperCase();
		if (currency !== "CNY" && currency !== "USD") continue;
		found[currency] = true;
		const amount = nonneg(wallet?.balance);
		if (amount === null) invalid[currency] = true;
		else totals[currency] += amount;
	}
	for (const currency of ["CNY", "USD"]) {
		if (found[currency] && !invalid[currency]) balances[currency] = totals[currency];
	}
	return { balances, error: null };
}

/** AccountClientMetadata contains no secrets; DSH owns account tokens and auth headers. */
function accountClientMetadata(request) {
	let version = "unknown";
	let locale = request?.headers?.get("accept-language") ?? "";
	try {
		version = process.env.DSH_CLIENT_VERSION || version;
		if (!locale) locale = process.env.LANG || "en-US";
	} catch {
		// Keep safe defaults in restricted Host runtimes.
	}
	return {
		version,
		locale: String(locale).split(",", 1)[0].trim() || "en-US",
		timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60
	};
}

/** Coerce a balance value to a non-negative number. The API returns numeric
 *  strings (e.g. "33.20"); accept both numbers and numeric strings, else null. */
function nonneg(value) {
	let n;
	if (typeof value === "number") {
		n = value;
	} else if (typeof value === "string" && value.trim() !== "") {
		const numeric = value.trim();
		if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(numeric)) return null;
		n = Number(numeric);
	} else {
		return null;
	}
	return Number.isFinite(n) && n >= 0 ? n : null;
}
