import { describe, expect, test } from "@oh-my-pi/pi-utils/test-runtime";
import * as path from "node:path";
import { bun } from "@oh-my-pi/pi-utils/node-runtime";
import { build } from "@oh-my-pi/pi-utils/node-build";

const repoRoot = path.join(import.meta.dirname, "..");

async function run(command: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const proc = bun.spawn(command, {
		cwd: repoRoot,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
}

describe("musl release artifacts", () => {
	test("builds the requested x64 and arm64 musl launcher assets", async () => {
		const result = await run([
			"node",
			"--experimental-transform-types",
			"--import",
			"./scripts/node-runtime-loader.mjs",
			"scripts/ci-release-build-binaries.ts",
			"--dry-run",
			"--targets",
			"linux-musl-x64,linux-musl-arm64",
		]);

		expect(result.exitCode, result.stderr).toBe(0);
		expect(result.stdout).toContain(
			"DRY RUN launcher packages/coding-agent/binaries/oyp-linux-musl-x64 (linux)",
		);
		expect(result.stdout).toContain(
			"DRY RUN launcher packages/coding-agent/binaries/oyp-linux-musl-arm64 (linux)",
		);
	});
});
