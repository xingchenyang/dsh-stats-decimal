import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { holidaySpansForClient } from "../lib/billing-calendar/index.js";
import { bandForTime, costOf, localDayStart, mergePricing } from "../lib/pricing.js";

const source = await readFile(new URL("../lib/index.js", import.meta.url), "utf8");

function makeSchemaStub() {
	return {
		default: makeSchemaStub,
		max: makeSchemaStub,
		min: makeSchemaStub,
		natural: makeSchemaStub,
		nonnegative: makeSchemaStub,
		int: makeSchemaStub,
		nullable: makeSchemaStub,
		strict: makeSchemaStub
	};
}

function loadHostApplyFromSource() {
	const z = Object.fromEntries(["object", "boolean", "array", "natural", "dict", "any", "string"].map((key) => [key, makeSchemaStub]));
	const zod = Object.fromEntries(["object", "number", "boolean", "array", "enum", "string"].map((key) => [key, makeSchemaStub]));
	const executableSource = source
		.replace(/^import .*;\r?\n/gm, "")
		.replace("export { apply, Config };", "")
		.replace("export default plugin;", "")
		.replace(/^export /gm, "")
		+ "\nglobalThis.__applyHostForTest = apply;";
	const context = {
		z,
		zod,
		costOf,
		bandForTime,
		localDayStart,
		mergePricing,
		holidaySpansForClient,
		Response,
		process: { env: {} },
		fetch: (...args) => globalThis.fetch(...args)
	};
	vm.runInNewContext(executableSource, context, { filename: "lib/index.js" });
	return context.__applyHostForTest;
}

function makeBalanceRoute({ credentials, account, logs = [] } = {}) {
	const routes = [];
	const connection = {
		fetch: {
			register(options) {
			routes.push(options);
				return () => {};
			}
		}
	};
	const connectionCtx = {
		connection,
		get(name) {
			if (name === "credentials") return credentials;
			return name === "deepseekAccount" ? account : undefined;
		},
		effect(effect) {
			effect();
		}
	};
	const ctx = {
		sessionProjections: { register() {} },
		inject(dependencies, callback) {
			assert.deepEqual(Array.from(dependencies), ["connection"]);
			callback(connectionCtx);
		},
		logger() {
			return { warn: (message) => logs.push(String(message)) };
		}
	};
	applyHost(ctx, {
		cnyEnabled: true,
		usdEnabled: true,
		balance: { enabled: true }
	});
	const route = routes.find((candidate) => candidate.path === "/api/stats-decimal/getBalance");
	assert.ok(route, "Host registers the shared /api balance route");
	assert.equal(route.path, "/api/stats-decimal/getBalance");
	assert.deepEqual(Array.from(route.methods), ["POST"]);
	assert.equal(route.requestBody, "buffered");
	return route;
}

function makeRpcRequest(route, body) {
	const requestBody = typeof body === "string" ? body : JSON.stringify(body);
	return route.fetch(new Request("http://dsh.test/api/stats-decimal/getBalance", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: requestBody
	}));
}

const VALID_BALANCE_RPC = {
	type: "client-request",
	rpcId: "rpc-balance-1",
	method: "stats-decimal/getBalance"
};

let applyHost;
let hasRealWireSchema = false;
try {
	const hostModule = await import("../lib/index.js");
	applyHost = hostModule.apply;
	hasRealWireSchema = true;
} catch (error) {
	const missingDeclaredRuntime = error?.code === "ERR_MODULE_NOT_FOUND"
		&& (String(error.message).includes("@deepseek-ai/schemastery") || String(error.message).includes("zod"));
	if (!missingDeclaredRuntime) throw error;
	// Execute the unchanged production module body with only its unavailable
	// schema constructors stubbed; pricing and calendar functions stay real.
	applyHost = loadHostApplyFromSource();
}

test("projection exposes period configuration and invalidates old cached prices", () => {
	assert.match(source, /peakHours: \[\.\.\.peakHours\]/);
	assert.match(source, /publicHolidaySpans: holidaySpansForClient\(\)/);
	assert.match(source, /publicHolidaySpans: zod\.array/);
	assert.match(source, /stateVersion: 7/);
	assert.match(source, /costOf\(buckets, model, band, currencies, table, timeEpochMs\)/);
	assert.match(source, /const band = bandForTime\(event\.time, peakHours\);/);
	assert.match(source, /const next = foldUsage\(base, buckets, model, band, activeCurrencies, table, true, event\.time\);/);
});

test("the declared runtime dependencies activate real wire-schema validation", { skip: !hasRealWireSchema }, () => {
	assert.equal(hasRealWireSchema, true);
});

	test("Host projection folds historical holiday usage at valley and wires labeled spans", () => {
	const projections = [];
	const ctx = {
		sessionProjections: { register: (projection) => projections.push(projection) },
		// Skip the unrelated optional balance-service registration in this fake Host.
		inject: () => {}
	};
	applyHost(ctx, {
		enableCost: true,
		cnyEnabled: true,
		usdEnabled: false,
		peakHours: [9, 10, 11, 14, 15, 16, 17]
	});
	assert.equal(projections.length, 1);
	const projection = projections[0];
	assert.equal(projection.key, "billingLedger");

	const eventTime = Date.UTC(2026, 8, 25, 1, 0, 0); // 09:00 Beijing on a Friday holiday.
	const usage = { inputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
	const event = {
		type: "assistant/message",
		time: eventTime,
		data: { usage, message: { source: { model: "deepseek-flash" } } }
	};
	const realNow = Date.now;
	try {
		// If classification used the clock, this would be an ordinary Monday peak hour.
		Date.now = () => Date.UTC(2026, 8, 28, 1, 0, 0);
		const state = projection.apply(projection.init(), event);
		const valleyCost = costOf({ uncachedInputTokens: 1_000_000 }, "deepseek-flash", "valley", ["CNY"], undefined, eventTime);
		const peakCost = costOf({ uncachedInputTokens: 1_000_000 }, "deepseek-flash", "peak", ["CNY"], undefined, eventTime);
		assert.equal(state.cumulative.CNY, valleyCost.CNY);
		assert.notEqual(state.cumulative.CNY, peakCost.CNY);
		assert.equal(state.today.CNY, valleyCost.CNY);

		const view = projection.wire.view(state);
		assert.deepEqual(view.publicHolidaySpans, holidaySpansForClient());
		assert.ok(view.publicHolidaySpans.some((span) => span.startDate === "2026-09-25" && span.endDate === "2026-09-27"));
		assert.ok(view.publicHolidaySpans.every((span) => Object.keys(span).sort().join(",") === "endDate,name,nameEn,startDate"));
		if (hasRealWireSchema) assert.deepEqual(projection.wire.viewSchema.parse(view), view);
	} finally {
		Date.now = realNow;
	}
});

test("official Beijing peak hours are the default", () => {
	assert.match(source, /default\(\[9, 10, 11, 14, 15, 16, 17\]\)/);
});

test("balance remains outside the Session event log", () => {
	assert.doesNotMatch(source, /session\.append\(/);
	assert.doesNotMatch(source, /stats-decimal\/balance["'`],/);
});

test("registered balance RPC resolves the key through DSH credentials and returns only the minimal balance view", async () => {
	const fakeCredential = "test-only-balance-key-7fb2";
	const upstreamOnlyValue = "test-provider-private-value-51a9";
	const logs = [];
	const credentialCalls = [];
	let authorization;
	const originalFetch = globalThis.fetch;
	const route = makeBalanceRoute({
		credentials: {
			async resolve(name) {
				credentialCalls.push(name);
				return { value: fakeCredential, source: "test" };
			}
		},
		logs
	});
	try {
		globalThis.fetch = async (url, init) => {
			assert.equal(String(url), "https://api.deepseek.com/user/balance");
			authorization = init.headers.Authorization;
			return new Response(JSON.stringify({
				balance_infos: [
					{ currency: "CNY", topped_up_balance: "12.34", private: upstreamOnlyValue },
					{ currency: "USD", topped_up_balance: 56.78 }
				],
				access_token: upstreamOnlyValue
			}), { headers: { "content-type": "application/json" } });
		};
		const response = await makeRpcRequest(route, VALID_BALANCE_RPC);
		const body = await response.json();
		assert.equal(response.status, 200);
		assert.deepEqual(credentialCalls, ["DEEPSEEK_API_KEY"]);
		assert.equal(authorization, `Bearer ${fakeCredential}`);
		assert.deepEqual(body, {
			type: "server-response",
			rpcId: "rpc-balance-1",
			result: {
				ok: true,
				value: { enabled: true, balances: { CNY: 12.34, USD: 56.78 }, error: null }
			}
		});
		assert.deepEqual(logs, []);
		assert.doesNotMatch(JSON.stringify(body), /test-only-balance-key|test-provider-private-value|access_token|source/);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("missing or failing credentials resolution falls back to account login, then to the existing no-credential result", async () => {
	let accountCalls = 0;
	let apiCalls = 0;
	const originalFetch = globalThis.fetch;
	const accountRoute = makeBalanceRoute({
		credentials: { resolve: async () => { throw new Error("private credential provider detail"); } },
		account: {
			async getBalance(metadata) {
				accountCalls += 1;
				assert.deepEqual(Object.keys(metadata).sort(), ["locale", "timezoneOffsetSeconds", "version"]);
				return { status: "ready", value: [{ currency: "CNY", balance: "8.50", token: "provider-private" }] };
			}
		}
	});
	try {
		globalThis.fetch = async () => { apiCalls += 1; throw new Error("must not fetch"); };
		const accountResponse = await makeRpcRequest(accountRoute, VALID_BALANCE_RPC);
		const accountBody = await accountResponse.json();
		assert.equal(accountResponse.status, 200);
		assert.deepEqual(accountBody.result.value, {
			enabled: true,
			balances: { CNY: 8.5, USD: null },
			error: null
		});
		assert.doesNotMatch(JSON.stringify(accountBody), /private credential|provider-private|token/);

		const missingRoute = makeBalanceRoute({});
		const missingResponse = await makeRpcRequest(missingRoute, VALID_BALANCE_RPC);
		const missingBody = await missingResponse.json();
		assert.deepEqual(missingBody.result.value, {
			enabled: true,
			balances: { CNY: null, USD: null },
			error: "no-balance-credentials"
		});
		assert.equal(accountCalls, 1);
		assert.equal(apiCalls, 0);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("malformed balance RPC envelopes keep the existing 400 responses", async () => {
	let credentialCalls = 0;
	const route = makeBalanceRoute({ credentials: { resolve: async () => { credentialCalls += 1; return undefined; } } });
	const malformed = await makeRpcRequest(route, "{not-json");
	assert.equal(malformed.status, 400);
	assert.equal(await malformed.text(), "body is not JSON");
	const invalid = await makeRpcRequest(route, { ...VALID_BALANCE_RPC, type: "client-event" });
	assert.equal(invalid.status, 400);
	assert.equal(await invalid.text(), "invalid balance RPC request");
	assert.equal(credentialCalls, 0);
});

test("balance provider failures return stable sanitized codes without provider details", async () => {
	const fakeCredential = "test-only-balance-key-failure";
	const providerDetail = "test provider internal detail";
	const originalFetch = globalThis.fetch;
	const route = makeBalanceRoute({ credentials: { resolve: async () => ({ value: fakeCredential }) } });
	try {
		globalThis.fetch = async () => new Response(providerDetail, { status: 503 });
		const httpResponse = await makeRpcRequest(route, VALID_BALANCE_RPC);
		const httpBody = await httpResponse.json();
		assert.equal(httpBody.result.value.error, "http-503");
		assert.deepEqual(httpBody.result.value.balances, { CNY: null, USD: null });
		assert.doesNotMatch(JSON.stringify(httpBody), /test-only-balance-key|test provider internal detail/);

		globalThis.fetch = async () => { throw new Error(providerDetail); };
		const networkResponse = await makeRpcRequest(route, VALID_BALANCE_RPC);
		const networkBody = await networkResponse.json();
		assert.equal(networkBody.result.value.error, "fetch-failed");
		assert.doesNotMatch(JSON.stringify(networkBody), /test-only-balance-key|test provider internal detail/);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("account-provider failures expose only the existing sanitized error code", async () => {
	const providerSecret = "test-provider-private-auth-detail";
	const logs = [];
	const route = makeBalanceRoute({
		credentials: {},
		account: {
			async getBalance() {
				const error = new Error(providerSecret);
				error.name = providerSecret;
				throw error;
			}
		},
		logs
	});
	const response = await makeRpcRequest(route, VALID_BALANCE_RPC);
	const body = await response.json();
	assert.deepEqual(body.result.value, {
		enabled: true,
		balances: { CNY: null, USD: null },
		error: "account-balance-failed"
	});
	assert.doesNotMatch(JSON.stringify(body), /test-provider-private-auth-detail/);
	assert.ok(logs.every((message) => !message.includes(providerSecret)));
});

test("invalid balance values are rejected without changing valid currency values", async () => {
	const originalFetch = globalThis.fetch;
	const route = makeBalanceRoute({ credentials: { resolve: async () => ({ value: "test-only-key" }) } });
	try {
		globalThis.fetch = async () => new Response(JSON.stringify({
			balance_infos: [
				{ currency: "CNY", topped_up_balance: "33.20abc" },
				{ currency: "USD", topped_up_balance: "-5" }
			]
		}), { headers: { "content-type": "application/json" } });
		const response = await makeRpcRequest(route, VALID_BALANCE_RPC);
		const body = await response.json();
		assert.deepEqual(body.result.value.balances, { CNY: null, USD: null });
		assert.equal(body.result.value.error, null);

		globalThis.fetch = async () => new Response(JSON.stringify({
			balance_infos: [{ currency: "USD", topped_up_balance: "0x10" }]
		}), { headers: { "content-type": "application/json" } });
		const hexResponse = await makeRpcRequest(route, VALID_BALANCE_RPC);
		const hexBody = await hexResponse.json();
		assert.deepEqual(hexBody.result.value.balances, { CNY: null, USD: null });
	} finally {
		globalThis.fetch = originalFetch;
	}
});
