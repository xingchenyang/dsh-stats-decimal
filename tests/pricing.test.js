import assert from "node:assert/strict";
import test from "node:test";
import { PRICE_HISTORY, PRICE_NOTICES, PRICES, bandForTime, costOf, mergePricing, pricingAt } from "../lib/pricing.js";

const FLASH_IDS = [
	"deepseek-flash",
	"deepseek-v4-flash",
	"deepseek-v4-flash-vision-exp"
];

test("all accepted Flash ids use the current V4.1 Flash prices", () => {
	for (const model of FLASH_IDS) assert.deepEqual(PRICES[model], PRICES["deepseek-flash"]);
	assert.deepEqual(PRICES["deepseek-flash"], {
		cny: {
			peak: { cacheHit: 0.04, cacheMiss: 2, output: 8 },
			valley: { cacheHit: 0.02, cacheMiss: 1, output: 4 }
		},
		usd: {
			peak: { cacheHit: 0.006, cacheMiss: 0.3, output: 1.2 },
			valley: { cacheHit: 0.003, cacheMiss: 0.15, output: 0.6 }
		}
	});
});

test("V4 Pro prices remain unchanged", () => {
	assert.deepEqual(PRICES["deepseek-v4-pro"], {
		cny: {
			peak: { cacheHit: 0.3, cacheMiss: 9, output: 27 },
			valley: { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 }
		},
		usd: {
			peak: { cacheHit: 0.044, cacheMiss: 1.32, output: 3.96 },
			valley: { cacheHit: 0.022, cacheMiss: 0.66, output: 1.98 }
		}
	});
});

test("historical prices switch at the exact official August and September boundaries", () => {
	const beforePeak = Date.parse("2026-08-16T15:59:59.999Z");
	const peakStart = Date.parse("2026-08-16T16:00:00Z");
	const beforeV41 = Date.parse("2026-09-10T03:59:59.999Z");
	const v41Start = Date.parse("2026-09-10T04:00:00Z");

	assert.deepEqual(pricingAt("deepseek-v4-flash", beforePeak).cny.peak, { cacheHit: 0.02, cacheMiss: 1, output: 2 });
	assert.deepEqual(pricingAt("deepseek-v4-flash", peakStart).cny.peak, { cacheHit: 0.1, cacheMiss: 3, output: 9 });
	assert.deepEqual(pricingAt("deepseek-v4-flash", beforeV41).usd.valley, { cacheHit: 0.007, cacheMiss: 0.22, output: 0.66 });
	assert.deepEqual(pricingAt("deepseek-v4-flash", v41Start).usd.valley, { cacheHit: 0.003, cacheMiss: 0.15, output: 0.6 });
});

test("Pro keeps its own price after the cancelled September routing plan", () => {
	const afterCancelledPlan = Date.parse("2026-09-14T04:00:00Z");
	assert.deepEqual(pricingAt("deepseek-v4-pro", afterCancelledPlan), PRICES["deepseek-v4-pro"]);
	assert.equal(PRICE_HISTORY["deepseek-v4-pro"].at(-1).noticeId, "v4-peak-pricing");
	const cancelled = PRICE_NOTICES.find((notice) => notice.id === "v4-pro-routing-to-flash");
	assert.equal(cancelled?.status, "cancelled");
	assert.match(cancelled?.sources.zhCN, /\/zh-cn\/quick_start\/pricing\/$/);
	assert.match(cancelled?.sources.en, /\/quick_start\/pricing\/$/);
});

test("price-related news keeps paired Chinese and English official sources", () => {
	const release = PRICE_NOTICES.find((notice) => notice.id === "v41-flash-pricing");
	assert.equal(release?.sources.zhCN, "https://api-docs.deepseek.com/zh-cn/news/news260910/");
	assert.equal(release?.sources.en, "https://api-docs.deepseek.com/news/news260910/");
	assert.equal(PRICE_NOTICES.find((notice) => notice.id === "context-cache-pricing")?.sources.zhCN, "https://api-docs.deepseek.com/zh-cn/news/news0802/");
	assert.equal(PRICE_NOTICES.find((notice) => notice.id === "v31-pricing")?.effectiveAt, "2025-09-06T00:00:00+08:00");
});

test("new model ids remain unknown before they existed", () => {
	assert.equal(pricingAt("deepseek-flash", Date.parse("2026-09-10T03:59:59.999Z")), null);
	assert.equal(pricingAt("deepseek-v4-flash-vision-exp", Date.parse("2026-08-20T15:59:59.999Z")), null);
});

test("April date-precision periods retain launch, promo, and cache-cut prices", () => {
	assert.deepEqual(pricingAt("deepseek-v4-pro", Date.parse("2026-04-24T12:00:00+08:00")).cny.valley, { cacheHit: 1, cacheMiss: 12, output: 24 });
	assert.deepEqual(pricingAt("deepseek-v4-pro", Date.parse("2026-04-25T12:00:00+08:00")).cny.valley, { cacheHit: 0.25, cacheMiss: 3, output: 6 });
	assert.deepEqual(pricingAt("deepseek-v4-pro", Date.parse("2026-04-26T12:00:00+08:00")).cny.valley, { cacheHit: 0.025, cacheMiss: 3, output: 6 });
	assert.equal(PRICE_HISTORY["deepseek-v4-pro"][0].effectivePrecision, "date");
});

test("costOf uses historical prices when an event timestamp is supplied", () => {
	const usage = { uncachedInputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1_000_000 };
	assert.deepEqual(costOf(usage, "deepseek-v4-flash", "valley", ["CNY", "USD"], PRICES, Date.parse("2026-08-01T00:00:00Z")), {
		CNY: 3,
		USD: 0.42
	});
});

test("Beijing weekday peak hours and weekend off-peak are stable across host time zones", () => {
	const peakHours = [9, 10, 11, 14, 15, 16, 17];
	assert.equal(bandForTime(Date.UTC(2026, 8, 14, 1, 0), peakHours), "peak");
	assert.equal(bandForTime(Date.UTC(2026, 8, 14, 4, 0), peakHours), "valley");
	assert.equal(bandForTime(Date.UTC(2026, 8, 12, 2, 0), peakHours), "valley");
	assert.equal(bandForTime(Date.UTC(2026, 8, 14, 1, 0), []), "valley");
});

test("costOf uses cache hit, cache miss, and output buckets for both currencies", () => {
	const usage = {
		uncachedInputTokens: 1_000_000,
		cacheReadTokens: 500_000,
		cacheWriteTokens: 500_000,
		outputTokens: 1_000_000
	};
	assert.deepEqual(costOf(usage, "deepseek-flash", "peak", ["CNY", "USD"]), {
		CNY: 10.04,
		USD: 1.506
	});
});

test("unknown and incomplete models remain unpriced", () => {
	const usage = { uncachedInputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
	assert.equal(costOf(usage, "unknown", "peak", ["CNY"]), null);
	const incomplete = mergePricing({ partial: { cny: { peak: { cacheHit: 1 } } } });
	assert.equal(costOf(usage, "partial", "peak", ["CNY"]), null);
});

test("a complete custom model can be priced without falling back to built-ins", () => {
	const custom = mergePricing({
		custom: {
			cny: {
				peak: { cacheHit: 1, cacheMiss: 2, output: 3 },
				valley: { cacheHit: 0.5, cacheMiss: 1, output: 1.5 }
			},
			usd: {
				peak: { cacheHit: 0.1, cacheMiss: 0.2, output: 0.3 },
				valley: { cacheHit: 0.05, cacheMiss: 0.1, output: 0.15 }
			}
		}
	});
	assert.deepEqual(costOf({ uncachedInputTokens: 1_000_000 }, "custom", "valley", ["CNY", "USD"], custom), {
		CNY: 1,
		USD: 0.1
	});
});

test("a built-in model override deliberately applies across its whole history", () => {
	const overridden = mergePricing({
		"deepseek-v4-flash": {
			cny: {
				peak: { cacheHit: 1, cacheMiss: 2, output: 3 },
				valley: { cacheHit: 1, cacheMiss: 2, output: 3 }
			}
		}
	});
	assert.deepEqual(pricingAt("deepseek-v4-flash", Date.parse("2026-04-24T00:00:00Z"), overridden).cny.valley, { cacheHit: 1, cacheMiss: 2, output: 3 });
});
