/**
 * dsh-stats-decimal — node/host half.
 *
 * Registers one session projection served to the browser conversation dock:
 *
 *  `billingLedger` — a pure fold of `assistant/message` usage events into
 *  per-currency (CNY / USD) session **cumulative** and **today** cost. Each
 *  message is priced by its model id, the Beijing-time peak/valley band of its
 *  `SessionEvent.time`, official HIT / MISS / OUTPUT rates, and optional
 *  model-specific CACHE WRITE rates. Zero
 *  network; the fold replays history, so re-opening an old session yields the
 *  same totals the live session shows.
 *
 * The account-balance row is deliberately NOT computed here and NOT carried
 * by a session event: the session log refuses to load any event whose type it
 * does not know unless it is marked `ignorable`, and this host half has no way
 * to attach that marker (see the session.append envelope). Persisting a custom
 * `stats-decimal/balance` event would permanently corrupt every session it was
 * appended to. The browser requests balance over authenticated RPC; this Host
 * half resolves the API key through DSH's credentials service or delegates
 * account-login reads to DSH's deepseekAccount service, keeping credentials and plugin-specific events out
 * of the browser and durable agent log.
 */
import z from "@deepseek-ai/schemastery";
import { z as zod } from "zod";
import { holidaySpansForClient } from "./billing-calendar/index.js";
import { costOf, bandForTime, localDayStart, mergePricing } from "./pricing.js";

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
	// Balance is controlled only by `balance.enabled` (disabled by default). Reuse DSH's
	// existing DEEPSEEK_API_KEY credential; do not configure a key here.
	balance: z.object({
		enabled: z.boolean().default(false),
		apiBase: z.string().default("https://api.deepseek.com")
	}).default({})
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

// Client view shape. The supported DSH v0.2.0-rc.1 projection contract exposes
// the client-visible part under `wire.viewSchema`; older versions are not a
// compatibility target.
// Without a `wire` the projection is not client-visible and its row
// never renders in the conversation dock.
const BILLING_LEDGER_SCHEMA = zod.object({
	enabled: zod.boolean(),
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

/** Return the real Beijing calendar date, independent of the Host time zone. */
function beijingDateKey(timeEpochMs) {
	if (!Number.isFinite(timeEpochMs)) return null;
	return new Date(timeEpochMs + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * Sum costs from the current Beijing day across DSH's live and persisted
 * session corpus. SessionQuery returns replay-validated detached logs; only
 * child-owned events are billed so fork-inherited prefixes are not counted
 * twice. The raw events remain on the Host and never enter the browser RPC.
 */
async function aggregateSessionDailyCost(sessionQuery, date, peakHours, currencies, table) {
	const unavailable = { status: "unavailable", date, sessionCount: 0 };
	if (typeof sessionQuery?.listSessions !== "function" || typeof sessionQuery?.readSession !== "function") {
		return unavailable;
	}
	try {
		const records = await sessionQuery.listSessions();
		if (!Array.isArray(records)) return unavailable;
		const sessionIds = records.map((record) => {
			const sessionId = record?.header?.id;
			if (typeof sessionId !== "string" || sessionId.length === 0) throw new TypeError("Invalid session query record");
			return sessionId;
		});
		const totals = { CNY: 0, USD: 0 };
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
				for (const event of snapshot.events) {
					if (event.seq < snapshot.inheritedEventCount || event.type !== "assistant/message") continue;
					const usage = event.data?.usage;
					if (usage === void 0 || usage === null || beijingDateKey(event.time) !== date) continue;
					sessionHasUsage = true;
					const delta = costOf({
						uncachedInputTokens: usage.inputTokens ?? 0,
						cacheReadTokens: usage.cacheReadTokens ?? 0,
						cacheWriteTokens: usage.cacheWriteTokens ?? 0,
						outputTokens: usage.outputTokens ?? 0
					}, event.data.message?.source?.model, bandForTime(event.time, peakHours), currencies, table, event.time);
					if (delta === null || currencies.some((currency) => !Number.isFinite(delta[currency]) || delta[currency] < 0)) {
						pricingKnown = false;
						continue;
					}
					for (const currency of currencies) totals[currency] += delta[currency] ?? 0;
				}
				if (sessionHasUsage) sessionCount += 1;
			}
		}
		if (currencies.some((currency) => !Number.isFinite(totals[currency]) || totals[currency] < 0)) pricingKnown = false;
		return {
			status: pricingKnown ? "ready" : "unknown",
			date,
			totals,
			sessionCount
		};
	} catch {
		// A partial scan must never be presented as a complete all-session total.
		return unavailable;
	}
}

/**
 * Node/host plugin apply. Registers the `billingLedger` projection (a pure
 * fold of `assistant/message` cost — the only session-affecting work this half
 * does) and a balance endpoint under the authenticated shared `/api` route,
 * which returns the recharge balance using the key resolved by DSH's
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
		const balanceCfg = cfg.balance ?? {};
		const balanceEnabled = Boolean(balanceCfg.enabled);
		const apiBase = String(balanceCfg.apiBase ?? "https://api.deepseek.com").replace(/\/+$/, "");
		let sessionDailyCache = null;
		let sessionDailyCacheAt = 0;
		let sessionDailyInFlight = null;
		ctx.inject(["connection"], (connectionCtx) => {
			const connection = connectionCtx.connection;
			if (typeof connection?.fetch?.register !== "function") return;
			const getBalanceResult = async (signal, request) => {
				if (!balanceEnabled) {
					return { ok: true, value: { enabled: false, balances: { CNY: null, USD: null }, error: null } };
				}
				let credentials;
				try {
					credentials = typeof connectionCtx.get === "function"
						? connectionCtx.get("credentials")
						: connectionCtx.credentials;
				} catch {
					credentials = null;
				}
				const apiKey = await resolveBalanceKey(credentials);
				if (apiKey) {
					const result = await fetchBalance(apiBase, apiKey, signal);
					if (result.error && typeof ctx.logger === "function") ctx.logger("stats-decimal").warn(`balance fetch failed: ${String(result.error)}`);
					return { ok: true, value: { enabled: true, balances: result.balances, error: result.error } };
				}

				// Account grants are separate from DEEPSEEK_API_KEY. Resolve this
				// optional service for each request so API-key-only profiles do not
				// wait for it or need a static dependency on the account provider.
				const deepseekAccount = typeof connectionCtx.get === "function"
					? connectionCtx.get("deepseekAccount")
					: null;
				if (typeof deepseekAccount?.getBalance === "function") {
					try {
						const accountBalance = await deepseekAccount.getBalance(accountClientMetadata(request));
						const result = accountBalanceToBalances(accountBalance);
						return { ok: true, value: { enabled: true, balances: result.balances, error: result.error } };
					} catch {
						if (typeof ctx.logger === "function") ctx.logger("stats-decimal").warn("account balance fetch failed");
						return { ok: true, value: { enabled: true, balances: { CNY: null, USD: null }, error: "account-balance-failed" } };
					}
				}

				if (typeof ctx.logger === "function") ctx.logger("stats-decimal").warn("balance enabled but neither DEEPSEEK_API_KEY nor DSH account balance service is available");
				return { ok: true, value: { enabled: true, balances: { CNY: null, USD: null }, error: "no-balance-credentials" } };
			};
			const getSessionDailyCost = async () => {
				const date = beijingDateKey(Date.now());
				if (!costEnabled) return { status: "unavailable", date, sessionCount: 0 };
				const now = Date.now();
				if (sessionDailyCache?.date === date && now - sessionDailyCacheAt < 60_000) return sessionDailyCache;
				if (sessionDailyInFlight?.date === date) return sessionDailyInFlight.promise;
				let sessionQuery;
				try {
					sessionQuery = typeof connectionCtx.get === "function"
						? connectionCtx.get("sessionQuery")
						: connectionCtx.sessionQuery;
				} catch {
					sessionQuery = null;
				}
				const promise = aggregateSessionDailyCost(sessionQuery, date, peakHours, activeCurrencies, table)
					.then((result) => {
						sessionDailyCache = result;
						sessionDailyCacheAt = Date.now();
						return result;
					})
					.finally(() => {
						if (sessionDailyInFlight?.promise === promise) sessionDailyInFlight = null;
					});
				sessionDailyInFlight = { date, promise };
				return promise;
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
					return Response.json({
						type: "server-response",
						rpcId: message.rpcId,
						result: await getBalanceResult(request.signal, request)
					});
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
						result: { ok: true, value: await getSessionDailyCost() }
					});
				}
			}), "stats-decimal: session daily cost endpoint");
		});
	}
}

/**
 * Resolve the DeepSeek API key through DSH's credentials capability. The
 * service owns its storage and environment precedence; this plugin does not
 * read DSH credential files or process environment directly. Returns "" when
 * no key is resolved so account login or the no-credentials result can apply.
 */
async function resolveBalanceKey(credentials) {
	if (typeof credentials?.resolve !== "function") return "";
	try {
		const resolved = await credentials.resolve("DEEPSEEK_API_KEY");
		return typeof resolved?.value === "string" && resolved.value.length > 0 ? resolved.value : "";
	} catch {
		return "";
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
 * Call the official DeepSeek `/user/balance` endpoint and pick the recharge
 * (topped-up) balance per currency. Never throws: on any failure it resolves
 * `{ balances: {CNY:null,USD:null}, error }`. Runs HOST-side (the browser asks
 * via the authenticated `/api` route and never holds the API key).
 */
async function fetchBalance(apiBase, apiKey, signal) {
	const empty = { balances: { CNY: null, USD: null }, error: null };
	if (!apiKey) return { ...empty, error: "no-api-key" };
	try {
		const res = await fetch(`${apiBase}/user/balance`, {
			headers: { Authorization: `Bearer ${apiKey}` },
			signal
		});
		if (!res.ok) return { ...empty, error: `http-${res.status}` };
		const json = await res.json();
		const infos = Array.isArray(json?.balance_infos) ? json.balance_infos : [];
		const balances = { CNY: null, USD: null };
		for (const info of infos) {
			const cur = String(info?.currency ?? "").toUpperCase();
			if (cur === "CNY" || cur === "USD") balances[cur] = nonneg(info?.topped_up_balance);
		}
		return { balances, error: null };
	} catch {
		return { ...empty, error: "fetch-failed" };
	}
}

/** Convert DSH's credential-safe AccountDetails balance outcome to CNY/USD. */
function accountBalanceToBalances(outcome) {
	const balances = { CNY: null, USD: null };
	if (outcome?.status !== "ready" || !Array.isArray(outcome.value)) {
		return { balances, error: outcome === null ? "no-account-session" : "account-balance-unavailable" };
	}
	for (const wallet of outcome.value) {
		const currency = String(wallet?.currency ?? "").toUpperCase();
		if (currency === "CNY" || currency === "USD") balances[currency] = nonneg(wallet?.balance);
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
