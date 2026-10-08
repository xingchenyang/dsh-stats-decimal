#!/usr/bin/env node

import { readFile } from "node:fs/promises";

const ROOTS = {
	zhCN: "https://api-docs.deepseek.com/zh-cn/",
	en: "https://api-docs.deepseek.com/"
};
const BASELINE_URL = new URL("../docs/deepseek-docs-baseline.json", import.meta.url);
const snapshotOnly = process.argv.includes("--snapshot");

async function fetchSource(url) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 20_000);
	try {
		const response = await fetch(url, {
			headers: { "user-agent": "dsh-stats-decimal-upstream-check/0.5.0" },
			signal: controller.signal
		});
		if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
		return await response.text();
	} finally {
		clearTimeout(timer);
	}
}

function decodeHtml(value) {
	return value
		.replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
		.replace(/&#([0-9]+);/g, (_, decimal) => String.fromCodePoint(Number.parseInt(decimal, 10)))
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, "\"")
		.replace(/&#39;/gi, "'");
}

function plainText(html) {
	const main = /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(html)?.[1] ?? html;
	return decodeHtml(main
		.replace(/<(script|style|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
		.replace(/<[^>]+>/g, " "))
		.replace(/\s+/g, " ")
		.trim();
}

function sidebarFromSource(html) {
	const entries = [];
	const seen = new Set();
	for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
		const attributes = match[1];
		const classes = /class=["']([^"']*)["']/i.exec(attributes)?.[1] ?? "";
		if (!classes.split(/\s+/).includes("menu__link")) continue;
		const href = /href=["']([^"']+)["']/i.exec(attributes)?.[1];
		const title = plainText(match[2]);
		if (!href || !title) continue;
		const key = `${href}\u0000${title}`;
		if (seen.has(key)) continue;
		seen.add(key);
		entries.push({ href, title });
	}
	return entries;
}

function newsFromSidebar(sidebar) {
	return sidebar
		.filter((item) => item.href.startsWith("/news/") && /\d{4}\/\d{2}\/\d{2}/.test(item.title))
		.map((item) => ({ path: item.href.replace(/\/$/, ""), titleEn: item.title }));
}

function firstNewsPath(html) {
	const href = /href=["'](\/(?:zh-cn\/)?news\/[^"'#?]+)["']/i.exec(html)?.[1];
	if (!href) throw new Error("首页源码中没有找到新闻入口");
	return href.replace(/^\/zh-cn/, "").replace(/\/$/, "");
}

function localizedNewsUrl(path, locale) {
	return new URL(`${locale === "zhCN" ? "/zh-cn" : ""}${path}/`, ROOTS[locale]).href;
}

async function currentSnapshot() {
	// English is the default discovery surface: in practice it responds more
	// reliably, while internal routes are canonicalized so the saved zh-CN
	// references can be derived without fetching the same navigation twice.
	const enRoot = await fetchSource(ROOTS.en);
	// The home pages expose the current News entry, while the complete News
	// sidebar is rendered in that article's source. Follow the discovered entry
	// instead of hard-coding the newest slug.
	const enNewsPath = firstNewsPath(enRoot);
	const enNewsSource = await fetchSource(localizedNewsUrl(enNewsPath, "en"));
	const sidebar = sidebarFromSource(enNewsSource);
	return {
		checkedAt: new Date().toISOString(),
		roots: ROOTS,
		queryLocale: "en",
		newsSeeds: {
			zhCN: localizedNewsUrl(enNewsPath, "zhCN"),
			en: localizedNewsUrl(enNewsPath, "en")
		},
		news: newsFromSidebar(sidebar),
		sidebar
	};
}

function compare(current, baseline) {
	const oldPaths = new Set(baseline.news.map((item) => item.path));
	const currentPaths = new Set(current.news.map((item) => item.path));
	const addedNews = current.news.filter((item) => !oldPaths.has(item.path));
	const removedNews = baseline.news.filter((item) => !currentPaths.has(item.path));
	const sidebarChanges = [];
	const before = baseline.sidebar ?? [];
	const after = current.sidebar;
	const entryKey = (item) => `${item.href}\u0000${item.title}`;
	const beforeKeys = new Set(before.map(entryKey));
	const afterKeys = new Set(after.map(entryKey));
	for (const item of after) {
		if (!beforeKeys.has(entryKey(item))) sidebarChanges.push({ kind: "added", ...item });
	}
	for (const item of before) {
		if (!afterKeys.has(entryKey(item))) sidebarChanges.push({ kind: "removed", ...item });
	}
	if (before.map(entryKey).join("\n") !== after.map(entryKey).join("\n")) {
		sidebarChanges.push({ kind: "reordered", href: "", title: "侧栏顺序发生变化" });
	}
	return { addedNews, removedNews, sidebarChanges };
}

function printReport(result, baseline) {
	console.log(`[deepseek-docs] baseline=${baseline.checkedAt}`);
	if (!result.addedNews.length && !result.removedNews.length && !result.sidebarChanges.length) {
		console.log("[deepseek-docs] 未发现英文 canonical 侧栏目录变化。");
		return false;
	}
	for (const item of result.addedNews) console.log(`[deepseek-docs] 新增新闻 ${item.path}  ${item.titleZhCN ?? item.titleEn ?? ""}`);
	for (const item of result.removedNews) console.log(`[deepseek-docs] 移除新闻 ${item.path}  ${item.titleZhCN ?? item.titleEn ?? ""}`);
	for (const item of result.sidebarChanges) console.log(`[deepseek-docs] 侧栏${item.kind}  ${item.href}  ${item.title}`);
	console.log("[deepseek-docs] 请打开相关新增页面，人工核对价格、实际生效时间及公告是否被撤回；脚本不会读取正文或修改计费表。");
	return true;
}

try {
	const current = await currentSnapshot();
	if (snapshotOnly) {
		console.log(JSON.stringify(current, null, 2));
	} else {
		const baseline = JSON.parse(await readFile(BASELINE_URL, "utf8"));
		if (printReport(compare(current, baseline), baseline)) process.exitCode = 2;
	}
} catch (error) {
	console.error(`[deepseek-docs] 检查失败：${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
}
