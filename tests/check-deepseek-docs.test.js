import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import {
	SOURCE_URLS,
	currentSnapshot,
	runCheck
} from "../scripts/check-deepseek-docs.mjs";

const fixtureRoot = new URL("./fixtures/deepseek-docs/", import.meta.url);
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const checkerPath = fileURLToPath(new URL("../scripts/check-deepseek-docs.mjs", import.meta.url));
const cliPreloadPath = fileURLToPath(new URL("./fixtures/deepseek-docs/cli-fetch-preload.mjs", import.meta.url));
const newsUrl = "https://api-docs.deepseek.com/news/news261017/";
const fixtureFiles = {
	[SOURCE_URLS.enRoot]: "en-home.html",
	[SOURCE_URLS.enPricing]: "en-pricing.html",
	[SOURCE_URLS.zhPricing]: "zh-pricing.html",
	[SOURCE_URLS.enUpdates]: "en-updates.html",
	[newsUrl]: "en-news.html"
};
const FIXED_NOW = () => new Date("2026-10-17T12:00:00.000Z");

async function readFixtures() {
	return Object.fromEntries(await Promise.all(Object.entries(fixtureFiles).map(async ([url, name]) => [
		url,
		await readFile(new URL(name, fixtureRoot), "utf8")
	])));
}

function fetcherFor(sources) {
	return async (url) => {
		if (!(url in sources)) throw new Error("Missing local fixture for " + url);
		return sources[url];
	};
}

function replaceOnce(source, before, after) {
	assert.ok(source.includes(before), "Fixture marker was not found: " + before);
	return source.replace(before, after);
}

const BASE_SOURCES = await readFixtures();
const BASELINE = await currentSnapshot(fetcherFor(BASE_SOURCES), FIXED_NOW);

test("checker returns exit 0 when normalized official facts match, regardless of checkedAt", async () => {
	const result = await runCheck({
		sourceFetcher: fetcherFor(BASE_SOURCES),
		baseline: { ...BASELINE, checkedAt: "2026-10-16T00:00:00.000Z" },
		now: FIXED_NOW
	});

	assert.equal(result.exitCode, 0);
	assert.match(result.report[1], /No semantic changes/);
});

test("checker returns exit 2 for a newly listed official News entry", async () => {
	const changed = { ...BASE_SOURCES };
	changed[newsUrl] = replaceOnce(
		changed[newsUrl],
		"</nav>",
		'<a class="menu__link" href="/news/news261018/">DeepSeek API Update 2026/10/18</a></nav>'
	);

	const result = await runCheck({
		sourceFetcher: fetcherFor(changed),
		baseline: BASELINE,
		now: FIXED_NOW
	});

	assert.equal(result.exitCode, 2);
	assert.ok(result.report.some((line) => line.includes("Added news /news/news261018")));
});

test("checker returns exit 2 for a new dated /updates entry", async () => {
	const changed = { ...BASE_SOURCES };
	changed[SOURCE_URLS.enUpdates] = replaceOnce(
		changed[SOURCE_URLS.enUpdates],
		"</main>",
		"<h2>Date: 2026-10-18</h2><h3>New model update</h3></main>"
	);

	const result = await runCheck({
		sourceFetcher: fetcherFor(changed),
		baseline: BASELINE,
		now: FIXED_NOW
	});

	assert.equal(result.exitCode, 2);
	assert.ok(result.report.some((line) => line.includes("Added update 2026-10-18  New model update")));
});

test("checker returns exit 2 when an official model token-price marker changes", async () => {
	const changed = { ...BASE_SOURCES };
	changed[SOURCE_URLS.enPricing] = replaceOnce(changed[SOURCE_URLS.enPricing], "$0.003", "$0.004");

	const result = await runCheck({
		sourceFetcher: fetcherFor(changed),
		baseline: BASELINE,
		now: FIXED_NOW
	});

	assert.equal(result.exitCode, 2);
	assert.ok(result.report.includes("[deepseek-docs] Changed model token pricing"));
});

test("checker returns exit 2 when a Search or Fetch request rate changes", async () => {
	const changed = { ...BASE_SOURCES };
	changed[SOURCE_URLS.enPricing] = replaceOnce(changed[SOURCE_URLS.enPricing], "$0.75", "$0.80");

	const result = await runCheck({
		sourceFetcher: fetcherFor(changed),
		baseline: BASELINE,
		now: FIXED_NOW
	});

	assert.equal(result.exitCode, 2);
	assert.ok(result.report.includes("[deepseek-docs] Changed Search/Fetch pricing or billing start"));
});

test("checker returns exit 2 when the bilingual server-side billing start changes", async () => {
	const changed = { ...BASE_SOURCES };
	changed[SOURCE_URLS.enPricing] = replaceOnce(
		changed[SOURCE_URLS.enPricing],
		"November 1, 2026",
		"November 2, 2026"
	);
	changed[SOURCE_URLS.zhPricing] = replaceOnce(
		changed[SOURCE_URLS.zhPricing],
		"2026 年 11 月 1 日",
		"2026 年 11 月 2 日"
	);

	const result = await runCheck({
		sourceFetcher: fetcherFor(changed),
		baseline: BASELINE,
		now: FIXED_NOW
	});

	assert.equal(result.exitCode, 2);
	assert.equal(result.snapshot.searchFetchPricing.dshServerSideToolsBillableFrom, "2026-11-02T00:00:00+08:00");
	assert.ok(result.report.includes("[deepseek-docs] Changed Search/Fetch pricing or billing start"));
});

test("checker returns exit 1 when a required page section or extraction contract is missing", async () => {
	const changed = { ...BASE_SOURCES, [SOURCE_URLS.zhPricing]: "<html><body><table></table></body></html>" };
	const result = await runCheck({
		sourceFetcher: fetcherFor(changed),
		baseline: BASELINE,
		now: FIXED_NOW
	});

	assert.equal(result.exitCode, 1);
	assert.match(result.error, /required <main> content was not found/);
});

test("checker rejects a dated update marker moved outside the supported heading structure", async () => {
	const changed = { ...BASE_SOURCES };
	changed[SOURCE_URLS.enUpdates] = replaceOnce(
		changed[SOURCE_URLS.enUpdates],
		"<h2>Date: 2026-10-17</h2>",
		"<p>Date: 2026-10-17</p>"
	);

	const result = await runCheck({
		sourceFetcher: fetcherFor(changed),
		baseline: BASELINE,
		now: FIXED_NOW
	});

	assert.equal(result.exitCode, 1);
	assert.match(result.error, /dated update marker was outside the supported level-two heading structure/);
});

test("legacy sidebar baseline has an explicit v2 migration path and returns exit 2", async () => {
	const legacy = { ...BASELINE };
	delete legacy.schemaVersion;
	delete legacy.sources;
	delete legacy.updates;
	delete legacy.tokenPricing;
	delete legacy.searchFetchPricing;

	const result = await runCheck({
		sourceFetcher: fetcherFor(BASE_SOURCES),
		baseline: legacy,
		now: FIXED_NOW
	});

	assert.equal(result.exitCode, 2);
	assert.equal(result.differences.migrationRequired, true);
	assert.ok(result.report.some((line) => line.includes("Baseline schema migration required")));
});

test("snapshot mode returns a candidate without comparing or writing a baseline", async () => {
	const result = await runCheck({
		sourceFetcher: fetcherFor(BASE_SOURCES),
		snapshotOnly: true,
		now: FIXED_NOW
	});

	assert.equal(result.exitCode, 0);
	assert.equal(result.snapshot.schemaVersion, 2);
	assert.equal(result.snapshot.searchFetchPricing.dshServerSideToolsBillableFrom, "2026-11-01T00:00:00+08:00");
	assert.equal("report" in result, false);
});

test("fixture assertions independently pin identifiers, representative prices, request rates, and billing time", async () => {
	const snapshot = await currentSnapshot(fetcherFor(BASE_SOURCES), FIXED_NOW);
	assert.deepEqual(Object.keys(snapshot.tokenPricing.models), ["deepseek-flash", "deepseek-v4-pro"]);
	assert.equal(snapshot.tokenPricing.models["deepseek-flash"].modelVersion, "DeepSeek-V4.1-Flash-1017");
	assert.equal(snapshot.tokenPricing.models["deepseek-v4-pro"].modelVersion, "DeepSeek-V4-Pro-0813");
	assert.equal(snapshot.tokenPricing.models["deepseek-flash"].usd.cacheHit.offPeak, 0.003);
	assert.equal(snapshot.tokenPricing.models["deepseek-flash"].cny.output.peak, 8);
	assert.equal(snapshot.tokenPricing.models["deepseek-v4-pro"].usd.cacheMiss.peak, 1.32);
	assert.equal(snapshot.tokenPricing.models["deepseek-v4-pro"].cny.output.offPeak, 13.5);
	assert.equal(snapshot.searchFetchPricing.unit, "per 1,000 successful requests");
	assert.deepEqual(Object.keys(snapshot.searchFetchPricing.apis), ["search", "fetch"]);
	assert.deepEqual(snapshot.searchFetchPricing.apis, {
		search: { cny: 5, usd: 0.75 },
		fetch: { cny: 5, usd: 0.75 }
	});
	assert.equal(snapshot.searchFetchPricing.dshServerSideToolsBillableFrom, "2026-11-01T00:00:00+08:00");
});

test("a complete recognized model token-pricing table remains accepted", async () => {
	const result = await runCheck({ sourceFetcher: fetcherFor(BASE_SOURCES), baseline: BASELINE, now: FIXED_NOW });

	assert.equal(result.exitCode, 0);
	assert.match(result.report[1], /No semantic changes/);
});

test("an unknown priced row after the final token metric fails closed", async () => {
	const changed = { ...BASE_SOURCES };
	changed[SOURCE_URLS.enPricing] = replaceOnce(
		changed[SOURCE_URLS.enPricing],
		"<tr><th>PEAK</th><td>$1.2</td><td>$3.96</td></tr>",
		"<tr><th>PEAK</th><td>$1.2</td><td>$3.96</td></tr><tr><th>Surcharge</th><td>$1</td><td>$2</td></tr>"
	);

	const result = await runCheck({ sourceFetcher: fetcherFor(changed), baseline: BASELINE, now: FIXED_NOW });

	assert.equal(result.exitCode, 1);
	assert.match(result.error, /unrecognized or ambiguous priced token-price row/);
});

test("an unknown priced row in the middle of token metrics fails closed", async () => {
	const changed = { ...BASE_SOURCES };
	changed[SOURCE_URLS.enPricing] = replaceOnce(
		changed[SOURCE_URLS.enPricing],
		"<tr><th>PRICING (2)</th><th>1M INPUT TOKENS (CACHE HIT)</th><th>OFF-PEAK</th><td>$0.003</td><td>$0.022</td></tr>",
		"<tr><th>PRICING (2)</th><th>1M INPUT TOKENS (CACHE HIT)</th><th>OFF-PEAK</th><td>$0.003</td><td>$0.022</td></tr><tr><th>Surcharge</th><td>$1</td><td>$2</td></tr>"
	);

	const result = await runCheck({ sourceFetcher: fetcherFor(changed), baseline: BASELINE, now: FIXED_NOW });

	assert.equal(result.exitCode, 1);
	assert.match(result.error, /unrecognized or ambiguous priced token-price row/);
});

test("an ordinary nonpriced footer in the model table remains ignored", async () => {
	const changed = { ...BASE_SOURCES };
	changed[SOURCE_URLS.enPricing] = replaceOnce(
		changed[SOURCE_URLS.enPricing],
		"<tr><th>PEAK</th><td>$1.2</td><td>$3.96</td></tr>",
		"<tr><th>PEAK</th><td>$1.2</td><td>$3.96</td></tr><tr><th>Concurrency Limit (3)</th><td>2500</td><td>500</td></tr>"
	);

	const result = await runCheck({ sourceFetcher: fetcherFor(changed), baseline: BASELINE, now: FIXED_NOW });

	assert.equal(result.exitCode, 0);
	assert.match(result.report[1], /No semantic changes/);
});

test("an additional Browse charge is reported as a semantic upstream change", async () => {
	const changed = { ...BASE_SOURCES };
	changed[SOURCE_URLS.enPricing] = replaceOnce(
		changed[SOURCE_URLS.enPricing],
		"<tr><td>Fetch</td><td>Per 1,000 successful requests</td><td>$0.75</td></tr>",
		"<tr><td>Fetch</td><td>Per 1,000 successful requests</td><td>$0.75</td></tr><tr><td>Browse</td><td>Per 1,000 successful requests</td><td>$1.25</td></tr>"
	);

	const result = await runCheck({ sourceFetcher: fetcherFor(changed), baseline: BASELINE, now: FIXED_NOW });

	assert.equal(result.exitCode, 2);
	assert.deepEqual(result.snapshot.searchFetchPricing.unrecognizedCategories.en, [{
		category: "Browse",
		unit: "per 1,000 successful requests",
		currency: "USD",
		rate: 1.25
	}]);
	assert.ok(result.report.some((line) => line.includes("unrecognized request-charge categories: Browse")));
	const repeated = await runCheck({ sourceFetcher: fetcherFor(changed), baseline: result.snapshot, now: FIXED_NOW });
	assert.equal(repeated.exitCode, 2, "an unrecognized category remains a review item even if copied into a local baseline");
});

test("an additional charge with an unparseable unit fails closed", async () => {
	const changed = { ...BASE_SOURCES };
	changed[SOURCE_URLS.enPricing] = replaceOnce(
		changed[SOURCE_URLS.enPricing],
		"<tr><td>Fetch</td><td>Per 1,000 successful requests</td><td>$0.75</td></tr>",
		"<tr><td>Fetch</td><td>Per 1,000 successful requests</td><td>$0.75</td></tr><tr><td>Browse</td><td>Per request</td><td>$1.25</td></tr>"
	);

	const result = await runCheck({ sourceFetcher: fetcherFor(changed), baseline: BASELINE, now: FIXED_NOW });

	assert.equal(result.exitCode, 1);
	assert.match(result.error, /unrecognized successful-request unit for Browse/);
});

test("CACHE WRITE rows cannot overwrite or masquerade as OUTPUT prices", async () => {
	const changed = { ...BASE_SOURCES };
	changed[SOURCE_URLS.enPricing] = replaceOnce(
		changed[SOURCE_URLS.enPricing],
		"<tr><th>PEAK</th><td>$1.2</td><td>$3.96</td></tr>",
		"<tr><th>PEAK</th><td>$1.2</td><td>$3.96</td></tr><tr><th>1M CACHE WRITE TOKENS</th><th>OFF-PEAK</th><td>$77</td><td>$88</td></tr><tr><th>PEAK</th><td>$99</td><td>$100</td></tr>"
	);

	const result = await runCheck({ sourceFetcher: fetcherFor(changed), baseline: BASELINE, now: FIXED_NOW });

	assert.equal(result.exitCode, 1);
	assert.match(result.error, /unrecognized token-price metric label/);
});

test("duplicate metric/band rows fail even when the duplicated values match", async () => {
	const changed = { ...BASE_SOURCES };
	const row = "<tr><th>PRICING (2)</th><th>1M INPUT TOKENS (CACHE HIT)</th><th>OFF-PEAK</th><td>$0.003</td><td>$0.022</td></tr>";
	changed[SOURCE_URLS.enPricing] = replaceOnce(changed[SOURCE_URLS.enPricing], row, row + row);

	const result = await runCheck({ sourceFetcher: fetcherFor(changed), baseline: BASELINE, now: FIXED_NOW });

	assert.equal(result.exitCode, 1);
	assert.match(result.error, /duplicate token-price metric\/band row cacheHit:offPeak/);
});

test("duplicate metric/band rows fail when the duplicated values conflict", async () => {
	const changed = { ...BASE_SOURCES };
	const row = "<tr><th>PRICING (2)</th><th>1M INPUT TOKENS (CACHE HIT)</th><th>OFF-PEAK</th><td>$0.003</td><td>$0.022</td></tr>";
	const conflicting = "<tr><th>PRICING (2)</th><th>1M INPUT TOKENS (CACHE HIT)</th><th>OFF-PEAK</th><td>$0.004</td><td>$0.022</td></tr>";
	changed[SOURCE_URLS.enPricing] = replaceOnce(changed[SOURCE_URLS.enPricing], row, row + conflicting);

	const result = await runCheck({ sourceFetcher: fetcherFor(changed), baseline: BASELINE, now: FIXED_NOW });

	assert.equal(result.exitCode, 1);
	assert.match(result.error, /duplicate token-price metric\/band row cacheHit:offPeak/);
});

test("incomplete token-price tuples fail closed", async () => {
	const changed = { ...BASE_SOURCES };
	changed[SOURCE_URLS.enPricing] = replaceOnce(
		changed[SOURCE_URLS.enPricing],
		"<td>$0.003</td><td>$0.022</td>",
		"<td>$0.003</td>"
	);

	const result = await runCheck({ sourceFetcher: fetcherFor(changed), baseline: BASELINE, now: FIXED_NOW });

	assert.equal(result.exitCode, 1);
	assert.match(result.error, /expected 2 model prices for cacheHit offPeak/);
});

test("ambiguous duplicate model tables fail closed", async () => {
	const changed = { ...BASE_SOURCES };
	const modelTable = /<table>[\s\S]*?<\/table>/.exec(changed[SOURCE_URLS.enPricing])?.[0];
	assert.ok(modelTable);
	changed[SOURCE_URLS.enPricing] = replaceOnce(changed[SOURCE_URLS.enPricing], "</main>", modelTable + "</main>");

	const result = await runCheck({ sourceFetcher: fetcherFor(changed), baseline: BASELINE, now: FIXED_NOW });

	assert.equal(result.exitCode, 1);
	assert.match(result.error, /expected exactly one model token-pricing table/);
});

test("multiple English billing-start dates are rejected as ambiguous", async () => {
	const changed = { ...BASE_SOURCES };
	changed[SOURCE_URLS.enPricing] = replaceOnce(
		changed[SOURCE_URLS.enPricing],
		"</main>",
		"<p>Billing starts at 00:00 Beijing time on November 2, 2026.</p></main>"
	);

	const result = await runCheck({ sourceFetcher: fetcherFor(changed), baseline: BASELINE, now: FIXED_NOW });

	assert.equal(result.exitCode, 1);
	assert.match(result.error, /exactly one unambiguous English billing-start marker/);
});

test("English February 31 billing dates are rejected instead of normalized", async () => {
	const changed = { ...BASE_SOURCES };
	changed[SOURCE_URLS.enPricing] = replaceOnce(changed[SOURCE_URLS.enPricing], "November 1, 2026", "February 31, 2026");

	const result = await runCheck({ sourceFetcher: fetcherFor(changed), baseline: BASELINE, now: FIXED_NOW });

	assert.equal(result.exitCode, 1);
	assert.match(result.error, /billing-start date is invalid/);
});

test("English non-leap-year February 29 billing dates are rejected", async () => {
	const changed = { ...BASE_SOURCES };
	changed[SOURCE_URLS.enPricing] = replaceOnce(changed[SOURCE_URLS.enPricing], "November 1, 2026", "February 29, 2026");

	const result = await runCheck({ sourceFetcher: fetcherFor(changed), baseline: BASELINE, now: FIXED_NOW });

	assert.equal(result.exitCode, 1);
	assert.match(result.error, /billing-start date is invalid/);
});

test("impossible English billing-start times are rejected", async () => {
	const changed = { ...BASE_SOURCES };
	changed[SOURCE_URLS.enPricing] = replaceOnce(
		changed[SOURCE_URLS.enPricing],
		"starts at 00:00 Beijing time on November 1, 2026.",
		"starts at 24:00 Beijing time on November 1, 2026."
	);

	const result = await runCheck({ sourceFetcher: fetcherFor(changed), baseline: BASELINE, now: FIXED_NOW });

	assert.equal(result.exitCode, 1);
	assert.match(result.error, /billing-start time is invalid/);
});

test("Chinese February 31 billing dates are rejected instead of normalized", async () => {
	const changed = { ...BASE_SOURCES };
	changed[SOURCE_URLS.zhPricing] = replaceOnce(changed[SOURCE_URLS.zhPricing], "2026 年 11 月 1 日", "2026 年 2 月 31 日");

	const result = await runCheck({ sourceFetcher: fetcherFor(changed), baseline: BASELINE, now: FIXED_NOW });

	assert.equal(result.exitCode, 1);
	assert.match(result.error, /billing-start date is invalid/);
});

test("duplicate Chinese billing-start markers are rejected as ambiguous", async () => {
	const changed = { ...BASE_SOURCES };
	changed[SOURCE_URLS.zhPricing] = replaceOnce(
		changed[SOURCE_URLS.zhPricing],
		"</main>",
		"<p>北京时间 2026 年 11 月 1 日 00:00 起按次收费。</p></main>"
	);

	const result = await runCheck({ sourceFetcher: fetcherFor(changed), baseline: BASELINE, now: FIXED_NOW });

	assert.equal(result.exitCode, 1);
	assert.match(result.error, /exactly one unambiguous Chinese billing-start marker/);
});

let cliInvocation = 0;
async function runCli(mode, args = []) {
	const originalArgv = process.argv;
	const originalExitCode = process.exitCode;
	const originalFetch = globalThis.fetch;
	const originalCase = process.env.DSH_DOCS_CLI_TEST_CASE;
	const originalLog = console.log;
	const originalError = console.error;
	const output = [];
	const errors = [];
	const invocation = ++cliInvocation;
	try {
		process.env.DSH_DOCS_CLI_TEST_CASE = mode;
		await import(pathToFileURL(cliPreloadPath).href + "?case=" + invocation);
		process.argv = [process.execPath, checkerPath, ...args];
		console.log = (...values) => output.push(values.join(" "));
		console.error = (...values) => errors.push(values.join(" "));
		process.exitCode = undefined;
		await import(pathToFileURL(checkerPath).href + "?cli=" + invocation);
		return { status: process.exitCode ?? 0, stdout: output.join("\n"), stderr: errors.join("\n") };
	} catch (error) {
		return { error, stdout: output.join("\n"), stderr: errors.join("\n") };
	} finally {
		process.argv = originalArgv;
		process.exitCode = originalExitCode;
		globalThis.fetch = originalFetch;
		if (originalCase === undefined) delete process.env.DSH_DOCS_CLI_TEST_CASE;
		else process.env.DSH_DOCS_CLI_TEST_CASE = originalCase;
		console.log = originalLog;
		console.error = originalError;
	}
}

test("in-process CLI entry assigns exit codes 0, 1, and 2 for matching, malformed, and changed offline sources", async () => {
	const testDirectory = await mkdtemp(join(repositoryRoot, ".work", "deepseek-docs-cli-"));
	const fixtureBaselinePath = join(testDirectory, "baseline.json");
	await writeFile(fixtureBaselinePath, JSON.stringify(BASELINE));
	try {
		for (const [mode, expected] of [["match", 0], ["malformed", 1], ["changed", 2]]) {
			const result = await runCli(mode, ["--baseline", fixtureBaselinePath]);
			assert.equal(result.error, undefined, result.error?.message);
			assert.equal(result.status, expected, result.stderr || result.stdout);
		}
	} finally {
		await rm(testDirectory, { recursive: true, force: true });
	}
});

test("in-process CLI snapshot prints a candidate and leaves the approved baseline byte-identical", async () => {
	const baselinePath = new URL("../docs/deepseek-docs-baseline.json", import.meta.url);
	const before = readFileSync(fileURLToPath(baselinePath));
	const result = await runCli("match", ["--snapshot"]);
	const after = readFileSync(fileURLToPath(baselinePath));

	assert.equal(result.error, undefined, result.error?.message);
	assert.equal(result.status, 0, result.stderr || "snapshot CLI failed");
	assert.equal(createHash("sha256").update(after).digest("hex"), createHash("sha256").update(before).digest("hex"));
	const candidate = JSON.parse(result.stdout);
	assert.equal(candidate.searchFetchPricing.dshServerSideToolsBillableFrom, "2026-11-01T00:00:00+08:00");
});
