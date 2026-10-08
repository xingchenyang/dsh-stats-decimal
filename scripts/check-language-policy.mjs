#!/usr/bin/env node

import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url)).replace(/[\\/]scripts$/, "");
const packagePath = join(ROOT, "package.json");
const manifestPath = join(ROOT, "docs", "localization-manifest.json");
const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const approvedChineseNavigation = "English | [" + String.fromCodePoint(0x4e2d, 0x6587) + "](README.zh.md)";
const markdownFiles = [
	"README.md", "DEVELOPMENT.md", "CHANGELOG.md", "AGENTS.md",
	"docs/BILLING_CALENDAR.md", "docs/PRICING_HISTORY.md",
	"docs/DEEPSEEK_NEWS_INDEX.md", ".work/README.md"
];
const plainEnglishFiles = [
	".gitignore", ".gitattributes", ".githooks/pre-commit",
	"cordis.patch.yml", "package.json", "docs/localization-manifest.json"
];
const errors = [];

function report(file, line, message) {
	errors.push(file + ":" + line + ": " + message);
}

function proseLines(source) {
	const lines = source.split(/\r?\n/);
	const result = [];
	let fenceCharacter = "";
	let fenceLength = 0;
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		const marker = /^\s{0,3}(\x60{3,}|~{3,})/.exec(line);
		if (marker) {
			const character = marker[1][0];
			if (!fenceCharacter) {
				fenceCharacter = character;
				fenceLength = marker[1].length;
			} else if (character === fenceCharacter && marker[1].length >= fenceLength) {
				fenceCharacter = "";
				fenceLength = 0;
			}
			continue;
		}
		if (fenceCharacter || /^\s{0,3}>/.test(line)) continue;
		const withoutCode = line.replace(/\x60+([^\x60]*)\x60+/g, " ");
		result.push({ line: index + 1, text: withoutCode });
	}
	return result;
}

function comments(source) {
	const result = [];
	let index = 0;
	let line = 1;
	while (index < source.length) {
		const current = source[index];
		const next = source[index + 1];
		if (current === "\n") {
			line++;
			index++;
			continue;
		}
		if (current === "'" || current === "\"" || current === String.fromCharCode(96)) {
			const quote = current;
			index++;
			while (index < source.length) {
				if (source[index] === "\\") {
					if (source[index + 1] === "\n") line++;
					index += 2;
					continue;
				}
				if (source[index] === "\n") line++;
				if (source[index] === quote) {
					index++;
					break;
				}
				index++;
			}
			continue;
		}
		if (current === "/" && next === "/") {
			const commentLine = line;
			const start = index + 2;
			const end = source.indexOf("\n", start);
			result.push({ line: commentLine, text: source.slice(start, end < 0 ? source.length : end) });
			index = end < 0 ? source.length : end;
			continue;
		}
		if (current === "/" && next === "*") {
			const commentLine = line;
			index += 2;
			const start = index;
			while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
				if (source[index] === "\n") line++;
				index++;
			}
			result.push({ line: commentLine, text: source.slice(start, index) });
			index += 2;
			continue;
		}
		index++;
	}
	return result;
}

async function walk(directory) {
	const entries = await readdir(join(ROOT, directory), { withFileTypes: true });
	const files = [];
	for (const entry of entries) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) files.push(...await walk(path));
		else if (/\.(?:mjs|js)$/.test(entry.name)) files.push(path);
	}
	return files;
}

for (const file of markdownFiles) {
	let source;
	try {
		source = await readFile(join(ROOT, file), "utf8");
	} catch (error) {
		if (file === ".work/README.md" && error?.code === "ENOENT") {
			report(file, 1, "Required tracked repository documentation file is missing.");
			continue;
		}
		throw error;
	}
	for (const line of proseLines(source)) {
		const isChineseNavigation = file === "README.md" && line.text === approvedChineseNavigation;
		if (!isChineseNavigation && cjk.test(line.text)) report(file, line.line, "CJK found in canonical English prose.");
	}
}

const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const snapshot = (manifest.translations || []).find((entry) =>
	entry.path === "README.zh.md" && entry.canonicalPath === "README.md"
);
if (!snapshot) {
	report("docs/localization-manifest.json", 1, "The README.zh.md to README.md mapping is missing.");
} else {
	if (manifest.snapshotVersion !== packageJson.version || snapshot.snapshotVersion !== packageJson.version) {
		report("docs/localization-manifest.json", 1, "Snapshot version must match package.json.");
	}
	if (!Array.isArray(manifest.synchronizationRules) || manifest.synchronizationRules.length === 0) {
		report("docs/localization-manifest.json", 1, "Synchronization rules are missing.");
	}
	const chineseReadme = await readFile(join(ROOT, snapshot.path), "utf8");
	const englishReadme = await readFile(join(ROOT, snapshot.canonicalPath), "utf8");
	if (!chineseReadme.includes(packageJson.version)) report(snapshot.path, 1, "Snapshot version is missing from the document.");
	if (!/\]\(README\.zh\.md\)/i.test(englishReadme) || !/\]\(README\.md\)/i.test(chineseReadme)) {
		report(snapshot.path, 1, "The English and Chinese README links must be reciprocal.");
	}
}

for (const file of plainEnglishFiles) {
	const source = await readFile(join(ROOT, file), "utf8");
	for (const [index, line] of source.split(/\r?\n/).entries()) {
		if (cjk.test(line)) report(file, index + 1, "CJK found in an English maintenance or configuration file.");
	}
}

for (const directory of ["lib", "scripts", "tests"]) {
	for (const file of await walk(directory)) {
		const source = await readFile(join(ROOT, file), "utf8");
		for (const comment of comments(source)) {
			const offset = comment.text.split(/\r?\n/).findIndex((text) => cjk.test(text));
			if (offset >= 0) report(file, comment.line + offset, "CJK found in an engineering code comment.");
		}
		if (directory === "scripts") {
			for (const [index, line] of source.split(/\r?\n/).entries()) {
				if (cjk.test(line)) report(file, index + 1, "CJK found in a maintenance script or diagnostic.");
			}
		}
		const normalizedFile = file.replaceAll("\\", "/");
		if (normalizedFile === "lib/client.js") {
			const start = source.indexOf("const zh = {");
			const end = source.indexOf("\n\t\tconst en = {", start);
			if (start < 0 || end < 0) {
				report(file, 1, "Could not locate the documented Chinese locale dictionary boundaries.");
			} else {
				let englishCode = source.slice(0, start) + source.slice(end);
				const fallback = String.fromCodePoint(0x6cd5, 0x5b9a, 0x8282, 0x5047, 0x65e5);
				const fallbackToken = "\"" + fallback + "\"";
				const fallbackLine = englishCode.split(/\r?\n/).find((line) =>
					line.includes("name: typeof holiday.name") && line.includes(fallbackToken)
				);
				if (!fallbackLine) {
					report(file, 1, "Could not locate the documented localized holiday fallback.");
				} else {
					englishCode = englishCode.replace(fallbackToken, "\"\"");
					for (const [index, line] of englishCode.split(/\r?\n/).entries()) {
						if (cjk.test(line)) report(file, index + 1, "CJK found outside the locale dictionary and holiday fallback.");
					}
				}
			}
		} else if (normalizedFile !== "lib/billing-calendar/2026.js" && directory === "lib") {
			for (const [index, line] of source.split(/\r?\n/).entries()) {
				if (cjk.test(line)) report(file, index + 1, "CJK found outside the documented source-data file.");
			}
		}
	}
}

if (errors.length) {
	console.error("[language-policy] Failed:");
	for (const error of errors) console.error("- " + error);
	process.exitCode = 1;
} else {
	console.log("[language-policy] Canonical prose and engineering comments are English; documented localization and source-data exceptions are preserved. README.zh.md matches package.json.");
}
