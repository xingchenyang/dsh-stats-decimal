/**
 * Pure provider-usage accounting fold shared by the live `billingLedger`
 * projection and the Local Today scan.
 *
 * The fold follows DSH's durable event contract:
 * - `assistant/message` prefers its authoritative `data.usage`, then falls back
 *   to the last usage chunk embedded in its stream;
 * - `assistant/attempt` uses the last usage chunk embedded in its stream;
 * - later samples for the same turn/step replace earlier samples;
 * - `llm/retry-started` closes the replacement slot so the next attempt adds.
 *
 * It deliberately contains no pricing, formatting, DSH service, or UI logic.
 * Usage is returned as disjoint provider buckets plus an informational
 * reasoning count (a subset of output, never added again to output).
 */

const ZERO_BUCKETS = () => ({
	uncachedInput: 0,
	cacheRead: 0,
	cacheWrite: 0,
	output: 0
});

function isCount(value) {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function safeSum(values) {
	let total = 0;
	for (const value of values) {
		if (!isCount(value)) return null;
		total += value;
		if (!Number.isSafeInteger(total)) return null;
	}
	return total;
}

function text(value) {
	return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Validate one provider usage object and normalize it to disjoint buckets.
 * Missing cache buckets default to zero, matching DSH's token projection.
 * A contradictory optional total is preserved as a known-usage/unknown-total
 * sample (`complete: false`) rather than silently dropped.
 *
 * @param {unknown} raw candidate `TokenUsage` value.
 * @returns {{buckets: {uncachedInput:number,cacheRead:number,cacheWrite:number,output:number}, reasoning:number, reasoningReported:boolean, complete:boolean}|null}
 */
export function normalizeUsage(raw) {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
	const inputTokens = raw.inputTokens;
	const outputTokens = raw.outputTokens;
	if (!isCount(inputTokens) || !isCount(outputTokens)) return null;
	const cacheReadTokens = raw.cacheReadTokens === undefined || raw.cacheReadTokens === null ? 0 : raw.cacheReadTokens;
	const cacheWriteTokens = raw.cacheWriteTokens === undefined || raw.cacheWriteTokens === null ? 0 : raw.cacheWriteTokens;
	if (!isCount(cacheReadTokens) || !isCount(cacheWriteTokens)) return null;
	const reasoningReported = raw.reasoningTokens !== undefined && raw.reasoningTokens !== null;
	const reasoningTokens = reasoningReported ? raw.reasoningTokens : 0;
	if (!isCount(reasoningTokens) || reasoningTokens > outputTokens) return null;
	const prompt = safeSum([inputTokens, cacheReadTokens, cacheWriteTokens]);
	if (prompt === null) return null;
	const total = safeSum([prompt, outputTokens]);
	if (total === null) return null;
	let complete = true;
	if (raw.totalTokens !== undefined && raw.totalTokens !== null) {
		if (!isCount(raw.totalTokens) || raw.totalTokens !== total) complete = false;
	}
	return {
		buckets: {
			uncachedInput: inputTokens,
			cacheRead: cacheReadTokens,
			cacheWrite: cacheWriteTokens,
			output: outputTokens
		},
		reasoning: reasoningTokens,
		// Presence metadata only: absent reasoningTokens must render as
		// unavailable, never as a provider-reported zero.
		reasoningReported,
		complete
	};
}

/** The last usage chunk embedded in one durable Assistant stream. */
export function lastStreamUsage(stream) {
	if (!Array.isArray(stream)) return undefined;
	for (let index = stream.length - 1; index >= 0; index -= 1) {
		const record = stream[index];
		if (record?.type === "chunk" && record.chunk?.type === "usage") return record.chunk.usage;
	}
	return undefined;
}

/**
 * Select the authoritative usage sample carried by an event.
 * @returns {{raw: unknown, source: "message"|"stream"}|null}
 */
export function usageSource(event) {
	if (event?.type === "assistant/message") {
		const usage = event.data?.usage;
		if (usage !== undefined && usage !== null) return { raw: usage, source: "message" };
		const streamUsage = lastStreamUsage(event.data?.stream);
		return streamUsage === undefined ? null : { raw: streamUsage, source: "stream" };
	}
	if (event?.type === "assistant/attempt") {
		const streamUsage = lastStreamUsage(event.data?.stream);
		return streamUsage === undefined ? null : { raw: streamUsage, source: "stream" };
	}
	return null;
}

function contextOf(event) {
	if (event?.type === "request/header") {
		const config = event.data?.header?.config;
		return { model: text(config?.model), provider: text(config?.provider) };
	}
	if (event?.type === "request/context") {
		return { model: text(event.data?.model), provider: text(event.data?.provider) };
	}
	return null;
}

function turnStepOf(event) {
	const turn = event?.data?.turn;
	const step = event?.data?.step;
	return {
		turn: Number.isSafeInteger(turn) ? turn : -1,
		step: Number.isSafeInteger(step) ? step : -1
	};
}

function bucketsEqual(left, right) {
	return left.uncachedInput === right.uncachedInput
		&& left.cacheRead === right.cacheRead
		&& left.cacheWrite === right.cacheWrite
		&& left.output === right.output;
}

function combineBuckets(tokens, buckets, reasoning, sign) {
	const next = {};
	for (const key of ["uncachedInput", "cacheRead", "cacheWrite", "output"]) {
		const value = tokens[key] + sign * buckets[key];
		if (!isCount(value)) return null;
		next[key] = value;
	}
	const nextReasoning = tokens.reasoning + sign * reasoning;
	if (!isCount(nextReasoning)) return null;
	next.reasoning = nextReasoning;
	return next;
}

/** Add one sample's buckets to a running total. */
export function addBuckets(tokens, buckets, reasoning = 0) {
	return combineBuckets(tokens, buckets, reasoning, 1);
}

/** Subtract one sample's buckets from a running total. */
export function subtractBuckets(tokens, buckets, reasoning = 0) {
	return combineBuckets(tokens, buckets, reasoning, -1);
}

export function aggregateBuckets(list) {
	let total = { ...ZERO_BUCKETS(), reasoning: 0 };
	for (const entry of list) {
		total = addBuckets(total, entry.buckets, entry.reasoning ?? 0);
		if (total === null) return null;
	}
	return total;
}

export function billedPromptTokens(buckets) {
	return safeSum([buckets.uncachedInput, buckets.cacheRead, buckets.cacheWrite]);
}

export function totalUsageTokens(buckets) {
	const prompt = billedPromptTokens(buckets);
	if (prompt === null) return null;
	return safeSum([prompt, buckets.output]);
}

/** Token-weighted cache hit over aggregate buckets. */
export function cacheHitOf(buckets) {
	const prompt = billedPromptTokens(buckets);
	return prompt !== null && prompt > 0 ? buckets.cacheRead / prompt : null;
}

/** State for one Session's own provider usage. */
export function emptyUsageState(inheritedEventCount = 0) {
	return {
		inheritedEventCount: Number.isSafeInteger(inheritedEventCount) && inheritedEventCount >= 0 ? inheritedEventCount : 0,
		tokens: { ...ZERO_BUCKETS(), reasoning: 0 },
		// null = no sample yet; true = every contributing sample reported it;
		// false = at least one contributing sample omitted the field.
		reasoningReported: null,
		currentModel: null,
		currentProvider: null,
		last: null,
		usageKnown: true
	};
}

/**
 * Fold one Session event into the pure usage state.
 *
 * Returns the next state plus an optional replacement transition:
 * - `removed`: the previous sample for the same turn/step;
 * - `added`: the new sample;
 * - `malformed`: a usage-bearing event whose payload could not be normalized.
 *
 * The caller may apply monetary pricing to `removed`/`added` and must not infer
 * additional provider requests from message counts.
 */
export function applyUsageEvent(state, event) {
	if (Number.isSafeInteger(event?.seq) && event.seq < state.inheritedEventCount) {
		return { state };
	}

	const context = contextOf(event);
	if (context !== null) {
		const model = context.model ?? state.currentModel;
		const provider = context.provider ?? state.currentProvider;
		if (model === state.currentModel && provider === state.currentProvider) return { state };
		return { state: { ...state, currentModel: model, currentProvider: provider } };
	}

	if (event?.type === "llm/retry-started") {
		const { turn, step } = turnStepOf(event);
		if (state.last === null || state.last.turn !== turn || state.last.step !== step) return { state };
		return { state: { ...state, last: null } };
	}

	if (event?.type !== "assistant/message" && event?.type !== "assistant/attempt") return { state };

	const source = usageSource(event);
	if (source === null) return { state };
	const normalized = normalizeUsage(source.raw);
	if (normalized === null) {
		return { state: { ...state, usageKnown: false }, malformed: true };
	}

	const { turn, step } = turnStepOf(event);
	const messageSource = event.type === "assistant/message" ? event.data?.message?.source : null;
	const model = text(messageSource?.model) ?? state.currentModel;
	const provider = text(messageSource?.provider) ?? state.currentProvider;
	const sample = {
		turn,
		step,
		buckets: normalized.buckets,
		reasoning: normalized.reasoning,
		reasoningReported: normalized.reasoningReported,
		model,
		provider,
		time: Number.isFinite(event.time) ? event.time : 0,
		complete: normalized.complete,
		source: source.source
	};

	const previous = state.last !== null && state.last.turn === turn && state.last.step === step
		? state.last
		: null;
	if (previous !== null
		&& bucketsEqual(previous.buckets, sample.buckets)
		&& previous.reasoning === sample.reasoning
		&& previous.reasoningReported === sample.reasoningReported
		&& previous.model === sample.model
		&& previous.provider === sample.provider
		&& previous.time === sample.time
		&& previous.complete === sample.complete) {
		return { state };
	}

	let tokens = state.tokens;
	if (previous !== null) tokens = subtractBuckets(tokens, previous.buckets, previous.reasoning);
	if (tokens === null) return { state: { ...state, usageKnown: false }, malformed: true };
	tokens = addBuckets(tokens, sample.buckets, sample.reasoning);
	if (tokens === null) return { state: { ...state, usageKnown: false }, malformed: true };

	// Conservative presence fold: once any contributing sample omitted the
	// field, the aggregate can no longer truthfully claim full reporting.
	let reasoningReported = state.reasoningReported ?? null;
	if (previous !== null && previous.reasoningReported === false) reasoningReported = false;
	reasoningReported = reasoningReported === null
		? sample.reasoningReported
		: reasoningReported && sample.reasoningReported;

	const nextState = {
		...state,
		tokens,
		reasoningReported,
		currentModel: model ?? state.currentModel,
		currentProvider: provider ?? state.currentProvider,
		last: sample,
		usageKnown: state.usageKnown && normalized.complete
	};
	return {
		state: nextState,
		...(previous === null ? {} : { removed: previous }),
		added: sample
	};
}
