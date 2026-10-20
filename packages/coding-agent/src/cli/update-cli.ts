/**
 * Update CLI command handler.
 *
 * Handles `oyp update` to check for and install updates.
 * Uses the installer that owns the active omp executable when it can be detected.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
	$which,
	APP_NAME,
	compareVersions,
	formatBytes,
	getProjectDir,
	isCompiledBinary,
	isEnoent,
	VERSION,
} from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { withFileLock } from "@oh-my-pi/pi-utils/file-lock";
import { $ } from "@oh-my-pi/pi-utils/shell";
import { Settings, settings } from "../config/settings";
import { theme } from "@oh-my-pi/pi-tui/theme";
import {
	isTimeoutError,
	isUnsupportedProxyError,
	unsupportedProxyMessage,
	withTimeoutSignal,
} from "../utils/fetch-timeout";
import { type BuildAnswer, type Fetch, fetchBuild, type UpdateChannel } from "./build-service";
import {
	DEFAULT_NPM_REGISTRY,
	loadNpmRegistryResolver,
	type NpmRegistry,
	type NpmRegistryResolver,
	npmRegistryPackageUrl,
} from "./npm-registry";

import { cfgUpdateChannel } from "../modes/settings";

const PACKAGE = "@oh-my-pi/pi-coding-agent";
const MISE_TOOL = "github:Alex1990/oh-my-pi";
const NIX_STORE_DIR = "/nix/store";
const RELEASE_METADATA_TIMEOUT_MS = 30_000;
const BINARY_DOWNLOAD_TIMEOUT_MS = 15 * 60_000;

/**
 * Core native addon package. Bumped in lock-step with {@link PACKAGE} so the
 * version sentinel the loader looks up at runtime matches the `.node` on
 * disk; see {@link buildPnpmInstallArgs} for why this must be installed
 * explicitly rather than inherited as a transitive dependency.
 */
const NATIVES_PACKAGE = "@oh-my-pi/pi-natives";

/**
 * Platform tags the release pipeline publishes as
 * `@oh-my-pi/pi-natives-<tag>` leaves. Mirrors `SUPPORTED_PLATFORMS` in
 * `packages/natives/native/loader-state.js` and `LEAF_TARGETS` in
 * `packages/natives/scripts/gen-npm-packages.ts`; kept here as the local
 * source of truth so the update path stays free of cross-package imports.
 */
const SUPPORTED_NATIVE_TAGS: ReadonlySet<string> = new Set([
	"linux-x64",
	"linux-arm64",
	"darwin-x64",
	"darwin-arm64",
	"win32-x64",
	"win32-arm64",
]);

function currentNativeTag(): string {
	return `${process.platform}-${process.arch}`;
}

/** Distribution channel advertised by a release's published npm manifest. */
export type ReleaseDist = "npm" | "binary";

/** npm package names a release installs: the agent package and its natives companion. */
export interface ReleasePackages {
	pkg: string;
	natives: string;
}

/** Parsed `omp.rename` pointer: the new agent package name and optional new natives name. */
export interface ReleaseRename {
	pkg: string;
	natives?: string;
}

const CURRENT_PACKAGES: ReleasePackages = { pkg: PACKAGE, natives: NATIVES_PACKAGE };

export interface ReleaseInfo {
	tag: string;
	version: string;
	/** Parsed `omp.dist` from the registry manifest; undefined when absent. */
	dist?: ReleaseDist;
	/** npm names to install, resolved after following any `omp.rename` pointers. */
	packages: ReleasePackages;
	/**
	 * Registry URL the version was resolved from; pnpm/npm installs pin to it
	 * so the install sees the same catalog as the check. See #1686.
	 */
	registry: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/**
 * Parse the `omp.dist` field from a published package manifest.
 *
 * Forward-compatibility contract with future releases: a release that is not
 * installable as an npm package (e.g. a native rewrite) publishes
 * `"omp": { "dist": "binary" }` in its package.json. Any value other than
 * "npm" — including values this updater does not know yet — maps to "binary"
 * so already-deployed updaters never run a package-manager install against a
 * release that no longer supports it.
 */
export function resolveReleaseDist(manifest: unknown): ReleaseDist | undefined {
	if (!isRecord(manifest) || !isRecord(manifest.omp)) return undefined;
	const dist = manifest.omp.dist;
	if (dist === undefined) return undefined;
	return dist === "npm" ? "npm" : "binary";
}

/**
 * Parse the `omp.rename` pointer from a published package manifest.
 *
 * Forward-compatibility contract for renaming the npm package: the final
 * version published under an old name is a stub whose manifest carries
 * `"omp": { "rename": { "package": "<new-agent-pkg>", "natives": "<new-natives-pkg>" }, "dist": "binary" }`.
 * Updaters that understand `rename` follow the pointer and resolve the
 * release from the renamed package instead ({@link getLatestRelease});
 * older deployed updaters ignore it and take the `dist: "binary"` escape
 * hatch, replacing the install with the standalone release binary rather than
 * installing the stub via pnpm/npm.
 *
 * The renamed package's own manifest MUST declare `"dist": "npm"` (so
 * package-manager installs stay package-managed across a major bump) and
 * MUST continue the old version line (a version reset would compare as
 * "already up to date" against the running build).
 */
export function resolveReleaseRename(manifest: unknown): ReleaseRename | undefined {
	if (!isRecord(manifest) || !isRecord(manifest.omp)) return undefined;
	const rename = manifest.omp.rename;
	if (!isRecord(rename) || typeof rename.package !== "string" || rename.package.length === 0) return undefined;
	const natives = rename.natives;
	return {
		pkg: rename.package,
		natives: typeof natives === "string" && natives.length > 0 ? natives : undefined,
	};
}

function majorVersion(version: string): number {
	const major = Number.parseInt(version, 10);
	return Number.isNaN(major) ? 0 : major;
}

/**
 * Whether the update must bypass pnpm/npm and install the release binary.
 *
 * An explicit `omp.dist` wins in both directions. Without one, a release with
 * a higher major than the running build is assumed not npm-installable: the
 * runtime may have changed out from under the package layout, and the pinned
 * `@oh-my-pi/pi-natives*` companions ({@link buildPnpmInstallArgs}) may not
 * exist at that version, which would strand pnpm/npm-managed installs behind a
 * hard install failure. mise installs are unaffected — it already installs the
 * standalone release binaries.
 */
export function shouldForceBinaryUpdate(
	release: { version: string; dist?: ReleaseDist },
	currentVersion: string = VERSION,
): boolean {
	if (release.dist !== undefined) return release.dist === "binary";
	return majorVersion(release.version) > majorVersion(currentVersion);
}

export interface VerifiedBinaryDownloadOptions {
	url: string;
	targetPath: string;
	expectedSize: number;
	expectedDigest: string;
	fetchImpl?: Fetch;
}

/**
 * Download a file and verify its build-service-reported size and SHA-256
 * digest (`sha256:<hex>`), leaving it executable. Nothing is left at
 * `targetPath` when the download fails or does not match.
 */
export async function downloadVerifiedBinary(options: VerifiedBinaryDownloadOptions): Promise<void> {
	const fetchImpl = options.fetchImpl ?? fetch;
	await unlinkIfExists(options.targetPath);

	let response: Response;
	try {
		response = await fetchImpl(options.url, {
			redirect: "follow",
			signal: withTimeoutSignal(BINARY_DOWNLOAD_TIMEOUT_MS),
		});
	} catch (err) {
		if (isTimeoutError(err)) {
			throw new Error("Timed out downloading release binary after 15 minutes", { cause: err });
		}
		if (isUnsupportedProxyError(err)) throw new Error(unsupportedProxyMessage(), { cause: err });
		throw err;
	}
	if (!response.ok || !response.body) {
		throw new Error(`Download failed: ${response.statusText}`);
	}

	const hash = createHash("sha256");
	let size = 0;
	const verifier = new Transform({
		transform(chunk, _encoding, callback) {
			size += chunk.byteLength;
			if (size > options.expectedSize) {
				callback(
					new Error(
						`Downloaded binary size mismatch: expected ${options.expectedSize} bytes, received at least ${size}`,
					),
				);
				return;
			}
			hash.update(chunk);
			callback(null, chunk);
		},
	});

	try {
		await pipeline(response.body, verifier, fs.createWriteStream(options.targetPath, { mode: 0o600 }));
		const digest = `sha256:${hash.digest("hex")}`;
		if (size !== options.expectedSize) {
			throw new Error(`Downloaded binary size mismatch: expected ${options.expectedSize} bytes, received ${size}`);
		}
		if (digest !== options.expectedDigest) {
			throw new Error(`Downloaded binary digest mismatch: expected ${options.expectedDigest}, received ${digest}`);
		}
		await fs.promises.chmod(options.targetPath, 0o755);
	} catch (err) {
		await unlinkIfExists(options.targetPath);
		if (isTimeoutError(err)) {
			throw new Error("Timed out downloading release binary after 15 minutes", { cause: err });
		}
		if (isUnsupportedProxyError(err)) throw new Error(unsupportedProxyMessage(), { cause: err });
		throw err;
	}
}

/** Result from running the installed binary and parsing its reported version. */
export interface InstalledVersionVerification {
	ok: boolean;
	actual?: string;
	path?: string;
}

/** Paths and verifier used while replacing a downloaded binary update. */
export interface BinaryReplacementOptions {
	targetPath: string;
	tempPath: string;
	backupPath: string;
	expectedVersion: string;
	verifyInstalledVersion: (expectedVersion: string) => Promise<InstalledVersionVerification>;
}

/**
 * Parse update subcommand arguments.
 * Returns undefined if not an update command.
 */
export function parseUpdateArgs(
	args: string[],
): { force: boolean; check: boolean; plugins: boolean; channel?: UpdateChannel } | undefined {
	if (args.length === 0 || args[0] !== "update") {
		return undefined;
	}

	const canary = args.includes("--canary");
	const stable = args.includes("--stable");
	if (canary && stable) throw new Error("--canary and --stable are mutually exclusive");

	return {
		force: args.includes("--force") || args.includes("-f"),
		check: args.includes("--check") || args.includes("-c"),
		plugins: args.includes("--plugins") || args.includes("-l"),
		channel: canary ? "canary" : stable ? "stable" : undefined,
	};
}

async function getPnpmGlobalBinDir(): Promise<string | undefined> {
	if (!$which("pnpm")) return undefined;
	try {
		const result = await $`pnpm bin -g`.quiet().nothrow();
		if (result.exitCode !== 0) return undefined;
		const output = result.text().trim();
		return output.length > 0 ? output : undefined;
	} catch {
		return undefined;
	}
}

async function getNpmGlobalBinDir(): Promise<string | undefined> {
	if (!$which("npm")) return undefined;
	try {
		const result = await $`npm prefix -g`.quiet().nothrow();
		if (result.exitCode !== 0) return undefined;
		const prefix = result.text().trim();
		if (prefix.length === 0) return undefined;
		return process.platform === "win32" ? prefix : path.join(prefix, "bin");
	} catch {
		return undefined;
	}
}

async function getMiseBinDirs(): Promise<string[]> {
	if (!$which("mise")) return [];
	try {
		const result = await $`mise bin-paths ${MISE_TOOL}`.quiet().nothrow();
		if (result.exitCode !== 0) return [];
		return result
			.text()
			.split(/\r?\n/)
			.map(line => line.trim())
			.filter(line => line.length > 0);
	} catch {
		return [];
	}
}

function getMiseDataDir(): string {
	const override = process.env.MISE_DATA_DIR;
	if (override && override.length > 0) return override;
	if (process.platform === "win32") {
		const localAppData = process.env.LOCALAPPDATA;
		if (localAppData && localAppData.length > 0) return path.join(localAppData, "mise");
	}
	const xdgDataHome = process.env.XDG_DATA_HOME;
	if (xdgDataHome && xdgDataHome.length > 0) return path.join(xdgDataHome, "mise");
	return path.join(os.homedir(), ".local", "share", "mise");
}

function normalizePathForComparison(filePath: string): string {
	const normalized = path.normalize(filePath);
	if (process.platform === "win32") return normalized.toLowerCase();
	return normalized;
}

function tryRealpath(p: string): string | undefined {
	try {
		return fs.realpathSync.native(p);
	} catch {
		return undefined;
	}
}

/**
 * Whether this omp runs from a source checkout (the dev launcher or a `pnpm link` of
 * `src/cli.ts`) rather than a compiled binary or a package-manager install, which
 * always lives under `node_modules`. Checkouts update through git, so update
 * prompts are noise there.
 */
export function isSourceCheckout(): boolean {
	return !isCompiledBinary() && !import.meta.dirname.split(path.sep).includes("node_modules");
}

/**
 * Name of the app that manages the omp at `binaryPath`, or undefined when none does.
 *
 * A manager (Tern) keeps `manager.json` (`{"manager": "tern", "name": "Tern"}`) two
 * directories above every binary it installs (`<root>/versions/<version>`,
 * `<root>/bin/omp.exe`) and updates them itself, so `oyp update` must leave them alone.
 * A missing or unreadable manifest means unmanaged.
 */
export async function managedInstallName(binaryPath: string): Promise<string | undefined> {
	const resolved = tryRealpath(binaryPath);
	if (!resolved) return undefined;
	let manifest: unknown;
	try {
		manifest = JSON.parse(
			await fs.promises.readFile(path.join(path.dirname(path.dirname(resolved)), "manager.json"), "utf8"),
		);
	} catch {
		return undefined;
	}
	if (!isRecord(manifest)) return undefined;
	const name = typeof manifest.name === "string" && manifest.name ? manifest.name : manifest.manager;
	return typeof name === "string" && name ? name : undefined;
}

function isSymlinkPath(p: string): boolean {
	try {
		return fs.lstatSync(p).isSymbolicLink();
	} catch {
		return false;
	}
}
/** Windows script shims (npm's launchers) that a native executable cannot overwrite. */
function isWindowsScriptLauncherPath(launcherPath: string): boolean {
	const extension = path.extname(launcherPath).toLowerCase();
	return extension === ".cmd" || extension === ".ps1" || extension === ".bat";
}

function isPathInDirectoryLexical(filePath: string, directoryPath: string): boolean {
	const normalizedPath = normalizePathForComparison(path.resolve(filePath));
	const normalizedDirectory = normalizePathForComparison(path.resolve(directoryPath));
	const relativePath = path.relative(normalizedDirectory, normalizedPath);
	return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function isPathInDirectory(filePath: string, directoryPath: string): boolean {
	if (isPathInDirectoryLexical(filePath, directoryPath)) return true;
	// Layer realpath resolution on top of the lexical guard. On Windows the
	// package-manager global dir can be reached through a junction, so
	// `pnpm bin -g` / `npm prefix -g` and the PATH-resolved omp path may name
	// the same directory through different strings. path.resolve does not
	// traverse junctions/symlinks; realpath does.
	// Resolve both the file and its parent directory: the file catches manager
	// links like a package manager's `bin/omp -> .../bin/omp`; the parent fallback
	// still tolerates fresh install paths where the file does not exist yet.
	const dirReal = tryRealpath(path.resolve(directoryPath));
	if (!dirReal) return false;
	const fileReal = tryRealpath(path.resolve(filePath));
	if (fileReal && isPathInDirectoryLexical(fileReal, dirReal)) return true;
	const fileDir = tryRealpath(path.dirname(path.resolve(filePath)));
	if (!fileDir) return false;
	const resolvedFile = path.join(fileDir, path.basename(filePath));
	return isPathInDirectoryLexical(resolvedFile, dirReal);
}

function isPathInManagerRoot(linkTarget: string, nodeModulesDir: string): boolean {
	if (isPathInDirectoryLexical(linkTarget, nodeModulesDir)) return true;
	// Resolve only the manager root. Resolving the link target itself would
	// follow globally linked packages into their checkout and lose ownership.
	const nodeModulesReal = tryRealpath(path.resolve(nodeModulesDir));
	return nodeModulesReal !== undefined && isPathInDirectoryLexical(linkTarget, nodeModulesReal);
}

function resolveNpmGlobalNodeModulesDir(globalBinDir: string | undefined): string | undefined {
	if (!globalBinDir) return undefined;
	if (process.platform === "win32") return path.join(globalBinDir, "node_modules");
	return path.join(path.dirname(globalBinDir), "lib", "node_modules");
}

function isManagerOwnedBinEntry(linkTarget: string | undefined, nodeModulesDir: string | undefined): boolean {
	// Non-symlink launchers and unreadable links retain the existing bin-dir
	// classification. A readable link must point through the manager's exact
	// global node_modules tree.
	return linkTarget === undefined || (nodeModulesDir !== undefined && isPathInManagerRoot(linkTarget, nodeModulesDir));
}

type UpdateMethod = "mise" | "nix" | "pnpm" | "npm" | "binary";

interface UpdateMethodResolutionOptions {
	miseBinDirs?: readonly string[];
	miseDataDir?: string;
	npmBinDir?: string;
	/** pnpm's global node_modules root (`pnpm root -g`), where its installed packages live. */
	pnpmGlobalDir?: string;
	/**
	 * Whether the resolved omp path is a plain file (the standalone binary)
	 * rather than a package-manager symlink. Stops a binary install from being
	 * misrouted to npm/pnpm when the global bin dir overlaps the installer's
	 * target directory.
	 */
	ompIsRegularFile?: boolean;
	/**
	 * Absolute path named by the bin entry's first symlink hop. This deliberately
	 * preserves a global package symlink instead of resolving into its checkout.
	 */
	ompLinkTarget?: string;
	/**
	 * Whether package-manager routing (pnpm/npm) is permitted. Binary-only
	 * releases pass `false`: a manager launcher then resolves to `"binary"` and
	 * is taken over in place rather than reinstalled through its manager. Defaults
	 * to `true` in {@link resolveUpdateMethod} so callers that only classify need
	 * not set it.
	 */
	allowPackageManagers?: boolean;
}

type UpdateTarget =
	| { method: "mise" }
	| { method: "nix" }
	| { method: "pnpm"; path?: string }
	| { method: "npm"; path?: string }
	| { method: "binary"; path: string; replacesSymlink: boolean; validateExistingTarget: boolean };

function resolveUpdateMethod(
	ompPath: string,
	pnpmBinDir: string | undefined,
	options: UpdateMethodResolutionOptions = {},
): UpdateMethod {
	const {
		allowPackageManagers = true,
		miseBinDirs = [],
		miseDataDir,
		npmBinDir,
		ompIsRegularFile = false,
		ompLinkTarget,
		pnpmGlobalDir,
	} = options;
	const launcherExtension = path.extname(ompPath).toLowerCase();
	const isWindowsScriptLauncher = isWindowsScriptLauncherPath(ompPath);
	if (isPathInDirectory(ompPath, NIX_STORE_DIR)) return "nix";
	if (miseBinDirs.some(dir => isPathInDirectory(ompPath, dir))) return "mise";
	if (miseDataDir && isPathInDirectory(ompPath, path.join(miseDataDir, "shims"))) return "mise";
	// A plain executable file in a package-manager bin dir is the standalone
	// binary the installer placed there, not an npm/pnpm-managed install (those
	// symlink into node_modules on POSIX). When the global bin dir overlaps the
	// installer's default (~/.local/bin), classifying by directory alone routes
	// a binary install through npm/pnpm, whose reinstall then collides with the
	// existing file (npm EEXIST). Fall through to binary replacement instead.
	// On Windows every launcher is a regular file, so ownership keys off the
	// manager's own artifacts instead: the shell/batch shims (`omp`, `omp.cmd`,
	// `omp.ps1`) both npm and pnpm write. A bare `.exe` is the standalone binary
	// a binary-only release installed over the launcher — routing that back
	// through pnpm reinstalls a package which no longer owns the launcher, and
	// Windows cannot replace the running `.exe`, so the install would stay
	// pinned to the old version.
	const isWindowsManagedLauncher =
		process.platform === "win32" && (isWindowsScriptLauncher || launcherExtension === "");
	const isStandaloneRegularFile = ompIsRegularFile && !isWindowsManagedLauncher;
	// pnpm first: its global installs are frequently invisible to npm (its
	// global dir is PNPM_HOME, not `npm prefix -g`), so the npm branch would
	// otherwise never see them.
	if (
		allowPackageManagers &&
		pnpmBinDir &&
		isPathInDirectory(ompPath, pnpmBinDir) &&
		!isStandaloneRegularFile &&
		isManagerOwnedBinEntry(ompLinkTarget, pnpmGlobalDir)
	) {
		return "pnpm";
	}
	const npmNodeModulesDir = resolveNpmGlobalNodeModulesDir(npmBinDir);
	if (
		allowPackageManagers &&
		npmBinDir &&
		isPathInDirectory(ompPath, npmBinDir) &&
		!isStandaloneRegularFile &&
		isManagerOwnedBinEntry(ompLinkTarget, npmNodeModulesDir)
	) {
		return "npm";
	}
	if (isWindowsScriptLauncher) {
		// With package-manager routing disabled only the shim shape is known.
		// Attribute it to the pnpm bin dir when the launcher sits there so
		// recovery messages name the manager that actually owns it.
		return pnpmBinDir && isPathInDirectory(ompPath, pnpmBinDir) ? "pnpm" : "npm";
	}
	return "binary";
}

export function resolveUpdateMethodForTest(
	ompPath: string,
	pnpmBinDir: string | undefined,
	options: UpdateMethodResolutionOptions = {},
): UpdateMethod {
	return resolveUpdateMethod(ompPath, pnpmBinDir, options);
}

/** Resolve an update target from the concrete PATH entry selected by the shell. */
export function resolveUpdateTargetFromPath(
	ompPath: string,
	pnpmBinDir: string | undefined,
	options: UpdateMethodResolutionOptions & { allowPackageManagers: boolean },
): UpdateTarget {
	let ompIsRegularFile = false;
	let ompIsSymlink = false;
	let ompLinkTarget: string | undefined;
	let ompRealpath: string | undefined;
	try {
		const stat = fs.lstatSync(ompPath);
		ompIsRegularFile = stat.isFile() && !stat.isSymbolicLink();
		ompIsSymlink = stat.isSymbolicLink();
		if (ompIsSymlink) {
			const rawTarget = fs.readlinkSync(ompPath);
			const linkDir = path.dirname(ompPath);
			ompLinkTarget = path.resolve(tryRealpath(linkDir) ?? linkDir, rawTarget);
			ompRealpath = tryRealpath(ompPath);
		}
	} catch {}

	const method = resolveUpdateMethod(ompPath, pnpmBinDir, {
		...options,
		ompIsRegularFile,
		ompLinkTarget,
	});
	if (method === "binary") {
		// A symlinked launcher created by pnpm/npm is taken over in place on a
		// binary-only release: routing through the manager is impossible, so the
		// standalone binary replaces the launcher and keeps the PATH entry live.
		// Every other symlink — a foreign alias, or an admin symlink into a
		// shared install — is self-healing: update the real binary it resolves
		// to and leave the launcher untouched, in every distribution channel.
		// The old channel gate clobbered these foreign launchers on binary-only
		// releases (EACCES on a root-owned link dir, or a stale split-brain copy
		// of the binary shadowing the shared install).
		const managerLauncher =
			ompIsSymlink &&
			!options.allowPackageManagers &&
			resolveUpdateMethod(ompPath, pnpmBinDir, {
				...options,
				allowPackageManagers: true,
				ompIsRegularFile,
				ompLinkTarget,
			}) !== "binary";
		const binaryPath = ompIsSymlink && !managerLauncher ? (ompRealpath ?? ompPath) : ompPath;
		return {
			method,
			path: binaryPath,
			replacesSymlink: ompIsSymlink && binaryPath === ompPath,
			validateExistingTarget: ompIsSymlink && !managerLauncher,
		};
	}
	if (method === "pnpm" || method === "npm") return { method, path: ompPath };
	return { method };
}
/**
 * Resolve how the running install should be updated.
 *
 * `allowPackageManagers: false` disables pnpm/npm routing — used for
 * binary-only releases, where reinstalling through a package manager is never
 * valid. The `pnpm bin -g` / `npm prefix -g` probes are then skipped unless
 * the launcher is a symlink or a Windows script shim, whose bin dirs
 * distinguish a manager launcher (taken over in place) from a foreign symlink
 * (resolved to its real binary).
 * mise detection always runs: it installs the standalone release binaries and
 * stays valid regardless of how the release is distributed.
 */
async function resolveUpdateTarget(options: { allowPackageManagers: boolean }): Promise<UpdateTarget> {
	const miseAvailable = $which("mise") !== undefined;
	const miseBinDirs = miseAvailable ? await getMiseBinDirs() : [];
	const miseDataDir = miseAvailable ? getMiseDataDir() : undefined;
	const ompPath = resolveOmpPath();

	// Binary-only releases skip package-manager routing, but a manager-owned
	// launcher still needs the manager bin dirs to tell a pnpm/npm launcher
	// (taken over in place) from a foreign symlink (resolved to its real
	// binary). A plain-file install never needs the distinction, so the common
	// case stays probe-free.
	const probeManagers =
		options.allowPackageManagers ||
		(ompPath !== undefined &&
			(isSymlinkPath(ompPath) || (process.platform === "win32" && isWindowsScriptLauncherPath(ompPath))));
	const pnpmBinDir = probeManagers ? await getPnpmGlobalBinDir() : undefined;
	const npmBinDir = probeManagers ? await getNpmGlobalBinDir() : undefined;

	if (ompPath) {
		return resolveUpdateTargetFromPath(ompPath, pnpmBinDir, {
			allowPackageManagers: options.allowPackageManagers,
			pnpmGlobalDir: pnpmBinDir ? await getPnpmGlobalNodeModulesDir() : undefined,
			miseBinDirs,
			miseDataDir,
			npmBinDir,
		});
	}

	if (pnpmBinDir) return { method: "pnpm" };

	throw new Error(`Could not resolve ${APP_NAME} binary path in PATH`);
}

/** Bound on `omp.rename` hops so a broken pointer chain cannot loop forever. */
const MAX_RENAME_HOPS = 3;

async function fetchLatestManifest(
	pkg: string,
	registry: NpmRegistry,
	timeoutMs: number,
	channel: UpdateChannel,
): Promise<{ version: string; manifest: Record<string, unknown> }> {
	const tag = channel === "canary" ? "canary" : "latest";
	const headers: Record<string, string> = { accept: "application/json" };
	if (registry.authorization) headers.authorization = registry.authorization;
	const origin = registry.url === DEFAULT_NPM_REGISTRY ? "" : ` from ${registry.url} (${registry.source})`;
	const get = async (url: string): Promise<Response> => {
		try {
			return await fetch(url, { headers, signal: withTimeoutSignal(timeoutMs) });
		} catch (err) {
			if (isTimeoutError(err)) {
				throw new Error(
					`Timed out fetching release info for ${pkg}${origin} after ${Math.round(timeoutMs / 1000)}s`,
					{ cause: err },
				);
			}
			if (isUnsupportedProxyError(err)) throw new Error(unsupportedProxyMessage(), { cause: err });
			throw err;
		}
	};
	const noCanary = () =>
		new Error(`No canary release has been published for ${pkg} yet. Try \`${APP_NAME} update --stable\`.`);

	const fromPackument = (packument: unknown): Record<string, unknown> => {
		const distTags = isRecord(packument) ? packument["dist-tags"] : undefined;
		const version = isRecord(distTags) ? distTags[tag] : undefined;
		if (typeof version !== "string") {
			if (channel === "canary") throw noCanary();
			throw new Error(`Malformed npm registry response for ${pkg}${origin}: missing dist-tags.${tag}`);
		}
		const versions = isRecord(packument) ? packument.versions : undefined;
		const manifest = isRecord(versions) ? versions[version] : undefined;
		if (!isRecord(manifest)) {
			throw new Error(`Malformed npm registry response for ${pkg}${origin}: missing versions.${version}`);
		}
		return manifest;
	};
	const isPackument = (body: unknown): boolean => isRecord(body) && isRecord(body["dist-tags"]);

	let response = await get(npmRegistryPackageUrl(registry, pkg, tag));
	let data: unknown;
	let useFullPackument = false;
	if (response.ok) {
		try {
			data = await response.json();
		} catch (err) {
			// Only a malformed body falls back; body-read timeouts and resets must surface.
			if (!origin || !(err instanceof SyntaxError)) throw err;
			useFullPackument = true;
		}
		if (isPackument(data)) {
			// Some registries (e.g. Sonatype Nexus) answer the dist-tag shortcut
			// with the full packument instead of the tagged version manifest.
			data = fromPackument(data);
		} else if (origin && !(isRecord(data) && typeof data.version === "string")) {
			useFullPackument = true;
		}
	} else if (origin && [400, 404, 405].includes(response.status)) {
		useFullPackument = true;
	}
	if (useFullPackument) {
		// Not every registry implementation serves npmjs's `/<pkg>/<dist-tag>`
		// shortcut; the full packument is the one endpoint all of them share.
		response = await get(npmRegistryPackageUrl(registry, pkg));
		data = response.ok ? fromPackument(await response.json()) : undefined;
	}
	if (!response.ok) {
		if (response.status === 404 && channel === "canary") throw noCanary();
		const authHint =
			response.status === 401 || response.status === 403 ? "; check the registry credentials in your .npmrc" : "";
		throw new Error(
			`Failed to fetch release info for ${pkg}${origin}: ${response.status} ${response.statusText}${authHint}`,
		);
	}

	if (!isRecord(data) || typeof data.version !== "string") {
		throw new Error(`Malformed npm registry response for ${pkg}${origin}: missing version`);
	}
	return { version: data.version, manifest: data };
}

/**
 * Get the latest release info from the npm registry, following `omp.rename`
 * pointers ({@link resolveReleaseRename}) when the package has moved to a new
 * npm name. Version, dist, and install names all come from the final manifest
 * in the chain. This is the version source of package-manager installs (pnpm,
 * npm, mise, Nix); standalone binaries ask GitHub Releases ({@link fetchBuild})
 * instead.
 *
 * The registry comes from the user's npm configuration
 * ({@link loadNpmRegistryResolver}), so a configured feed is honored.
 */
export async function getLatestRelease(
	options: { timeoutMs?: number; channel?: UpdateChannel; registries?: NpmRegistryResolver } = {},
): Promise<ReleaseInfo> {
	const timeoutMs = options.timeoutMs ?? RELEASE_METADATA_TIMEOUT_MS;
	const channel = options.channel ?? "stable";
	const registries = options.registries ?? (await loadNpmRegistryResolver());
	const packages: ReleasePackages = { ...CURRENT_PACKAGES };
	const visited = new Set([packages.pkg]);
	let registry = registries(packages.pkg);
	let latest = await fetchLatestManifest(packages.pkg, registry, timeoutMs, channel);
	for (let hop = 0; hop < MAX_RENAME_HOPS; hop++) {
		const rename = resolveReleaseRename(latest.manifest);
		if (!rename || visited.has(rename.pkg)) break;
		visited.add(rename.pkg);
		packages.pkg = rename.pkg;
		if (rename.natives) packages.natives = rename.natives;
		registry = registries(packages.pkg);
		latest = await fetchLatestManifest(packages.pkg, registry, timeoutMs, channel);
	}

	return {
		tag: `v${latest.version}`,
		version: latest.version,
		dist: resolveReleaseDist(latest.manifest),
		packages,
		registry: registry.url,
	};
}

/** pnpm's global layout version: `$PNPM_HOME/global/<version>/node_modules`. */
const PNPM_GLOBAL_LAYOUT_VERSION = "5";

interface PnpmGlobalInstallLocations {
	/** `pnpm root -g`: the global node_modules root, used verbatim. */
	globalRoot?: string;
	/** `$PNPM_HOME` (what `pnpm bin -g` reports), which holds the layout directory. */
	globalHome?: string;
}

/** Resolve pnpm's global node_modules root from `pnpm root -g` or `$PNPM_HOME`. */
export function resolvePnpmGlobalNodeModulesDirFromLocations({
	globalRoot,
	globalHome,
}: PnpmGlobalInstallLocations): string | undefined {
	if (globalRoot && globalRoot.length > 0) return globalRoot;
	if (globalHome && globalHome.length > 0) {
		return path.join(globalHome, "global", PNPM_GLOBAL_LAYOUT_VERSION, "node_modules");
	}
	return undefined;
}

async function getPnpmGlobalNodeModulesDir(): Promise<string | undefined> {
	try {
		const result = await $`pnpm root -g`.quiet().nothrow();
		return resolvePnpmGlobalNodeModulesDirFromLocations({
			globalRoot: result.exitCode === 0 ? result.text().trim() : undefined,
			globalHome: process.env.PNPM_HOME,
		});
	} catch {
		return resolvePnpmGlobalNodeModulesDirFromLocations({ globalHome: process.env.PNPM_HOME });
	}
}

/**
 * Resolve the path that `omp` maps to in the user's PATH.
 */
function resolveOmpPath(): string | undefined {
	return $which(APP_NAME) ?? undefined;
}

/**
 * Parse the version a launcher reports from `oyp --version` output
 * (`omp/X.Y.Z`, or a prerelease such as `omp/X.Y.Z-canary.1`).
 *
 * The prerelease suffix is preserved so a correctly installed canary build
 * verifies as up to date instead of appearing to report a stale `X.Y.Z` and
 * being mistaken for an unreplaced launcher.
 */
export function parseReportedVersion(output: string): string | undefined {
	if (!output.startsWith(`${APP_NAME}/`)) return undefined;
	return output.slice(APP_NAME.length + 1).match(/^(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/)?.[1];
}

async function reportedVersionAtPath(binaryPath: string): Promise<string | undefined> {
	try {
		const result = await $`${binaryPath} --version`.quiet().nothrow();
		if (result.exitCode !== 0) return undefined;
		return parseReportedVersion(result.text().trim());
	} catch {
		return undefined;
	}
}

/**
 * Run a specific binary and check if it reports the expected version.
 */
async function verifyBinaryAtPath(binaryPath: string, expectedVersion: string): Promise<InstalledVersionVerification> {
	const actual = await reportedVersionAtPath(binaryPath);
	return { ok: actual === expectedVersion, actual, path: binaryPath };
}

async function validateExistingUpdateTarget(targetPath: string): Promise<void> {
	let hasShebang = false;
	const head = Buffer.alloc(2);
	try {
		const file = await fs.promises.open(targetPath, "r");
		try {
			hasShebang = (await file.read(head, 0, 2, 0)).bytesRead === 2 && head.toString() === "#!";
		} finally {
			await file.close();
		}
	} catch {}

	if (!hasShebang && (await reportedVersionAtPath(targetPath)) !== undefined) return;

	const reason = hasShebang
		? "is a shebang script, not an OMP binary"
		: "does not report an OMP version when run directly";
	throw new Error(
		`Refusing to replace ${targetPath}: the resolved foreign symlink target ${reason}. Point PATH directly at the OMP binary you want to update, or reinstall with: ${installerHint()}`,
	);
}

/**
 * Run the PATH-resolved omp binary and check if it reports the expected version.
 */
async function verifyInstalledVersion(expectedVersion: string): Promise<InstalledVersionVerification> {
	const ompPath = resolveOmpPath();
	if (!ompPath) return { ok: false };
	const binaryPath = tryRealpath(ompPath) ?? ompPath;
	return await verifyBinaryAtPath(binaryPath, expectedVersion);
}

function printVerifiedVersion(expectedVersion: string, binaryPath?: string): void {
	const icon = theme?.status?.success ?? "✔";
	const location = binaryPath ? ` at ${binaryPath}` : "";
	console.log(chalk.green(`\n${icon} Updated to ${expectedVersion}${location}`));
}

function formatVerificationFailure(result: InstalledVersionVerification, expectedVersion: string): string {
	if (result.actual) {
		return `${APP_NAME} at ${result.path} still reports ${result.actual} (expected ${expectedVersion})`;
	}
	return `could not verify updated version${result.path ? ` at ${result.path}` : ""}`;
}

/**
 * Print post-update verification result.
 */
function printVerificationResult(result: InstalledVersionVerification, expectedVersion: string): void {
	if (result.ok) {
		printVerifiedVersion(expectedVersion, result.path);
		return;
	}
	console.log(chalk.yellow(`\nWarning: ${formatVerificationFailure(result, expectedVersion)}`));
	console.log(chalk.yellow(`You may need to reinstall: ${installerHint()}`));
}

/** Verify the PATH-resolved launcher and print the outcome. */
async function printVerification(expectedVersion: string): Promise<void> {
	printVerificationResult(await verifyInstalledVersion(expectedVersion), expectedVersion);
}

async function unlinkIfExists(filePath: string): Promise<void> {
	try {
		await fs.promises.unlink(filePath);
	} catch (err) {
		if (!isEnoent(err)) throw err;
	}
}

/**
 * Remove a backup binary without letting the removal abort a completed update.
 *
 * On Windows the executable that was just moved aside is still mapped as the
 * running process image, so unlinking it fails with EPERM/EACCES until this
 * process exits (issue #845). On macOS the same unlink would instead succeed
 * while breaking the live process's TCC permission attribution — macOS
 * resolves grants against the executable's on-disk image path — so a `.bak`
 * still mapped by any process is retained for a later sweep. The replacement
 * and verification already succeeded by the time we get here, so every error
 * is swallowed; the leftover is reclaimed by {@link sweepStaleUpdateArtifacts}
 * on the next update once it is no longer in use. Returns whether the file is
 * gone.
 */
async function removeBackupBestEffort(filePath: string): Promise<boolean> {
	// macOS only, `.bak` only: a `.new` temp file is a download in progress,
	// never an installed image, and Windows/Linux locking is already handled by
	// the swallow below — so both stay ungated.
	if (process.platform === "darwin" && filePath.endsWith(".bak")) {
		// `/usr/sbin/lsof -t` prints the PIDs holding the file; exit 1 with
		// empty stdout and stderr is the only result that proves the file is
		// unused. Live users, a missing lsof, or diagnostics on stderr all
		// retain the file for a later sweep.
		let provenUnused = false;
		try {
			const result = await $`/usr/sbin/lsof -t -- ${filePath}`.quiet().nothrow();
			provenUnused = result.exitCode === 1 && result.stdout.length === 0 && result.stderr.length === 0;
		} catch {
			// lsof missing or failed to spawn — retain conservatively.
		}
		if (!provenUnused) return false;
	}
	try {
		await fs.promises.unlink(filePath);
		return true;
	} catch (err) {
		return isEnoent(err);
	}
}

/**
 * Best-effort removal of binary-update leftovers from earlier runs.
 *
 * Each self-update writes to `<binary>.<timestamp>.<pid>.new` and moves the
 * previous executable to `<binary>.<timestamp>.<pid>.bak` before swapping the
 * new one in. On Windows a backup cannot be deleted while the updating process
 * is alive (it is the running process image), so it is left for a later run to
 * reclaim once its owning process has exited. On macOS the sweep must also
 * spare a backup that any process still maps as its executable image —
 * unlinking it would break the live process's TCC permission attribution — so
 * a live image survives until its process exits. A `.new` temp file only
 * survives a hard kill mid-update; it is reaped once older than the download
 * window, which a live download cannot exceed without timing out and cleaning
 * up after itself — so a concurrent run's in-progress temp is never deleted.
 * Legacy fixed `<binary>.bak` / `<binary>.new` names (from before suffixes
 * were made unique) are matched too, so users upgrading from a buggy release
 * get the orphaned files cleaned up. `.patch` files from releases that shipped
 * binary patches are reclaimed the same way.
 */
export async function sweepStaleUpdateArtifacts(targetPath: string): Promise<void> {
	const dir = path.dirname(targetPath);
	const base = path.basename(targetPath);
	let entries: string[];
	try {
		entries = await fs.promises.readdir(dir);
	} catch {
		return;
	}
	const now = Date.now();
	for (const entry of entries) {
		if (!entry.startsWith(`${base}.`)) continue;
		const suffix = entry.endsWith(".bak")
			? ".bak"
			: entry.endsWith(".new")
				? ".new"
				: entry.endsWith(".patch")
					? ".patch"
					: undefined;
		if (!suffix) continue;
		// Legacy "<base><suffix>" → empty middle; new "<base>.<timestamp>.<pid><suffix>"
		// → dot-separated numeric run. Anything else is an unrelated file; a patch
		// never had a legacy name, so a bare "<base>.patch" is not ours either.
		const middle = entry.slice(base.length + 1, entry.length - suffix.length);
		if (middle.length > 0 ? !/^\d+(\.\d+)*$/.test(middle) : suffix === ".patch") continue;
		const full = path.join(dir, entry);
		if (suffix !== ".bak") {
			// A temp file may belong to a concurrent update still downloading, so
			// only reap ones older than the download window.
			let mtimeMs: number;
			try {
				mtimeMs = (await fs.promises.stat(full)).mtimeMs;
			} catch {
				continue;
			}
			if (now - mtimeMs < BINARY_DOWNLOAD_TIMEOUT_MS) continue;
		}
		await removeBackupBestEffort(full);
	}
}

/**
 * Atomically replace the installed binary and roll back if version verification fails.
 */
export async function replaceBinaryForUpdate(options: BinaryReplacementOptions): Promise<InstalledVersionVerification> {
	let backupReady = false;
	try {
		// `backupPath` is unique per attempt (see updateViaBinaryAt), so this rename
		// never has to overwrite — or unlink — a possibly-locked leftover from an
		// earlier run. Renaming the running executable itself is permitted on
		// Windows; only deleting its still-mapped image is not.
		// A missing target is tolerated: repairing a launcher that a failed
		// package-manager reinstall removed installs the binary at a vacant
		// path. There is then nothing to restore, so a verification failure
		// leaves the new binary in place rather than the previous nothing.
		try {
			await fs.promises.rename(options.targetPath, options.backupPath);
			backupReady = true;
		} catch (err) {
			if (!isEnoent(err)) throw err;
		}
		await fs.promises.rename(options.tempPath, options.targetPath);

		const verification = await options.verifyInstalledVersion(options.expectedVersion);
		if (!verification.ok) {
			throw new Error(
				`${formatVerificationFailure(verification, options.expectedVersion)}; restored previous ${APP_NAME} binary`,
			);
		}

		backupReady = false;
		// Swap done and verified. On Windows the backup is still the running
		// process image and cannot be unlinked until this process exits, and on
		// macOS unlinking the still-mapped backup would break the live image's
		// TCC permission attribution, so either way a failure here must NOT fail
		// an otherwise-successful update.
		await removeBackupBestEffort(options.backupPath);
		return verification;
	} catch (err) {
		if (backupReady) {
			await unlinkIfExists(options.targetPath);
			await fs.promises.rename(options.backupPath, options.targetPath);
		}
		await unlinkIfExists(options.tempPath);
		throw err;
	}
}

function buildVersionedPackageInstallArgs(
	expectedVersion: string,
	nativeTag: string,
	packages: ReleasePackages,
): string[] {
	const args = [`${packages.pkg}@${expectedVersion}`, `${packages.natives}@${expectedVersion}`];
	if (SUPPORTED_NATIVE_TAGS.has(nativeTag)) {
		args.push(`${packages.natives}-${nativeTag}@${expectedVersion}`);
	}
	return args;
}

/**
 * Build the pnpm argv used to globally install a specific omp version.
 *
 * The version is selected by querying the resolved registry in
 * {@link getLatestRelease} ({@link ReleaseInfo.registry}), so the install
 * MUST observe the same catalog:
 *
 * - `--registry=<release registry>` pins the install to the registry the
 *   check used. That is the user's configured feed when one is set, and
 *   {@link DEFAULT_NPM_REGISTRY} otherwise, so a pnpm whose own resolution
 *   differs (project `.npmrc`, lagging mirror) cannot reject a version the
 *   check already advertised.
 * - `--config.minimumReleaseAge=0` overrides an ambient `minimumReleaseAge`
 *   for this invocation: pnpm's global install reads its settings from the
 *   workspace `.npmrc`/`pnpm-workspace.yaml`, and self-update installs the
 *   exact pinned manifests the version check just advertised, so a
 *   supply-chain cooldown must not reject them (same check-vs-installer
 *   divergence class as #1686). pnpm resolves metadata on every invocation
 *   — there is no manifest snapshot to bypass, so no cache flag is needed.
 *
 * Together these flags make `oyp update` produce exactly the registry lookup
 * the version check just performed. See #1686.
 *
 * Also pins {@link NATIVES_PACKAGE} and the platform-specific
 * `@oh-my-pi/pi-natives-<tag>` leaf to `expectedVersion`. `pnpm add -g`
 * does not reliably refresh transitive `optionalDependencies` when the
 * top-level package is the only one bumped, so the native addon and its
 * version sentinel can drift out of sync with the freshly installed
 * `@oh-my-pi/pi-coding-agent` and the loader aborts at
 * `validateLoadedBindings` on the next launch
 * (`The .node file on disk is from a different release than this loader`).
 * Listing the natives explicitly forces pnpm to replace them in lock-step.
 * The leaf is added only on tags the release pipeline actually publishes
 * ({@link SUPPORTED_NATIVE_TAGS}) so unsupported platforms still fail with
 * the original "no matching version" message instead of `EBADPLATFORM`.
 * See #1824.
 */
export function buildPnpmInstallArgs(
	expectedVersion: string,
	nativeTag: string = currentNativeTag(),
	packages: ReleasePackages = CURRENT_PACKAGES,
	options: { registry?: string } = {},
): string[] {
	return [
		"add",
		"-g",
		"--config.minimumReleaseAge=0",
		`--registry=${options.registry ?? DEFAULT_NPM_REGISTRY}`,
		...buildVersionedPackageInstallArgs(expectedVersion, nativeTag, packages),
	];
}

/**
 * Build the npm argv used to update npm-managed global installs.
 * Pins `--registry` to the checked registry for the same reason as
 * {@link buildPnpmInstallArgs}.
 *
 * `force` is set only for rename migrations: npm refuses to write the `omp`
 * bin while the old package still owns it (`EEXIST`), and the migration
 * installs the new package BEFORE removing the old one so a failed install
 * never leaves the user without a working `omp`.
 */
export function buildNpmInstallArgs(
	expectedVersion: string,
	nativeTag: string = currentNativeTag(),
	packages: ReleasePackages = CURRENT_PACKAGES,
	flags: { force?: boolean; registry?: string } = {},
): string[] {
	return [
		"install",
		"-g",
		...(flags.force ? ["--force"] : []),
		`--registry=${flags.registry ?? DEFAULT_NPM_REGISTRY}`,
		...buildVersionedPackageInstallArgs(expectedVersion, nativeTag, packages),
	];
}

/**
 * Env overlay for npm self-update installs. Setting the same key,
 * `npm_config_min_release_age: "0"`, outranks any ambient `min-release-age`
 * or `before` from npmrc files on every npm that supports release-age gates
 * (env beats file sources; age 0 flattens to no cutoff). Do NOT use
 * `npm_config_before` here: npm 11.10.0-11.14.x declared `before` and
 * `min-release-age` mutually exclusive across sources and abort config
 * loading with a TypeError when one comes from env and the other from an
 * npmrc file, turning the targeted scenario into a hard npm failure.
 * npm predating the feature warns "Unknown env config" for the key, so
 * callers pass `supportsReleaseAgeOverride` from a probe.
 */
export function buildNpmUpdateEnv(
	base: Record<string, string | undefined> = process.env,
	supportsReleaseAgeOverride = true,
): Record<string, string | undefined> {
	if (!supportsReleaseAgeOverride) return base;
	return { ...base, npm_config_min_release_age: "0" };
}

/**
 * Build the attended mise update command.
 *
 * `--before 0s` overrides global and per-tool release-age settings for this
 * invocation. Unlike `MISE_MINIMUM_RELEASE_AGE`, the command option has the
 * precedence required when the tool entry itself sets `minimum_release_age`.
 * `--before` is accepted by mise releases with release-age filtering and is
 * the hidden compatibility name for `--minimum-release-age` in current mise.
 * Older mise releases predate the option and reject unknown flags, so callers
 * omit it when the installed command help does not advertise either name.
 */
export function buildMiseUpgradeArgs(supportsReleaseAgeOverride = true): string[] {
	return ["upgrade", MISE_TOOL, "--bump", ...(supportsReleaseAgeOverride ? ["--before", "0s"] : [])];
}

export function buildMiseUpdateEnv(
	base: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
	return { ...base, MISE_MINIMUM_RELEASE_AGE: "0s" };
}

export function buildMiseForceInstallArgs(expectedVersion: string): string[] {
	return ["install", "--force", `${MISE_TOOL}@${expectedVersion}`];
}

/**
 * Old-name globals a rename migration removes after the new install exists:
 * the set difference between the old install's top-level globals
 * ({@link buildVersionedPackageInstallArgs} installs the agent, natives core,
 * and platform leaf explicitly) and the resolved install's. An agent-only
 * rename keeps the natives names, and removing them would strip the addon
 * the new install just pinned.
 */
export function buildRenameCleanupPackages(
	packages: ReleasePackages,
	nativeTag: string = currentNativeTag(),
): string[] {
	const old = [PACKAGE, NATIVES_PACKAGE];
	if (SUPPORTED_NATIVE_TAGS.has(nativeTag)) {
		old.push(`${NATIVES_PACKAGE}-${nativeTag}`);
	}
	const newLeaf = `${packages.natives}-${nativeTag}`;
	return old.filter(name => name !== packages.pkg && name !== packages.natives && name !== newLeaf);
}

/** Injectable shell steps for {@link migrateRenamedInstall}; commands return process exit codes. */
export interface RenameMigrationSteps {
	/** Globally install the new package names. MUST be idempotent: re-running re-links the `omp` bin. */
	install(): Promise<number>;
	/** Remove the old-name globals. */
	removeOld(): Promise<number>;
	/** Check the PATH-resolved `omp` against the expected version. */
	verify(): Promise<InstalledVersionVerification>;
}

/** Production {@link RenameMigrationSteps}: pnpm/npm global installs plus PATH verification. */
function packageManagerMigrationSteps(manager: "pnpm" | "npm", release: ReleaseInfo): RenameMigrationSteps {
	const nativeTag = currentNativeTag();
	return {
		async install() {
			if (manager === "pnpm") {
				const args = buildPnpmInstallArgs(release.version, nativeTag, release.packages, {
					registry: release.registry,
				});
				return (await $`pnpm ${args}`.nothrow()).exitCode ?? 1;
			}
			const args = buildNpmInstallArgs(release.version, nativeTag, release.packages, {
				force: true,
				registry: release.registry,
			});
			return (
				(await $`npm ${args}`.env(buildNpmUpdateEnv(process.env, await npmSupportsReleaseAgeOverride())).nothrow())
					.exitCode ?? 1
			);
		},
		async removeOld() {
			// One invocation per package: a single batched remove fails wholesale
			// when any name is absent (e.g. the platform leaf on an old install),
			// which would skip the agent package that actually owns the bin.
			let agentExit = 0;
			for (const pkg of buildRenameCleanupPackages(release.packages, nativeTag)) {
				const result =
					manager === "pnpm"
						? await $`pnpm remove -g ${pkg}`.quiet().nothrow()
						: await $`npm uninstall -g ${pkg}`.quiet().nothrow();
				if (pkg === PACKAGE) agentExit = result.exitCode ?? 1;
			}
			return agentExit;
		},
		verify: () => verifyInstalledVersion(release.version),
	};
}

/**
 * Migrate a package-manager install across an `omp.rename` hop without a
 * window where no working `omp` exists:
 *
 * 1. Install the new package FIRST. Nothing has been removed yet, so a
 *    failure here leaves the old install fully functional.
 * 2. Remove the old-name globals. Failure is non-fatal: a stale package
 *    wastes disk, but the bin already points at the new install.
 * 3. Verify the PATH-resolved `omp`. If the removal deleted the shared bin
 *    link (manager-dependent), re-run the idempotent install to restore it
 *    and verify again; only a repeated failure aborts, with a recovery hint.
 */
export async function migrateRenamedInstall(release: ReleaseInfo, steps: RenameMigrationSteps): Promise<void> {
	console.log(chalk.dim(`npm package renamed to ${release.packages.pkg}; migrating this install.`));
	const installExit = await steps.install();
	if (installExit !== 0) {
		throw new Error(
			`install of ${release.packages.pkg} failed with exit code ${installExit}; the existing install was left untouched`,
		);
	}

	const removeExit = await steps.removeOld();
	if (removeExit !== 0) {
		console.log(chalk.yellow(`Warning: could not remove the old ${PACKAGE} package; remove it manually later.`));
	}

	let verification = await steps.verify();
	if (!verification.ok) {
		// Removing the old package may have taken the shared bin link with it;
		// reinstalling the new package restores the link.
		if ((await steps.install()) === 0) {
			verification = await steps.verify();
		}
	}
	if (!verification.ok) {
		throw new Error(
			`${formatVerificationFailure(verification, release.version)}; reinstall with: ${installerHint()}`,
		);
	}
	printVerifiedVersion(release.version);
}

/**
 * npm predating `min-release-age` (11.10.0, npm/cli#8965) warns "Unknown env
 * config" for the overlay key and gains nothing from it. Probed from a neutral
 * directory: inside an npm workspaces checkout the config query exits with
 * ENOWORKSPACES before it ever reads the key.
 */
async function npmSupportsReleaseAgeOverride(): Promise<boolean> {
	const probe = await $`npm config get min-release-age`.cwd(os.tmpdir()).quiet().nothrow();
	return probe.exitCode === 0 && probe.text().trim() !== "undefined";
}

/**
 * Update via package manager.
 *
 * Returns the PATH-resolved launcher check so the caller can repair a launcher
 * the manager left unusable, or `undefined` when a rename migration already
 * verified and reported its own result.
 */
async function updateViaPnpm(release: ReleaseInfo): Promise<InstalledVersionVerification | undefined> {
	console.log(chalk.dim("Updating via pnpm..."));
	if (release.packages.pkg !== PACKAGE) {
		await migrateRenamedInstall(release, packageManagerMigrationSteps("pnpm", release));
		return undefined;
	}
	const args = buildPnpmInstallArgs(release.version, currentNativeTag(), release.packages, {
		registry: release.registry,
	});
	const result = await $`pnpm ${args}`.nothrow();
	if (result.exitCode !== 0) {
		throw new Error(`pnpm add failed with exit code ${result.exitCode}`);
	}
	return await verifyInstalledVersion(release.version);
}

async function updateViaNpm(release: ReleaseInfo): Promise<InstalledVersionVerification | undefined> {
	console.log(chalk.dim("Updating via npm..."));
	if (release.packages.pkg !== PACKAGE) {
		await migrateRenamedInstall(release, packageManagerMigrationSteps("npm", release));
		return undefined;
	}
	const args = buildNpmInstallArgs(release.version, currentNativeTag(), release.packages, {
		registry: release.registry,
	});
	const result = await $`npm ${args}`
		.env(buildNpmUpdateEnv(process.env, await npmSupportsReleaseAgeOverride()))
		.nothrow();
	if (result.exitCode !== 0) {
		throw new Error(`npm install failed with exit code ${result.exitCode}`);
	}

	return await verifyInstalledVersion(release.version);
}
/** Injectable steps for {@link updateViaManager}; mirrors {@link RenameMigrationSteps}. */
export interface ManagerUpdateSteps {
	/** Manager name used in progress and recovery messages. */
	manager: string;
	/**
	 * Run the manager's global install. Resolves to the PATH-resolved launcher
	 * check, or `undefined` when a rename migration already verified and
	 * reported its own result.
	 */
	install(): Promise<InstalledVersionVerification | undefined>;
	/** Re-check the PATH-resolved launcher after the install threw. */
	verify(): Promise<InstalledVersionVerification>;
	/** Take `launcherPath` over with the standalone release binary. */
	repair(launcherPath: string): Promise<void>;
}

/**
 * Production {@link ManagerUpdateSteps}: a pnpm/npm global install plus an
 * in-place takeover with the released binary of the same version.
 */
function packageManagerUpdateSteps(manager: "pnpm" | "npm", release: ReleaseInfo): ManagerUpdateSteps {
	return {
		manager,
		install: () => (manager === "pnpm" ? updateViaPnpm(release) : updateViaNpm(release)),
		verify: () => verifyInstalledVersion(release.version),
		repair: async launcherPath => {
			const build = await fetchBuild({ version: release.version });
			// npm's script shims outrank `.exe` in PowerShell and Git Bash, so
			// they must be retired rather than merely shadowed.
			if (isWindowsScriptLauncherPath(launcherPath)) {
				await updateViaShimTakeover(launcherPath, build);
			} else {
				await updateViaBinaryAt(launcherPath, build);
			}
		},
	};
}

/**
 * Run a package-manager self-update, repairing the launcher when the manager
 * succeeds without updating it or leaves no working launcher behind.
 *
 * A global reinstall has to replace files the running process still holds open.
 * On Windows that is unavoidable — the launcher image, the loaded native addon,
 * and the package tree being executed are all locked. pnpm writes fresh bin
 * shims before the old package tree is replaced, while npm can retire its
 * shims before an install fails.
 *
 * A successful install whose PATH launcher still reports an older version
 * means the manager no longer controls that launcher, so it is taken over with
 * the standalone binary. A newer launcher may have been installed by a
 * concurrent update and is left untouched. If the install itself failed, a
 * launcher that still reports a version is preserved and the manager error is
 * surfaced; only a missing or unusable launcher is repaired.
 */
export async function updateViaManager(
	release: ReleaseInfo,
	launcherPath: string | undefined,
	steps: ManagerUpdateSteps,
): Promise<void> {
	let installError: unknown;
	let verification: InstalledVersionVerification | undefined;
	try {
		verification = await steps.install();
		// A rename migration verifies and reports on its own.
		if (!verification) return;
	} catch (err) {
		installError = err;
	}
	const result = verification ?? (await steps.verify());
	const launcherIsBroken = result.path === undefined || result.actual === undefined;
	const launcherIsOlder =
		installError === undefined && result.actual !== undefined && compareVersions(result.actual, release.version) < 0;
	const launcherNeedsRepair = !result.ok && (launcherIsBroken || launcherIsOlder);
	if (!launcherNeedsRepair) {
		if (installError) throw installError;
		printVerificationResult(result, release.version);
		return;
	}
	if (!launcherPath) {
		throw installError ?? new Error(formatVerificationFailure(result, release.version));
	}
	console.log(
		chalk.yellow(
			`\n${steps.manager} did not install a working ${APP_NAME} ${release.version} launcher (${formatVerificationFailure(result, release.version)}); installing the standalone binary at ${launcherPath}.`,
		),
	);
	try {
		await steps.repair(launcherPath);
	} catch (err) {
		throw new Error(`${steps.manager} update did not produce a working launcher and binary repair failed: ${err}`, {
			cause: installError ?? err,
		});
	}
	console.log(
		chalk.yellow(
			`This install is no longer managed by ${steps.manager}. Removing the old global package may delete this launcher; if it does, reinstall with: ${installerHint()}`,
		),
	);
}

async function updateViaMise(expectedVersion: string, force: boolean): Promise<void> {
	console.log(chalk.dim("Updating via mise..."));
	const env = buildMiseUpdateEnv();
	const help = await $`mise upgrade --help`.env(env).quiet().nothrow();
	const supportsReleaseAgeOverride = help.exitCode === 0 && /(?:--minimum-release-age|--before)\b/.test(help.text());
	const args = buildMiseUpgradeArgs(supportsReleaseAgeOverride);
	const result = await $`mise ${args}`.env(env).nothrow();
	if (result.exitCode !== 0) {
		throw new Error(`mise upgrade failed with exit code ${result.exitCode}`);
	}

	if (force) {
		const forceArgs = buildMiseForceInstallArgs(expectedVersion);
		const forceResult = await $`mise ${forceArgs}`.env(env).nothrow();
		if (forceResult.exitCode !== 0) {
			throw new Error(`mise install --force failed with exit code ${forceResult.exitCode}`);
		}
	}

	await printVerification(expectedVersion);
}

// Monotonic within this process so two updates started in the same millisecond
// (same pid, same `Date.now()`) still get distinct temp/backup paths. Kept
// numeric so the artifact sweep's `\d+(\.\d+)*` matcher still reclaims them.
let updateAttemptSeq = 0;

/** Network seam for installing a {@link BuildAnswer}. */
export interface BuildDownloadOptions {
	fetchImpl?: Fetch;
}

/**
 * Write the answered build to `tempPath`, verified against the release's size
 * and SHA-256.
 */
async function downloadBuild(
	build: BuildAnswer,
	paths: { tempPath: string },
	options: BuildDownloadOptions,
): Promise<void> {
	console.log(chalk.dim(`Downloading ${build.file.name} (${formatBytes(build.file.size)})…`));
	await downloadVerifiedBinary({
		url: build.download,
		targetPath: paths.tempPath,
		expectedSize: build.file.size,
		expectedDigest: `sha256:${build.file.sha256}`,
		fetchImpl: options.fetchImpl,
	});
	console.log(chalk.dim(`Verified sha256:${build.file.sha256}`));
}

/**
 * Install the answered build at `targetPath`, replacing an existing file.
 */
export async function updateViaBinaryAt(
	targetPath: string,
	build: BuildAnswer,
	options: BuildDownloadOptions & {
		/** Refuse replacement unless the existing path is a non-script OMP executable. */
		validateExistingTarget?: boolean;
		verifyInstalledVersion?: typeof verifyInstalledVersion;
	} = {},
): Promise<void> {
	if (options.validateExistingTarget) await validateExistingUpdateTarget(targetPath);
	// Unique per attempt so two overlapping `oyp update` runs never share a temp
	// or backup path. A fixed temp name (`<binary>.new`) let the second run's
	// pre-download unlink delete the first run's still-downloading temp file; the
	// first kept writing to its open fd (size + digest still passed), then chmod
	// hit the missing path and the update aborted (issue #8434). The backup needs
	// the same uniqueness: a stale backup from an earlier update may still be
	// locked (the previous process image on Windows), so a fixed name would force
	// the move-aside rename to overwrite it. pid, timestamp, and a process-local
	// counter keep two updates started in the same millisecond from colliding.
	const attempt = `${Date.now()}.${process.pid}.${updateAttemptSeq++}`;
	const tempPath = `${targetPath}.${attempt}.new`;
	const backupPath = `${targetPath}.${attempt}.bak`;
	await downloadBuild(build, { tempPath }, options);

	// Serialize the target swap and stale-artifact sweep per target so two
	// overlapping `oyp update` runs never replace the same binary concurrently
	// or reclaim each other's live backup/temp files. The download above writes
	// to a unique temp path and is safe to overlap; only the swap is shared.
	const verification = await withFileLock(targetPath, async () => {
		console.log(chalk.dim("Installing update..."));
		const result = await replaceBinaryForUpdate({
			targetPath,
			tempPath,
			backupPath,
			expectedVersion: build.version,
			verifyInstalledVersion: options.verifyInstalledVersion ?? (version => verifyBinaryAtPath(targetPath, version)),
		});
		// Reclaim backups from earlier updates whose owning process has since exited.
		await sweepStaleUpdateArtifacts(targetPath);
		return result;
	});
	printVerifiedVersion(build.version, verification.path ?? targetPath);
	console.log(chalk.dim(`Restart ${APP_NAME} to use the new version`));
}

/**
 * In-place forwarder bodies, by shim extension, for launchers that cannot be
 * renamed aside during a script-shim takeover; each execs the sibling
 * `omp.exe`. Rewriting matters for the shims that outrank `.exe` at command
 * resolution: PowerShell prefers `.ps1` and Git Bash resolves the
 * extensionless sh shim first, so leaving the old body behind would keep
 * launching the replaced install.
 */
const SHIM_FORWARDERS: Record<string, string> = {
	"": `#!/bin/sh\nexec "$(dirname "$0")/${APP_NAME}.exe" "$@"\n`,
	".cmd": `@"%~dp0${APP_NAME}.exe" %*\r\n`,
	".bat": `@"%~dp0${APP_NAME}.exe" %*\r\n`,
	".ps1": `& "$PSScriptRoot\\${APP_NAME}.exe" @args\nexit $LASTEXITCODE\n`,
};

/**
 * Take over a Windows script-launcher install for a binary-only release.
 *
 * npm-managed Windows installs are launched through script shims
 * (`omp`/`omp.cmd`/`omp.ps1`) that cannot be overwritten with a native
 * executable. The release binary is installed as `omp.exe` beside them and
 * the shims are then renamed aside: cmd.exe would already prefer `.exe` via
 * PATHEXT, but PowerShell resolves `.ps1` first, so the takeover only sticks
 * once the shims are out of the way. A working launcher exists at every
 * step — the exe lands before any shim moves, a shim that refuses to move
 * (a running `.cmd` can be renamed but may be held open some other way) is
 * rewritten in place as a forwarder to the exe, and a failed version
 * verification moves everything back.
 */
export async function updateViaShimTakeover(
	shimPath: string,
	build: BuildAnswer,
	options: BuildDownloadOptions & { verifyBinary?: typeof verifyBinaryAtPath } = {},
): Promise<void> {
	const launcherDir = path.dirname(shimPath);
	const exePath = path.join(launcherDir, `${APP_NAME}.exe`);
	const attempt = `${Date.now()}.${process.pid}.${updateAttemptSeq++}`;
	const tempPath = `${exePath}.${attempt}.new`;
	await downloadBuild(build, { tempPath }, options);
	const forwarded: Array<{ launcher: string; original: string }> = [];
	const stuck: string[] = [];
	// Serialize the launcher swap and artifact sweep so two overlapping updates
	// never retire the same shims or reclaim a live run's backup before its
	// verification can roll it back.
	await withFileLock(exePath, async () => {
		console.log(chalk.dim(`Installing ${APP_NAME}.exe beside the script launcher...`));
		await fs.promises.rename(tempPath, exePath);
		// Retire the shims so PATH resolution lands on the new exe. Renamed, not
		// deleted: restorable on verification failure, and Windows permits
		// renaming a batch file that is still executing. A shim that cannot be
		// renamed (held open without delete sharing) is rewritten in place as a
		// forwarder to the exe — write and rename take different Windows locks,
		// so one can succeed where the other fails.
		const backupSuffix = `${attempt}.bak`;
		const retired: Array<{ launcher: string; backup: string }> = [];
		for (const ext of ["", ".cmd", ".ps1", ".bat"]) {
			const launcher = path.join(launcherDir, `${APP_NAME}${ext}`);
			const backup = `${launcher}.${backupSuffix}`;
			try {
				await fs.promises.rename(launcher, backup);
				retired.push({ launcher, backup });
			} catch (err) {
				if (isEnoent(err)) continue;
				try {
					const original = await fs.promises.readFile(launcher, "utf8");
					await fs.promises.writeFile(launcher, SHIM_FORWARDERS[ext]);
					forwarded.push({ launcher, original });
				} catch {
					stuck.push(launcher);
				}
			}
		}

		// Verify the exe by its explicit path: $which cached the shim path when
		// the update target was resolved, and the shim was just renamed away, so
		// a PATH re-resolution here would test a file that no longer exists.
		const verify = options.verifyBinary ?? verifyBinaryAtPath;
		const verification = await verify(exePath, build.version);
		if (!verification.ok) {
			for (const { launcher, backup } of retired) {
				try {
					await fs.promises.rename(backup, launcher);
				} catch {}
			}
			for (const { launcher, original } of forwarded) {
				try {
					await fs.promises.writeFile(launcher, original);
				} catch {}
			}
			await unlinkIfExists(exePath);
			throw new Error(
				`${formatVerificationFailure(verification, build.version)}; restored previous ${APP_NAME} launcher`,
			);
		}
		for (const { backup } of retired) {
			await removeBackupBestEffort(backup);
		}
		// Reclaim exe backups and retired-shim leftovers from earlier attempts.
		for (const ext of [".exe", "", ".cmd", ".ps1", ".bat"]) {
			await sweepStaleUpdateArtifacts(path.join(launcherDir, `${APP_NAME}${ext}`));
		}
	});
	for (const { launcher } of forwarded) {
		console.log(chalk.dim(`Converted ${launcher} to a forwarder (it could not be removed).`));
	}
	for (const launcher of stuck) {
		console.log(
			chalk.yellow(
				`Could not retire ${launcher}; shells that prefer it may keep launching the old version until it is deleted manually.`,
			),
		);
	}
	printVerifiedVersion(build.version);
	console.log(chalk.dim(`Restart ${APP_NAME} to use the new version`));
}

/**
 * Platform-appropriate installer one-liner for recovery instructions.
 *
 * Forces the installer's binary mode (`--binary` / `-Binary`): the default
 * mode prefers a package-manager install whenever a supported manager is
 * present, which would send a user recovering from a binary-only release
 * straight back through one.
 */
function installerHint(): string {
	return process.platform === "win32"
		? "& ([scriptblock]::Create((irm https://omp.sh/install.ps1))) -Binary"
		: "curl -fsSL https://omp.sh/install | sh -s -- --binary";
}

/** Persisted channel, or undefined when settings are unavailable (SDK/test embedding without `Settings.init()`). */
function readPersistedChannel(): UpdateChannel | undefined {
	try {
		return cfgUpdateChannel.get(settings);
	} catch {
		return undefined;
	}
}

/** Persist an explicit channel switch; tolerated as a no-op when settings are unavailable. */
function persistChannel(channel: UpdateChannel): void {
	try {
		cfgUpdateChannel.set(settings, channel);
	} catch {
		// Outside a CLI host the explicit flag still applied for this run.
	}
}

type BinaryUpdateTarget = Extract<UpdateTarget, { method: "binary" }>;
type ManagedUpdateTarget = Exclude<UpdateTarget, { method: "binary" }>;

/** What `oyp update` was asked to do, after resolving the channel. */
interface UpdateRequest {
	force: boolean;
	check: boolean;
	channel: UpdateChannel;
	/** An explicit channel differing from the persisted one. */
	isChannelSwitch: boolean;
	/** Persist `channel` once the update succeeds (`--canary`/`--stable` given). */
	persistChannel: boolean;
}

/**
 * Print how the offered `version` relates to the running build. Returns false
 * when there is nothing to install: not newer, and neither `--force` nor a
 * channel switch asks for it.
 */
function announceOffer(version: string, request: UpdateRequest): boolean {
	const comparison = compareVersions(version, VERSION);
	if (comparison <= 0 && !request.force && !request.isChannelSwitch) {
		const icon = theme?.status?.success ?? "✔";
		console.log(chalk.green(`${icon} Already up to date`));
		return false;
	}
	if (request.isChannelSwitch) {
		console.log(
			chalk.yellow(
				`Switching to ${request.channel} ${version}${comparison < 0 ? ` (downgrade from ${VERSION})` : ""}`,
			),
		);
	} else if (comparison > 0) {
		console.log(chalk.cyan(`New version available: ${version}`));
	} else {
		console.log(chalk.yellow(`Forcing reinstall of ${version}`));
	}
	return true;
}

/**
 * Update a standalone binary install from GitHub Releases: the newest release
 * on the channel. npm is never consulted.
 */
async function runBinaryUpdate(
	target: BinaryUpdateTarget | undefined,
	targetError: unknown,
	request: UpdateRequest,
): Promise<void> {
	let build: BuildAnswer;
	try {
		build = await fetchBuild({ channel: request.channel });
	} catch (err) {
		console.error(chalk.red(`Failed to check for updates: ${err}`));
		process.exit(1);
	}
	if (!announceOffer(build.version, request) || request.check) return;

	try {
		if (!target) throw targetError;
		await updateViaBinaryAt(target.path, build, { validateExistingTarget: target.validateExistingTarget });
		if (request.persistChannel) persistChannel(request.channel);
	} catch (err) {
		console.error(chalk.red(`Update failed: ${err}`));
		process.exit(1);
	}
}

/**
 * Replace a pnpm/npm install with the standalone binary because npm says the
 * release is binary-only ({@link shouldForceBinaryUpdate}).
 *
 * The launcher is resolved again without package-manager routing: a manager
 * symlink is taken over in place, a Windows script launcher gets `omp.exe`
 * beside it. The binary is the newest release on the channel. A build older
 * than npm's release that would not move the install forward means the
 * release is still uploading, so the update stops instead of reinstalling or
 * downgrading.
 */
async function updateToStandaloneBinary(
	manager: "pnpm" | "npm",
	release: ReleaseInfo,
	channel: UpdateChannel,
): Promise<void> {
	const target = await resolveUpdateTarget({ allowPackageManagers: false });
	const build = await fetchBuild({ channel });
	if (compareVersions(build.version, release.version) < 0 && compareVersions(build.version, VERSION) <= 0) {
		throw new Error(
			`${release.version} ships as a standalone binary, but the newest ${channel} build of it published for this platform is ${build.version}; retry in a few minutes once it finishes uploading, or reinstall with: ${installerHint()}`,
		);
	}
	if (build.version !== release.version) {
		console.log(chalk.dim(`Installing the newest published ${channel} build, ${build.version}.`));
	}
	const unmanaged = `This install is no longer managed by ${manager}. Removing the old global package may delete this launcher; if it does, reinstall with: ${installerHint()}`;
	if (target.method === "binary") {
		if (target.replacesSymlink) {
			console.log(chalk.dim("Replacing the package-manager launcher with the standalone binary."));
		}
		await updateViaBinaryAt(target.path, build, { validateExistingTarget: target.validateExistingTarget });
		if (target.replacesSymlink) console.log(chalk.yellow(unmanaged));
		return;
	}
	// A Windows script shim is the only manager-owned shape that reaches here
	// without package-manager routing; its path is known, so it can be retired
	// in favour of the sibling `omp.exe`.
	if ((target.method !== "pnpm" && target.method !== "npm") || !target.path) {
		throw new Error(`Could not resolve ${APP_NAME} launcher path in PATH`);
	}
	console.log(chalk.dim("This release ships as a standalone binary; replacing the script launcher."));
	await updateViaShimTakeover(target.path, build);
	console.log(chalk.yellow(unmanaged));
}

/**
 * Update a package-manager install (pnpm, npm, mise, Nix) to npm's
 * release for the channel.
 */
async function runManagedUpdate(
	target: ManagedUpdateTarget | undefined,
	targetError: unknown,
	request: UpdateRequest,
): Promise<void> {
	let release: ReleaseInfo;
	try {
		release = await getLatestRelease({ channel: request.channel });
	} catch (err) {
		console.error(chalk.red(`Failed to check for updates: ${err}`));
		process.exit(1);
	}
	if (!announceOffer(release.version, request)) return;
	if (release.packages.pkg !== PACKAGE) {
		console.log(chalk.cyan(`The npm package moved to ${release.packages.pkg}; updating migrates this install.`));
	}
	if (request.check) return;

	try {
		if (!target) throw targetError;
		if (request.channel === "canary" && (target.method === "nix" || target.method === "mise")) {
			console.log(chalk.yellow("Canary updates are only supported for pnpm, npm, or binary installs."));
			return;
		}
		if (target.method === "nix") {
			console.log(chalk.yellow("This installation is managed by Nix and cannot update itself."));
			console.log(chalk.dim("Update the flake input or profile that provides omp, then rebuild."));
			return;
		}
		if (target.method === "mise") {
			await updateViaMise(release.version, request.force);
		} else if (shouldForceBinaryUpdate(release)) {
			await updateToStandaloneBinary(target.method, release, request.channel);
		} else {
			await updateViaManager(release, target.path, packageManagerUpdateSteps(target.method, release));
		}
		if (request.persistChannel) persistChannel(request.channel);
	} catch (err) {
		console.error(chalk.red(`Update failed: ${err}`));
		process.exit(1);
	}
}

/**
 * Run the update command.
 *
 * The installer that owns the PATH `omp` decides where the version comes
 * from: a standalone binary asks GitHub Releases, a package-manager install
 * asks npm. When no target resolves, the running build's kind decides, so
 * `--check` still answers; installing then fails on the unresolved target.
 */
export async function runUpdateCommand(opts: {
	force: boolean;
	check: boolean;
	channel?: UpdateChannel;
}): Promise<void> {
	const ompPath = resolveOmpPath();
	const manager = ompPath ? await managedInstallName(ompPath) : undefined;
	if (manager) {
		console.log(
			chalk.yellow(`${ompPath} is installed and kept up to date by ${manager}; update it from ${manager}.`),
		);
		return;
	}
	// `update.channel` picks the channel; --canary/--stable switch and persist it.
	await Settings.init({ cwd: getProjectDir() });
	console.log(chalk.dim(`Current version: ${VERSION}`));
	const persistedChannel = readPersistedChannel() ?? "stable";
	const channel = opts.channel ?? persistedChannel;
	if (channel === "canary") console.log(chalk.dim("Current channel: canary"));
	const request: UpdateRequest = {
		force: opts.force,
		check: opts.check,
		channel,
		isChannelSwitch: opts.channel !== undefined && opts.channel !== persistedChannel,
		persistChannel: opts.channel !== undefined,
	};

	let target: UpdateTarget | undefined;
	let targetError: unknown;
	try {
		target = await resolveUpdateTarget({ allowPackageManagers: true });
	} catch (err) {
		targetError = err;
	}
	if (target?.method === "binary") {
		await runBinaryUpdate(target, targetError, request);
	} else if (!target && isCompiledBinary()) {
		await runBinaryUpdate(undefined, targetError, request);
	} else {
		await runManagedUpdate(target, targetError, request);
	}
}

/**
 * Print update command help.
 */
export function printUpdateHelp(): void {
	console.log(`${chalk.bold(`${APP_NAME} update`)} - Check for and install updates

${chalk.bold("Usage:")}
  ${APP_NAME} update [options]

${chalk.bold("Options:")}
  -c, --check     Check for updates without installing
  -f, --force     Force reinstall even if up to date
  -l, --plugins   Update installed plugins
  --canary        Switch to the canary channel and update
  --stable        Switch back to the stable channel

${chalk.bold("Examples:")}
  ${APP_NAME} update              Update to latest version
  ${APP_NAME} update --check      Check if updates are available
  ${APP_NAME} update --force      Force reinstall
  ${APP_NAME} update -l           Update installed plugins
  ${APP_NAME} update --canary    Switch to the canary channel and update
`);
}
