import { bun } from "@oh-my-pi/pi-utils/node-runtime";
import { resolvePackageManager, translateBunArgs } from "@oh-my-pi/pi-utils/package-manager";

/** Exit code and captured output of one package-manager invocation. */
export interface BunCliResult {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
}

/**
 * Runs the host package manager (pnpm when available, else npm) in `cwd` for
 * plugin install/update/uninstall.
 *
 * Bun let plugin installs re-enter the running executable with `BUN_BE_BUN=1`,
 * so no separate package manager was needed. Node has no such mode: resolve
 * pnpm/npm from `PATH` and translate Bun's argument spelling onto it.
 */
export async function runPackageManagerCli(args: readonly string[], cwd: string): Promise<BunCliResult> {
	const manager = resolvePackageManager();
	const proc = bun.spawn([manager.command, ...translateBunArgs(manager.kind, args)], {
		cwd,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		windowsHide: true,
	});
	// Drain both pipes concurrently with exit: awaiting `exited` first deadlocks
	// once a chatty install fills the OS pipe buffer.
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
}
