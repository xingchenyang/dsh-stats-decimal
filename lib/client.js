/**
 * dsh-stats-decimal — browser half.
 *
 * Fixes the cache-hit display bug in @deepseek-ai/dsh-client-ui-conversation:
 * the shipped StatsLine renders `Math.round(cacheRead / billed * 100)` — an
 * integer, so 99.7% shows as 100% and 99.4% as 99%. This bundle shadows the
 * shipped entry of the `conversation.composer.dock` list slot (same cell id
 * "stats" at a lower priority; the slot registry's per-id shadowing means only
 * the lowest-priority entry of a cell renders) and draws the line itself with
 * two decimals truncated down (e.g. 99.20%) — never rounded up, so 99.9999%
 * shows 99.99% instead of a misleading 100%. Layout: one row for the run
 * summary (turns/steps, durations, speeds) and a second row for the token
 * ledger (cache-hit share + billed input/output), each kept on a single line.
 *
 * Format mirrors the shipped bundle: window.__ModuleLoader__.load({ id, factory }),
 * no build step required.
 */
window.__ModuleLoader__.load({
	id: "dsh-stats-decimal",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");

		const NS = "stats-decimal";

		// ---- display helpers ----
		// Token figures: raw counts below 1000 have no K/M unit and stay
		// integers (e.g. 131 tok); K/M scales always carry two decimals,
		// truncated down — never rounded up (0.01 at a large base is still a
		// large quantity, and rounding would overstate it). All truncation is
		// done in integer math on the raw token count, so no float drift.
		function formatTokens(n) {
			if (n < 1e3) return String(n);
			let unit, div100;
			if (n < 1e6) {
				unit = "K";
				div100 = 10;
			} else if (n < 1e9) {
				unit = "M";
				div100 = 10000;
			} else {
				unit = "G";
				div100 = 10000000;
			}
			const hundredths = Math.floor(n / div100);
			return `${(hundredths / 100).toFixed(2)}${unit}`;
		}
		function formatDuration(ms) {
			const s = ms / 1e3;
			if (s < 60) return `${Math.round(s * 10) / 10}s`;
			const whole = Math.round(s);
			return `${Math.floor(whole / 60)}m${whole % 60}s`;
		}
		function formatTokensPerSecond(tps) {
			const clamped = Math.max(0, tps);
			return clamped >= 10 ? String(Math.round(clamped)) : String(Math.round(clamped * 10) / 10);
		}
		/** The fix: two decimals, truncated down (never rounded up to 100%). */
		function cacheHitPercent(usage) {
			const denominator = billedInputTokens(usage);
			if (denominator === 0) return null;
			// Integer math: exact truncation to the hundredth of a percent.
			return Math.floor(usage.cacheReadTokens * 10000 / denominator) / 100;
		}
		function billedInputTokens(usage) {
			return usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
		}

		// ---- locale templates copied verbatim from the conversation bundle ----
		const zh = {
			"stats.counts": "{turns} 轮 · {steps} 步",
			"stats.llm": "LLM {duration}",
			"stats.toolCall": "工具调用 {duration}",
			"stats.ttftAverage": "首 token 平均 {duration}",
			"stats.tokensPerSecond": "{throughput} tok/s",
			"stats.cacheHit": "缓存命中 {percent}%",
			"stats.tokens": "输入 {input} tok · 输出 {output} tok"
		};
		const en = {
			"stats.counts": "{turns} turns · {steps} steps",
			"stats.llm": "LLM {duration}",
			"stats.toolCall": "Tool call {duration}",
			"stats.ttftAverage": "TTFT avg {duration}",
			"stats.tokensPerSecond": "{throughput} tok/s",
			"stats.cacheHit": "Cache hit {percent}%",
			"stats.tokens": "Input {input} tok · Output {output} tok"
		};

		// Same props shape the shipped StatsLine receives in this slot:
		// { useSession, useProjection, t } — we only need the last two.
		// Typography mirrors the shipped StatsLine.module.css (12px, tertiary
		// label, centered, spaced separators); truncation + tooltip is dropped
		// in favor of full output. Rows never wrap (each fits the composer
		// column); the ledger gets its own row so the cache-hit and token
		// figures stay readable next to the two-decimal precision.
		const rootStyle = {
			textAlign: "center",
			boxSizing: "border-box",
			width: "100%",
			padding: "4px calc(var(--dsh-composer-side-clearance) + 16px) 0px",
			color: "var(--dsw-alias-label-tertiary)",
			fontSize: "12px",
			lineHeight: "20px",
			display: "block"
		};
		const lineStyle = {
			whiteSpace: "nowrap"
		};
		const sepStyle = {
			color: "var(--dsw-alias-separator-primary)",
			margin: "0 10px"
		};
		function StatsLineDecimal({ useProjection, t }) {
			const usage = useProjection("tokenUsage");
			const projected = useProjection("sessionStats");
			const stats = projected ?? null;
			const summary = [];
			const ledger = [];
			if (stats !== null && stats.steps > 0) {
				summary.push(t("stats.counts", {
					turns: stats.turns,
					steps: stats.steps
				}));
				const durations = [];
				if (stats.llmMs > 0) durations.push(t("stats.llm", { duration: formatDuration(stats.llmMs) }));
				if (stats.toolMs > 0) durations.push(t("stats.toolCall", { duration: formatDuration(stats.toolMs) }));
				if (durations.length > 0) summary.push(durations.join(" · "));
				const speeds = [];
				if (stats.ttftSteps > 0) speeds.push(t("stats.ttftAverage", { duration: formatDuration(stats.ttftMs / stats.ttftSteps) }));
				if (stats.decodeMs > 0) speeds.push(t("stats.tokensPerSecond", { throughput: formatTokensPerSecond(stats.decodeTokens / (stats.decodeMs / 1e3)) }));
				if (speeds.length > 0) summary.push(speeds.join(" · "));
			}
			if (usage !== void 0 && (billedInputTokens(usage) > 0 || usage.outputTokens > 0)) {
				const cacheHit = cacheHitPercent(usage);
				if (cacheHit !== null) ledger.push(t("stats.cacheHit", { percent: cacheHit.toFixed(2) }));
				ledger.push(t("stats.tokens", {
					input: formatTokens(billedInputTokens(usage)),
					output: formatTokens(usage.outputTokens)
				}));
			}
			const renderRow = (groups) => {
				if (groups.length === 0) return null;
				const children = [];
				groups.forEach((group, i) => {
					if (i > 0) {
						children.push(react.createElement("span", { style: sepStyle, "aria-hidden": true }, "|"), " ");
					}
					children.push(react.createElement("span", null, group));
				});
				return react.createElement("div", { style: lineStyle }, children);
			};
			const rows = [renderRow(summary), renderRow(ledger)].filter(Boolean);
			return react.createElement("div", { "data-stats-decimal": "", style: rootStyle }, rows);
		}

		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "stats-decimal: dictionaries");
			// Wait for the shipped slot declaration, then shadow cell "stats"
			// at priority -1 (shipped entry sits at priority 0).
			ctx.slots.inject("conversation.composer.dock", () => ctx.slots.register({
				name: "conversation.composer.dock",
				id: "stats",
				priority: -1,
				order: 0,
				locale: NS
			}, StatsLineDecimal));
		}

		exports.apply = apply;
		exports.inject = ["slots", "locale"];
		return module.exports;
	}
});
