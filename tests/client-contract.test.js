import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

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

test("current-period calculation mirrors the fixed Beijing weekday rule", () => {
	assert.match(source, /timeEpochMs \+ 8 \* 60 \* 60 \* 1000/);
	assert.match(source, /beijingDay === 0 \|\| beijingDay === 6/);
	assert.match(source, /peakHours\.includes\(beijingTime\.getUTCHours\(\)\)/);
});
