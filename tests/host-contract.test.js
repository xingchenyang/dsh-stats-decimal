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
		required: makeSchemaStub,
		strict: makeSchemaStub
	};
}

function loadHostApplyFromSource() {
	const z = Object.fromEntries(["object", "boolean", "array", "natural", "dict", "any", "string", "union", "const"].map((key) => [key, makeSchemaStub]));
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
		AbortController,
		TextDecoder,
		URL,
		setTimeout,
		clearTimeout,
		process: { env: {} },
		fetch: (...args) => globalThis.fetch(...args)
	};
	vm.runInNewContext(executableSource, context, { filename: "lib/index.js" });
	return context.__applyHostForTest;
}

function makeBalanceRoute(options = {}) {
	const { credentials, logs = [], serviceLookups = [] } = options;
	const listeners = new Map();
	const projectionListeners = new Set();
	const disposers = [];
	let projectionReads = 0;
	const modelSelection = options.modelSelection ?? { next: null, lastUsed: null };
	const sessionController = options.sessionController === null ? null : {
		async projections({ sessionId }, signal) {
			projectionReads += 1;
			options.onProjectionRead?.(sessionId, projectionReads, signal);
			if (options.projectionError) throw new Error("private projection detail");
			if (options.sessionExists === false) return null;
			return {
				asOfSeq: projectionReads,
				values: { modelSelection: typeof modelSelection === "function" ? modelSelection(projectionReads, sessionId) : modelSelection }
			};
		}
	};
	const defaultModel = {
		currentSelection() {
			options.defaultReads?.();
			return typeof options.defaultSelection === "function"
				? options.defaultSelection()
				: options.defaultSelection ?? { provider: options.defaultProvider ?? "deepseek-official", model: "test-model" };
		}
	};
	const account = options.account === null ? null : { ...(options.account ?? {}) };
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
			serviceLookups.push(name);
			options.onConnectionServiceGet?.(name);
			if (name === "sessionController") return sessionController;
			if (name === "agentDefaultModel") return defaultModel;
			if (name === "credentials") return credentials;
			return name === "deepseekAccount" ? account : undefined;
		},
		effect(effect) {
			effect();
		}
	};
	const officialNamespace = options.settingsNamespace ?? "llm-deepseek-api-key";
	const llm = options.llm === null ? null : {
		listProviders() {
			const providers = typeof options.providers === "function" ? options.providers() : options.providers;
			return providers ?? [{ id: "deepseek-official", name: "DeepSeek" }];
		},
		listConfigurableProviders() {
			const providers = typeof options.configurableProviders === "function"
				? options.configurableProviders()
				: options.configurableProviders;
			return providers ?? [{
				provider: "deepseek-official",
				displayName: "DeepSeek",
				settingsNs: officialNamespace,
				settingsPath: []
			}];
		}
	};
	const settings = options.settings === null ? null : {
		describe(describeOptions) {
			options.onSettingsDescribe?.(describeOptions);
			if (options.settingsError) throw new Error("private settings detail");
			if (options.settingsDescriptors !== undefined) {
				return typeof options.settingsDescriptors === "function"
					? options.settingsDescriptors()
					: options.settingsDescriptors;
			}
			const value = typeof options.officialConfig === "function"
				? options.officialConfig()
				: options.officialConfig ?? { apiKeyEnv: "DEEPSEEK_API_KEY" };
			const revision = typeof options.settingsRevision === "function"
				? options.settingsRevision()
				: options.settingsRevision ?? 0;
			return [{
				ns: officialNamespace,
				applies: options.settingsApplies ?? "live",
				revision,
				value
			}];
		}
	};
	const launchEnvironment = options.launchEnvironment === null
		? null
		: options.launchEnvironment ?? { get() { return undefined; } };
	const ctx = {
		sessionProjections: {
			register() {},
			onChanged(listener) { projectionListeners.add(listener); return () => projectionListeners.delete(listener); }
		},
		get(name) {
			if (name === "llm") return llm;
			if (name === "settings") return settings;
			if (name === "launchEnvironment") return launchEnvironment;
			return undefined;
		},
		on(name, listener) {
			const entries = listeners.get(name) ?? new Set();
			entries.add(listener);
			listeners.set(name, entries);
			const dispose = () => entries.delete(listener);
			disposers.push(dispose);
			return dispose;
		},
		effect(effect) {
			const dispose = effect();
			if (typeof dispose === "function") disposers.push(dispose);
			return dispose;
		},
		inject(dependencies, callback) {
			assert.deepEqual(Array.from(dependencies), ["connection"]);
			callback(connectionCtx);
		},
		logger() {
			return { warn: (message) => logs.push(String(message)) };
		}
	};
	const balance = { enabled: options.enabled !== false };
	applyHost(ctx, {
		cnyEnabled: true,
		usdEnabled: true,
		balance
	});
	const route = routes.find((candidate) => candidate.path === "/api/stats-decimal/getBalance");
	assert.ok(route, "Host registers the shared /api balance route");
	assert.equal(route.path, "/api/stats-decimal/getBalance");
	assert.deepEqual(Array.from(route.methods), ["POST"]);
	assert.equal(route.requestBody, "buffered");
	route.hostControl = {
		emit(name, ...args) {
			for (const listener of listeners.get(name) ?? []) listener(...args);
		},
		emitProjection(sessionId, key = "modelSelection", value = null, seq = projectionReads) {
			for (const listener of projectionListeners) listener({ id: sessionId }, key, value, seq);
		},
		listenerCounts() {
			return {
				projections: projectionListeners.size,
				host: [...listeners.values()].reduce((count, entries) => count + entries.size, 0)
			};
		},
		dispose() {
			for (const dispose of disposers.splice(0).reverse()) dispose();
		}
	};
	return route;
}

function makeSessionDailyRoute(sessionQuery) {
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
			return name === "sessionQuery" ? sessionQuery : undefined;
		},
		effect(effect) {
			effect();
		}
	};
	const ctx = {
		sessionProjections: { register() {} },
		inject(_dependencies, callback) {
			callback(connectionCtx);
		}
	};
	applyHost(ctx, {
		enableCost: true,
		cnyEnabled: true,
		usdEnabled: true,
		balance: { enabled: false }
	});
	const route = routes.find((candidate) => candidate.path === "/api/stats-decimal/getSessionDailyCost");
	assert.ok(route, "Host registers the authenticated session daily-cost route");
	return route;
}

function makeRpcRequest(route, body, endpoint = "getBalance", signal) {
	const requestBody = typeof body === "string" ? body : JSON.stringify(body);
	return route.fetch(new Request(`http://dsh.test/api/stats-decimal/${endpoint}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: requestBody,
		signal
	}));
}

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
	return { promise, resolve, reject };
}

const VALID_BALANCE_RPC = {
	type: "client-request",
	rpcId: "rpc-balance-1",
	method: "stats-decimal/getBalance",
	payload: { sessionId: "session-balance-test" }
};

let applyHost;
let hostConfig;
let hasRealWireSchema = false;
try {
	const hostModule = await import("../lib/index.js");
	applyHost = hostModule.apply;
	hostConfig = hostModule.Config;
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

test("balance change listeners are disposed with the owning plugin context", () => {
	const route = makeBalanceRoute();
	assert.equal(route.hostControl.listenerCounts().projections, 1);
	assert.ok(route.hostControl.listenerCounts().host >= 5);
	route.hostControl.dispose();
	assert.deepEqual(route.hostControl.listenerCounts(), { projections: 0, host: 0 });
});

test("balance config needs no provider and ignores obsolete provider and apiBase values", { skip: !hasRealWireSchema }, () => {
	assert.match(source, /provider: z\.string\(\)/);
	assert.match(source, /apiBase: z\.string\(\)/);
	assert.doesNotMatch(source, /balanceCfg\.provider|balanceCfg\.apiBase/);
	assert.deepEqual(hostConfig({ balance: { enabled: false } }).balance, { enabled: false });
	assert.deepEqual(hostConfig({ balance: { enabled: true } }).balance, { enabled: true });
	const oldConfig = hostConfig({ balance: { enabled: true, provider: "deepseek-account", apiBase: "https://attacker.invalid" } });
	assert.equal(oldConfig.balance.enabled, true);
	assert.doesNotMatch(source, /fetch\(.*apiBase/s);
});

test("default official provider resolves the API key and uses the fixed Host destination", async () => {
	const fakeCredential = "test-only-balance-key-7fb2";
	const upstreamOnlyValue = "test-provider-private-value-51a9";
	const logs = [];
	const serviceLookups = [];
	const credentialCalls = [];
	let accountCalls = 0;
	let authorization;
	const destinations = [];
	const originalFetch = globalThis.fetch;
	const route = makeBalanceRoute({
		defaultProvider: "deepseek-official",
		credentials: {
			async resolve(name) {
				credentialCalls.push(name);
				return { value: fakeCredential, source: "test" };
			}
		},
		account: { async getBalance() { accountCalls += 1; return { status: "ready", value: [] }; } },
		serviceLookups,
		logs
	});
	try {
		globalThis.fetch = async (url, init) => {
			destinations.push(String(url));
			assert.equal(String(url), "https://api.deepseek.com/user/balance");
			assert.equal(init.redirect, "error");
			authorization = init.headers.Authorization;
			return new Response(JSON.stringify({
				balance_infos: [
					{ currency: "CNY", topped_up_balance: "12.34", private: upstreamOnlyValue },
					{ currency: "USD", topped_up_balance: 56.78 }
				],
				access_token: upstreamOnlyValue
			}), { headers: { "content-type": "application/json" } });
		};
		const response = await makeRpcRequest(route, {
			...VALID_BALANCE_RPC,
			payload: { ...VALID_BALANCE_RPC.payload, provider: "deepseek-account" },
			apiBase: "https://attacker.invalid:9443/collect",
			endpoint: "http://attacker.invalid/collect"
		});
		const body = await response.json();
		assert.equal(response.status, 200);
		assert.deepEqual(serviceLookups, ["sessionController", "agentDefaultModel", "credentials", "sessionController", "agentDefaultModel", "sessionController", "agentDefaultModel"]);
		assert.deepEqual(credentialCalls, ["DEEPSEEK_API_KEY"]);
		assert.equal(accountCalls, 0);
		assert.deepEqual(destinations, ["https://api.deepseek.com/user/balance"]);
		assert.equal(authorization, `Bearer ${fakeCredential}`);
		assert.deepEqual(body, {
			type: "server-response",
			rpcId: "rpc-balance-1",
			result: {
				ok: true,
				value: { enabled: true, provider: "deepseek-official", balanceGeneration: 0, balances: { CNY: 12.34, USD: 56.78 }, error: null }
			}
		});
		assert.deepEqual(logs, []);
		assert.doesNotMatch(JSON.stringify(body), /test-only-balance-key|test-provider-private-value|access_token|source/);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("official balance binds a custom credential reference to the canonical configured route", async () => {
	const fakeCredential = "test-custom-ref-key";
	const credentialCalls = [];
	let settingsWasRedacted = false;
	const originalFetch = globalThis.fetch;
	const route = makeBalanceRoute({
		officialConfig: { baseURL: "https://api.deepseek.com/anthropic", apiKeyEnv: "TEAM_DEEPSEEK_KEY" },
		launchEnvironment: { get() { throw new Error("explicit baseURL must take precedence"); } },
		onSettingsDescribe(options) { settingsWasRedacted = options?.redactSecrets === true; },
		credentials: { async resolve(ref) { credentialCalls.push(ref); return { value: fakeCredential }; } }
	});
	try {
		globalThis.fetch = async (url, init) => {
			assert.equal(String(url), "https://api.deepseek.com/user/balance");
			assert.equal(init.redirect, "error");
			assert.equal(init.headers.Authorization, `Bearer ${fakeCredential}`);
			return new Response(JSON.stringify({ balance_infos: [{ currency: "CNY", topped_up_balance: 5 }] }));
		};
		const response = await makeRpcRequest(route, VALID_BALANCE_RPC);
		const body = await response.json();
		assert.equal(body.result.value.balances.CNY, 5);
		assert.deepEqual(credentialCalls, ["TEAM_DEEPSEEK_KEY"]);
		assert.equal(settingsWasRedacted, true);
		assert.doesNotMatch(JSON.stringify(body), /test-custom-ref-key|TEAM_DEEPSEEK_KEY/);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("canonical DEEPSEEK_BASE_URL override is accepted and its exact credential reference is used", async () => {
	const credentialCalls = [];
	const originalFetch = globalThis.fetch;
	const route = makeBalanceRoute({
		officialConfig: { apiKeyEnv: "CUSTOM_OFFICIAL_KEY" },
		launchEnvironment: { get(name) {
			assert.equal(name, "DEEPSEEK_BASE_URL");
			return { value: "https://api.deepseek.com/anthropic" };
		} },
		credentials: { async resolve(ref) { credentialCalls.push(ref); return { value: "fake-env-route-key" }; } }
	});
	try {
		globalThis.fetch = async () => new Response(JSON.stringify({ balance_infos: [] }));
		const response = await makeRpcRequest(route, VALID_BALANCE_RPC);
		assert.equal((await response.json()).result.value.provider, "deepseek-official");
		assert.deepEqual(credentialCalls, ["CUSTOM_OFFICIAL_KEY"]);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("a proxy configuration fails closed and can recover after returning to the canonical official route", async () => {
	let config = { baseURL: "https://proxy.invalid/anthropic", apiKeyEnv: "OFFICIAL_ROUTE_KEY" };
	let revision = 0;
	let credentialCalls = 0;
	let apiCalls = 0;
	const route = makeBalanceRoute({
		officialConfig: () => config,
		settingsRevision: () => revision,
		credentials: { async resolve(ref) { credentialCalls += 1; assert.equal(ref, "OFFICIAL_ROUTE_KEY"); return { value: "official-route-key" }; } }
	});
	const originalFetch = globalThis.fetch;
	try {
		globalThis.fetch = async (url, init) => {
			apiCalls += 1;
			assert.equal(String(url), "https://api.deepseek.com/user/balance");
			assert.equal(init.redirect, "error");
			return new Response(JSON.stringify({ balance_infos: [] }));
		};
		const rejected = (await (await makeRpcRequest(route, VALID_BALANCE_RPC)).json()).result.value;
		assert.equal(rejected.error, "official-endpoint-unverified");
		assert.equal(credentialCalls, 0);
		assert.equal(apiCalls, 0);
		config = { baseURL: "https://api.deepseek.com/anthropic", apiKeyEnv: "OFFICIAL_ROUTE_KEY" };
		revision += 1;
		route.hostControl.emit("settings/document-updated", "llm-deepseek-api-key", revision);
		const recovered = (await (await makeRpcRequest(route, VALID_BALANCE_RPC)).json()).result.value;
		assert.equal(recovered.error, null);
		assert.equal(credentialCalls, 1);
		assert.equal(apiCalls, 1);
		assert.equal(recovered.balanceGeneration, 1);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("custom, HTTP, lookalike, and non-canonical routes fail before credential resolution or network", async () => {
	const rejectedEndpoints = [
		"https://gateway.example/anthropic",
		"http://api.deepseek.com/anthropic",
		"https://api.deepseek.com.attacker.invalid/anthropic",
		"https://api.deepseek.com:8443/anthropic",
		"https://api.deepseek.com/anthropic/v1"
	];
	const originalFetch = globalThis.fetch;
	try {
		for (const baseURL of rejectedEndpoints) {
			let credentialCalls = 0;
			let apiCalls = 0;
			const route = makeBalanceRoute({
				officialConfig: { baseURL, apiKeyEnv: "DEEPSEEK_API_KEY" },
				credentials: { async resolve() { credentialCalls += 1; return { value: "must-not-resolve" }; } }
			});
			globalThis.fetch = async () => { apiCalls += 1; throw new Error("must not fetch an unverified route"); };
			const response = await makeRpcRequest(route, VALID_BALANCE_RPC);
			const body = await response.json();
			assert.equal(body.result.value.error, "official-endpoint-unverified", baseURL);
			assert.equal(credentialCalls, 0, baseURL);
			assert.equal(apiCalls, 0, baseURL);
			assert.doesNotMatch(JSON.stringify(body), /gateway\.example|attacker\.invalid|must-not-resolve/);
		}
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("an environment proxy and a proxy credential named DEEPSEEK_API_KEY fail closed", async () => {
	let credentialCalls = 0;
	let apiCalls = 0;
	const route = makeBalanceRoute({
		officialConfig: { apiKeyEnv: "DEEPSEEK_API_KEY" },
		launchEnvironment: { get() { return { value: "https://proxy.invalid/anthropic" }; } },
		credentials: { async resolve() { credentialCalls += 1; return { value: "proxy-key" }; } }
	});
	const originalFetch = globalThis.fetch;
	try {
		globalThis.fetch = async () => { apiCalls += 1; throw new Error("must not contact a proxy"); };
		const response = await makeRpcRequest(route, VALID_BALANCE_RPC);
		const body = await response.json();
		assert.equal(body.result.value.error, "official-endpoint-unverified");
		assert.equal(credentialCalls, 0);
		assert.equal(apiCalls, 0);
		assert.doesNotMatch(JSON.stringify(body), /proxy-key|proxy\.invalid/);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("explicit canonical baseURL takes precedence over an environment proxy", async () => {
	let environmentReads = 0;
	let credentialCalls = 0;
	const originalFetch = globalThis.fetch;
	const route = makeBalanceRoute({
		officialConfig: { baseURL: "https://api.deepseek.com/anthropic", apiKeyEnv: "EXPLICIT_ROUTE_KEY" },
		launchEnvironment: { get() { environmentReads += 1; return { value: "https://proxy.invalid/anthropic" }; } },
		credentials: { async resolve(ref) { credentialCalls += 1; assert.equal(ref, "EXPLICIT_ROUTE_KEY"); return { value: "test-key" }; } }
	});
	try {
		globalThis.fetch = async () => new Response(JSON.stringify({ balance_infos: [] }));
		const response = await makeRpcRequest(route, VALID_BALANCE_RPC);
		assert.equal((await response.json()).result.value.provider, "deepseek-official");
		assert.equal(environmentReads, 0);
		assert.equal(credentialCalls, 1);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("missing or unreadable official configuration fails before credentials and Fetch", async () => {
	for (const options of [
		{ settings: null, error: "official-route-configuration-unavailable" },
		{ settingsError: true, error: "official-route-configuration-unavailable" },
		{ settingsDescriptors: [], error: "official-config-unavailable" },
		{ settingsApplies: "pending", error: "official-config-unavailable" },
		{ launchEnvironment: null, error: "official-environment-unavailable" }
	]) {
		let credentialCalls = 0;
		let apiCalls = 0;
		const route = makeBalanceRoute({
			...options,
			credentials: { async resolve() { credentialCalls += 1; return { value: "must-not-resolve" }; } }
		});
		const originalFetch = globalThis.fetch;
		try {
			globalThis.fetch = async () => { apiCalls += 1; throw new Error("must not fetch without config"); };
			const response = await makeRpcRequest(route, VALID_BALANCE_RPC);
			assert.equal((await response.json()).result.value.error, options.error);
			assert.equal(credentialCalls, 0);
			assert.equal(apiCalls, 0);
		} finally {
			globalThis.fetch = originalFetch;
		}
	}
});

test("only the active official provider declaration and a valid credential reference are accepted", async () => {
	for (const options of [
		{ providers: [], error: "official-provider-unavailable" },
		{ configurableProviders: [], error: "official-provider-unavailable" },
		{ settingsNamespace: "third-party-provider", error: "official-provider-unavailable" },
		{ officialConfig: { baseURL: "https://api.deepseek.com/anthropic", apiKeyEnv: "not/a/reference" }, error: "official-credential-reference-invalid" }
	]) {
		let credentialCalls = 0;
		let apiCalls = 0;
		const route = makeBalanceRoute({
			...options,
			credentials: { async resolve() { credentialCalls += 1; return { value: "must-not-resolve" }; } }
		});
		const originalFetch = globalThis.fetch;
		try {
			globalThis.fetch = async () => { apiCalls += 1; throw new Error("must not fetch without a verified route"); };
			const response = await makeRpcRequest(route, VALID_BALANCE_RPC);
			assert.equal((await response.json()).result.value.error, options.error);
			assert.equal(credentialCalls, 0);
			assert.equal(apiCalls, 0);
		} finally {
			globalThis.fetch = originalFetch;
		}
	}
});

test("third-party provider routes never inspect DeepSeek credentials or call balance endpoints", async () => {
	let credentialCalls = 0;
	let accountCalls = 0;
	let apiCalls = 0;
	const route = makeBalanceRoute({
		modelSelection: { next: { provider: "openai", model: "third-party-model" }, lastUsed: null },
		credentials: { async resolve() { credentialCalls += 1; return { value: "must-not-resolve" }; } },
		account: { async getBalance() { accountCalls += 1; return { status: "ready", value: [] }; } }
	});
	const originalFetch = globalThis.fetch;
	try {
		globalThis.fetch = async () => { apiCalls += 1; throw new Error("must not fetch for third-party providers"); };
		const response = await makeRpcRequest(route, VALID_BALANCE_RPC);
		assert.equal((await response.json()).result.value.error, "unsupported-provider");
		assert.deepEqual({ credentialCalls, accountCalls, apiCalls }, { credentialCalls: 0, accountCalls: 0, apiCalls: 0 });
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("a changed adapter credential reference during credential resolution prevents dispatch", async () => {
	let currentConfig = { baseURL: "https://api.deepseek.com/anthropic", apiKeyEnv: "FIRST_ROUTE_KEY" };
	let revision = 0;
	let releaseCredential;
	let credentialStarted;
	const credentialStartedPromise = new Promise((resolve) => { credentialStarted = resolve; });
	let credentialCalls = 0;
	let apiCalls = 0;
	const route = makeBalanceRoute({
		officialConfig: () => currentConfig,
		settingsRevision: () => revision,
		credentials: { async resolve(ref) {
			credentialCalls += 1;
			assert.equal(ref, "FIRST_ROUTE_KEY");
			credentialStarted();
			return await new Promise((resolve) => { releaseCredential = () => resolve({ value: "late-first-key" }); });
		} }
	});
	const originalFetch = globalThis.fetch;
	try {
		globalThis.fetch = async () => { apiCalls += 1; throw new Error("changed route must not dispatch"); };
		const pending = makeRpcRequest(route, VALID_BALANCE_RPC);
		await credentialStartedPromise;
		currentConfig = { baseURL: "https://api.deepseek.com/anthropic", apiKeyEnv: "SECOND_ROUTE_KEY" };
		revision += 1;
		route.hostControl.emit("settings/document-updated", "llm-deepseek-api-key", revision);
		releaseCredential();
		const body = await (await pending).json();
		assert.equal(body.result.value.error, "request-cancelled");
		assert.deepEqual(body.result.value.balances, { CNY: null, USD: null });
		assert.equal(credentialCalls, 1);
		assert.equal(apiCalls, 0);
		assert.doesNotMatch(JSON.stringify(body), /late-first-key|FIRST_ROUTE_KEY|SECOND_ROUTE_KEY/);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("a route change queued after credential resolution is caught at the final pre-dispatch check", async () => {
	const canonical = "https://api.deepseek.com/anthropic";
	let currentConfig = { baseURL: canonical, apiKeyEnv: "RACE_ROUTE_KEY" };
	let revision = 0;
	let settingsReads = 0;
	let apiCalls = 0;
	let routeChanged = false;
	const route = makeBalanceRoute({
		officialConfig: () => currentConfig,
		settingsRevision: () => revision,
		onSettingsDescribe() {
			settingsReads += 1;
			if (settingsReads === 4) {
				queueMicrotask(() => {
					currentConfig = { baseURL: "https://proxy.invalid/anthropic", apiKeyEnv: "RACE_ROUTE_KEY" };
					revision += 1;
					routeChanged = true;
					route.hostControl.emit("settings/document-updated", "llm-deepseek-api-key", revision);
				});
			}
		},
		credentials: { async resolve(ref) {
			assert.equal(ref, "RACE_ROUTE_KEY");
			return { value: "route-race-key" };
		} }
	});
	const originalFetch = globalThis.fetch;
	try {
		globalThis.fetch = async (url, init) => {
			apiCalls += 1;
			assert.equal(currentConfig.baseURL, canonical, "configuration is still canonical at dispatch");
			assert.equal(String(url), "https://api.deepseek.com/user/balance");
			assert.equal(init.redirect, "error");
			return new Response(JSON.stringify({ balance_infos: [{ currency: "CNY", topped_up_balance: 99 }] }));
		};
		const response = await makeRpcRequest(route, VALID_BALANCE_RPC);
		const body = await response.json();
		assert.equal(routeChanged, true);
		assert.equal(apiCalls, 0);
		assert.equal(body.result.value.error, "request-cancelled");
		assert.deepEqual(body.result.value.balances, { CNY: null, USD: null });
		assert.doesNotMatch(JSON.stringify(body), /route-race-key|proxy\.invalid/);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("a late balance response is discarded after adapter endpoint configuration changes", async () => {
	let currentConfig = { baseURL: "https://api.deepseek.com/anthropic", apiKeyEnv: "FIRST_ROUTE_KEY" };
	let revision = 0;
	let releaseFetch;
	let fetchStarted;
	const fetchStartedPromise = new Promise((resolve) => { fetchStarted = resolve; });
	const route = makeBalanceRoute({
		officialConfig: () => currentConfig,
		settingsRevision: () => revision,
		credentials: { async resolve() { return { value: "late-response-key" }; } }
	});
	const originalFetch = globalThis.fetch;
	try {
		globalThis.fetch = async () => {
			fetchStarted();
			return await new Promise((resolve) => { releaseFetch = () => resolve(new Response(JSON.stringify({
				balance_infos: [{ currency: "CNY", topped_up_balance: 99 }]
			}))); });
		};
		const pending = makeRpcRequest(route, VALID_BALANCE_RPC);
		await fetchStartedPromise;
		currentConfig = { baseURL: "https://gateway.example/anthropic", apiKeyEnv: "FIRST_ROUTE_KEY" };
		revision += 1;
		route.hostControl.emit("settings/document-updated", "llm-deepseek-api-key", revision);
		releaseFetch();
		const body = await (await pending).json();
		assert.equal(body.result.value.error, "request-cancelled");
		assert.deepEqual(body.result.value.balances, { CNY: null, USD: null });
		assert.doesNotMatch(JSON.stringify(body), /late-response-key|gateway\.example/);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("Session provider changes while credentials resolve stop dispatch without provider fallback", async () => {
	for (const nextSelection of [
		{ next: { provider: "deepseek-account", model: "account-model" }, lastUsed: null },
		{ next: { provider: "unsupported-provider", model: "unsupported-model" }, lastUsed: null }
	]) {
		let selection = { next: { provider: "deepseek-official", model: "official-model" }, lastUsed: null };
		const credentialStarted = deferred();
		const credential = deferred();
		let credentialCalls = 0;
		let accountCalls = 0;
		let apiCalls = 0;
		const sessionId = VALID_BALANCE_RPC.payload.sessionId;
		const route = makeBalanceRoute({
			modelSelection: () => selection,
			credentials: { async resolve() { credentialCalls += 1; credentialStarted.resolve(); return credential.promise; } },
			account: { async getBalance() { accountCalls += 1; return { status: "ready", value: [] }; } }
		});
		const originalFetch = globalThis.fetch;
		try {
			globalThis.fetch = async () => { apiCalls += 1; throw new Error("invalidated selection must not fetch"); };
			const pending = makeRpcRequest(route, VALID_BALANCE_RPC);
			await credentialStarted.promise;
			selection = nextSelection;
			route.hostControl.emitProjection(sessionId);
			credential.resolve({ value: "late-session-key" });
			const value = (await (await pending).json()).result.value;
			assert.equal(value.error, "selection-changed");
			assert.deepEqual(value.balances, { CNY: null, USD: null });
			assert.equal(credentialCalls, 1);
			assert.equal(accountCalls, 0);
			assert.equal(apiCalls, 0);
		} finally {
			globalThis.fetch = originalFetch;
		}
	}
});

test("Session invalidated while acquiring the credential service never calls credentials.resolve", async () => {
	let selection = { next: { provider: "deepseek-official", model: "official-model" }, lastUsed: null };
	let credentialCalls = 0;
	let apiCalls = 0;
	let accountCalls = 0;
	let route;
	const sessionId = VALID_BALANCE_RPC.payload.sessionId;
	route = makeBalanceRoute({
		modelSelection: () => selection,
		onConnectionServiceGet(name) {
			if (name !== "credentials") return;
			selection = { next: { provider: "deepseek-account", model: "account-model" }, lastUsed: null };
			route.hostControl.emitProjection(sessionId);
		},
		credentials: { async resolve() { credentialCalls += 1; return { value: "must-not-resolve" }; } },
		account: { async getBalance() { accountCalls += 1; return { status: "ready", value: [] }; } }
	});
	const originalFetch = globalThis.fetch;
	try {
		globalThis.fetch = async () => { apiCalls += 1; throw new Error("invalidated Session must not dispatch"); };
		const value = (await (await makeRpcRequest(route, VALID_BALANCE_RPC)).json()).result.value;
		assert.equal(value.error, "selection-changed");
		assert.equal(credentialCalls, 0);
		assert.equal(apiCalls, 0);
		assert.equal(accountCalls, 0, "an invalidated official operation never falls through to the newly selected account provider");
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("official to account to official during credential resolution invalidates the original generation", async () => {
	let selection = { next: { provider: "deepseek-official", model: "official-model" }, lastUsed: null };
	const credentialStarted = deferred();
	const credential = deferred();
	let apiCalls = 0;
	let accountCalls = 0;
	const sessionId = VALID_BALANCE_RPC.payload.sessionId;
	const route = makeBalanceRoute({
		modelSelection: () => selection,
		credentials: { async resolve() { credentialStarted.resolve(); return credential.promise; } },
		account: { async getBalance() { accountCalls += 1; return { status: "ready", value: [] }; } }
	});
	const originalFetch = globalThis.fetch;
	try {
		globalThis.fetch = async () => { apiCalls += 1; throw new Error("ABA selection must not fetch"); };
		const pending = makeRpcRequest(route, VALID_BALANCE_RPC);
		await credentialStarted.promise;
		selection = { next: { provider: "deepseek-account", model: "account-model" }, lastUsed: null };
		route.hostControl.emitProjection(sessionId);
		selection = { next: { provider: "deepseek-official", model: "official-model" }, lastUsed: null };
		route.hostControl.emitProjection(sessionId);
		credential.resolve({ value: "late-aba-key" });
		const value = (await (await pending).json()).result.value;
		assert.equal(value.error, "selection-changed");
		assert.deepEqual(value.balances, { CNY: null, USD: null });
		assert.equal(apiCalls, 0);
		assert.equal(accountCalls, 0);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("Session disappearance while credentials resolve prevents official dispatch", async () => {
	const credentialStarted = deferred();
	const credential = deferred();
	let apiCalls = 0;
	let accountCalls = 0;
	const sessionId = VALID_BALANCE_RPC.payload.sessionId;
	const route = makeBalanceRoute({
		modelSelection: { next: { provider: "deepseek-official", model: "official-model" }, lastUsed: null },
		credentials: { async resolve() { credentialStarted.resolve(); return credential.promise; } },
		account: { async getBalance() { accountCalls += 1; return { status: "ready", value: [] }; } }
	});
	const originalFetch = globalThis.fetch;
	try {
		globalThis.fetch = async () => { apiCalls += 1; throw new Error("disposed Session must not fetch"); };
		const pending = makeRpcRequest(route, VALID_BALANCE_RPC);
		await credentialStarted.promise;
		route.hostControl.emit("session/disposed", { id: sessionId });
		credential.resolve({ value: "late-disposed-key" });
		const value = (await (await pending).json()).result.value;
		assert.equal(value.error, "selection-changed");
		assert.equal(apiCalls, 0);
		assert.equal(accountCalls, 0);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("Session provider change at the final synchronous route check prevents Fetch", async () => {
	let selection = { next: { provider: "deepseek-official", model: "official-model" }, lastUsed: null };
	let credentialResolved = false;
	let selectionChanged = false;
	let settingsReads = 0;
	let apiCalls = 0;
	let accountCalls = 0;
	const sessionId = VALID_BALANCE_RPC.payload.sessionId;
	const route = makeBalanceRoute({
		modelSelection: () => selection,
		onSettingsDescribe() {
			settingsReads += 1;
			if (credentialResolved && !selectionChanged && settingsReads === 5) {
				selectionChanged = true;
				selection = { next: { provider: "deepseek-account", model: "account-model" }, lastUsed: null };
				route.hostControl.emitProjection(sessionId);
			}
		},
		credentials: { async resolve() { credentialResolved = true; return { value: "final-check-key" }; } },
		account: { async getBalance() { accountCalls += 1; return { status: "ready", value: [] }; } }
	});
	const originalFetch = globalThis.fetch;
	try {
		globalThis.fetch = async () => { apiCalls += 1; throw new Error("final Session check must precede fetch"); };
		const value = (await (await makeRpcRequest(route, VALID_BALANCE_RPC)).json()).result.value;
		assert.equal(selectionChanged, true);
		assert.equal(value.error, "selection-changed");
		assert.equal(apiCalls, 0);
		assert.equal(accountCalls, 0);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("late successful Fetch after official-account-official invalidation is discarded", async () => {
	let selection = { next: { provider: "deepseek-official", model: "official-model" }, lastUsed: null };
	const fetchStarted = deferred();
	const fetchResponse = deferred();
	let apiCalls = 0;
	let accountCalls = 0;
	const sessionId = VALID_BALANCE_RPC.payload.sessionId;
	const route = makeBalanceRoute({
		modelSelection: () => selection,
		credentials: { async resolve() { return { value: "late-session-response-key" }; } },
		account: { async getBalance() { accountCalls += 1; return { status: "ready", value: [] }; } }
	});
	const originalFetch = globalThis.fetch;
	try {
		globalThis.fetch = async () => { apiCalls += 1; fetchStarted.resolve(); return fetchResponse.promise; };
		const pending = makeRpcRequest(route, VALID_BALANCE_RPC);
		await fetchStarted.promise;
		selection = { next: { provider: "deepseek-account", model: "account-model" }, lastUsed: null };
		route.hostControl.emitProjection(sessionId);
		selection = { next: { provider: "deepseek-official", model: "official-model" }, lastUsed: null };
		route.hostControl.emitProjection(sessionId);
		fetchResponse.resolve(new Response(JSON.stringify({ balance_infos: [{ currency: "CNY", topped_up_balance: 88 }] })));
		const value = (await (await pending).json()).result.value;
		assert.equal(value.error, "selection-changed");
		assert.deepEqual(value.balances, { CNY: null, USD: null });
		assert.equal(apiCalls, 1);
		assert.equal(accountCalls, 0);
		assert.doesNotMatch(JSON.stringify(value), /late-session-response-key/);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("credential rotation observed before resolution uses the current Host generation", async () => {
	let credentialCalls = 0;
	const route = makeBalanceRoute({
		modelSelection: { next: { provider: "deepseek-official", model: "official-model" }, lastUsed: null },
		credentials: { async resolve(ref) { credentialCalls += 1; assert.equal(ref, "DEEPSEEK_API_KEY"); return { value: "rotated-before-resolution-key" }; } }
	});
	route.hostControl.emit("credentials/reference-updated", "DEEPSEEK_API_KEY");
	const originalFetch = globalThis.fetch;
	try {
		globalThis.fetch = async (_url, init) => {
			assert.equal(init.headers.Authorization, "Bearer rotated-before-resolution-key");
			return new Response(JSON.stringify({ balance_infos: [] }));
		};
		const value = (await (await makeRpcRequest(route, VALID_BALANCE_RPC)).json()).result.value;
		assert.equal(value.error, null);
		assert.equal(value.balanceGeneration, 1);
		assert.equal(credentialCalls, 1);
		assert.doesNotMatch(JSON.stringify(value), /rotated-before-resolution-key|DEEPSEEK_API_KEY/);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("credential rotation during credential resolution suppresses the pending dispatch", async () => {
	const credentialStarted = deferred();
	const credential = deferred();
	let apiCalls = 0;
	let accountCalls = 0;
	const route = makeBalanceRoute({
		modelSelection: { next: { provider: "deepseek-official", model: "official-model" }, lastUsed: null },
		credentials: { async resolve() { credentialStarted.resolve(); return credential.promise; } },
		account: { async getBalance() { accountCalls += 1; return { status: "ready", value: [] }; } }
	});
	const originalFetch = globalThis.fetch;
	try {
		globalThis.fetch = async () => { apiCalls += 1; throw new Error("rotated pending credential must not dispatch"); };
		const pending = makeRpcRequest(route, VALID_BALANCE_RPC);
		await credentialStarted.promise;
		route.hostControl.emit("credentials/reference-updated", "DEEPSEEK_API_KEY");
		credential.resolve({ value: "stale-credential-value" });
		const value = (await (await pending).json()).result.value;
		assert.equal(value.error, "request-cancelled");
		assert.deepEqual(value.balances, { CNY: null, USD: null });
		assert.equal(apiCalls, 0);
		assert.equal(accountCalls, 0);
		assert.doesNotMatch(JSON.stringify(value), /stale-credential-value|DEEPSEEK_API_KEY/);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("credential invalidation does not depend on a route read during a transient failure window", async () => {
	const credentialStarted = deferred();
	const credential = deferred();
	let updateInspectionFailure = false;
	let settingsReadsDuringFailure = 0;
	let apiCalls = 0;
	let accountCalls = 0;
	const logs = [];
	const route = makeBalanceRoute({
		modelSelection: { next: { provider: "deepseek-official", model: "official-model" }, lastUsed: null },
		onSettingsDescribe() {
			if (updateInspectionFailure) {
				settingsReadsDuringFailure += 1;
				throw new Error("private transient settings detail");
			}
		},
		credentials: { async resolve() { credentialStarted.resolve(); return credential.promise; } },
		account: { async getBalance() { accountCalls += 1; return { status: "ready", value: [] }; } },
		logs
	});
	const originalFetch = globalThis.fetch;
	try {
		globalThis.fetch = async () => { apiCalls += 1; throw new Error("obsolete key must not dispatch"); };
		const pending = makeRpcRequest(route, VALID_BALANCE_RPC);
		await credentialStarted.promise;
		updateInspectionFailure = true;
		route.hostControl.emit("credentials/reference-updated", "DEEPSEEK_API_KEY");
		updateInspectionFailure = false; // The old resolution finishes after settings become readable again.
		credential.resolve({ value: "stale-after-route-read-failure" });
		const value = (await (await pending).json()).result.value;
		assert.equal(settingsReadsDuringFailure, 0, "credential invalidation itself does not inspect settings");
		assert.equal(apiCalls, 0);
		assert.equal(accountCalls, 0);
		assert.deepEqual(value.balances, { CNY: null, USD: null });
		assert.doesNotMatch(JSON.stringify({ value, logs }), /stale-after-route-read-failure|DEEPSEEK_API_KEY|private transient settings detail/);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("credential update during credentials service acquisition invalidates before resolve", async () => {
	let route;
	let updateSent = false;
	let credentialCalls = 0;
	let apiCalls = 0;
	let accountCalls = 0;
	route = makeBalanceRoute({
		modelSelection: { next: { provider: "deepseek-official", model: "official-model" }, lastUsed: null },
		onConnectionServiceGet(name) {
			if (name === "credentials" && !updateSent) {
				updateSent = true;
				route.hostControl.emit("credentials/reference-updated", "DEEPSEEK_API_KEY");
			}
		},
		credentials: { async resolve() { credentialCalls += 1; return { value: "must-not-resolve-after-service-update" }; } },
		account: { async getBalance() { accountCalls += 1; return { status: "ready", value: [] }; } }
	});
	const originalFetch = globalThis.fetch;
	try {
		globalThis.fetch = async () => { apiCalls += 1; throw new Error("invalidated route must not dispatch"); };
		const value = (await (await makeRpcRequest(route, VALID_BALANCE_RPC)).json()).result.value;
		assert.equal(updateSent, true);
		assert.equal(credentialCalls, 0);
		assert.equal(apiCalls, 0);
		assert.equal(accountCalls, 0);
		assert.deepEqual(value.balances, { CNY: null, USD: null });
		assert.doesNotMatch(JSON.stringify(value), /must-not-resolve-after-service-update|DEEPSEEK_API_KEY/);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("unrelated credential updates cannot leak into or fall back from the selected official route", async () => {
	const credentialStarted = deferred();
	const credential = deferred();
	let credentialCalls = 0;
	let apiCalls = 0;
	let accountCalls = 0;
	const reference = "UNRELATED_PRIVATE_REFERENCE";
	const logs = [];
	const route = makeBalanceRoute({
		modelSelection: { next: { provider: "deepseek-official", model: "official-model" }, lastUsed: null },
		credentials: { async resolve() { credentialCalls += 1; credentialStarted.resolve(); return credential.promise; } },
		account: { async getBalance() { accountCalls += 1; return { status: "ready", value: [] }; } },
		logs
	});
	const originalFetch = globalThis.fetch;
	try {
		globalThis.fetch = async () => { apiCalls += 1; throw new Error("unrelated update must not dispatch"); };
		const pending = makeRpcRequest(route, VALID_BALANCE_RPC);
		await credentialStarted.promise;
		route.hostControl.emit("credentials/reference-updated", reference);
		credential.resolve({ value: "must-not-be-dispatched" });
		const value = (await (await pending).json()).result.value;
		assert.equal(credentialCalls, 1, "the update does not resolve its supplied reference");
		assert.equal(apiCalls, 0);
		assert.equal(accountCalls, 0, "an unrelated update does not select the account provider");
		assert.deepEqual(value.balances, { CNY: null, USD: null });
		assert.doesNotMatch(JSON.stringify({ value, logs }), /UNRELATED_PRIVATE_REFERENCE|must-not-be-dispatched/);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("credential rotation immediately before Fetch fails the final generation check", async () => {
	let credentialResolved = false;
	let rotationSent = false;
	let settingsReads = 0;
	let apiCalls = 0;
	const route = makeBalanceRoute({
		modelSelection: { next: { provider: "deepseek-official", model: "official-model" }, lastUsed: null },
		onSettingsDescribe() {
			settingsReads += 1;
			if (credentialResolved && !rotationSent && settingsReads === 5) {
				rotationSent = true;
				route.hostControl.emit("credentials/reference-updated", "DEEPSEEK_API_KEY");
			}
		},
		credentials: { async resolve() { credentialResolved = true; return { value: "pre-dispatch-stale-key" }; } }
	});
	const originalFetch = globalThis.fetch;
	try {
		globalThis.fetch = async () => { apiCalls += 1; throw new Error("rotated reference must not dispatch"); };
		const value = (await (await makeRpcRequest(route, VALID_BALANCE_RPC)).json()).result.value;
		assert.equal(rotationSent, true);
		assert.equal(value.error, "official-route-changed");
		assert.equal(apiCalls, 0);
		assert.doesNotMatch(JSON.stringify(value), /pre-dispatch-stale-key|DEEPSEEK_API_KEY/);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("credential rotation after dispatch rejects the late successful balance", async () => {
	const fetchStarted = deferred();
	const fetchResponse = deferred();
	let apiCalls = 0;
	const route = makeBalanceRoute({
		modelSelection: { next: { provider: "deepseek-official", model: "official-model" }, lastUsed: null },
		credentials: { async resolve() { return { value: "already-dispatched-key" }; } }
	});
	const originalFetch = globalThis.fetch;
	try {
		globalThis.fetch = async () => { apiCalls += 1; fetchStarted.resolve(); return fetchResponse.promise; };
		const pending = makeRpcRequest(route, VALID_BALANCE_RPC);
		await fetchStarted.promise;
		route.hostControl.emit("credentials/reference-updated", "DEEPSEEK_API_KEY");
		fetchResponse.resolve(new Response(JSON.stringify({ balance_infos: [{ currency: "CNY", topped_up_balance: 44 }] })));
		const value = (await (await pending).json()).result.value;
		assert.equal(apiCalls, 1, "the credential event cannot retract a request already handed to Fetch");
		assert.equal(value.error, "request-cancelled");
		assert.deepEqual(value.balances, { CNY: null, USD: null });
		assert.doesNotMatch(JSON.stringify(value), /already-dispatched-key|DEEPSEEK_API_KEY/);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("official balance accepts exactly the byte cap and rejects larger actual bodies", async () => {
	const prefix = JSON.stringify({ balance_infos: [] });
	const exactBody = prefix + " ".repeat(64 * 1024 - Buffer.byteLength(prefix));
	assert.equal(Buffer.byteLength(exactBody), 64 * 1024);
	const oversizedBytes = new TextEncoder().encode(exactBody + " ");
	const originalFetch = globalThis.fetch;
	try {
		const acceptedRoute = makeBalanceRoute({
			modelSelection: { next: { provider: "deepseek-official", model: "official-model" }, lastUsed: null },
			credentials: { async resolve() { return { value: "size-cap-key" }; } }
		});
		globalThis.fetch = async () => new Response(exactBody, { headers: { "content-type": "application/json" } });
		const accepted = (await (await makeRpcRequest(acceptedRoute, VALID_BALANCE_RPC)).json()).result.value;
		assert.equal(accepted.error, null);
		assert.deepEqual(accepted.balances, { CNY: null, USD: null });

		const rejectedRoute = makeBalanceRoute({
			modelSelection: { next: { provider: "deepseek-official", model: "official-model" }, lastUsed: null },
			credentials: { async resolve() { return { value: "size-cap-key" }; } }
		});
		globalThis.fetch = async () => new Response(new ReadableStream({
			start(controller) {
				controller.enqueue(oversizedBytes.subarray(0, 32 * 1024));
				controller.enqueue(oversizedBytes.subarray(32 * 1024));
				controller.close();
			}
		}), { headers: { "content-type": "application/json" } });
		const rejected = (await (await makeRpcRequest(rejectedRoute, VALID_BALANCE_RPC)).json()).result.value;
		assert.equal(rejected.error, "response-too-large");
		assert.deepEqual(rejected.balances, { CNY: null, USD: null });
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("official balance rejects malformed JSON and cancels a stalled body read", async () => {
	const originalFetch = globalThis.fetch;
	try {
		const malformedRoute = makeBalanceRoute({
			modelSelection: { next: { provider: "deepseek-official", model: "official-model" }, lastUsed: null },
			credentials: { async resolve() { return { value: "malformed-response-key" }; } }
		});
		globalThis.fetch = async () => new Response("{", { headers: { "content-type": "application/json" } });
		const malformed = (await (await makeRpcRequest(malformedRoute, VALID_BALANCE_RPC)).json()).result.value;
		assert.equal(malformed.error, "invalid-response");
		assert.deepEqual(malformed.balances, { CNY: null, USD: null });

		const controller = new AbortController();
		const fetchStarted = deferred();
		let bodyCancelled = false;
		const cancelledRoute = makeBalanceRoute({
			modelSelection: { next: { provider: "deepseek-official", model: "official-model" }, lastUsed: null },
			credentials: { async resolve() { return { value: "cancelled-body-key" }; } }
		});
		globalThis.fetch = async () => {
			fetchStarted.resolve();
			return {
				ok: true,
				status: 200,
				body: {
					getReader() {
						return {
							read() { return new Promise(() => {}); },
							cancel() { bodyCancelled = true; return Promise.resolve(); },
							releaseLock() {}
						};
					}
				}
			};
		};
		const pending = makeRpcRequest(cancelledRoute, VALID_BALANCE_RPC, "getBalance", controller.signal);
		await fetchStarted.promise;
		controller.abort();
		const cancelled = (await (await pending).json()).result.value;
		assert.equal(cancelled.error, "request-cancelled");
		assert.equal(bodyCancelled, true);
		assert.deepEqual(cancelled.balances, { CNY: null, USD: null });
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("selected account provider uses only DSH account balance even when API credentials are present", async () => {
	const fakeCredential = "test-account-provider-must-not-read-key";
	const logs = [];
	const serviceLookups = [];
	let credentialCalls = 0;
	let accountCalls = 0;
	let apiCalls = 0;
	const originalFetch = globalThis.fetch;
	const route = makeBalanceRoute({
		modelSelection: { next: { provider: "deepseek-account", model: "account-model" }, lastUsed: { provider: "deepseek-official", model: "old-model" } },
		credentials: { async resolve() { credentialCalls += 1; return { value: fakeCredential }; } },
		account: {
			async getBalance(metadata) {
				accountCalls += 1;
				assert.deepEqual(Object.keys(metadata).sort(), ["locale", "timezoneOffsetSeconds", "version"]);
				return { status: "ready", value: [{ currency: "CNY", balance: "8.50", token: "provider-private" }] };
			}
		},
		serviceLookups,
		logs
	});
	try {
		globalThis.fetch = async () => { apiCalls += 1; throw new Error("unexpected network request"); };
		const response = await makeRpcRequest(route, VALID_BALANCE_RPC);
		const body = await response.json();
		assert.equal(response.status, 200);
		assert.deepEqual(serviceLookups, ["sessionController", "deepseekAccount", "sessionController"]);
		assert.equal(credentialCalls, 0);
		assert.equal(accountCalls, 1);
		assert.equal(apiCalls, 0);
		assert.deepEqual(body.result.value, {
			enabled: true,
			provider: "deepseek-account",
			balances: { CNY: 8.5, USD: null },
			error: null
		});
		assert.doesNotMatch(JSON.stringify(body), /test-account-provider-must-not-read-key|provider-private|token/);
		assert.ok(logs.every((message) => !message.includes(fakeCredential)));
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("selected official provider with unavailable credentials fails without account fallback", async () => {
	const credentialDetail = "private credential resolver detail";
	const logs = [];
	const serviceLookups = [];
	let accountCalls = 0;
	let apiCalls = 0;
	const originalFetch = globalThis.fetch;
	const route = makeBalanceRoute({
		modelSelection: { next: { provider: "deepseek-official", model: "official-model" }, lastUsed: null },
		credentials: { async resolve() { throw new Error(credentialDetail); } },
		account: { async getBalance() { accountCalls += 1; return { status: "ready", value: [] }; } },
		serviceLookups,
		logs
	});
	try {
		globalThis.fetch = async () => { apiCalls += 1; throw new Error("must not fetch without credentials"); };
		const response = await makeRpcRequest(route, VALID_BALANCE_RPC);
		const body = await response.json();
		assert.deepEqual(body.result.value, {
			enabled: true,
			provider: "deepseek-official",
			balanceGeneration: 0,
			balances: { CNY: null, USD: null },
			error: "credentials-unavailable"
		});
		assert.deepEqual(serviceLookups, ["sessionController", "credentials", "sessionController"]);
		assert.equal(accountCalls, 0);
		assert.equal(apiCalls, 0);
		assert.doesNotMatch(JSON.stringify(body), /private credential resolver detail/);
		assert.ok(logs.every((message) => !message.includes(credentialDetail)));

		const missingKeyRoute = makeBalanceRoute({
			modelSelection: { next: null, lastUsed: { provider: "deepseek-official", model: "official-model" } },
			credentials: { async resolve() { return { value: "" }; } },
			account: { async getBalance() { accountCalls += 1; return { status: "ready", value: [] }; } }
		});
		const missingKeyResponse = await makeRpcRequest(missingKeyRoute, VALID_BALANCE_RPC);
		const missingKeyBody = await missingKeyResponse.json();
		assert.equal(missingKeyBody.result.value.error, "missing-api-key");
		assert.equal(accountCalls, 0);
		assert.equal(apiCalls, 0);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("selected account provider fails if its balance capability is unavailable", async () => {
	const serviceLookups = [];
	let credentialCalls = 0;
	const route = makeBalanceRoute({
		modelSelection: { next: { provider: "deepseek-account", model: "account-model" }, lastUsed: null },
		credentials: { async resolve() { credentialCalls += 1; return { value: "unused" }; } },
		serviceLookups
	});
	const response = await makeRpcRequest(route, VALID_BALANCE_RPC);
	const body = await response.json();
	assert.equal(body.result.value.error, "account-provider-unavailable");
	assert.deepEqual(serviceLookups, ["sessionController", "deepseekAccount", "sessionController"]);
	assert.equal(credentialCalls, 0);
});

test("selected account provider reports account authentication failures without checking API credentials", async () => {
	const serviceLookups = [];
	let credentialCalls = 0;
	const route = makeBalanceRoute({
		modelSelection: { next: { provider: "deepseek-account", model: "account-model" }, lastUsed: null },
		credentials: { async resolve() { credentialCalls += 1; return { value: "must-not-fallback" }; } },
		account: { async getBalance() { return { status: "unauthenticated", detail: "private auth response" }; } },
		serviceLookups
	});
	const response = await makeRpcRequest(route, VALID_BALANCE_RPC);
	const body = await response.json();
	assert.equal(body.result.value.error, "account-balance-unavailable");
	assert.deepEqual(serviceLookups, ["sessionController", "deepseekAccount", "sessionController"]);
	assert.equal(credentialCalls, 0);
	assert.doesNotMatch(JSON.stringify(body), /private auth response/);
});

test("pending Session selection takes precedence over last-used and ignores both credential availability and payload provider", async () => {
	const calls = { account: 0, credentials: 0 };
	const route = makeBalanceRoute({
		modelSelection: { next: { provider: "deepseek-account", model: "pending-model" }, lastUsed: { provider: "deepseek-official", model: "used-model" } },
		credentials: { async resolve() { calls.credentials += 1; return { value: "available-key" }; } },
		account: { async getBalance() { calls.account += 1; return { status: "ready", value: [{ currency: "CNY", balance: 9 }] }; } }
	});
	const response = await makeRpcRequest(route, {
		...VALID_BALANCE_RPC,
		payload: { ...VALID_BALANCE_RPC.payload, provider: "deepseek-official" }
	});
	const body = await response.json();
	assert.equal(body.result.value.provider, "deepseek-account");
	assert.deepEqual(calls, { account: 1, credentials: 0 });
});

test("last-used Session provider is used when no selection is pending", async () => {
	let credentialCalls = 0;
	let accountCalls = 0;
	const route = makeBalanceRoute({
		modelSelection: { next: null, lastUsed: { provider: "deepseek-official", model: "last-model" } },
		credentials: { async resolve() { credentialCalls += 1; return { value: "test-key" }; } },
		account: { async getBalance() { accountCalls += 1; return { status: "ready", value: [] }; } }
	});
	const originalFetch = globalThis.fetch;
	try {
		globalThis.fetch = async () => new Response(JSON.stringify({ balance_infos: [] }));
		const response = await makeRpcRequest(route, VALID_BALANCE_RPC);
		assert.equal((await response.json()).result.value.provider, "deepseek-official");
		assert.equal(credentialCalls, 1);
		assert.equal(accountCalls, 0);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("different Sessions with different providers each use their own authoritative projection", async () => {
	const calls = { account: 0, credentials: 0 };
	const accountId = "account-session";
	const officialId = "official-session";
	const route = makeBalanceRoute({
		modelSelection: (_read, sessionId) => sessionId === accountId
			? { next: { provider: "deepseek-account", model: "account-model" }, lastUsed: null }
			: { next: { provider: "deepseek-official", model: "official-model" }, lastUsed: null },
		account: { async getBalance() { calls.account += 1; return { status: "ready", value: [] }; } },
		credentials: { async resolve() { calls.credentials += 1; return { value: "test-key" }; } }
	});
	const originalFetch = globalThis.fetch;
	try {
		globalThis.fetch = async () => new Response(JSON.stringify({ balance_infos: [] }));
		const accountResponse = await makeRpcRequest(route, { ...VALID_BALANCE_RPC, payload: { sessionId: accountId } });
		const officialResponse = await makeRpcRequest(route, { ...VALID_BALANCE_RPC, payload: { sessionId: officialId } });
		assert.equal((await accountResponse.json()).result.value.provider, "deepseek-account");
		assert.equal((await officialResponse.json()).result.value.provider, "deepseek-official");
		assert.deepEqual(calls, { account: 1, credentials: 1 });
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("concurrent Session components share one provider-wide balance request", async () => {
	let accountCalls = 0;
	let resolveAccount;
	const route = makeBalanceRoute({
		modelSelection: { next: { provider: "deepseek-account", model: "account-model" }, lastUsed: null },
		account: { async getBalance() {
			accountCalls += 1;
			return await new Promise((resolve) => { resolveAccount = () => resolve({ status: "ready", value: [{ currency: "CNY", balance: 2 }] }); });
		} }
	});
	const first = makeRpcRequest(route, { ...VALID_BALANCE_RPC, rpcId: "rpc-balance-a", payload: { sessionId: "session-a" } });
	const second = makeRpcRequest(route, { ...VALID_BALANCE_RPC, rpcId: "rpc-balance-b", payload: { sessionId: "session-b" } });
	while (!resolveAccount) await new Promise((resolve) => setImmediate(resolve));
	assert.equal(accountCalls, 1);
	resolveAccount();
	const [firstBody, secondBody] = await Promise.all([first.then((response) => response.json()), second.then((response) => response.json())]);
	assert.equal(firstBody.result.value.provider, "deepseek-account");
	assert.equal(secondBody.result.value.provider, "deepseek-account");
	assert.deepEqual(firstBody.result.value.balances, { CNY: 2, USD: null });
	assert.deepEqual(secondBody.result.value.balances, { CNY: 2, USD: null });
});

test("new Session follows the current global default, including default changes between reads", async () => {
	let currentDefault = { provider: "deepseek-account", model: "account-model" };
	let accountCalls = 0;
	let credentialCalls = 0;
	const route = makeBalanceRoute({
		defaultSelection: () => currentDefault,
		account: { async getBalance() { accountCalls += 1; return { status: "ready", value: [] }; } },
		credentials: { async resolve() { credentialCalls += 1; return { value: "test-key" }; } }
	});
	const originalFetch = globalThis.fetch;
	try {
		globalThis.fetch = async () => new Response(JSON.stringify({ balance_infos: [] }));
		const accountResponse = await makeRpcRequest(route, VALID_BALANCE_RPC);
		assert.equal((await accountResponse.json()).result.value.provider, "deepseek-account");
		currentDefault = { provider: "deepseek-official", model: "official-model" };
		const officialResponse = await makeRpcRequest(route, {
			...VALID_BALANCE_RPC,
			payload: { ...VALID_BALANCE_RPC.payload, sessionId: "new-session-after-default-change" }
		});
		assert.equal((await officialResponse.json()).result.value.provider, "deepseek-official");
		assert.equal(accountCalls, 1);
		assert.equal(credentialCalls, 1);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("a default-model change during credential resolution prevents dispatch for a new Session", async () => {
	const credentialStarted = deferred();
	const credential = deferred();
	let currentDefault = { provider: "deepseek-official", model: "official-model" };
	let apiCalls = 0;
	let accountCalls = 0;
	const route = makeBalanceRoute({
		defaultSelection: () => currentDefault,
		credentials: { async resolve() { credentialStarted.resolve(); return credential.promise; } },
		account: { async getBalance() { accountCalls += 1; return { status: "ready", value: [] }; } }
	});
	const originalFetch = globalThis.fetch;
	try {
		globalThis.fetch = async () => { apiCalls += 1; throw new Error("stale default selection must not dispatch"); };
		const pending = makeRpcRequest(route, {
			...VALID_BALANCE_RPC,
			payload: { ...VALID_BALANCE_RPC.payload, sessionId: "new-session-default-race" }
		});
		await credentialStarted.promise;
		currentDefault = { provider: "deepseek-account", model: "account-model" };
		route.hostControl.emit("settings/document-updated", "agent-default-model", 1);
		credential.resolve({ value: "stale-default-key" });
		const value = (await (await pending).json()).result.value;
		assert.equal(value.error, "request-cancelled");
		assert.deepEqual(value.balances, { CNY: null, USD: null });
		assert.equal(apiCalls, 0);
		assert.equal(accountCalls, 0, "default changes invalidate the original operation instead of switching providers mid-call");
		assert.doesNotMatch(JSON.stringify(value), /stale-default-key/);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("selected account uses only getBalance and fails closed when no account session exists", async () => {
	let credentialCalls = 0;
	let balanceCalls = 0;
	let stateCalls = 0;
	const route = makeBalanceRoute({
		modelSelection: { next: { provider: "deepseek-account", model: "account-model" }, lastUsed: null },
		credentials: { async resolve() { credentialCalls += 1; return { value: "unused-key" }; } },
		account: {
			async getState() { stateCalls += 1; throw new Error("account provider must call only getBalance"); },
			async getBalance() { balanceCalls += 1; return null; }
		}
	});
	const response = await makeRpcRequest(route, VALID_BALANCE_RPC);
	const body = await response.json();
	assert.equal(body.result.value.error, "no-account-session");
	assert.equal(credentialCalls, 0);
	assert.equal(balanceCalls, 1);
	assert.equal(stateCalls, 0);
});

test("selected official provider fails closed when its key is missing even if account login exists", async () => {
	let balanceCalls = 0;
	const route = makeBalanceRoute({
		modelSelection: { next: { provider: "deepseek-official", model: "official-model" }, lastUsed: null },
		credentials: { async resolve() { return undefined; } },
		account: { async getBalance() { balanceCalls += 1; return { status: "ready", value: [] }; } }
	});
	const response = await makeRpcRequest(route, VALID_BALANCE_RPC);
	assert.equal((await response.json()).result.value.error, "missing-api-key");
	assert.equal(balanceCalls, 0);
});

test("unsupported, malformed, and unresolved Session selections fail closed without provider access", async () => {
	for (const options of [
		{ modelSelection: { next: { provider: "other-provider", model: "model" }, lastUsed: null }, error: "unsupported-provider" },
		{ modelSelection: { next: { provider: "deepseek-account", model: "" }, lastUsed: null }, error: "model-selection-invalid" },
		{ modelSelection: { next: null, lastUsed: null }, sessionExists: false, error: "session-unavailable" },
		{ modelSelection: { next: null, lastUsed: null }, sessionController: null, error: "session-authority-unavailable" },
		{ modelSelection: { next: null, lastUsed: null }, defaultSelection: () => ({ provider: "deepseek-account" }), error: "model-selection-invalid" }
	]) {
		let credentialCalls = 0;
		let accountCalls = 0;
		const route = makeBalanceRoute({
			...options,
			credentials: { async resolve() { credentialCalls += 1; return { value: "unused" }; } },
			account: { async getBalance() { accountCalls += 1; return { status: "ready", value: [] }; } }
		});
		const response = await makeRpcRequest(route, VALID_BALANCE_RPC);
		const body = await response.json();
		assert.equal(body.result.value.error, options.error);
		assert.equal(credentialCalls, 0);
		assert.equal(accountCalls, 0);
	}
});

test("a provider switch during the balance call rejects the late old-provider result", async () => {
	let reads = 0;
	let accountCalls = 0;
	let credentialCalls = 0;
	let releaseAccount;
	const route = makeBalanceRoute({
		modelSelection: (count) => count === 1
			? { next: { provider: "deepseek-account", model: "account-model" }, lastUsed: null }
			: { next: { provider: "deepseek-official", model: "official-model" }, lastUsed: null },
		onProjectionRead() { reads += 1; },
		account: {
			async getBalance() {
				accountCalls += 1;
				return await new Promise((resolve) => { releaseAccount = () => resolve({ status: "ready", value: [{ currency: "CNY", balance: 99 }] }); });
			}
		},
		credentials: { async resolve() { credentialCalls += 1; return { value: "unused" }; } }
	});
	const pending = makeRpcRequest(route, VALID_BALANCE_RPC);
	while (!releaseAccount) await new Promise((resolve) => setImmediate(resolve));
	releaseAccount();
	const body = await (await pending).json();
	assert.equal(body.result.value.error, "selection-changed");
	assert.deepEqual(body.result.value.balances, { CNY: null, USD: null });
	assert.equal(accountCalls, 1);
	assert.equal(credentialCalls, 0);
	assert.equal(reads, 2);
});

test("disabled balance view exposes only a boolean and the endpoint never reaches providers", async () => {
	let route;
	const projections = [];
	const ctx = {
		sessionProjections: { register: (projection) => projections.push(projection) },
		inject(_dependencies, callback) {
			callback({ connection: { fetch: { register: (value) => { if (value.path.endsWith("/getBalance")) route = value; return () => {}; } } }, get() { throw new Error("no provider lookup allowed"); }, effect(effect) { effect(); } });
		}
	};
	applyHost(ctx, { enableCost: true, cnyEnabled: true, balance: { enabled: false } });
	const view = projections[0].wire.view(projections[0].init());
	assert.equal(view.balanceEnabled, false);
	assert.equal(projections[0].stateVersion, 7);
	const response = await makeRpcRequest(route, VALID_BALANCE_RPC);
	assert.equal((await response.json()).result.value.enabled, false);
});

test("account-selected failures never resolve credentials and official-selected failures never call account", async () => {
	const accountRoute = makeBalanceRoute({
		modelSelection: { next: { provider: "deepseek-account", model: "account-model" }, lastUsed: null },
		account: { async getBalance() { throw new Error("account balance failed"); } },
		credentials: { async resolve() { throw new Error("must not resolve while account mode is selected"); } }
	});
	const accountResponse = await makeRpcRequest(accountRoute, VALID_BALANCE_RPC);
	assert.equal((await accountResponse.json()).result.value.error, "account-balance-failed");

	let accountCalls = 0;
	const officialRoute = makeBalanceRoute({
		modelSelection: { next: { provider: "deepseek-official", model: "official-model" }, lastUsed: null },
		account: { async getBalance() { accountCalls += 1; return { status: "ready", value: [] }; } },
		credentials: { async resolve() { return undefined; } }
	});
	const officialResponse = await makeRpcRequest(officialRoute, VALID_BALANCE_RPC);
	assert.equal((await officialResponse.json()).result.value.error, "missing-api-key");
	assert.equal(accountCalls, 0);
});

test("official Fetch has a bounded deadline even when a mocked fetch ignores AbortSignal", async () => {
	const originalFetch = globalThis.fetch;
	const originalSetTimeout = globalThis.setTimeout;
	let fetchSignal;
	const route = makeBalanceRoute({
		modelSelection: { next: { provider: "deepseek-official", model: "official-model" }, lastUsed: null },
		credentials: { async resolve() { return { value: "fake-timeout-key" }; } }
	});
	try {
		globalThis.setTimeout = (callback, delay, ...args) => originalSetTimeout(callback, delay === 20_000 ? 0 : delay, ...args);
		globalThis.fetch = async (_url, init) => {
			fetchSignal = init.signal;
			return await new Promise(() => {});
		};
		const response = await makeRpcRequest(route, VALID_BALANCE_RPC);
		const body = await response.json();
		assert.equal(body.result.value.error, "official-balance-timeout");
		assert.equal(fetchSignal.aborted, true);
		assert.deepEqual(body.result.value.balances, { CNY: null, USD: null });
	} finally {
		globalThis.fetch = originalFetch;
		globalThis.setTimeout = originalSetTimeout;
	}
});

test("account timeout stays within the pinned service maximum and never falls back", async () => {
	const originalSetTimeout = globalThis.setTimeout;
	let credentialCalls = 0;
	let accountCalls = 0;
	const route = makeBalanceRoute({
		modelSelection: { next: { provider: "deepseek-account", model: "account-model" }, lastUsed: null },
		account: { async getBalance() { accountCalls += 1; return await new Promise(() => {}); } },
		credentials: { async resolve() { credentialCalls += 1; return { value: "unused" }; } }
	});
	try {
		globalThis.setTimeout = (callback, delay, ...args) => originalSetTimeout(callback, delay === 125_000 ? 0 : delay, ...args);
		const response = await makeRpcRequest(route, VALID_BALANCE_RPC);
		const body = await response.json();
		assert.equal(body.result.value.error, "account-balance-timeout");
		assert.equal(accountCalls, 1);
		assert.equal(credentialCalls, 0);
	} finally {
		globalThis.setTimeout = originalSetTimeout;
	}
});

test("session daily RPC reads its timezone and session ID from the Connection payload", async () => {
	const sessionId = "session-daily-payload-test";
	const eventTime = Date.now();
	let listed = 0;
	const sessionQuery = {
		async listSessions() {
			listed += 1;
			return [{ header: { id: sessionId } }];
		},
		async readSession(id) {
			assert.equal(id, sessionId);
			return {
				session: { id },
				inheritedEventCount: 0,
				events: [{
					seq: 0,
					type: "assistant/message",
					time: eventTime,
					data: {
						usage: { inputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
						message: { source: { model: "deepseek-flash" } }
					}
				}]
			};
		}
	};
	const route = makeSessionDailyRoute(sessionQuery);
	const response = await makeRpcRequest(route, {
		type: "client-request",
		rpcId: "rpc-session-daily-1",
		method: "stats-decimal/getSessionDailyCost",
		payload: { force: true, timeZone: "Europe/Paris", sessionId }
	}, "getSessionDailyCost");
	const body = await response.json();
	assert.equal(body.result.value.timeZone, "Europe/Paris");
	assert.equal(body.result.value.status, "ready");
	assert.equal(body.result.value.sessionCount, 1);
	assert.equal(body.result.value.currentSession.status, "ready");
	assert.ok(body.result.value.currentSession.totals.CNY > 0);
	assert.deepEqual(body.result.value.currentSession.totals, body.result.value.totals);
	assert.equal(listed, 1);
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

test("official balance redirect is rejected before any unexpected destination is contacted", async () => {
	const fakeCredential = "redirect-test-api-key";
	const redirectTarget = "https://attacker.invalid/collect";
	const destinations = [];
	const route = makeBalanceRoute({
		credentials: { async resolve() { return { value: fakeCredential }; } }
	});
	const originalFetch = globalThis.fetch;
	try {
		globalThis.fetch = async (url, init) => {
			destinations.push(String(url));
			assert.equal(String(url), "https://api.deepseek.com/user/balance");
			assert.equal(init.redirect, "error");
			assert.equal(init.headers.Authorization, `Bearer ${fakeCredential}`);
			// Model Fetch's redirect:error behavior; the redirect target is never requested.
			const redirectResponse = new Response(null, { status: 302, headers: { location: redirectTarget } });
			if (init.redirect === "error" && redirectResponse.status >= 300 && redirectResponse.status < 400) {
				throw new TypeError(`redirect rejected for ${redirectResponse.headers.get("location")}`);
			}
			throw new Error("redirect was not rejected");
		};
		const response = await makeRpcRequest(route, VALID_BALANCE_RPC);
		const body = await response.json();
		assert.equal(body.result.value.error, "fetch-failed");
		assert.deepEqual(destinations, ["https://api.deepseek.com/user/balance"]);
		assert.doesNotMatch(JSON.stringify(body), /redirect-test-api-key|attacker\.invalid/);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("balance provider failures return stable sanitized codes without provider details", async () => {
	const fakeCredential = "test-only-balance-key-failure";
	const providerDetail = "test provider internal detail";
	const originalFetch = globalThis.fetch;
	const logs = [];
	const route = makeBalanceRoute({
		credentials: { resolve: async () => ({ value: fakeCredential }) },
		account: { async getBalance() { throw new Error("must not fall back after HTTP error"); } },
		logs
	});
	try {
		globalThis.fetch = async (_url, init) => {
			assert.equal(init.redirect, "error");
			return new Response(providerDetail, { status: 503 });
		};
		const httpResponse = await makeRpcRequest(route, VALID_BALANCE_RPC);
		const httpBody = await httpResponse.json();
		assert.equal(httpBody.result.value.error, "http-503");
		assert.deepEqual(httpBody.result.value.balances, { CNY: null, USD: null });
		assert.doesNotMatch(JSON.stringify(httpBody), /test-only-balance-key|test provider internal detail/);

		globalThis.fetch = async (_url, init) => {
			assert.equal(init.redirect, "error");
			return new Response("unauthorized private detail", { status: 401 });
		};
		const unauthorizedResponse = await makeRpcRequest(route, VALID_BALANCE_RPC);
		const unauthorizedBody = await unauthorizedResponse.json();
		assert.equal(unauthorizedBody.result.value.error, "http-401");
		assert.doesNotMatch(JSON.stringify(unauthorizedBody), /test-only-balance-key|unauthorized private detail/);

		globalThis.fetch = async (_url, init) => {
			assert.equal(init.redirect, "error");
			throw new Error(providerDetail);
		};
		const networkResponse = await makeRpcRequest(route, VALID_BALANCE_RPC);
		const networkBody = await networkResponse.json();
		assert.equal(networkBody.result.value.error, "fetch-failed");
		assert.doesNotMatch(JSON.stringify(networkBody), /test-only-balance-key|test provider internal detail/);
		assert.ok(logs.every((message) => !message.includes(fakeCredential) && !message.includes(providerDetail)));
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("account-provider failures expose only the existing sanitized error code", async () => {
	const providerSecret = "test-provider-private-auth-detail";
	const logs = [];
	let credentialCalls = 0;
	const route = makeBalanceRoute({
		modelSelection: { next: { provider: "deepseek-account", model: "account-model" }, lastUsed: null },
		credentials: { async resolve() { credentialCalls += 1; return { value: "must-not-fallback" }; } },
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
		provider: "deepseek-account",
		balances: { CNY: null, USD: null },
		error: "account-balance-failed"
	});
	assert.equal(credentialCalls, 0);
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
