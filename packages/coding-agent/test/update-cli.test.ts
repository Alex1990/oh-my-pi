import { afterEach, describe, expect, it, type Mock, spyOn, vi } from "@oh-my-pi/pi-utils/test-runtime";
import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { BuildAnswer, Fetch } from "@oh-my-pi/pi-coding-agent/cli/build-service";
import * as pluginCli from "@oh-my-pi/pi-coding-agent/cli/plugin-cli";
import * as updateCli from "@oh-my-pi/pi-coding-agent/cli/update-cli";
import {
	buildMiseForceInstallArgs,
	buildMiseUpdateEnv,
	buildMiseUpgradeArgs,
	buildNpmInstallArgs,
	buildNpmUpdateEnv,
	buildPnpmInstallArgs,
	buildRenameCleanupPackages,
	downloadVerifiedBinary,
	type InstalledVersionVerification,
	managedInstallName,
	type ManagerUpdateSteps,
	migrateRenamedInstall,
	parseReportedVersion,
	parseUpdateArgs,
	type ReleaseInfo,
	type RenameMigrationSteps,
	replaceBinaryForUpdate,
	resolvePnpmGlobalNodeModulesDirFromLocations,
	resolveReleaseDist,
	resolveReleaseRename,
	resolveUpdateMethodForTest,
	resolveUpdateTargetFromPath,
	shouldForceBinaryUpdate,
	sweepStaleUpdateArtifacts,
	updateViaBinaryAt,
	updateViaManager,
	updateViaShimTakeover,
} from "@oh-my-pi/pi-coding-agent/cli/update-cli";
import Update from "@oh-my-pi/pi-coding-agent/commands/update";
import { $which, removeWithRetries } from "@oh-my-pi/pi-utils";
import type { CliConfig } from "@oh-my-pi/pi-utils/cli";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-tui/theme";
import { bun } from "@oh-my-pi/pi-utils/node-runtime";
import { serve } from "@oh-my-pi/pi-utils/node-serve";

const miseBinary = bun.env.MISE_BIN ?? $which("mise");
const npmBinary = $which("npm");

/**
 * npm before 11.10.0 has no `min-release-age` (npm/cli#8965) and ignores the
 * env key there, so the gated half of the resolution test below can only fail
 * on 11.10.0+. Probed synchronously because `it.skipIf` is evaluated while
 * the module loads.
 */
const npmSupportsReleaseAge = (() => {
	if (!npmBinary) return false;
	// Run from a neutral directory: inside an npm workspaces checkout the
	// config query exits with ENOWORKSPACES before it ever reads the key.
	const probe = bun.spawnSync([npmBinary, "config", "get", "min-release-age"], {
		cwd: os.tmpdir(),
		stdout: "pipe",
		stderr: "ignore",
	});
	return probe.exitCode === 0 && probe.stdout.toString().trim() !== "undefined";
})();

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
	const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-update-test-")));
	tempDirs.push(dir);
	return dir;
}
/**
 * Run `fn` with `process.platform` reporting `platform`. Launcher
 * classification and recovery hints are platform-gated, so the gate itself has
 * to be driven from whichever host runs this suite.
 */
function withPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
	const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
	if (!platformDescriptor) throw new Error("process.platform descriptor missing");
	Object.defineProperty(process, "platform", { ...platformDescriptor, value: platform });
	try {
		return fn();
	} finally {
		Object.defineProperty(process, "platform", platformDescriptor);
	}
}

/** Async {@link withPlatform}: keeps the override until the returned promise settles. */
async function withPlatformAsync<T>(platform: NodeJS.Platform, fn: () => Promise<T>): Promise<T> {
	const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
	if (!platformDescriptor) throw new Error("process.platform descriptor missing");
	Object.defineProperty(process, "platform", { ...platformDescriptor, value: platform });
	try {
		return await fn();
	} finally {
		Object.defineProperty(process, "platform", platformDescriptor);
	}
}

/** A checked release answer offering `content` as `version`. */
function buildAnswer(version: string, content: string | Uint8Array, overrides: Partial<BuildAnswer> = {}): BuildAnswer {
	return {
		version,
		tag: `v${version}`,
		file: { name: "oyp-linux-x64", size: Buffer.byteLength(content), sha256: bun.SHA256.hash(content, "hex") },
		download: "https://r2.test/oyp-linux-x64",
		...overrides,
	};
}

/** Fetch stand-in serving `body` at the build's whole-file download URL and nothing else. */
function serveDownload(build: BuildAnswer, body: string | Uint8Array): Fetch {
	return async input => {
		if (String(input) === build.download) return new Response(body);
		throw new Error(`Unexpected request: ${String(input)}`);
	};
}

/** npm's global layout: `<prefix>/bin` + `<prefix>/lib/node_modules` on POSIX; both rooted at `<prefix>` on Windows. */
function npmGlobalLayout(prefix: string): { binDir: string; nodeModulesDir: string } {
	return process.platform === "win32"
		? { binDir: prefix, nodeModulesDir: path.join(prefix, "node_modules") }
		: { binDir: path.join(prefix, "bin"), nodeModulesDir: path.join(prefix, "lib", "node_modules") };
}

afterEach(async () => {
	vi.restoreAllMocks();

	await Promise.all(tempDirs.splice(0).map(dir => removeWithRetries(dir)));
});
const TEST_CONFIG: CliConfig = {
	bin: "oyp",
	version: "0.0.0-test",
	commands: new Map(),
};

describe("update command plugin dispatch", () => {
	it("routes -l to plugin upgrade instead of the app updater", async () => {
		const pluginSpy = spyOn(pluginCli, "runPluginCommand").mockResolvedValue(undefined);
		const updateSpy = spyOn(updateCli, "runUpdateCommand").mockResolvedValue(undefined);

		const command = new Update(["-l"], TEST_CONFIG);
		await command.run();

		expect(pluginSpy).toHaveBeenCalledWith({ action: "upgrade", args: [], flags: {} });
		expect(updateSpy).not.toHaveBeenCalled();
	});

	it("keeps normal update flags on the app updater path", async () => {
		const pluginSpy = spyOn(pluginCli, "runPluginCommand").mockResolvedValue(undefined);
		const updateSpy = spyOn(updateCli, "runUpdateCommand").mockResolvedValue(undefined);

		const command = new Update(["--check", "--force"], TEST_CONFIG);
		await command.run();

		expect(updateSpy).toHaveBeenCalledWith({ force: true, check: true, channel: undefined });
		expect(pluginSpy).not.toHaveBeenCalled();
	});
});

describe("parseUpdateArgs", () => {
	it("preserves the legacy plugin update shorthand", () => {
		expect(parseUpdateArgs(["update", "-l"])).toEqual({
			force: false,
			check: false,
			plugins: true,
			channel: undefined,
		});
	});

	it("parses update channels", () => {
		expect(parseUpdateArgs(["update", "--canary"])?.channel).toBe("canary");
		expect(parseUpdateArgs(["update", "--stable"])?.channel).toBe("stable");
		expect(parseUpdateArgs(["update"])?.channel).toBeUndefined();
	});

	it("rejects conflicting update channels", () => {
		expect(() => parseUpdateArgs(["update", "--canary", "--stable"])).toThrow(
			"--canary and --stable are mutually exclusive",
		);
	});
});
describe("parseReportedVersion", () => {
	it("preserves the prerelease suffix so a canary launcher verifies as up to date", () => {
		// Regression: dropping `-canary.1` made a correctly installed canary
		// build look like a stale `X.Y.Z` launcher, triggering a needless
		// binary repair.
		expect(parseReportedVersion("oyp/18.0.6-canary.1")).toBe("18.0.6-canary.1");
		expect(parseReportedVersion("oyp/18.0.5")).toBe("18.0.5");
		expect(parseReportedVersion("not a version")).toBeUndefined();
	});

	it("rejects version output from a different executable", () => {
		expect(parseReportedVersion("node/18.0.5")).toBeUndefined();
		expect(parseReportedVersion("codex/18.0.5")).toBeUndefined();
	});
});

describe("update-cli install target detection", () => {
	it("leaves Nix store installations under Nix management", () => {
		const method = resolveUpdateMethodForTest(
			"/nix/store/0123456789-omp-17.2.15/bin/oyp",
			"/nix/store/9876543210-pnpm-10.18.0/bin",
		);

		expect(method).toBe("nix");
	});

	it("uses pnpm update when prioritized oyp is inside pnpm global bin", () => {
		const method = resolveUpdateMethodForTest("/Users/test/.local/share/pnpm/oyp", "/Users/test/.local/share/pnpm");

		expect(method).toBe("pnpm");
	});

	it("uses npm update when prioritized oyp is inside an npm global bin", () => {
		const method = resolveUpdateMethodForTest("/Users/test/.npm-global/bin/oyp", undefined, {
			npmBinDir: "/Users/test/.npm-global/bin",
		});

		expect(method).toBe("npm");
	});

	it("uses npm update for Windows npm command shims even when no package-manager bin dirs were detected", () => {
		const method = resolveUpdateMethodForTest("C:\\Users\\test\\AppData\\Roaming\\npm\\oyp.cmd", undefined);

		expect(method).toBe("npm");
	});

	it("uses binary update when a plain file in the npm global bin dir is the standalone binary, not an npm symlink", () => {
		// Regression: with `npm prefix -g` pointed at the installer's default
		// (~/.local), directory containment alone misclassified the standalone
		// binary as npm-managed, so `npm install -g` failed with EEXIST refusing
		// to overwrite the existing executable. POSIX layout: on Windows an
		// extensionless launcher is npm's sh shim (covered by the win32 cases).
		const method = withPlatform("linux", () =>
			resolveUpdateMethodForTest("/home/u/.local/bin/oyp", undefined, {
				npmBinDir: "/home/u/.local/bin",
				ompIsRegularFile: true,
			}),
		);

		expect(method).toBe("binary");
	});

	it("uses binary update when a plain file in the pnpm global bin dir is the standalone binary", () => {
		const method = withPlatform("linux", () =>
			resolveUpdateMethodForTest("/home/u/.local/bin/oyp", "/home/u/.local/bin", {
				ompIsRegularFile: true,
			}),
		);

		expect(method).toBe("binary");
	});

	it("keeps pnpm update for Windows script shims in the pnpm global bin dir", () => {
		// On Windows a pnpm-managed global install is a regular-file
		// `oyp.cmd`/`oyp.ps1`/`oyp` shim, not a symlink, so the
		// standalone-binary override cannot key off file type. Paths use forward
		// slashes so the lexical containment check works on the POSIX host
		// running this suite.
		const method = withPlatform("win32", () =>
			resolveUpdateMethodForTest("C:/Users/test/pnpm/oyp.cmd", "C:/Users/test/pnpm", {
				ompIsRegularFile: true,
			}),
		);

		expect(method).toBe("pnpm");
	});

	it("uses binary update for a Windows .exe in the pnpm global bin dir, which pnpm never writes", () => {
		// Regression: a binary-only release replaces pnpm's shims with the
		// standalone `oyp.exe`. Classifying that by directory alone sent the next
		// update back through `pnpm add -g`, which cannot overwrite the running
		// `.exe`, so the install stayed pinned to the old version with no way
		// forward.
		const method = withPlatform("win32", () =>
			resolveUpdateMethodForTest("C:/Users/test/pnpm/oyp.exe", "C:/Users/test/pnpm", {
				ompIsRegularFile: true,
			}),
		);

		expect(method).toBe("binary");
	});

	it("still uses npm update when the npm global bin entry is a package-manager symlink, not a plain file", () => {
		const method = resolveUpdateMethodForTest("/home/u/.local/bin/oyp", undefined, {
			npmBinDir: "/home/u/.local/bin",
			ompIsRegularFile: false,
		});

		expect(method).toBe("npm");
	});

	it("updates the standalone binary behind a foreign npm-bin alias without replacing the alias", async () => {
		const dir = await makeTempDir();
		const npmBinDir = path.join(dir, ".npm-global", "bin");
		const standalonePath = path.join(dir, ".local", "bin", "oyp");
		const aliasPath = path.join(npmBinDir, "oyp");
		await fs.mkdir(npmBinDir, { recursive: true });
		await bun.write(standalonePath, "binary");
		await fs.symlink(standalonePath, aliasPath);

		const target = resolveUpdateTargetFromPath(aliasPath, undefined, {
			allowPackageManagers: true,
			npmBinDir,
		});

		expect(target).toEqual({
			method: "binary",
			path: standalonePath,
			replacesSymlink: false,
			validateExistingTarget: true,
		});
		expect(await fs.readlink(aliasPath)).toBe(standalonePath);
	});

	it("keeps an npm-linked checkout under npm management instead of overwriting its resolved script", async () => {
		const dir = await makeTempDir();
		const npmPrefix = path.join(dir, ".npm-global");
		const { binDir: npmBinDir, nodeModulesDir } = npmGlobalLayout(npmPrefix);
		const packagePath = path.join(nodeModulesDir, "@oh-my-pi", "pi-coding-agent");
		const checkoutPath = path.join(dir, "checkout");
		const checkoutCli = path.join(checkoutPath, "dist", "cli.js");
		const aliasPath = path.join(npmBinDir, "oyp");
		await fs.mkdir(npmBinDir, { recursive: true });
		await fs.mkdir(path.dirname(packagePath), { recursive: true });
		await bun.write(checkoutCli, "linked checkout");
		await fs.symlink(checkoutPath, packagePath, "junction");
		await fs.symlink(path.relative(npmBinDir, path.join(packagePath, "dist", "cli.js")), aliasPath);

		const target = resolveUpdateTargetFromPath(aliasPath, undefined, {
			allowPackageManagers: true,
			npmBinDir,
		});

		expect(await fs.realpath(aliasPath)).toBe(checkoutCli);
		expect(target).toEqual({ method: "npm", path: aliasPath });
		expect(await bun.file(checkoutCli).text()).toBe("linked checkout");
	});

	it("treats a pnpm-bin alias into a custom directory as foreign", async () => {
		const dir = await makeTempDir();
		const pnpmBinDir = path.join(dir, "pnpm");
		const standalonePath = path.join(dir, "pnpm-custom", "oyp");
		const aliasPath = path.join(pnpmBinDir, "oyp");
		await fs.mkdir(pnpmBinDir, { recursive: true });
		await bun.write(standalonePath, "binary");
		await fs.symlink(path.relative(pnpmBinDir, standalonePath), aliasPath);

		const target = resolveUpdateTargetFromPath(aliasPath, pnpmBinDir, {
			allowPackageManagers: true,
		});

		expect(target).toEqual({
			method: "binary",
			path: standalonePath,
			replacesSymlink: false,
			validateExistingTarget: true,
		});
	});

	it("resolves a foreign symlink to its real binary on a binary-only release instead of clobbering the launcher", async () => {
		// Admin shared-install layout: a non-manager symlink in PATH points into
		// a shared install dir. On a binary-only release the target must still be
		// the resolved binary, not the launcher — otherwise the update writes
		// beside a root-owned symlink (EACCES) or replaces it with a split-brain
		// copy that shadows the shared install (#8732).
		const dir = await makeTempDir();
		const sharedBinDir = path.join(dir, "opt", "oyp", "bin");
		const standalonePath = path.join(sharedBinDir, "oyp");
		const launcherDir = path.join(dir, "usr", "local", "bin");
		const launcherPath = path.join(launcherDir, "oyp");
		await fs.mkdir(sharedBinDir, { recursive: true });
		await fs.mkdir(launcherDir, { recursive: true });
		await bun.write(standalonePath, "binary");
		await fs.symlink(standalonePath, launcherPath);

		const target = resolveUpdateTargetFromPath(launcherPath, undefined, {
			allowPackageManagers: false,
		});

		expect(target).toEqual({
			method: "binary",
			path: standalonePath,
			replacesSymlink: false,
			validateExistingTarget: true,
		});
		expect(await fs.readlink(launcherPath)).toBe(standalonePath);
	});

	it.skipIf(process.platform === "win32")(
		"refuses to overwrite a shared shebang dispatcher behind a foreign symlink",
		async () => {
			const dir = await makeTempDir();
			const dispatcherPath = path.join(dir, "launch");
			const aliasPath = path.join(dir, "oyp");
			const dispatcher = "#!/bin/sh\necho dispatcher\n";
			await bun.write(dispatcherPath, dispatcher);
			await fs.chmod(dispatcherPath, 0o755);
			await fs.symlink("launch", aliasPath);
			const fetchImpl = vi.fn(async () => new Response());

			const target = resolveUpdateTargetFromPath(aliasPath, undefined, {
				allowPackageManagers: true,
			});
			if (target.method !== "binary") throw new Error("Expected binary update target");

			await expect(
				updateViaBinaryAt(target.path, buildAnswer("18.1.13", "new binary"), {
					fetchImpl,
					validateExistingTarget: target.validateExistingTarget,
				}),
			).rejects.toThrow(`Refusing to replace ${dispatcherPath}`);
			expect(fetchImpl).not.toHaveBeenCalled();
			expect(await bun.file(dispatcherPath).text()).toBe(dispatcher);
		},
	);

	it.skipIf(process.platform === "win32")(
		"refuses a foreign native target that does not report an OMP version",
		async () => {
			const dir = await makeTempDir();
			const foreignPath = path.join(dir, "foreign");
			const aliasPath = path.join(dir, "oyp");
			await fs.copyFile(process.execPath, foreignPath);
			await fs.chmod(foreignPath, 0o755);
			await fs.symlink(foreignPath, aliasPath);
			const fetchImpl = vi.fn(async () => new Response());
			const target = resolveUpdateTargetFromPath(aliasPath, undefined, {
				allowPackageManagers: true,
			});
			if (target.method !== "binary") throw new Error("Expected binary update target");

			await expect(
				updateViaBinaryAt(target.path, buildAnswer("18.1.13", "new binary"), {
					fetchImpl,
					validateExistingTarget: target.validateExistingTarget,
				}),
			).rejects.toThrow("does not report an OMP version when run directly");
			expect(fetchImpl).not.toHaveBeenCalled();
		},
	);

	it("takes over a package-manager launcher in place on a binary-only release", async () => {
		// A pnpm/npm-managed launcher symlinks into the manager's node_modules.
		// A forced binary release cannot route through the manager, so the
		// launcher is deliberately replaced in place, keeping the PATH entry live.
		const dir = await makeTempDir();
		const npmPrefix = path.join(dir, ".npm-global");
		const { binDir: npmBinDir, nodeModulesDir } = npmGlobalLayout(npmPrefix);
		const managedBinary = path.join(nodeModulesDir, "@oh-my-pi", "pi-coding-agent", "oyp");
		const aliasPath = path.join(npmBinDir, "oyp");
		await fs.mkdir(npmBinDir, { recursive: true });
		await fs.mkdir(path.dirname(managedBinary), { recursive: true });
		await bun.write(managedBinary, "binary");
		await fs.symlink(managedBinary, aliasPath);

		const target = resolveUpdateTargetFromPath(aliasPath, undefined, {
			allowPackageManagers: false,
			npmBinDir,
		});

		expect(target).toEqual({
			method: "binary",
			path: aliasPath,
			replacesSymlink: true,
			validateExistingTarget: false,
		});
	});

	it("keeps a split-root pnpm-linked checkout under pnpm management instead of overwriting its script", async () => {
		const dir = await makeTempDir();
		const pnpmBinDir = path.join(dir, "pnpm");
		const pnpmGlobalDir = path.join(dir, "pnpm-global", "global", "5", "node_modules");
		const packagePath = path.join(pnpmGlobalDir, "@oh-my-pi", "pi-coding-agent");
		const checkoutPath = path.join(dir, "checkout");
		const checkoutCli = path.join(checkoutPath, "dist", "cli.js");
		const aliasPath = path.join(pnpmBinDir, "oyp");
		await fs.mkdir(pnpmBinDir, { recursive: true });
		await fs.mkdir(path.dirname(packagePath), { recursive: true });
		await bun.write(checkoutCli, "linked checkout");
		await fs.symlink(checkoutPath, packagePath, "junction");
		await fs.symlink(path.relative(pnpmBinDir, path.join(packagePath, "dist", "cli.js")), aliasPath);

		const target = resolveUpdateTargetFromPath(aliasPath, pnpmBinDir, {
			allowPackageManagers: true,
			pnpmGlobalDir,
		});

		expect(await fs.realpath(aliasPath)).toBe(checkoutCli);
		expect(target).toEqual({ method: "pnpm", path: aliasPath });
		expect(await bun.file(checkoutCli).text()).toBe("linked checkout");
	});

	it("uses binary update when prioritized oyp is outside pnpm global bin", () => {
		const method = resolveUpdateMethodForTest("/Users/test/.local/bin/oyp", "/Users/test/.local/share/pnpm");

		expect(method).toBe("binary");
	});

	it("uses binary update when pnpm global bin cannot be resolved", () => {
		const method = resolveUpdateMethodForTest("/Users/test/.local/bin/oyp", undefined);

		expect(method).toBe("binary");
	});

	it("uses mise update when prioritized oyp is in an active mise bin path", () => {
		const method = resolveUpdateMethodForTest(
			"/Users/test/.local/share/mise/installs/github-can1357-oh-my-pi/latest/bin/oyp",
			undefined,
			{
				miseBinDirs: ["/Users/test/.local/share/mise/installs/github-can1357-oh-my-pi/latest/bin"],
			},
		);

		expect(method).toBe("mise");
	});

	it("uses mise update when prioritized oyp is a mise shim", () => {
		const method = resolveUpdateMethodForTest("/Users/test/.local/share/mise/shims/oyp", undefined, {
			miseDataDir: "/Users/test/.local/share/mise",
		});

		expect(method).toBe("mise");
	});
});

describe("update-cli package manager commands", () => {
	it("targets the mise GitHub backend and overrides release-age settings for attended updates", () => {
		expect(buildMiseUpgradeArgs()).toEqual(["upgrade", "github:Alex1990/oh-my-pi", "--bump", "--before", "0s"]);
		expect(buildMiseUpgradeArgs(false)).toEqual(["upgrade", "github:Alex1990/oh-my-pi", "--bump"]);
		expect(buildMiseUpdateEnv({ PATH: "/bin", MISE_MINIMUM_RELEASE_AGE: "24h" })).toEqual({
			PATH: "/bin",
			MISE_MINIMUM_RELEASE_AGE: "0s",
		});
		expect(buildMiseForceInstallArgs("15.10.5")).toEqual(["install", "--force", "github:Alex1990/oh-my-pi@15.10.5"]);
	});

	it.skipIf(!miseBinary)("overrides per-tool release age during actual mise upgrade resolution", async () => {
		if (!miseBinary) throw new Error("mise binary unavailable");
		const root = await makeTempDir();
		const releases = [
			{ tag_name: "v2.0.0", draft: false, prerelease: false, created_at: "2026-09-09T00:00:00Z", assets: [] },
			{ tag_name: "v1.0.0", draft: false, prerelease: false, created_at: "2020-01-01T00:00:00Z", assets: [] },
		];
		const server = await serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				const pathname = new URL(request.url).pathname;
				if (pathname.endsWith("/releases/latest")) return Response.json(releases[0]);
				if (pathname.endsWith("/releases")) return Response.json(releases);
				return new Response("not found", { status: 404 });
			},
		});
		try {
			await bun.write(
				path.join(root, "mise.toml"),
				`[tools]
"github:Alex1990/oh-my-pi" = { version = "1", minimum_release_age = "999y", api_url = "${server.url}" }
`,
			);
			const env = {
				...process.env,
				HOME: path.join(root, "home"),
				MISE_CACHE_DIR: path.join(root, "cache"),
				MISE_CONFIG_DIR: path.join(root, "config"),
				MISE_DATA_DIR: path.join(root, "data"),
				MISE_STATE_DIR: path.join(root, "state"),
				HTTP_PROXY: "http://127.0.0.1:9",
				HTTPS_PROXY: "http://127.0.0.1:9",
				ALL_PROXY: "http://127.0.0.1:9",
				NO_PROXY: "127.0.0.1,localhost",
			};
			const run = async (args: string[]): Promise<string> => {
				const process = bun.spawn([miseBinary, "-C", root, ...args], {
					env,
					stdin: "ignore",
					stdout: "pipe",
					stderr: "pipe",
				});
				const [stdout, stderr, exitCode] = await Promise.all([
					new Response(process.stdout).text(),
					new Response(process.stderr).text(),
					process.exited,
				]);
				if (exitCode !== 0) throw new Error(`mise upgrade failed: ${stdout}${stderr}`);
				return stdout + stderr;
			};

			const blocked = await run(["upgrade", "github:Alex1990/oh-my-pi", "--bump", "--dry-run"]);
			expect(blocked).not.toContain("Would install github:Alex1990/oh-my-pi@2.0.0");

			const allowed = await run([...buildMiseUpgradeArgs(), "--dry-run"]);
			expect(allowed).toContain("Would install github:Alex1990/oh-my-pi@2.0.0");
		} finally {
			server.stop(true);
		}
	});

	it("pins npm package installs to the official registry and the checked native package versions", () => {
		const args = buildNpmInstallArgs("16.3.15", "win32-x64");

		expect(args.slice(0, 2)).toEqual(["install", "-g"]);
		expect(args).toContain("--registry=https://registry.npmjs.org/");
		expect(args).toContain("@oh-my-pi/pi-coding-agent@16.3.15");
		expect(args).toContain("@oh-my-pi/pi-natives@16.3.15");
		expect(args).toContain("@oh-my-pi/pi-natives-win32-x64@16.3.15");
	});

	it("pins pnpm package installs to the official registry and the checked native package versions", () => {
		// pnpm's global install reads its settings from the ambient
		// workspace/`.npmrc`, so the cooldown override has to ride on the argv;
		// there is no metadata snapshot to bypass either.
		const args = buildPnpmInstallArgs("16.3.15", "win32-x64");

		expect(args.slice(0, 2)).toEqual(["add", "-g"]);
		expect(args).toContain("--config.minimumReleaseAge=0");
		expect(args).toContain("--registry=https://registry.npmjs.org/");
		expect(args).toContain("@oh-my-pi/pi-coding-agent@16.3.15");
		expect(args).toContain("@oh-my-pi/pi-natives@16.3.15");
		expect(args).toContain("@oh-my-pi/pi-natives-win32-x64@16.3.15");
	});

	it("overrides ambient npm release-age settings with the same key, never with before", () => {
		// npm 11.10-11.14 declared before and min-release-age mutually exclusive
		// across config sources and aborted with a TypeError when they met, so the
		// overlay must override min-release-age itself, not before.
		const env = buildNpmUpdateEnv({ PATH: "/bin", npm_config_min_release_age: "365" });

		expect(env.PATH).toBe("/bin");
		expect(env.npm_config_min_release_age).toBe("0");
		expect(Object.keys(env)).not.toContain("npm_config_before");

		// npm predating the feature must not even see the unknown env key.
		expect(buildNpmUpdateEnv({ PATH: "/bin" }, false)).toEqual({ PATH: "/bin" });
	});

	it.skipIf(!npmBinary || !npmSupportsReleaseAge)(
		"overrides ambient min-release-age during actual npm resolution",
		async () => {
			if (!npmBinary) throw new Error("npm binary unavailable");
			const root = await makeTempDir();
			const now = new Date().toISOString();
			const old = "2020-01-01T00:00:00.000Z";
			const version = (v: string) => ({
				name: "omp-age-gate-probe",
				version: v,
				dist: { tarball: "http://127.0.0.1/never-fetched.tgz" },
			});
			const packument = {
				name: "omp-age-gate-probe",
				"dist-tags": { latest: "2.0.0" },
				versions: { "1.0.0": version("1.0.0"), "2.0.0": version("2.0.0") },
				time: { created: old, modified: now, "1.0.0": old, "2.0.0": now },
			};
			const server = await serve({
				hostname: "127.0.0.1",
				port: 0,
				fetch(request) {
					const pathname = new URL(request.url).pathname;
					if (pathname.endsWith("/omp-age-gate-probe")) return Response.json(packument);
					return new Response("not found", { status: 404 });
				},
			});
			try {
				// The gate lives in an npmrc FILE, not env: the reported bug is
				// npmrc-sourced, and the fixed overlay beats it via cross-source
				// precedence (env outranks file). Same-source env would also mask
				// the before/min-release-age exclusivity abort on npm 11.10-11.14.
				const home = path.join(root, "home");
				await fs.mkdir(home, { recursive: true });
				await fs.mkdir(path.join(root, "prefix"), { recursive: true });
				await bun.write(path.join(home, ".npmrc"), "min-release-age=365\n");
				// Bogus proxies keep a corporate proxy from intercepting the loopback
				// registry; NO_PROXY exempts 127.0.0.1 so the fake registry stays reachable.
				const env: Record<string, string> = {
					PATH: process.env.PATH ?? "",
					HOME: home,
					// npm resolves the home npmrc from USERPROFILE and the global
					// prefix from APPDATA on Windows; pin both inside the sandbox.
					USERPROFILE: home,
					npm_config_prefix: path.join(root, "prefix"),
					npm_config_cache: path.join(root, "cache"),
					npm_config_audit: "false",
					npm_config_fund: "false",
					npm_config_update_notifier: "false",
					HTTP_PROXY: "http://127.0.0.1:9",
					HTTPS_PROXY: "http://127.0.0.1:9",
					ALL_PROXY: "http://127.0.0.1:9",
					NO_PROXY: "127.0.0.1,localhost",
				};
				const run = async (extraEnv: Record<string, string | undefined>) => {
					const proc = bun.spawn(
						[npmBinary, "install", "-g", "--dry-run", `--registry=${server.url}`, "omp-age-gate-probe@2.0.0"],
						{ env: { ...env, ...extraEnv }, cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
					);
					const [stdout, stderr, exitCode] = await Promise.all([
						new Response(proc.stdout).text(),
						new Response(proc.stderr).text(),
						proc.exited,
					]);
					return { out: stdout + stderr, exitCode };
				};

				const gated = await run({});
				expect(gated.exitCode).not.toBe(0);
				expect(gated.out).toMatch(/notarget|No matching version/i);

				const overlay = buildNpmUpdateEnv({});
				const allowed = await run(overlay);
				expect(allowed.exitCode).toBe(0);
				expect(allowed.out).toMatch(/add(ed)?\s+\S*omp-age-gate-probe\b[^\n]*2\.0\.0/);
			} finally {
				server.stop(true);
			}
		},
	);
});

describe("update-cli npm rename contract", () => {
	it("parses a well-formed omp.rename pointer and rejects malformed ones", () => {
		expect(resolveReleaseRename({ omp: { rename: { package: "@new/oyp", natives: "@new/natives" } } })).toEqual({
			pkg: "@new/oyp",
			natives: "@new/natives",
		});
		expect(resolveReleaseRename({ omp: { rename: { package: "@new/oyp" } } })).toEqual({
			pkg: "@new/oyp",
			natives: undefined,
		});
		expect(resolveReleaseRename({ omp: { rename: { package: "" } } })).toBeUndefined();
		expect(resolveReleaseRename({ omp: { rename: "@new/oyp" } })).toBeUndefined();
		expect(resolveReleaseRename({ omp: {} })).toBeUndefined();
		expect(resolveReleaseRename(undefined)).toBeUndefined();
	});

	it("installs renamed package names in lock-step, with no old-name leftovers in the argv", () => {
		const packages = { pkg: "@new/oyp", natives: "@new/natives" };

		const pnpmArgs = buildPnpmInstallArgs("17.0.0", "linux-x64", packages);
		expect(pnpmArgs).toContain("@new/oyp@17.0.0");
		expect(pnpmArgs).toContain("@new/natives@17.0.0");
		expect(pnpmArgs).toContain("@new/natives-linux-x64@17.0.0");
		expect(pnpmArgs.some(arg => arg.startsWith("@oh-my-pi/"))).toBe(false);

		expect(buildNpmInstallArgs("17.0.0", "linux-x64", packages)).toContain("@new/oyp@17.0.0");
	});

	it("adds --force to npm argv only for rename migrations so the old package's bin can be clobbered", () => {
		const packages = { pkg: "@new/oyp", natives: "@new/natives" };
		expect(buildNpmInstallArgs("17.0.0", "linux-x64", packages, { force: true })).toContain("--force");
		expect(buildNpmInstallArgs("16.3.15", "win32-x64")).not.toContain("--force");
	});

	it("removes the old agent package and its natives companions when both names moved", () => {
		const packages = { pkg: "@new/oyp", natives: "@new/natives" };
		expect(buildRenameCleanupPackages(packages, "darwin-arm64")).toEqual([
			"@oh-my-pi/pi-coding-agent",
			"@oh-my-pi/pi-natives",
			"@oh-my-pi/pi-natives-darwin-arm64",
		]);
		expect(buildRenameCleanupPackages(packages, "linux-arm")).toEqual([
			"@oh-my-pi/pi-coding-agent",
			"@oh-my-pi/pi-natives",
		]);
	});

	it("keeps the natives packages on an agent-only rename so cleanup cannot strip the addon the new install pinned", () => {
		const packages = { pkg: "@new/oyp", natives: "@oh-my-pi/pi-natives" };
		expect(buildRenameCleanupPackages(packages, "darwin-arm64")).toEqual(["@oh-my-pi/pi-coding-agent"]);
		expect(buildRenameCleanupPackages(packages, "linux-arm")).toEqual(["@oh-my-pi/pi-coding-agent"]);
	});
});

describe("migrateRenamedInstall transaction", () => {
	const release: ReleaseInfo = {
		tag: "v999.1.0",
		version: "999.1.0",
		packages: { pkg: "@new/oyp", natives: "@new/natives" },
		registry: "https://registry.npmjs.org/",
	};

	function scriptedSteps(script: { install: number[]; removeOld?: number; verify: boolean[] }): {
		steps: RenameMigrationSteps;
		calls: string[];
	} {
		const calls: string[] = [];
		let installs = 0;
		let verifies = 0;
		return {
			calls,
			steps: {
				async install() {
					calls.push("install");
					return script.install[installs++] ?? 0;
				},
				async removeOld() {
					calls.push("removeOld");
					return script.removeOld ?? 0;
				},
				async verify() {
					calls.push("verify");
					return script.verify[verifies++]
						? { ok: true, actual: "999.1.0", path: "/bin/oyp" }
						: { ok: false, path: "/bin/oyp" };
				},
			},
		};
	}

	it("never touches the old install when the new install fails", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		const { steps, calls } = scriptedSteps({ install: [1], verify: [] });

		await expect(migrateRenamedInstall(release, steps)).rejects.toThrow("left untouched");
		expect(calls).toEqual(["install"]);
	});

	it("installs the new package before removing the old one and verifies the result", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		const { steps, calls } = scriptedSteps({ install: [0], verify: [true] });

		await migrateRenamedInstall(release, steps);
		expect(calls).toEqual(["install", "removeOld", "verify"]);
	});

	it("restores the bin link by reinstalling when old-package removal breaks verification", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		const { steps, calls } = scriptedSteps({ install: [0, 0], verify: [false, true] });

		await migrateRenamedInstall(release, steps);
		expect(calls).toEqual(["install", "removeOld", "verify", "install", "verify"]);
	});

	it("treats old-package removal failure as a warning when the new install verifies", async () => {
		const logs: string[] = [];
		vi.spyOn(console, "log").mockImplementation(message => {
			logs.push(String(message));
		});
		const { steps, calls } = scriptedSteps({ install: [0], removeOld: 1, verify: [true] });

		await migrateRenamedInstall(release, steps);
		expect(calls).toEqual(["install", "removeOld", "verify"]);
		expect(logs.some(line => line.includes("could not remove the old"))).toBe(true);
	});

	it("aborts with a recovery hint when verification still fails after the restore install", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		const { steps, calls } = scriptedSteps({ install: [0, 0], verify: [false, false] });

		await withPlatformAsync("linux", async () => {
			await expect(migrateRenamedInstall(release, steps)).rejects.toThrow("curl -fsSL https://omp.sh/install");
		});
		expect(calls).toEqual(["install", "removeOld", "verify", "install", "verify"]);
	});

	it("uses the platform-aware PowerShell reinstall hint on Windows", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
		if (!platformDescriptor) throw new Error("process.platform descriptor missing");
		Object.defineProperty(process, "platform", { ...platformDescriptor, value: "win32" });
		try {
			const { steps } = scriptedSteps({ install: [0, 0], verify: [false, false] });
			const promise = migrateRenamedInstall(release, steps);
			await expect(promise).rejects.toThrow("irm https://omp.sh/install.ps1");
			await expect(promise).rejects.not.toThrow("| sh");
		} finally {
			Object.defineProperty(process, "platform", platformDescriptor);
		}
	});
});

describe("update-cli pnpm install command", () => {
	it("pins the official npm registry so a stale mirror cannot mask a freshly published version", () => {
		// Regression: omp queries https://registry.npmjs.org/<pkg>/latest directly.
		// The install MUST hit the same registry, otherwise a lagging mirror
		// (corp proxy, Taobao, …) rejects the version with
		// `No version matching "X" (but package exists)`. pnpm re-resolves
		// metadata on every invocation, so the registry pin is the whole fix.
		// See https://github.com/can1357/oh-my-pi/issues/1686.
		const args = buildPnpmInstallArgs("15.7.6", "linux-x64");
		expect(args.slice(0, 5)).toEqual([
			"add",
			"-g",
			"--config.minimumReleaseAge=0",
			"--registry=https://registry.npmjs.org/",
			"@oh-my-pi/pi-coding-agent@15.7.6",
		]);
	});

	it("pins the native addon core and the platform-specific leaf to the same version so the loader sentinel cannot drift on supported tags", () => {
		// Regression: pnpm add -g <pkg>@<v> would update only the top-level
		// package, leaving @oh-my-pi/pi-natives and @oh-my-pi/pi-natives-<tag>
		// at their previous version. The next launch then loaded a stale .node
		// file and aborted at validateLoadedBindings with `The .node file on
		// disk is from a different release than this loader`. See
		// https://github.com/can1357/oh-my-pi/issues/1824.
		for (const tag of ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64", "win32-x64", "win32-arm64"]) {
			const args = buildPnpmInstallArgs("15.9.0", tag);
			expect(args).toContain("@oh-my-pi/pi-natives@15.9.0");
			expect(args).toContain(`@oh-my-pi/pi-natives-${tag}@15.9.0`);
		}
	});

	it("omits the leaf on unsupported platform tags so an EBADPLATFORM swap does not mask the underlying `no matching version` error", () => {
		// Defensive: an unsupported tag (e.g. linux-arm32) still installs the
		// core natives package — which will fail at module load if the platform
		// truly is unsupported — but we never request a leaf the release
		// pipeline doesn't publish, otherwise pnpm aborts with EBADPLATFORM
		// and hides the real diagnostic from `loadNative`'s aggregated error.
		const args = buildPnpmInstallArgs("15.9.0", "linux-arm");
		expect(args).toContain("@oh-my-pi/pi-natives@15.9.0");
		expect(args.some(arg => arg.startsWith("@oh-my-pi/pi-natives-"))).toBe(false);
	});

	it("derives global node_modules from `pnpm root -g` or $PNPM_HOME, with the reported root taking precedence", () => {
		expect(
			resolvePnpmGlobalNodeModulesDirFromLocations({ globalHome: path.join("home", ".local", "share", "pnpm") }),
		).toBe(path.join("home", ".local", "share", "pnpm", "global", "5", "node_modules"));
		expect(
			resolvePnpmGlobalNodeModulesDirFromLocations({
				globalRoot: path.join("root", "pnpm-global", "global", "5", "node_modules"),
				globalHome: path.join("root", "pnpm"),
			}),
		).toBe(path.join("root", "pnpm-global", "global", "5", "node_modules"));
		expect(resolvePnpmGlobalNodeModulesDirFromLocations({})).toBeUndefined();
	});
});

describe("update-cli release binary integrity", () => {
	const binaryName = "oyp-linux-x64";
	const url = "https://r2.test/oyp-linux-x64";
	const content = "verified binary";
	const digest = `sha256:${bun.SHA256.hash(content, "hex")}`;

	it("writes a download only after its size and digest match", async () => {
		const dir = await makeTempDir();
		const targetPath = path.join(dir, binaryName);

		await downloadVerifiedBinary({
			url,
			targetPath,
			expectedSize: Buffer.byteLength(content),
			expectedDigest: digest,
			fetchImpl: async () => new Response(content),
		});

		expect(await bun.file(targetPath).text()).toBe(content);
		// Windows has no POSIX mode bits; the executable bit is only observable elsewhere.
		if (process.platform !== "win32") expect((await fs.stat(targetPath)).mode & 0o777).toBe(0o755);
	});

	it("aborts the response stream as soon as it exceeds the expected size", async () => {
		const dir = await makeTempDir();
		const targetPath = path.join(dir, binaryName);
		let pulls = 0;
		const body = new ReadableStream<Uint8Array>(
			{
				pull(controller) {
					pulls++;
					controller.enqueue(new Uint8Array(pulls === 1 ? 2 : 1));
					if (pulls === 2) controller.close();
				},
			},
			{ highWaterMark: 0 },
		);

		await expect(
			downloadVerifiedBinary({
				url,
				targetPath,
				expectedSize: 1,
				expectedDigest: digest,
				fetchImpl: async () => new Response(body),
			}),
		).rejects.toThrow("received at least 2");
		expect(pulls).toBe(1);
		expect(await bun.file(targetPath).exists()).toBe(false);
	});

	it("wraps a timeout during body streaming with a friendly message", async () => {
		const dir = await makeTempDir();
		const targetPath = path.join(dir, binaryName);
		const body = new ReadableStream<Uint8Array>(
			{
				pull(controller) {
					controller.enqueue(new Uint8Array(1));
					controller.error(new DOMException("The operation timed out.", "TimeoutError"));
				},
			},
			{ highWaterMark: 0 },
		);

		await expect(
			downloadVerifiedBinary({
				url,
				targetPath,
				expectedSize: Buffer.byteLength(content),
				expectedDigest: digest,
				fetchImpl: async () => new Response(body),
			}),
		).rejects.toThrow("Timed out downloading release binary after 15 minutes");
		expect(await bun.file(targetPath).exists()).toBe(false);
	});

	it("removes downloads whose size or digest does not match", async () => {
		const dir = await makeTempDir();
		const targetPath = path.join(dir, binaryName);
		const fetchImpl = async () => new Response(content);

		await expect(
			downloadVerifiedBinary({
				url,
				targetPath,
				expectedSize: Buffer.byteLength(content) + 1,
				expectedDigest: digest,
				fetchImpl,
			}),
		).rejects.toThrow("size mismatch");
		expect(await bun.file(targetPath).exists()).toBe(false);

		await expect(
			downloadVerifiedBinary({
				url,
				targetPath,
				expectedSize: Buffer.byteLength(content),
				expectedDigest: `sha256:${bun.SHA256.hash("different binary", "hex")}`,
				fetchImpl,
			}),
		).rejects.toThrow("digest mismatch");
		expect(await bun.file(targetPath).exists()).toBe(false);
	});

	it("rejects an altered whole-file download and leaves the installed binary in place", async () => {
		const dir = await makeTempDir();
		const targetPath = path.join(dir, binaryName);
		const installed = "#!/bin/sh\necho oyp/17.0.8\n";
		const altered = "#!/bin/sh\necho oyp/17.1.2\n";
		await bun.write(targetPath, installed);
		await fs.chmod(targetPath, 0o755);
		vi.spyOn(console, "log").mockImplementation(() => {});
		const build = buildAnswer("17.1.2", "x".repeat(Buffer.byteLength(altered)));

		await expect(updateViaBinaryAt(targetPath, build, { fetchImpl: serveDownload(build, altered) })).rejects.toThrow(
			"digest mismatch",
		);
		expect(await bun.file(targetPath).text()).toBe(installed);
		if (process.platform !== "win32") expect((await fs.stat(targetPath)).mode & 0o777).toBe(0o755);
		const newResidue = (await fs.readdir(dir)).filter(name => name.endsWith(".new"));
		expect(newResidue).toEqual([]);
	});
});

describe("update-cli binary replacement", () => {
	it("restores the previous binary when the replacement fails verification", async () => {
		const dir = await makeTempDir();
		const targetPath = path.join(dir, "oyp");
		const tempPath = `${targetPath}.new`;
		const backupPath = `${targetPath}.bak`;
		await bun.write(targetPath, "old binary");
		await bun.write(tempPath, "broken binary");

		await expect(
			replaceBinaryForUpdate({
				targetPath,
				tempPath,
				backupPath,
				expectedVersion: "15.1.8",
				verifyInstalledVersion: async () => ({ ok: false, path: targetPath }),
			}),
		).rejects.toThrow("restored previous oyp binary");

		expect(await bun.file(targetPath).text()).toBe("old binary");
		expect(await bun.file(tempPath).exists()).toBe(false);
		expect(await bun.file(backupPath).exists()).toBe(false);
	});

	it("keeps the replacement only after it reports the expected version", async () => {
		const dir = await makeTempDir();
		const targetPath = path.join(dir, "oyp");
		const tempPath = `${targetPath}.new`;
		const backupPath = `${targetPath}.bak`;
		await bun.write(targetPath, "old binary");
		await bun.write(tempPath, "new binary");

		await replaceBinaryForUpdate({
			targetPath,
			tempPath,
			backupPath,
			expectedVersion: "15.1.8",
			verifyInstalledVersion: async () => ({ ok: true, actual: "15.1.8", path: targetPath }),
		});

		expect(await bun.file(targetPath).text()).toBe("new binary");
		expect(await bun.file(tempPath).exists()).toBe(false);
		expect(await bun.file(backupPath).exists()).toBe(false);
	});
	it("installs at a vacated launcher path when the previous launcher is gone", async () => {
		// Repairing a launcher a failed package-manager reinstall deleted: there
		// is nothing to move aside, so the swap must still land instead of
		// aborting on ENOENT and leaving the user without a launcher.
		const dir = await makeTempDir();
		const targetPath = path.join(dir, "oyp");
		const tempPath = `${targetPath}.new`;
		const backupPath = `${targetPath}.bak`;
		await bun.write(tempPath, "new binary");

		const result = await replaceBinaryForUpdate({
			targetPath,
			tempPath,
			backupPath,
			expectedVersion: "15.1.8",
			verifyInstalledVersion: async () => ({ ok: true, actual: "15.1.8", path: targetPath }),
		});

		expect(result.ok).toBe(true);
		expect(await bun.file(targetPath).text()).toBe("new binary");
		expect(await bun.file(backupPath).exists()).toBe(false);
	});
});

describe("update-cli binary replacement on locked backups", () => {
	it("treats an EPERM on backup cleanup as a successful, completed update", async () => {
		// Regression: on Windows the binary moved aside during the swap is still
		// the running process image, so unlinking it throws EPERM. That cleanup
		// failure must not turn a verified swap into "Update failed" (issue #845).
		const dir = await makeTempDir();
		const targetPath = path.join(dir, "oyp.exe");
		const tempPath = `${targetPath}.new`;
		const backupPath = `${targetPath}.1700000000000.4242.bak`;
		await bun.write(targetPath, "old binary");
		await bun.write(tempPath, "new binary");

		const realUnlink = nodeFs.promises.unlink.bind(nodeFs.promises);
		const spy = spyOn(nodeFs.promises, "unlink").mockImplementation(async (p: nodeFs.PathLike) => {
			if (String(p) === backupPath) {
				const err = new Error(`EPERM: operation not permitted, unlink '${p}'`) as NodeJS.ErrnoException;
				err.code = "EPERM";
				throw err;
			}
			return realUnlink(p);
		});
		try {
			const result = await replaceBinaryForUpdate({
				targetPath,
				tempPath,
				backupPath,
				expectedVersion: "15.1.8",
				verifyInstalledVersion: async () => ({ ok: true, actual: "15.1.8", path: targetPath }),
			});
			expect(result.ok).toBe(true);
		} finally {
			spy.mockRestore();
		}

		// New binary is installed and the temp consumed even though the locked
		// backup survives; the next run's sweep reclaims it once it is unlocked.
		expect(await bun.file(targetPath).text()).toBe("new binary");
		expect(await bun.file(tempPath).exists()).toBe(false);
		expect(await bun.file(backupPath).text()).toBe("old binary");
	});
});

describe("update-cli stale update artifact sweep", () => {
	it("reclaims timestamped and legacy backups and orphaned temps while sparing in-progress temps and unrelated files", async () => {
		const dir = await makeTempDir();
		const targetPath = path.join(dir, "oyp.exe");
		await bun.write(targetPath, "current binary");
		await bun.write(`${targetPath}.bak`, "legacy backup");
		await bun.write(`${targetPath}.1700000000000.4242.bak`, "timestamped backup");
		await bun.write(`${targetPath}.1800000000000.99.bak`, "another backup");
		// Orphaned temp files from a hard-killed download: reaped once older than
		// the download window. Legacy fixed name and timestamped name both count.
		const stale = new Date(Date.now() - 60 * 60 * 1000);
		await bun.write(`${targetPath}.new`, "legacy temp");
		await fs.utimes(`${targetPath}.new`, stale, stale);
		await bun.write(`${targetPath}.1700000000000.4242.new`, "timestamped temp");
		await fs.utimes(`${targetPath}.1700000000000.4242.new`, stale, stale);
		await bun.write(`${targetPath}.1700000000000.4242.0.patch`, "orphaned patch");
		await fs.utimes(`${targetPath}.1700000000000.4242.0.patch`, stale, stale);
		// Must survive: a fresh temp or patch still belongs to a concurrent,
		// in-progress download (unique per attempt), plus foreign basenames,
		// non-numeric middle segments, and a bare `.patch` (never ours).
		await bun.write(`${targetPath}.9999999999999.7.new`, "in-progress temp");
		await bun.write(`${targetPath}.9999999999999.7.0.patch`, "in-progress patch");
		await bun.write(`${targetPath}.patch`, "the user's patch");
		await fs.utimes(`${targetPath}.patch`, stale, stale);
		await bun.write(path.join(dir, "notes.bak"), "keep me");
		await bun.write(`${targetPath}.config.bak`, "keep me too");
		await bun.write(`${targetPath}.config.new`, "keep me three");

		await sweepStaleUpdateArtifacts(targetPath);

		expect(await bun.file(targetPath).exists()).toBe(true);
		expect(await bun.file(`${targetPath}.bak`).exists()).toBe(false);
		expect(await bun.file(`${targetPath}.1700000000000.4242.bak`).exists()).toBe(false);
		expect(await bun.file(`${targetPath}.1800000000000.99.bak`).exists()).toBe(false);
		expect(await bun.file(`${targetPath}.new`).exists()).toBe(false);
		expect(await bun.file(`${targetPath}.1700000000000.4242.new`).exists()).toBe(false);
		expect(await bun.file(`${targetPath}.1700000000000.4242.0.patch`).exists()).toBe(false);
		expect(await bun.file(`${targetPath}.9999999999999.7.new`).exists()).toBe(true);
		expect(await bun.file(`${targetPath}.9999999999999.7.0.patch`).exists()).toBe(true);
		expect(await bun.file(`${targetPath}.patch`).exists()).toBe(true);
		expect(await bun.file(path.join(dir, "notes.bak")).exists()).toBe(true);
		expect(await bun.file(`${targetPath}.config.bak`).exists()).toBe(true);
		expect(await bun.file(`${targetPath}.config.new`).exists()).toBe(true);
	});
});

describe.skipIf(process.platform !== "darwin")("update-cli macOS live backup images", () => {
	// Regression for the macOS TCC image-path requirement: a `.bak` is the
	// previous executable and another process may still be running it, so it
	// must survive both the immediate post-swap cleanup and later sweeps until
	// its image exits, then be reclaimable. `process.execPath` under `bun
	// test` is the bun runtime — a real Mach-O whose copy can be held live.
	// (Copies of Apple trust-cache binaries like /bin/sleep are SIGKILLed by
	// macOS when executed from a new path, so they cannot serve here.)
	it("retains a backup whose image a live process runs across cleanup and sweep, then reclaims it after the process exits", async () => {
		const dir = await makeTempDir();
		const targetPath = path.join(dir, "oyp");
		await fs.copyFile(process.execPath, targetPath);
		const live = bun.spawn([targetPath, "-e", "await bun.sleep(30000)"], { stdout: "ignore", stderr: "ignore" });
		try {
			// Real-time waits, not fake timers: these wait on genuine kernel and
			// process state (lsof visibility of the live image, vnode release
			// after exit) that no in-test clock controls.
			// The image must actually be live and visible to lsof, or the
			// retention assertions below would pass for the wrong reason.
			let liveImageVisible = false;
			for (let i = 0; i < 20 && !liveImageVisible; i++) {
				const seen = bun.spawnSync(["/usr/sbin/lsof", "-t", "--", targetPath]);
				liveImageVisible = seen.exitCode === 0 && seen.stdout.toString().includes(String(live.pid));
				if (!liveImageVisible) await bun.sleep(100);
			}
			expect(liveImageVisible).toBe(true);

			const attempt = "1700000000000.4242";
			const tempPath = `${targetPath}.${attempt}.new`;
			const backupPath = `${targetPath}.${attempt}.bak`;
			await bun.write(tempPath, "new binary");

			const result = await replaceBinaryForUpdate({
				targetPath,
				tempPath,
				backupPath,
				expectedVersion: "15.1.8",
				verifyInstalledVersion: async () => ({ ok: true, actual: "15.1.8", path: targetPath }),
			});
			expect(result.ok).toBe(true);
			// The swap landed and the temp was consumed, but the live image's
			// backup must remain on disk.
			expect(await bun.file(targetPath).text()).toBe("new binary");
			expect(await bun.file(tempPath).exists()).toBe(false);
			expect(await bun.file(backupPath).exists()).toBe(true);

			// A later sweep must spare it too.
			await sweepStaleUpdateArtifacts(targetPath);
			expect(await bun.file(backupPath).exists()).toBe(true);

			live.kill();
			await live.exited;

			// Once the image is gone, the backup is reclaimable.
			for (let i = 0; i < 20 && (await bun.file(backupPath).exists()); i++) {
				await sweepStaleUpdateArtifacts(targetPath);
				await bun.sleep(100);
			}
			expect(await bun.file(backupPath).exists()).toBe(false);
		} finally {
			live.kill();
			await live.exited;
		}
	});
});

describe("update-cli binary-only release gating", () => {
	it("honors an explicit omp.dist field from the registry manifest", () => {
		expect(resolveReleaseDist({ omp: { dist: "binary" } })).toBe("binary");
		expect(resolveReleaseDist({ omp: { dist: "npm" } })).toBe("npm");
	});

	it("treats unknown dist values as binary-only", () => {
		expect(resolveReleaseDist({ omp: { dist: "cargo" } })).toBe("binary");
	});

	it("returns undefined when the manifest carries no dist field", () => {
		expect(resolveReleaseDist({ version: "1.2.3" })).toBeUndefined();
		expect(resolveReleaseDist({ omp: {} })).toBeUndefined();
		expect(resolveReleaseDist(undefined)).toBeUndefined();
	});

	it("forces binary updates when dist is binary regardless of version", () => {
		expect(shouldForceBinaryUpdate({ version: "1.2.3", dist: "binary" }, "1.2.2")).toBe(true);
	});

	it("allows package-manager updates across majors when dist is explicitly npm", () => {
		expect(shouldForceBinaryUpdate({ version: "2.0.0", dist: "npm" }, "1.9.0")).toBe(false);
	});

	it("forces binary updates on a major bump without a dist field", () => {
		expect(shouldForceBinaryUpdate({ version: "2.0.0" }, "1.9.0")).toBe(true);
		expect(shouldForceBinaryUpdate({ version: "2.0.0-rc.1" }, "1.9.0")).toBe(true);
	});

	it("keeps package-manager updates within the same major and on downgrades", () => {
		expect(shouldForceBinaryUpdate({ version: "1.10.0" }, "1.9.0")).toBe(false);
		expect(shouldForceBinaryUpdate({ version: "1.0.0" }, "2.0.0")).toBe(false);
	});
});

describe("update-cli script-shim takeover", () => {
	const version = "18.0.0";

	/** The build answer offering `content` plus a fetch serving it. */
	function offer(content: string): { build: BuildAnswer; fetchImpl: Fetch } {
		const build = buildAnswer(version, content);
		return { build, fetchImpl: serveDownload(build, content) };
	}

	const shims: Record<string, string> = {
		oyp: "#!/bin/sh\nnode oyp.js\n",
		"oyp.cmd": "@node oyp.js %*\n",
		"oyp.ps1": "node oyp.js @args\n",
	};

	async function writeShims(dir: string): Promise<void> {
		for (const name in shims) {
			await bun.write(path.join(dir, name), shims[name]);
		}
	}

	/**
	 * The fake release binaries are `#!/bin/sh` scripts, which Windows cannot
	 * launch as `oyp.exe`. There, "run" the explicit path the takeover verifies
	 * by reading the version the script echoes; POSIX hosts execute it for real.
	 */
	const verifyBinary =
		process.platform === "win32"
			? async (binaryPath: string, expectedVersion: string): Promise<InstalledVersionVerification> => {
					const script = await bun.file(binaryPath).text();
					const actual = parseReportedVersion(script.match(/^echo (.+)$/m)?.[1] ?? "");
					return { ok: actual === expectedVersion, actual, path: binaryPath };
				}
			: undefined;

	it("installs oyp.exe beside the shims and retires them", async () => {
		const dir = await makeTempDir();
		await writeShims(dir);
		// Real executable, no injected verifier: the takeover must verify the
		// exe by explicit path — $which cached the shim path before it was
		// renamed away, so a PATH re-resolution would fail here.
		const exe = `#!/bin/sh\necho oyp/${version}\n`;

		const { build, fetchImpl } = offer(exe);

		await updateViaShimTakeover(path.join(dir, "oyp.cmd"), build, { fetchImpl, verifyBinary });

		expect(await bun.file(path.join(dir, "oyp.exe")).text()).toBe(exe);
		for (const name in shims) {
			expect(await bun.file(path.join(dir, name)).exists()).toBe(false);
		}
		const residue = (await fs.readdir(dir)).filter(name => name.endsWith(".bak") || name.endsWith(".new"));
		expect(residue).toEqual([]);
	});

	it.skipIf(process.platform === "win32")("reports the physical binary path verified after an update", async () => {
		const dir = await makeTempDir();
		const targetPath = path.join(dir, "oyp");
		const exe = `#!/bin/sh\necho oyp/${version}\n`;
		await bun.write(targetPath, "old binary");
		const logSpy = spyOn(console, "log").mockImplementation(() => {});

		const { build, fetchImpl } = offer(exe);

		await updateViaBinaryAt(targetPath, build, { fetchImpl });

		expect(
			logSpy.mock.calls.some(
				([message]) => String(message).includes(targetPath) && String(message).includes(version),
			),
		).toBe(true);
	});

	it("restores the shims and removes the exe when the exe reports the wrong version", async () => {
		const dir = await makeTempDir();
		await writeShims(dir);
		// Executable runs but reports the previous version -> full rollback.
		const exe = "#!/bin/sh\necho oyp/17.2.12\n";
		const { build, fetchImpl } = offer(exe);

		await expect(
			updateViaShimTakeover(path.join(dir, "oyp.cmd"), build, { fetchImpl, verifyBinary }),
		).rejects.toThrow(/still reports 17\.2\.12 \(expected 18\.0\.0\); restored previous oyp launcher/);

		expect(await bun.file(path.join(dir, "oyp.exe")).exists()).toBe(false);
		for (const name in shims) {
			expect(await bun.file(path.join(dir, name)).text()).toBe(shims[name]);
		}
		const residue = (await fs.readdir(dir)).filter(name => name.endsWith(".bak") || name.endsWith(".new"));
		expect(residue).toEqual([]);
	});

	function renameLockingPs1(): Mock<typeof nodeFs.promises.rename> {
		const realRename = nodeFs.promises.rename;
		return spyOn(nodeFs.promises, "rename").mockImplementation(async (from, to) => {
			if (path.basename(String(from)) === "oyp.ps1") {
				throw Object.assign(new Error("EPERM: file is locked"), { code: "EPERM" });
			}
			return await realRename(from, to);
		});
	}

	it("rewrites an immovable precedence-winning shim as a forwarder to the exe", async () => {
		const dir = await makeTempDir();
		await writeShims(dir);
		const exe = `#!/bin/sh\necho oyp/${version}\n`;
		const renameSpy = renameLockingPs1();
		const { build, fetchImpl } = offer(exe);
		try {
			await updateViaShimTakeover(path.join(dir, "oyp.cmd"), build, { fetchImpl, verifyBinary });
		} finally {
			renameSpy.mockRestore();
		}

		expect(await bun.file(path.join(dir, "oyp.exe")).text()).toBe(exe);
		expect(await bun.file(path.join(dir, "oyp")).exists()).toBe(false);
		expect(await bun.file(path.join(dir, "oyp.cmd")).exists()).toBe(false);
		// PowerShell resolves .ps1 before .exe: the locked shim must now exec
		// the new binary instead of keeping its old body.
		expect(await bun.file(path.join(dir, "oyp.ps1")).text()).toContain('& "$PSScriptRoot\\oyp.exe" @args');
	});

	it("restores a forwarded shim's original body when verification fails", async () => {
		const dir = await makeTempDir();
		await writeShims(dir);
		const exe = "#!/bin/sh\necho oyp/17.2.12\n";
		const renameSpy = renameLockingPs1();
		const { build, fetchImpl } = offer(exe);
		try {
			await expect(
				updateViaShimTakeover(path.join(dir, "oyp.cmd"), build, { fetchImpl, verifyBinary }),
			).rejects.toThrow("restored previous oyp launcher");
		} finally {
			renameSpy.mockRestore();
		}

		expect(await bun.file(path.join(dir, "oyp.exe")).exists()).toBe(false);
		for (const name in shims) {
			expect(await bun.file(path.join(dir, name)).text()).toBe(shims[name]);
		}
	});
});

describe("update-cli concurrent binary updates", () => {
	const version = "999.0.0";
	const payload = Buffer.alloc(2048, 0x41);
	const build = buildAnswer(version, payload);
	const fastFetch = serveDownload(build, payload);

	const verify = async () => ({ ok: true, actual: version });

	async function prepare(): Promise<{ dir: string; targetPath: string }> {
		const loadedTheme = await getThemeByName("dark");
		if (!loadedTheme) throw new Error("theme unavailable");
		setThemeInstance(loadedTheme);
		vi.spyOn(console, "log").mockImplementation(() => {});
		const dir = await makeTempDir();
		const targetPath = path.join(dir, "oyp");
		await bun.write(targetPath, "old binary");
		return { dir, targetPath };
	}

	// Regression for #8434: two overlapping `omp update` runs must not share a
	// temp path. Run A downloads slowly and only finishes after run B has fully
	// installed. With the old fixed `<binary>.new` temp name, B's pre-download
	// unlink deleted A's temp file, so A's chmod failed with ENOENT even though
	// its size + digest passed. Unique temp paths keep the two runs independent.
	it("lets an overlapping slow run install after a fast run completes, instead of failing chmod with ENOENT", async () => {
		const { dir, targetPath } = await prepare();

		const aWroteFirstChunk = Promise.withResolvers<void>();
		const letAFinish = Promise.withResolvers<void>();
		const slowFetch = async (input: string | URL | Request): Promise<Response> => {
			const requestUrl = String(input);
			if (requestUrl === build.download) {
				return new Response(
					new ReadableStream<Uint8Array>({
						async start(controller) {
							controller.enqueue(payload.subarray(0, 1024));
							aWroteFirstChunk.resolve();
							await letAFinish.promise;
							controller.enqueue(payload.subarray(1024));
							controller.close();
						},
					}),
				);
			}
			throw new Error(`Unexpected request: ${requestUrl}`);
		};

		const runA = updateViaBinaryAt(targetPath, build, {
			fetchImpl: slowFetch,
			verifyInstalledVersion: verify,
		});
		await aWroteFirstChunk.promise;
		await updateViaBinaryAt(targetPath, build, {
			fetchImpl: fastFetch,
			verifyInstalledVersion: verify,
		});
		letAFinish.resolve();
		await runA;

		expect(await bun.file(targetPath).bytes()).toEqual(new Uint8Array(payload));
		const residue = (await fs.readdir(dir)).filter(name => name.endsWith(".new"));
		expect(residue).toEqual([]);
	});

	// Regression: a failed verification must still roll back its own backup even
	// when another update completes while it is held. The per-target lock
	// serializes the swap + sweep, so the concurrent run's sweep cannot reclaim
	// the live backup before the rollback renames it back.
	it("rolls back its backup when verification fails while another update runs", async () => {
		const { dir, targetPath } = await prepare();

		const enteredVerify = Promise.withResolvers<void>();
		const releaseVerify = Promise.withResolvers<void>();
		const failingVerify = async () => {
			enteredVerify.resolve();
			await releaseVerify.promise;
			return { ok: false, actual: "0.0.0", path: targetPath };
		};

		const runA = updateViaBinaryAt(targetPath, build, {
			fetchImpl: fastFetch,
			verifyInstalledVersion: failingVerify,
		});
		await enteredVerify.promise;
		const runB = updateViaBinaryAt(targetPath, build, {
			fetchImpl: fastFetch,
			verifyInstalledVersion: verify,
		});
		releaseVerify.resolve();
		await expect(runA).rejects.toThrow(/still reports 0\.0\.0 \(expected 999\.0\.0\)/);
		await runB;

		expect(await bun.file(targetPath).bytes()).toEqual(new Uint8Array(payload));
		const residue = (await fs.readdir(dir)).filter(name => name.endsWith(".bak") || name.endsWith(".new"));
		expect(residue).toEqual([]);
	});
});

describe("managedInstallName", () => {
	async function managedRoot(): Promise<string> {
		const root = await makeTempDir();
		await fs.mkdir(path.join(root, "versions"));
		await fs.mkdir(path.join(root, "bin"));
		await bun.write(path.join(root, "versions", "1.0.0"), "oyp");
		await bun.write(path.join(root, "manager.json"), JSON.stringify({ manager: "tern", name: "Tern" }));
		return root;
	}

	it.skipIf(process.platform === "win32")(
		"names the manager through the launcher symlink and a link outside the root",
		async () => {
			const root = await managedRoot();
			const launcher = path.join(root, "bin", "oyp");
			await fs.symlink(path.join("..", "versions", "1.0.0"), launcher);
			const outside = path.join(await makeTempDir(), "oyp");
			await fs.symlink(launcher, outside);

			expect(await managedInstallName(launcher)).toBe("Tern");
			expect(await managedInstallName(outside)).toBe("Tern");
		},
	);

	it("names the manager of a copied launcher (Windows layout)", async () => {
		const root = await managedRoot();
		const copy = path.join(root, "bin", "oyp.exe");
		await bun.write(copy, "oyp");

		expect(await managedInstallName(copy)).toBe("Tern");
	});

	it("treats a binary without a readable manifest as unmanaged", async () => {
		const plain = path.join(await makeTempDir(), "bin", "oyp");
		await bun.write(plain, "oyp");
		expect(await managedInstallName(plain)).toBeUndefined();

		const root = await managedRoot();
		await bun.write(path.join(root, "manager.json"), "{not json");
		expect(await managedInstallName(path.join(root, "versions", "1.0.0"))).toBeUndefined();
	});
});

describe("update-cli manager update recovery", () => {
	const release: ReleaseInfo = {
		tag: "v18.0.1",
		version: "18.0.1",
		packages: { pkg: "@oh-my-pi/pi-coding-agent", natives: "@oh-my-pi/pi-natives" },
		registry: "https://registry.npmjs.org/",
	};
	const launcherPath = "C:/Users/test/AppData/Roaming/npm/oyp.cmd";

	function scriptedSteps(script: {
		install: InstalledVersionVerification | Error | undefined;
		verify?: InstalledVersionVerification;
		repair?: Error;
	}): { steps: ManagerUpdateSteps; calls: string[] } {
		const calls: string[] = [];
		return {
			calls,
			steps: {
				manager: "npm",
				async install() {
					calls.push("install");
					if (script.install instanceof Error) throw script.install;
					return script.install;
				},
				async verify() {
					calls.push("verify");
					return script.verify ?? { ok: false };
				},
				async repair(target) {
					calls.push(`repair:${target}`);
					if (script.repair) throw script.repair;
				},
			},
		};
	}

	it("takes the launcher over when the manager install left nothing on PATH", async () => {
		// npm retires the global bin shims before unpacking and restores them
		// only if its own rollback succeeds; a locked file (the loaded native
		// addon on Windows) can leave the user with no `omp` at all.
		vi.spyOn(console, "log").mockImplementation(() => {});
		const { steps, calls } = scriptedSteps({ install: new Error("npm install failed with exit code 1") });

		await updateViaManager(release, launcherPath, steps);

		expect(calls).toEqual(["install", "verify", `repair:${launcherPath}`]);
	});

	it("takes the launcher over when it survives but can no longer report a version", async () => {
		// The manager aborts the whole install on the first file it cannot
		// overwrite, leaving a half-replaced package the launcher cannot run.
		vi.spyOn(console, "log").mockImplementation(() => {});
		const { steps, calls } = scriptedSteps({ install: { ok: false, path: launcherPath } });

		await updateViaManager(release, launcherPath, steps);

		expect(calls).toEqual(["install", `repair:${launcherPath}`]);
	});

	it("takes the launcher over when the manager succeeds but the previous version remains", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		const { steps, calls } = scriptedSteps({ install: { ok: false, path: launcherPath, actual: "17.4.2" } });

		await updateViaManager(release, launcherPath, steps);

		expect(calls).toEqual(["install", `repair:${launcherPath}`]);
	});

	it("leaves a concurrently installed newer launcher untouched", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		const { steps, calls } = scriptedSteps({ install: { ok: false, path: launcherPath, actual: "18.0.2" } });

		await updateViaManager(release, launcherPath, steps);

		expect(calls).toEqual(["install"]);
	});

	it("surfaces the install failure without a takeover when the previous launcher still runs", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		const { steps, calls } = scriptedSteps({
			install: new Error("npm install failed with exit code 1"),
			verify: { ok: false, path: launcherPath, actual: "17.4.2" },
		});

		await expect(updateViaManager(release, launcherPath, steps)).rejects.toThrow("exit code 1");
		expect(calls).toEqual(["install", "verify"]);
	});

	it("keeps a verified manager install untouched", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		const { steps, calls } = scriptedSteps({ install: { ok: true, path: launcherPath, actual: release.version } });

		await updateViaManager(release, launcherPath, steps);

		expect(calls).toEqual(["install"]);
	});

	it("defers to a rename migration that already verified and reported its own result", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		const { steps, calls } = scriptedSteps({ install: undefined });

		await updateViaManager(release, launcherPath, steps);

		expect(calls).toEqual(["install"]);
	});

	it("reports the failed repair with the install failure as its cause", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		const { steps } = scriptedSteps({
			install: new Error("npm install failed with exit code 1"),
			repair: new Error("no binary asset"),
		});

		await expect(updateViaManager(release, launcherPath, steps)).rejects.toThrow(
			"update did not produce a working launcher and binary repair failed: Error: no binary asset",
		);
	});
});
