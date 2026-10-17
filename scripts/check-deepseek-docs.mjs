#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOTS = {
	zhCN: "https://api-docs.deepseek.com/zh-cn/",
	en: "https://api-docs.deepseek.com/"
};

export const SOURCE_URLS = {
	enRoot: ROOTS.en,
	enUpdates: new URL("/updates/", ROOTS.en).href,
	enPricing: new URL("/quick_start/pricing/", ROOTS.en).href,
	zhPricing: new URL("/zh-cn/quick_start/pricing/", ROOTS.en).href,
	enSearchGuide: new URL("/guides/search/", ROOTS.en).href,
	zhSearchGuide: new URL("/zh-cn/guides/search/", ROOTS.en).href
};

const BASELINE_URL = new URL("../docs/deepseek-docs-baseline.json", import.meta.url);
const SCHEMA_VERSION = 2;
const MODEL_IDS = ["deepseek-flash", "deepseek-v4-pro"];
const SOURCE_TEXT = {
	input: "\u8f93\u5165",
	cacheHit: "\u7f13\u5b58\u547d\u4e2d",
	cacheMiss: "\u7f13\u5b58\u672a\u547d\u4e2d",
	output: "\u8f93\u51fa",
	million: "\u767e\u4e07",
	offPeak: "\u7a7a\u95f2\u65f6\u6bb5",
	peak: "\u9ad8\u5cf0\u65f6\u6bb5",
	model: "\u6a21\u578b",
	version: "\u7248\u672c",
	successfulRequestSuffix: "\u6b21\u6210\u529f\u8bf7\u6c42",
	beijingTime: "\u5317\u4eac\u65f6\u95f4",
	year: "\u5e74",
	month: "\u6708",
	day: "\u65e5",
	start: "\u8d77",
	cnyYuan: "\u5143"
};

export async function fetchSource(url) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 20_000);
	try {
		const response = await fetch(url, {
			headers: { "user-agent": "dsh-stats-decimal-upstream-check" },
			signal: controller.signal
		});
		if (!response.ok) throw new Error(url + ": " + response.status + " " + response.statusText);
		return await response.text();
	} finally {
		clearTimeout(timer);
	}
}

function decodeHtml(value) {
	return value
		.replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
		.replace(/&#([0-9]+);/g, (_, decimal) => String.fromCodePoint(Number.parseInt(decimal, 10)))
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, "\"")
		.replace(/&#39;/gi, "'");
}

function plainText(html) {
	return decodeHtml(html
		.replace(/<(script|style|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
		.replace(/<[^>]+>/g, " "))
		.replace(/[\u200b\u200c\u200d\ufeff]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

function requiredMain(html, sourceName) {
	const main = /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(html)?.[1];
	if (!main) throw new Error(sourceName + ": required <main> content was not found");
	return main;
}

function sidebarFromSource(html, sourceName) {
	const entries = [];
	const seen = new Set();
	for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
		const attributes = match[1];
		const classes = /class=["']([^"']*)["']/i.exec(attributes)?.[1] ?? "";
		if (!classes.split(/\s+/).includes("menu__link")) continue;
		const href = /href=["']([^"']+)["']/i.exec(attributes)?.[1];
		const title = plainText(match[2]);
		if (!href || !title) continue;
		const key = href + "\u0000" + title;
		if (seen.has(key)) continue;
		seen.add(key);
		entries.push({ href, title });
	}
	if (!entries.length) throw new Error(sourceName + ": no sidebar entries matched the supported menu__link structure");
	return entries;
}

function newsFromSidebar(sidebar) {
	const newsLinks = sidebar.filter((item) => item.href.startsWith("/news/"));
	if (!newsLinks.length) throw new Error("News sidebar did not contain a News entry");
	const undated = newsLinks.find((item) => !/\d{4}\/\d{2}\/\d{2}/.test(item.title));
	if (undated) throw new Error("News sidebar entry did not contain a supported YYYY/MM/DD date: " + undated.href);
	return newsLinks.map((item) => ({ path: item.href.replace(/\/$/, ""), titleEn: item.title }));
}

function firstNewsPath(html) {
	const href = /href=["'](\/(?:zh-cn\/)?news\/[^"'#?]+)["']/i.exec(html)?.[1];
	if (!href) throw new Error("Could not find a News link in the English home page source");
	return href.replace(/^\/zh-cn/, "").replace(/\/$/, "");
}

function localizedNewsUrl(path, locale) {
	return new URL((locale === "zhCN" ? "/zh-cn" : "") + path + "/", ROOTS[locale]).href;
}

function headingsFromSource(html, sourceName) {
	const main = requiredMain(html, sourceName);
	return [...main.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi)]
		.map((match) => ({ level: Number(match[1]), title: plainText(match[2]) }))
		.filter((item) => item.title);
}

function updatesFromSource(html) {
	const sourceUrl = SOURCE_URLS.enUpdates;
	const main = requiredMain(html, sourceUrl);
	const headings = headingsFromSource(html, sourceUrl);
	if (!headings.some((item) => item.level === 1 && item.title === "Change Log")) {
		throw new Error(sourceUrl + ": expected the Change Log heading");
	}
	const datedHeadings = headings
		.filter((item) => item.level === 2)
		.map((item) => /^Date:\s*(\d{4}-\d{2}-\d{2})$/.exec(item.title)?.[1])
		.filter(Boolean);
	const paragraphDate = [...main.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
		.map((match) => plainText(match[1]))
		.find((title) => /^Date:\s*\d{4}-\d{2}-\d{2}(?:\s|$)/.test(title));
	if (!datedHeadings.length || paragraphDate) {
		throw new Error(sourceUrl + ": a dated update marker was outside the supported level-two heading structure");
	}

	const entries = [];
	let currentDate = null;
	let titleCountForDate = 0;
	for (const heading of headings) {
		const date = heading.level === 2 ? /^Date:\s*(\d{4}-\d{2}-\d{2})$/.exec(heading.title) : null;
		if (date) {
			if (currentDate && titleCountForDate === 0) {
				throw new Error(sourceUrl + ": dated section " + currentDate + " has no level-three entry heading");
			}
			currentDate = date[1];
			titleCountForDate = 0;
			continue;
		}
		if (/^Date:/i.test(heading.title)) {
			throw new Error(sourceUrl + ": unrecognized dated heading " + heading.title);
		}
		if (currentDate && heading.level === 3) {
			entries.push({ date: currentDate, title: heading.title });
			titleCountForDate++;
		}
	}
	if (!currentDate || titleCountForDate === 0 || !entries.length) {
		throw new Error(sourceUrl + ": no dated update entries matched the supported Date/level-three-heading structure");
	}
	return { sourceUrl, entries };
}

function tableRowsFromSource(html, sourceName) {
	const main = requiredMain(html, sourceName);
	const tables = [];
	for (const tableMatch of main.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)) {
		const rows = [];
		for (const rowMatch of tableMatch[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
			const cells = [...rowMatch[1].matchAll(/<(?:th|td)\b[^>]*>([\s\S]*?)<\/(?:th|td)>/gi)]
				.map((cell) => plainText(cell[1]));
			if (cells.length) rows.push(cells);
		}
		if (rows.length) tables.push(rows);
	}
	const rows = tables.flat();
	if (!rows.length) throw new Error(sourceName + ": no table rows matched the supported table structure");
	return { main, rows, tables };
}

function normalizeModelId(value) {
	return value.replace(/\s*\(\d+\)\s*$/, "").trim().toLowerCase();
}

function metricForLabel(label, locale) {
	const key = label.toLowerCase().replace(/\s+/g, "").replace(/[()\uff08\uff09]/g, "");
	if (locale === "en") {
		if (key === "1minputtokenscachehit") return "cacheHit";
		if (key === "1minputtokenscachemiss") return "cacheMiss";
		if (key === "1moutputtokens") return "output";
		return null;
	}
	if (key === SOURCE_TEXT.million + "tokens" + SOURCE_TEXT.input + SOURCE_TEXT.cacheHit) return "cacheHit";
	if (key === SOURCE_TEXT.million + "tokens" + SOURCE_TEXT.input + SOURCE_TEXT.cacheMiss) return "cacheMiss";
	if (key === SOURCE_TEXT.million + "tokens" + SOURCE_TEXT.output) return "output";
	return null;
}

function bandForCell(value, locale) {
	const key = value.toLowerCase().replace(/\s+/g, "");
	if (locale === "en") {
		if (key.includes("off-peak")) return "offPeak";
		if (key === "peak") return "peak";
		return null;
	}
	if (key.includes(SOURCE_TEXT.offPeak)) return "offPeak";
	if (key.includes(SOURCE_TEXT.peak)) return "peak";
	return null;
}

function moneyValue(value, currency, sourceName) {
	if (currency === "USD" && !value.includes("$")) {
		throw new Error(sourceName + ": expected a USD marker in " + JSON.stringify(value));
	}
	if (currency === "CNY" && !/(?:\u00a5|\uffe5|\u5143)/.test(value)) {
		throw new Error(sourceName + ": expected a CNY marker in " + JSON.stringify(value));
	}
	const number = Number(/-?\d+(?:\.\d+)?/.exec(value.replace(/,/g, ""))?.[0]);
	if (!Number.isFinite(number) || number < 0) {
		throw new Error(sourceName + ": could not parse a non-negative price from " + JSON.stringify(value));
	}
	return number;
}

function hasMonetaryPrice(value) {
	return /(?:[$\u20ac\u00a3\u00a5\uffe5]|\u5143|\b(?:USD|CNY|RMB)\b)/i.test(value) && /\d/.test(value);
}

function parseModelTokenPrices(html, locale, currency, sourceName) {
	const { tables } = tableRowsFromSource(html, sourceName);
	const modelLabel = locale === "en" ? "model" : SOURCE_TEXT.model;
	const versionLabel = locale === "en" ? "model version" : SOURCE_TEXT.model + SOURCE_TEXT.version;
	const normalizeLabel = (value) => value.toLowerCase().replace(/\s+/g, "").replace(/[()\uff08\uff09]/g, "");
	const modelHeader = modelLabel.replace(/\s+/g, "");
	const candidateTables = tables.filter((rows) => rows.some((row) => normalizeLabel(row[0] ?? "") === modelHeader));
	if (candidateTables.length !== 1) {
		throw new Error(sourceName + ": expected exactly one model token-pricing table");
	}
	const rows = candidateTables[0];
	const modelRows = rows.filter((row) => normalizeLabel(row[0] ?? "") === modelHeader);
	if (modelRows.length !== 1) throw new Error(sourceName + ": model header row was ambiguous");
	const modelRow = modelRows[0];

	const modelIds = modelRow.slice(1).map(normalizeModelId);
	const indices = Object.fromEntries(MODEL_IDS.map((modelId) => [modelId, modelIds.indexOf(modelId)]));
	for (const modelId of MODEL_IDS) {
		if (indices[modelId] < 0) throw new Error(sourceName + ": model column " + modelId + " was not found");
	}
	if (new Set(modelIds).size !== modelIds.length) throw new Error(sourceName + ": model columns were duplicated");

	const versionRows = rows.filter((row) => normalizeLabel(row[0] ?? "") === versionLabel.replace(/\s+/g, ""));
	if (versionRows.length !== 1) throw new Error(sourceName + ": model version row was missing or ambiguous");
	const versionRow = versionRows[0];
	const versions = Object.fromEntries(MODEL_IDS.map((modelId) => {
		const value = versionRow[indices[modelId] + 1];
		if (!value) throw new Error(sourceName + ": model version is missing for " + modelId);
		return [modelId, value];
	}));

	const values = Object.fromEntries(MODEL_IDS.map((modelId) => [
		modelId,
		{ cacheHit: {}, cacheMiss: {}, output: {} }
	]));
	let currentMetric = null;
	const seenMetricBands = new Set();
	const tokenMetricMarker = (label) => locale === "en"
		? /(?:input|output|token|cache|\b1m\b)/i.test(label)
		: [SOURCE_TEXT.input, SOURCE_TEXT.output, SOURCE_TEXT.cacheHit.slice(0, 2)].some((part) => label.includes(part))
			|| /tokens?|\u767e\u4e07/i.test(label);
	const pricingHeader = (label) => locale === "en"
		? /^pricing(?:\s*\(\d+\))?$/i.test(label.trim())
		: /^\u4ef7\u683c(?:\s*[\uff08(]\d+[\uff09)])?$/.test(label.trim());
	let pricingStarted = false;
	for (const row of rows) {
		if (row === modelRow || row === versionRow) continue;
		if (row.some(pricingHeader)) pricingStarted = true;
		const bandCells = row.map((cell, index) => ({ band: bandForCell(cell, locale), index }))
			.filter((item) => item.band !== null);
		const metricCells = row.map((cell, index) => ({ metric: metricForLabel(cell, locale), index, label: cell }))
			.filter((item) => item.metric !== null);
		const hasUnknownMetricLabel = pricingStarted
			&& row.some((cell) => tokenMetricMarker(cell) && !metricForLabel(cell, locale));
		if (hasUnknownMetricLabel) {
			throw new Error(sourceName + ": unrecognized token-price metric label " + JSON.stringify(row));
		}
		if (bandCells.length > 1) throw new Error(sourceName + ": ambiguous token-price period row " + JSON.stringify(row));
		if (!bandCells.length) {
			if (row.some(hasMonetaryPrice)) {
				throw new Error(sourceName + ": unrecognized or ambiguous priced token-price row " + JSON.stringify(row));
			}
			if (metricCells.length > 1) throw new Error(sourceName + ": ambiguous token-price metric row " + JSON.stringify(row));
			if (metricCells.length === 1) {
				if (!pricingStarted) throw new Error(sourceName + ": token-price metric appeared before the pricing section " + JSON.stringify(row));
				currentMetric = metricCells[0].metric;
				continue;
			}
			const labels = row.map((cell) => cell.trim()).filter(Boolean);
			if (!pricingStarted || !labels.length || (labels.length === 1 && pricingHeader(labels[0]))) continue;
			if (seenMetricBands.size === 6) {
				currentMetric = null;
				continue;
			}
			throw new Error(sourceName + ": unrecognized token-price table row " + JSON.stringify(row));
		}
		if (!pricingStarted) {
			throw new Error(sourceName + ": token-price period row appeared before the pricing section " + JSON.stringify(row));
		}
		const band = bandCells[0].band;
		const bandIndex = bandCells[0].index;
		const metricBeforeBand = metricCells.filter((item) => item.index < bandIndex);
		if (metricBeforeBand.length > 1) {
			throw new Error(sourceName + ": ambiguous token-price metric row " + JSON.stringify(row));
		}
		if (metricCells.some((item) => item.index > bandIndex)) {
			throw new Error(sourceName + ": token-price metric appears after its period " + JSON.stringify(row));
		}
		if (metricBeforeBand.length === 1) {
			currentMetric = metricBeforeBand[0].metric;
		} else {
			const labelsBeforeBand = row.slice(0, bandIndex).map((cell) => cell.trim()).filter(Boolean);
			if (bandIndex !== 0 || labelsBeforeBand.length !== 0 || !currentMetric) {
				throw new Error(sourceName + ": token-price row has no explicit metric or valid continuation " + JSON.stringify(row));
			}
		}
		const metricBand = currentMetric + ":" + band;
		if (seenMetricBands.has(metricBand)) {
			throw new Error(sourceName + ": duplicate token-price metric/band row " + metricBand);
		}
		seenMetricBands.add(metricBand);
		const prices = row.slice(bandIndex + 1);
		if (prices.length !== modelIds.length) {
			throw new Error(sourceName + ": expected " + modelIds.length + " model prices for " + currentMetric + " " + band);
		}
		for (const modelId of MODEL_IDS) {
			values[modelId][currentMetric][band] = moneyValue(prices[indices[modelId]], currency, sourceName);
		}
	}

	for (const modelId of MODEL_IDS) {
		for (const metric of ["cacheHit", "cacheMiss", "output"]) {
			for (const band of ["offPeak", "peak"]) {
				if (values[modelId][metric][band] === undefined) {
					throw new Error(sourceName + ": missing " + modelId + " " + metric + " " + band + " price");
				}
			}
		}
	}
	return Object.fromEntries(MODEL_IDS.map((modelId) => [
		modelId,
		{ modelVersion: versions[modelId], ...values[modelId] }
	]));
}

function parseRequestRates(html, locale, currency, sourceName) {
	const { tables } = tableRowsFromSource(html, sourceName);
	const normalizedCategory = (value) => value.trim().toLowerCase();
	const requestTables = tables.filter((rows) => ["search", "fetch"].every((api) =>
		rows.filter((row) => normalizedCategory(row[0] ?? "") === api).length > 0
	));
	if (requestTables.length !== 1) {
		throw new Error(sourceName + ": expected exactly one Search/Fetch request-pricing table");
	}
	const rows = requestTables[0];
	const rates = {};
	const additionalCategories = [];
	const seenCategories = new Set();
	if (normalizedCategory(rows[0]?.[0] ?? "") !== "api") {
		throw new Error(sourceName + ": request-pricing table header was missing or ambiguous");
	}
	if (rows[0].length !== 3) throw new Error(sourceName + ": request-pricing table header had an unexpected shape");
	for (const row of rows.slice(1)) {
		const category = row[0]?.trim() ?? "";
		if (!category || row.length !== 3) {
			throw new Error(sourceName + ": request-pricing row had an unexpected shape " + JSON.stringify(row));
		}
		const key = normalizedCategory(category);
		if (seenCategories.has(key)) throw new Error(sourceName + ": duplicate request-charge category " + category);
		seenCategories.add(key);
		const unit = row[1] ?? "";
		const successfulRequestUnit = locale === "en"
			? /1[, ]?000\s+successful requests/i.test(unit)
			: new RegExp("1[, ]?000\\s*" + SOURCE_TEXT.successfulRequestSuffix).test(unit);
		if (!successfulRequestUnit) {
			throw new Error(sourceName + ": unrecognized successful-request unit for " + category);
		}
		const rate = moneyValue(row[2], currency, sourceName);
		if (key === "search" || key === "fetch") {
			rates[key] = rate;
		} else {
			additionalCategories.push({ category, unit: "per 1,000 successful requests", currency, rate });
		}
	}
	for (const api of ["Search", "Fetch"]) {
		if (rates[api.toLowerCase()] === undefined) {
			throw new Error(sourceName + ": expected exactly one " + api + " request-price row");
		}
	}
	return { rates, additionalCategories };
}

function englishBillingStart(html) {
	const sourceName = SOURCE_URLS.enPricing;
	const text = plainText(requiredMain(html, sourceName));
	const pattern = /\bbilling\s+starts?\s+at\s+(\d{2}):(\d{2})\s+Beijing time on\s+([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/gi;
	const matches = [...text.matchAll(pattern)];
	if (matches.length !== 1) {
		throw new Error(sourceName + ": expected exactly one unambiguous English billing-start marker");
	}
	const [, hour, minute, monthName, day, year] = matches[0];
	const monthNames = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
	const month = monthNames.indexOf(monthName.toLowerCase()) + 1;
	return billingTimestamp(year, month, day, hour, minute, sourceName);
}

function billingTimestamp(yearText, monthText, dayText, hourText, minuteText, sourceName) {
	const year = Number(yearText);
	const month = Number(monthText);
	const day = Number(dayText);
	const hour = Number(hourText);
	const minute = Number(minuteText);
	const parsed = new Date(0);
	parsed.setUTCHours(0, 0, 0, 0);
	parsed.setUTCFullYear(year, month - 1, day);
	if (!Number.isInteger(year) || year < 1 || year > 9999
		|| !Number.isInteger(month) || month < 1 || month > 12
		|| !Number.isInteger(day) || day < 1 || day > 31
		|| parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
		throw new Error(sourceName + ": billing-start date is invalid");
	}
	if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) {
		throw new Error(sourceName + ": billing-start time is invalid");
	}
	return String(year).padStart(4, "0") + "-" + String(month).padStart(2, "0") + "-" + String(day).padStart(2, "0")
		+ "T" + String(hour).padStart(2, "0") + ":" + String(minute).padStart(2, "0") + ":00+08:00";
}

function chineseBillingStart(html) {
	const sourceName = SOURCE_URLS.zhPricing;
	const text = plainText(requiredMain(html, sourceName));
	const pattern = new RegExp(
		SOURCE_TEXT.beijingTime + "\\s*(\\d{4})\\s*" + SOURCE_TEXT.year
		+ "\\s*(\\d{1,2})\\s*" + SOURCE_TEXT.month + "\\s*(\\d{1,2})\\s*"
		+ SOURCE_TEXT.day + "\\s*(\\d{2}):(\\d{2})\\s*" + SOURCE_TEXT.start,
		"g"
	);
	const matches = [...text.matchAll(pattern)];
	if (matches.length !== 1) {
		throw new Error(sourceName + ": expected exactly one unambiguous Chinese billing-start marker");
	}
	const [, year, month, day, hour, minute] = matches[0];
	return billingTimestamp(year, month, day, hour, minute, sourceName);
}

function tokenPricingFromSources(enHtml, zhHtml) {
	const en = parseModelTokenPrices(enHtml, "en", "USD", SOURCE_URLS.enPricing);
	const zhCN = parseModelTokenPrices(zhHtml, "zhCN", "CNY", SOURCE_URLS.zhPricing);
	const models = {};
	for (const modelId of MODEL_IDS) {
		if (en[modelId].modelVersion !== zhCN[modelId].modelVersion) {
			throw new Error("English and Chinese pricing pages disagree on the model version for " + modelId);
		}
		models[modelId] = {
			modelVersion: en[modelId].modelVersion,
			cny: zhCN[modelId],
			usd: en[modelId]
		};
		delete models[modelId].cny.modelVersion;
		delete models[modelId].usd.modelVersion;
	}
	return {
		unit: "per 1M tokens",
		models,
		sources: { en: SOURCE_URLS.enPricing, zhCN: SOURCE_URLS.zhPricing }
	};
}

function searchFetchPricingFromSources(enHtml, zhHtml) {
	const usd = parseRequestRates(enHtml, "en", "USD", SOURCE_URLS.enPricing);
	const cny = parseRequestRates(zhHtml, "zhCN", "CNY", SOURCE_URLS.zhPricing);
	const englishStart = englishBillingStart(enHtml);
	const chineseStart = chineseBillingStart(zhHtml);
	if (englishStart !== chineseStart) {
		throw new Error("English and Chinese pricing pages disagree on the server-side billing start time");
	}
	return {
		unit: "per 1,000 successful requests",
		apis: {
			search: { cny: cny.rates.search, usd: usd.rates.search },
			fetch: { cny: cny.rates.fetch, usd: usd.rates.fetch }
		},
		dshServerSideToolsBillableFrom: englishStart,
		...(usd.additionalCategories.length || cny.additionalCategories.length
			? { unrecognizedCategories: { en: usd.additionalCategories, zhCN: cny.additionalCategories } }
			: {}),
		sources: {
			enPricing: SOURCE_URLS.enPricing,
			zhPricing: SOURCE_URLS.zhPricing,
			enGuide: SOURCE_URLS.enSearchGuide,
			zhGuide: SOURCE_URLS.zhSearchGuide
		}
	};
}

function unionSidebars(...sidebars) {
	const result = [];
	const seen = new Set();
	for (const sidebar of sidebars) {
		for (const item of sidebar) {
			const key = item.href + "\u0000" + item.title;
			if (seen.has(key)) continue;
			seen.add(key);
			result.push(item);
		}
	}
	return result;
}

export async function currentSnapshot(sourceFetcher = fetchSource, now = () => new Date()) {
	const enRoot = await sourceFetcher(SOURCE_URLS.enRoot);
	const enNewsPath = firstNewsPath(enRoot);
	const enNewsUrl = localizedNewsUrl(enNewsPath, "en");
	const [enPricing, zhPricing, enUpdates, enNews] = await Promise.all([
		sourceFetcher(SOURCE_URLS.enPricing),
		sourceFetcher(SOURCE_URLS.zhPricing),
		sourceFetcher(SOURCE_URLS.enUpdates),
		sourceFetcher(enNewsUrl)
	]);

	const docsSidebar = sidebarFromSource(enPricing, SOURCE_URLS.enPricing);
	const newsSidebar = sidebarFromSource(enNews, enNewsUrl);
	if (!docsSidebar.some((item) => item.href.replace(/\/$/, "") === "/quick_start/pricing")) {
		throw new Error(SOURCE_URLS.enPricing + ": the pricing navigation entry was not found");
	}
	const updates = updatesFromSource(enUpdates);
	return {
		schemaVersion: SCHEMA_VERSION,
		checkedAt: now().toISOString(),
		roots: ROOTS,
		queryLocale: "en",
		newsSeeds: {
			zhCN: localizedNewsUrl(enNewsPath, "zhCN"),
			en: enNewsUrl
		},
		sources: {
			newsDirectory: { en: enNewsUrl, zhCN: localizedNewsUrl(enNewsPath, "zhCN") },
			updates: updates.sourceUrl,
			tokenPricing: { en: SOURCE_URLS.enPricing, zhCN: SOURCE_URLS.zhPricing },
			searchFetchPricing: {
				en: SOURCE_URLS.enPricing,
				zhCN: SOURCE_URLS.zhPricing,
				enGuide: SOURCE_URLS.enSearchGuide,
				zhGuide: SOURCE_URLS.zhSearchGuide
			}
		},
		news: newsFromSidebar(newsSidebar),
		updates: updates.entries,
		tokenPricing: tokenPricingFromSources(enPricing, zhPricing),
		searchFetchPricing: searchFetchPricingFromSources(enPricing, zhPricing),
		sidebar: unionSidebars(docsSidebar, newsSidebar)
	};
}

function stableJson(value) {
	return JSON.stringify(value);
}

function compareNews(current, baseline) {
	const oldByPath = new Map((baseline ?? []).map((item) => [item.path, item]));
	const newByPath = new Map(current.map((item) => [item.path, item]));
	const added = current.filter((item) => !oldByPath.has(item.path));
	const removed = (baseline ?? []).filter((item) => !newByPath.has(item.path));
	const renamed = current.filter((item) => oldByPath.has(item.path)
		&& oldByPath.get(item.path).titleEn !== item.titleEn);
	return { added, removed, renamed };
}

function compareUpdates(current, baseline) {
	const key = (item) => item.date + "\u0000" + item.title;
	const before = new Set((baseline ?? []).map(key));
	const after = new Set(current.map(key));
	return {
		added: current.filter((item) => !before.has(key(item))),
		removed: (baseline ?? []).filter((item) => !after.has(key(item)))
	};
}

function compareSidebar(current, baseline) {
	const key = (item) => item.href + "\u0000" + item.title;
	const before = new Set((baseline ?? []).map(key));
	const after = new Set(current.map(key));
	const changes = [];
	for (const item of current) {
		if (!before.has(key(item))) changes.push({ kind: "added", ...item });
	}
	for (const item of baseline ?? []) {
		if (!after.has(key(item))) changes.push({ kind: "removed", ...item });
	}
	if ((baseline ?? []).map(key).join("\n") !== current.map(key).join("\n")) {
		changes.push({ kind: "reordered", href: "", title: "Sidebar order changed" });
	}
	return changes;
}

export function compare(current, baseline) {
	const migrationRequired = baseline.schemaVersion !== SCHEMA_VERSION
		|| !Array.isArray(baseline.updates)
		|| !baseline.tokenPricing
		|| !baseline.searchFetchPricing
		|| !baseline.sources;
	const news = compareNews(current.news, baseline.news);
	const updates = compareUpdates(current.updates, baseline.updates);
	const sidebarChanges = compareSidebar(current.sidebar, baseline.sidebar);
	const changedFacts = [];
	const unrecognizedRequestCharges = Object.values(current.searchFetchPricing?.unrecognizedCategories ?? {})
		.flat()
		.map((item) => item.category);

	if (!baseline.sources) changedFacts.push("source URLs");
	else if (stableJson(current.sources) !== stableJson(baseline.sources)) changedFacts.push("official source references");
	if (!Array.isArray(baseline.updates) || stableJson(current.updates) !== stableJson(baseline.updates)) {
		if (!migrationRequired || Array.isArray(baseline.updates)) changedFacts.push("dated updates");
	}
	if (!baseline.tokenPricing || stableJson(current.tokenPricing) !== stableJson(baseline.tokenPricing)) {
		if (!migrationRequired || baseline.tokenPricing) changedFacts.push("model token pricing");
	}
	if (!baseline.searchFetchPricing || stableJson(current.searchFetchPricing) !== stableJson(baseline.searchFetchPricing)) {
		if (!migrationRequired || baseline.searchFetchPricing) changedFacts.push("Search/Fetch pricing or billing start");
	}
	if (unrecognizedRequestCharges.length) {
		changedFacts.push("unrecognized request-charge categories: " + [...new Set(unrecognizedRequestCharges)].join(", "));
	}
	if (stableJson(current.newsSeeds) !== stableJson(baseline.newsSeeds)) changedFacts.push("newest News discovery URL");

	return {
		migrationRequired,
		news,
		updates,
		changedFacts,
		sidebarChanges,
		hasChanges: migrationRequired
			|| news.added.length > 0
			|| news.removed.length > 0
			|| news.renamed.length > 0
			|| updates.added.length > 0
			|| updates.removed.length > 0
			|| changedFacts.length > 0
			|| unrecognizedRequestCharges.length > 0
			|| sidebarChanges.length > 0
	};
}

export function formatReport(result, baseline) {
	const lines = ["[deepseek-docs] baseline=" + (baseline.checkedAt ?? "unknown") + " schema=" + (baseline.schemaVersion ?? "legacy")];
	if (!result.hasChanges) {
		lines.push("[deepseek-docs] No semantic changes in official News, dated updates, model token prices, Search/Fetch pricing, billing start, or navigation.");
		return lines;
	}
	if (result.migrationRequired) lines.push("[deepseek-docs] Baseline schema migration required; review and approve the v2 candidate snapshot.");
	for (const item of result.news.added) lines.push("[deepseek-docs] Added news " + item.path + "  " + item.titleEn);
	for (const item of result.news.removed) lines.push("[deepseek-docs] Removed news " + item.path + "  " + item.titleEn);
	for (const item of result.news.renamed) lines.push("[deepseek-docs] Changed news title " + item.path + "  " + item.titleEn);
	for (const item of result.updates.added) lines.push("[deepseek-docs] Added update " + item.date + "  " + item.title);
	for (const item of result.updates.removed) lines.push("[deepseek-docs] Removed update " + item.date + "  " + item.title);
	for (const fact of result.changedFacts) lines.push("[deepseek-docs] Changed " + fact);
	for (const item of result.sidebarChanges) {
		lines.push("[deepseek-docs] Sidebar " + item.kind + "  " + item.href + "  " + item.title);
	}
	lines.push("[deepseek-docs] Review official source pages and approve a candidate snapshot before updating the baseline.");
	return lines;
}

export async function runCheck({
	sourceFetcher = fetchSource,
	baseline,
	baselinePath = BASELINE_URL,
	snapshotOnly = false,
	now = () => new Date()
} = {}) {
	try {
		const snapshot = await currentSnapshot(sourceFetcher, now);
		if (snapshotOnly) return { exitCode: 0, snapshot };
		const approvedBaseline = baseline
			?? JSON.parse(await readFile(baselinePath, "utf8"));
		const differences = compare(snapshot, approvedBaseline);
		return {
			exitCode: differences.hasChanges ? 2 : 0,
			snapshot,
			baseline: approvedBaseline,
			differences,
			report: formatReport(differences, approvedBaseline)
		};
	} catch (error) {
		return {
			exitCode: 1,
			error: error instanceof Error ? error.message : String(error)
		};
	}
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
	const baselineIndex = process.argv.indexOf("--baseline");
	const baselinePath = baselineIndex < 0 ? BASELINE_URL : process.argv[baselineIndex + 1];
	const result = baselineIndex >= 0 && (!baselinePath || baselinePath.startsWith("--"))
		? { exitCode: 1, error: "--baseline requires a JSON file path" }
		: await runCheck({
			snapshotOnly: process.argv.includes("--snapshot"),
			baselinePath
		});
	if (result.exitCode === 1) {
		console.error("[deepseek-docs] Check failed: " + result.error);
	} else if (process.argv.includes("--snapshot")) {
		console.log(JSON.stringify(result.snapshot, null, 2));
	} else {
		for (const line of result.report) console.log(line);
	}
	process.exitCode = result.exitCode;
}
