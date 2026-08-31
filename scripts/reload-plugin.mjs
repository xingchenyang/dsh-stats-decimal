#!/usr/bin/env node
/**
 * reload-plugin.mjs — 一步重装本插件到指定的 dsh profile。
 *
 * 等价于手动执行的「remove + add」标准流程，但绕开 PowerShell 执行策略对
 * `dsh` / `pnpm` .ps1 的拦截：直接用 node 调用 dsh 的 bin.js（含 bundle
 * reconcile），行为与 `dsh plugin --profile <p> remove/add` 完全一致。
 *
 * 用法（在项目根目录，或任意目录带路径）：
 *   node scripts/reload-plugin.mjs                      # 默认 profile=web
 *   node scripts/reload-plugin.mjs --profile web        # 显式 profile
 *   node scripts/reload-plugin.mjs --profile headless   # 其它 profile
 *
 * 脚本只动 profile 的 package.json 依赖 + node_modules，不碰 profile 的
 * cordis.patch.yml（插件配置保留）。跑完记得重启 `dsh web` 并硬刷新（Ctrl+F5）。
 */
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

// ---- 常量 ---------------------------------------------------------------
// dsh CLI 全局安装的 bin.js。若你换过安装位置，改这里。
const DSH_BIN_CANDIDATES = [
	join(process.env.APPDATA ?? "", "npm", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"),
	join(process.env.LOCALAPPDATA ?? "", "npm", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"),
	join(process.env.USERPROFILE ?? "", "AppData", "Roaming", "npm", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js")
];

// 本脚本所在目录的父目录 = 插件源码根目录（dsh-stats-decimal）。
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = resolve(SCRIPT_DIR, "..");
const PACKAGE_NAME = "dsh-stats-decimal";

// ---- 参数解析 -----------------------------------------------------------
function parseArgs(argv) {
	const args = { profile: "web" };
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--profile") args.profile = argv[++i];
		else if (argv[i].startsWith("--profile=")) args.profile = argv[i].slice("--profile=".length);
		else if (argv[i] === "--dry-run") args.dryRun = true;
		else if (argv[i] === "--help" || argv[i] === "-h") args.help = true;
		else args.unknown = args.unknown ?? argv[i];
	}
	return args;
}

function findDshBin() {
	for (const candidate of DSH_BIN_CANDIDATES) {
		if (existsSync(candidate)) return candidate;
	}
	return null;
}

function fail(msg) {
	console.error(`\n[reload-plugin] 错误：${msg}`);
	process.exitCode = 1;
}

function runDsh(args, dryRun) {
	const bin = findDshBin();
	if (!bin) {
		fail(`找不到 dsh 的 bin.js。已尝试：\n${DSH_BIN_CANDIDATES.map((c) => `  ${c}`).join("\n")}`);
		return false;
	}
	if (dryRun) {
		console.log(`  [模拟] node "${bin}" ${args.join(" ")}`);
		return true;
	}
	const result = spawnSync(process.execPath, [bin, ...args], { encoding: "utf8" });
	if (result.stdout) process.stdout.write(result.stdout);
	if (result.stderr) process.stderr.write(result.stderr);
	if (result.status !== 0) {
		const why = result.status === null
			? `进程被终止（signal=${result.signal ?? "?"}）——通常是 profile 目录无写权限`
			: `退出码 ${result.status}`;
		fail(`dsh 命令 ${why}：dsh ${args.join(" ")}\n提示：在你有权写入 profile 的普通终端里运行本脚本（勿在受限/沙箱 shell 中跑）。`);
		return false;
	}
	return true;
}

// ---- 主流程 -------------------------------------------------------------
const args = parseArgs(process.argv.slice(2));
if (args.help || args.unknown) {
	console.log(`用法：
  node scripts/reload-plugin.mjs [--profile <name>] [--dry-run]

重装 ${PACKAGE_NAME} 到指定 dsh profile（默认 web）。
等价于 remove + add file:<源码绝对路径>，并保留 profile 的 cordis.patch.yml 配置。
--dry-run 只打印将执行的命令，不真正改动。
`);
	if (args.help) process.exit(0);
	fail(`未知参数：${args.unknown ?? "?"}`);
	process.exit(1);
}

if (args.dryRun) {
	console.log(`[reload-plugin] 模拟模式（--dry-run），不会改动任何 profile。`);
}

if (!existsSync(join(PLUGIN_DIR, "package.json"))) {
	fail(`找不到插件源码根目录（缺 package.json）：${PLUGIN_DIR}`);
	process.exit(1);
}

console.log(`[reload-plugin] profile=${args.profile}  package=${PACKAGE_NAME}  source=${PLUGIN_DIR}`);
console.log(`[reload-plugin] 第 1 步 / 2：remove ${PACKAGE_NAME}`);
if (!runDsh(["plugin", "--profile", args.profile, "remove", PACKAGE_NAME], args.dryRun)) process.exit(1);

console.log(`[reload-plugin] 第 2 步 / 2：add file:${PLUGIN_DIR}`);
if (!runDsh(["plugin", "--profile", args.profile, "add", `file:${resolve(PLUGIN_DIR)}`], args.dryRun)) process.exit(1);

if (args.dryRun) {
	console.log(`\n[reload-plugin] 已确认命令无误（未实际运行）。真实执行请去掉 --dry-run。`);
	process.exit(0);
}

console.log(`
[reload-plugin] 完成。已重装 ${PACKAGE_NAME} 到 profile "${args.profile}"。
下一步：重启 dsh web 并硬刷新页面（Ctrl+F5）：
  dsh web
`);
