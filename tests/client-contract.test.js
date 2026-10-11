import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../lib/client.js", import.meta.url), "utf8");

function loadBalanceTestApi(reactOverride) {
	let clientExports;
	const instrumented = source.replace(
		"\n\t\tfunction apply(ctx)",
		"\n\t\texports.__balanceTestApi = { subscribeBalance, refreshBalance, balanceEntries, refreshTasks, selectedProviderFromProjection, invalidateBalanceEntries, invalidateRemovedSessionBalance, BillingStatus, apply, bindBalanceRpc(fn) { callGetBalance = fn; } };\n\t\tfunction apply(ctx)"
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
	assert.match(source, /const balanceEnabled = ledgerVal !== void 0 && ledgerVal\.balanceEnabled === true/);
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
