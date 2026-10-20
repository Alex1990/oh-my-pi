#!/usr/bin/env node
/**
 * `pnpm run setup` entrypoint. Chains the four setup steps (install → native
 * addon build → coding-agent link → omp link). The native host build uses
 * the local Cargo/N-API backend by default; set
 * `OMP_NATIVE_BUILD_BACKEND=bazel` to opt into bazel. Flags after `--` are
 * appended to the native build invocation.
 *
 * On Windows the final `link omp` step runs natively in this file instead of
 * spawning `sh` (issue #12483): same target check, same global-bin lookup
 * order, symlink with copy fallback.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { bun } from "@oh-my-pi/pi-utils/node-runtime";
const repoRoot = path.join(import.meta.dirname, "..");

const argv = process.argv.slice(2);
const passthrough: string[] = [];
for (let i = 0; i < argv.length; i++) {
	const arg = argv[i];
	if (arg === "--") {
		passthrough.push(...argv.slice(i + 1));
		break;
	}
	passthrough.push(arg);
}

interface Step {
	label: string;
	cmd: string[];
	cwd?: string;
}

/**
 * Native equivalent of `scripts/link-omp.sh` for Windows, where `sh` is
 * unavailable (issue #12483). Same semantics: verify the wrapper target,
 * resolve pnpm's global bin dir (`pnpm bin -g`, then `$PNPM_HOME`), and link
 * `omp` to it — symlink first, plain copy as a fallback when links need
 * privileges the user lacks. Returns a process-like exit code for the shared
 * runner below.
 */
function linkOmpWindows(repoRoot: string): number {
	const target = path.join(repoRoot, "packages", "coding-agent", "scripts", "omp");
	try {
		fs.accessSync(target, fs.constants.F_OK);
	} catch {
		console.error(`link-omp: target wrapper not found: ${target}`);
		return 1;
	}
	let globalBin = "";
	try {
		const out = bun.spawnSync(["pnpm", "bin", "-g"], { stdout: "pipe", stderr: "ignore" });
		if (out.exitCode === 0) globalBin = Buffer.from(out.stdout).toString().trim();
	} catch {
		// fall through to the default below
	}
	if (!globalBin) globalBin = process.env.PNPM_HOME ?? path.join(os.homedir(), ".local", "share", "pnpm");
	const linkPaths = ["oyp"].map(name => path.join(globalBin, name));
	try {
		fs.mkdirSync(globalBin, { recursive: true });
		for (const linkPath of linkPaths) {
			try {
				fs.unlinkSync(linkPath);
			} catch {
				// nothing to replace
			}
			fs.symlinkSync(target, linkPath, "file");
			console.log(`link-omp: linked ${linkPath} -> ${target}`);
		}
		return 0;
	} catch (error) {
		console.error(`link-omp: symlink failed (${error}), falling back to copy`);
		try {
			for (const linkPath of linkPaths) {
				fs.copyFileSync(target, linkPath);
				console.log(`link-omp: copied ${target} -> ${linkPath}`);
			}
			return 0;
		} catch (copyError) {
			console.error(`link-omp: copy failed (${copyError})`);
			return 1;
		}
	}
}

const steps: Step[] = [
	{ label: "pnpm install", cmd: ["pnpm", "install"] },
	{ label: "build:native", cmd: ["pnpm", "run", "build:native", ...passthrough] },
	{ label: "coding-agent link", cmd: ["pnpm", "--dir", "packages/coding-agent", "link"] },
	{ label: "link oyp", cmd: ["sh", "scripts/link-omp.sh"] },
];

for (const step of steps) {
	console.log(`\n▶ ${step.label}`);
	if (step.label === "link oyp" && process.platform === "win32") {
		const exitCode = linkOmpWindows(repoRoot);
		if (exitCode !== 0) {
			console.error(`\nsetup step "${step.label}" failed (exit ${exitCode})`);
			process.exit(exitCode);
		}
		continue;
	}
	const proc = bun.spawn(step.cmd, {
		cwd: step.cwd ?? repoRoot,
		env: process.env,
		stdout: "inherit",
		stderr: "inherit",
	});
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		console.error(`\nsetup step "${step.label}" failed (exit ${exitCode})`);
		process.exit(exitCode || 1);
	}
}
