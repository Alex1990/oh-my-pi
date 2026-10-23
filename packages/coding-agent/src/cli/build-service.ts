/**
 * Resolve oyp's standalone binaries from GitHub Releases.
 *
 * `oyp update` on a standalone binary install, the binary takeover of a
 * package-manager install, and the startup update check of a compiled binary
 * all ask GitHub which release to install ({@link fetchBuild}):
 *
 * - the newest stable release (`/releases/latest`);
 * - the newest prerelease (`/releases`, canary channel);
 * - one exact tag (`/releases/tags/v<version>`).
 *
 * Every release publishes the platform launchers (`oyp-<os>-<arch>`), the
 * shared `cli.js` bundle, and `SHA256SUMS.txt`. The checksum file is the trust
 * anchor: the binary's SHA-256 is read from it rather than from the asset
 * metadata.
 *
 * The repository is `OMP_RELEASE_REPO` ({@link DEFAULT_RELEASE_REPO} when
 * unset). `OMP_RELEASE_API` overrides the API base for tests and mirrors.
 * Requests carry `User-Agent: oyp/<version>`.
 */
import * as fs from "node:fs";
import { $env, APP_NAME, isRecord, VERSION } from "@oh-my-pi/pi-utils";
import { $ } from "@oh-my-pi/pi-utils/shell";
import {
	isTimeoutError,
	isUnsupportedProxyError,
	unsupportedProxyMessage,
	withTimeoutSignal,
} from "../utils/fetch-timeout";

export type UpdateChannel = "stable" | "canary";

export type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Repository that hosts oyp's releases. */
export const DEFAULT_RELEASE_REPO = "Alex1990/oh-your-pi";

/** The product name upstream builds are published under. */
export const UPSTREAM_PRODUCT = "omp";

/** Release repository: `OMP_RELEASE_REPO`, else {@link DEFAULT_RELEASE_REPO}. */
export function releaseRepo(): string {
	const configured = ($env.OMP_RELEASE_REPO ?? "").trim().replace(/^\/+|\/+$/g, "");
	return configured || DEFAULT_RELEASE_REPO;
}

/** GitHub API repository base; `OMP_RELEASE_API` overrides it for tests and mirrors. */
export function releaseApiBase(): string {
	const configured = ($env.OMP_RELEASE_API ?? "").trim().replace(/\/+$/, "");
	return configured || `https://api.github.com/repos/${releaseRepo()}`;
}

const BUILD_CHECK_TIMEOUT_MS = 30_000;
const CHECKSUM_FILE = "SHA256SUMS.txt";

/** Where this host's builds live in a release. */
export interface BuildHost {
	/** Release asset name for this host, e.g. `oyp-darwin-arm64` or `oyp-windows-x64.cmd`. */
	fileName: string;
}

/** The release asset name for a platform, architecture, and libc. */
export function resolveBuildHost(platform: NodeJS.Platform, arch: string, musl: boolean): BuildHost {
	let fileOs: string;
	switch (platform) {
		case "darwin":
			fileOs = "darwin";
			break;
		case "linux":
			fileOs = musl ? "linux-musl" : "linux";
			break;
		case "win32":
			fileOs = "windows";
			break;
		default:
			throw new Error(`Unsupported platform: ${platform}`);
	}
	if (arch !== "x64" && arch !== "arm64") throw new Error(`Unsupported architecture: ${arch}`);
	const suffix = platform === "win32" ? ".cmd" : "";
	return { fileName: `${UPSTREAM_PRODUCT}-${fileOs}-${arch}${suffix}` };
}

/**
 * Detect a musl-libc Linux host (Alpine, Void-musl) so self-update replaces a
 * musl binary with the musl build instead of the glibc one, which would fail
 * to start on the next run. The loader file alone is not sufficient: glibc
 * hosts may have musl installed for cross-compilation.
 */
interface MuslDetectionOptions {
	platform: NodeJS.Platform;
	alpineRelease: boolean;
	lddOutput: string;
}

function isMuslLinux(options: MuslDetectionOptions): boolean {
	if (options.platform !== "linux") return false;
	return options.alpineRelease || /\bmusl\b/i.test(options.lddOutput);
}

/** Test seam for libc detection. */
export function isMuslLinuxForTest(options: MuslDetectionOptions): boolean {
	return isMuslLinux(options);
}

async function detectLddOutput(): Promise<string> {
	try {
		const result = await $`ldd --version`.quiet().nothrow();
		return `${result.stdout.toString("utf-8")}\n${result.stderr.toString("utf-8")}`;
	} catch {
		return "";
	}
}

let currentHost: Promise<BuildHost> | undefined;

/** This host's {@link BuildHost}, detected once per process. */
export function currentBuildHost(): Promise<BuildHost> {
	currentHost ??= (async () => {
		const platform = process.platform;
		const musl =
			platform === "linux" &&
			isMuslLinux({
				platform,
				alpineRelease: fs.existsSync("/etc/alpine-release"),
				lddOutput: await detectLddOutput(),
			});
		return resolveBuildHost(platform, process.arch, musl);
	})();
	return currentHost;
}

/** The answered release's file for this host. */
export interface BuildFile {
	name: string;
	size: number;
	/** Lowercase hex SHA-256. */
	sha256: string;
}

/** A checked GitHub release answer. */
export interface BuildAnswer {
	version: string;
	/** Release tag as published, e.g. `v18.8.9`. */
	tag: string;
	file: BuildFile;
	/** HTTPS URL of the whole file. */
	download: string;
}

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function isSize(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isHttpsUrl(value: unknown): value is string {
	if (typeof value !== "string") return false;
	try {
		return new URL(value).protocol === "https:";
	} catch {
		return false;
	}
}

interface ReleaseAsset {
	name: string;
	size: number;
	download: string;
}

/** Tag of a release, or undefined when it is not a `v<semver>` release. */
function releaseVersion(tag: unknown): string | undefined {
	if (typeof tag !== "string") return undefined;
	const version = tag.startsWith("v") ? tag.slice(1) : tag;
	return SEMVER.test(version) ? version : undefined;
}

/**
 * Check a GitHub release payload for `fileName`.
 *
 * Throws when the release cannot be installed safely: a tag that is not
 * semver, a missing or malformed asset, a download that is not HTTPS, or a
 * missing checksum manifest. The checksum is looked up by exact file name.
 */
export function parseRelease(body: unknown, fileName: string, checksums: string): BuildAnswer {
	if (!isRecord(body)) throw new Error("release answer is not an object");
	const tag = body.tag_name;
	const version = releaseVersion(tag);
	if (typeof tag !== "string" || !version) throw new Error("release has no valid tag");
	if (body.draft === true) throw new Error(`release ${tag} is a draft`);
	const assets = body.assets;
	if (!Array.isArray(assets)) throw new Error("release has no assets");
	let file: ReleaseAsset | undefined;
	let checksumAsset: ReleaseAsset | undefined;
	for (const asset of assets) {
		if (!isRecord(asset)) continue;
		const name = asset.name;
		const size = asset.size;
		const download = asset.browser_download_url;
		if (typeof name !== "string" || !isSize(size) || typeof download !== "string") continue;
		if (name === fileName) file = { name, size, download };
		else if (name === CHECKSUM_FILE) checksumAsset = { name, size, download };
	}
	if (!file) throw new Error(`release ${tag} has no ${fileName} asset`);
	if (!isHttpsUrl(file.download)) throw new Error(`${fileName} has no HTTPS download`);
	if (!checksumAsset) throw new Error(`release ${tag} has no ${CHECKSUM_FILE} asset`);
	const sha256 = checksumFor(checksums, fileName);
	if (!sha256) throw new Error(`${CHECKSUM_FILE} has no entry for ${fileName}`);
	return {
		version,
		tag,
		file: { name: fileName, size: file.size, sha256 },
		download: file.download,
	};
}

/** The SHA-256 a `sha256sum`-compatible manifest lists for `fileName`. */
export function checksumFor(manifest: string, fileName: string): string | undefined {
	for (const line of manifest.split(/\r?\n/)) {
		const match = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(line.trim());
		if (match && match[2] === fileName) return match[1].toLowerCase();
	}
	return undefined;
}

/** Which release to ask for: the newest on a channel, or one exact version. */
export type BuildSelector = { channel: UpdateChannel } | { version: string };

export interface FetchBuildOptions {
	timeoutMs?: number;
	fetchImpl?: Fetch;
	/** Defaults to {@link currentBuildHost}. */
	host?: BuildHost;
}

async function fetchJson(url: string, options: FetchBuildOptions, what: string): Promise<unknown> {
	const timeoutMs = options.timeoutMs ?? BUILD_CHECK_TIMEOUT_MS;
	const headers: Record<string, string> = {
		Accept: "application/vnd.github+json",
		"User-Agent": `${APP_NAME}/${VERSION}`,
	};
	const token = ($env.GITHUB_TOKEN ?? "").trim();
	if (token) headers.Authorization = `Bearer ${token}`;
	const mapError = (err: unknown): unknown => {
		if (isTimeoutError(err)) {
			return new Error(`Timed out asking GitHub for the ${what} after ${Math.round(timeoutMs / 1000)}s`, {
				cause: err,
			});
		}
		if (isUnsupportedProxyError(err)) return new Error(unsupportedProxyMessage(), { cause: err });
		return err;
	};
	let response: Response;
	let body: unknown;
	try {
		response = await (options.fetchImpl ?? fetch)(url, {
			headers,
			signal: withTimeoutSignal(timeoutMs),
		});
		try {
			body = await response.json();
		} catch (err) {
			if (!(err instanceof SyntaxError)) throw err;
		}
	} catch (err) {
		throw mapError(err);
	}
	if (response.status === 404) throw new Error(`No ${what} is published.`);
	if (!response.ok) throw new Error(`GitHub answered ${response.status} ${response.statusText} for the ${what}`);
	return body;
}

async function fetchChecksums(url: string, options: FetchBuildOptions): Promise<string> {
	const timeoutMs = options.timeoutMs ?? BUILD_CHECK_TIMEOUT_MS;
	const headers = { "User-Agent": `${APP_NAME}/${VERSION}` };
	const response = await (options.fetchImpl ?? fetch)(url, { headers, signal: withTimeoutSignal(timeoutMs) });
	if (!response.ok) throw new Error(`GitHub answered ${response.status} ${response.statusText} for ${CHECKSUM_FILE}`);
	return response.text();
}

/** The release for `selector`, checked to be installable for this host. */
async function findRelease(selector: BuildSelector, options: FetchBuildOptions): Promise<unknown> {
	const api = releaseApiBase();
	if ("version" in selector) {
		const version = selector.version.replace(/^v/, "");
		if (!SEMVER.test(version)) throw new Error(`${selector.version} is not a release version`);
		return fetchJson(`${api}/releases/tags/v${encodeURIComponent(version)}`, options, `${version} release`);
	}
	if (selector.channel === "stable") {
		return fetchJson(`${api}/releases/latest`, options, "stable release");
	}
	const url = `${api}/releases?per_page=30`;
	const body = await fetchJson(url, options, "canary release");
	if (!Array.isArray(body)) throw new Error("GitHub releases answer is not a list");
	const canary = body.find(release => isRecord(release) && release.prerelease === true && release.draft !== true);
	if (!canary) throw new Error(`No canary release is published. Try \`${APP_NAME} update --stable\`.`);
	return canary;
}

/** Ask GitHub for a release of this host's target ({@link BuildSelector}). */
export async function fetchBuild(selector: BuildSelector, options: FetchBuildOptions = {}): Promise<BuildAnswer> {
	const host = options.host ?? (await currentBuildHost());
	const release = await findRelease(selector, options);
	if (!isRecord(release) || !Array.isArray(release.assets)) throw new Error("GitHub release answer is malformed");
	const checksumAsset = release.assets.find(asset => isRecord(asset) && asset.name === CHECKSUM_FILE);
	if (!isRecord(checksumAsset) || typeof checksumAsset.browser_download_url !== "string") {
		throw new Error(`release has no ${CHECKSUM_FILE} asset`);
	}
	const checksums = await fetchChecksums(checksumAsset.browser_download_url, options);
	try {
		return parseRelease(release, host.fileName, checksums);
	} catch (err) {
		throw new Error(`Invalid release answer: ${err instanceof Error ? err.message : err}`);
	}
}
