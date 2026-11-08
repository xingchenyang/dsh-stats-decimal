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

async function makeBalanceRoute(options = {}) {
	const { credentials, logs = [], serviceLookups = [] } = options;
	const listeners = new Map();
	const projectionListeners = new Set();
	const disposers = [];
	let projectionReads = 0;
	const modelSelection = options.modelSelection ?? { next: null, lastUsed: null };
	const projectionContract = options.projectionContract ?? "v0.2.0-rc.2";
	const sessionController = options.sessionController === null ? null : {
		async projections({ sessionId }, signal) {
			projectionReads += 1;
			options.onProjectionRead?.(sessionId, projectionReads, signal);
			if (options.projectionError) throw new Error("private projection detail");
			if (options.sessionExists === false) return null;
			if (Object.hasOwn(options, "projectionResponse")) {
				return typeof options.projectionResponse === "function"
					? options.projectionResponse(projectionReads, sessionId)
					: options.projectionResponse;
			}
			const values = Object.hasOwn(options, "projectionValues")
				? typeof options.projectionValues === "function"
					? options.projectionValues(projectionReads, sessionId)
					: options.projectionValues
				: { modelSelection: typeof modelSelection === "function" ? modelSelection(projectionReads, sessionId) : modelSelection };
			const baseline = {
				asOfSeq: typeof options.asOfSeq === "function" ? options.asOfSeq(projectionReads, sessionId) : options.asOfSeq ?? projectionReads,
				values
			};
			if (projectionContract === "v0.2.0-rc.2") return baseline;
			if (projectionContract === "v0.2.1-rc.1") return { kind: "sequenced", ...baseline };
			throw new Error(`Unknown test projection contract: ${projectionContract}`);
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
	await applyHost(ctx, {
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

async function makeSessionDailyRoute(sessionQuery) {
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
	await applyHost(ctx, {
		enableCost: true,
		cnyEnabled: true,
		usdEnabled: true,
		balance: { enabled: false }
	});
	const route = routes.find((candidate) => candidate.path === "/api/stats-decimal/getSessionDailyCost");
	assert.ok(route, "Host registers the authenticated session daily-cost route");
	return route;
}

async function makeUsageScopesRoute(sessionQuery, subagents) {
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
			if (name === "sessionQuery") return sessionQuery;
			if (name === "subagents") return subagents;
			return undefined;
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
	await applyHost(ctx, {
		enableCost: true,
		cnyEnabled: true,
		usdEnabled: true,
		balance: { enabled: false }
	});
	const route = routes.find((candidate) => candidate.path === "/api/stats-decimal/getUsageScopes");
	assert.ok(route, "Host registers the authenticated usage scopes route");
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
	assert.match(source, /stateVersion: 8/);
	assert.match(source, /const transition = applyUsageEvent\(state\.usage, event\);/);
});

test("the declared runtime dependencies activate real wire-schema validation", { skip: !hasRealWireSchema }, () => {
	assert.equal(hasRealWireSchema, true);
});

	test("Host projection folds historical holiday usage at valley and wires labeled spans", async () => {
	const projections = [];
	const ctx = {
		sessionProjections: { register: (projection) => projections.push(projection) },
		// Skip the unrelated optional balance-service registration in this fake Host.
		inject: () => {}
	};
	await applyHost(ctx, {
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

function makeLifecycleContext(register, onDependent = () => {}) {
	return {
		sessionProjections: { register },
		inject(dependencies, callback) {
			assert.deepEqual(Array.from(dependencies), ["connection"]);
			onDependent();
			callback({
				connection: { fetch: { register: () => () => {} } },
				get() { return undefined; },
				effect(effect) { effect(); }
			});
		}
	};
}

async function makeBillingProjection(overrides = {}) {
	let projection;
	const ctx = {
		sessionProjections: {
			register(definition) {
				projection = definition;
				return () => {};
			}
		},
		inject() {}
	};
	await applyHost(ctx, {
		enableCost: true,
		cnyEnabled: true,
		usdEnabled: false,
		balance: { enabled: false },
		...overrides
	});
	assert.ok(projection, "Host registers the billing projection");
	return projection;
}

function hostStreamUsage(usage) {
	return [{ type: "chunk", time: 0, chunk: { type: "usage", usage } }];
}

function treeSnapshot(id, inheritedEventCount, events, extra = {}) {
	return { session: { id, ...extra }, inheritedEventCount, events };
}

function treeRequestHeader(seq, time, model = "deepseek-flash", provider = "deepseek-official") {
	return {
		type: "request/header",
		seq,
		time,
		data: { header: { config: { provider, model } }, reason: "initial" }
	};
}

function treeMessage(seq, time, usage, model = "deepseek-flash", turn = 1, step = 1) {
	return {
		type: "assistant/message",
		seq,
		time,
		data: {
			turn,
			step,
			usage,
			message: { source: { kind: "model", provider: "deepseek-official", model } },
			stream: []
		}
	};
}

function treeAttempt(seq, time, usage, turn = 1, step = 1) {
	return {
		type: "assistant/attempt",
		seq,
		time,
		data: { turn, step, stream: hostStreamUsage(usage) }
	};
}

function treeRetryStarted(seq, time, turn = 1, step = 1) {
	return { type: "llm/retry-started", seq, time, data: { turn, step, retry: 1, retryId: "retry-1" } };
}

function makeTreeSessionQuery(snapshots) {
	const byId = new Map(snapshots.map((snapshot) => [snapshot.session.id, snapshot]));
	return {
		async listSessions() {
			return snapshots.map((snapshot) => ({ header: { id: snapshot.session.id } }));
		},
		async readSession(id) {
			const snapshot = byId.get(id);
			if (snapshot === undefined) throw new Error(`unreadable test Session ${id}`);
			return snapshot;
		}
	};
}

function makeTreeSubagents(rowsOrError) {
	return {
		async listDescendants() {
			if (rowsOrError instanceof Error) throw rowsOrError;
			return rowsOrError;
		}
	};
}

async function readUsageScopes(route, sessionId, timeZone = "Europe/Paris") {
	const response = await makeRpcRequest(route, {
		type: "client-request",
		rpcId: `rpc-usage-scopes-${sessionId}`,
		method: "stats-decimal/getUsageScopes",
		payload: { force: true, timeZone, sessionId }
	}, "getUsageScopes");
	return (await response.json()).result.value;
}

async function readUsageScopesScoped(route, sessionId, scopes, force = true, timeZone = "Europe/Paris") {
	const response = await makeRpcRequest(route, {
		type: "client-request",
		rpcId: `rpc-usage-scopes-scoped-${sessionId}`,
		method: "stats-decimal/getUsageScopes",
		payload: { force, timeZone, sessionId, scopes }
	}, "getUsageScopes");
	return { status: response.status, value: response.status === 200 ? (await response.json()).result.value : null };
}

function treeCost(usage, eventTime, model = "deepseek-flash") {
	return costOf({
		uncachedInputTokens: usage.inputTokens ?? 0,
		cacheReadTokens: usage.cacheReadTokens ?? 0,
		cacheWriteTokens: usage.cacheWriteTokens ?? 0,
		outputTokens: usage.outputTokens ?? 0
	}, model, bandForTime(eventTime, [9, 10, 11, 14, 15, 16, 17]), ["CNY", "USD"], undefined, eventTime);
}

test("billingLedger counts own attempt/retry usage and excludes inherited history", async () => {
	const projection = await makeBillingProjection();
	const eventTime = Date.UTC(2026, 8, 25, 1, 0, 0); // Holiday valley.
	const inheritedUsage = { inputTokens: 9_000_000, outputTokens: 9_000 };
	const ownFirstUsage = { inputTokens: 100, outputTokens: 10 };
	const ownReplacedUsage = { inputTokens: 250, outputTokens: 25 };
	const events = [
		{
			type: "assistant/message",
			seq: 0,
			time: eventTime,
			data: { turn: 9, step: 1, usage: inheritedUsage, message: { source: { model: "deepseek-flash" } } }
		},
		{
			type: "assistant/message",
			seq: 1,
			time: eventTime,
			data: { turn: 9, step: 2, usage: inheritedUsage, message: { source: { model: "deepseek-flash" } } }
		},
		{
			type: "request/header",
			seq: 2,
			time: eventTime,
			data: { header: { config: { provider: "deepseek-official", model: "deepseek-flash" } }, reason: "resume" }
		},
		{
			type: "assistant/attempt",
			seq: 3,
			time: eventTime,
			data: { turn: 1, step: 1, stream: hostStreamUsage(ownFirstUsage) }
		},
		{
			type: "llm/retry-started",
			seq: 4,
			time: eventTime,
			data: { turn: 1, step: 1, retry: 1, retryId: "retry-1" }
		},
		{
			type: "assistant/attempt",
			seq: 5,
			time: eventTime,
			data: { turn: 1, step: 1, stream: hostStreamUsage({ inputTokens: 200, outputTokens: 20 }) }
		},
		{
			type: "assistant/message",
			seq: 6,
			time: eventTime,
			data: {
				turn: 1,
				step: 1,
				usage: ownReplacedUsage,
				message: { source: { kind: "model", provider: "deepseek-official", model: "deepseek-flash" } },
				stream: []
			}
		}
	];
	let state = projection.init(undefined, 2);
	for (const event of events) state = projection.apply(state, event);
	assert.deepEqual(state.usage.tokens, {
		uncachedInput: 350,
		cacheRead: 0,
		cacheWrite: 0,
		output: 35,
		reasoning: 0
	});
	const firstCost = costOf({ uncachedInputTokens: 100, outputTokens: 10 }, "deepseek-flash", bandForTime(eventTime, [9, 10, 11, 14, 15, 16, 17]), ["CNY"], undefined, eventTime);
	const replacedCost = costOf({ uncachedInputTokens: 250, outputTokens: 25 }, "deepseek-flash", bandForTime(eventTime, [9, 10, 11, 14, 15, 16, 17]), ["CNY"], undefined, eventTime);
	assert.equal(state.cumulative.CNY, firstCost.CNY + replacedCost.CNY);
	assert.equal(state.today.CNY, firstCost.CNY + replacedCost.CNY);
	assert.equal(state.pricingKnown, true);
	assert.equal(state.usage.usageKnown, true);
	assert.equal(projection.stateVersion, 8);
	if (hasRealWireSchema) assert.deepEqual(projection.stateSchema.parse(state), state);
});

test("billingLedger keeps attempt usage but reports unknown cost without a model", async () => {
	const projection = await makeBillingProjection();
	const eventTime = Date.now();
	const state = projection.apply(projection.init(), {
		type: "assistant/attempt",
		seq: 0,
		time: eventTime,
		data: { turn: 1, step: 1, stream: hostStreamUsage({ inputTokens: 100, outputTokens: 10 }) }
	});
	assert.deepEqual(state.usage.tokens, {
		uncachedInput: 100,
		cacheRead: 0,
		cacheWrite: 0,
		output: 10,
		reasoning: 0
	});
	assert.equal(state.cumulative.CNY, 0);
	assert.equal(state.pricingKnown, false);
	assert.equal(state.usage.usageKnown, true);
});

test("Local Today uses own attempt/retry usage and excludes inherited history", async () => {
	const sessionId = "session-local-today-fork";
	const eventTime = Date.now();
	const inheritedUsage = { inputTokens: 9_000_000, outputTokens: 9_000 };
	const ownFirstUsage = { inputTokens: 100, outputTokens: 10 };
	const ownReplacedUsage = { inputTokens: 250, outputTokens: 25 };
	const sessionQuery = {
		async listSessions() {
			return [{ header: { id: sessionId, createdAt: 0 } }];
		},
		async readSession(id) {
			assert.equal(id, sessionId);
			return {
				session: { id },
				inheritedEventCount: 2,
				events: [
					{ type: "assistant/message", seq: 0, time: eventTime, data: { turn: 9, step: 1, usage: inheritedUsage, message: { source: { model: "deepseek-flash" } } } },
					{ type: "assistant/message", seq: 1, time: eventTime, data: { turn: 9, step: 2, usage: inheritedUsage, message: { source: { model: "deepseek-flash" } } } },
					{ type: "request/header", seq: 2, time: eventTime, data: { header: { config: { provider: "deepseek-official", model: "deepseek-flash" } }, reason: "resume" } },
					{ type: "assistant/attempt", seq: 3, time: eventTime, data: { turn: 1, step: 1, stream: hostStreamUsage(ownFirstUsage) } },
					{ type: "llm/retry-started", seq: 4, time: eventTime, data: { turn: 1, step: 1, retry: 1, retryId: "retry-1" } },
					{ type: "assistant/attempt", seq: 5, time: eventTime, data: { turn: 1, step: 1, stream: hostStreamUsage({ inputTokens: 200, outputTokens: 20 }) } },
					{ type: "assistant/message", seq: 6, time: eventTime, data: { turn: 1, step: 1, usage: ownReplacedUsage, message: { source: { kind: "model", provider: "deepseek-official", model: "deepseek-flash" } }, stream: [] } }
				]
			};
		}
	};
	const route = await makeSessionDailyRoute(sessionQuery);
	const response = await makeRpcRequest(route, {
		type: "client-request",
		rpcId: "rpc-local-today-fork",
		method: "stats-decimal/getSessionDailyCost",
		payload: { force: true, timeZone: "Europe/Paris", sessionId }
	}, "getSessionDailyCost");
	const body = await response.json();
	const firstCost = costOf({ uncachedInputTokens: 100, outputTokens: 10 }, "deepseek-flash", bandForTime(eventTime, [9, 10, 11, 14, 15, 16, 17]), ["CNY", "USD"], undefined, eventTime);
	const replacedCost = costOf({ uncachedInputTokens: 250, outputTokens: 25 }, "deepseek-flash", bandForTime(eventTime, [9, 10, 11, 14, 15, 16, 17]), ["CNY", "USD"], undefined, eventTime);
	assert.equal(body.result.value.status, "ready");
	assert.equal(body.result.value.sessionCount, 1);
	assert.equal(body.result.value.currentSession.status, "ready");
	assert.equal(body.result.value.currentSession.totals.CNY, firstCost.CNY + replacedCost.CNY);
	assert.equal(body.result.value.currentSession.totals.USD, firstCost.USD + replacedCost.USD);
	assert.equal(Object.hasOwn(body.result.value, "tokens"), false);
	assert.equal(Object.hasOwn(body.result.value, "cacheHit"), false);
	assert.equal(Object.hasOwn(body.result.value.currentSession, "tokens"), false);
});

test("Local Today counts an attempt-only Session created before the local date", async () => {
	const sessionId = "session-local-today-attempt-only";
	const eventTime = Date.now();
	const sessionQuery = {
		async listSessions() {
			return [{ header: { id: sessionId, createdAt: 0 } }];
		},
		async readSession(id) {
			return {
				session: { id },
				inheritedEventCount: 0,
				events: [
					{ type: "request/header", seq: 0, time: eventTime, data: { header: { config: { provider: "deepseek-official", model: "deepseek-flash" } }, reason: "initial" } },
					{ type: "assistant/attempt", seq: 1, time: eventTime, data: { turn: 1, step: 1, stream: hostStreamUsage({ inputTokens: 100, outputTokens: 10 }) } }
				]
			};
		}
	};
	const route = await makeSessionDailyRoute(sessionQuery);
	const response = await makeRpcRequest(route, {
		type: "client-request",
		rpcId: "rpc-local-today-attempt",
		method: "stats-decimal/getSessionDailyCost",
		payload: { force: true, timeZone: "Europe/Paris", sessionId }
	}, "getSessionDailyCost");
	const body = await response.json();
	assert.equal(body.result.value.status, "ready");
	assert.equal(body.result.value.sessionCount, 1);
	assert.equal(body.result.value.currentSession.status, "ready");
	assert.ok(body.result.value.currentSession.totals.CNY > 0);
});

test("Local Today keeps usage but reports unknown cost when the attempt model is unavailable", async () => {
	const sessionId = "session-local-today-unknown-model";
	const eventTime = Date.now();
	const sessionQuery = {
		async listSessions() {
			return [{ header: { id: sessionId, createdAt: 0 } }];
		},
		async readSession(id) {
			return {
				session: { id },
				inheritedEventCount: 0,
				events: [
					{ type: "assistant/attempt", seq: 0, time: eventTime, data: { turn: 1, step: 1, stream: hostStreamUsage({ inputTokens: 100, outputTokens: 10 }) } }
				]
			};
		}
	};
	const route = await makeSessionDailyRoute(sessionQuery);
	const response = await makeRpcRequest(route, {
		type: "client-request",
		rpcId: "rpc-local-today-unknown-model",
		method: "stats-decimal/getSessionDailyCost",
		payload: { force: true, timeZone: "Europe/Paris", sessionId }
	}, "getSessionDailyCost");
	const body = await response.json();
	assert.equal(body.result.value.status, "unknown");
	assert.equal(body.result.value.sessionCount, 1);
	assert.equal(body.result.value.currentSession.status, "unknown");
	assert.deepEqual(body.result.value.currentSession.totals, { CNY: 0, USD: 0 });
});

test("Local Today reports unknown accounting for malformed usage", async () => {
	const sessionId = "session-local-today-malformed";
	const eventTime = Date.now();
	const sessionQuery = {
		async listSessions() {
			return [{ header: { id: sessionId, createdAt: 0 } }];
		},
		async readSession(id) {
			return {
				session: { id },
				inheritedEventCount: 0,
				events: [
					{
						type: "assistant/message",
						seq: 0,
						time: eventTime,
						data: {
							turn: 1,
							step: 1,
							usage: { inputTokens: -1, outputTokens: 10 },
							message: { source: { kind: "model", provider: "deepseek-official", model: "deepseek-flash" } },
							stream: []
						}
					}
				]
			};
		}
	};
	const route = await makeSessionDailyRoute(sessionQuery);
	const response = await makeRpcRequest(route, {
		type: "client-request",
		rpcId: "rpc-local-today-malformed",
		method: "stats-decimal/getSessionDailyCost",
		payload: { force: true, timeZone: "Europe/Paris", sessionId }
	}, "getSessionDailyCost");
	const body = await response.json();
	assert.equal(body.result.value.status, "unknown");
	assert.equal(body.result.value.sessionCount, 1);
	assert.equal(body.result.value.currentSession.status, "unknown");
	assert.deepEqual(body.result.value.currentSession.totals, { CNY: 0, USD: 0 });
});

test("Local Today ignores historical unknown pricing that contributes nothing today", async () => {
	const sessionId = "session-local-today-historical-unknown";
	const eventTime = Date.now();
	const previousDay = eventTime - 36 * 60 * 60 * 1000;
	const sessionQuery = {
		async listSessions() {
			return [{ header: { id: sessionId, createdAt: 0 } }];
		},
		async readSession(id) {
			return {
				session: { id },
				inheritedEventCount: 0,
				events: [
					treeMessage(0, previousDay, { inputTokens: 100, outputTokens: 10 }, "unpriced-test-model"),
					treeMessage(1, eventTime, { inputTokens: 100, outputTokens: 10 })
				]
			};
		}
	};
	const route = await makeSessionDailyRoute(sessionQuery);
	const response = await makeRpcRequest(route, {
		type: "client-request",
		rpcId: "rpc-local-today-historical-unknown",
		method: "stats-decimal/getSessionDailyCost",
		payload: { force: true, timeZone: "Europe/Paris", sessionId }
	}, "getSessionDailyCost");
	const body = await response.json();
	assert.equal(body.result.value.status, "ready");
	assert.equal(body.result.value.currentSession.status, "ready");
	assert.ok(body.result.value.currentSession.totals.CNY > 0);
});

test("Local Today ignores an unknown Session with no usage today", async () => {
	const todayId = "session-local-today-known";
	const historyId = "session-local-today-history-only";
	const eventTime = Date.now();
	const previousDay = eventTime - 36 * 60 * 60 * 1000;
	const query = {
		async listSessions() {
			return [{ header: { id: todayId, createdAt: 0 } }, { header: { id: historyId, createdAt: 0 } }];
		},
		async readSession(id) {
			if (id === todayId) {
				return {
					session: { id },
					inheritedEventCount: 0,
					events: [treeMessage(0, eventTime, { inputTokens: 100, outputTokens: 10 })]
				};
			}
			return {
				session: { id },
				inheritedEventCount: 0,
				events: [treeMessage(0, previousDay, { inputTokens: 100, outputTokens: 10 }, "unpriced-test-model")]
			};
		}
	};
	const route = await makeSessionDailyRoute(query);
	const response = await makeRpcRequest(route, {
		type: "client-request",
		rpcId: "rpc-local-today-unrelated-unknown",
		method: "stats-decimal/getSessionDailyCost",
		payload: { force: true, timeZone: "Europe/Paris", sessionId: todayId }
	}, "getSessionDailyCost");
	const body = await response.json();
	assert.equal(body.result.value.status, "ready");
	assert.equal(body.result.value.currentSession.status, "ready");
	assert.equal(body.result.value.sessionCount, 1);
});

test("Local Today resolves a complete replacement from an unpriced attempt to a priced message", async () => {
	const sessionId = "session-local-today-replacement";
	const eventTime = Date.now();
	const sessionQuery = {
		async listSessions() {
			return [{ header: { id: sessionId, createdAt: 0 } }];
		},
		async readSession(id) {
			return {
				session: { id },
				inheritedEventCount: 0,
				events: [
					treeAttempt(0, eventTime, { inputTokens: 100, outputTokens: 10 }),
					treeMessage(1, eventTime, { inputTokens: 100, outputTokens: 10 })
				]
			};
		}
	};
	const route = await makeSessionDailyRoute(sessionQuery);
	const response = await makeRpcRequest(route, {
		type: "client-request",
		rpcId: "rpc-local-today-replacement",
		method: "stats-decimal/getSessionDailyCost",
		payload: { force: true, timeZone: "Europe/Paris", sessionId }
	}, "getSessionDailyCost");
	const body = await response.json();
	assert.equal(body.result.value.status, "ready");
	assert.equal(body.result.value.currentSession.status, "ready");
	assert.ok(body.result.value.currentSession.totals.CNY > 0);
});

test("an inherited unknown prefix does not contaminate Local Today", async () => {
	const sessionId = "session-local-today-inherited-unknown";
	const eventTime = Date.now();
	const sessionQuery = {
		async listSessions() {
			return [{ header: { id: sessionId, createdAt: 0 } }];
		},
		async readSession(id) {
			return {
				session: { id },
				inheritedEventCount: 1,
				events: [
					treeMessage(0, eventTime - 36 * 60 * 60 * 1000, { inputTokens: 100, outputTokens: 10 }, "unpriced-test-model"),
					treeMessage(1, eventTime, { inputTokens: 100, outputTokens: 10 })
				]
			};
		}
	};
	const route = await makeSessionDailyRoute(sessionQuery);
	const response = await makeRpcRequest(route, {
		type: "client-request",
		rpcId: "rpc-local-today-inherited-unknown",
		method: "stats-decimal/getSessionDailyCost",
		payload: { force: true, timeZone: "Europe/Paris", sessionId }
	}, "getSessionDailyCost");
	const body = await response.json();
	assert.equal(body.result.value.status, "ready");
	assert.equal(body.result.value.currentSession.status, "ready");
	assert.ok(body.result.value.currentSession.totals.CNY > 0);
});

test("Local Today does not count inherited-only fork history as observed usage", async () => {	const sessionId = "session-local-today-inherited-only";
	const eventTime = Date.now();
	const sessionQuery = {
		async listSessions() {
			return [{ header: { id: sessionId, createdAt: 0 } }];
		},
		async readSession(id) {
			return {
				session: { id },
				inheritedEventCount: 2,
				events: [
					{ type: "assistant/message", seq: 0, time: eventTime, data: { turn: 9, step: 1, usage: { inputTokens: 9_000_000, outputTokens: 9_000 }, message: { source: { model: "deepseek-flash" } } } },
					{ type: "assistant/message", seq: 1, time: eventTime, data: { turn: 9, step: 2, usage: { inputTokens: 9_000_000, outputTokens: 9_000 }, message: { source: { model: "deepseek-flash" } } } }
				]
			};
		}
	};
	const route = await makeSessionDailyRoute(sessionQuery);
	const response = await makeRpcRequest(route, {
		type: "client-request",
		rpcId: "rpc-local-today-inherited-only",
		method: "stats-decimal/getSessionDailyCost",
		payload: { force: true, timeZone: "Europe/Paris", sessionId }
	}, "getSessionDailyCost");
	const body = await response.json();
	assert.equal(body.result.value.status, "ready");
	assert.equal(body.result.value.sessionCount, 0);
	assert.deepEqual(body.result.value.totals, { CNY: 0, USD: 0 });
});


test("usage scopes keeps Tree Today and Local Today independent", async () => {
	const eventTime = Date.now();
	const root = treeSnapshot("root-independent", 0, [treeMessage(0, eventTime, { inputTokens: 100, outputTokens: 10 })]);
	const outside = treeSnapshot("outside-tree", 0, [treeMessage(0, eventTime, { inputTokens: 200, outputTokens: 20 })]);
	const query = makeTreeSessionQuery([root, outside]);
	const route = await makeUsageScopesRoute(query, makeTreeSubagents([]));
	const value = await readUsageScopes(route, "root-independent");
	const rootCost = treeCost({ inputTokens: 100, outputTokens: 10 }, eventTime);
	const outsideCost = treeCost({ inputTokens: 200, outputTokens: 20 }, eventTime);
	assert.equal(value.tree.today.CNY, rootCost.CNY);
	assert.equal(value.local.today.CNY, rootCost.CNY + outsideCost.CNY);
	assert.equal(value.local.sessionCount, 2);
});

test("usage scopes keeps Local Today ready when another Session has only historical unknown pricing", async () => {
	const eventTime = Date.now();
	const previousDay = eventTime - 36 * 60 * 60 * 1000;
	const root = treeSnapshot("root-local-history-known", 0, [
		treeMessage(0, eventTime, { inputTokens: 100, outputTokens: 10 })
	]);
	const historyOnly = treeSnapshot("outside-local-history-unknown", 0, [
		treeMessage(0, previousDay, { inputTokens: 100, outputTokens: 10 }, "unpriced-test-model")
	]);
	const query = makeTreeSessionQuery([root, historyOnly]);
	const route = await makeUsageScopesRoute(query, makeTreeSubagents([]));
	const value = await readUsageScopes(route, "root-local-history-known");
	assert.equal(value.local.status, "ready");
	assert.equal(value.local.pricingKnown, true);
	assert.equal(value.local.sessionCount, 1);
	assert.ok(value.local.today.CNY > 0);
});

test("usage scopes reuses root and child snapshots for Local Today instead of reading them twice", async () => {
	const eventTime = Date.now();
	const root = treeSnapshot("root-reuse", 0, [treeMessage(0, eventTime, { inputTokens: 100, outputTokens: 10 })]);
	const child = treeSnapshot("child-reuse", 0, [treeMessage(0, eventTime, { inputTokens: 200, outputTokens: 20 })]);
	const outside = treeSnapshot("outside-reuse", 0, [treeMessage(0, eventTime, { inputTokens: 300, outputTokens: 30 })]);
	const query = makeTreeSessionQuery([root, child, outside]);
	const reads = new Map();
	const originalRead = query.readSession.bind(query);
	query.readSession = async (id) => {
		reads.set(id, (reads.get(id) ?? 0) + 1);
		return originalRead(id);
	};
	const route = await makeUsageScopesRoute(query, makeTreeSubagents([
		{ kind: "child", id: child.session.id, parentId: root.session.id, depth: 1, mode: "one-shot", activity: "inactive", hasChildren: false }
	]));
	const value = await readUsageScopes(route, root.session.id);
	assert.equal(value.local.sessionCount, 3);
	assert.equal(reads.get(root.session.id), 1);
	assert.equal(reads.get(child.session.id), 1);
	assert.equal(reads.get(outside.session.id), 1);
});

test("usage scopes cache hit returns the prior result without rereading Sessions", async () => {
	const eventTime = Date.now();
	const root = treeSnapshot("root-cache-hit", 0, [treeMessage(0, eventTime, { inputTokens: 100, outputTokens: 10 })]);
	const query = makeTreeSessionQuery([root]);
	let reads = 0;
	const originalRead = query.readSession.bind(query);
	query.readSession = async (id) => {
		reads += 1;
		return originalRead(id);
	};
	const route = await makeUsageScopesRoute(query, makeTreeSubagents([]));
	const body = {
		type: "client-request",
		rpcId: "rpc-usage-cache-hit",
		method: "stats-decimal/getUsageScopes",
		payload: { force: false, timeZone: "Europe/Paris", sessionId: root.session.id }
	};
	const first = await (await makeRpcRequest(route, body, "getUsageScopes")).json();
	const readsAfterFirst = reads;
	const second = await (await makeRpcRequest(route, body, "getUsageScopes")).json();
	assert.equal(second.result.value.local.today.CNY, first.result.value.local.today.CNY);
	assert.equal(reads, readsAfterFirst);
});

test("usage scopes fast selection does not run the Local Today corpus scan", async () => {
	const eventTime = Date.now();
	const root = treeSnapshot("root-fast-only", 0, [treeMessage(0, eventTime, { inputTokens: 100, outputTokens: 10 })]);
	const query = makeTreeSessionQuery([root]);
	query.listSessions = async () => { throw new Error("Local Today must not be invoked"); };
	const route = await makeUsageScopesRoute(query, makeTreeSubagents([]));
	const result = await readUsageScopesScoped(route, root.session.id, ["session", "tree"]);
	assert.equal(result.status, 200);
	assert.equal(result.value.local, null);
	assert.equal(result.value.session.status, "ready");
	assert.equal(result.value.tree.status, "ready");
	assert.equal(result.value.tree.hasDescendants, false);
});

test("usage scopes local selection does not run Tree membership", async () => {
	const eventTime = Date.now();
	const root = treeSnapshot("root-local-only", 0, [treeMessage(0, eventTime, { inputTokens: 100, outputTokens: 10 })]);
	const query = makeTreeSessionQuery([root]);
	const route = await makeUsageScopesRoute(query, {
		async listDescendants() { throw new Error("Tree membership must not be invoked"); }
	});
	const result = await readUsageScopesScoped(route, root.session.id, ["local"]);
	assert.equal(result.status, 200);
	assert.equal(result.value.session, null);
	assert.equal(result.value.tree, null);
	assert.equal(result.value.local.status, "ready");
	assert.ok(result.value.local.today.CNY > 0);
});

test("usage scopes Local Today cache survives a different root Session", async () => {
	const eventTime = Date.now();
	const first = treeSnapshot("root-cache-local-a", 0, [treeMessage(0, eventTime, { inputTokens: 100, outputTokens: 10 })]);
	const second = treeSnapshot("root-cache-local-b", 0, [treeMessage(0, eventTime, { inputTokens: 200, outputTokens: 20 })]);
	const query = makeTreeSessionQuery([first, second]);
	let lists = 0;
	const originalList = query.listSessions.bind(query);
	query.listSessions = async () => { lists += 1; return originalList(); };
	const route = await makeUsageScopesRoute(query, makeTreeSubagents([]));
	const firstValue = await readUsageScopesScoped(route, first.session.id, ["local"], false);
	const listsAfterFirst = lists;
	const secondValue = await readUsageScopesScoped(route, second.session.id, ["local"], false);
	assert.equal(firstValue.status, 200);
	assert.equal(secondValue.status, 200);
	assert.equal(lists, listsAfterFirst);
	assert.equal(secondValue.value.local.today.CNY, firstValue.value.local.today.CNY);
});

test("usage scopes omitted selection preserves the full legacy response", async () => {
	const eventTime = Date.now();
	const root = treeSnapshot("root-legacy-full", 0, [treeMessage(0, eventTime, { inputTokens: 100, outputTokens: 10 })]);
	const route = await makeUsageScopesRoute(makeTreeSessionQuery([root]), makeTreeSubagents([]));
	const value = await readUsageScopes(route, root.session.id);
	assert.equal(value.session.status, "ready");
	assert.equal(value.tree.status, "ready");
	assert.equal(value.local.status, "ready");
	assert.equal(value.tree.hasDescendants, false);
});

test("usage scopes rejects an empty or unknown scope selection", async () => {
	const eventTime = Date.now();
	const root = treeSnapshot("root-invalid-scopes", 0, [treeMessage(0, eventTime, { inputTokens: 100, outputTokens: 10 })]);
	const route = await makeUsageScopesRoute(makeTreeSessionQuery([root]), makeTreeSubagents([]));
	const empty = await readUsageScopesScoped(route, root.session.id, []);
	const unknown = await readUsageScopesScoped(route, root.session.id, ["session", "bogus"]);
	assert.equal(empty.status, 400);
	assert.equal(unknown.status, 400);
});

test("usage scopes exposes authoritative hasDescendants empty/true/unavailable", async () => {
	const eventTime = Date.now();
	const root = treeSnapshot("root-has-descendants", 0, [treeMessage(0, eventTime, { inputTokens: 100, outputTokens: 10 })]);
	const child = treeSnapshot("child-has-descendants", 0, [treeMessage(0, eventTime, { inputTokens: 200, outputTokens: 20 })]);
	const emptyRoute = await makeUsageScopesRoute(makeTreeSessionQuery([root]), makeTreeSubagents([]));
	const empty = await readUsageScopes(emptyRoute, root.session.id);
	assert.equal(empty.tree.hasDescendants, false);

	const childRoute = await makeUsageScopesRoute(makeTreeSessionQuery([root, child]), makeTreeSubagents([
		{ kind: "child", id: child.session.id, parentId: root.session.id, depth: 1, mode: "one-shot", activity: "inactive", hasChildren: false }
	]));
	const withChild = await readUsageScopes(childRoute, root.session.id);
	assert.equal(withChild.tree.hasDescendants, true);

	const externalRoute = await makeUsageScopesRoute(makeTreeSessionQuery([root, child]), makeTreeSubagents([
		{ kind: "child", id: child.session.id, parentId: root.session.id, depth: 1, mode: "external", activity: "inactive", hasChildren: false }
	]));
	const external = await readUsageScopes(externalRoute, root.session.id);
	assert.equal(external.tree.hasDescendants, true);

	const unavailableRoute = await makeUsageScopesRoute(makeTreeSessionQuery([root]), makeTreeSubagents(new Error("unavailable")));
	const unavailable = await readUsageScopes(unavailableRoute, root.session.id);
	assert.equal(unavailable.tree.hasDescendants, null);
});

test("usage scopes carries reasoning presence without changing token totals", async () => {
	const eventTime = Date.now();
	const explicitZero = treeSnapshot("root-reasoning-zero", 0, [
		treeMessage(0, eventTime, { inputTokens: 100, outputTokens: 10, reasoningTokens: 0 })
	]);
	const zeroRoute = await makeUsageScopesRoute(makeTreeSessionQuery([explicitZero]), makeTreeSubagents([]));
	const zero = await readUsageScopes(zeroRoute, explicitZero.session.id);
	assert.equal(zero.session.reasoningReported, true);
	assert.equal(zero.tree.reasoningReported, true);
	assert.equal(zero.local.reasoningReported, true);
	assert.equal(zero.session.tokens.reasoning, 0);

	const absent = treeSnapshot("root-reasoning-absent", 0, [
		treeMessage(0, eventTime, { inputTokens: 100, outputTokens: 10 })
	]);
	const absentRoute = await makeUsageScopesRoute(makeTreeSessionQuery([absent]), makeTreeSubagents([]));
	const missing = await readUsageScopes(absentRoute, absent.session.id);
	assert.equal(missing.session.reasoningReported, false);
	assert.equal(missing.local.reasoningReported, false);

	const nonZero = treeSnapshot("root-reasoning-nonzero", 0, [
		treeMessage(0, eventTime, { inputTokens: 100, outputTokens: 10, reasoningTokens: 4 })
	]);
	const nonZeroRoute = await makeUsageScopesRoute(makeTreeSessionQuery([nonZero]), makeTreeSubagents([]));
	const value = await readUsageScopes(nonZeroRoute, nonZero.session.id);
	assert.equal(value.session.reasoningReported, true);
	assert.equal(value.session.tokens.reasoning, 4);
	assert.equal(
		value.session.cumulative.CNY,
		treeCost({ inputTokens: 100, outputTokens: 10 }, eventTime).CNY
	);
});

test("Local Today uses observeSession without per-session listing preflights", async () => {
	const eventTime = Date.now();
	const root = treeSnapshot("root-observe", 0, [treeMessage(0, eventTime, { inputTokens: 100, outputTokens: 10 })]);
	const outside = treeSnapshot("outside-observe", 0, [treeMessage(0, eventTime, { inputTokens: 200, outputTokens: 20 })]);
	const seeded = treeSnapshot("seeded-observe", 1, [
		treeMessage(0, eventTime, { inputTokens: 9_000, outputTokens: 900 }, "unpriced-test-model"),
		treeMessage(1, eventTime, { inputTokens: 300, outputTokens: 30 })
	]);
	const snapshots = [root, outside, seeded];
	const query = makeTreeSessionQuery(snapshots);
	let listCalls = 0;
	let observeCalls = 0;
	let readCalls = 0;
	let disposeCalls = 0;
	query.listSessions = async () => {
		listCalls += 1;
		return snapshots.map((snapshot) => ({ header: { id: snapshot.session.id } }));
	};
	query.readSession = async (id) => {
		readCalls += 1;
		return snapshots.find((snapshot) => snapshot.session.id === id);
	};
	query.observeSession = async (id) => {
		observeCalls += 1;
		const snapshot = snapshots.find((item) => item.session.id === id);
		return {
			header: snapshot.session,
			inheritedEventCount: snapshot.inheritedEventCount,
			events: snapshot.events,
			[Symbol.dispose]: () => { disposeCalls += 1; }
		};
	};
	const route = await makeUsageScopesRoute(query, makeTreeSubagents([]));
	const local = (await readUsageScopesScoped(route, root.session.id, ["local"])).value.local;
	const authoritativeRoute = await makeUsageScopesRoute(makeTreeSessionQuery(snapshots), makeTreeSubagents([]));
	const authoritative = (await readUsageScopesScoped(authoritativeRoute, root.session.id, ["local"])).value.local;
	assert.equal(local.sessionCount, authoritative.sessionCount);
	assert.equal(local.today.CNY, authoritative.today.CNY);
	assert.equal(local.today.USD, authoritative.today.USD);
	assert.equal(local.tokens.reasoning, authoritative.tokens.reasoning);
	assert.equal(local.pricingKnown, authoritative.pricingKnown);
	assert.equal(listCalls, 1);
	assert.equal(observeCalls, 3);
	assert.equal(readCalls, 0);
	assert.equal(disposeCalls, 3);
});

test("usage scopes treats a proven empty tree as ready and root-only", async () => {
	const eventTime = Date.now();
	const usage = { inputTokens: 100, outputTokens: 10 };
	const root = treeSnapshot("root-empty", 0, [
		treeRequestHeader(0, eventTime),
		treeMessage(1, eventTime, usage)
	]);
	const query = makeTreeSessionQuery([root]);
	const route = await makeUsageScopesRoute(query, makeTreeSubagents([]));
	const value = await readUsageScopes(route, "root-empty");
	const expected = treeCost(usage, eventTime);
	assert.equal(value.tree.status, "ready");
	assert.equal(value.tree.complete, true);
	assert.equal(value.tree.usageKnown, true);
	assert.equal(value.tree.pricingKnown, true);
	assert.deepEqual(value.tree.subagentsAggregate.cumulative, { CNY: 0, USD: 0 });
	assert.deepEqual(value.tree.subagentsAggregate.today, { CNY: 0, USD: 0 });
	assert.equal(value.tree.cumulative.CNY, expected.CNY);
	assert.equal(value.tree.today.CNY, expected.CNY);
	assert.equal(value.tree.coordinatorDirect.cumulative.CNY, expected.CNY);
	assert.equal(value.tree.tokens.uncachedInput, 100);
	assert.equal(value.session.status, "ready");
	assert.ok(Number.isSafeInteger(value.generatedAt));
});

test("usage scopes sums one direct child exactly once", async () => {
	const eventTime = Date.now();
	const rootUsage = { inputTokens: 100, outputTokens: 10 };
	const childUsage = { inputTokens: 200, outputTokens: 20 };
	const root = treeSnapshot("root-direct", 0, [treeMessage(0, eventTime, rootUsage)]);
	const child = treeSnapshot("child-direct", 0, [treeMessage(0, eventTime, childUsage)]);
	const query = makeTreeSessionQuery([root, child]);
	const subagents = makeTreeSubagents([
		{ kind: "child", id: "child-direct", parentId: "root-direct", depth: 1, mode: "one-shot", activity: "inactive", hasChildren: false }
	]);
	const route = await makeUsageScopesRoute(query, subagents);
	const value = await readUsageScopes(route, "root-direct");
	const rootCost = treeCost(rootUsage, eventTime);
	const childCost = treeCost(childUsage, eventTime);
	assert.equal(value.tree.status, "ready");
	assert.equal(value.tree.cumulative.CNY, rootCost.CNY + childCost.CNY);
	assert.equal(value.tree.today.CNY, rootCost.CNY + childCost.CNY);
	assert.equal(value.tree.coordinatorDirect.cumulative.CNY, rootCost.CNY);
	assert.equal(value.tree.subagentsAggregate.cumulative.CNY, childCost.CNY);
	assert.equal(value.tree.tokens.uncachedInput, 300);
	assert.equal(value.tree.tokens.uncachedInput, value.tree.coordinatorDirect.tokens.uncachedInput + value.tree.subagentsAggregate.tokens.uncachedInput);
});

test("usage scopes includes nested descendants without double counting", async () => {
	const eventTime = Date.now();
	const root = treeSnapshot("root-nested", 0, [treeMessage(0, eventTime, { inputTokens: 100, outputTokens: 10 })]);
	const childA = treeSnapshot("child-a", 0, [treeMessage(0, eventTime, { inputTokens: 200, outputTokens: 20 })]);
	const childB = treeSnapshot("child-b", 0, [treeMessage(0, eventTime, { inputTokens: 300, outputTokens: 30 })]);
	const query = makeTreeSessionQuery([root, childA, childB]);
	const subagents = makeTreeSubagents([
		{ kind: "child", id: "child-a", parentId: "root-nested", depth: 1, mode: "continuable", activity: "inactive", hasChildren: true },
		{ kind: "child", id: "child-b", parentId: "child-a", depth: 2, mode: "one-shot", activity: "inactive", hasChildren: false }
	]);
	const route = await makeUsageScopesRoute(query, subagents);
	const value = await readUsageScopes(route, "root-nested");
	const rootCost = treeCost({ inputTokens: 100, outputTokens: 10 }, eventTime);
	const aCost = treeCost({ inputTokens: 200, outputTokens: 20 }, eventTime);
	const bCost = treeCost({ inputTokens: 300, outputTokens: 30 }, eventTime);
	assert.equal(value.tree.status, "ready");
	assert.equal(value.tree.cumulative.CNY, rootCost.CNY + aCost.CNY + bCost.CNY);
	assert.equal(value.tree.subagentsAggregate.cumulative.CNY, aCost.CNY + bCost.CNY);
	assert.equal(value.tree.tokens.uncachedInput, 600);
	assert.equal(value.tree.tokens.uncachedInput, value.tree.coordinatorDirect.tokens.uncachedInput + value.tree.subagentsAggregate.tokens.uncachedInput);
	assert.equal(value.tree.cumulative.CNY, value.tree.coordinatorDirect.cumulative.CNY + value.tree.subagentsAggregate.cumulative.CNY);
	assert.equal(value.tree.today.CNY, value.tree.coordinatorDirect.today.CNY + value.tree.subagentsAggregate.today.CNY);
});

test("usage scopes excludes a fork-seeded descendant's inherited prefix", async () => {
	const eventTime = Date.now();
	const root = treeSnapshot("root-fork", 0, [treeMessage(0, eventTime, { inputTokens: 100, outputTokens: 10 })]);
	const inherited = { inputTokens: 9_000_000, outputTokens: 9_000 };
	const child = treeSnapshot("child-fork", 2, [
		treeMessage(0, eventTime, inherited, "deepseek-flash", 9, 1),
		treeMessage(1, eventTime, inherited, "deepseek-flash", 9, 2),
		treeMessage(2, eventTime, { inputTokens: 200, outputTokens: 20 })
	]);
	const query = makeTreeSessionQuery([root, child]);
	const route = await makeUsageScopesRoute(query, makeTreeSubagents([
		{ kind: "child", id: "child-fork", parentId: "root-fork", depth: 1, mode: "one-shot", activity: "inactive", hasChildren: false }
	]));
	const value = await readUsageScopes(route, "root-fork");
	const rootCost = treeCost({ inputTokens: 100, outputTokens: 10 }, eventTime);
	const childCost = treeCost({ inputTokens: 200, outputTokens: 20 }, eventTime);
	assert.equal(value.tree.cumulative.CNY, rootCost.CNY + childCost.CNY);
	assert.equal(value.tree.today.CNY, rootCost.CNY + childCost.CNY);
	assert.equal(value.tree.tokens.uncachedInput, 300);
});

test("usage scopes preserves attempt/retry semantics for a descendant", async () => {
	const eventTime = Date.now();
	const root = treeSnapshot("root-retry", 0, []);
	const child = treeSnapshot("child-retry", 0, [
		treeRequestHeader(0, eventTime),
		treeAttempt(1, eventTime, { inputTokens: 100, outputTokens: 10 }),
		treeRetryStarted(2, eventTime),
		treeAttempt(3, eventTime, { inputTokens: 200, outputTokens: 20 }),
		treeMessage(4, eventTime, { inputTokens: 250, outputTokens: 25 })
	]);
	const query = makeTreeSessionQuery([root, child]);
	const route = await makeUsageScopesRoute(query, makeTreeSubagents([
		{ kind: "child", id: "child-retry", parentId: "root-retry", depth: 1, mode: "one-shot", activity: "inactive", hasChildren: false }
	]));
	const value = await readUsageScopes(route, "root-retry");
	const first = treeCost({ inputTokens: 100, outputTokens: 10 }, eventTime);
	const final = treeCost({ inputTokens: 250, outputTokens: 25 }, eventTime);
	assert.equal(value.tree.status, "ready");
	assert.equal(value.tree.subagentsAggregate.cumulative.CNY, first.CNY + final.CNY);
	assert.equal(value.tree.subagentsAggregate.tokens.uncachedInput, 350);
});

test("usage scopes reads a cold historical child from durable Session data", async () => {
	const eventTime = Date.now();
	const root = treeSnapshot("root-cold", 0, []);
	const child = treeSnapshot("child-cold", 0, [treeMessage(0, eventTime, { inputTokens: 400, outputTokens: 40 })]);
	const query = makeTreeSessionQuery([root, child]);
	const route = await makeUsageScopesRoute(query, makeTreeSubagents([
		{ kind: "child", id: "child-cold", parentId: "root-cold", depth: 1, mode: "one-shot", activity: "inactive", hasChildren: false }
	]));
	const value = await readUsageScopes(route, "root-cold");
	assert.equal(value.tree.status, "ready");
	assert.equal(value.tree.subagentsAggregate.tokens.uncachedInput, 400);
});

test("usage scopes marks external and unreadable descendants partial without fabricating usage", async () => {
	const eventTime = Date.now();
	const root = treeSnapshot("root-partial", 0, [treeMessage(0, eventTime, { inputTokens: 100, outputTokens: 10 })]);
	const query = makeTreeSessionQuery([root]);
	const route = await makeUsageScopesRoute(query, makeTreeSubagents([
		{ kind: "child", id: "external-child", parentId: "root-partial", depth: 1, mode: "external", activity: "inactive", hasChildren: false },
		{ kind: "child", id: "missing-child", parentId: "root-partial", depth: 1, mode: "one-shot", activity: "inactive", hasChildren: false }
	]));
	const value = await readUsageScopes(route, "root-partial");
	const rootCost = treeCost({ inputTokens: 100, outputTokens: 10 }, eventTime);
	assert.equal(value.tree.status, "partial");
	assert.equal(value.tree.complete, false);
	assert.equal(value.tree.diagnostics.external, true);
	assert.equal(value.tree.diagnostics.unreadable, true);
	assert.equal(value.tree.cumulative.CNY, rootCost.CNY);
	assert.deepEqual(value.tree.subagentsAggregate.cumulative, { CNY: 0, USD: 0 });
});

test("usage scopes gives partial precedence over unknown pricing", async () => {
	const eventTime = Date.now();
	const root = treeSnapshot("root-precedence", 0, [treeMessage(0, eventTime, { inputTokens: 100, outputTokens: 10 })]);
	const unknownChild = treeSnapshot("child-precedence", 0, [treeMessage(0, eventTime, { inputTokens: 500, outputTokens: 50 }, "unpriced-test-model")]);
	const query = makeTreeSessionQuery([root, unknownChild]);
	const route = await makeUsageScopesRoute(query, makeTreeSubagents([
		{ kind: "child", id: "child-precedence", parentId: "root-precedence", depth: 1, mode: "one-shot", activity: "inactive", hasChildren: false },
		{ kind: "child", id: "external-precedence", parentId: "root-precedence", depth: 1, mode: "external", activity: "inactive", hasChildren: false }
	]));
	const value = await readUsageScopes(route, "root-precedence");
	assert.equal(value.tree.status, "partial");
	assert.equal(value.tree.complete, false);
	assert.equal(value.tree.pricingKnown, false);
	assert.equal(value.tree.subagentsAggregate.tokens.uncachedInput, 500);
});

test("usage scopes preserves corrupt diagnostics and never reports ready", async () => {	const eventTime = Date.now();
	const root = treeSnapshot("root-corrupt", 0, [treeMessage(0, eventTime, { inputTokens: 100, outputTokens: 10 })]);
	const query = makeTreeSessionQuery([root]);
	const route = await makeUsageScopesRoute(query, makeTreeSubagents([
		{ kind: "diagnostic", id: "corrupt-child", parentId: "root-corrupt", depth: 1, reason: "corrupt" },
		{ kind: "diagnostic", id: "unsupported-child", parentId: "root-corrupt", depth: 1, reason: "unsupported" }
	]));
	const value = await readUsageScopes(route, "root-corrupt");
	assert.equal(value.tree.status, "partial");
	assert.equal(value.tree.complete, false);
	assert.equal(value.tree.diagnostics.corrupt, true);
	assert.equal(value.tree.diagnostics.unsupported, true);
	assert.equal(value.tree.cumulative.CNY, treeCost({ inputTokens: 100, outputTokens: 10 }, eventTime).CNY);
});

test("usage scopes reports unavailable when authoritative membership is unavailable", async () => {
	const eventTime = Date.now();
	const root = treeSnapshot("root-membership", 0, [treeMessage(0, eventTime, { inputTokens: 100, outputTokens: 10 })]);
	const query = makeTreeSessionQuery([root]);
	const route = await makeUsageScopesRoute(query, makeTreeSubagents(new Error("subagent listing unavailable")));
	const value = await readUsageScopes(route, "root-membership");
	assert.equal(value.tree.status, "unavailable");
	assert.equal(value.tree.complete, false);
	assert.equal(value.tree.cumulative, null);
	assert.equal(value.tree.diagnostics.membershipUnavailable, true);
	assert.equal(value.session.status, "ready");
});

test("usage scopes keeps unknown-priced descendant tokens but cannot become ready", async () => {
	const eventTime = Date.now();
	const root = treeSnapshot("root-unknown-price", 0, [treeMessage(0, eventTime, { inputTokens: 100, outputTokens: 10 })]);
	const child = treeSnapshot("child-unknown-price", 0, [treeMessage(0, eventTime, { inputTokens: 500, outputTokens: 50 }, "unpriced-test-model")]);
	const query = makeTreeSessionQuery([root, child]);
	const route = await makeUsageScopesRoute(query, makeTreeSubagents([
		{ kind: "child", id: "child-unknown-price", parentId: "root-unknown-price", depth: 1, mode: "one-shot", activity: "inactive", hasChildren: false }
	]));
	const value = await readUsageScopes(route, "root-unknown-price");
	assert.equal(value.tree.status, "unknown");
	assert.equal(value.tree.complete, true);
	assert.equal(value.tree.pricingKnown, false);
	assert.equal(value.tree.subagentsAggregate.tokens.uncachedInput, 500);
	assert.deepEqual(value.tree.subagentsAggregate.cumulative, { CNY: 0, USD: 0 });
});

test("usage scopes keeps malformed descendant usage unknown", async () => {
	const eventTime = Date.now();
	const root = treeSnapshot("root-malformed", 0, [treeMessage(0, eventTime, { inputTokens: 100, outputTokens: 10 })]);
	const child = treeSnapshot("child-malformed", 0, [treeMessage(0, eventTime, { inputTokens: -1, outputTokens: 10 })]);
	const query = makeTreeSessionQuery([root, child]);
	const route = await makeUsageScopesRoute(query, makeTreeSubagents([
		{ kind: "child", id: "child-malformed", parentId: "root-malformed", depth: 1, mode: "one-shot", activity: "inactive", hasChildren: false }
	]));
	const value = await readUsageScopes(route, "root-malformed");
	assert.equal(value.tree.status, "unknown");
	assert.equal(value.tree.usageKnown, false);
	assert.equal(value.tree.pricingKnown, false);
	assert.equal(value.tree.subagentsAggregate.tokens.uncachedInput, 0);
});

test("usage scopes treats the requested Session as the explicit tree root, even if it is a subagent", async () => {
	const eventTime = Date.now();
	const parent = treeSnapshot("historical-parent", 0, [treeMessage(0, eventTime, { inputTokens: 9_000_000, outputTokens: 9_000 })]);
	const root = treeSnapshot("current-subagent-root", 0, [treeMessage(0, eventTime, { inputTokens: 100, outputTokens: 10 })], { parentSession: "historical-parent", origin: "subagent", delegationDepth: 1 });
	const child = treeSnapshot("grandchild", 0, [treeMessage(0, eventTime, { inputTokens: 200, outputTokens: 20 })]);
	const query = makeTreeSessionQuery([parent, root, child]);
	const route = await makeUsageScopesRoute(query, makeTreeSubagents([
		{ kind: "child", id: "grandchild", parentId: "current-subagent-root", depth: 1, mode: "one-shot", activity: "inactive", hasChildren: false }
	]));
	const value = await readUsageScopes(route, "current-subagent-root");
	const rootCost = treeCost({ inputTokens: 100, outputTokens: 10 }, eventTime);
	const childCost = treeCost({ inputTokens: 200, outputTokens: 20 }, eventTime);
	assert.equal(value.tree.cumulative.CNY, rootCost.CNY + childCost.CNY);
	assert.equal(value.tree.coordinatorDirect.cumulative.CNY, rootCost.CNY);
});

test("usage scopes protects against duplicate descendant rows", async () => {
	const eventTime = Date.now();
	const root = treeSnapshot("root-duplicate", 0, [treeMessage(0, eventTime, { inputTokens: 100, outputTokens: 10 })]);
	const child = treeSnapshot("child-duplicate", 0, [treeMessage(0, eventTime, { inputTokens: 200, outputTokens: 20 })]);
	const query = makeTreeSessionQuery([root, child]);
	const duplicateRow = { kind: "child", id: "child-duplicate", parentId: "root-duplicate", depth: 1, mode: "one-shot", activity: "inactive", hasChildren: false };
	const route = await makeUsageScopesRoute(query, makeTreeSubagents([duplicateRow, duplicateRow]));
	const value = await readUsageScopes(route, "root-duplicate");
	const childCost = treeCost({ inputTokens: 200, outputTokens: 20 }, eventTime);
	assert.equal(value.tree.status, "partial");
	assert.equal(value.tree.diagnostics.duplicate, true);
	assert.equal(value.tree.subagentsAggregate.cumulative.CNY, childCost.CNY);
});

test("usage scopes Tree Today uses own event dates, not Session creation dates", async () => {
	const now = Date.now();
	const yesterday = now - 24 * 60 * 60 * 1000;
	const root = treeSnapshot("root-dates", 0, [treeMessage(0, now, { inputTokens: 100, outputTokens: 10 })], { createdAt: 0 });
	const oldChild = treeSnapshot("child-old-date", 0, [treeMessage(0, now, { inputTokens: 200, outputTokens: 20 })], { createdAt: 0 });
	const newChild = treeSnapshot("child-new-date", 1, [
		treeMessage(0, yesterday, { inputTokens: 9_000, outputTokens: 900 }, "deepseek-flash", 8, 1),
		treeMessage(1, now, { inputTokens: 300, outputTokens: 30 })
	], { createdAt: now });
	const yesterdayChild = treeSnapshot("child-yesterday", 0, [treeMessage(0, yesterday, { inputTokens: 400, outputTokens: 40 })], { createdAt: yesterday });
	const query = makeTreeSessionQuery([root, oldChild, newChild, yesterdayChild]);
	const rows = [
		{ kind: "child", id: "child-old-date", parentId: "root-dates", depth: 1, mode: "one-shot", activity: "inactive", hasChildren: false },
		{ kind: "child", id: "child-new-date", parentId: "root-dates", depth: 1, mode: "one-shot", activity: "inactive", hasChildren: false },
		{ kind: "child", id: "child-yesterday", parentId: "root-dates", depth: 1, mode: "one-shot", activity: "inactive", hasChildren: false }
	];
	const route = await makeUsageScopesRoute(query, makeTreeSubagents(rows));
	const value = await readUsageScopes(route, "root-dates");
	const todayRoot = treeCost({ inputTokens: 100, outputTokens: 10 }, now);
	const todayOld = treeCost({ inputTokens: 200, outputTokens: 20 }, now);
	const todayNew = treeCost({ inputTokens: 300, outputTokens: 30 }, now);
	const yesterdayCost = treeCost({ inputTokens: 400, outputTokens: 40 }, yesterday);
	assert.equal(value.tree.today.CNY, todayRoot.CNY + todayOld.CNY + todayNew.CNY);
	assert.ok(Math.abs(value.tree.cumulative.CNY - (todayRoot.CNY + todayOld.CNY + todayNew.CNY + yesterdayCost.CNY)) < 1e-12);
});

test("usage scopes response contains only aggregate accounting, not raw child data", async () => {
	const eventTime = Date.now();
	const root = treeSnapshot("root-privacy", 0, [treeMessage(0, eventTime, { inputTokens: 100, outputTokens: 10 })]);
	const child = treeSnapshot("child-privacy", 0, [treeMessage(0, eventTime, { inputTokens: 200, outputTokens: 20 })]);
	const query = makeTreeSessionQuery([root, child]);
	const route = await makeUsageScopesRoute(query, makeTreeSubagents([
		{ kind: "child", id: "child-privacy", parentId: "root-privacy", depth: 1, mode: "one-shot", activity: "inactive", hasChildren: false, label: "private label" }
	]));
	const value = await readUsageScopes(route, "root-privacy");
	const serialized = JSON.stringify(value);
	assert.doesNotMatch(serialized, /root-privacy|child-privacy|private label/);
	assert.doesNotMatch(serialized, /"(events|logs|children|catalog|members|label)"/);
});

test("Host apply awaits Session Projection registration", () => {
	assert.match(source, /async function apply\(ctx, config\)/);
	assert.match(source, /await ctx\.sessionProjections\.register\(billingLedger\)/);
});

test("Host apply accepts a synchronous projection disposer and publishes dependent behavior after registration", async () => {
	let sequence = 0;
	let registrationOrder = -1;
	let dependentOrder = -1;
	const ctx = makeLifecycleContext(() => {
		registrationOrder = sequence++;
		return () => {};
	}, () => {
		dependentOrder = sequence++;
	});
	await applyHost(ctx, {
		enableCost: true,
		cnyEnabled: true,
		usdEnabled: false,
		balance: { enabled: false }
	});
	assert.equal(registrationOrder, 0);
	assert.equal(dependentOrder, 1);
});

test("Host apply waits for an awaitable projection handle and does not publish dependent behavior early", async () => {
	let registered = 0;
	let dependent = 0;
	let applied = false;
	let release;
	const gate = new Promise((resolve) => { release = resolve; });
	const handle = {
		stateOf() { throw new Error("Phase 1 must not call ProjectionHandle.stateOf()"); },
		readerFor() { throw new Error("Phase 1 must not call ProjectionHandle.readerFor()"); },
		dispose() { throw new Error("Phase 1 must not call ProjectionHandle.dispose()"); }
	};
	const ctx = makeLifecycleContext(() => {
		registered += 1;
		// Mirror DSH 0.2.2: a callable disposer that is also awaitable and
		// resolves to the ProjectionHandle.
		return Object.assign(() => {}, {
			then(resolve, reject) {
				gate.then(() => resolve(handle), reject);
			}
		});
	}, () => {
		dependent += 1;
	});
	const applying = applyHost(ctx, {
		enableCost: true,
		cnyEnabled: true,
		usdEnabled: false,
		balance: { enabled: false }
	}).then(() => { applied = true; });
	await Promise.resolve();
	assert.equal(registered, 1);
	assert.equal(dependent, 0);
	assert.equal(applied, false);
	release();
	await applying;
	assert.equal(dependent, 1);
	assert.equal(applied, true);
});

test("Host apply propagates projection registration rejection and does not publish dependent behavior", async () => {
	let dependent = 0;
	const ctx = makeLifecycleContext(
		() => Promise.reject(new Error("projection registration failed")),
		() => { dependent += 1; }
	);
	await assert.rejects(
		applyHost(ctx, {
			enableCost: true,
			cnyEnabled: true,
			usdEnabled: false,
			balance: { enabled: false }
		}),
		/projection registration failed/
	);
	assert.equal(dependent, 0);
});

test("official Beijing peak hours are the default", () => {
	assert.match(source, /default\(\[9, 10, 11, 14, 15, 16, 17\]\)/);
});

test("balance remains outside the Session event log", () => {
	assert.doesNotMatch(source, /session\.append\(/);
	assert.doesNotMatch(source, /stats-decimal\/balance["'`],/);
});

test("balance change listeners are disposed with the owning plugin context", async () => {
	const route = await makeBalanceRoute();
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
	const route = await makeBalanceRoute({
		defaultProvider: "deepseek-official",
		credentials: {
			async resolve(name) {
				credentialCalls.push(name);
				return { value: fakeCredential, source: "test" };
			}
		},
		account: { async getBalance() { accountCalls += 1; return { status: "ready", value: [], bonusWallets: [] }; } },
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
					{ currency: "CNY", total_balance: "20.00", granted_balance: "7.66", topped_up_balance: "12.34", private: upstreamOnlyValue },
					{ currency: "USD", total_balance: 58.00, granted_balance: 1.22, topped_up_balance: 56.78 }
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
				value: { enabled: true, provider: "deepseek-official", balanceGeneration: 0, balances: { CNY: 20, USD: 58 }, error: null }
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
	const route = await makeBalanceRoute({
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
			return new Response(JSON.stringify({ balance_infos: [{ currency: "CNY", total_balance: 5 }] }));
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
	const route = await makeBalanceRoute({
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
	const route = await makeBalanceRoute({
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
			const route = await makeBalanceRoute({
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
	const route = await makeBalanceRoute({
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
	const route = await makeBalanceRoute({
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
		const route = await makeBalanceRoute({
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
		const route = await makeBalanceRoute({
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
	const route = await makeBalanceRoute({
		modelSelection: { next: { provider: "openai", model: "third-party-model" }, lastUsed: null },
		credentials: { async resolve() { credentialCalls += 1; return { value: "must-not-resolve" }; } },
		account: { async getBalance() { accountCalls += 1; return { status: "ready", value: [], bonusWallets: [] }; } }
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
	const route = await makeBalanceRoute({
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
	const route = await makeBalanceRoute({
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
			return new Response(JSON.stringify({ balance_infos: [{ currency: "CNY", total_balance: 99 }] }));
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
	const route = await makeBalanceRoute({
		officialConfig: () => currentConfig,
		settingsRevision: () => revision,
		credentials: { async resolve() { return { value: "late-response-key" }; } }
	});
	const originalFetch = globalThis.fetch;
	try {
		globalThis.fetch = async () => {
			fetchStarted();
			return await new Promise((resolve) => { releaseFetch = () => resolve(new Response(JSON.stringify({
				balance_infos: [{ currency: "CNY", total_balance: 99 }]
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
		const route = await makeBalanceRoute({
			modelSelection: () => selection,
			credentials: { async resolve() { credentialCalls += 1; credentialStarted.resolve(); return credential.promise; } },
			account: { async getBalance() { accountCalls += 1; return { status: "ready", value: [], bonusWallets: [] }; } }
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
	route = await makeBalanceRoute({
		modelSelection: () => selection,
		onConnectionServiceGet(name) {
			if (name !== "credentials") return;
			selection = { next: { provider: "deepseek-account", model: "account-model" }, lastUsed: null };
			route.hostControl.emitProjection(sessionId);
		},
		credentials: { async resolve() { credentialCalls += 1; return { value: "must-not-resolve" }; } },
		account: { async getBalance() { accountCalls += 1; return { status: "ready", value: [], bonusWallets: [] }; } }
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
	const route = await makeBalanceRoute({
		modelSelection: () => selection,
		credentials: { async resolve() { credentialStarted.resolve(); return credential.promise; } },
		account: { async getBalance() { accountCalls += 1; return { status: "ready", value: [], bonusWallets: [] }; } }
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
	const route = await makeBalanceRoute({
		modelSelection: { next: { provider: "deepseek-official", model: "official-model" }, lastUsed: null },
		credentials: { async resolve() { credentialStarted.resolve(); return credential.promise; } },
		account: { async getBalance() { accountCalls += 1; return { status: "ready", value: [], bonusWallets: [] }; } }
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
	const route = await makeBalanceRoute({
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
		account: { async getBalance() { accountCalls += 1; return { status: "ready", value: [], bonusWallets: [] }; } }
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
	const route = await makeBalanceRoute({
		modelSelection: () => selection,
		credentials: { async resolve() { return { value: "late-session-response-key" }; } },
		account: { async getBalance() { accountCalls += 1; return { status: "ready", value: [], bonusWallets: [] }; } }
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
		fetchResponse.resolve(new Response(JSON.stringify({ balance_infos: [{ currency: "CNY", total_balance: 88 }] })));
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
	const route = await makeBalanceRoute({
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
	const route = await makeBalanceRoute({
		modelSelection: { next: { provider: "deepseek-official", model: "official-model" }, lastUsed: null },
		credentials: { async resolve() { credentialStarted.resolve(); return credential.promise; } },
		account: { async getBalance() { accountCalls += 1; return { status: "ready", value: [], bonusWallets: [] }; } }
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
	const route = await makeBalanceRoute({
		modelSelection: { next: { provider: "deepseek-official", model: "official-model" }, lastUsed: null },
		onSettingsDescribe() {
			if (updateInspectionFailure) {
				settingsReadsDuringFailure += 1;
				throw new Error("private transient settings detail");
			}
		},
		credentials: { async resolve() { credentialStarted.resolve(); return credential.promise; } },
		account: { async getBalance() { accountCalls += 1; return { status: "ready", value: [], bonusWallets: [] }; } },
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
	route = await makeBalanceRoute({
		modelSelection: { next: { provider: "deepseek-official", model: "official-model" }, lastUsed: null },
		onConnectionServiceGet(name) {
			if (name === "credentials" && !updateSent) {
				updateSent = true;
				route.hostControl.emit("credentials/reference-updated", "DEEPSEEK_API_KEY");
			}
		},
		credentials: { async resolve() { credentialCalls += 1; return { value: "must-not-resolve-after-service-update" }; } },
		account: { async getBalance() { accountCalls += 1; return { status: "ready", value: [], bonusWallets: [] }; } }
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
	const route = await makeBalanceRoute({
		modelSelection: { next: { provider: "deepseek-official", model: "official-model" }, lastUsed: null },
		credentials: { async resolve() { credentialCalls += 1; credentialStarted.resolve(); return credential.promise; } },
		account: { async getBalance() { accountCalls += 1; return { status: "ready", value: [], bonusWallets: [] }; } },
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
	const route = await makeBalanceRoute({
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
	const route = await makeBalanceRoute({
		modelSelection: { next: { provider: "deepseek-official", model: "official-model" }, lastUsed: null },
		credentials: { async resolve() { return { value: "already-dispatched-key" }; } }
	});
	const originalFetch = globalThis.fetch;
	try {
		globalThis.fetch = async () => { apiCalls += 1; fetchStarted.resolve(); return fetchResponse.promise; };
		const pending = makeRpcRequest(route, VALID_BALANCE_RPC);
		await fetchStarted.promise;
		route.hostControl.emit("credentials/reference-updated", "DEEPSEEK_API_KEY");
		fetchResponse.resolve(new Response(JSON.stringify({ balance_infos: [{ currency: "CNY", total_balance: 44 }] })));
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
		const acceptedRoute = await makeBalanceRoute({
			modelSelection: { next: { provider: "deepseek-official", model: "official-model" }, lastUsed: null },
			credentials: { async resolve() { return { value: "size-cap-key" }; } }
		});
		globalThis.fetch = async () => new Response(exactBody, { headers: { "content-type": "application/json" } });
		const accepted = (await (await makeRpcRequest(acceptedRoute, VALID_BALANCE_RPC)).json()).result.value;
		assert.equal(accepted.error, null);
		assert.deepEqual(accepted.balances, { CNY: null, USD: null });

		const rejectedRoute = await makeBalanceRoute({
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
		const malformedRoute = await makeBalanceRoute({
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
		const cancelledRoute = await makeBalanceRoute({
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
	const route = await makeBalanceRoute({
		modelSelection: { next: { provider: "deepseek-account", model: "account-model" }, lastUsed: { provider: "deepseek-official", model: "old-model" } },
		credentials: { async resolve() { credentialCalls += 1; return { value: fakeCredential }; } },
		account: {
			async getBalance(metadata) {
				accountCalls += 1;
				assert.deepEqual(Object.keys(metadata).sort(), ["locale", "timezoneOffsetSeconds", "version"]);
				return {
					status: "ready",
					value: [{ currency: "CNY", balance: "8.50", token: "provider-private" }],
					bonusWallets: [
						{ currency: "CNY", balance: "1.25" },
						{ currency: "USD", balance: "0.40" }
					]
				};
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
			balances: { CNY: 9.75, USD: 0.4 },
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
	const route = await makeBalanceRoute({
		modelSelection: { next: { provider: "deepseek-official", model: "official-model" }, lastUsed: null },
		credentials: { async resolve() { throw new Error(credentialDetail); } },
		account: { async getBalance() { accountCalls += 1; return { status: "ready", value: [], bonusWallets: [] }; } },
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

		const missingKeyRoute = await makeBalanceRoute({
			modelSelection: { next: null, lastUsed: { provider: "deepseek-official", model: "official-model" } },
			credentials: { async resolve() { return { value: "" }; } },
			account: { async getBalance() { accountCalls += 1; return { status: "ready", value: [], bonusWallets: [] }; } }
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
	const route = await makeBalanceRoute({
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
	const route = await makeBalanceRoute({
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
	const route = await makeBalanceRoute({
		projectionContract: "v0.2.1-rc.1",
		modelSelection: { next: { provider: "deepseek-account", model: "pending-model" }, lastUsed: { provider: "deepseek-official", model: "used-model" } },
		credentials: { async resolve() { calls.credentials += 1; return { value: "available-key" }; } },
		account: { async getBalance() { calls.account += 1; return { status: "ready", value: [{ currency: "CNY", balance: 9 }], bonusWallets: [] }; } }
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
	const route = await makeBalanceRoute({
		projectionContract: "v0.2.0-rc.2",
		modelSelection: { next: null, lastUsed: { provider: "deepseek-official", model: "last-model" } },
		credentials: { async resolve() { credentialCalls += 1; return { value: "test-key" }; } },
		account: { async getBalance() { accountCalls += 1; return { status: "ready", value: [], bonusWallets: [] }; } }
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
	const route = await makeBalanceRoute({
		modelSelection: (_read, sessionId) => sessionId === accountId
			? { next: { provider: "deepseek-account", model: "account-model" }, lastUsed: null }
			: { next: { provider: "deepseek-official", model: "official-model" }, lastUsed: null },
		account: { async getBalance() { calls.account += 1; return { status: "ready", value: [], bonusWallets: [] }; } },
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
	const route = await makeBalanceRoute({
		modelSelection: { next: { provider: "deepseek-account", model: "account-model" }, lastUsed: null },
		account: { async getBalance() {
			accountCalls += 1;
			return await new Promise((resolve) => { resolveAccount = () => resolve({ status: "ready", value: [{ currency: "CNY", balance: 2 }], bonusWallets: [] }); });
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
	const route = await makeBalanceRoute({
		projectionContract: "v0.2.1-rc.1",
		asOfSeq: -1,
		defaultSelection: () => currentDefault,
		account: { async getBalance() { accountCalls += 1; return { status: "ready", value: [], bonusWallets: [] }; } },
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
	const route = await makeBalanceRoute({
		defaultSelection: () => currentDefault,
		credentials: { async resolve() { credentialStarted.resolve(); return credential.promise; } },
		account: { async getBalance() { accountCalls += 1; return { status: "ready", value: [], bonusWallets: [] }; } }
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
	const route = await makeBalanceRoute({
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
	const route = await makeBalanceRoute({
		modelSelection: { next: { provider: "deepseek-official", model: "official-model" }, lastUsed: null },
		credentials: { async resolve() { return undefined; } },
		account: { async getBalance() { balanceCalls += 1; return { status: "ready", value: [], bonusWallets: [] }; } }
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
		const route = await makeBalanceRoute({
			...options,
			credentials: { async resolve() { credentialCalls += 1; return { value: "unused" }; } },
			account: { async getBalance() { accountCalls += 1; return { status: "ready", value: [], bonusWallets: [] }; } }
		});
		const response = await makeRpcRequest(route, VALID_BALANCE_RPC);
		const body = await response.json();
		assert.equal(body.result.value.error, options.error);
		assert.equal(credentialCalls, 0);
		assert.equal(accountCalls, 0);
	}
});

test("migration-required Session projection hints never influence provider resolution or expose cached selection details", async () => {
	const originalFetch = globalThis.fetch;
	const cachedModelSecret = "cached-private-model-7a91";
	try {
		let fetchCalls = 0;
		globalThis.fetch = async () => {
			fetchCalls += 1;
			throw new Error("migration-required projections must not dispatch a balance request");
		};
		for (const scenario of [
			{
				name: "cached official selection",
				values: { modelSelection: { next: { provider: "deepseek-official", model: cachedModelSecret }, lastUsed: null } }
			},
			{
				name: "cached account selection",
				values: { modelSelection: { next: { provider: "deepseek-account", model: cachedModelSecret }, lastUsed: null } }
			},
			{ name: "no cached selection", values: {} }
		]) {
			const calls = { defaults: 0, credentials: 0, account: 0 };
			const logs = [];
			const serviceLookups = [];
			const route = await makeBalanceRoute({
				projectionResponse: { kind: "migration-required", values: scenario.values },
				defaultReads() { calls.defaults += 1; },
				credentials: { async resolve() { calls.credentials += 1; return { value: "must-not-resolve" }; } },
				account: { async getBalance() { calls.account += 1; return { status: "ready", value: [], bonusWallets: [] }; } },
				logs,
				serviceLookups
			});
			const body = await (await makeRpcRequest(route, VALID_BALANCE_RPC)).json();
			const value = body.result.value;
			assert.equal(value.error, "session-projection-migration-required", scenario.name);
			assert.equal(value.provider, null, scenario.name);
			assert.deepEqual(calls, { defaults: 0, credentials: 0, account: 0 }, scenario.name);
			assert.equal(fetchCalls, 0, scenario.name);
			assert.deepEqual(serviceLookups, ["sessionController"], scenario.name);
			assert.deepEqual(logs, ["balance query failed: session-projection-migration-required"], scenario.name);
			assert.doesNotMatch(JSON.stringify(body), /cached-private-model-7a91|must-not-resolve/);
			assert.doesNotMatch(logs.join("\n"), /cached-private-model-7a91|must-not-resolve/);
		}
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("unknown and malformed Session projection baselines fail closed before provider access", async () => {
	const validValues = { modelSelection: { next: { provider: "deepseek-official", model: "must-not-use" }, lastUsed: null } };
	const cases = [
		{ name: "unknown discriminant", response: { kind: "future", asOfSeq: 1, values: validValues } },
		{ name: "missing legacy watermark", response: { values: validValues } },
		{ name: "missing sequenced watermark", response: { kind: "sequenced", values: validValues } },
		{ name: "negative watermark", response: { kind: "sequenced", asOfSeq: -2, values: validValues } },
		{ name: "negative zero watermark", response: { asOfSeq: -0, values: validValues } },
		{ name: "fractional watermark", response: { kind: "sequenced", asOfSeq: 1.5, values: validValues } },
		{ name: "unsafe watermark", response: { asOfSeq: Number.MAX_SAFE_INTEGER + 1, values: validValues } },
		{ name: "primitive response container", response: "cached projection" },
		{ name: "array response container", response: [] },
		{ name: "missing values container", response: { kind: "sequenced", asOfSeq: 1 } },
		{ name: "null values container", response: { kind: "sequenced", asOfSeq: 1, values: null } },
		{ name: "array values container", response: { asOfSeq: 1, values: [] } }
	];
	const originalFetch = globalThis.fetch;
	try {
		let fetchCalls = 0;
		globalThis.fetch = async () => { fetchCalls += 1; throw new Error("invalid projections must not dispatch a balance request"); };
		for (const scenario of cases) {
			const calls = { defaults: 0, credentials: 0, account: 0 };
			const route = await makeBalanceRoute({
				projectionResponse: scenario.response,
				defaultReads() { calls.defaults += 1; },
				credentials: { async resolve() { calls.credentials += 1; return { value: "must-not-resolve" }; } },
				account: { async getBalance() { calls.account += 1; return { status: "ready", value: [], bonusWallets: [] }; } }
			});
			const body = await (await makeRpcRequest(route, VALID_BALANCE_RPC)).json();
			assert.equal(body.result.value.error, "session-projection-invalid", scenario.name);
			assert.equal(body.result.value.provider, null, scenario.name);
			assert.deepEqual(calls, { defaults: 0, credentials: 0, account: 0 }, scenario.name);
			assert.equal(fetchCalls, 0, scenario.name);
		}
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("a provider switch during the balance call rejects the late old-provider result", async () => {
	let reads = 0;
	let accountCalls = 0;
	let credentialCalls = 0;
	let releaseAccount;
	const route = await makeBalanceRoute({
		modelSelection: (count) => count === 1
			? { next: { provider: "deepseek-account", model: "account-model" }, lastUsed: null }
			: { next: { provider: "deepseek-official", model: "official-model" }, lastUsed: null },
		onProjectionRead() { reads += 1; },
		account: {
			async getBalance() {
				accountCalls += 1;
				return await new Promise((resolve) => { releaseAccount = () => resolve({ status: "ready", value: [{ currency: "CNY", balance: 99 }], bonusWallets: [] }); });
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
	await applyHost(ctx, { enableCost: true, cnyEnabled: true, balance: { enabled: false } });
	const view = projections[0].wire.view(projections[0].init());
	assert.equal(view.balanceEnabled, false);
	assert.equal(projections[0].stateVersion, 8);
	const response = await makeRpcRequest(route, VALID_BALANCE_RPC);
	assert.equal((await response.json()).result.value.enabled, false);
});

test("account-selected failures never resolve credentials and official-selected failures never call account", async () => {
	const accountRoute = await makeBalanceRoute({
		modelSelection: { next: { provider: "deepseek-account", model: "account-model" }, lastUsed: null },
		account: { async getBalance() { throw new Error("account balance failed"); } },
		credentials: { async resolve() { throw new Error("must not resolve while account mode is selected"); } }
	});
	const accountResponse = await makeRpcRequest(accountRoute, VALID_BALANCE_RPC);
	assert.equal((await accountResponse.json()).result.value.error, "account-balance-failed");

	let accountCalls = 0;
	const officialRoute = await makeBalanceRoute({
		modelSelection: { next: { provider: "deepseek-official", model: "official-model" }, lastUsed: null },
		account: { async getBalance() { accountCalls += 1; return { status: "ready", value: [], bonusWallets: [] }; } },
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
	const route = await makeBalanceRoute({
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
	const route = await makeBalanceRoute({
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
	const route = await makeSessionDailyRoute(sessionQuery);
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
	const route = await makeBalanceRoute({ credentials: { resolve: async () => { credentialCalls += 1; return undefined; } } });
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
	const route = await makeBalanceRoute({
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
	const route = await makeBalanceRoute({
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
	const route = await makeBalanceRoute({
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
	const route = await makeBalanceRoute({ credentials: { resolve: async () => ({ value: "test-only-key" }) } });
	try {
		globalThis.fetch = async () => new Response(JSON.stringify({
			balance_infos: [
				{ currency: "CNY", total_balance: "33.20abc" },
				{ currency: "USD", total_balance: "-5" }
			]
		}), { headers: { "content-type": "application/json" } });
		const response = await makeRpcRequest(route, VALID_BALANCE_RPC);
		const body = await response.json();
		assert.deepEqual(body.result.value.balances, { CNY: null, USD: null });
		assert.equal(body.result.value.error, null);

		globalThis.fetch = async () => new Response(JSON.stringify({
			balance_infos: [{ currency: "USD", total_balance: "0x10" }]
		}), { headers: { "content-type": "application/json" } });
		const hexResponse = await makeRpcRequest(route, VALID_BALANCE_RPC);
		const hexBody = await hexResponse.json();
		assert.deepEqual(hexBody.result.value.balances, { CNY: null, USD: null });
	} finally {
		globalThis.fetch = originalFetch;
	}
});
