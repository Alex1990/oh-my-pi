import { afterEach, expect, it } from "@oh-my-pi/pi-utils/test-runtime";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { bun } from "@oh-my-pi/pi-utils/node-runtime";
import { nodeSourceFlags } from "../../src/subprocess/worker-client";

const probePath = path.resolve(import.meta.dirname, "../fixtures/legacy-pi-require-cache-clear-probe.ts");
const tempDirs: TempDir[] = [];

afterEach(async () => {
	for (const dir of tempDirs.splice(0)) await dir.remove();
});

// #15799: `stealthy-require` (via `request-promise`) deletes every `require.cache`
// key and assigns them back. Under Bun that also unloaded the host's ES modules,
// so the next host import evaluated a second, uninitialized settings singleton.
it("keeps host modules loaded when extension CommonJS clears and restores require.cache", async () => {
	const dir = TempDir.createSync("@omp-require-cache-clear-");
	tempDirs.push(dir);
	await bun.write(dir.join("package.json"), JSON.stringify({ name: "cache-clearing-extension", version: "1.0.0" }));
	await bun.write(
		dir.join("dep.cjs"),
		[
			"const saved = Object.assign({}, require.cache);",
			"for (const key in require.cache) delete require.cache[key];",
			"Object.assign(require.cache, saved);",
			"module.exports = { cleared: Object.keys(require.cache).length === Object.keys(saved).length };",
		].join("\n"),
	);
	await bun.write(dir.join("index.mjs"), "import dep from './dep.cjs';\nexport const cleared = dep.cleared;\n");

	// Subprocess: without the guard the probe's whole module graph is unloaded.
	const proc = bun.spawn([process.execPath, ...nodeSourceFlags(), probePath, dir.join("index.mjs")], {
		cwd: path.resolve(import.meta.dirname, "../.."),
		env: { ...process.env, PI_CODING_AGENT_DIR: dir.join("agent") },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);

	expect(exitCode, stderr).toBe(0);
	expect(JSON.parse(stdout)).toEqual({ cleared: true, settingsInitialized: true });
});
