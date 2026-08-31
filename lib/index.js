/**
 * dsh-stats-decimal — node/host half.
 *
 * Registers one session projection served to the browser conversation dock:
 *
 *  `billingLedger` — a pure fold of `assistant/message` usage events into
 *  per-currency (CNY / USD) session **cumulative** and **today** cost. Each
 *  message is priced by its model id, the local-time peak/valley band of its
 *  `SessionEvent.time`, and the official HIT / MISS / OUTPUT rates. Zero
 *  network; the fold replays history, so re-opening an old session yields the
 *  same totals the live session shows.
 *
 * The account-balance row is deliberately NOT computed here and NOT carried
 * by a session event: the session log refuses to load any event whose type it
 * does not know unless it is marked `ignorable`, and this host half has no way
 * to attach that marker (see the session.append envelope). Persisting a custom
 * `stats-decimal/balance` event would permanently corrupt every session it was
 * appended to. The balance is therefore fetched in the BROWSER half
 * (`lib/client.js`), which reads the `balance` config from the client-side
 * bundle — keeping the durable agent log free of plugin-specific event types.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import z from "@deepseek-ai/schemastery";
import { z as zod } from "zod";
import { costOf, bandForTime, localDayStart, mergePricing, FALLBACK_MODEL } from "./pricing.js";

/** Cordis plugin name. */
export const name = "stats-decimal";

const Config = z.object({
	// 计价总开关（默认关：无配置时第三行成本账本不显示，完全由配置驱动）
	enableCost: z.boolean().default(false),
	// 币种开关（默认关）
	cnyEnabled: z.boolean().default(false),
	usdEnabled: z.boolean().default(false),
	// 峰值小时（北京时间 UTC+8, 0-23）；不在集合内视为谷。空集合 -> 全程谷。
	// 示例：北京峰 9-12、14-18 => [9,10,11,14,15,16,17]。与宿主机器时区/冬夏令时无关。
	peakHours: z.array(z.natural().max(23)).default([]),
	// 峰谷价格覆盖（默认取 lib/pricing.js 官方价目）。shape: { model: { cny|usd: { peak|valley: {cacheHit,cacheMiss,output} } } }
	overridePricing: z.dict(z.any()).default({}),
	// 账号余额：唯一开关是 `balance.enabled`（默认关闭）。Key 自动复用 DSH
	// 现有 DEEPSEEK_API_KEY 凭据，无需、也不应在此配置。
	balance: z.object({
		enabled: z.boolean().default(false),
		apiBase: z.string().default("https://api.deepseek.com")
	}).default({})
});

const ZERO_LEDGER = () => ({ cumulative: { CNY: 0, USD: 0 }, today: { CNY: 0, USD: 0 }, todayStamp: null });

// Internal projection state shape carried by `init`/`apply`. Distinct from the
// client view (`BILLING_LEDGER_SCHEMA`): the state also holds `todayStamp`, the
// local-day epoch "today" refers to, which is how the day cut survives folds.
const BILLING_LEDGER_STATE_SCHEMA = zod.object({
	cumulative: zod.object({ CNY: zod.number().nonnegative(), USD: zod.number().nonnegative() }).strict(),
	today: zod.object({ CNY: zod.number().nonnegative(), USD: zod.number().nonnegative() }).strict(),
	todayStamp: zod.number().nullable()
}).strict();

// Client view shape. Since dsh v0.1.1-rc.2 this is the `wire.viewSchema` of a
// projection; without a `wire` the projection is not client-visible and its row
// never renders in the conversation dock.
const BILLING_LEDGER_SCHEMA = zod.object({
	enabled: zod.boolean(),
	currencies: zod.array(zod.enum(["CNY", "USD"])),
	cumulative: zod.object({ CNY: zod.number().nonnegative(), USD: zod.number().nonnegative() }).strict(),
	today: zod.object({ CNY: zod.number().nonnegative(), USD: zod.number().nonnegative() }).strict()
}).strict();

/** Projection registry is required; Connection (for the balance RPC) is gated
 *  separately via an inner `ctx.inject` so the ledger still works in profiles
 *  that only mount projections. */
export const inject = ["sessionProjections"];

/** Fold one usage record into the running ledger (pure). Preserves the
 *  `todayStamp` (the local day `today` refers to) so it survives folds. */
function foldUsage(state, buckets, model, band, currencies, table, today) {
	const delta = costOf(buckets, model, band, currencies, table);
	if (delta == null) return state;
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
	return { cumulative, today: todayCur, todayStamp: state.todayStamp };
}

/**
 * Node/host plugin apply. Registers the `billingLedger` projection (a pure
 * fold of `assistant/message` cost — the only session-affecting work this half
 * does) and a loopback-only RPC channel `/stats-decimal` whose `getBalance`
 * endpoint returns the recharge balance using the host-side `balance.apiKey`.
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
			const model = event.data.message?.source?.model ?? FALLBACK_MODEL;
			const band = bandForTime(event.time, peakHours);
			// 今日消费 = 事件所在本地自然日 == 最近一次事件所在日。跨天（或回放
			// 到另一历史日）时先清零 today，再累加当天，避免昨日/今日混算。
			const dayStamp = localDayStart(event.time);
			let base = state;
			if (state.todayStamp !== dayStamp) {
				base = { cumulative: state.cumulative, today: { CNY: 0, USD: 0 }, todayStamp: dayStamp };
			}
			const next = foldUsage(base, buckets, model, band, activeCurrencies, table, true);
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
				cumulative: { ...state.cumulative },
				today: { ...state.today }
			})
		},
		stateVersion: 1
	};
	ctx.sessionProjections.register(billingLedger);

	// Balance RPC: loopback-only channel. The DeepSeek key stays host-side
	// (auto-reused from the DSH credentials, never configured here). No session
	// event is ever written. The channel is registered unconditionally when the
	// connection service exists; `getBalance` returns `{ enabled, balances,
	// error }` so the client renders the balance row ONLY when `enabled` — a
	// single `balance.enabled` switch controls it.
	if (true) {
		const balanceCfg = cfg.balance ?? {};
		const balanceEnabled = Boolean(balanceCfg.enabled);
		const apiBase = String(balanceCfg.apiBase ?? "https://api.deepseek.com").replace(/\/+$/, "");
		ctx.inject(["connection", "credentials"], (connectionCtx) => {
			const rpc = connectionCtx.connection?.rpc;
			const credentials = connectionCtx.credentials;
			if (!rpc || typeof rpc.handle !== "function") return;
			rpc.handle("/stats-decimal", async (endpoint, payload, signal) => {
				if (endpoint !== "getBalance") {
					return { ok: false, error: { code: "bad-request", message: `unknown endpoint ${JSON.stringify(endpoint)}`, details: { issues: [] } } };
				}
				if (!balanceEnabled) {
					return { ok: true, value: { enabled: false, balances: { CNY: null, USD: null }, error: null } };
				}
				const apiKey = await resolveBalanceKey(credentials);
				if (!apiKey) {
					if (typeof ctx.logger === "function") ctx.logger("stats-decimal").warn("balance enabled but no DEEPSEEK_API_KEY resolved (credentials/env empty)");
					return { ok: true, value: { enabled: true, balances: { CNY: null, USD: null }, error: "no-api-key" } };
				}
				const result = await fetchBalance(apiBase, apiKey, signal);
				if (result.error && typeof ctx.logger === "function") ctx.logger("stats-decimal").warn(`balance fetch failed: ${String(result.error)}`);
				return { ok: true, value: { enabled: true, balances: result.balances, error: result.error } };
			}, { authority: "loopback" });
		});
	}
}

/**
 * Resolve the DeepSeek API key for the balance fetch. The `.credentials.yaml`
 * direct-read path is the diag-verified one (the file > credentials > env
 * order). Returns "" when none is found (balance then shows "–", no request).
 */
async function resolveBalanceKey(credentials) {
	// 1) Direct read of $DSH_HOME/.credentials.yaml (the reliable, diag-proven
	//    source for DEEPSEEK_API_KEY). Order matches dsh-credentials-local's
	//    file layer and the official endpoint worked with this file's key.
	try {
		const fromFile = readCredentialsFile();
		if (fromFile) return fromFile;
	} catch {
		// fall through
	}
	// 2) credentials service
	if (credentials && typeof credentials.resolve === "function") {
		try {
			const resolved = await credentials.resolve("DEEPSEEK_API_KEY");
			if (resolved?.value) return resolved.value;
		} catch {
			// fall through to env
		}
	}
	// 3) process env
	try {
		const fromEnv = process.env.DEEPSEEK_API_KEY;
		if (fromEnv) return fromEnv;
	} catch {
		// sandbox without process access
	}
	return "";
}

/** Read `DEEPSEEK_API_KEY: <value>` from `$DSH_HOME/.credentials.yaml`. */
function readCredentialsFile() {
	const dshHome = process.env.DSH_HOME || (process.env.USERPROFILE ? `${process.env.USERPROFILE}\\.dsh` : "");
	if (!dshHome) return "";
	try {
		return readKeyFromFile(join(dshHome, ".credentials.yaml"));
	} catch {
		return "";
	}
}

/** Read one `DEEPSEEK_API_KEY: xxx` line from a YAML-ish credentials file. */
function readKeyFromFile(filePath) {
	if (!existsSync(filePath)) return "";
	const raw = readFileSync(filePath, "utf8");
	const m = /DEEPSEEK_API_KEY:\s*(.+?)\s*[\r\n]?$/.exec(raw);
	if (!m) return "";
	return m[1].trim();
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
 * via the `/stats-decimal` RPC and never holds the API key).
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
	} catch (err) {
		return { ...empty, error: String(err?.name ?? "fetch-failed") };
	}
}

/** Coerce a balance value to a non-negative number. The API returns numeric
 *  strings (e.g. "33.20"); accept both numbers and numeric strings, else null. */
function nonneg(value) {
	let n;
	if (typeof value === "number") {
		n = value;
	} else if (typeof value === "string" && value.trim() !== "") {
		n = Number.parseFloat(value);
	} else {
		return null;
	}
	return Number.isFinite(n) && n >= 0 ? n : null;
}
