import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../lib/client.js", import.meta.url), "utf8");

test("client preserves DSH native stats and registers a separate billing cell", () => {
	assert.match(source, /id: "stats-decimal-billing"/);
	assert.doesNotMatch(source, /id: "stats"/);
	assert.doesNotMatch(source, /priority: -1/);
});

test("pricing-period labels use only the official bilingual names", () => {
	for (const label of ["空闲时段", "高峰时段", "OFF-PEAK", "PEAK"]) assert.match(source, new RegExp(label));
	assert.doesNotMatch(source, /梁文[峰谷]/);
});

test("current-period calculation mirrors the fixed Beijing weekday and holiday rule", () => {
	assert.match(source, /timeEpochMs \+ 8 \* 60 \* 60 \* 1000/);
	assert.match(source, /beijingDay === 0 \|\| beijingDay === 6/);
	assert.match(source, /beijingDate <= span\.endDate/);
	assert.match(source, /currentPeriodStatus\(now, ledgerVal\.peakHours, ledgerVal\.publicHolidaySpans\)/);
	assert.match(source, /peakHours\.includes\(beijingTime\.getUTCHours\(\)\)/);
});

test("browser current-period logic honors Host-supplied holiday spans", () => {
	let clientExports;
	const instrumented = source.replace(
		"\n\t\t// ---- plugin-owned locale templates ----",
		"\n\t\texports.__currentPeriodStatusForTest = currentPeriodStatus;\n\t\t// ---- plugin-owned locale templates ----"
	);
	assert.notEqual(instrumented, source, "test hook insertion point should exist");
	vm.runInNewContext(instrumented, {
		window: {
			__ModuleLoader__: {
				load: ({ factory }) => {
					clientExports = factory(() => ({}));
				}
			}
		}
	});

	const peakHours = [9, 10, 11, 14, 15, 16, 17];
	const hostHolidaySpans = [{ startDate: "2026-09-25", endDate: "2026-09-27" }];
	assert.equal(clientExports.__currentPeriodStatusForTest(Date.UTC(2026, 8, 25, 1), peakHours, hostHolidaySpans).band, "valley");
	assert.equal(clientExports.__currentPeriodStatusForTest(Date.UTC(2026, 8, 28, 1), peakHours, hostHolidaySpans).band, "peak");
});

test("currency formatting truncates at display boundaries and handles defensive inputs", () => {
	let clientExports;
	const instrumented = source.replace(
		"\n\t\tfunction currencyLedgerSegment(",
		"\n\t\texports.__formatAmountForTest = formatAmount;\n\t\tfunction currencyLedgerSegment("
	);
	assert.notEqual(instrumented, source, "test hook insertion point should exist");
	vm.runInNewContext(instrumented, {
		window: {
			__ModuleLoader__: {
				load: ({ factory }) => {
					clientExports = factory(() => ({}));
				}
			}
		}
	});

	const format = clientExports.__formatAmountForTest;
	assert.equal(format(12.34, "CNY", 2), "¥12.34"); // exact cent
	assert.equal(format(12.349, "CNY", 2), "¥12.34"); // below the next cent
	assert.equal(format(12.350001, "USD", 2), "$12.35"); // above the display boundary
	assert.equal(format(1.005, "USD", 2), "$1.00");
	assert.equal(format(0.009999, "CNY", 2), "¥0.00"); // very small positive amount
	assert.equal(format(0, "USD", 2), "$0.00");
	assert.equal(format(Number.NaN, "USD", 2), "$0.00");
	assert.equal(format(Number.POSITIVE_INFINITY, "USD", 2), "$0.00");
	assert.equal(format(-0.01, "USD", 2), "$0.00");
});
