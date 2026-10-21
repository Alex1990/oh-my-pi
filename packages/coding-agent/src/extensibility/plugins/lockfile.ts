/**
 * Package-manager lockfiles in the plugins directory.
 *
 * Plugin installs run through pnpm or npm, so the resolved version/commit lives
 * in `pnpm-lock.yaml` or `package-lock.json`. Directories installed by older
 * builds may still carry `bun.lock`; it stays readable so those installs can
 * still report and pin their resolution.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { JSONC, YAML, bun } from "@oh-my-pi/pi-utils/node-runtime";

/** Lockfile names in preference order. */
export const PLUGIN_LOCKFILES = ["pnpm-lock.yaml", "package-lock.json", "bun.lock"] as const;

/** Contents of every lockfile in a directory; `null` means "did not exist". */
export type LockfileSnapshot = Record<string, string | null>;

async function readText(filePath: string): Promise<string | undefined> {
	try {
		return await bun.file(filePath).text();
	} catch (err) {
		if (isEnoent(err)) return undefined;
		throw err;
	}
}

/** Capture every lockfile before an install so a failed run can restore it. */
export async function snapshotLockfiles(dir: string): Promise<LockfileSnapshot> {
	const snapshot: LockfileSnapshot = {};
	for (const name of PLUGIN_LOCKFILES) {
		const filePath = path.join(dir, name);
		snapshot[filePath] = (await readText(filePath)) ?? null;
	}
	return snapshot;
}

/** Restore a snapshot: absent files are removed, present files get their bytes back. */
export async function restoreLockfiles(snapshot: LockfileSnapshot): Promise<void> {
	for (const [filePath, content] of Object.entries(snapshot)) {
		if (content === null) {
			await fs.rm(filePath, { force: true });
		} else {
			await bun.write(filePath, content);
		}
	}
}

/**
 * Resolve an installed plugin's locked identity — e.g.
 * `github.com/HexRaysSA/ida-mcp/<sha>` for git sources, `1.2.3` for npm.
 * Returns `undefined` when no lockfile records the package.
 */
export async function readLockResolution(dir: string, name: string): Promise<string | undefined> {
	const pnpm = await readText(path.join(dir, "pnpm-lock.yaml"));
	if (pnpm !== undefined) {
		const resolved = pnpmResolution(pnpm, name);
		if (resolved !== undefined) return resolved;
	}
	const npm = await readText(path.join(dir, "package-lock.json"));
	if (npm !== undefined) {
		const resolved = npmResolution(npm, name);
		if (resolved !== undefined) return resolved;
	}
	const bunLock = await readText(path.join(dir, "bun.lock"));
	if (bunLock !== undefined) {
		return bunResolution(bunLock, name);
	}
	return undefined;
}

function pnpmResolution(text: string, name: string): string | undefined {
	const lock = YAML.parse(text) as {
		importers?: Record<
			string,
			{
				dependencies?: Record<string, { version?: unknown }>;
				devDependencies?: Record<string, { version?: unknown }>;
			}
		>;
	} | null;
	const root = lock?.importers?.["."];
	for (const section of [root?.dependencies, root?.devDependencies]) {
		const version = section?.[name]?.version;
		if (typeof version === "string" && version.length > 0) return version;
	}
	return undefined;
}

function npmResolution(text: string, name: string): string | undefined {
	const lock = JSON.parse(text) as {
		packages?: Record<string, { version?: unknown; resolved?: unknown }>;
	} | null;
	const entry = lock?.packages?.[`node_modules/${name}`];
	const resolved = entry?.resolved;
	if (typeof resolved === "string" && resolved.length > 0) return resolved;
	return typeof entry?.version === "string" ? entry.version : undefined;
}

/** Legacy `bun.lock` (JSONC): `packages[name]` is `[resolution, metadata, …]`. */
function bunResolution(text: string, name: string): string | undefined {
	const lock = JSONC.parse(text) as { packages?: Record<string, unknown> } | null;
	const entry = lock?.packages?.[name];
	return Array.isArray(entry) && typeof entry[0] === "string" ? entry[0] : undefined;
}
