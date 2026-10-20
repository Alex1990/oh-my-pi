import { describe, expect, test } from "@oh-my-pi/pi-utils/test-runtime";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import packageManifest from "../package.json" with { type: "json" };
import { fastembedRuntimeInstallPlan, prepareWindowsFastembedRuntime } from "../src/core/fastembed-runtime";
import { bun } from "@oh-my-pi/pi-utils/node-runtime";

// The fastembed peer is pinned as an exact version (not `catalog:`) because
// `core/fastembed-runtime.ts` reads it to `bun install` the on-demand embedding
// runtime — including from bundles where the inlined manifest would otherwise
// carry an uninstallable `catalog:` spec (#2389). The runtime cache must keep
// fastembed's own ORT dependency intact because its native addon links against
// that exact bundled library name (#3054).
describe("fastembed runtime version pins", () => {
	test("pins are exact installable versions, not catalog or range specs", () => {
		expect(packageManifest.peerDependencies.fastembed).toMatch(/^\d+\.\d+\.\d+$/);
		expect(packageManifest.peerDependencies["onnxruntime-node"]).toMatch(/^\d+\.\d+\.\d+$/);
	});

	test("runtime install preserves fastembed's transitive onnxruntime pin", () => {
		const plan = fastembedRuntimeInstallPlan();
		expect(plan.install.dependencies).toEqual({
			fastembed: packageManifest.peerDependencies.fastembed,
		});
		expect(plan.install.overrides?.["onnxruntime-node"]).toBeUndefined();
		expect(plan.install.trustedDependencies).toEqual(["onnxruntime-node"]);
		expect(plan.versionKey).toContain("transitive-ort");
		expect(plan.versionKey).not.toContain("forced-ort");
	});

	test("runtime install overrides tokenizers to a release with linux-arm64 bindings", () => {
		const plan = fastembedRuntimeInstallPlan();
		expect(plan.install.overrides).toEqual({ "@anush008/tokenizers": "0.6.0" });
		expect(plan.versionKey).toContain("tokenizers-0.6.0");
	});

	test("Windows preload selects fastembed's ORT DLL before inherited paths", async () => {
		const requireTest = createRequire(import.meta.url);
		const fastembedEntry = requireTest.resolve("fastembed");
		// Node honors `exports`, which (unlike Bun) hides `fastembed/package.json`;
		// walk up from the resolved entry to the package root instead.
		let fastembedPackageDir = path.dirname(fastembedEntry);
		for (;;) {
			const manifestPath = path.join(fastembedPackageDir, "package.json");
			if (existsSync(manifestPath) && JSON.parse(readFileSync(manifestPath, "utf8")).name === "fastembed") break;
			const parent = path.dirname(fastembedPackageDir);
			if (parent === fastembedPackageDir) throw new Error(`fastembed package root not found above ${fastembedEntry}`);
			fastembedPackageDir = parent;
		}
		const inheritedPath = ["/stale-ort", "/system"].join(path.delimiter);
		const env: NodeJS.ProcessEnv = { PATH: inheritedPath };
		const { ortEntry, ortPackageDir, dllDir } = await prepareWindowsFastembedRuntime({
			fastembedEntry,
			fastembedPackageDir,
			arch: "x64",
			env,
		});
		const ortManifest: { version?: unknown } = requireTest(path.join(ortPackageDir, "package.json"));

		expect(ortManifest.version).toBe(packageManifest.peerDependencies["onnxruntime-node"]);
		expect(ortEntry.startsWith(`${ortPackageDir}${path.sep}`)).toBe(true);
		expect(await bun.file(path.join(dllDir, "onnxruntime.dll")).exists()).toBe(true);
		expect(env.PATH).toBe(`${dllDir}${path.delimiter}${inheritedPath}`);
	});
});
