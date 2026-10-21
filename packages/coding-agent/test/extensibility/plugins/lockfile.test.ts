import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, test } from "@oh-my-pi/pi-utils/test-runtime";
import {
	readLockResolution,
	restoreLockfiles,
	snapshotLockfiles,
} from "@oh-my-pi/pi-coding-agent/extensibility/plugins/lockfile";
import { bun } from "@oh-my-pi/pi-utils/node-runtime";

const GIT_SPEC = "github:HexRaysSA/ida-mcp#main";

async function tempDir(): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), "omp-plugin-lockfile-"));
}

async function write(dir: string, name: string, content: string): Promise<void> {
	await bun.write(path.join(dir, name), content);
}

describe("readLockResolution", () => {
	test("reads a git resolution from pnpm's importer entry", async () => {
		const dir = await tempDir();
		await write(
			dir,
			"pnpm-lock.yaml",
			`lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      ida-mcp:
        specifier: ${GIT_SPEC}
        version: github.com/HexRaysSA/ida-mcp/abc123
      left-pad:
        specifier: ^1.3.0
        version: 1.3.0
`,
		);

		expect(await readLockResolution(dir, "ida-mcp")).toBe("github.com/HexRaysSA/ida-mcp/abc123");
		expect(await readLockResolution(dir, "left-pad")).toBe("1.3.0");
	});

	test("prefers npm's resolved git URL over the package version", async () => {
		const dir = await tempDir();
		await write(
			dir,
			"package-lock.json",
			JSON.stringify({
				lockfileVersion: 3,
				packages: {
					"node_modules/ida-mcp": {
						version: "1.0.0",
						resolved: "git+ssh://git@github.com/HexRaysSA/ida-mcp.git#abc123",
					},
					"node_modules/left-pad": {
						version: "1.3.0",
						resolved: "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz",
					},
				},
			}),
		);

		expect(await readLockResolution(dir, "ida-mcp")).toBe("git+ssh://git@github.com/HexRaysSA/ida-mcp.git#abc123");
		expect(await readLockResolution(dir, "left-pad")).toBe(
			"https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz",
		);
	});

	test("falls back to a legacy bun.lock entry", async () => {
		const dir = await tempDir();
		await write(
			dir,
			"bun.lock",
			JSON.stringify({ packages: { "ida-mcp": ["ida-mcp@github:HexRaysSA/ida-mcp#abc123", "", {}] } }),
		);

		expect(await readLockResolution(dir, "ida-mcp")).toBe("ida-mcp@github:HexRaysSA/ida-mcp#abc123");
	});

	test("falls through to the next lockfile when the package is absent", async () => {
		const dir = await tempDir();
		await write(dir, "pnpm-lock.yaml", "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies: {}\n");
		await write(
			dir,
			"package-lock.json",
			JSON.stringify({ packages: { "node_modules/ida-mcp": { version: "2.0.0" } } }),
		);

		expect(await readLockResolution(dir, "ida-mcp")).toBe("2.0.0");
	});

	test("returns undefined when no lockfile records the package", async () => {
		const dir = await tempDir();
		expect(await readLockResolution(dir, "ida-mcp")).toBeUndefined();
	});
});

describe("lockfile snapshots", () => {
	test("restores overwritten lockfiles and removes ones created by the install", async () => {
		const dir = await tempDir();
		await write(dir, "pnpm-lock.yaml", "before\n");
		const snapshot = await snapshotLockfiles(dir);

		await write(dir, "pnpm-lock.yaml", "after\n");
		await write(dir, "package-lock.json", "{}\n");
		await restoreLockfiles(snapshot);

		expect(await bun.file(path.join(dir, "pnpm-lock.yaml")).text()).toBe("before\n");
		await expect(fs.access(path.join(dir, "package-lock.json"))).rejects.toThrow();
	});
});
