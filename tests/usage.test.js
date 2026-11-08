import assert from "node:assert/strict";
import test from "node:test";
import {
	aggregateBuckets,
	applyUsageEvent,
	billedPromptTokens,
	cacheHitOf,
	emptyUsageState,
	normalizeUsage,
	totalUsageTokens
} from "../lib/usage.js";

const MODEL = "deepseek-flash";
const PROVIDER = "deepseek-official";

function rawUsage(options = {}) {
	const usage = {
		inputTokens: options.input ?? 0,
		outputTokens: options.output ?? 0
	};
	if (options.cacheRead !== undefined) usage.cacheReadTokens = options.cacheRead;
	if (options.cacheWrite !== undefined) usage.cacheWriteTokens = options.cacheWrite;
	if (options.reasoning !== undefined) usage.reasoningTokens = options.reasoning;
	if (options.total !== undefined) usage.totalTokens = options.total;
	return usage;
}

function usageStream(usage) {
	return [{ type: "chunk", time: 0, chunk: { type: "usage", usage } }];
}

function requestHeader(seq, model = MODEL, provider = PROVIDER) {
	return {
		type: "request/header",
		seq,
		time: seq,
		data: { header: { config: { provider, model } }, reason: "initial" }
	};
}

function attempt(seq, turn, step, usage, time = seq) {
	return {
		type: "assistant/attempt",
		seq,
		time,
		data: { turn, step, stream: usageStream(usage) }
	};
}

function message(seq, turn, step, options = {}, time = seq) {
	const data = { turn, step, stream: options.stream ?? [] };
	if (options.usage !== undefined) data.usage = options.usage;
	if (options.model !== null) data.message = { role: "assistant", source: { kind: "model", provider: options.provider ?? PROVIDER, model: options.model ?? MODEL } };
	return { type: "assistant/message", seq, time, data };
}

function retryStarted(seq, turn, step, time = seq) {
	return { type: "llm/retry-started", seq, time, data: { turn, step, retry: 1, retryId: "retry-1" } };
}

function applyAll(state, events) {
	const transitions = [];
	let current = state;
	for (const event of events) {
		const transition = applyUsageEvent(current, event);
		transitions.push(transition);
		current = transition.state;
	}
	return { state: current, transitions };
}

test("normal assistant message contributes its authoritative usage once", () => {
	const tokenUsage = rawUsage({ input: 1_000_000, cacheRead: 2_000_000, output: 100 });
	const { state } = applyAll(emptyUsageState(), [requestHeader(0), message(1, 1, 1, { usage: tokenUsage })]);
	assert.deepEqual(state.tokens, {
		uncachedInput: 1_000_000,
		cacheRead: 2_000_000,
		cacheWrite: 0,
		output: 100,
		reasoning: 0
	});
	assert.equal(billedPromptTokens(state.tokens), 3_000_000);
	assert.equal(totalUsageTokens(state.tokens), 3_000_100);
	assert.equal(state.usageKnown, true);
});

test("fork inherited prefix is excluded from own usage even at a high ratio", () => {
	const inherited = emptyUsageState(2);
	const inheritedEvent = message(0, 1, 1, { usage: rawUsage({ input: 5_000_000, cacheRead: 5_000_000, output: 10_000 }) });
	const first = applyUsageEvent(inherited, inheritedEvent);
	assert.equal(first.state, inherited);
	assert.deepEqual(first.state.tokens, { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 });

	const second = applyUsageEvent(first.state, message(1, 1, 2, { usage: rawUsage({ input: 6_000_000, output: 20_000 }) }));
	assert.equal(second.state, first.state);
	const own = message(2, 1, 3, { usage: rawUsage({ input: 1_000, cacheRead: 3_000, output: 7 }) });
	const after = applyUsageEvent(second.state, own);
	assert.deepEqual(after.state.tokens, {
		uncachedInput: 1_000,
		cacheRead: 3_000,
		cacheWrite: 0,
		output: 7,
		reasoning: 0
	});
});

test("attempt usage is counted without a final assistant message", () => {
	const { state } = applyAll(emptyUsageState(), [
		requestHeader(0),
		attempt(1, 1, 1, rawUsage({ input: 100, cacheRead: 400, output: 9 }))
	]);
	assert.deepEqual(state.tokens, {
		uncachedInput: 100,
		cacheRead: 400,
		cacheWrite: 0,
		output: 9,
		reasoning: 0
	});
	assert.equal(state.usageKnown, true);
});

test("attempt usage uses the last embedded stream sample", () => {
	const { state } = applyAll(emptyUsageState(), [
		requestHeader(0),
		{
			type: "assistant/attempt",
			seq: 1,
			time: 1,
			data: {
				turn: 1,
				step: 1,
				stream: [
					{ type: "chunk", time: 1, chunk: { type: "usage", usage: rawUsage({ input: 100, output: 10 }) } },
					{ type: "chunk", time: 2, chunk: { type: "usage", usage: rawUsage({ input: 200, output: 20 }) } }
				]
			}
		}
	]);
	assert.deepEqual(state.tokens, {
		uncachedInput: 200,
		cacheRead: 0,
		cacheWrite: 0,
		output: 20,
		reasoning: 0
	});
});

test("negative or malformed cache and reasoning values are rejected", () => {
	assert.equal(normalizeUsage(rawUsage({ input: 1, output: 2, cacheRead: -1 })), null);
	assert.equal(normalizeUsage(rawUsage({ input: 1, output: 2, reasoning: 3 })), null);
});

test("later same-step sample replaces the earlier attempt sample", () => {
	const { state, transitions } = applyAll(emptyUsageState(), [
		requestHeader(0),
		attempt(1, 1, 1, rawUsage({ input: 100, output: 10 })),
		message(2, 1, 1, { usage: rawUsage({ input: 250, output: 20 }) })
	]);
	assert.deepEqual(state.tokens, {
		uncachedInput: 250,
		cacheRead: 0,
		cacheWrite: 0,
		output: 20,
		reasoning: 0
	});
	assert.equal(transitions.at(-1).removed.buckets.uncachedInput, 100);
	assert.equal(transitions.at(-1).added.buckets.uncachedInput, 250);
});

test("retry-started makes attempts additive while replacement remains per attempt", () => {
	const { state } = applyAll(emptyUsageState(), [
		requestHeader(0),
		attempt(1, 1, 1, rawUsage({ input: 100, output: 10 })),
		retryStarted(2, 1, 1),
		attempt(3, 1, 1, rawUsage({ input: 200, output: 20 })),
		message(4, 1, 1, { usage: rawUsage({ input: 250, output: 25 }) })
	]);
	assert.deepEqual(state.tokens, {
		uncachedInput: 350,
		cacheRead: 0,
		cacheWrite: 0,
		output: 35,
		reasoning: 0
	});
});

test("authoritative message usage wins over a stream sample", () => {
	const { state } = applyAll(emptyUsageState(), [
		requestHeader(0),
		message(1, 1, 1, {
			usage: rawUsage({ input: 100, output: 10 }),
			stream: usageStream(rawUsage({ input: 999, output: 99 }))
		})
	]);
	assert.deepEqual(state.tokens, {
		uncachedInput: 100,
		cacheRead: 0,
		cacheWrite: 0,
		output: 10,
		reasoning: 0
	});
});

test("message stream usage is the fallback when the message has no usage field", () => {
	const { state } = applyAll(emptyUsageState(), [
		requestHeader(0),
		message(1, 1, 1, { stream: usageStream(rawUsage({ input: 120, output: 12 })) })
	]);
	assert.deepEqual(state.tokens, {
		uncachedInput: 120,
		cacheRead: 0,
		cacheWrite: 0,
		output: 12,
		reasoning: 0
	});
});

test("attempt usage is attributed from the current request header and does not leak stale models", () => {
	const { transitions } = applyAll(emptyUsageState(), [
		requestHeader(0, "deepseek-flash"),
		attempt(1, 1, 1, rawUsage({ input: 100, output: 10 })),
		requestHeader(2, "deepseek-v4-pro"),
		attempt(3, 2, 1, rawUsage({ input: 200, output: 20 }))
	]);
	assert.equal(transitions[1].added.model, "deepseek-flash");
	assert.equal(transitions[3].added.model, "deepseek-v4-pro");
});

test("missing model attribution keeps usage but leaves the sample unpriced", () => {
	const { state, transitions } = applyAll(emptyUsageState(), [
		attempt(0, 1, 1, rawUsage({ input: 100, output: 10 }))
	]);
	assert.equal(transitions[0].added.model, null);
	assert.deepEqual(state.tokens, {
		uncachedInput: 100,
		cacheRead: 0,
		cacheWrite: 0,
		output: 10,
		reasoning: 0
	});
	assert.equal(state.usageKnown, true);
});

test("reasoning is a subset of output and is never added again", () => {
	const tokenUsage = rawUsage({ input: 10, output: 100, reasoning: 40, total: 110 });
	const normalized = normalizeUsage(tokenUsage);
	assert.equal(normalized.complete, true);
	assert.deepEqual(normalized.buckets, { uncachedInput: 10, cacheRead: 0, cacheWrite: 0, output: 100 });
	assert.equal(normalized.reasoning, 40);
	const { state } = applyAll(emptyUsageState(), [
		requestHeader(0),
		message(1, 1, 1, { usage: tokenUsage })
	]);
	assert.equal(state.tokens.output, 100);
	assert.equal(state.tokens.reasoning, 40);
	assert.equal(totalUsageTokens(state.tokens), 110);
});

test("malformed usage is not converted into complete accounting", () => {
	const state = emptyUsageState();
	const transition = applyUsageEvent(state, message(1, 1, 1, {
		usage: rawUsage({ input: -1, output: 10 })
	}));
	assert.equal(transition.malformed, true);
	assert.equal(transition.state.usageKnown, false);
	assert.deepEqual(transition.state.tokens, { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 });
});

test("contradictory total preserves known buckets but marks usage incomplete", () => {
	const tokenUsage = rawUsage({ input: 10, output: 5, total: 999 });
	const transition = applyUsageEvent(emptyUsageState(), message(1, 1, 1, { usage: tokenUsage }));
	assert.equal(transition.added.complete, false);
	assert.deepEqual(transition.state.tokens, {
		uncachedInput: 10,
		cacheRead: 0,
		cacheWrite: 0,
		output: 5,
		reasoning: 0
	});
	assert.equal(transition.state.usageKnown, false);
});

test("aggregate cache hit is token-weighted, not an average of per-sample rates", () => {
	const first = {
		buckets: { uncachedInput: 1_000_000, cacheRead: 1_000_000, cacheWrite: 0, output: 0 },
		reasoning: 0
	};
	const second = {
		buckets: { uncachedInput: 3_000_000, cacheRead: 0, cacheWrite: 0, output: 0 },
		reasoning: 0
	};
	const aggregate = aggregateBuckets([first, second]);
	assert.equal(cacheHitOf(aggregate), 0.2);
	assert.notEqual(cacheHitOf(aggregate), (0.5 + 0) / 2);
});

test("reasoning presence is tracked separately from its numeric value", () => {
	const explicitZero = normalizeUsage(rawUsage({ input: 1, output: 10, reasoning: 0 }));
	const absent = normalizeUsage(rawUsage({ input: 1, output: 10 }));
	const nonZero = normalizeUsage(rawUsage({ input: 1, output: 10, reasoning: 4 }));
	assert.equal(explicitZero.reasoning, 0);
	assert.equal(explicitZero.reasoningReported, true);
	assert.equal(absent.reasoning, 0);
	assert.equal(absent.reasoningReported, false);
	assert.equal(nonZero.reasoning, 4);
	assert.equal(nonZero.reasoningReported, true);
});

test("aggregate reasoning presence stays conservative and never changes billed tokens", () => {
	const explicit = applyAll(emptyUsageState(), [
		requestHeader(0),
		message(1, 1, 1, { usage: rawUsage({ input: 10, output: 20, reasoning: 5 }) })
	]).state;
	const absent = applyAll(emptyUsageState(), [
		requestHeader(0),
		message(1, 1, 1, { usage: rawUsage({ input: 10, output: 20 }) })
	]).state;
	assert.equal(explicit.reasoningReported, true);
	assert.equal(absent.reasoningReported, false);
	assert.equal(totalUsageTokens(explicit.tokens), 30);
	assert.equal(totalUsageTokens(absent.tokens), 30);
	let mixed = applyAll(emptyUsageState(), [
		requestHeader(0),
		message(1, 1, 1, { usage: rawUsage({ input: 10, output: 20, reasoning: 5 }) }),
		requestHeader(2),
		message(3, 2, 1, { usage: rawUsage({ input: 10, output: 20 }) })
	]).state;
	assert.equal(mixed.tokens.reasoning, 5);
	assert.equal(mixed.reasoningReported, false);
	assert.equal(totalUsageTokens(mixed.tokens), 60);
});
