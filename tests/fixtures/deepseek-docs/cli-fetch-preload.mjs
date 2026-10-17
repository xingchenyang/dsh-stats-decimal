import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const fixtureDirectory = new URL("./", import.meta.url);
const fixtureByUrl = new Map([
	["https://api-docs.deepseek.com/", "en-home.html"],
	["https://api-docs.deepseek.com/quick_start/pricing/", "en-pricing.html"],
	["https://api-docs.deepseek.com/zh-cn/quick_start/pricing/", "zh-pricing.html"],
	["https://api-docs.deepseek.com/updates/", "en-updates.html"],
	["https://api-docs.deepseek.com/news/news261017/", "en-news.html"]
]);

globalThis.fetch = async (input) => {
	const url = String(input);
	const fixture = fixtureByUrl.get(url);
	if (!fixture) return new Response("No offline CLI fixture for " + url, { status: 404 });
	let body = readFileSync(fileURLToPath(new URL(fixture, fixtureDirectory)), "utf8");
	const testCase = process.env.DSH_DOCS_CLI_TEST_CASE;
	if (testCase === "changed" && url === "https://api-docs.deepseek.com/quick_start/pricing/") {
		body = body.replace("$0.003", "$0.004");
	}
	if (testCase === "malformed" && url === "https://api-docs.deepseek.com/zh-cn/quick_start/pricing/") {
		body = "<html><body><table></table></body></html>";
	}
	return new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
};
