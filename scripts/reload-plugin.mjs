#!/usr/bin/env node
/**
 * reload-plugin.mjs — Reinstall this plugin into a selected dsh profile.
 *
 * This is equivalent to the standard manual remove + add flow. Calling dsh's
 * bin.js through Node avoids PowerShell execution-policy blocks on dsh/pnpm
 * .ps1 shims and includes bundle reconciliation.
 *
 * Usage (from the repository root, or pass a path from another directory):
 *   node scripts/reload-plugin.mjs                      # default profile=web
 *   node scripts/reload-plugin.mjs --profile web        # select web explicitly
 *   node scripts/reload-plugin.mjs --profile headless   # select another profile
 *
 * The script updates only profile dependencies and node_modules. It leaves the
 * profile's cordis.patch.yml and plugin configuration untouched. Restart
 * `dsh web` and hard-refresh (Ctrl+F5) after it completes.
 */
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

// ---- Constants ----------------------------------------------------------
// Candidate locations for the globally installed dsh CLI bin.js.
const DSH_BIN_CANDIDATES = [
	join(process.env.APPDATA ?? "", "npm", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"),
	join(process.env.LOCALAPPDATA ?? "", "npm", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"),
	join(process.env.USERPROFILE ?? "", "AppData", "Roaming", "npm", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js")
];

// The parent of this script's directory is the plugin source root.
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = resolve(SCRIPT_DIR, "..");
const PACKAGE_NAME = "dsh-stats-decimal";

// ---- Argument parsing ---------------------------------------------------
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
	console.error(`\n[reload-plugin] Error: ${msg}`);
	process.exitCode = 1;
}

function runDsh(args, dryRun) {
	const bin = findDshBin();
	if (!bin) {
		fail(`Could not find dsh's bin.js. Tried:\n${DSH_BIN_CANDIDATES.map((c) => `  ${c}`).join("\n")}`);
		return false;
	}
	if (dryRun) {
		console.log(`  [dry run] node "${bin}" ${args.join(" ")}`);
		return true;
	}
	const result = spawnSync(process.execPath, [bin, ...args], { encoding: "utf8" });
	if (result.stdout) process.stdout.write(result.stdout);
	if (result.stderr) process.stderr.write(result.stderr);
	if (result.status !== 0) {
		const why = result.status === null
			? `process terminated (signal=${result.signal ?? "?"}); the profile directory may not be writable`
			: `exit code ${result.status}`;
		fail(`dsh command failed (${why}): dsh ${args.join(" ")}\nRun this script in a normal terminal with write access to the profile; restricted or sandboxed shells may block it.`);
		return false;
	}
	return true;
}

// ---- Main flow ----------------------------------------------------------
const args = parseArgs(process.argv.slice(2));
if (args.help || args.unknown) {
	console.log(`Usage:
  node scripts/reload-plugin.mjs [--profile <name>] [--dry-run]

Reinstall ${PACKAGE_NAME} into the selected dsh profile (default: web).
Equivalent to remove + add file:<absolute-source-path>; profile cordis.patch.yml is preserved.
--dry-run prints the commands without making changes.
`);
	if (args.help) process.exit(0);
	fail(`Unknown argument: ${args.unknown ?? "?"}`);
	process.exit(1);
}

if (args.dryRun) {
	console.log(`[reload-plugin] Dry-run mode; no profile will be changed.`);
}

if (!existsSync(join(PLUGIN_DIR, "package.json"))) {
	fail(`Plugin source root not found (package.json is missing): ${PLUGIN_DIR}`);
	process.exit(1);
}

console.log(`[reload-plugin] profile=${args.profile}  package=${PACKAGE_NAME}  source=${PLUGIN_DIR}`);
console.log(`[reload-plugin] Step 1 of 2: remove ${PACKAGE_NAME}`);
if (!runDsh(["plugin", "--profile", args.profile, "remove", PACKAGE_NAME], args.dryRun)) process.exit(1);

console.log(`[reload-plugin] Step 2 of 2: add file:${PLUGIN_DIR}`);
if (!runDsh(["plugin", "--profile", args.profile, "add", `file:${resolve(PLUGIN_DIR)}`], args.dryRun)) process.exit(1);

if (args.dryRun) {
	console.log(`\n[reload-plugin] Commands verified; nothing was run. Remove --dry-run to execute them.`);
	process.exit(0);
}

console.log(`
[reload-plugin] Complete. Reinstalled ${PACKAGE_NAME} into profile "${args.profile}".
Next: restart dsh web and hard-refresh the page (Ctrl+F5):
  dsh web
`);
