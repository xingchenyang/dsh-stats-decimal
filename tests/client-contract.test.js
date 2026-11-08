import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../lib/client.js", import.meta.url), "utf8");

function loadBalanceTestApi(reactOverride) {
	let clientExports;
	const instrumented = source.replace(
		"\n\t\tfunction apply(ctx)",
		"\n\t\texports.__balanceTestApi = { subscribeBalance, refreshBalance, balanceEntries, refreshTasks, selectedProviderFromProjection, invalidateBalanceEntries, invalidateRemovedSessionBalance, BillingStatus, apply, parseUsageScopes, zoneAmountText, compactSingleText, compactPairText, compactAriaLabel, compactSubagentsText, compactSubagentsAriaLabel, cacheHitFromTokens, firstAvailableBalanceCurrency, balanceDisplayStatus, layoutModeForWidth, computeDetailPosition, formatCacheHit, formatTokenCount, zoneTokenRows, ZONE_CSS, ZONE_DOCK_ORDER, usageScopesSnapshot, subscribeUsageScopes, refreshUsageScopesPart, usageScopesEntries, bindBalanceRpc(fn) { callGetBalance = fn; }, bindUsageScopesRpc(fn) { callGetUsageScopes = fn; } };\n\t\tfunction apply(ctx)"
	);
	assert.notEqual(instrumented, source, "balance test hook insertion point should exist");
	let now = Date.UTC(2026, 9, 10, 12);
	let nextTimerId = 1;
	const timers = new Map();
	const fakeSetTimeout = (callback, delay = 0) => {
		const id = nextTimerId++;
		timers.set(id, { callback, at: now + Math.max(0, Number(delay) || 0) });
		return id;
	};
	const fakeClearTimeout = (id) => timers.delete(id);
	class FakeDate extends Date {
		constructor(...args) { super(...(args.length === 0 ? [now] : args)); }
		static now() { return now; }
	}
	const react = reactOverride ?? {
		useState(initial) { return [typeof initial === "function" ? initial() : initial, () => {}]; },
		useEffect(effect) { return effect(); },
		useLayoutEffect() {},
		useRef(initial) { return { current: initial }; },
		createElement(type, props, ...children) { return { type, props: props ?? {}, children }; }
	};
	vm.runInNewContext(instrumented, {
		window: { __ModuleLoader__: { load: ({ factory }) => { clientExports = factory(() => react); } } },
		AbortController,
		Date: FakeDate,
		setTimeout: fakeSetTimeout,
		clearTimeout: fakeClearTimeout
	});
	async function advance(ms = 0) {
		const end = now + ms;
		let idleTurns = 0;
		for (;;) {
			const due = [...timers.entries()]
				.filter(([, timer]) => timer.at <= end)
				.sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
			if (!due) {
				if (idleTurns > 0) break;
				for (let i = 0; i < 5; i += 1) await Promise.resolve();
				await new Promise((resolve) => setImmediate(resolve));
				idleTurns += 1;
				continue;
			}
			const [id, timer] = due;
			timers.delete(id);
			now = timer.at;
			timer.callback();
			for (let i = 0; i < 5; i += 1) await Promise.resolve();
			await new Promise((resolve) => setImmediate(resolve));
			idleTurns = 0;
		}
		now = end;
	}
	return { api: clientExports.__balanceTestApi, advance, timers };
}

function installClientEvents(api, rpcCall) {
	const remoteListeners = new Map();
	const localListeners = new Map();
	const cleanups = [];
	const ctx = {
		connection: { rpc: { call: rpcCall } },
		remote: {
			$on(event, listener) {
				const listeners = remoteListeners.get(event) ?? new Set();
				listeners.add(listener);
				remoteListeners.set(event, listeners);
				return () => listeners.delete(listener);
			}
		},
		on(event, listener) {
			const listeners = localListeners.get(event) ?? new Set();
			listeners.add(listener);
			localListeners.set(event, listeners);
			return () => listeners.delete(listener);
		},
		effect(effect) {
			const cleanup = effect();
			if (typeof cleanup === "function") cleanups.push(cleanup);
		},
		locale: { register() { return () => {}; } },
		slots: { inject() {}, register() {} }
	};
	api.apply(ctx);
	return {
		ctx,
		cleanups,
		emitRemote(event, ...args) { for (const listener of remoteListeners.get(event) ?? []) listener(...args); },
		emitLocal(event, ...args) { for (const listener of localListeners.get(event) ?? []) listener(...args); }
	};
}

test("client preserves DSH native stats and registers a separate billing cell", () => {
	assert.match(source, /id: "stats-decimal-billing"/);
	assert.doesNotMatch(source, /id: "stats"/);
	assert.doesNotMatch(source, /priority: -1/);
});

test("balance RPC polling is gated by the Host balanceEnabled projection flag", () => {
	assert.match(source, /const balanceEnabled = ledgerVal !== null && ledgerVal !== void 0 && ledgerVal\.balanceEnabled === true/);
	assert.match(source, /if \(!enabled \|\| !balanceEnabled\)/);
	assert.match(source, /useProjection\("modelSelection"\)/);
	assert.match(source, /getBalance", \{ sessionId \}, controller\.signal/);
});

test("multiple rows for one Session share one balance RPC and a different Session gets isolated state", async () => {
	const { api, advance } = loadBalanceTestApi();
	const calls = [];
	api.bindBalanceRpc(async (_channel, _endpoint, payload, signal) => {
		calls.push({ sessionId: payload.sessionId, signal });
		return { ok: true, value: { enabled: true, provider: "deepseek-account", balances: { CNY: 8.5, USD: null }, error: null } };
	});
	const first = [];
	const second = [];
	const other = [];
	const releaseFirst = api.subscribeBalance("session-a", "deepseek-account", (value) => first.push(value));
	const releaseSecond = api.subscribeBalance("session-a", "deepseek-account", (value) => second.push(value));
	await advance(0);
	assert.equal(calls.length, 1);
	assert.equal(first.at(-1).balances.CNY, 8.5);
	assert.equal(second.at(-1).sessionId, "session-a");
	const releaseOther = api.subscribeBalance("session-b", "deepseek-account", (value) => other.push(value));
	await advance(0);
	assert.equal(calls.length, 2);
	assert.deepEqual(calls.map((call) => call.sessionId), ["session-a", "session-b"]);
	assert.equal(other.at(-1).sessionId, "session-b");
	releaseFirst();
	assert.equal(api.balanceEntries.has("session-a"), true, "the remaining same-Session row keeps the shared entry alive");
	releaseSecond();
	releaseOther();
	assert.equal(api.balanceEntries.size, 0);
});

test("provider changes invalidate the generation and ignore a late prior-provider response", async () => {
	const { api, advance } = loadBalanceTestApi();
	let resolveOld;
	const calls = [];
	api.bindBalanceRpc((_channel, _endpoint, payload, signal) => {
		calls.push({ payload, signal });
		if (calls.length === 1) return new Promise((resolve) => { resolveOld = resolve; });
		return Promise.resolve({ ok: true, value: { enabled: true, provider: "deepseek-official", balanceGeneration: 1, balances: { CNY: null, USD: 3.2 }, error: null } });
	});
	const oldValues = [];
	const newValues = [];
	const releaseOld = api.subscribeBalance("session-switch", "deepseek-account", (value) => oldValues.push(value));
	await advance(0);
	const entry = api.balanceEntries.get("session-switch");
	const generation = entry.generation;
	const oldSignal = calls[0].signal;
	assert.equal(oldValues.at(-1).loading, true);
	const releaseNew = api.subscribeBalance("session-switch", "deepseek-official", (value) => newValues.push(value));
	assert.ok(entry.generation > generation);
	assert.equal(oldSignal.aborted, true);
	assert.equal(newValues.at(-1), null, "old provider balance is cleared immediately");
	await advance(0);
	assert.equal(calls.length, 2);
	assert.equal(newValues.at(-1).provider, "deepseek-official");
	resolveOld({ ok: true, value: { enabled: true, provider: "deepseek-account", balances: { CNY: 88, USD: null }, error: null } });
	await advance(0);
	assert.equal(api.balanceEntries.get("session-switch").value.balances.USD, 3.2);
	assert.doesNotMatch(JSON.stringify(newValues), /88/);
	releaseOld();
	releaseNew();
});

test("session unmount cancels its RPC and discards a later result", async () => {
	const { api, advance } = loadBalanceTestApi();
	let resolvePending;
	let signal;
	const values = [];
	api.bindBalanceRpc((_channel, _endpoint, _payload, requestSignal) => {
		signal = requestSignal;
		return new Promise((resolve) => { resolvePending = resolve; });
	});
	const release = api.subscribeBalance("unmount-session", null, (value) => values.push(value));
	await advance(0);
	release();
	assert.equal(signal.aborted, true);
	assert.equal(api.balanceEntries.has("unmount-session"), false);
	resolvePending({ ok: true, value: { enabled: true, provider: "deepseek-official", balanceGeneration: 1, balances: { CNY: 90, USD: 1 }, error: null } });
	await advance(0);
	assert.equal(api.balanceEntries.has("unmount-session"), false);
	assert.doesNotMatch(JSON.stringify(values), /90/);
});

test("an indefinitely pending RPC times out, releases the scheduler, and permits a later refresh", async () => {
	const { api, advance } = loadBalanceTestApi();
	let calls = 0;
	const values = [];
	api.bindBalanceRpc(() => { calls += 1; return new Promise(() => {}); });
	const release = api.subscribeBalance("timeout-session", "deepseek-official", (value) => values.push(value));
	await advance(0);
	assert.equal(calls, 1);
	await advance(165_000);
	const entry = api.balanceEntries.get("timeout-session");
	assert.equal(entry.value.error, "rpc-timeout");
	assert.equal(entry.value.loading, false);
	assert.equal(api.refreshTasks.get("balance:timeout-session").inFlight, false);
	await advance(135_000);
	assert.equal(calls, 2, "the normal periodic refresh is available after timeout");
	release();
});

test("successful balances expire before a hung refresh can leave the old value visible", async () => {
	const { api, advance } = loadBalanceTestApi();
	let calls = 0;
	const values = [];
	api.bindBalanceRpc(() => {
		calls += 1;
		if (calls === 1) return Promise.resolve({ ok: true, value: { enabled: true, provider: "deepseek-account", balances: { CNY: 7, USD: null }, error: null } });
		return new Promise(() => {});
	});
	const release = api.subscribeBalance("stale-session", "deepseek-account", (value) => values.push(value));
	await advance(0);
	assert.equal(api.balanceEntries.get("stale-session").value.balances.CNY, 7);
	await advance(300_000);
	assert.equal(calls, 2);
	const value = api.balanceEntries.get("stale-session").value;
	assert.ok(value === null || value.loading === true || value.balances.CNY === null);
	assert.doesNotMatch(JSON.stringify(values.slice(-2)), /"CNY":7/);
	release();
});

test("a Connection failure recovers on the next bounded periodic refresh", async () => {
	const { api, advance } = loadBalanceTestApi();
	let calls = 0;
	api.bindBalanceRpc(async () => {
		calls += 1;
		if (calls === 1) return { ok: false, error: { code: "connection-unavailable", message: "private transport detail" } };
		return { ok: true, value: { enabled: true, provider: "deepseek-official", balanceGeneration: 2, balances: { CNY: 1.25, USD: 0.4 }, error: null } };
	});
	const release = api.subscribeBalance("reconnect-session", "deepseek-official", () => {});
	await advance(0);
	assert.equal(api.balanceEntries.get("reconnect-session").value.balances.CNY, null);
	await advance(300_000);
	assert.equal(calls, 2);
	assert.equal(api.balanceEntries.get("reconnect-session").value.balances.CNY, 1.25);
	release();
});

test("official Host error without a generation settles as unavailable without retaining a balance", async () => {
	const { api, advance } = loadBalanceTestApi();
	api.bindBalanceRpc(async () => ({ ok: true, value: {
		enabled: true,
		provider: "deepseek-official",
		balances: { CNY: 91, USD: 7 },
		error: "private-route-inspection-detail"
	} }));
	const release = api.subscribeBalance("official-error-without-generation", "deepseek-official", () => {});
	await advance(0);
	const entry = api.balanceEntries.get("official-error-without-generation");
	assert.equal(entry.value.provider, "deepseek-official");
	assert.equal(entry.value.balanceGeneration, null, "an unverified result keeps no generation");
	assert.equal(entry.value.error, "balance-identity-unavailable");
	assert.equal(entry.value.balances.CNY, null);
	assert.equal(entry.value.balances.USD, null);
	assert.equal(entry.value.loading, false);
	assert.equal(entry.controller, null);
	assert.equal(api.refreshTasks.get("balance:official-error-without-generation").inFlight, false);
	assert.doesNotMatch(JSON.stringify(entry.value), /private-route-inspection-detail/);
	release();
});

test("same-provider route and credential notifications clear balances before refreshing", async () => {
	const { api, advance } = loadBalanceTestApi();
	let calls = 0;
	const client = installClientEvents(api, async () => {
		calls += 1;
		return { ok: true, value: {
			enabled: true,
			provider: "deepseek-official",
			balanceGeneration: calls,
			balances: { CNY: calls, USD: null },
			error: null
		} };
	});
	const values = [];
	const release = api.subscribeBalance("same-provider-route", "deepseek-official", (value) => values.push(value));
	await advance(0);
	const entry = api.balanceEntries.get("same-provider-route");
	assert.equal(entry.value.balances.CNY, 1);
	client.emitRemote("settings/document-updated", { namespace: "llm-deepseek-api-key" });
	assert.equal(entry.value, null, "same-provider endpoint/apiKeyEnv edits clear the old balance immediately");
	await advance(300);
	assert.equal(entry.value.balanceGeneration, 2);
	client.emitRemote("credentials/reference-updated", "PRIVATE_REFERENCE_NAME");
	assert.equal(entry.value, null, "credential rotation clears an official balance without storing the reference");
	assert.doesNotMatch(JSON.stringify(entry), /PRIVATE_REFERENCE_NAME/);
	await advance(300);
	assert.equal(entry.value.balanceGeneration, 3);
	release();
});

test("removed Sessions discard their balance and ignore a late RPC response", async () => {
	const { api, advance } = loadBalanceTestApi();
	let resolvePending;
	const client = installClientEvents(api, () => new Promise((resolve) => { resolvePending = resolve; }));
	const sessionId = "removed-session-balance";
	const release = api.subscribeBalance(sessionId, "deepseek-official", () => {});
	await advance(0);
	const entry = api.balanceEntries.get(sessionId);
	const oldSignal = entry.controller.signal;
	assert.equal(oldSignal.aborted, false);
	client.emitRemote("api-session/removed", sessionId);
	assert.equal(oldSignal.aborted, true);
	assert.equal(api.balanceEntries.has(sessionId), false);
	resolvePending({ ok: true, value: {
		enabled: true,
		provider: "deepseek-official",
		balanceGeneration: 2,
		balances: { CNY: 88, USD: null },
		error: null
	} });
	await advance(0);
	assert.equal(api.balanceEntries.has(sessionId), false);
	release();
});

test("connection reset clears balances and rebinds the RPC client before reconnect refresh", async () => {
	const { api, advance } = loadBalanceTestApi();
	let firstCalls = 0;
	let secondCalls = 0;
	const client = installClientEvents(api, async () => {
		firstCalls += 1;
		return { ok: true, value: { enabled: true, provider: "deepseek-official", balanceGeneration: 1, balances: { CNY: 6, USD: null }, error: null } };
	});
	const entryValues = [];
	const release = api.subscribeBalance("reconnect-invalidates", "deepseek-official", (value) => entryValues.push(value));
	await advance(0);
	const entry = api.balanceEntries.get("reconnect-invalidates");
	assert.equal(entry.value.balances.CNY, 6);
	client.ctx.connection.rpc = { call: async () => {
		secondCalls += 1;
		return { ok: true, value: { enabled: true, provider: "deepseek-official", balanceGeneration: 2, balances: { CNY: 9, USD: null }, error: null } };
	} };
	client.emitLocal("connection/reset");
	assert.equal(entry.value, null);
	await advance(300);
	assert.equal(firstCalls, 1);
	assert.equal(secondCalls, 1);
	assert.equal(entry.value.balances.CNY, 9);
	release();
});

test("a late response after credential invalidation cannot overwrite the newer balance", async () => {
	const { api, advance } = loadBalanceTestApi();
	let oldResolve;
	let calls = 0;
	const client = installClientEvents(api, (_channel, _endpoint, _payload, signal) => {
		calls += 1;
		if (calls === 1) {
			return new Promise((resolve) => { oldResolve = resolve; });
		}
		return Promise.resolve({ ok: true, value: {
			enabled: true,
			provider: "deepseek-official",
			balanceGeneration: 8,
			balances: { CNY: 8, USD: null },
			error: null
		} });
	});
	const release = api.subscribeBalance("late-credential-rotation", "deepseek-official", () => {});
	await advance(0);
	const entry = api.balanceEntries.get("late-credential-rotation");
	const oldSignal = entry.controller.signal;
	client.emitRemote("credentials/reference-updated", "DO_NOT_RETAIN_THIS_REFERENCE");
	assert.equal(oldSignal.aborted, true);
	assert.equal(entry.value, null);
	await advance(300);
	assert.equal(calls, 2);
	assert.equal(entry.value.balances.CNY, 8);
	oldResolve({ ok: true, value: {
		enabled: true,
		provider: "deepseek-official",
		balanceGeneration: 7,
		balances: { CNY: 77, USD: null },
		error: null
	} });
	await advance(0);
	assert.equal(entry.value.balances.CNY, 8);
	assert.doesNotMatch(JSON.stringify(entry), /DO_NOT_RETAIN_THIS_REFERENCE/);
	release();
});

test("rapid official to account to official changes do not accept the first official response", async () => {
	const { api, advance } = loadBalanceTestApi();
	let firstResolve;
	let calls = 0;
	api.bindBalanceRpc(() => {
		calls += 1;
		if (calls === 1) return new Promise((resolve) => { firstResolve = resolve; });
		return Promise.resolve({ ok: true, value: {
			enabled: true,
			provider: "deepseek-official",
			balanceGeneration: 4,
			balances: { CNY: 4, USD: null },
			error: null
		} });
	});
	const releaseOfficial = api.subscribeBalance("rapid-aba", "deepseek-official", () => {});
	await advance(0);
	const entry = api.balanceEntries.get("rapid-aba");
	const releaseAccount = api.subscribeBalance("rapid-aba", "deepseek-account", () => {});
	const releaseOfficialAgain = api.subscribeBalance("rapid-aba", "deepseek-official", () => {});
	firstResolve({ ok: true, value: {
		enabled: true,
		provider: "deepseek-official",
		balanceGeneration: 3,
		balances: { CNY: 33, USD: null },
		error: null
	} });
	await advance(0);
	assert.equal(calls, 2);
	assert.equal(entry.value.provider, "deepseek-official");
	assert.equal(entry.value.balances.CNY, 4);
	assert.equal(entry.value.balances.CNY === 33, false);
	releaseOfficial();
	releaseAccount();
	releaseOfficialAgain();
});

test("disabled balances do not subscribe to balance RPC polling", () => {
	const cleanups = [];
	const react = {
		useState(initial) { return [typeof initial === "function" ? initial() : initial, () => {}]; },
		useEffect(effect) { const cleanup = effect(); if (typeof cleanup === "function") cleanups.push(cleanup); },
		useLayoutEffect() {},
		useRef(initial) { return { current: initial }; },
		createElement(type, props, ...children) { return { type, props: props ?? {}, children }; }
	};
	const { api, timers } = loadBalanceTestApi(react);
	let balanceCalls = 0;
	api.bindBalanceRpc(async () => { balanceCalls += 1; return { ok: true, value: {} }; });
	const view = api.BillingStatus({
		useProjection(name) {
			return name === "billingLedger"
				? { enabled: true, balanceEnabled: false, currencies: ["CNY"], peakHours: [], publicHolidaySpans: [], cumulative: { CNY: 1, USD: 0 }, today: { CNY: 0, USD: 0 }, pricingKnown: true }
				: { next: null, lastUsed: null };
		},
		t: (key) => key,
		sessionId: "disabled-balance-session"
	});
	assert.ok(view);
	assert.equal(balanceCalls, 0);
	for (const cleanup of cleanups) cleanup();
	assert.equal(timers.size, 0);
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
		"\n\t\tfunction formatAmount(",
		"\n\t\texports.__formatAmountForTest = formatAmount;\n\t\tfunction formatAmount("
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

test("usage scopes parser preserves Host statuses and never converts unknown or unavailable into zero", () => {
	const { api } = loadBalanceTestApi();
	const payload = {
		date: "2026-11-08",
		timeZone: "Europe/Paris",
		generatedAt: 123456,
		session: {
			status: "ready",
			cumulative: { CNY: 1.25, USD: 0.2 },
			today: { CNY: 0.5, USD: 0.1 },
			tokens: { uncachedInput: 10, cacheRead: 20, cacheWrite: 0, output: 5, reasoning: 2 },
			cacheHit: 0.5,
			pricingKnown: true,
			usageKnown: true
		},
		tree: {
			status: "partial",
			cumulative: { CNY: 3.4, USD: 0.47 },
			today: { CNY: 1.2, USD: 0.17 },
			tokens: { uncachedInput: 30, cacheRead: 40, cacheWrite: 0, output: 15, reasoning: 3 },
			cacheHit: 0.6,
			pricingKnown: false,
			usageKnown: true,
			complete: false,
			hasDescendants: true,
			coordinatorDirect: {
				cumulative: { CNY: 2.4, USD: 0.33 },
				today: { CNY: 0.7, USD: 0.09 },
				tokens: { uncachedInput: 20, cacheRead: 30, cacheWrite: 0, output: 10, reasoning: 2 }
			},
			subagentsAggregate: {
				cumulative: { CNY: 1, USD: 0.14 },
				today: { CNY: 0.5, USD: 0.08 },
				tokens: { uncachedInput: 10, cacheRead: 10, cacheWrite: 0, output: 5, reasoning: 1 }
			},
			diagnostics: { external: true, unreadable: false }
		},
		local: {
			status: "unknown",
			today: { CNY: 9.22, USD: 1.38 },
			tokens: null,
			cacheHit: null,
			pricingKnown: false,
			usageKnown: true,
			sessionCount: 30
		}
	};
	const parsed = api.parseUsageScopes(payload);
	assert.equal(parsed.date, "2026-11-08");
	assert.equal(parsed.timeZone, "Europe/Paris");
	assert.equal(parsed.generatedAt, 123456);
	assert.equal(parsed.session.status, "ready");
	assert.equal(parsed.session.cumulative.CNY, 1.25);
	assert.equal(parsed.session.cumulative.USD, 0.2);
	assert.equal(parsed.tree.status, "partial");
	assert.equal(parsed.tree.complete, false);
	assert.equal(parsed.tree.hasDescendants, true);
	assert.equal(parsed.tree.coordinatorDirect.cumulative.CNY, 2.4);
	assert.equal(parsed.tree.subagentsAggregate.today.USD, 0.08);
	assert.equal(parsed.tree.diagnostics.external, true);
	assert.equal(parsed.local.status, "unknown");
	assert.equal(parsed.local.sessionCount, 30);
	assert.equal(parsed.session.tokens.reasoning, 2);
	assert.equal(parsed.tree.tokens.cacheRead, 40);

	const unavailable = api.parseUsageScopes(null, "rpc-error");
	assert.equal(unavailable.session.status, "unavailable");
	assert.equal(unavailable.tree.status, "unavailable");
	assert.equal(unavailable.local.status, "unavailable");
	assert.equal(unavailable.session.cumulative, null);
	assert.equal(unavailable.tree.cumulative, null);
	assert.equal(unavailable.local.today, null);
});

test("usage scopes amount presentation is status-aware and never fabricates zero", () => {
	const { api } = loadBalanceTestApi();
	const t = (key) => key === "statsDecimal.valueSeparator" ? " · " : key;
	assert.equal(api.zoneAmountText("ready", { CNY: 12.34, USD: 1.5 }, ["CNY", "USD"], t), "¥12.34 · $1.50");
	assert.equal(api.zoneAmountText("partial", { CNY: 12.34, USD: 1.5 }, ["CNY"], t), "¥12.34");
	assert.equal(api.zoneAmountText("unknown", { CNY: 12.34 }, ["CNY"], t), "statsDecimal.costUnknown");
	assert.equal(api.zoneAmountText("unavailable", null, ["CNY"], t), "statsDecimal.status.unavailable");
	assert.equal(api.zoneAmountText("loading", null, ["CNY"], t), "statsDecimal.status.loading");
	assert.equal(api.zoneAmountText("ready", { CNY: null }, ["CNY"], t), "statsDecimal.dailyCostUnavailable");
	assert.equal(api.formatCacheHit(0.12345), "12.34%");
	assert.equal(api.formatCacheHit(null), null);
});

test("compact summaries use the first configured currency and never fabricate zero", () => {
	const { api } = loadBalanceTestApi();
	const t = (key) => key === "statsDecimal.compact.separator" ? " / " : key === "statsDecimal.valueSeparator" ? " · " : key;
	assert.equal(api.compactSingleText("ready", { USD: 1.25, CNY: 9.2 }, "USD", t), "$1.25");
	assert.equal(api.compactPairText("ready", { USD: 1.25 }, { USD: 0.5 }, "USD", t), "$1.25 / $0.50");
	assert.equal(api.compactSingleText("partial", { USD: 1.25 }, "USD", t), "$1.25");
	assert.equal(api.compactSingleText("unknown", { USD: 1.25 }, "USD", t), "statsDecimal.compact.unknown");
	assert.equal(api.compactSingleText("unavailable", { USD: 1.25 }, "USD", t), "statsDecimal.compact.unavailable");
	assert.equal(api.compactSingleText("loading", null, "USD", t), "statsDecimal.compact.loading");
	assert.equal(api.compactSingleText("disabled", null, "USD", t), "statsDecimal.compact.disabled");
	assert.equal(api.compactSingleText("ready", { USD: 1.25 }, null, t), "statsDecimal.compact.unavailable");
	assert.equal(api.compactSubagentsText({ hasDescendants: false }, "ready", "USD", t), "statsDecimal.compact.notUsed");
	assert.equal(api.compactSubagentsText({ hasDescendants: true, cumulative: { USD: 99 }, today: { USD: 99 }, subagentsAggregate: { cumulative: { USD: 1.25 }, today: { USD: 0.5 } } }, "ready", "USD", t), "$1.25 / $0.50");
	assert.equal(api.compactSubagentsText({ hasDescendants: null, subagentsAggregate: { cumulative: { USD: 1.25 }, today: { USD: 0.5 } } }, "ready", "USD", t), "statsDecimal.compact.unknown");
	assert.equal(api.compactSubagentsText({ hasDescendants: null, subagentsAggregate: { cumulative: { USD: 1.25 }, today: { USD: 0.5 } } }, "unknown", "USD", t), "statsDecimal.compact.unknown");
	assert.equal(api.compactSubagentsAriaLabel({ hasDescendants: false }, "ready", "USD", t), "statsDecimal.compact.subagents: statsDecimal.compact.notUsed");
	assert.equal(api.cacheHitFromTokens({ uncachedInput: 1, cacheRead: 9, cacheWrite: 0 }), 0.9);
	assert.equal(api.cacheHitFromTokens({ uncachedInput: 0, cacheRead: 0, cacheWrite: 0 }), null);
	assert.match(source, /"statsDecimal\.compact\.subagents": "子智能体"/);
	assert.match(source, /"statsDecimal\.scope\.subagents": "子智能体"/);
	assert.equal(
		api.compactAriaLabel("local", "ready", null, { USD: 1.25 }, "USD", t),
		"statsDecimal.compact.local: statsDecimal.compact.aria.local"
	);
	assert.equal(
		api.zoneAmountText("ready", { CNY: 1.25, USD: 0.2 }, ["USD", "CNY"], t),
		"$0.20 · ¥1.25"
	);
});

test("Subagents compact and aggregate values are non-overlapping with Session", () => {
	const { api } = loadBalanceTestApi();
	const t = (key) => key === "statsDecimal.compact.separator" ? " / " : key;
	const parsed = api.parseUsageScopes({
		date: "2026-11-08",
		timeZone: "Europe/Paris",
		session: {
			status: "ready",
			cumulative: { CNY: 1.25, USD: 0.2 },
			today: { CNY: 0.75, USD: 0.1 },
			tokens: { uncachedInput: 20, cacheRead: 30, cacheWrite: 0, output: 10, reasoning: 2 },
			cacheHit: 0.6,
			pricingKnown: true,
			usageKnown: true
		},
		tree: {
			status: "ready",
			cumulative: { CNY: 3.4, USD: 0.47 },
			today: { CNY: 1.2, USD: 0.17 },
			tokens: { uncachedInput: 30, cacheRead: 40, cacheWrite: 0, output: 15, reasoning: 3 },
			cacheHit: 0.57,
			pricingKnown: true,
			usageKnown: true,
			hasDescendants: true,
			subagentsAggregate: {
				cumulative: { CNY: 2.15, USD: 0.27 },
				today: { CNY: 0.45, USD: 0.07 },
				tokens: { uncachedInput: 10, cacheRead: 10, cacheWrite: 0, output: 5, reasoning: 1 }
			}
		},
		local: { status: "ready", today: { CNY: 0, USD: 0 }, tokens: null, cacheHit: null, pricingKnown: true, usageKnown: true, sessionCount: 0 }
	});
	assert.equal(api.compactSubagentsText(parsed.tree, "ready", "USD", t), "$0.27 / $0.07");
	assert.equal(api.compactSubagentsText(parsed.tree, "ready", "USD", t).includes("$0.47"), false);
	assert.equal(api.cacheHitFromTokens(parsed.tree.subagentsAggregate.tokens), 0.5);
	assert.equal(parsed.session.tokens.uncachedInput + parsed.tree.subagentsAggregate.tokens.uncachedInput, parsed.tree.tokens.uncachedInput);
	assert.ok(Math.abs((parsed.session.cumulative.USD + parsed.tree.subagentsAggregate.cumulative.USD) - parsed.tree.cumulative.USD) < 1e-12);
});

test("Balance display status requires an actual numeric amount and agrees across surfaces", () => {
	const { api } = loadBalanceTestApi();
	const currencies = ["CNY", "USD"];
	assert.equal(api.balanceDisplayStatus(true, true, null, currencies), "loading");
	assert.equal(api.balanceDisplayStatus(false, false, null, currencies), "disabled");
	assert.equal(api.balanceDisplayStatus(true, false, null, currencies), "unavailable");
	assert.equal(api.balanceDisplayStatus(true, false, { balances: { CNY: null, USD: null }, provider: "deepseek-account" }, currencies), "unavailable");
	assert.equal(api.balanceDisplayStatus(true, false, { balances: { CNY: null, USD: 0 }, provider: "deepseek-account" }, currencies), "ready");
	assert.equal(api.balanceDisplayStatus(true, false, { balances: { CNY: 8.5, USD: null }, provider: "deepseek-account" }, currencies), "ready");
	assert.equal(api.firstAvailableBalanceCurrency(currencies, { CNY: null, USD: 3.2 }), "USD");
	assert.equal(api.firstAvailableBalanceCurrency(currencies, { CNY: null, USD: null }), null);
	assert.equal(api.compactSingleText("unavailable", { CNY: null, USD: null }, "CNY", (key) => key), "statsDecimal.compact.unavailable");
	assert.match(source, /const balanceStatus = balanceDisplayStatus\(balanceEnabled, balanceLoading, visibleBalance, currencies\)/);
	assert.match(source, /detailCard\("balance", t\("statsDecimal\.scope\.balance"\), balanceStatus/);
	assert.match(source, /visibleBalance\?\.provider \? t\("statsDecimal\.detail\.balanceSource"/);
});

test("usage scopes layout breakpoints are container thresholds, not viewport/sidebar state", () => {
	const { api } = loadBalanceTestApi();
	assert.equal(api.layoutModeForWidth(800), "medium");
	assert.equal(api.layoutModeForWidth(1000), "medium");
	assert.equal(api.layoutModeForWidth(799), "medium");
	assert.equal(api.layoutModeForWidth(400), "medium");
	assert.equal(api.layoutModeForWidth(399), "narrow");
	assert.match(api.ZONE_CSS, /container-type:inline-size/);
	assert.match(api.ZONE_CSS, /\.dsh-sd-responsive\{container-type:inline-size/);
	assert.match(api.ZONE_CSS, /\.dsh-sd-inset\{[^}]*padding:0 calc\(var\(--dsh-composer-side-clearance\) \+ 16px\)/);
	assert.doesNotMatch(api.ZONE_CSS, /\[data-stats-decimal-zone\]\{[^}]*container-type/);
	assert.match(source, /className: "dsh-sd-responsive"/);
	assert.match(source, /className: "dsh-sd-inset"/);
	assert.match(api.ZONE_CSS, /@container \(min-width:400px\)/);
	assert.match(api.ZONE_CSS, /grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
	assert.doesNotMatch(api.ZONE_CSS, /grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/);
	assert.doesNotMatch(api.ZONE_CSS, /ZONE_WIDE_MIN|min-width:800px/);
	assert.doesNotMatch(source, /ZONE_WIDE_MIN|repeat\(4,minmax\(0,1fr\)\)/);
	assert.match(api.ZONE_CSS, /font-variant-numeric:tabular-nums/);
	assert.equal((source.match(/data-composer-dock/g) ?? []).length, 1);
	assert.doesNotMatch(source, /textOverflow|text-overflow|ellipsis/);
	assert.doesNotMatch(source, /closest\('\[data-slot|parentElement/);
	assert.doesNotMatch(source, /sidebar|innerWidth ===|innerWidth </);
	assert.doesNotMatch(source, /overflow-x\s*:/);
});

test("dock adapter orders the plugin after native items, not native content after the plugin", () => {
	const { api } = loadBalanceTestApi();
	assert.equal(api.ZONE_DOCK_ORDER, 1);
	assert.match(api.ZONE_CSS, /\[data-stats-decimal-zone\]\{[^}]*order:1/);
	assert.match(api.ZONE_CSS, /flex-wrap:wrap/);
	assert.match(api.ZONE_CSS, /flex:1 1 100%/);
	assert.doesNotMatch(source, /ContextMeter|A6Bq1a|21%|nth-child|nextElementSibling|previousElementSibling/);

	// Observed DOM order in DSH: slot entries (activity, usage, plugin) followed
	// by the Context Meter sibling. CSS order 0 is native; the plugin is after
	// every native item, so native relative order is unchanged.
	const dockItems = [
		{ key: "native-activity", order: 0 },
		{ key: "native-usage", order: 0 },
		{ key: "plugin-zone", order: api.ZONE_DOCK_ORDER },
		{ key: "native-context", order: 0 }
	];
	const visualOrder = [...dockItems]
		.sort((left, right) => left.order - right.order)
		.map((item) => item.key);
	assert.deepEqual(visualOrder, [
		"native-activity",
		"native-usage",
		"native-context",
		"plugin-zone"
	]);
});

test("detail opening does not start a unique accounting computation path", () => {
	assert.match(source, /requestRefreshTask\(usageScopesRefreshKey\(sessionId, "fast"\)\)/);
	assert.match(source, /requestRefreshTask\(usageScopesRefreshKey\(sessionId, "local"\)\)/);
	assert.match(source, /subscribeUsageScopes\(sessionId, \(snapshot\) => setUsageSnapshot/);
	const triggerBlock = source.slice(source.indexOf("const zone = h"), source.indexOf("const detailRows ="));
	assert.doesNotMatch(triggerBlock, /requestRefreshTask|rpcFetchUsageScopes/);
});

test("detail positioning passes through a hidden first measurement and rAF settle", () => {
	const { api } = loadBalanceTestApi();
	const right = api.computeDetailPosition(
		{ left: 950, top: 300, width: 40, height: 40, bottom: 340 },
		{ width: 300, height: 180 },
		{ width: 1000, height: 800 }
	);
	assert.equal(right.placement, "below");
	assert.ok(right.left + right.width <= 988);
	const small = api.computeDetailPosition(
		{ left: 10, top: 180, width: 40, height: 40, bottom: 220 },
		{ width: 460, height: 500 },
		{ width: 320, height: 240 }
	);
	assert.ok(small.width <= 296);
	assert.ok(small.left >= 12);
	assert.ok(small.top >= 12);
	assert.ok(small.maxHeight >= 120);
	assert.match(source, /visibility: detailReady \? "visible" : "hidden"/);
	assert.match(source, /requestAnimationFrame/);
	assert.match(source, /const openDetail = \(\) =>/);
	assert.match(source, /setDetailPosition\(null\)/);
});

test("usage scopes detail positioning stays inside the viewport and flips near the bottom", () => {
	const { api } = loadBalanceTestApi();
	const below = api.computeDetailPosition(
		{ left: 400, top: 300, width: 100, height: 40, bottom: 340 },
		{ width: 300, height: 180 },
		{ width: 1000, height: 800 }
	);
	assert.equal(below.placement, "below");
	assert.ok(below.left >= 12);
	assert.ok(below.top >= 12);
	assert.ok(below.left + below.width <= 988);

	const above = api.computeDetailPosition(
		{ left: 400, top: 700, width: 100, height: 40, bottom: 740 },
		{ width: 300, height: 500 },
		{ width: 1000, height: 800 }
	);
	assert.equal(above.placement, "above");
	assert.ok(above.top >= 12);
	assert.ok(above.maxHeight >= 120);
});

test("progressive usage scopes deliver Session/Tree before Local Today resolves", async () => {
	const { api, advance } = loadBalanceTestApi();
	let releaseLocal;
	const localGate = new Promise((resolve) => { releaseLocal = resolve; });
	api.bindUsageScopesRpc(async (_base, _method, payload) => {
		if (payload.scopes.includes("local")) {
			await localGate;
			return {
				ok: true,
				value: {
					date: "2026-11-08",
					timeZone: "Europe/Paris",
					session: null,
					tree: null,
					local: {
						status: "ready",
						today: { CNY: 5, USD: 1 },
						tokens: null,
						cacheHit: null,
						pricingKnown: true,
						usageKnown: true,
						sessionCount: 4
					},
					generatedAt: 2
				}
			};
		}
		return {
			ok: true,
			value: {
				date: "2026-11-08",
				timeZone: "Europe/Paris",
				session: {
					status: "ready",
					cumulative: { CNY: 1, USD: 0.2 },
					today: { CNY: 0.5, USD: 0.1 },
					tokens: null,
					cacheHit: null,
					pricingKnown: true,
					usageKnown: true
				},
				tree: {
					status: "ready",
					cumulative: { CNY: 1, USD: 0.2 },
					today: { CNY: 0.5, USD: 0.1 },
					tokens: null,
					cacheHit: null,
					pricingKnown: true,
					usageKnown: true,
					complete: true,
					hasDescendants: false,
					diagnostics: {}
				},
				local: null,
				generatedAt: 1
			}
		};
	});
	const updates = [];
	const release = api.subscribeUsageScopes("progressive-session", (snapshot) => updates.push(snapshot));
	await advance(0);
	assert.ok(updates.some((snapshot) => snapshot.fastValue !== null && snapshot.localValue === null));
	releaseLocal();
	await advance(0);
	assert.ok(updates.some((snapshot) => snapshot.fastValue !== null && snapshot.localValue?.local?.today?.CNY === 5));
	release();
});

test("a Local Today failure does not erase fast Session/Tree data", async () => {
	const { api, advance } = loadBalanceTestApi();
	api.bindUsageScopesRpc(async (_base, _method, payload) => {
		if (payload.scopes.includes("local")) return { ok: false, error: { code: "rpc-error" } };
		return {
			ok: true,
			value: {
				date: "2026-11-08",
				timeZone: "Europe/Paris",
				session: {
					status: "ready",
					cumulative: { CNY: 1, USD: 0.2 },
					today: { CNY: 0.5, USD: 0.1 },
					tokens: null,
					cacheHit: null,
					pricingKnown: true,
					usageKnown: true
				},
				tree: {
					status: "ready",
					cumulative: { CNY: 1, USD: 0.2 },
					today: { CNY: 0.5, USD: 0.1 },
					tokens: null,
					cacheHit: null,
					pricingKnown: true,
					usageKnown: true,
					complete: true,
					hasDescendants: false,
					diagnostics: {}
				},
				local: null,
				generatedAt: 1
			}
		};
	});
	const updates = [];
	const release = api.subscribeUsageScopes("independent-session", (snapshot) => updates.push(snapshot));
	await advance(0);
	assert.ok(updates.some((snapshot) => snapshot.fastValue?.session?.status === "ready"));
	assert.ok(updates.some((snapshot) => snapshot.fastValue !== null && snapshot.localError !== null));
	release();
});

test("usage scopes compact Zone is on the accepted dock slot and removes the old private DOM layout", () => {
	assert.match(source, /name: "conversation\.composer\.dock"/);
	assert.match(source, /id: "stats-decimal-billing"/);
	assert.match(source, /order: 10/);
	assert.match(source, /data-stats-decimal-zone/);
	assert.match(source, /"data-plugin": "dsh-stats-decimal"/);
	assert.match(source, /dsh-sd-pills/);
	assert.doesNotMatch(source, /dsh-sd-grid|dsh-sd-header|dsh-sd-card|dsh-sd-period|dsh-sd-date/);
	assert.match(source, /dsh-sd-detail/);
	assert.match(source, /role: "dialog"/);
	assert.match(source, /Escape/);
	assert.match(source, /pointerdown/);
	assert.match(source, /aria-expanded/);
	assert.match(source, /createPortal/);
	assert.match(source, /aria-modal/);
	assert.match(source, /triggerRef\.current\?\.focus\?\./);
	assert.match(source, /panelRef\.current\?\.focus\?\./);
	assert.match(source, /statsDecimal\.detail\.disclaimer/);
	assert.doesNotMatch(source, /data-slot="conversation\.composer\.dock"/);
	assert.doesNotMatch(source, /statsDecimal\.currency|currencyLedgerSegment\(/);
});

test("usage scopes uses only the aggregate Host read model and the existing balance source", () => {
	assert.match(source, /stats-decimal\/getUsageScopes/);
	assert.match(source, /callGetUsageScopes\(\s*"\/api",\s*"stats-decimal\/getUsageScopes"/s);
	assert.match(source, /usageScopesSnapshot/);
	assert.match(source, /generatedAt/);
	assert.match(source, /stats-decimal\/getBalance/);
	assert.doesNotMatch(source, /listDescendants|parentSession|childId/);
	assert.match(source, /usageScopesEntries\.get\(sessionId\) !== entry/);
	assert.match(source, /usageSnapshotMatchesSession/);
	assert.match(source, /usageSnapshot\?\.sessionId === sessionId/);
	assert.match(source, /statsDecimal\.detail\.transportError/);
	assert.match(source, /statsDecimal\.detail\.period/);
	assert.match(source, /const localCompact = compactSingleText\(localStatus, localScope\?\.today/);
});

test("dense detail uses a two-column wide layout with compact token grids and no-descendant suppression", () => {
	const { api } = loadBalanceTestApi();
	assert.match(api.ZONE_CSS, /\.dsh-sd-detail\{[^}]*width:min\(600px/);
	assert.doesNotMatch(api.ZONE_CSS, /width:min\(620px/);
	assert.doesNotMatch(api.ZONE_CSS, /width:min\(820px/);
	assert.doesNotMatch(api.ZONE_CSS, /width:min\(820px/);
	assert.match(api.ZONE_CSS, /@container \(min-width:520px\)\{\.dsh-sd-detail-grid\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)\}\}/);
	assert.match(api.ZONE_CSS, /\.dsh-sd-token-list\{[^}]*display:grid/);
	assert.doesNotMatch(api.ZONE_CSS, /\.dsh-sd-token-grid/);
	assert.match(source, /treeScope\?\.subagentsAggregate/);
	assert.match(source, /className: "dsh-sd-detail-grid"/);
	assert.match(source, /className: "dsh-sd-token-list"/);
	assert.match(source, /const detailCard =/);
	assert.match(source, /treeHasDescendants === false/);
	assert.match(source, /statsDecimal\.detail\.noDescendants/);
	assert.match(source, /sessionStatus === "ready" \? \[\]/);
	assert.match(source, /treeStatus === "ready" \? \[\]/);
	assert.match(source, /function compactSubagentsAriaLabel/);
	assert.match(source, /treeScope\?\.hasDescendants === false/);
	assert.match(source, /statsDecimal\.compact\.notUsed/);
	assert.match(source, /statsDecimal\.detail\.treeTotal/);
	assert.match(source, /const subagentsCard =/);
	assert.match(source, /detailCard\("subagents", t\("statsDecimal\.scope\.subagents"\), treeStatus, \[\], t\("statsDecimal\.detail\.noDescendants"\), null\)/);
	assert.match(source, /detailCard\("subagents", t\("statsDecimal\.scope\.subagents"\), treeStatus, \[\], t\("statsDecimal\.detail\.subagentsMembershipUnknown"\), null\)/);
	assert.match(source, /detailCard\("subagents", t\("statsDecimal\.scope\.subagents"\), treeStatus, subagentsDetailRows, treeNote, subagentsScope\?\.tokens, subagentsScope\?\.reasoningReported\)/);
	assert.match(source, /const treeTotal = treeHasDescendants === true/);
	assert.doesNotMatch(source, /treeScope\?\.coordinatorDirect/);
	assert.doesNotMatch(source, /detailCard\("subagents".*treeScope\?\.tokens/);
	assert.doesNotMatch(source, /detailCard\("subagents".*treeScope\?\.reasoningReported/);
	assert.doesNotMatch(source, /detailSection\(/);
});

test("usage scopes detail exposes Subagents aggregate values only in the detail surface", () => {
	const detailSection = source.indexOf("const detailRows =");
	const compactSection = source.indexOf("const sessionCompact =");
	assert.ok(compactSection >= 0);
	assert.ok(detailSection > compactSection);
	const compactSlice = source.slice(compactSection, detailSection);
	assert.doesNotMatch(compactSlice, /Coordinator Direct|Subagents Aggregate|statsDecimal\.token\.|cacheHit|sessionCount|detail\.coverage/);
	assert.match(source, /const subagentsScope = treeScope\?\.subagentsAggregate/);
	assert.match(source, /subagentsScope\?\.tokens/);
	assert.match(source, /statsDecimal\.scope\.subagents/);
	assert.match(source, /statsDecimal\.token\.reasoning/);
	assert.match(source, /const localNote =/);
	assert.match(source, /detailCard\("local", t\("statsDecimal\.scope\.local"\), localStatus, localDetailRows, localNote, localScope\?\.tokens, localScope\?\.reasoningReported\)/);
	assert.match(source, /const sessionNote =/);
	const balanceStart = source.indexOf("const balanceCompact =");
	const balanceEnd = source.indexOf("const compactPill =");
	assert.ok(balanceStart >= 0 && balanceEnd > balanceStart);
	assert.doesNotMatch(source.slice(balanceStart, balanceEnd), /statsDecimal\.label\.(cumulative|today)/);
});

test("compact Zone renders four scopes with status-aware values and no detail-only concepts", () => {
	const react = {
		Fragment: Symbol("Fragment"),
		useState(initial) { return [typeof initial === "function" ? initial() : initial, () => {}]; },
		useEffect(effect) { return effect(); },
		useLayoutEffect() {},
		useRef(initial) { return { current: initial }; },
		createElement(type, props, ...children) { return { type, props: props ?? {}, children }; }
	};
	const { api } = loadBalanceTestApi(react);
	const parsed = api.parseUsageScopes({
		date: "2026-11-08",
		timeZone: "Europe/Paris",
		generatedAt: 123456,
		session: {
			status: "ready",
			cumulative: { CNY: 9.2, USD: 1.25 },
			today: { CNY: 3.6, USD: 0.5 },
			tokens: null,
			cacheHit: 0.5,
			pricingKnown: true,
			usageKnown: true
		},
		tree: {
			status: "partial",
			cumulative: { CNY: 24.9, USD: 3.4 },
			today: { CNY: 8.8, USD: 1.2 },
			tokens: null,
			cacheHit: null,
			pricingKnown: false,
			usageKnown: true,
			complete: false,
			diagnostics: { external: true }
		},
		local: {
			status: "unknown",
			today: { CNY: 9.22, USD: 1.38 },
			tokens: null,
			cacheHit: null,
			pricingKnown: false,
			usageKnown: true,
			sessionCount: 30
		}
	});
	api.usageScopesEntries.set("zone-preview-session", {
		sessionId: "zone-preview-session",
		fastValue: parsed,
		localValue: parsed,
		fastRefreshing: false,
		localRefreshing: false,
		fastError: null,
		localError: null,
		listeners: new Set(),
		releaseFast: null,
		releaseLocal: null
	});
	const view = api.BillingStatus({
		useProjection(name) {
			return name === "billingLedger"
				? {
					enabled: true,
					balanceEnabled: false,
					currencies: ["USD", "CNY"],
					peakHours: [],
					publicHolidaySpans: [],
					cumulative: { CNY: 0, USD: 0 },
					today: { CNY: 0, USD: 0 },
					pricingKnown: true
				}
				: { next: null, lastUsed: null };
		},
		t: (key) => key === "statsDecimal.compact.separator" ? " / " : key,
		sessionId: "zone-preview-session"
	});
	const text = (node) => {
		if (node === null || node === void 0 || typeof node === "boolean") return "";
		if (typeof node === "string" || typeof node === "number") return String(node);
		if (Array.isArray(node)) return node.map(text).join(" ");
		if (node.type === "style") return "";
		return (node.children ?? []).map(text).join(" ");
	};
	const rendered = text(view);
	const findNode = (node, predicate) => {
		if (node === null || node === void 0 || typeof node !== "object") return null;
		if (Array.isArray(node)) {
			for (const child of node) {
				const found = findNode(child, predicate);
				if (found !== null) return found;
			}
			return null;
		}
		if (predicate(node)) return node;
		for (const child of node.children ?? []) {
			const found = findNode(child, predicate);
			if (found !== null) return found;
		}
		return null;
	};
	const trigger = findNode(view, (node) => node.props?.role === "button");
	assert.ok(trigger);
	assert.equal(trigger.props["aria-haspopup"], "dialog");
	assert.equal(trigger.props["aria-expanded"], false);
	assert.equal(typeof trigger.props.onClick, "function");
	assert.equal(typeof trigger.props.onKeyDown, "function");
	assert.equal(typeof trigger.props["aria-label"], "string");
	assert.match(rendered, /statsDecimal\.compact\.session/);
	assert.match(rendered, /statsDecimal\.compact\.subagents/);
	assert.match(rendered, /statsDecimal\.compact\.local/);
	assert.match(rendered, /statsDecimal\.compact\.balance/);
	assert.match(rendered, /\$1\.25 \/ \$0\.50/);
	assert.match(rendered, /statsDecimal\.compact\.partial/);
	assert.match(rendered, /statsDecimal\.compact\.unknown/);
	assert.match(rendered, /statsDecimal\.compact\.disabled/);
	assert.doesNotMatch(rendered, /¥1\.25/);
	assert.doesNotMatch(rendered, /¥9\.22/);
	assert.doesNotMatch(rendered, /statsDecimal\.label\.(cumulative|today)/);
	assert.doesNotMatch(rendered, /2026-11-08/);
	assert.match(rendered, /statsDecimal\.periodWeekendOffPeak/);
	assert.doesNotMatch(rendered, /Europe\/Paris/);
	assert.doesNotMatch(rendered, /statsDecimal\.detail\.disclaimer/);
	assert.doesNotMatch(rendered, /statsDecimal\.zone\.estimated/);
	assert.doesNotMatch(rendered, /statsDecimal\.label\.direct/);
	assert.doesNotMatch(rendered, /statsDecimal\.label\.subagents/);
	assert.doesNotMatch(rendered, /statsDecimal\.detail\.tokens/);
	assert.doesNotMatch(rendered, /statsDecimal\.detail\.diagnostics/);
	assert.doesNotMatch(rendered, /zone-preview-session/);
	assert.doesNotMatch(rendered, /source/);
});

test("token counts render as grouped integers without changing values", () => {
	const { api } = loadBalanceTestApi();
	assert.equal(api.formatTokenCount(2214866), "2,214,866");
	assert.equal(api.formatTokenCount(252979328), "252,979,328");
	assert.equal(api.formatTokenCount(811427456), "811,427,456");
	assert.equal(api.formatTokenCount(0), "0");
	assert.equal(api.formatTokenCount(-1), "–");
	assert.equal(api.formatTokenCount(1.5), "–");
});

test("token rows stay sequential and distinguish unreported reasoning from a reported zero", () => {
	const { api } = loadBalanceTestApi();
	const tokens = { uncachedInput: 2214866, cacheRead: 252979328, cacheWrite: 0, output: 667221, reasoning: 0 };
	const labels = (rows) => rows.map(([label]) => label);
	const reported = api.zoneTokenRows(tokens, true, (key) => key);
	const absent = api.zoneTokenRows(tokens, false, (key) => key);
	const unknown = api.zoneTokenRows(tokens, null, (key) => key);
	assert.equal(JSON.stringify(labels(reported)), JSON.stringify([
		"statsDecimal.token.in",
		"statsDecimal.token.cacheRead",
		"statsDecimal.token.cacheWrite",
		"statsDecimal.token.output",
		"statsDecimal.token.reason"
	]));
	assert.equal(reported[0][1], "2,214,866");
	assert.equal(reported[1][1], "252,979,328");
	assert.equal(reported[4][1], "0");
	const nonZero = api.zoneTokenRows({ ...tokens, reasoning: 1234 }, true, (key) => key);
	assert.equal(nonZero[4][1], "1,234");
	assert.equal(absent[4][1], "—");
	assert.equal(unknown[4][1], "—");
});

test("detail density uses compact label/value grids and a permanent pricing-band pill", () => {
	const { api } = loadBalanceTestApi();
	assert.match(api.ZONE_CSS, /\.dsh-sd-detail-rows\{[^}]*grid-template-columns:minmax\(0,1fr\) auto/);
	assert.match(api.ZONE_CSS, /\.dsh-sd-detail-row\{display:contents\}/);
	assert.match(api.ZONE_CSS, /\.dsh-sd-detail-label\{[^}]*justify-self:start/);
	assert.match(api.ZONE_CSS, /\.dsh-sd-detail-value\{[^}]*text-align:right[^}]*justify-self:end/);
	assert.match(api.ZONE_CSS, /\.dsh-sd-token-list\{[^}]*grid-template-columns:minmax\(0,1fr\) auto/);
	assert.match(api.ZONE_CSS, /\.dsh-sd-token-item\{display:contents\}/);
	assert.match(api.ZONE_CSS, /\.dsh-sd-token-label\{[^}]*justify-self:start/);
	assert.match(api.ZONE_CSS, /\.dsh-sd-token-value\{[^}]*text-align:right[^}]*justify-self:end/);
	assert.match(api.ZONE_CSS, /\.dsh-sd-detail-label\{[^}]*min-width:0/);
	assert.doesNotMatch(api.ZONE_CSS, /\.dsh-sd-detail-card-title\{[^}]*text-align:center/);
	assert.doesNotMatch(api.ZONE_CSS, /\.dsh-sd-token-grid/);
	assert.match(api.ZONE_CSS, /\.dsh-sd-band-row\{[^}]*justify-content:center/);
	assert.match(api.ZONE_CSS, /\.dsh-sd-band-row \.dsh-sd-pill-period\{flex:0 1 auto\}/);
	assert.match(api.ZONE_CSS, /\.dsh-sd-detail-grid\{[^}]*gap:7px 20px/);
	assert.match(api.ZONE_CSS, /\.dsh-sd-pills\{[^}]*gap:4px 10px/);
	assert.match(api.ZONE_CSS, /\.dsh-sd-pill\{[^}]*grid-template-columns:minmax\(0,1fr\) auto/);
	assert.match(api.ZONE_CSS, /\.dsh-sd-pill-label\{[^}]*justify-self:start/);
	assert.match(api.ZONE_CSS, /\.dsh-sd-pill-value-group\{[^}]*justify-self:end/);
	assert.match(api.ZONE_CSS, /\.dsh-sd-pill-value\{[^}]*text-align:right/);
	assert.match(source, /className: "dsh-sd-pill-value-group"/);
	assert.match(source, /status === "partial" \? h\("span", \{ className: "dsh-sd-partial"/);
	assert.match(source, /className: "dsh-sd-pill dsh-sd-pill-period"/);
	assert.match(source, /h\("div", \{ className: "dsh-sd-band-row" \}, pricingPill\)/);
	assert.match(source, /const compactPills = \[\s*compactPill\("session"/);
	assert.match(source, /data-scope": "period"/);
	assert.doesNotMatch(source, /const compactPills = \[\s*pricingPill,/);
	assert.match(source, /className: "dsh-sd-detail-rows"/);
	assert.match(source, /rows.length > 0 \? h\("div", \{ className: "dsh-sd-detail-rows"/);
	assert.match(source, /className: "dsh-sd-token-list"/);
	assert.match(source, /detailCard\("balance"/);
	assert.doesNotMatch(source, /className: "dsh-sd-token-grid"/);
});

test("usage scopes parser preserves reasoning presence metadata", () => {
	const { api } = loadBalanceTestApi();
	const parsed = api.parseUsageScopes({
		date: "2026-11-08",
		timeZone: "Europe/Paris",
		session: { status: "ready", cumulative: null, today: null, tokens: { uncachedInput: 1, cacheRead: 0, cacheWrite: 0, output: 1, reasoning: 0 }, reasoningReported: true, cacheHit: null, pricingKnown: true, usageKnown: true },
		tree: { status: "ready", cumulative: null, today: null, tokens: null, reasoningReported: null, cacheHit: null, pricingKnown: true, usageKnown: true, hasDescendants: false, coordinatorDirect: null, subagentsAggregate: null, diagnostics: {} },
		local: { status: "ready", today: null, tokens: null, reasoningReported: false, cacheHit: null, pricingKnown: true, usageKnown: true, sessionCount: 1 }
	});
	assert.equal(parsed.session.reasoningReported, true);
	assert.equal(parsed.local.reasoningReported, false);
	assert.equal(parsed.tree.reasoningReported, null);
});
