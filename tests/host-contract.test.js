import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../lib/index.js", import.meta.url), "utf8");

test("projection exposes period configuration and invalidates old cached prices", () => {
	assert.match(source, /peakHours: \[\.\.\.peakHours\]/);
	assert.match(source, /stateVersion: 4/);
	assert.match(source, /costOf\(buckets, model, band, currencies, table, timeEpochMs\)/);
});

test("official Beijing peak hours are the default", () => {
	assert.match(source, /default\(\[9, 10, 11, 14, 15, 16, 17\]\)/);
});

test("balance remains outside the Session event log", () => {
	assert.doesNotMatch(source, /session\.append\(/);
	assert.doesNotMatch(source, /stats-decimal\/balance["'`],/);
});
