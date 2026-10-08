/**
 * dsh-stats-decimal — shared pricing model (CNY + USD, peak/valley).
 *
 * DeepSeek official price table, per 1M tokens, split by model and by peak /
 * off-peak (valley) window. Values are the vendor-facing prices supplied by
 * the user (uploaded 2026-08 pricing). Models that share a price row are
 * expanded explicitly so a per-message model lookup is a direct map read.
 *
 * Every cost computation uses these tables in integer-friendly currency
 * units (per 1M tokens in the target currency), never floats at the token
 * scale — see `costOf`.
 *
 * Model id -> price classes. `depth` is unused for billing (kept out of the
 * cost path). Vision mirrors flash pricing per the official table.
 */
export const PRICES = {
	"deepseek-v4-flash": {
		cny: {
			peak: { cacheHit: 0.1, cacheMiss: 3.0, output: 9.0 },
			valley: { cacheHit: 0.05, cacheMiss: 1.5, output: 4.5 }
		},
		usd: {
			peak: { cacheHit: 0.014, cacheMiss: 0.44, output: 1.32 },
			valley: { cacheHit: 0.007, cacheMiss: 0.22, output: 0.66 }
		}
	},
	"deepseek-v4-pro": {
		cny: {
			peak: { cacheHit: 0.3, cacheMiss: 9.0, output: 27.0 },
			valley: { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 }
		},
		usd: {
			peak: { cacheHit: 0.044, cacheMiss: 1.32, output: 3.96 },
			valley: { cacheHit: 0.022, cacheMiss: 0.66, output: 1.98 }
		}
	},
	"deepseek-v4-flash-vision-exp": {
		cny: {
			peak: { cacheHit: 0.1, cacheMiss: 3.0, output: 9.0 },
			valley: { cacheHit: 0.05, cacheMiss: 1.5, output: 4.5 }
		},
		usd: {
			peak: { cacheHit: 0.014, cacheMiss: 0.44, output: 1.32 },
			valley: { cacheHit: 0.007, cacheMiss: 0.22, output: 0.66 }
		}
	}
};

/** Default currencies, display order. */
export const DEFAULT_CURRENCIES = ["CNY", "USD"];

/** Number of decimals shown for a currency amount (truncated, never rounded). */
export const AMOUNT_DECIMALS = 2;

/** Model id fallback when a session used an unlisted model id. */
export const FALLBACK_MODEL = "deepseek-v4-flash";

/**
 * Merge user price overrides onto a copy of the default table. Same shape as
 * `PRICES`: model -> { cny|usd -> { peak|valley -> {cacheHit, cacheMiss, output} } }.
 */
export function mergePricing(override) {
	const merged = {};
	for (const [model, modelPrices] of Object.entries(PRICES)) {
		const m = structuredClone(modelPrices);
		const overrideModel = override?.[model];
		merged[model] = m;
		if (!overrideModel) continue;
		for (const bc of ["cny", "usd"]) {
			const mCur = m[bc];
			const oCur = overrideModel[bc];
			if (!oCur) continue;
			for (const band of ["peak", "valley"]) {
				const oBand = oCur[band];
				if (!oBand) continue;
				mCur[band] = { ...(mCur[band] ?? {}), ...oBand };
			}
		}
	}
	return merged;
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
 * @returns { currency -> number adjusted balance delta}
 */
export function costOf(usage, modelId, band, currencies, table = PRICES) {
	const pricesTable = table ?? PRICES;
	const modelTable = pricesTable[modelId] ?? pricesTable[FALLBACK_MODEL];
	const out = {};
	for (const currency of currencies) {
		const p = modelTable[currencyKey(currency)]?.[band];
		if (!p) {
			out[currency] = 0;
			continue;
		}
		// Per 1M tokens, so divide the token sum by 1e6 once.
		const usd30 = (usage.uncachedInputTokens ?? 0) * p.cacheMiss
			+ ((usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)) * p.cacheHit
			+ (usage.outputTokens ?? 0) * p.output;
		out[currency] = usd30 / 1e6;
	}
	return out;
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
 * Empty set -> always valley. Full set -> always peak.
 *
 * @param timeEpochMs absolute epoch ms (SessionEvent.time)
 * @param peakHours array of peak hours (0-23) in Beijing time
 * @returns 'peak' | 'valley'
 */
export function bandForTime(timeEpochMs, peakHours) {
	if (!Array.isArray(peakHours) || peakHours.length === 0) return "valley";
	// Asia/Shanghai has no DST and is fixed UTC+8.
	const beijingHour = new Date(timeEpochMs + 8 * 60 * 60 * 1000).getUTCHours();
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
