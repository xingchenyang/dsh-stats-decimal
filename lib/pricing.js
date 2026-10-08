/**
 * dsh-stats-decimal — shared pricing model (CNY + USD, peak/valley).
 *
 * DeepSeek official price tables, per 1M tokens, split by model and by peak /
 * off-peak (valley) window:
 * - CNY: https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
 * - USD: https://api-docs.deepseek.com/quick_start/pricing/
 * - CN updates: https://api-docs.deepseek.com/zh-cn/updates
 * - EN updates: https://api-docs.deepseek.com/updates/
 *
 * `PRICE_HISTORY` is the billing source of truth. Its effective timestamps
 * make a replayed Session use the price that applied when each message was
 * produced, instead of retroactively applying today's price. `PRICES` remains
 * the latest-price compatibility view used by configuration and callers that
 * do not supply an event timestamp.
 *
 * Every cost computation uses these tables in integer-friendly currency
 * units (per 1M tokens in the target currency), never floats at the token
 * scale — see `costOf`.
 *
 * Date-only April announcements are represented at Beijing midnight and carry
 * `effectivePrecision: "date"`; exact August/September boundaries carry
 * `effectivePrecision: "instant"`.
 */
const flatPrice = (cny, usd) => ({
	cny: { peak: { ...cny }, valley: { ...cny } },
	usd: { peak: { ...usd }, valley: { ...usd } }
});

const V4_FLASH_LAUNCH = flatPrice(
	{ cacheHit: 0.2, cacheMiss: 1.0, output: 2.0 },
	{ cacheHit: 0.028, cacheMiss: 0.14, output: 0.28 }
);
const V4_FLASH_CACHE_CUT = flatPrice(
	{ cacheHit: 0.02, cacheMiss: 1.0, output: 2.0 },
	{ cacheHit: 0.0028, cacheMiss: 0.14, output: 0.28 }
);
const V4_PRO_LAUNCH = flatPrice(
	{ cacheHit: 1.0, cacheMiss: 12.0, output: 24.0 },
	{ cacheHit: 0.145, cacheMiss: 1.74, output: 3.48 }
);
const V4_PRO_PROMO = flatPrice(
	{ cacheHit: 0.25, cacheMiss: 3.0, output: 6.0 },
	{ cacheHit: 0.03625, cacheMiss: 0.435, output: 0.87 }
);
const V4_PRO_PROMO_CACHE_CUT = flatPrice(
	{ cacheHit: 0.025, cacheMiss: 3.0, output: 6.0 },
	{ cacheHit: 0.003625, cacheMiss: 0.435, output: 0.87 }
);
const V4_FLASH_PEAK_PRICES = {
	cny: {
		peak: { cacheHit: 0.1, cacheMiss: 3.0, output: 9.0 },
		valley: { cacheHit: 0.05, cacheMiss: 1.5, output: 4.5 }
	},
	usd: {
		peak: { cacheHit: 0.014, cacheMiss: 0.44, output: 1.32 },
		valley: { cacheHit: 0.007, cacheMiss: 0.22, output: 0.66 }
	}
};
const V4_PRO_PEAK_PRICES = {
	cny: {
		peak: { cacheHit: 0.3, cacheMiss: 9.0, output: 27.0 },
		valley: { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 }
	},
	usd: {
		peak: { cacheHit: 0.044, cacheMiss: 1.32, output: 3.96 },
		valley: { cacheHit: 0.022, cacheMiss: 0.66, output: 1.98 }
	}
};
const V41_FLASH_PRICES = {
	cny: {
		peak: { cacheHit: 0.04, cacheMiss: 2.0, output: 8.0 },
		valley: { cacheHit: 0.02, cacheMiss: 1.0, output: 4.0 }
	},
	usd: {
		peak: { cacheHit: 0.006, cacheMiss: 0.3, output: 1.2 },
		valley: { cacheHit: 0.003, cacheMiss: 0.15, output: 0.6 }
	}
};

const at = (iso) => Date.parse(iso);
const period = (effectiveFrom, effectivePrecision, prices, noticeId) => ({
	effectiveFrom: at(effectiveFrom),
	effectivePrecision,
	prices,
	noticeId
});

/** Stable official entry points used when maintaining the historical data. */
export const OFFICIAL_PRICING_SOURCES = {
	cnyPricing: "https://api-docs.deepseek.com/zh-cn/quick_start/pricing/",
	usdPricing: "https://api-docs.deepseek.com/quick_start/pricing/",
	cnUpdates: "https://api-docs.deepseek.com/zh-cn/updates",
	enUpdates: "https://api-docs.deepseek.com/updates/"
};

const bilingualNews = (slug) => ({
	zhCN: `https://api-docs.deepseek.com/zh-cn/news/${slug}/`,
	en: `https://api-docs.deepseek.com/news/${slug}/`
});
const bilingualPricing = {
	zhCN: OFFICIAL_PRICING_SOURCES.cnyPricing,
	en: OFFICIAL_PRICING_SOURCES.usdPricing
};

/**
 * Effective billing periods, ordered oldest -> newest for each API model id.
 * Values are per 1M tokens. This is also the data source for a future pricing
 * history step chart.
 */
export const PRICE_HISTORY = {
	"deepseek-flash": [
		period("2026-09-10T12:00:00+08:00", "instant", V41_FLASH_PRICES, "v41-flash-pricing")
	],
	"deepseek-v4-flash": [
		period("2026-04-24T00:00:00+08:00", "date", V4_FLASH_LAUNCH, "v4-launch"),
		period("2026-04-26T00:00:00+08:00", "date", V4_FLASH_CACHE_CUT, "v4-cache-hit-cut"),
		period("2026-08-17T00:00:00+08:00", "instant", V4_FLASH_PEAK_PRICES, "v4-peak-pricing"),
		period("2026-09-10T12:00:00+08:00", "instant", V41_FLASH_PRICES, "v41-flash-pricing")
	],
	"deepseek-v4-pro": [
		period("2026-04-24T00:00:00+08:00", "date", V4_PRO_LAUNCH, "v4-launch"),
		period("2026-04-25T00:00:00+08:00", "date", V4_PRO_PROMO, "v4-pro-promo"),
		period("2026-04-26T00:00:00+08:00", "date", V4_PRO_PROMO_CACHE_CUT, "v4-cache-hit-cut"),
		period("2026-08-17T00:00:00+08:00", "instant", V4_PRO_PEAK_PRICES, "v4-peak-pricing")
	],
	"deepseek-v4-flash-vision-exp": [
		period("2026-08-21T00:00:00+08:00", "date", V4_FLASH_PEAK_PRICES, "v4-flash-vision-launch"),
		period("2026-09-10T12:00:00+08:00", "instant", V41_FLASH_PRICES, "v41-flash-pricing")
	]
};

/**
 * Price-related announcements, including policy-only and withdrawn changes.
 * `cancelled` notices never create a period in `PRICE_HISTORY`.
 */
export const PRICE_NOTICES = [
	{ id: "context-cache-pricing", announcedOn: "2024-08-02", status: "effective", sources: bilingualNews("news0802") },
	{ id: "v3-pricing-and-promo", announcedOn: "2024-12-26", effectiveAt: "2025-02-09T00:00:00+08:00", status: "effective", sources: bilingualNews("news1226") },
	{ id: "r1-pricing", announcedOn: "2025-01-20", status: "effective", sources: bilingualNews("news250120") },
	{ id: "v31-pricing", announcedOn: "2025-08-21", effectiveAt: "2025-09-06T00:00:00+08:00", status: "effective", sources: bilingualNews("news250821") },
	{ id: "v32-exp-price-cut", announcedOn: "2025-09-29", status: "effective-date-precision", sources: bilingualNews("news250929") },
	{ id: "v4-launch", announcedOn: "2026-04-24", status: "effective", sources: bilingualNews("news260424") },
	{ id: "v4-pro-promo", announcedOn: "2026-04-25", status: "effective", sources: bilingualPricing },
	{ id: "v4-cache-hit-cut", announcedOn: "2026-04-26", status: "effective", sources: bilingualPricing },
	{ id: "v4-pro-permanent-price", announcedOn: "2026-05-22", effectiveAt: "2026-06-01T00:00:00+08:00", status: "effective-no-rate-change", sources: bilingualPricing },
	{ id: "v4-peak-pricing", announcedOn: "2026-08-13", effectiveAt: "2026-08-17T00:00:00+08:00", status: "effective", sources: bilingualNews("news260813") },
	{ id: "v4-flash-vision-launch", announcedOn: "2026-08-21", status: "effective", sources: bilingualNews("news260821") },
	{ id: "v41-flash-pricing", announcedOn: "2026-09-10", effectiveAt: "2026-09-10T12:00:00+08:00", status: "effective", sources: bilingualNews("news260910") },
	{ id: "v4-pro-routing-to-flash", announcedOn: "2026-09-10", effectiveAt: "2026-09-14T12:00:00+08:00", status: "cancelled", sources: bilingualPricing }
];

/** Latest-price compatibility view. */
export const PRICES = {
	"deepseek-flash": V41_FLASH_PRICES,
	"deepseek-v4-flash": V41_FLASH_PRICES,
	"deepseek-v4-pro": V4_PRO_PEAK_PRICES,
	"deepseek-v4-flash-vision-exp": V41_FLASH_PRICES
};

const OVERRIDDEN_MODELS = Symbol("overriddenPricingModels");

/** Default currencies, display order. */
export const DEFAULT_CURRENCIES = ["CNY", "USD"];

/** Number of decimals shown for a currency amount (truncated, never rounded). */
export const AMOUNT_DECIMALS = 2;

/**
 * Merge user price overrides onto a copy of the default table. Same shape as
 * `PRICES`: model -> { cny|usd -> { peak|valley -> {cacheHit, cacheMiss, output} } }.
 */
export function mergePricing(override) {
	const merged = {};
	const models = new Set([...Object.keys(PRICES), ...Object.keys(override ?? {})]);
	for (const model of models) {
		const modelPrices = PRICES[model] ?? {};
		const m = structuredClone(modelPrices);
		const overrideModel = override?.[model];
		merged[model] = m;
		if (!overrideModel) continue;
		for (const bc of ["cny", "usd"]) {
			const mCur = m[bc] ?? (m[bc] = {});
			const oCur = overrideModel[bc];
			if (!oCur) continue;
			for (const band of ["peak", "valley"]) {
				const oBand = oCur[band];
				if (!oBand) continue;
				mCur[band] = { ...(mCur[band] ?? {}), ...oBand };
			}
		}
	}
	Object.defineProperty(merged, OVERRIDDEN_MODELS, {
		value: new Set(Object.keys(override ?? {})),
		enumerable: false
	});
	return merged;
}

/** Select the price table effective for a model at an event timestamp. */
export function pricingAt(modelId, timeEpochMs, table = PRICES) {
	if (table?.[OVERRIDDEN_MODELS]?.has(modelId)) return table[modelId] ?? null;
	if (!Number.isFinite(timeEpochMs)) return table?.[modelId] ?? null;
	const history = PRICE_HISTORY[modelId];
	if (!history) return table?.[modelId] ?? null;
	let selected = null;
	for (const entry of history) {
		if (entry.effectiveFrom > timeEpochMs) break;
		selected = entry.prices;
	}
	return selected;
}

/**
 * Map a usage bucket set to a BillingAmount per currency using the official
 * price tables. `cacheWriteTokens` is billed at the cache-HIT rate (per the
 * user's stated official semantics), `uncachedInputTokens` at the cache-MISS
 * rate, `outputTokens` at the output rate.
 *
 * @param usage token buckets ({uncachedInputTokens, cacheReadTokens, cacheWriteTokens, outputTokens})
 * @param modelId model id
 * @param band 'peak' | 'valley'
 * @param currencies enabled currency codes (subset of ['CNY','USD'])
 * @param table optional merged pricing table (defaults to PRICES)
 * @param timeEpochMs optional event timestamp; omitted means current prices
 * @returns { currency -> number adjusted balance delta}
 */
export function costOf(usage, modelId, band, currencies, table = PRICES, timeEpochMs) {
	const pricesTable = table ?? PRICES;
	const modelTable = pricingAt(modelId, timeEpochMs, pricesTable);
	if (!modelTable) return null;
	const out = {};
	for (const currency of currencies) {
		const p = modelTable[currencyKey(currency)]?.[band];
		if (!isCompletePrice(p)) return null;
		// Per 1M tokens, so divide the token sum by 1e6 once.
		const usd30 = (usage.uncachedInputTokens ?? 0) * p.cacheMiss
			+ ((usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)) * p.cacheHit
			+ (usage.outputTokens ?? 0) * p.output;
		out[currency] = usd30 / 1e6;
	}
	return out;
}

function isCompletePrice(price) {
	return price !== null
		&& typeof price === "object"
		&& [price.cacheHit, price.cacheMiss, price.output]
			.every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0);
}

function currencyKey(currency) {
	return currency.toLowerCase();
}

/**
 * Apply a peak/valley band to a single event time.
 *
 * `peakHours` is a set of **Beijing-time (Asia/Shanghai, fixed UTC+8)** hours
 * (0-23 integers) treated as peak; any hour not in the set is valley. The
 * event's absolute epoch ms is shifted to the fixed UTC+8 day and its hour
 * read via `getUTCHours` — this is timezone- and DST-independent, so the same
 * configuration bills identically no matter which time zone the DSH host runs
 * in (incl. seasonal DST changes). Peak/valley always follows Beijing local
 * time, matching the official DeepSeek pricing periods.
 *
 * Saturdays and Sundays in Beijing time are always valley, regardless of
 * `peakHours`. On weekdays, an empty set means always valley and a full set
 * means always peak.
 *
 * @param timeEpochMs absolute epoch ms (SessionEvent.time)
 * @param peakHours array of peak hours (0-23) in Beijing time
 * @returns 'peak' | 'valley'
 */
export function bandForTime(timeEpochMs, peakHours) {
	if (!Array.isArray(peakHours) || peakHours.length === 0) return "valley";
	// Asia/Shanghai has no DST and is fixed UTC+8.
	const beijingTime = new Date(timeEpochMs + 8 * 60 * 60 * 1000);
	const beijingDay = beijingTime.getUTCDay();
	if (beijingDay === 0 || beijingDay === 6) return "valley";
	const beijingHour = beijingTime.getUTCHours();
	return peakHours.includes(beijingHour) ? "peak" : "valley";
}

/**
 * The natural-day start (local) of the given epoch ms, as an epoch ms, using
 * DSH machine local time. Used to decide "today" cut.
 */
export function localDayStart(timeEpochMs) {
	const d = new Date(timeEpochMs);
	const s = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
	return s.getTime();
}

/**
 * Whether the given epoch ms falls on the same local calendar day as now
 * (defaults to Date.now()).
 */
export function isSameLocalDay(timeEpochMs, nowEpochMs = Date.now()) {
	return localDayStart(timeEpochMs) === localDayStart(nowEpochMs);
}
