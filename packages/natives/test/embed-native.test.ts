import { describe, expect, it } from "@oh-my-pi/pi-utils/test-runtime";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { embeddedAddonFiles } from "../scripts/embed-native";
import packageJson from "../package.json" with { type: "json" };
import { type EmbeddedAddon, extractEmbeddedAddons } from "../native/loader-state.js";
import { bun } from "@oh-my-pi/pi-utils/node-runtime";

describe("native addon embedding", () => {
	for (const [label, contents] of [
		["a longer release stamp that starts with the expected version", `binaryPI_NATIVES_VERSION_STAMP:18.1.10\0\0`],
		["a longer legacy sentinel export that starts with the expected version", "binary__piNativesV18_1_10\0"],
		["an unstamped addon", `binaryPI_NATIVES_VERSION_STAMP:${"\0".repeat(39)}`],
	] as const) {
		it(`rejects ${label}`, async () => {
			const nativeDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-natives-embed-"));
			try {
				await bun.write(path.join(nativeDir, "pi_natives.win32-arm64.node"), contents);

				await expect(
					embeddedAddonFiles({ platform: "win32", arch: "arm64", nativeDir, version: "18.1.1" }),
				).rejects.toThrow("does not carry the @oh-my-pi/pi-natives@18.1.1 version stamp");
			} finally {
				await fs.rm(nativeDir, { recursive: true, force: true });
			}
		});
	}

	it("embeds identical addon bytes identically", async () => {
		const nativeDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-natives-embed-"));
		try {
			const stamp = "PI_NATIVES_VERSION_STAMP:18.1.1\0";
			await bun.write(path.join(nativeDir, "pi_natives.linux-x64-modern.node"), `modern ${stamp}`.repeat(64));
			await bun.write(path.join(nativeDir, "pi_natives.linux-x64-baseline.node"), `baseline ${stamp}`.repeat(64));
			const first = await embeddedAddonFiles({ platform: "linux", arch: "x64", nativeDir, version: "18.1.1" });
			// Distinct mtimes must not leak into the embedded bytes.
			await fs.utimes(path.join(nativeDir, "pi_natives.linux-x64-modern.node"), 1, 1);
			const second = await embeddedAddonFiles({ platform: "linux", arch: "x64", nativeDir, version: "18.1.1" });

			expect(Object.keys(first).map(key => path.basename(key))).toEqual([
				"pi_natives.linux-x64-modern.node.zst",
				"pi_natives.linux-x64-baseline.node.zst",
				"embedded-addon.js",
			]);
			expect(second).toEqual(first);
		} finally {
			await fs.rm(nativeDir, { recursive: true, force: true });
		}
	});

	it("emits a manifest whose zstd frames the loader extracts back to the addon", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-natives-embed-"));
		const nativeDir = path.join(root, "native");
		const outDir = path.join(root, "out");
		const cacheDir = path.join(root, "cache");
		// A pre-stamp addon whose legacy sentinel matches the version (the loader accepts it).
		const addon = "binary__piNativesV18_1_1\0";
		try {
			await bun.write(path.join(nativeDir, "pi_natives.win32-arm64.node"), addon);
			await fs.mkdir(cacheDir);
			const files = await embeddedAddonFiles({ platform: "win32", arch: "arm64", nativeDir, version: "18.1.1" });
			await fs.mkdir(outDir, { recursive: true });
			const manifestPath = path.join(await fs.realpath(outDir), "embedded-addon.js");
			for (const filePath in files) {
				await bun.write(path.join(outDir, path.basename(filePath)), files[filePath]);
			}
			const rawManifest = files[path.join(await fs.realpath(nativeDir), "embedded-addon.js")];
			if (typeof rawManifest !== "string") throw new Error("embed step did not emit an embedded-addon manifest");
			// Node has no `with { type: "file" }`; hand the manifest the same absolute
			// frame path a bundler would pass, then load it by URL.
			const manifest = rawManifest.replace(
				/^import (zstdPath\d+) from "\.\/(.+?)" with \{ type: "file" \};$/gm,
				(_line, name: string, file: string) => `const ${name} = ${JSON.stringify(path.join(outDir, file))};`,
			);
			await bun.write(manifestPath, manifest);

			// Dynamic: the manifest under test is generated into a per-test temp dir.
			const { embeddedAddon }: { embeddedAddon: EmbeddedAddon } = await import(pathToFileURL(manifestPath).href);
			expect(embeddedAddon.platformTag).toBe("win32-arm64");
			expect(embeddedAddon.version).toBe("18.1.1");
			expect(embeddedAddon.files).toEqual([
				{
					variant: "default",
					filename: "pi_natives.win32-arm64.node",
					size: addon.length,
					zstdPath: path.join(await fs.realpath(outDir), "pi_natives.win32-arm64.node.zst"),
				},
			]);
			expect(extractEmbeddedAddons({ files: embeddedAddon.files, targetDir: cacheDir })).toEqual([
				path.join(cacheDir, "pi_natives.win32-arm64.node"),
			]);
			expect(await bun.file(path.join(cacheDir, "pi_natives.win32-arm64.node")).text()).toBe(addon);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it.skipIf(process.arch !== "x64")("extracts only the selected addon until the loader tries a fallback", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-natives-first-run-"));
		const addonDir = path.join(root, "addons");
		const packageDir = path.join(root, "package");
		const embeddedDir = path.join(packageDir, "embedded");
		const tag = `${process.platform}-${process.arch}`;
		try {
			for (const variant of ["modern", "baseline"]) {
				await bun.write(
					path.join(addonDir, `pi_natives.${tag}-${variant}.node`),
					`fake ${variant} PI_NATIVES_VERSION_STAMP:${packageJson.version}\0`,
				);
			}
			const embedded = await embeddedAddonFiles({
				platform: process.platform,
				arch: process.arch,
				nativeDir: addonDir,
				version: packageJson.version,
			});
			// Materialize the manifest the embed step would hand to the bundler. Bun's
			// `with { type: "file" }` imports have no Node equivalent, so the loader
			// receives the same absolute frame paths as plain consts instead.
			await fs.mkdir(embeddedDir, { recursive: true });
			const resolvedAddonDir = await fs.realpath(addonDir);
			for (const [file, contents] of Object.entries(embedded)) {
				const base = path.basename(file);
				if (base.endsWith(".zst")) await fs.writeFile(path.join(embeddedDir, base), contents);
			}
			const rawManifest = embedded[path.join(resolvedAddonDir, "embedded-addon.js")];
			if (typeof rawManifest !== "string") throw new Error("embed step did not emit an embedded-addon manifest");
			const manifest = rawManifest.replace(
				/^import (zstdPath\d+) from "\.\/(.+?)" with \{ type: "file" \};$/gm,
				(_line, name: string, file: string) =>
					`const ${name} = ${JSON.stringify(path.join(embeddedDir, file))};`,
			);
			await fs.mkdir(path.join(packageDir, "native"), { recursive: true });
			for (const file of ["loader-state.js", "version-sentinel.js"]) {
				await fs.copyFile(
					path.join(import.meta.dirname, "../native", file),
					path.join(packageDir, "native", file),
				);
			}
			await fs.copyFile(path.join(import.meta.dirname, "../package.json"), path.join(packageDir, "package.json"));
			await fs.writeFile(path.join(packageDir, "native", "embedded-addon.js"), manifest);

			const entry = path.join(packageDir, "entry.mjs");
			await fs.writeFile(
				entry,
				`import { loadNative } from "./native/loader-state.js";\ntry { loadNative(); } catch {}\n`,
			);

			for (const variant of ["baseline", "modern"]) {
				const cache = path.join(root, variant);
				const child = bun.spawn([process.execPath, entry], {
					env: { ...process.env, PI_NATIVES_DIR: cache, PI_NATIVE_VARIANT: variant },
					stdout: "ignore",
					stderr: "ignore",
				});
				expect(await child.exited).toBe(0);
				const extracted = (await fs.readdir(path.join(cache, packageJson.version)))
					.filter(filename => filename.endsWith(".node"))
					.sort();
				expect(extracted).toEqual(
					(variant === "modern"
						? [`pi_natives.${tag}-modern.node`, `pi_natives.${tag}-baseline.node`]
						: [`pi_natives.${tag}-baseline.node`]
					).sort(),
				);
			}
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
